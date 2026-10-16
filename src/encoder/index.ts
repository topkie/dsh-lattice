// 向量编码层：模型懒加载、批量编码、可用性探测与降级。
//
// 三条纪律：
//   1. **懒加载**：插件激活时绝不碰模型。首次编码才加载，否则会拖慢宿主启动。
//   2. **可缺失**：编码器是 optionalDependency，装不上或加载失败时进入降级态，
//      encode() 返回 null 而不是抛错——上层用词面那一票兜住，功能缩水但不崩。
//   3. **可观测**：降级必须留下痕迹（state + error），不允许静默失效。
//
// 池化方式固定为 CLS：同一个模型用 mean 池化会给出**错误**的相似度排序
// （实测：cls 下"同域 > 跨域"，mean 下反转），这是模型本身的用法约定。

import { VEC_DIM, normalized } from '../util/vec.js'

/** 编码器状态。idle 表示尚未尝试加载。 */
export type EncoderState = 'idle' | 'loading' | 'ready' | 'unavailable'

export interface EncoderOptions {
  /** 模型标识，如 `BAAI/bge-small-zh-v1.5` */
  model: string
  /** 模型缓存目录；留空则用运行时默认 */
  cacheDir?: string
  /** 模型下载源；留空用官方源，网络受限环境可指向镜像 */
  remoteHost?: string
  /** 量化方式，默认 q8 */
  dtype?: string
}

/**
 * 本插件用到的 pipeline 形状。
 *
 * 为什么手写一个窄接口、而不是 import type 那个包自己的 FeatureExtractionPipeline：
 * 它是 **optionalDependency**（装不上时走降级路径，见文件头第 2 条）。把一个可选依赖的
 * 类型引进编译期，就把它变成了**构建期**必需 —— 那份「可缺失」的性质会在构建阶段失效。
 * 这里只描述真正用到的那一小块，装不装得上都能编译。
 */
interface FeatureExtractor {
  (
    texts: string[],
    options: { pooling: string; normalize: boolean },
  ): Promise<{
    data: unknown
    dims?: readonly number[]
  }>
}

/**
 * 动态 import 进来的模块里，本插件实际依赖的那一部分。
 *
 * 只列这三个字段：`env` 的两个赋值、`pipeline` 的调用。写成接口而不是 `any`，
 * 是为了让「插件用了这个包的哪几个 API」在代码里可读、可查。
 */
interface TransformersModule {
  env: { remoteHost?: string; cacheDir?: string }
  pipeline(task: string, model: string, options: { dtype: string }): Promise<FeatureExtractor | null>
}

let state: EncoderState = 'idle'
let lastError: string | null = null
let extractor: FeatureExtractor | null = null
let loading: Promise<boolean> | null = null
/** 已加载的模型标识。切换模型时必须重新加载 —— 否则会静默沿用旧模型。 */
let loadedModel: string | null = null

/** 当前状态。 */
export function encoderState(): EncoderState {
  return state
}

/** 最近一次失败原因（成功时为 null）。 */
export function encoderError(): string | null {
  return lastError
}

/** 复位（测试与配置热更新时使用）。 */
export function resetEncoder(): void {
  state = 'idle'
  lastError = null
  extractor = null
  loading = null
  loadedModel = null
}

/**
 * 确保编码器可用。并发调用只会触发一次加载。
 *
 * 失败不抛错——只把状态置为 unavailable 并记录原因。
 */
export async function ensureEncoder(opts: EncoderOptions): Promise<boolean> {
  // 已就绪但**请求的是另一个模型**时必须重新加载：
  // 状态与 extractor 是模块级单例，早先写成「ready 就直接返回 true」，
  // 于是切换模型（或测试里换了替身）会静默沿用旧模型 —— 结果看起来正常、
  // 向量却来自别的模型，属于最难查的一类错。
  if (state === 'ready' && loadedModel === opts.model) return true
  if (state === 'unavailable' && loadedModel === opts.model) return false
  if (loading !== null && loadedModel === opts.model) return loading
  if (state === 'ready' || state === 'unavailable') resetEncoder()

  loading = (async () => {
    state = 'loading'
    try {
      // 动态 import：包可能根本没装（optionalDependency）。
      // 这个转换是对**宿主之外**的边界：包没有随本仓库编译的声明，形状由上层用法约束，
      // 也就是上面那个 TransformersModule —— 声称的字段一旦写错，调用点会立刻编译不过。
      const mod = (await import('@huggingface/transformers')) as unknown as TransformersModule
      if (opts.remoteHost) mod.env.remoteHost = opts.remoteHost
      if (opts.cacheDir) mod.env.cacheDir = opts.cacheDir
      extractor = await mod.pipeline('feature-extraction', opts.model, {
        dtype: opts.dtype ?? 'q8',
      })
      state = 'ready'
      loadedModel = opts.model
      lastError = null
      return true
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      extractor = null
      loadedModel = opts.model
      state = 'unavailable'
      return false
    } finally {
      loading = null
    }
  })()

  return loading
}

/** 把 pipeline 输出的展平数组按维度切成若干条向量。 */
function sliceVectors(data: Float32Array, dim: number, count: number): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < count; i++) out.push(data.slice(i * dim, (i + 1) * dim))
  return out
}

/**
 * 批量编码。返回与输入等长的数组，失败位置为 null。
 *
 * 失败语义是"这一条没编码成功"，而不是"整批失败"——上层据此决定是否降级。
 */
export async function encodeBatch(texts: string[], opts: EncoderOptions): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return []
  const ok = await ensureEncoder(opts)
  if (!ok || !extractor) return texts.map(() => null)
  try {
    const out = await extractor(texts, { pooling: 'cls', normalize: true })
    const dim = Number(out.dims?.[1] ?? VEC_DIM)
    if (!(out.data instanceof Float32Array) || dim <= 0) throw new Error('编码输出形状异常')
    return sliceVectors(out.data, dim, texts.length)
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    return texts.map(() => null)
  }
}

/** 单条编码；失败返回 null。 */
export async function encode(text: string, opts: EncoderOptions): Promise<Float32Array | null> {
  const [v] = await encodeBatch([text], opts)
  return v ?? null
}

/**
 * 由若干向量算中心向量（成员均值后归一化）。
 *
 * 与 topic 的 sum_vec 是同一套语义：增量加减与全量重算结果一致。
 */
export function centroidOf(vectors: Float32Array[]): Float32Array {
  const dim = vectors[0]?.length ?? VEC_DIM
  const sum = new Float32Array(dim)
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i] ?? 0
  return normalized(sum)
}

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

let state: EncoderState = 'idle'
let lastError: string | null = null
let extractor: ((input: string | string[], options: unknown) => Promise<unknown>) | null = null
let loading: Promise<boolean> | null = null

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
}

/**
 * 确保编码器可用。并发调用只会触发一次加载。
 *
 * 失败不抛错——只把状态置为 unavailable 并记录原因。
 */
export async function ensureEncoder(opts: EncoderOptions): Promise<boolean> {
  if (state === 'ready') return true
  if (state === 'unavailable') return false
  if (loading) return loading

  loading = (async () => {
    state = 'loading'
    try {
      // 动态 import：包可能根本没装（optionalDependency）
      const mod: any = await import('@huggingface/transformers')
      if (opts.remoteHost) mod.env.remoteHost = opts.remoteHost
      if (opts.cacheDir) mod.env.cacheDir = opts.cacheDir
      extractor = (await mod.pipeline('feature-extraction', opts.model, {
        dtype: opts.dtype ?? 'q8',
      })) as typeof extractor
      state = 'ready'
      lastError = null
      return true
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      extractor = null
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
    const out: any = await extractor(texts, { pooling: 'cls', normalize: true })
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
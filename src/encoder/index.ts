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
  /**
   * 下载源候选，**按顺序尝试**，前一个失败才试下一个。留空等于只用官方源。
   *
   * 为什么要候选而不是一个源：官方源在部分网络里不可达（实测被 DNS 污染到
   * 一个无关地址段），镜像也会失效。只配一个源的后果是「网络稍差就没有向量」，
   * 而且失败原因只留最后一个，用户看不出该换哪个。
   */
  hosts?: readonly string[]
  /** 量化方式，默认 q8 */
  dtype?: string
  /**
   * 加载器。默认走 `@huggingface/transformers` 的 `pipeline()`。
   *
   * 留出这个参数是为了让用例能构造「第一个源失败、第二个源成功」的顺序：
   * 真网络里造不出确定的失败与成功。生产代码不传。
   */
  load?: EncoderLoader
}

/**
 * 本插件用到的 pipeline 形状。
 *
 * 为什么手写一个窄接口、而不是 import type 那个包自己的 FeatureExtractionPipeline：
 * 它是 **optionalDependency**（装不上时走降级路径，见文件头第 2 条）。把一个可选依赖的
 * 类型引进编译期，就把它变成了**构建期**必需 —— 那份「可缺失」的性质会在构建阶段失效。
 * 这里只描述真正用到的那一小块，装不装得上都能编译。
 */
export interface FeatureExtractor {
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

/** 加载一个源上的模型。失败请抛错（不要返回 null），由调用方记进尝试记录。 */
export type EncoderLoader = (host: string, opts: EncoderOptions) => Promise<FeatureExtractor | null>

/**
 * 官方源。`@huggingface/transformers` 自己的默认值就是它；这里显式写出来，
 * 因为「第一个源」要出现在尝试记录里，不能靠「没设过」来表达。
 */
export const OFFICIAL_HOST = 'https://huggingface.co/'

/** 官方源不可达时用的镜像。写成常量，改它只改一处。 */
export const DEFAULT_MIRROR_HOST = 'https://hf-mirror.com/'

/**
 * 由配置里的一个镜像地址算出候选序列。
 *
 * 顺序固定为「官方在前、镜像在后」：官方源可用时不该先去镜像绕一圈，
 * 而镜像失效时也不该把用户卡在「必须先改配置」上。镜像填成官方地址时只留一个，
 * 免得同一个源试两次。
 */
export function hostList(mirror?: string): readonly string[] {
  const custom = typeof mirror === 'string' ? mirror.trim() : ''
  const second = custom === '' ? DEFAULT_MIRROR_HOST : custom
  return second === OFFICIAL_HOST ? [OFFICIAL_HOST] : [OFFICIAL_HOST, second]
}

/** 一次源尝试的结果。`ms` 是这一次花掉的时间，含建立连接与下载。 */
export interface EncoderAttempt {
  /** 试的是哪个源。 */
  host: string
  /** 这个源上是否加载成功。 */
  ok: boolean
  /** 这一次花掉的毫秒数。 */
  ms: number
  /** 失败时的消息原文；成功时为 null。**含主机名与缓存路径，不要写进日志。** */
  error: string | null
}

/**
 * 最近一次加载尝试的逐源记录，按尝试顺序。加载成功后保留。
 *
 * 为什么不只留最后一句错误：用户要知道的是「哪几个源试过、分别怎么失败」。
 * 只留最后一次会把「第一个源为什么不通」抹掉，而那往往正是要改的那个配置。
 */
let attempts: EncoderAttempt[] = []

/** 最近一次加载尝试的逐源记录（副本，调用方改不动模块状态）。 */
export function encoderAttempts(): EncoderAttempt[] {
  return attempts.map((a) => ({ ...a }))
}

/**
 * 默认加载器：动态 import 那个包，设好源与缓存目录，再建 pipeline。
 *
 * 每次尝试都要**重设 `remoteHost`** —— 那个包把它当全局环境变量读，
 * 换源不重新赋值的话，第二个源仍会打向第一个地址。
 */
async function defaultLoader(host: string, opts: EncoderOptions): Promise<FeatureExtractor | null> {
  // 动态 import：包可能根本没装（optionalDependency）。
  // 这个转换是对**宿主之外**的边界：包没有随本仓库编译的声明，形状由上层用法约束，
  // 也就是上面那个 TransformersModule —— 声称的字段一旦写错，调用点会立刻编译不过。
  const mod = (await import('@huggingface/transformers')) as unknown as TransformersModule
  mod.env.remoteHost = host
  if (opts.cacheDir) mod.env.cacheDir = opts.cacheDir
  return mod.pipeline('feature-extraction', opts.model, { dtype: opts.dtype ?? 'q8' })
}

let state: EncoderState = 'idle'
let lastError: string | null = null
/**
 * 最近一次失败的**错误类名或错误码**（不是消息原文）。
 *
 * 为什么单存一份：消息可能含模型缓存路径与主机名，而日志模块只允许短 token
 * （见 src/log/policy.ts）。降级埋点要的是「哪一类失败」，不是「失败说了什么」。
 */
let lastErrorCode: string | null = null
let extractor: FeatureExtractor | null = null
let loading: Promise<boolean> | null = null
/** 已加载的模型标识。切换模型时必须重新加载 —— 否则会静默沿用旧模型。 */
let loadedModel: string | null = null

/** 当前状态。 */
export function encoderState(): EncoderState {
  return state
}

/** 最近一次失败原因（成功时为 null）。**这是消息原文，不要写进日志。** */
export function encoderError(): string | null {
  return lastError
}

/** 最近一次失败的错误类名或错误码（成功时为 null）；可安全写进日志。 */
export function encoderErrorCode(): string | null {
  return lastErrorCode
}

/**
 * 编码器本体的**实时**占用。
 *
 * 这一项没有「条目数」：编码器是一份模型本体，不是一张表。它自己的规模字段不由本模块
 * 持有 —— `pipeline` 返回的对象是 @huggingface/transformers 的内部形状，版本之间不稳定，
 * 拿它算参数量会在升级时静默给出错的数。所以只报**是不是已经加载**（`loaded`）、
 * 当前状态与加载的模型名；这三样是从模块变量直读，不是快照。
 */
export function encoderCacheUsage(): {
  loaded: boolean
  state: EncoderState
  model: string | null
  attempts: EncoderAttempt[]
} {
  return { loaded: extractor !== null, state, model: loadedModel, attempts: encoderAttempts() }
}

/** 异常 → 短 token：优先 `code`，其次类名。 */
function codeOf(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') return name
  }
  return 'Error'
}

/** 复位（测试与配置热更新时使用）。 */
export function resetEncoder(): void {
  state = 'idle'
  lastError = null
  lastErrorCode = null
  extractor = null
  loading = null
  loadedModel = null
  attempts = []
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

  // 一个源都没配就只试官方源：`hosts` 为空与「只用官方」是同一种意思，
  // 不能让空数组变成「什么都不试、直接降级」。
  const hosts = opts.hosts !== undefined && opts.hosts.length > 0 ? opts.hosts : [OFFICIAL_HOST]
  const load = opts.load ?? defaultLoader

  loading = (async () => {
    try {
      state = 'loading'
      attempts = []
      // 按顺序试：前一个失败才试下一个。每次都重设 remoteHost（见 defaultLoader 的注释）。
      for (const host of hosts) {
        const started = Date.now()
        try {
          extractor = await load(host, opts)
          state = 'ready'
          loadedModel = opts.model
          lastError = null
          lastErrorCode = null
          attempts.push({ host, ok: true, ms: Date.now() - started, error: null })
          return true
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          lastErrorCode = codeOf(err)
          extractor = null
          attempts.push({ host, ok: false, ms: Date.now() - started, error: lastError })
        }
      }
      // 所有源都失败：停在 unavailable，逐源原因留在 attempts 里。
      // 不再抛错 —— 编码器可缺失是文件头第 2 条纪律，上层靠 null 走词面路径。
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
    lastErrorCode = codeOf(err)
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

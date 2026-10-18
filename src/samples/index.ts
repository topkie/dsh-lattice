// 校准样本模块的**唯一写入口**（与 src/log/index.ts 同一形状：入队 → setImmediate 批量落盘）。
//
// 这个模块只做三件事：
//   ① 记样本：显式 feedback（模型判断）与自动收集（负样本，按纯度规则过滤）；
//   ② 报条数：lattice_ping 只报 total / positive / negative，**不报任何原文**；
//   ③ 会话级「最近一次召回」：只留在内存里，供 lattice_feedback 把 1-based 序号
//      解析成 atom id（裁决 #33/#34 ⑥）。
//
// 为什么入队而不是当场写：召回是热路径，样本是旁路。一次召回可能同时触发自动收集，
// 若当场写 SQLite，样本就会给召回加一次 fsync。队列用 setImmediate 合并同一轮事件
// 循环里的写入（**不新增定时器**，同 log 模块）。
//
// 队列有界（满了丢最旧）：丢的是最不重要的那几条样本，而不是让内存随召回次数增长。
//
// 开关语义：`samplesEnabled` 关掉的是**自动收集**；显式 feedback 照常记录 ——
// feedback 是模型对本次召回的显式判断，不是抽样；把它一并关掉，用户就再也无法让
// 「这一条有用」被记下来，而样本库首先是为这件事存在的。

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { logEvent } from '../log/index.js'
import { reasonCodeOf } from '../log/policy.js'
import type { RecallMeta } from '../pipeline/search.js'
import {
  DEFAULT_SAMPLE_LIMITS,
  SAMPLE_OBVIOUS_MAX_TOP1,
  SAMPLE_UNCERTAIN_MAX_TOP1,
  SampleStore,
  sampleFilePath,
  type SampleCounts,
  type SampleKind,
  type SampleLimits,
  type SampleRow,
  type SampleSource,
} from './store.js'

export { sampleFilePath }

/** 队列上限：64 条。一次召回最多入队一条，64 条足以吸收「事件循环被占住」的一整轮。 */
export const SAMPLE_QUEUE_MAX = 64

/** 调用方给的样本语义（时间与模型名由本模块补齐，避免两处各写一份）。 */
export interface SampleInput {
  kind: SampleKind
  source: SampleSource
  /** 本次召回的 top1 余弦；无向量时为 0。 */
  top1: number
  /** 查询向量；**只存向量，不存原文**。 */
  vec: Float32Array | null
  /** 命中的 atom id（feedback 时只有映射后的那一条）。 */
  hitIds: readonly number[]
}

/**
 * 会话级「最近一次召回」（裁决 #34 ⑥）。
 *
 * 只放内存、进程结束即失，**不写库**：feedback 的 `ref` 指的是「刚刚那次召回的序号」，
 * 跨会话毫无意义；写进库反而会让重启后的第一次 feedback 引用到上一次会话的结果。
 */
export interface LastRecall {
  /** 上次召回**真的展示给模型**的 atom id，按展示顺序（1-based 序号 = 下标 + 1）。 */
  ids: readonly number[]
  /** 上次召回的 top1 余弦。 */
  top1: number
  /** 上次召回的查询向量；编码器不可用时为 null。 */
  vec: Float32Array | null
}

/** `ref` 解析结果。失败时**必须**给得出原因：拒绝要可见（判据 12）。 */
export type FeedbackRef =
  { ok: true; atomId: number; top1: number; vec: Float32Array | null } | { ok: false; reason: string }

/** 模块状态。收在一个对象里，测试能一眼复位（同 src/log/index.ts 的做法）。 */
interface SampleState {
  /** 是否已配置 dataDir。未配置时一律丢弃 —— 不猜样本该落在哪。 */
  active: boolean
  /** 自动收集开关（配置项 samplesEnabled）。 */
  enabled: boolean
  dataDir: string
  /** 当前编码模型名；写样本时带进 row，换模型时据此标失效。 */
  model: string
  limits: SampleLimits
  store: SampleStore | null
  queue: SampleRow[]
  scheduled: boolean
  dropped: number
  failures: number
  lastRecall: LastRecall | null
  /** 上一条自动样本的查询指纹 —— 只用于「不与上一条重复」，不留原文。 */
  lastAutoFingerprint: string
}

const state: SampleState = {
  active: false,
  enabled: true,
  dataDir: '',
  model: '',
  limits: DEFAULT_SAMPLE_LIMITS,
  store: null,
  queue: [],
  scheduled: false,
  dropped: 0,
  failures: 0,
  lastRecall: null,
  lastAutoFingerprint: '',
}

/**
 * 指定样本库所在的数据目录与开关。
 *
 * 与 configureLog 同一条理由：样本模块不认识 RuntimeConfig，而「样本该落到哪个目录」
 * 与「记忆库在哪个目录」必须是同一个答案。重复调用同目录是幂等的；换目录先关旧连接。
 */
export function configureSamples(
  dir: string,
  opts: { enabled?: boolean; model?: string; limits?: Partial<SampleLimits> } = {},
): void {
  if (dir === '') return
  if (dir === state.dataDir) {
    state.active = true
    if (opts.enabled !== undefined) state.enabled = opts.enabled
    if (opts.model !== undefined) state.model = opts.model
    if (opts.limits !== undefined) {
      state.limits = { ...DEFAULT_SAMPLE_LIMITS, ...opts.limits }
      state.store?.close()
      state.store = null
    }
    return
  }
  closeSamples()
  state.dataDir = dir
  state.enabled = opts.enabled ?? true
  state.model = opts.model ?? ''
  state.limits = { ...DEFAULT_SAMPLE_LIMITS, ...opts.limits }
  state.active = true
}

/**
 * 记一条样本并在落盘后返回是否成功。
 *
 * 显式 feedback 用它：返回 true 才说「已记下」。说「记下了」而其实没写，是这条
 * 判据最糟的失败形态 —— 调用方从此以为样本存在。
 */
export async function recordSample(input: SampleInput): Promise<boolean> {
  if (!enqueueSample(input)) return false
  return flushSamplesAsync()
}

/**
 * 自动收集用：入队即返回，不等落盘。
 *
 * 召回路径上不能有同步 IO，也不能等样本 —— 样本写失败与这次召回无关。
 */
export function queueSample(input: SampleInput): void {
  enqueueSample(input)
}

/** 立即 flush（关闭前、测试里、需要当场断言时用）。失败同样不抛。 */
export function flushSamples(): boolean {
  state.scheduled = false
  return flushNow()
}

/** 下一轮事件循环落盘一次再返回。显式 feedback 用它（不阻塞调用方，但可等待）。 */
export function flushSamplesAsync(): Promise<boolean> {
  return new Promise((resolve) => {
    setImmediate(() => {
      state.scheduled = false
      resolve(flushNow())
    })
  })
}

/**
 * 关闭样本库：尽力 flush 一次，然后关连接并清空队列。
 *
 * 清空队列是**刻意**的：卸载之后还留在内存里的行不会再有人写（与 closeLog 同一条）。
 * 会话级「最近一次召回」一并清掉 —— 换了库还留着旧的 hit_ids，feedback 会引用到
 * 一个已经不存在的召回结果。
 */
export function closeSamples(): void {
  if (state.queue.length > 0) flushNow()
  state.store?.close()
  state.store = null
  state.queue = []
  state.scheduled = false
  state.active = false
  state.lastRecall = null
  state.lastAutoFingerprint = ''
}

/** 因为队列满而丢掉的条数（诊断用）。 */
export function samplesDroppedCount(): number {
  return state.dropped
}

/** 写失败次数（诊断用；不影响返回值之外的任何行为）。 */
export function samplesWriteFailureCount(): number {
  return state.failures
}

/**
 * 样本库的整体情况，给 lattice_ping 用。
 *
 * 库文件不存在时报 0：ping 是健康检查，不该因为「还没写过样本」就建一个空库。
 * 读失败（损坏、被占用）报 0 并留一条日志 —— 报得出「读不到」比抛错更适合健康检查。
 */
export function sampleStats(): SampleCounts {
  const zero: SampleCounts = { total: 0, positive: 0, negative: 0 }
  if (!state.active || state.dataDir === '') return zero
  if (!existsSync(sampleFilePath(state.dataDir))) return zero
  try {
    if (state.store === null) state.store = new SampleStore(state.dataDir, state.limits)
    return state.store.counts()
  } catch (err) {
    logEvent('warn', 'samples.unavailable', { reason: reasonCodeOf(err) })
    return zero
  }
}

/**
 * 读出用于重标的样本（T44 判据 3/5/7 的输入）。
 *
 * 读不到就返回空数组、并留一条日志：重标会因此被「无样本」那道闸跳过（判据 5），
 * 而不是拿着半份样本去算一个不可解释的切点。
 */
/** 样本库交出的行形状。与 calibration/trigger.ts 的 SampleLike 同形，但这里自带一份，
 * 免得 samples 模块为了一个类型去 import 触发模块（依赖方向：触发读样本，样本不认识触发）。 */
export interface CalibrationSampleRow {
  kind: 'positive' | 'negative'
  source: string
  top1: number
  vec: Float32Array | null
  encoderModel: string
}

export function loadCalibrationSamples(limit: number): CalibrationSampleRow[] {
  // **不看 state.enabled**（审核发现 F3-2 / P1-2）：`samplesEnabled` 关掉的是「自动收集」，
  // 不是「样本库不存在」。此前这里一起挡掉，于是关掉自动收集会让重标失去正样本来源 ——
  // 而文档对这个开关的承诺是「只停自动收集」。真要清空样本库走界面上的清空入口。
  if (state.dataDir === '') return []
  try {
    if (state.store === null) state.store = new SampleStore(state.dataDir, state.limits)
    return state.store.readForCalibration(limit)
  } catch (err) {
    logEvent('warn', 'samples.unavailable', { reason: reasonCodeOf(err) })
    return []
  }
}

/** 记下「最近一次召回」。只放内存，不写库（裁决 #34 ⑥）。 */
export function noteLastRecall(recall: LastRecall): void {
  state.lastRecall = { ids: [...recall.ids], top1: recall.top1, vec: recall.vec }
}

/** 上次召回的条数与 top1（给拒因文案用）；没有召回过时返回 null。 */
export function lastRecallInfo(): { count: number; top1: number } | null {
  if (state.lastRecall === null) return null
  return { count: state.lastRecall.ids.length, top1: state.lastRecall.top1 }
}

/**
 * 把 feedback 的 1-based 序号解析成 atom id（裁决 #33）。
 *
 * 为什么由插件解析而不是让模型报 atom id：模型管语义位置（「第几条」），插件管结构
 * （那条是哪个 id）。这样模型不必搬运 id，结构暴露面收窄到「指向历史记忆」的两处
 * （`edges` 与 `supersedes`）。
 *
 * 三条边界都由这里挡住，且**拒因可见**：没有上次召回 / 序号不是正整数 / 超出条数。
 * 序号指向的是**上次召回真正展示给模型的那批条目**（view 的锚段），不是融合后的全部
 * 候选 —— 模型数的是它看见的那几行，数不到被预算裁掉的条目。
 */
export function resolveFeedbackRef(ref: unknown): FeedbackRef {
  const last = state.lastRecall
  if (last === null) {
    return {
      ok: false,
      reason:
        '还没有可引用的召回结果：先调 lattice_recall，再用返回文本【锚】段里的 1-based 序号。' +
        '（会话级记录只在内存里，进程重启后会清空。）',
    }
  }
  // 「召回过但一条没命中」与「还没召回过」是两件事：前者再调一次 recall 也可能还是空的，
  // 让调用方去改查询或改写法，而不是反复重试同一次调用。
  if (last.ids.length === 0) {
    return { ok: false, reason: '上次召回没有命中任何记忆，没有可引用的序号。' }
  }
  if (typeof ref !== 'number' || !Number.isInteger(ref)) {
    return { ok: false, reason: 'ref 必须是整数序号（1 起），收到 ' + describeValue(ref) + '。' }
  }
  if (ref < 1) {
    return { ok: false, reason: 'ref 从 1 开始，收到 ' + ref + '。' }
  }
  if (ref > last.ids.length) {
    return {
      ok: false,
      reason:
        '上次召回只展示了 ' +
        last.ids.length +
        ' 条，ref=' +
        ref +
        ' 超出范围（1..' +
        last.ids.length +
        '）。',
    }
  }
  return { ok: true, atomId: last.ids[ref - 1]!, top1: last.top1, vec: last.vec }
}

/** 拒因里回显入参：不把 undefined / 字符串 / NaN 混成同一句话，否则调用方改不对。 */
function describeValue(v: unknown): string {
  if (v === undefined) return '（未提供）'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return '"' + v + '"'
  return typeof v
}

/** 负样本的档位（裁决 #34 ④）。 */
export type NegativeBand = 'obvious' | 'uncertain'

/**
 * 自动收集的**纯度规则**：这次召回算不算一条可用的负样本，以及落在哪一档。
 *
 * 三条排除条件，各自挡的是一种「看起来是负样本、其实是别的故障」：
 *   · 无查询向量 / 词面两路失效 / 短词落空 —— 是**降级**，不是「不相关」；
 *   · 词面有命中 —— 说明库里有字面对得上的东西，「不相关」这个判断不可靠；
 *   · 向量路零候选 —— top1=0 只说明库里没有可比的向量，衡量不了任何东西。
 *
 * 通过之后按 top1 分两档：低于 0.4 是「明显无关」（信息量低、量要封顶），
 * 0.4~0.6 是「不确定带」（切点就落在这附近，优先保留）。0.6 以上不收 ——
 * 那种召回多半是「有点关系」，当成负样本会直接把切点往下拽。
 */
export function classifyNegative(meta: RecallMeta): NegativeBand | null {
  if (meta.vectorMissing) return null
  if (meta.lexicalDegraded || meta.shortTermMiss) return null
  if (meta.counts.entry > 0 || meta.counts.body > 0) return null
  if (meta.counts.vec === 0) return null
  if (meta.topCosine < SAMPLE_OBVIOUS_MAX_TOP1) return 'obvious'
  if (meta.topCosine <= SAMPLE_UNCERTAIN_MAX_TOP1) return 'uncertain'
  return null
}

/** 自动收集的输入。查询原文只用来算指纹，**不进队列、不落库**。 */
export interface AutoNegativeInput {
  query: string
  meta: RecallMeta
  vec: Float32Array | null
  hitIds: readonly number[]
}

/**
 * 自动收集一条负样本；被纯度规则或去重挡下时返回 null。
 *
 * 「不与上一条重复」用的是查询的 sha256：同一条查询在一场会话里反复出现（模型试措辞）
 * 会把同一句话记很多遍，而它只代表一个样本。指纹只留在内存里，落盘的是向量 ——
 * 保存哈希同样是一种「保存了关于原文的信息」，只是比原文轻。
 */
export function collectAutoNegative(input: AutoNegativeInput): SampleRow | null {
  if (!state.active || !state.enabled) return null
  if (classifyNegative(input.meta) === null) return null
  const fp = fingerprint(input.query)
  if (fp === state.lastAutoFingerprint) return null
  const row: SampleRow = {
    createdAt: Date.now(),
    kind: 'negative',
    source: 'auto',
    top1: input.meta.topCosine,
    vec: input.vec,
    hitIds: [...input.hitIds],
    encoderModel: state.model,
  }
  state.lastAutoFingerprint = fp
  enqueueRow(row)
  return row
}

/** 一条样本入队；未配置 dataDir 时返回 false（不猜该落到哪）。 */
function enqueueSample(input: SampleInput): boolean {
  if (!state.active || state.dataDir === '') return false
  enqueueRow({
    createdAt: Date.now(),
    kind: input.kind,
    source: input.source,
    top1: input.top1,
    vec: input.vec,
    hitIds: [...input.hitIds],
    encoderModel: state.model,
  })
  return true
}

/** 入队 + 安排下一次 flush。 */
function enqueueRow(row: SampleRow): void {
  if (state.queue.length >= SAMPLE_QUEUE_MAX) {
    state.queue.shift()
    state.dropped++
  }
  state.queue.push(row)
  scheduleFlushSoon()
}

/** 用 setImmediate 合并同一轮事件循环里的写入（不新增定时器）。 */
function scheduleFlushSoon(): void {
  if (state.scheduled) return
  state.scheduled = true
  setImmediate(() => {
    if (!state.scheduled) return
    state.scheduled = false
    flushNow()
  })
}

/**
 * 一次批量落盘。返回是否全部写入成功；**不抛** —— 这是模块对外的承诺。
 *
 * 失败的行放回队首（有界）：一次性的目录不可写不该让「已经发生过的反馈」凭空消失，
 * 下一次事件到来时会再试。与 log 模块不同的是这里**不限频记日志**：样本写失败是
 * 用户可感知的（feedback 返回值会说），而日志噪声的代价更高。
 */
function flushNow(): boolean {
  if (state.queue.length === 0) return true
  if (state.dataDir === '') return false
  if (state.store === null) state.store = new SampleStore(state.dataDir, state.limits)
  const batch = state.queue
  state.queue = []
  try {
    state.store.append(batch)
    return true
  } catch (err) {
    state.failures++
    state.store?.close()
    state.store = null
    state.queue = batch.concat(state.queue).slice(-SAMPLE_QUEUE_MAX)
    logEvent('warn', 'samples.unavailable', { reason: reasonCodeOf(err) })
    return false
  }
}

/** 查询指纹：只用于「不与上一条重复」，只存在内存里。 */
function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

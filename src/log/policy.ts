// 日志模块的**写入口白名单**：什么事件、什么字段可以落库。
//
// 为什么白名单长成一张表、而不是散在调用点：日志库是唯一会把插件运行痕迹落到磁盘的地方，
// 而「不写用户内容」这条约束不能靠每个调用点自觉 —— 调用点越多，漏一个就是一条查询文本
// 进了库。表在这里，过滤也在这里：**不在这张表里的事件与字段一律丢弃**，调用点写错了
// 也不会出库。
//
// 两条硬规则（都能构造失败）：
//   1. 事件名必须在 EVENT_DETAIL_KEYS 里；不在就整条丢弃。不做「降级成别的名字」——
//      那会把「写错了」伪装成「写对了」，而日志的价值恰恰在于它记的是真发生过的事。
//   2. detail 只收表里列出的键，且值只能是数字、布尔或**短 token**（错误类名 / 错误码）。
//      字符串不匹配 token 形状时替换成 'other'：这是最后一道闸，挡住「调用方顺手把错误
//      消息原文（可能含查询文本或路径）塞进 reason」这种最可能发生的泄漏。
//
// 据此，查询文本、atom 正文与 id、文件路径、模型名都没有进入这张表的路径 —— 不是靠
// 调用方「记得不要传」，而是传了也落不下去。

/**
 * 日志等级，三档。
 *
 * 为什么有 `info`：不是给「一切正常」用的（那不需要日志库），而是给**做成了的事**用的 ——
 * 「重标成功」这类事件原先只能记成 warn，因为当时只有两档可用。级别该由事件本身决定，
 * 不该由「有哪些档可用」倒推。
 */
export type LogLevel = 'info' | 'warn' | 'error'

/** 待落盘的一行。ts 由队列在入队时给定（「当场」= 入队时刻）。 */
export interface LogRow {
  ts: number
  level: LogLevel
  event: string
  detail: string | null
}

/**
 * 事件白名单：事件名 → 该事件 detail 里允许出现的字段。
 *
 * 与设计草案第三节逐条对应；**新增事件必须先改这里**，否则写入会被静默丢弃。
 * 字段值为空数组表示该事件只记「发生了」，不带任何细节。
 */
export const EVENT_DETAIL_KEYS: Readonly<Record<string, readonly string[]>> = {
  // 编码器加载或调用失败。只记错误类名 / 错误码，不记错误消息（消息可能含模型路径）。
  'encoder.unavailable': ['reason'],
  // 本次召回没有查询向量（纯词面）。原因在 encoder.unavailable 或配置里。
  'recall.vector_missing': [],
  // 词面两路全空、仅向量路有结果。
  'recall.lexical_degraded': [],
  // 查询含两字词、入口层零命中 —— 通常意味着索引或切词出了问题。
  'recall.short_term_miss': [],
  // 图路建边失败。
  'graph.unavailable': ['reason'],
  // 启动时标定快照缺失 / 版本不符或损坏 / 重标失败 / 重标完成 / 本库未标定。
  'calib.snapshot_missing': [],
  'calib.snapshot_invalid': ['field'],
  'calib.recalibrate_failed': ['stage', 'reason'],
  'calib.recalibrate_done': ['atoms', 'samples', 'ms', 'changed'],
  'calib.unlocalized': ['reason'],
  // 日志自身写失败（限频 1 次/分钟）。它也会走白名单，原因同样只记错误码。
  'log.write_failed': ['reason'],
  // 校准样本库写不进 / 读不到。样本是旁路：失败只留痕，不影响召回与写入。
  // 只记原因码 —— 路径与查询文本都不进这张表。
  'samples.unavailable': ['reason'],
  // 用户忽略了一条待拆分候选（T29）。这是留痕而不是待办：没有状态、没有后续动作。
  // **不带 atom id**：这张表的白名单里没有 id 通道，忽略这件事只需要「发生过」。
  'split.ignored': [],
  // 用户确认了一条待拆分候选（T29）。与 split.ignored 同形，理由见 split.ts 的文件头：
  // meta 里的确认清单是 FIFO 的，被挤出去的那条只能靠日志回答「它被确认过」。
  'split.confirmed': [],
  // 确认清单满了，最旧的一条被挤出去（T29）。只记**被挤掉的条数**，不记 id。
  // 正常情况下这个数是 1；大于 1 说明一次确认挤掉了一批，值得知道。
  'split.evicted': ['evicted'],
  // 用户清空了「学到的入口」（T50）。只记清掉的条数，不记任何词或 id。
  // 零条也记：与 split.ignored 同一条理由 —— 这件事没有别的留痕处。
  'entry.cleared': ['cleared'],
}

/** 允许落库的等级。 */
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error']

/** 等级守卫：写入口与过滤层共用一份定义，避免两处各列一遍。 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

/**
 * 字符串值的合法形状：以字母开头、只含字母数字与 `_.:-`、最长 64。
 *
 * 错误类名（TypeError）、错误码（ENOENT / MODULE_NOT_FOUND）、状态枚举（never / small_db）
 * 都落在这个形状里；查询文本、路径、模型名落不进去。**这是本轮唯一的字符串通道**，
 * 所以「短 token」这条限制本身就是隐私边界。
 */
const SAFE_VALUE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/

/** detail 序列化后的字符上限。白名单字段本就短，这里只是兜住异常调用。 */
export const DETAIL_MAX_CHARS = 512

/** 单个字段值的安全化：不合法就换成 'other'（**不拼接、不截断原文**）。 */
function cleanValue(value: unknown): number | boolean | string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return SAFE_VALUE.test(value) ? value : 'other'
  return undefined
}

/**
 * 把一次调用过滤成可落盘的一行；不合格返回 null（整条丢弃，不抛错）。
 *
 * 不抛错是刻意的：日志是旁路，它不能因为调用方传错而影响召回或写入。
 */
export function sanitizeEvent(level: unknown, event: unknown, detail: unknown): Omit<LogRow, 'ts'> | null {
  if (!isLogLevel(level)) return null
  if (typeof event !== 'string') return null
  if (!Object.prototype.hasOwnProperty.call(EVENT_DETAIL_KEYS, event)) return null
  const allowed = EVENT_DETAIL_KEYS[event] ?? []
  const out: Record<string, number | boolean | string> = {}
  if (detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
    const raw = detail as Record<string, unknown>
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
      const value = cleanValue(raw[key])
      if (value !== undefined) out[key] = value
    }
  }
  const text = Object.keys(out).length === 0 ? null : JSON.stringify(out)
  if (text !== null && text.length > DETAIL_MAX_CHARS) return null
  return { level, event, detail: text }
}

/**
 * 把异常换成可落库的原因码：优先 `code`（ENOENT / MODULE_NOT_FOUND），其次类名（TypeError）。
 *
 * **绝不返回 message**：它是唯一可能携带查询文本、路径或模型名的字段。
 * 两个值都得再过一个 token 形状检查 —— 外部异常的形状不可信。
 */
export function reasonCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && SAFE_VALUE.test(code)) return code
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string' && SAFE_VALUE.test(name)) return name
  }
  return 'unknown'
}

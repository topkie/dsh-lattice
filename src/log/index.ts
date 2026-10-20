// 降级日志模块的**唯一写入口**。
//
// 对外只有两件事要做对：
//   1. 事件发生**当场**入队（入队即已记录），绝不因为写盘而阻塞调用方；
//   2. 写失败只降级到内存，限频记一条 log.write_failed，**绝不抛回调用方**。
//
// 为什么要有缓冲：日志是旁路。一次召回里可能同时触发「编码器不可用」与「纯词面」，
// 若每条都同步写 SQLite，降级路径就会自己变成慢路径 —— 而那正是最不该失速的时刻。
// 队列上限 200 条：200 条在 50ms 窗口下约 4000 条/秒的吸收能力，远超降级
// 事件的实际速率；满了丢最旧，丢掉的条数可以从 logDroppedCount() 读出来。
//
// 为什么不用定时器：批量窗口用 setImmediate —— 同一轮事件循环里的所有事件
// 合成一个事务，正常情况下延迟只有几微秒。50ms 只作为「事件循环被长时间占住」时的
// 兜底上界：入队时发现队首已经等了 50ms 就当场 flush，不让日志在内存里无限期悬着。
//
// 降级事件按**状态变化**记（见 state.ts 的 noteEncoderState / noteRecallDegradations）：
// 编码器关掉后每次召回都会 vectorMissing，若逐次记，日志库会被这一个已知状态刷满。

import { CSV_HEADER, CSV_TRUNCATED, exportLogCsv, type LogExport } from './export.js'
import { reasonCodeOf, sanitizeEvent, type LogLevel, type LogRow } from './policy.js'
import {
  DEFAULT_LOG_LIMITS,
  LOG_DB_NAME,
  LogStore,
  clearLogFiles,
  logDirOf,
  logFilesIn,
  type LogLimits,
} from './store.js'

/** 队列上限：200 条。满了丢最旧。 */
export const LOG_QUEUE_MAX = 200

/** 批量窗口上界：50ms。正常路径由 setImmediate 立即 flush，这个值只在事件循环被占住时生效。 */
export const LOG_FLUSH_WINDOW_MS = 50

/** log.write_failed 的限频间隔：1 次/分钟（草案第三节）。 */
export const LOG_WRITE_FAILED_MIN_INTERVAL_MS = 60 * 1000

/**
 * 模块状态收在一个对象里（而不是一组模块级 let）。
 *
 * 除了「测试里一眼能复位」之外还有一条实际理由：仓库的阈值覆盖检查会把模块级
 * 数值常量（含 `let x = 0`）当成待登记的阈值扫出来。这些是运行时计数器的初值，
 * 不是阈值；收进对象后既不冒充阈值，也不会被误登记成「标定值」。
 */
interface LogState {
  /** 是否已配置 dataDir。未配置时 logEvent 一律丢弃（不猜日志该落在哪）。 */
  active: boolean
  dataDir: string
  limits: LogLimits
  store: LogStore | null
  queue: LogRow[]
  scheduled: boolean
  /** 队首入队时刻；0 表示队列为空。 */
  firstQueuedAt: number
  dropped: number
  writeFailures: number
  lastWriteFailedAt: number
}

const state: LogState = {
  active: false,
  dataDir: '',
  limits: DEFAULT_LOG_LIMITS,
  store: null,
  queue: [],
  scheduled: false,
  firstQueuedAt: 0,
  dropped: 0,
  writeFailures: 0,
  lastWriteFailedAt: 0,
}

/**
 * 指定日志库所在的数据目录。
 *
 * 必须在 getRuntime 与两条日志路由里都调用：日志模块不认识 RuntimeConfig，
 * 而「日志该落到哪个库」与「记忆库在哪个目录」必须是同一个答案。
 * 重复调用同目录是幂等的；换目录会先关旧连接（测试与多实例场景）。
 */
export function configureLog(dir: string, overrides?: Partial<LogLimits>): void {
  if (dir === '') return
  if (dir === state.dataDir) {
    state.active = true
    if (overrides !== undefined) {
      state.limits = { ...DEFAULT_LOG_LIMITS, ...overrides }
      state.store?.close()
      state.store = null
    }
    return
  }
  closeLog()
  state.dataDir = dir
  state.limits = { ...DEFAULT_LOG_LIMITS, ...overrides }
  state.active = true
  // 诊断计数器跟着数据目录走：换库之后「上一轮丢了多少、失败几次」不再是这一轮的事实。
  state.dropped = 0
  state.writeFailures = 0
  state.lastWriteFailedAt = 0
}

/**
 * 记一条事件。**唯一的写入口**：等级校验、白名单过滤、入队都在这里。
 *
 * 不合格的等级/事件/字段被 sanitizeEvent 丢弃；这里不抛错，也不返回值 ——
 * 调用方（召回、写入、标定）不该需要处理日志的失败。
 *
 * **调用方一般不该直接用它**，用下面的 `log.info / log.warn / log.error`：
 * 那里的函数名就是等级，没有可以写错的字面量。
 */
export function logEvent(level: LogLevel, event: string, detail?: Record<string, unknown>): void {
  if (!state.active || state.dataDir === '') return
  const row = sanitizeEvent(level, event, detail)
  if (row === null) return
  enqueue({ ts: Date.now(), ...row })
}

/**
 * 按等级分的写入口。**写日志用这三个，不要手写级别字符串。**
 *
 * 为什么包一层：`logEvent('warn', ...)` 的等级是一个裸字面量 —— 打错字编译器拦不住，
 * 把一个「做成了的事」记成 warn 也没人拦。而这三者的名字就是等级本身，读调用点时
 * 不需要先认出字符串再判断严重程度。
 *
 * 这一层**不做任何判断**：等级是否合法、事件在不在白名单、字段能不能落库，全部由
 * `logEvent` → `sanitizeEvent` 那一层决定。所以它不会成为「绕过校验的后门」。
 *
 * 什么时候仍用 `logEvent`：需要按变量传等级的批量写入（目前没有）、以及测试里专门
 * 验证底层过滤的那几条用例。
 */
export const log = {
  /** 做成了的事（如重标完成）。不是「一切正常」的流水账 —— 那不需要日志库。 */
  info: (event: string, detail?: Record<string, unknown>): void => logEvent('info', event, detail),
  /** 降级但还能用：词面路失效、图路不可用、样本库写不进。 */
  warn: (event: string, detail?: Record<string, unknown>): void => logEvent('warn', event, detail),
  /** 日志模块自身或重标这类「本应成功、实际失败」的事。 */
  error: (event: string, detail?: Record<string, unknown>): void => logEvent('error', event, detail),
} as const

/** 立即 flush（关闭前、测试里、清空前用）。失败同样不抛。 */
export function flushLog(): void {
  state.scheduled = false
  flushNow()
}

/**
 * 关闭日志库：尽力 flush 一次，然后关连接并清空队列。
 *
 * 挂在插件卸载（ctx.effect 的 dispose）上。清空队列是**刻意**的：卸载之后还留在
 * 内存里的行不会再有人写，留着只会让下一次激活把上一轮的旧行带进新库。
 */
export function closeLog(): void {
  if (state.queue.length > 0) flushNow()
  state.store?.close()
  state.store = null
  state.queue = []
  state.firstQueuedAt = 0
  state.scheduled = false
  state.active = false
}

/** 已经发生过的写失败次数（诊断用；限频只影响落库，不影响计数）。 */
export function logWriteFailureCount(): number {
  return state.writeFailures
}

/** 因为队列满而丢掉的条数。 */
export function logDroppedCount(): number {
  return state.dropped
}

/** 当前还在内存里、尚未落盘的行数（测试与诊断用）。 */
export function pendingLogRows(): number {
  return state.queue.length
}

/** 日志库文件路径：排障时要知道它在哪，但**不要**写到日志里。 */
export function logFilePath(dir: string): string {
  return logDirOf(dir) + '/' + LOG_DB_NAME
}

/** 导出全部保留的日志（只读）。见 export.ts 的三条约束。 */
export { exportLogCsv, CSV_HEADER, CSV_TRUNCATED }
export type { LogExport }

/** 清空结果。removed 含 -wal/-shm，因此可能大于日志库文件数。 */
export interface ClearResult {
  removed: number
}

/**
 * 清空日志：关连接 → 丢队列 → 删本模块的文件 → 等下一次写时重建空库。
 *
 * 顺序不能反：Windows 上打开着的文件删不掉，先删后关会得到「删了一半」。
 * 队列也必须丢掉 —— 否则清空后第一次 flush 会把清空前的行写回新库，
 * 用户会看到「清空了但还有数据」，那比报错更难解释。
 *
 * 失败时抛 LogClearError（消息可直接给用户看）；此时库仍可用：下一次写会新建
 * 或沿用自己的文件。
 */
export function clearLog(dir: string): ClearResult {
  const target = dir === '' ? state.dataDir : dir
  if (target === '') return { removed: 0 }
  flushLog()
  state.store?.close()
  state.store = null
  state.queue = []
  state.firstQueuedAt = 0
  const result = clearLogFiles(target)
  if (state.dataDir === '') state.dataDir = target
  state.active = true
  return result
}

/** 日志目录下的全部文件（导出与清空的共用口径）。 */
export function logFiles(dir: string): string[] {
  return logFilesIn(logDirOf(dir))
}

/** 把一行放进队列；scheduleFlush=false 用于写失败路径（避免目录不可写时空转）。 */
function enqueue(row: LogRow, scheduleFlush = true): void {
  if (state.queue.length >= LOG_QUEUE_MAX) {
    state.queue.shift()
    state.dropped++
  }
  if (state.queue.length === 0) state.firstQueuedAt = Date.now()
  state.queue.push(row)
  if (!scheduleFlush) return
  if (Date.now() - state.firstQueuedAt >= LOG_FLUSH_WINDOW_MS) {
    flushLog()
    return
  }
  scheduleFlushSoon()
}

/** 用 setImmediate 合并同一轮事件循环里的写入。 */
function scheduleFlushSoon(): void {
  if (state.scheduled) return
  state.scheduled = true
  setImmediate(() => {
    if (!state.scheduled) return
    state.scheduled = false
    flushNow()
  })
}

/** 一次批量落盘。内部吞掉异常并走降级路径 —— 这是模块对外的承诺。 */
function flushNow(): void {
  if (state.queue.length === 0 || state.dataDir === '') return
  if (state.store === null) state.store = new LogStore(state.dataDir, state.limits)
  const batch = state.queue
  state.queue = []
  state.firstQueuedAt = 0
  try {
    state.store.append(batch)
  } catch (err) {
    noteWriteFailure(err, batch)
  }
}

/**
 * 写失败的降级：退回内存、限频记 log.write_failed。
 *
 * 这里**不安排下一次 flush**：目录不可写时若还排立即执行，会变成一个不断失败、
 * 不断重排的空转循环。下一次真实事件到来时自然会再试一次。
 */
function noteWriteFailure(err: unknown, batch: LogRow[]): void {
  state.writeFailures++
  state.store?.close()
  state.store = null
  // 放回队首（有界）：崩溃窗口之外，写失败不该让已经发生的降级痕迹消失。
  state.queue = batch.concat(state.queue).slice(-LOG_QUEUE_MAX)
  const now = Date.now()
  if (now - state.lastWriteFailedAt < LOG_WRITE_FAILED_MIN_INTERVAL_MS) return
  state.lastWriteFailedAt = now
  const row = sanitizeEvent('error', 'log.write_failed', { reason: reasonCodeOf(err) })
  if (row !== null) enqueue({ ts: now, ...row }, false)
}

// 资源参数：把「与机器相关」的数值从常量改成推导值。
//
// 为什么需要这一层：mmap_size / cache_size / busy_timeout 这类参数的合理取值取决于
// **机器内存与磁盘延迟**，写死一个数字必然在另一台机器上要么浪费要么不够。
// 256 MB 的 mmap 在 8 GB 机器上无所谓，在 2 GB 机器上就是白占；
// 5 秒的 busy_timeout 在慢盘上可能直接抛 SQLITE_BUSY。
//
// 做法：能推导的就推导，推导不出来的由配置覆盖。推导规则本身也标注在这里，
// 免得下一个人只看到一行算式而不知道它从哪来。

import { totalmem } from 'node:os'
import type { ThresholdValue } from '../threshold-types.js'

/** 资源参数取值。 */
export interface ResourceParams {
  /** SQLite mmap 窗口大小（字节）。 */
  mmapSize: number
  /** SQLite 页缓存大小（字节，可为负值表示 KiB，这里统一返回字节）。 */
  cacheSize: number
  /** 写锁等待上限（毫秒）。 */
  busyTimeout: number
  /** 推导所依据的机器内存（字节），便于健康检查里核对。 */
  detectedMemory: number
}

export interface ResourceOverrides {
  mmapSize?: number
  cacheSize?: number
  busyTimeout?: number
}

/**
 * 推导规则（每一档都写清依据）：
 *
 * - mmap = clamp(库大小 × 1.5, 64 MB, min(256 MB, 内存 × 1/8))。
 *   乘 1.5 是为了让整个库文件能落进窗口；上限同时受「固定 256 MB」与「内存的八分之一」约束，
 *   取更小的那个 —— mmap 是虚拟地址占用，但被访问的页会驻留物理内存，
 *   在 2 GB 机器上给 3.2 GB 的窗口没有意义。
 * - cache = 内存 × 5%，上下界 [16 MB, 128 MB]。SQLite 默认只有 2 MB，对万级 atom 偏小；
 *   但也不能无上限 —— 大内存机器上按 5% 算会凭空多占几百 MB，而收益早已饱和。
 * - busyTimeout = max(5000, 单条写入耗时 × 200)。实测单条写入约 3.5 ms，
 *   5 秒已能排下上千次写入；慢盘上按写入耗时放大，而不是拍一个更大的常数。
 */
// ── 推导规则里的每个数字，都在这里有个名字 ──────────────────
//
// 为什么具名：这些数原先直接写在算式里，读代码只能看到 `Math.min(256 * 1024 * 1024, mem / 8)`，
// 看不出「256 MB 是上限还是目标」「8 是从哪来的」。具名之后阈值登记表能定位到它们，
// 改的时候也知道改的是哪一条规则。

/** mmap 窗口的固定上限。 */
export const MMAP_LIMIT_BYTES = (256 * 1024 * 1024) satisfies ThresholdValue<
  'chosen',
  {
    why: '本机推导规则的上限、不是标定值：256 MB 是写死的上限，与「内存的八分之一」取更小者；上限本身是容量选择'
    failsWhen: ['机器内存', '库文件大小']
    guardedBy: ['test/memory.test.mjs']
    affects: 'mmap 窗口上限'
    diverges: '**已从常量改成推导值**（待办第 2、3 项），但仍是一个写死的上限'
    display: '{v} MB（上限，与「内存的八分之一」取更小者）'
    unit: 'MB'
  }
>

/** mmap 上限同时受「机器内存的几分之一」约束（取更小者）。 */
export const MMAP_MEMORY_DIVISOR = 8 satisfies ThresholdValue<
  'chosen',
  {
    why: '八分之一是经验取法（mmap 是虚拟地址占用，但被访问的页会驻留物理内存）；比例取值是选择，无记录'
    failsWhen: ['机器内存', '库的访问局部性']
    affects: 'mmap 上限的第二个约束：与固定 256 MB 取更小者'
    display: '{v}（内存的八分之一）'
  }
>

/** mmap 相对库文件的倍数：让整个库文件能落进窗口。 */
export const MMAP_GROWTH = 1.5 satisfies ThresholdValue<
  'chosen',
  {
    why: '1.5 只为留一点余量让整个库文件进窗口，没有实测出处'
    failsWhen: ['库文件大小']
    affects: 'mmap 目标窗口相对库文件大小的倍数：让整个库文件能落进窗口'
    display: '库文件的 {v} 倍'
    unit: 'x'
  }
>

/** mmap 下限，也是「还不知道库多大」时的默认窗口。 */
export const MMAP_FLOOR_BYTES = (64 * 1024 * 1024) satisfies ThresholdValue<
  'chosen',
  {
    why: '库很小时也至少给这么多的下限是容量选择；与上限同处的 1.5 倍 / 八分之一 / 64 MB 三个数都没有出处'
    failsWhen: ['机器内存']
    guardedBy: ['test/memory.test.mjs']
    affects: 'mmap 窗口下限（库很小时也至少给这么多）'
    display: '{v} MB（下限）'
    unit: 'MB'
  }
>

/** 页缓存占机器内存的比例。 */
export const CACHE_RATIO = 0.05 satisfies ThresholdValue<
  'chosen',
  {
    why: '页缓存占内存多少是取舍：SQLite 默认只有 2 MB，对万级 atom 偏小，也不能无上限；5% 没有实测依据'
    failsWhen: ['机器内存', '库的访问模式']
    affects: 'SQLite 页缓存目标大小（内存 × 5%）'
    display: '内存的 {v}%'
    unit: '%'
  }
>

/** 页缓存下限（SQLite 默认只有 2 MB，对万级 atom 偏小）。 */
export const CACHE_FLOOR_BYTES = (16 * 1024 * 1024) satisfies ThresholdValue<
  'chosen',
  {
    why: '页缓存下限是容量选择，无记录（同 CACHE_RATIO）'
    failsWhen: ['机器内存']
    guardedBy: ['test/memory.test.mjs']
    affects: '页缓存下限'
    display: '{v} MB'
    unit: 'MB'
  }
>

/** 页缓存上限（大内存机器上按 5% 算会凭空多占几百 MB，而收益早已饱和）。 */
export const CACHE_CEIL_BYTES = (128 * 1024 * 1024) satisfies ThresholdValue<
  'chosen',
  {
    why: '页缓存上限是容量选择，无记录（同 CACHE_RATIO）'
    failsWhen: ['机器内存']
    guardedBy: ['test/memory.test.mjs']
    affects: '页缓存上限'
    display: '{v} MB'
    unit: 'MB'
  }
>

/** 写锁等待的下限。 */
export const BUSY_TIMEOUT_FLOOR_MS = 5000 satisfies ThresholdValue<
  'chosen',
  {
    why: '写锁等待的下限本身是选择：实测的单条写入耗时只能说明「等这么久够排下很多次写入」，与该值之间没有算式（乘 200 也没有出处）'
    failsWhen: ['磁盘延迟', '并发写入压力']
    guardedBy: ['test/memory.test.mjs']
    affects: '写锁等待下限：max(5000, 单条写入耗时 × 200)'
    diverges: '**这个数同时是「本机实测」的产物**：3.5 ms × 200 里的 200 与 3.5 都没有文档出处'
    display: '{v} ms'
    unit: 'ms'
  }
>

/** 实测的单条写入耗时（毫秒）：慢盘上按它放大等待时间，而不是拍一个更大的常数。 */
export const WRITE_COST_MEASURED_MS = 3.5 satisfies ThresholdValue<
  'recheckable',
  {
    tool: '无脚本（本机磁盘上写一条记录并计时）'
    finding: '本机磁盘单条写入 3.5 ms，写锁等待时间以它为基数；换机器后这个数会变，届时等待时间自动跟着变'
    encoderModel: '不适用（磁盘写入计时，不用向量）'
    scale: '本机磁盘上写一条记录，多次计时取均值'
    failsWhen: ['磁盘延迟', '机器负载']
    affects: '写锁等待时间的推导基数：慢盘上按它放大，而不是拍一个更大的常数'
    display: '{v} ms（本机实测的单条写入耗时）'
    unit: 'ms'
  }
>

/** 等待时间相对单条写入耗时的倍数。 */
export const BUSY_TIMEOUT_MULTIPLIER = 200 satisfies ThresholdValue<
  'chosen',
  {
    why: '200 由「一次等待里最多排几次写入」这个取舍决定，没有实测出处'
    failsWhen: ['并发写入压力']
    affects: '等待时间 = 单条写入耗时 × 200（约能排下几百次写入）'
    display: '{v} 倍'
    unit: 'x'
  }
>

/**
 * 推导资源参数。
 *
 * `memBytes` 可注入：**判据要求用构造的内存输入断言输出**，而 totalmem() 读的是真机 ——
 * 不注入就只能测「本机这一种内存」，那不是对规则的检验。
 */
export function deriveResourceParams(
  dbFileSize = 0,
  overrides: ResourceOverrides = {},
  memBytes: number = totalmem(),
): ResourceParams {
  const mem = memBytes
  const mmapCeil = Math.min(MMAP_LIMIT_BYTES, mem / MMAP_MEMORY_DIVISOR)
  const mmapWant = dbFileSize > 0 ? dbFileSize * MMAP_GROWTH : MMAP_FLOOR_BYTES
  const mmap = clamp(mmapWant, MMAP_FLOOR_BYTES, Math.max(mmapCeil, MMAP_FLOOR_BYTES))
  const cache = clamp(mem * CACHE_RATIO, CACHE_FLOOR_BYTES, CACHE_CEIL_BYTES)
  const busy = Math.max(BUSY_TIMEOUT_FLOOR_MS, Math.round(WRITE_COST_MEASURED_MS * BUSY_TIMEOUT_MULTIPLIER))
  return {
    mmapSize: overrides.mmapSize ?? Math.round(mmap),
    cacheSize: overrides.cacheSize ?? Math.round(cache),
    busyTimeout: overrides.busyTimeout ?? busy,
    detectedMemory: mem,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

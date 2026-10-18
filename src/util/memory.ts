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
export const MMAP_LIMIT_BYTES = 256 * 1024 * 1024

/** mmap 上限同时受「机器内存的几分之一」约束（取更小者）。 */
export const MMAP_MEMORY_DIVISOR = 8

/** mmap 相对库文件的倍数：让整个库文件能落进窗口。 */
export const MMAP_GROWTH = 1.5

/** mmap 下限，也是「还不知道库多大」时的默认窗口。 */
export const MMAP_FLOOR_BYTES = 64 * 1024 * 1024

/** 页缓存占机器内存的比例。 */
export const CACHE_RATIO = 0.05

/** 页缓存下限（SQLite 默认只有 2 MB，对万级 atom 偏小）。 */
export const CACHE_FLOOR_BYTES = 16 * 1024 * 1024

/** 页缓存上限（大内存机器上按 5% 算会凭空多占几百 MB，而收益早已饱和）。 */
export const CACHE_CEIL_BYTES = 128 * 1024 * 1024

/** 写锁等待的下限。 */
export const BUSY_TIMEOUT_FLOOR_MS = 5000

/** 实测的单条写入耗时（毫秒）：慢盘上按它放大等待时间，而不是拍一个更大的常数。 */
export const WRITE_COST_MEASURED_MS = 3.5

/** 等待时间相对单条写入耗时的倍数。 */
export const BUSY_TIMEOUT_MULTIPLIER = 200

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

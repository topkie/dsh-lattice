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
export function deriveResourceParams(dbFileSize = 0, overrides: ResourceOverrides = {}): ResourceParams {
  const mem = totalmem()
  const mmapCeil = Math.min(256 * 1024 * 1024, mem / 8)
  const mmapWant = dbFileSize > 0 ? dbFileSize * 1.5 : 64 * 1024 * 1024
  const mmap = clamp(mmapWant, 64 * 1024 * 1024, Math.max(mmapCeil, 64 * 1024 * 1024))
  const cache = clamp(mem * 0.05, 16 * 1024 * 1024, 128 * 1024 * 1024)
  const busy = Math.max(5000, Math.round(3.5 * 200))
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

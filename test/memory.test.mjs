// 资源参数的推导规则（M4-T45 批二·判据：每条规则用**构造的输入**断言输出）。
//
// 为什么必须注入内存：totalmem() 读真机，不注入就只能测「本机这一种内存」，
// 那不是对规则的检验 —— 而规则的价值恰恰在换机器时。
//
// 钩子放在 describe 内部（node:test 顶层钩子是全局的）。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BUSY_TIMEOUT_FLOOR_MS,
  CACHE_CEIL_BYTES,
  CACHE_FLOOR_BYTES,
  MMAP_FLOOR_BYTES,
  MMAP_LIMIT_BYTES,
  deriveResourceParams,
} from '../dist/util/memory.js'

const MB = 1024 * 1024
const GB = 1024 * MB

describe('资源参数推导（T45 批二）', () => {
  it('大内存机型：cache 被上限压住；还不知道库多大时 mmap 取下限', () => {
    const r = deriveResourceParams(0, {}, 32 * GB)
    assert.equal(r.mmapSize, MMAP_FLOOR_BYTES, '库大小未知给下限 64 MB —— 上限要等库大到 1.5 倍才用满')
    assert.equal(r.cacheSize, CACHE_CEIL_BYTES, '32 GB × 5% = 1.6 GB，被 128 MB 上限压住')
    assert.equal(r.busyTimeout, BUSY_TIMEOUT_FLOOR_MS)
    assert.equal(r.detectedMemory, 32 * GB)
  })

  it('中等内存机型：mmap 受内存的八分之一约束（比固定上限更小）', () => {
    const r = deriveResourceParams(0, {}, 1 * GB)
    assert.equal(r.mmapSize, MMAP_FLOOR_BYTES, '1 GB/8 = 128 MB 与 64 MB 下限取大 —— 下限胜出')
    assert.equal(r.cacheSize, Math.round(1 * GB * 0.05), '50 MB 落在上下限之间，按比例走')
  })

  it('库文件比下限大：mmap 按 1.5 倍库大小，但仍受上限约束', () => {
    const mid = deriveResourceParams(100 * MB, {}, 8 * GB)
    assert.equal(mid.mmapSize, Math.round(100 * MB * 1.5), '150 MB 落在 [64 MB, 256 MB] 内')
    const big = deriveResourceParams(1 * GB, {}, 8 * GB)
    assert.equal(big.mmapSize, MMAP_LIMIT_BYTES, '1.5 GB 想超出上限，被压回 256 MB')
  })

  it('很小的库不报错，也不给低于下限的窗口', () => {
    const r = deriveResourceParams(1, {}, 2 * GB)
    assert.equal(r.mmapSize, MMAP_FLOOR_BYTES, '1 字节的库也至少给 64 MB')
    assert.ok(Number.isFinite(r.mmapSize) && r.mmapSize > 0)
  })

  it('内存很小时 cache 不低于下限（否则页缓存比 SQLite 默认还小）', () => {
    const r = deriveResourceParams(0, {}, 256 * MB)
    assert.equal(r.cacheSize, CACHE_FLOOR_BYTES, '256 MB × 5% = 12.8 MB，被 16 MB 下限托住')
    assert.ok(r.cacheSize >= CACHE_FLOOR_BYTES)
  })

  it('显式覆盖优先于推导（三个参数各自独立）', () => {
    const r = deriveResourceParams(0, { mmapSize: 123, cacheSize: 456, busyTimeout: 789 }, 8 * GB)
    assert.equal(r.mmapSize, 123)
    assert.equal(r.cacheSize, 456)
    assert.equal(r.busyTimeout, 789)
  })
})

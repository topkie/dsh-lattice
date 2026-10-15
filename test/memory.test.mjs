// 资源参数测试：推导规则 + 实际生效的 PRAGMA。
//
// 这一类参数的坑在于「推导了但没生效」：代码里有算式，连接上仍是旧值。
// 所以这里既验算式，也**读回 PRAGMA 实际值**比对。

import assert from 'node:assert/strict'
import { rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openDb, openVault } from '../dist/db/open.js'
import { deriveResourceParams } from '../dist/util/memory.js'

let dbFile = ''

beforeEach(() => {
  dbFile = join(
    tmpdir(),
    'dsh-lattice-res-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db',
  )
})

afterEach(() => {
  for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true })
})

describe('资源参数推导', () => {
  it('mmap 随库大小增长，但不超过内存的 10% 与 512 MB 上限', () => {
    const small = deriveResourceParams(1024 * 1024) // 1 MB 的库
    const big = deriveResourceParams(10 * 1024 * 1024 * 1024) // 10 GB 的库
    assert.ok(small.mmapSize < big.mmapSize, '库越大窗口越大')
    assert.ok(small.mmapSize >= 64 * 1024 * 1024, '再小的库也要给到 64 MB 下界')
    assert.ok(big.mmapSize <= 256 * 1024 * 1024, '不得超过 256 MB 上界')
    assert.ok(big.mmapSize <= big.detectedMemory / 8 + 1, '不得超过内存的八分之一')
  })

  it('cache 落在 16~256 MB，且随内存放大', () => {
    const r = deriveResourceParams(0)
    assert.ok(
      r.cacheSize >= 16 * 1024 * 1024 && r.cacheSize <= 128 * 1024 * 1024,
      'cache 越界: ' + r.cacheSize,
    )
  })

  it('显式覆盖优先于推导', () => {
    const r = deriveResourceParams(0, { mmapSize: 12345678, cacheSize: 4096, busyTimeout: 700 })
    assert.equal(r.mmapSize, 12345678)
    assert.equal(r.cacheSize, 4096)
    assert.equal(r.busyTimeout, 700)
  })

  it('busy_timeout 不会是 0（那会让写入立刻失败）', () => {
    assert.ok(deriveResourceParams(0).busyTimeout >= 5000)
  })
})

describe('资源参数真正落到连接上', () => {
  it('实际 PRAGMA 值与推导值一致', () => {
    const res = deriveResourceParams(0)
    const db = openDb(dbFile, {
      resources: { mmapSize: res.mmapSize, cacheSize: res.cacheSize, busyTimeout: res.busyTimeout },
    })
    const mmap = Number(db.prepare('PRAGMA mmap_size').get().mmap_size)
    // 注意：`PRAGMA busy_timeout` 返回的列名是 `timeout`，不是同名的 busy_timeout。
    const busy = Number(db.prepare('PRAGMA busy_timeout').get().timeout)
    // cache_size 以负值表示 KiB。
    const cacheKiB = Number(db.prepare('PRAGMA cache_size').get().cache_size)
    assert.equal(mmap, res.mmapSize, 'mmap 没生效')
    assert.equal(busy, res.busyTimeout, 'busy_timeout 没生效')
    assert.equal(-cacheKiB * 1024, res.cacheSize, 'cache 没生效')
    db.close()
  })

  it('小内存机器可以通过覆盖把占用压小', () => {
    const db = openDb(dbFile, { resources: { mmapSize: 64 * 1024 * 1024, cacheSize: 16 * 1024 * 1024 } })
    assert.equal(Number(db.prepare('PRAGMA mmap_size').get().mmap_size), 64 * 1024 * 1024)
    db.close()
  })

  it('只读打开也能设置等待上限（否则读会被写者饿死）', () => {
    const { db: rw } = openVault(dbFile)
    rw.close()
    const ro = openDb(dbFile, { readOnly: true })
    assert.ok(Number(ro.prepare('PRAGMA busy_timeout').get().timeout) > 0)
    ro.close()
  })

  it('库变大后重新打开会得到更大的 mmap 窗口', () => {
    const { db } = openVault(dbFile)
    // 塞入足够的数据让文件长大，再看推导是否跟着变。
    db.exec('CREATE TABLE IF NOT EXISTS filler (v BLOB)')
    db.exec('INSERT INTO filler(v) VALUES (zeroblob(2000000))')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    const size = statSync(dbFile).size
    assert.ok(size > 1024 * 1024, '前置条件：库应当已经长大')
    const small = deriveResourceParams(0)
    const grown = deriveResourceParams(size)
    assert.ok(grown.mmapSize >= small.mmapSize, '库变大后窗口不应变小')
  })
})

// 读路径不建推断边。
//
// 为什么值得单独钉：这件事曾经挂在召回上（每个连接试一次全量重建，理由是「没有别的地方
// 能建」）。写入路径与显式命令都能建之后，那条理由消失，而它带来的三个代价留下：只读连接
// 建不了边（诊断与对照实验都走只读）、第一次召回要付全量重建的时间、判据是「表里有没有
// 推断边」所以真实的半建状态永远不修。
//
// 两条判据各挡一种回归：
//   1. 有 atom、一条推断边都没有的库，召回之后边表仍然是 0 行 —— 挡住「重新接回读路径」。
//      夹具用真实写入路径造 atom 再删掉推断边，造出「半建」形态 —— 这正是旧判据认不出来、
//      以为已经建好的那个状态。
//   2. search.ts 不从别处导入任何建边函数（只读函数可以）—— 挡住「换个函数名接回来」。
//      注释里提到函数名不算，所以这里只检查 import 行。

import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { recall } from '../dist/pipeline/search.js'
import { VEC_DIM } from '../dist/util/vec.js'

let dbFile = ''
let db = null

/** 由文本确定性生成的伪随机单位向量：同一文本恒得同一向量。 */
function hashVec(text) {
  const v = new Float32Array(VEC_DIM)
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  for (let i = 0; i < v.length; i++) {
    h ^= i + 1
    h = Math.imul(h, 16777619) >>> 0
    v[i] = ((h % 2000) - 1000) / 1000
  }
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

describe('读路径不建推断边', () => {
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-readpath-' +
        process.pid +
        '-' +
        Date.now() +
        '-' +
        Math.random().toString(36).slice(2) +
        '.db',
    )
    db = openVault(dbFile).db
  })

  afterEach(() => {
    try {
      db?.close()
    } catch {
      /* 已关闭 */
    }
    db = null
    for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true })
  })

  it('有 atom、一条推断边都没有的库，召回之后推断边仍是 0 条', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    await writeAtom(ctx, { text: '代理端口第 1 段：系统代理必须走本地端口，否则访问境外源会超时。' })
    await writeAtom(ctx, { text: '代理端口第 2 段：本地端口被别的进程占用时，请求会直接失败。' })
    // 写入路径会当场补推断边（linkNewAtom）。删掉它们，得到「有 atom、推断边为 0」的
    // 半建形态 —— 旧代码的判据（表里有没有推断边）认不出它，会以为已经建好。
    db.prepare("DELETE FROM edge WHERE origin = 'inferred'").run()
    const inferred = () =>
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM edge WHERE src_type = 'atom' AND dst_type = 'atom' AND origin = 'inferred'",
          )
          .get().n,
      )
    assert.equal(inferred(), 0, '前提：召回之前推断边是空的')
    const res = recall(db, '代理端口', null, {})
    assert.ok(res.hits.length > 0, '召回本身要能跑出结果，否则这条判据是空转')
    assert.equal(inferred(), 0, '召回不得写边：推断边由写入路径与显式命令重建')
    assert.ok(res.meta.graphStatus.includes('推断边 0 条'), res.meta.graphStatus)
  })

  it('search.ts 不从别处导入任何建边函数', () => {
    const src = readFileSync(new URL('../src/pipeline/search.ts', import.meta.url), 'utf8')
    const imported = src
      .split('\n')
      .filter((line) => /^import\b/.test(line))
      .join('\n')
    for (const name of ['ensureGraphEdges', 'inferEdges', 'linkNewAtom']) {
      assert.ok(!imported.includes(name), 'search.ts 不应导入建边函数：' + name)
    }
    assert.ok(imported.includes('edgeOriginCounts'), '仍要读边表现状，只是不写')
  })
})

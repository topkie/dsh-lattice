// 新写入的记忆立刻获得推断边。
//
// 这件事曾经是缺口：读路径只在「表里一条推断边都没有」时补一次全量重建，
// 新写入的 atom 要等下一次全量重建才有边，在那之前图路找不到它。改由写入路径
// 局部补边之后，这个缺口才真正合上。
// 这里钉两件事：
//   1. 只靠写入路径、不手动重建，图路就能把新记忆带进候选；
//   2. 把它的边删掉之后，同一次召回不会把它补回来 —— 证明上一条来自边，不是别的路径。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { recall } from '../dist/pipeline/search.js'
import { VEC_DIM } from '../dist/util/vec.js'

let dbFile = ''
let db = null

/** 造一个 512 维单位向量：只有前几个分量非零，按给的比例分配。 */
function unit(weights) {
  const v = new Float32Array(VEC_DIM)
  let s = 0
  for (let i = 0; i < weights.length; i++) {
    v[i] = weights[i]
    s += weights[i] * weights[i]
  }
  const n = Math.sqrt(s) || 1
  for (let i = 0; i < weights.length; i++) v[i] = v[i] / n
  return v
}

describe('写入路径：新记忆立刻获得推断边', () => {
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-link-' +
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
    for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true })
  })

  it('只靠写入，图路就能找到刚写的记忆；删掉边就找不到', async () => {
    const A = '依赖解析要开 hoisted'
    // 文本与 A 不含任何共同的二字组：否则词面路会把 B 带进候选，测的就不是图路。
    const B = '装包链接失败先看落位策略'
    // 余弦 0.75：过建边线 0.7，又在汇入线 0.78 之下 —— 所以 B 只能经边到。
    const VA = unit([1, 0])
    const VB = unit([0.75, 0.661])
    const table = new Map([
      [A, VA],
      [B, VB],
    ])
    const ctx = createWriteCtx(db, {}, { encode: async (text) => table.get(text) ?? null })

    const ra = await writeAtom(ctx, { text: A })
    const rb = await writeAtom(ctx, { text: B })

    // 前置：B 不该因为词面或主题与 A 相邻（否则下面的对照不成立）。
    // 恰一对双向边，不多不少。用 some() 只能证明「有」，证明不了「只有」——
    // 多出来的边会把这个库的图路宽度改掉，而测试照样绿。
    const rows = db
      .prepare("SELECT src_id, dst_id FROM edge WHERE origin = 'inferred'")
      .all()
      .map((x) => [Number(x.src_id), Number(x.dst_id)])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1])
    const lo = Math.min(ra.atomId, rb.atomId)
    const hi = Math.max(ra.atomId, rb.atomId)
    assert.deepEqual(
      rows,
      [
        [lo, hi],
        [hi, lo],
      ],
      '两个原子之间应恰好一对双向 near 边',
    )

    // kVec: 1 把向量路压到只回种子，B 只能经边到。
    const res = recall(db, A, VA, { topN: 8, kVec: 1 })
    assert.ok(
      res.hits.map((h) => h.id).includes(rb.atomId),
      '图路应把新记忆带进候选：' + JSON.stringify(res.meta.counts),
    )
    assert.ok(res.meta.counts.graph > 0, '图路应该有输入：' + JSON.stringify(res.meta.counts))

    db.prepare("DELETE FROM edge WHERE origin = 'inferred' AND (src_id = ? OR dst_id = ?)").run(
      rb.atomId,
      rb.atomId,
    )
    const without = recall(db, A, VA, { topN: 8, kVec: 1 })
    assert.ok(
      !without.hits.map((h) => h.id).includes(rb.atomId),
      '删掉边之后同一次召回不该再出现 —— 否则上一条不是边带来的',
    )
  })
})

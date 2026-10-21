// 取代：被取代的条目不再当答案出现。
//
// 这里验三件事：
//   1. 旧条与新条都在候选里时，只出新条（旧条不是「分低」而是「过期」）；
//   2. 取代者不在候选里时保留旧条 —— 压掉它等于这一组什么都不给；
//   3. 显式检索（listAtomsByIds）仍能看到旧条并带 supersededBy。
//
// 与重复压制（suppressDuplicates）刻意分开测：重复取分高的那条，取代只留新条。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { closeRuntime } from '../dist/state.js'
import { openVault } from '../dist/db/open.js'
import { VEC_DIM } from '../dist/util/vec.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView } from '../dist/pipeline/view.js'
import { listAtomsByIds } from '../dist/pipeline/list.js'

/** 单热向量。 */
function oneHot(i) {
  const v = new Float32Array(VEC_DIM)
  v[i % VEC_DIM] = 1
  return v
}

let dir = ''
let db = null

describe('取代：被取代的条目不再当答案', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-supersede-'))
    db = openVault(join(dir, 'lattice.db')).db
  })

  afterEach(() => {
    closeRuntime()
    try {
      db?.close()
    } catch {
      /* 已关闭 */
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  })

  /** 按「文本前 12 字 → 向量」的假编码器写入若干条，返回 atom id。 */
  async function seed(items) {
    const encode = async (t) => {
      for (const [text, vec] of items) if (t.includes(text.slice(0, 12))) return vec
      return oneHot(200)
    }
    const ctx = createWriteCtx(db, {}, { encode })
    const ids = []
    for (const [text] of items) ids.push((await writeAtom(ctx, { text })).atomId)
    return ids
  }

  /** 把 oldId 标成「已被 newId 取代」—— 写入侧的 supersedes 参数做的就是这一条 UPDATE。 */
  function markSuperseded(oldId, newId) {
    db.prepare('UPDATE atom SET superseded_by = ? WHERE id = ?').run(newId, oldId)
  }

  it('判据 1：新旧两条都命中时，结果里只有新条', async () => {
    const V = oneHot(3)
    const ids = await seed([
      ['系统代理必须走本地端口，否则访问境外源会直接超时。', V],
      ['代理配置改成了新的端口与上游，旧的说明作废。', oneHot(4)],
    ])
    markSuperseded(ids[0], ids[1])
    const r = recall(db, '代理', V, {})
    const got = r.hits.map((h) => h.id)
    assert.ok(!got.includes(ids[0]), '被取代的旧条不该出现在结果里；实际：' + JSON.stringify(got))
    assert.ok(got.includes(ids[1]), '新条应当在结果里；实际：' + JSON.stringify(got))
    assert.equal(r.meta.suppressedSuperseded, 1, 'meta 要报出压了几条')
  })

  it('判据 2：取代者不在候选里时保留旧条，并在注入里标「已被取代」', async () => {
    const ids = await seed([
      ['系统代理必须走本地端口，否则访问境外源会直接超时。', oneHot(3)],
      ['代理配置改成了新的端口与上游，旧的说明作废。', oneHot(4)],
    ])
    markSuperseded(ids[0], ids[1])
    // 这条查询只命中旧条：新条讲的是「配置改成了什么」，不含「境外源」。
    // kVec: 1 是为了让向量路只取最近的 1 条 —— 库里只有 2 条时，默认 kVec 会把两条都带进
    // 候选集（cos=0 也照样返回），那样测的就不是「取代者不在候选里」了。
    const r = recall(db, '境外源', oneHot(3), { kVec: 1 })
    assert.deepEqual(
      r.hits.map((h) => h.id),
      [ids[0]],
      '新条没命中时旧条必须保留 —— 否则这一组什么都不给',
    )
    assert.equal(r.meta.suppressedSuperseded, 0)
    const view = assembleView(db, r, {}).text
    assert.ok(view.includes('已被 #' + ids[1] + ' 取代'), '保留的旧条要带「已被取代」标记')
  })

  it('判据 2 补：有压制时注入文本给出条数', async () => {
    const V = oneHot(3)
    const ids = await seed([
      ['系统代理必须走本地端口，否则访问境外源会直接超时。', V],
      ['代理配置改成了新的端口与上游，旧的说明作废。', oneHot(4)],
    ])
    markSuperseded(ids[0], ids[1])
    const r = recall(db, '代理', V, {})
    const view = assembleView(db, r, {}).text
    assert.ok(view.includes('另有 1 条已被取代'), '注入里要说明少了一条；实际：\n' + view)
  })

  it('判据 4：显式检索仍返回被取代的条目', async () => {
    const ids = await seed([
      ['系统代理必须走本地端口，否则访问境外源会直接超时。', oneHot(3)],
      ['代理配置改成了新的端口与上游，旧的说明作废。', oneHot(4)],
    ])
    markSuperseded(ids[0], ids[1])
    const rows = listAtomsByIds(db, [ids[0]])
    assert.equal(rows.length, 1, '显式检索不该被取代压制影响')
    assert.equal(rows[0].supersededBy, ids[1])
  })
})

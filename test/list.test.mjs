// 目录工具测试：只读、分页、过滤，以及项目级 scope 的语义。
//
// 直接塞 atom 而不走写入管线：本模块只读，构造输入比跑一遍编码快得多，
// 也不会因为落位阈值或切词规则的微调而跟着摇。
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, listAtoms, listAtomsByIds } from '../dist/pipeline/list.js'
import { recall } from '../dist/pipeline/search.js'

let dbFile = ''
let db = null

beforeEach(() => {
  dbFile = join(
    tmpdir(),
    'dsh-lattice-list-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db',
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

/** 塞一条 atom（连同检索正文）。 */
function seed(id, o = {}) {
  const text = o.text ?? '正文'
  db.prepare(
    'INSERT INTO atom(id, kind, text, summary, embedding, scope, project_key, origin, created_at, updated_at) VALUES (?, ?, ?, ?, zeroblob(2048), ?, ?, ?, ?, ?)',
  ).run(
    id,
    o.kind ?? '结论',
    text,
    o.summary ?? '摘要' + id,
    o.scope ?? 'global',
    o.projectKey ?? null,
    o.origin ?? 'model',
    id,
    id,
  )
  db.prepare('INSERT INTO atom_search(id, body) VALUES (?, ?)').run(id, text)
}

describe('目录：分页与过滤', () => {
  it('按写入顺序倒序分页，并带出总条数', () => {
    for (let i = 1; i <= 5; i++) seed(i, {})
    const p1 = listAtoms(db, { limit: 2, offset: 0 })
    assert.equal(p1.total, 5)
    assert.deepEqual(
      p1.rows.map((r) => r.id),
      [5, 4],
    )
    const p2 = listAtoms(db, { limit: 2, offset: 2 })
    assert.deepEqual(
      p2.rows.map((r) => r.id),
      [3, 2],
    )
    assert.deepEqual(
      listAtoms(db, { limit: 2, offset: 4 }).rows.map((r) => r.id),
      [1],
    )
    assert.equal(listAtoms(db, {}).limit, LIST_DEFAULT_LIMIT)
  })

  it('limit 被钳制在上下界内，不存在「一次给全部」的开关', () => {
    for (let i = 1; i <= 3; i++) seed(i, {})
    assert.equal(listAtoms(db, { limit: 999 }).limit, LIST_MAX_LIMIT)
    assert.equal(listAtoms(db, { limit: 0 }).limit, 1)
    assert.equal(listAtoms(db, { limit: -5 }).limit, 1)
  })

  it('按 kind 与 origin 过滤；空串等同不筛', () => {
    seed(1, { kind: '结论', origin: 'user' })
    seed(2, { kind: '坑', origin: 'import' })
    seed(3, { kind: '坑', origin: 'model' })
    assert.deepEqual(
      listAtoms(db, { kind: '坑' }).rows.map((r) => r.id),
      [3, 2],
    )
    assert.deepEqual(
      listAtoms(db, { origin: 'user' }).rows.map((r) => r.id),
      [1],
    )
    assert.equal(listAtoms(db, { kind: '不存在' }).total, 0)
    assert.equal(listAtoms(db, { kind: '' }).total, 3)
  })
})

describe('目录：按 id 批量取（搜索结果的归属显示要用）', () => {
  it('按 id 取回与 listAtoms 同形的行，顺序 id 倒序', () => {
    for (let i = 1; i <= 5; i++) seed(i, { origin: i === 2 ? 'user' : 'model' })
    const rows = listAtomsByIds(db, [2, 4, 1])
    assert.deepEqual(
      rows.map((r) => r.id),
      [4, 2, 1],
    )
    // 与目录行同形：归属显示要的字段一个都不能少
    const one = rows.find((r) => r.id === 2)
    assert.equal(one.origin, 'user')
    assert.equal(one.supersededBy, null)
    assert.equal(typeof one.recallHits, 'number')
    assert.ok('lastRecalledAt' in one)
    assert.equal(one.kind, '结论')
  })

  it('空入参、非法 id、不存在的 id 都不炸', () => {
    seed(1, {})
    assert.deepEqual(listAtomsByIds(db, []), [])
    assert.deepEqual(listAtomsByIds(db, [0, -3, 1.5, NaN]), [])
    assert.equal(listAtomsByIds(db, [1, 1, 999]).length, 1)
  })
})

describe('目录：项目级 scope', () => {
  it('看某个项目时同时看到全局，看不到别的项目', () => {
    seed(1, { scope: 'global' })
    seed(2, { scope: 'proj-a', projectKey: 'proj-a' })
    seed(3, { scope: 'proj-b', projectKey: 'proj-b' })
    assert.deepEqual(
      listAtoms(db, { scope: 'proj-a' }).rows.map((r) => r.id),
      [2, 1],
    )
    assert.deepEqual(
      listAtoms(db, { scope: 'proj-b' }).rows.map((r) => r.id),
      [3, 1],
    )
    // 不给 scope 即不隔离：三条都看得到
    assert.equal(listAtoms(db, {}).total, 3)
  })

  it('召回与目录对 scope 的语义一致', () => {
    seed(1, { scope: 'global', text: '系统代理配置要写在环境变量里' })
    seed(2, { scope: 'proj-a', text: '系统代理配置要写在环境变量里' })
    seed(3, { scope: 'proj-b', text: '系统代理配置要写在环境变量里' })
    // 纯词面召回（queryVec 为 null）：不加载模型也能验 scope 隔离
    const inA = recall(db, '系统代理', null, { scope: 'proj-a' })
      .hits.map((h) => h.id)
      .sort()
    assert.deepEqual(inA, [1, 2])
    const all = recall(db, '系统代理', null, {})
      .hits.map((h) => h.id)
      .sort()
    assert.deepEqual(all, [1, 2, 3])
  })
})

// 体检模块的单元测试：结构指标、两种「空」的分开报、只读、分页与上界。
//
// 夹具直接塞 atom / topic / entry / edge，不走写入管线：audit 只读这些表，
// 用写入管线造数会把「落位阈值」与「体检口径」两件事缠在一起 —— 阈值一调，
// 体检的用例跟着摇，而它本来不该摇。
//
// atom_pair 的构造走**真的** rebuildAtomPairs（不是手写 INSERT）：那张表的阈值与
// 写入口径归那边所有，手写一行会绕开它，测出来的就不是同一件事。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { ORPHAN_DEFINITION, audit, noDataReport } from '../dist/pipeline/audit.js'
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from '../dist/pipeline/list.js'
import { rebuildAtomPairs } from '../dist/cluster/rebuild.js'
import { VEC_DIM } from '../dist/util/vec.js'
import { GRAPH_INFER_MAX_ATOMS } from '../dist/graph/infer.js'
import { openRuler } from './ro-ruler.mjs'

/** 一行 topic。n_atoms 由调用方按夹具写成与实际成员一致。 */
function seedTopic(db, id, nAtoms, at = id) {
  db.prepare(
    'INSERT INTO topic(id, domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at) ' +
      'VALUES (?, NULL, ?, zeroblob(2048), ?, 0, ?, ?)',
  ).run(id, '主题' + id, nAtoms, at, at)
}

/** 一行 atom（连同 atom_search 正文；audit 不读正文，但 rebuildAtomPairs 的词面要读）。 */
function seedAtom(db, id, o = {}) {
  const text = o.text ?? '正文' + id
  db.prepare(
    'INSERT INTO atom(id, kind, text, summary, embedding, topic_id, fit, scope, origin, recall_hits, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, zeroblob(2048), ?, 1.0, ?, ?, ?, ?, ?)',
  ).run(
    id,
    o.kind ?? '结论',
    text,
    o.summary ?? '摘要' + id,
    o.topicId === undefined ? id : o.topicId,
    o.scope ?? 'global',
    o.origin ?? 'model',
    o.recallHits ?? 0,
    o.createdAt ?? id,
    id,
  )
  db.prepare('INSERT INTO atom_search(id, body) VALUES (?, ?)').run(id, text)
}

/** 一条入口。term 的唯一性由调用方保证（表上有 UNIQUE(atom_id, term, origin)）。 */
function seedEntry(db, atomId, term, origin, weight) {
  db.prepare(
    'INSERT INTO entry(atom_id, term, bigram, weight, origin, hits, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  ).run(atomId, term, term, weight, origin, atomId)
}

/** 正交的假向量：第 i 维为 1。只用来构造「同一对/不同对」，不参与真实语义。 */
function axisVec(i) {
  const v = new Float32Array(VEC_DIM)
  v[i % VEC_DIM] = 1
  return v
}

describe('体检（audit）：结构指标与两种「空」', () => {
  let dir = ''
  let dbFile = ''
  let db = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lattice-audit-'))
    dbFile = join(dir, 'lattice.db')
    db = openVault(dbFile).db
  })

  afterEach(() => {
    try {
      db?.close()
    } catch {
      /* 已关闭 */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('空库：比例给 null 而不是 0，每个发现项都报「无数据」', () => {
    const r = audit(db)
    assert.equal(r.dataState, 'empty')
    assert.equal(r.topics.atoms, 0)
    assert.equal(r.topics.withAtoms, 0)
    assert.equal(r.topics.singleMemberRatio, null)
    assert.equal(r.topics.atomTopicRatio, null)
    assert.equal(r.graph.state, 'no-data')
    assert.equal(r.entries.state, 'no-data')
    assert.equal(r.duplicates.state, 'no-data')
    assert.equal(r.orphans.state, 'no-data')
    assert.equal(r.recall.neverRecalledRatio, null)
    // 「无数据」必须说出口：否则空数组会被读成「没有问题」。
    assert.match(r.detail, /无数据/)
    assert.match(r.duplicates.detail, /没有数据|无数据/)
    // 空报告与真报告同形，调用方不必写两套分支。
    assert.deepEqual(noDataReport().topics, r.topics)
  })

  it('单成员 topic 占比与 atom/topic 比按 topic.n_atoms 算', () => {
    seedTopic(db, 1, 2)
    seedTopic(db, 2, 1)
    seedTopic(db, 3, 0) // 空 topic 不计入分母
    seedAtom(db, 1, { topicId: 1 })
    seedAtom(db, 2, { topicId: 1 })
    seedAtom(db, 3, { topicId: 2 })
    seedAtom(db, 4, { topicId: null })
    const r = audit(db)
    assert.equal(r.dataState, 'ready')
    assert.equal(r.topics.atoms, 4)
    assert.equal(r.topics.withAtoms, 2)
    assert.equal(r.topics.singleMember, 1)
    assert.equal(r.topics.singleMemberRatio, 0.5)
    assert.equal(r.topics.atomTopicRatio, 2)
    assert.equal(r.topics.withoutTopic, 1)
    // 与 SQL 直查一致：不拿模块自己的输出对照自己。
    const direct = Number(db.prepare('SELECT COUNT(*) AS n FROM topic WHERE n_atoms = 1').get().n)
    assert.equal(r.topics.singleMember, direct)
  })

  it('atom_pair 为空时区分「没建过」与「建过但没有」', () => {
    seedTopic(db, 1, 1)
    seedTopic(db, 2, 1)
    seedAtom(db, 1, { topicId: 1, text: '代理必须走本地端口' })
    seedAtom(db, 2, { topicId: 2, text: '完全不相干的一句话' })

    // ① 没有重聚类记录：空表只能说「没有数据」。
    const before = audit(db)
    assert.equal(before.duplicates.state, 'no-data')
    assert.equal(before.duplicates.rebuiltAt, null)
    assert.match(before.duplicates.detail, /先跑一次重建/)

    // ② 真的跑一次 atom_pair 回填（正交向量 + 不相干文本）：0 对，但这次是「没有发现」。
    rebuildAtomPairs(
      db,
      new Map([
        [1, axisVec(1)],
        [2, axisVec(2)],
      ]),
      {
        texts: new Map([
          [1, '代理必须走本地端口'],
          [2, '完全不相干的一句话'],
        ]),
      },
    )
    const after = audit(db)
    assert.equal(after.duplicates.state, 'no-findings')
    assert.ok(typeof after.duplicates.rebuiltAt === 'number')
    assert.equal(after.duplicates.total, 0)

    // ③ 两条几乎相同、却分属不同 topic：这才是「发现」。
    db.prepare(
      "UPDATE atom SET text = '代理必须走本地端口，否则会超时', summary = '同一件事' WHERE id = 2",
    ).run()
    db.prepare("UPDATE atom_search SET body = '代理必须走本地端口，否则会超时' WHERE id = 2").run()
    rebuildAtomPairs(
      db,
      new Map([
        [1, axisVec(3)],
        [2, axisVec(3)],
      ]),
      {
        texts: new Map([
          [1, '代理必须走本地端口，否则会超时'],
          [2, '代理必须走本地端口，否则会超时'],
        ]),
      },
    )
    const found = audit(db)
    assert.equal(found.duplicates.state, 'has-findings')
    assert.equal(found.duplicates.total, 1)
    assert.equal(found.duplicates.rows[0].aId, 1)
    assert.equal(found.duplicates.rows[0].bId, 2)
    assert.equal(found.duplicates.rows[0].cos, 1)
    assert.equal(found.duplicates.rows[0].lexical, 1)
  })

  it('同一 topic 内的高相似对不算「未合并」', () => {
    seedTopic(db, 1, 2)
    seedAtom(db, 1, { topicId: 1, text: '同一句话' })
    seedAtom(db, 2, { topicId: 1, text: '同一句话' })
    rebuildAtomPairs(
      db,
      new Map([
        [1, axisVec(5)],
        [2, axisVec(5)],
      ]),
      {
        texts: new Map([
          [1, '同一句话'],
          [2, '同一句话'],
        ]),
      },
    )
    const r = audit(db)
    assert.equal(r.duplicates.state, 'no-findings')
    assert.equal(r.duplicates.total, 0)
    assert.match(r.duplicates.detail, /同一 topic/)
  })

  it('高相似对的分页与上界：limit 钳制在 [1, LIST_MAX_LIMIT]', () => {
    for (let i = 1; i <= 3; i++) {
      seedTopic(db, i, 1)
      seedAtom(db, i, { topicId: i, text: '三句完全一样的话' })
    }
    rebuildAtomPairs(
      db,
      new Map([
        [1, axisVec(7)],
        [2, axisVec(7)],
        [3, axisVec(7)],
      ]),
      {
        texts: new Map([
          [1, '三句完全一样的话'],
          [2, '三句完全一样的话'],
          [3, '三句完全一样的话'],
        ]),
      },
    )
    const page1 = audit(db, { limit: 1 })
    assert.equal(page1.duplicates.total, 3)
    assert.equal(page1.duplicates.limit, 1)
    assert.equal(page1.duplicates.rows.length, 1)
    const page2 = audit(db, { limit: 1, offset: 1 })
    assert.equal(page2.duplicates.rows.length, 1)
    assert.equal(page2.duplicates.rows[0].bId, 3, '第二页接着第一页，不重复也不跳号')
    assert.equal(audit(db, { limit: 999 }).duplicates.limit, LIST_MAX_LIMIT)
    assert.equal(audit(db, { limit: 0 }).duplicates.limit, 1)
    assert.equal(audit(db).duplicates.limit, LIST_DEFAULT_LIMIT)
  })

  it('孤立 atom = 无边 + 单成员 topic；计数与 SQL 直查一致，加一条边就消失', () => {
    seedTopic(db, 1, 1)
    seedTopic(db, 2, 1)
    seedTopic(db, 3, 1)
    seedAtom(db, 1, { topicId: 1 })
    seedAtom(db, 2, { topicId: 2 })
    seedAtom(db, 3, { topicId: 3 })
    db.prepare(
      "INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES ('atom', 2, 'atom', 3, 'near', 0.9, 'inferred', 1)",
    ).run()
    const r = audit(db)
    assert.equal(r.orphans.total, 1)
    assert.equal(r.orphans.rows[0].id, 1)
    assert.equal(r.orphans.definition, ORPHAN_DEFINITION)
    const direct = Number(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM atom a JOIN topic t ON t.id = a.topic_id WHERE t.n_atoms = 1 ' +
            "AND NOT EXISTS (SELECT 1 FROM edge e WHERE (e.src_type = 'atom' AND e.src_id = a.id) " +
            "OR (e.dst_type = 'atom' AND e.dst_id = a.id))",
        )
        .get().n,
    )
    assert.equal(r.orphans.total, direct)
    // 任何一条边都算「有边」—— 包括 atom → topic 的 near 边。
    db.prepare(
      "INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES ('atom', 1, 'topic', 1, 'near', 0.5, 'declared', 1)",
    ).run()
    assert.equal(audit(db).orphans.total, 0)
    assert.equal(audit(db).orphans.state, 'no-findings')
  })

  it('入口噪声：每 atom 平均入口数与 learned 占比', () => {
    seedTopic(db, 1, 3)
    for (let i = 1; i <= 3; i++) seedAtom(db, i, { topicId: 1 })
    seedEntry(db, 1, '代理', 'declared', 1)
    seedEntry(db, 1, '端口', 'extracted', 0.6)
    seedEntry(db, 2, '超时', 'extracted', 0.6)
    seedEntry(db, 2, '本地', 'extracted', 0.6)
    seedEntry(db, 3, '反哺', 'learned', 0.3)
    seedEntry(db, 3, '记忆', 'learned', 0.3)
    const r = audit(db)
    assert.equal(r.entries.total, 6)
    assert.equal(r.entries.declared, 1)
    assert.equal(r.entries.extracted, 3)
    assert.equal(r.entries.learned, 2)
    assert.equal(r.entries.perAtom, 2)
    assert.equal(r.entries.learnedRatio, 2 / 6)
  })

  it('图路状态按两类边判，不触发建边', () => {
    seedTopic(db, 1, 2)
    seedAtom(db, 1, { topicId: 1 })
    seedAtom(db, 2, { topicId: 1 })
    const before = audit(db)
    assert.equal(before.graph.status, 'not-built')
    assert.equal(before.graph.inferredEdges, 0)
    assert.equal(before.graph.declaredEdges, 0)
    // 只加声明边：图路同样有输入（声明边用的 kind 也在 GRAPH_KINDS 白名单里），
    // 所以不能报「没建过」。这一条钉的是「有声明边、但建不出推断边」那个形态。
    db.prepare(
      "INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES ('atom', 1, 'atom', 2, 'related', 1, 'declared', 1)",
    ).run()
    const declaredOnly = audit(db)
    assert.equal(declaredOnly.graph.status, 'built')
    assert.equal(declaredOnly.graph.declaredEdges, 1)
    assert.equal(declaredOnly.graph.inferredEdges, 0)
    assert.deepEqual(declaredOnly.graph.byKind, {})
    // 再加一条推断边：两类各自报数；byKind 只统计推断边（kind 分布是推断边的性质）。
    db.prepare(
      "INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES ('atom', 1, 'atom', 2, 'near', 0.9, 'inferred', 1)",
    ).run()
    const after = audit(db)
    assert.equal(after.graph.status, 'built')
    assert.equal(after.graph.inferredEdges, 1)
    assert.equal(after.graph.declaredEdges, 1)
    assert.deepEqual(after.graph.byKind, { near: 1 })
  })

  it('规模超过推断上限、但库里有声明边：不许报成「空」', () => {
    // 为了越过上限只造 atom 行，不建 atom_search —— audit 不读正文。
    const insert = db.prepare(
      'INSERT INTO atom(id, kind, text, summary, embedding, topic_id, fit, scope, origin, recall_hits, created_at, updated_at) ' +
        "VALUES (?, '结论', 'x', 'x', zeroblob(2048), NULL, 1.0, 'global', 'model', 0, ?, ?)",
    )
    db.exec('BEGIN')
    for (let i = 1; i <= GRAPH_INFER_MAX_ATOMS + 1; i += 1) insert.run(i, i, i)
    db.exec('COMMIT')
    db.prepare(
      "INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES ('atom', 1, 'atom', 2, 'related', 1, 'declared', 1)",
    ).run()
    const r = audit(db)
    assert.equal(r.graph.status, 'built', '有声明边就不是空图路')
    assert.equal(r.graph.declaredEdges, 1)
    assert.equal(r.graph.inferredEdges, 0)
    assert.match(r.graph.detail, /推断边不会重建/)
  })

  it('只读：跑前后 data_version、各表行数、recall_hits 总和与文件 mtime 都不变', () => {
    seedTopic(db, 1, 2)
    seedAtom(db, 1, { topicId: 1, recallHits: 3 })
    seedAtom(db, 2, { topicId: 1, recallHits: 5 })
    seedEntry(db, 1, '代理', 'learned', 0.3)
    // 观测走另一个只读连接：同连接读 PRAGMA data_version 看不到本连接自己的写，
    // 只量行数又抓不到「改了某一列」的写。只读连接全程开着，前后用同一个。
    const ruler = openRuler(dbFile)
    try {
      const before = ruler.read()
      const mtimeBefore = statSync(dbFile).mtimeMs
      audit(db)
      audit(db, { limit: 1, offset: 0 })
      assert.deepEqual(ruler.read(), before)
      assert.equal(statSync(dbFile).mtimeMs, mtimeBefore, '文件 mtime 不该变')
    } finally {
      ruler.close()
    }
  })

  it('输出里没有二值判决词（U2：比例只作参考）', () => {
    seedTopic(db, 1, 1)
    seedAtom(db, 1, { topicId: 1 })
    const text = JSON.stringify(audit(db))
    assert.ok(!/通过|失败|健康|正常|异常/.test(text), text)
    assert.equal(audit(db).referenceOnly, true)
  })
})

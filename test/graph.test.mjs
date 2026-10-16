// 图扩展测试：推断出的 atom 之间的边，以及它在注入里的消费者（【路】段）。
//
// 两条被测行为的来历，都是这次任务里查出来的：
//   · 出度上限 —— §33 与 §40 都点名要求它，而在此之前代码里根本不存在 atom 之间的边，
//     所以没有任何用例挡得住「边爆炸」；
//   · 路段只认 atom 之间的边 —— 改之前那段 SQL 只检查边的一端在锚里，没检查另一端也是
//     atom，于是 atom 到 topic 的边会经 id 碰撞冒充一跳邻居。它不报错、也不改变计数，
//     因此活到现在；这条用例专门钉住它。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { ensureGraphEdges, inferEdges } from '../dist/graph/infer.js'
import { assembleView } from '../dist/pipeline/view.js'
import { VEC_DIM } from '../dist/util/vec.js'

const Q = String.fromCharCode(39)
const DUP = { dupCos: 0.92, dupLex: 0.72 }

let dbFile = ''
let db = null

beforeEach(() => {
  dbFile = join(
    tmpdir(),
    'dsh-lattice-graph-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db',
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

function blobOf(v) {
  const b = new Uint8Array(v.length * 4)
  new Float32Array(b.buffer, b.byteOffset, v.length).set(v)
  return b
}

/** 往库里塞一个带真向量的 atom，返回它的 id。 */
function seedAtom(topicId, text, vec) {
  const now = Date.now()
  if (!db.prepare('SELECT 1 AS ok FROM topic WHERE id = ?').get(topicId)) {
    db.prepare(
      'INSERT INTO topic(id, domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at) VALUES (?, NULL, ?, zeroblob(2048), 1, 0.8, ?, ?)',
    ).run(topicId, 'T' + topicId, now, now)
  }
  const r = db
    .prepare(
      'INSERT INTO atom(kind, text, summary, embedding, topic_id, fit, scope, project_key, source, source_ref, polarity, flags, created_at, updated_at) VALUES (' +
        Q +
        '结论' +
        Q +
        ', ?, ?, ?, ?, 0.8, ' +
        Q +
        'global' +
        Q +
        ', NULL, NULL, NULL, NULL, 0, ?, ?)',
    )
    .run(text, String(text).slice(0, 40), blobOf(vec), topicId, now, now)
  const id = Number(r.lastInsertRowid)
  db.prepare(
    'INSERT INTO atom_topic(atom_id, topic_id, weight, origin) VALUES (?, ?, 1.0, ' + Q + 'primary' + Q + ')',
  ).run(id, topicId)
  return id
}

function insertEdge(srcType, srcId, dstType, dstId, kind, conf, origin) {
  db.prepare(
    'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(srcType, srcId, dstType, dstId, kind, conf, origin, Date.now())
}

function outDegrees() {
  const rows = db
    .prepare("SELECT src_id AS id, COUNT(*) AS n FROM edge WHERE origin = 'inferred' GROUP BY src_id")
    .all()
  return rows.map((r) => ({ id: Number(r.id), n: Number(r.n) }))
}

describe('图扩展：边推断与出度控制', () => {
  it('每个 atom 的出度不超过目标出度 K', () => {
    // 五个向量两两都很近（余弦远高于截断线），所以候选邻居一定够多。
    const ids = []
    for (let i = 0; i < 5; i++) ids.push(seedAtom(1, '第' + i + '条记忆的正文', unit([1, 0.9, 0.8, 0.7])))
    const r = inferEdges(db, { nearK: 2, nearCosMin: 0.5, ...DUP })
    assert.equal(r.status, 'built')
    assert.equal(r.stats.atoms, 5)
    for (const d of outDegrees()) assert.ok(d.n <= 2, 'atom ' + d.id + ' 出度 ' + d.n + ' 超过 K')
    assert.ok(r.stats.maxOutDegree <= 2)
    assert.ok(r.stats.meanOutDegree <= 2)
  })

  it('硬上限压得住一个被调大的 K', () => {
    const ids = []
    for (let i = 0; i < 6; i++) ids.push(seedAtom(1, '第' + i + '条记忆的正文', unit([1, 0.9, 0.8, 0.7])))
    const r = inferEdges(db, { nearK: 100, nearCosMin: 0.5, outDegreeCap: 2, ...DUP })
    for (const d of outDegrees()) assert.ok(d.n <= 2, '硬上限没生效')
    assert.ok(r.stats.maxOutDegree <= 2)
  })

  it('低于余弦截断线的对不建边', () => {
    seedAtom(1, '甲条记忆的正文', unit([1, 0]))
    seedAtom(1, '乙条记忆的正文', unit([0, 1]))
    const r = inferEdges(db, { nearK: 4, nearCosMin: 0.5, ...DUP })
    assert.equal(r.stats.nearEdges, 0)
    assert.equal(r.stats.isolatedAtoms, 2)
  })

  it('重建是幂等的：连跑两次边数不变', () => {
    for (let i = 0; i < 4; i++) seedAtom(1, '第' + i + '条记忆的正文', unit([1, 0.9, 0.8, 0.7]))
    const a = inferEdges(db, { nearK: 3, nearCosMin: 0.5, ...DUP })
    const b = inferEdges(db, { nearK: 3, nearCosMin: 0.5, ...DUP })
    assert.equal(a.stats.nearEdges, b.stats.nearEdges)
    assert.equal(b.stats.removedEdges, a.stats.nearEdges, '第二次该先删掉上一次写的那批')
    assert.equal(outDegrees().length, 4)
  })

  it('不碰 declared / untyped 的边', () => {
    const a = seedAtom(1, '甲条记忆的正文', unit([1, 0.9]))
    const b = seedAtom(1, '乙条记忆的正文', unit([1, 0.9]))
    insertEdge('atom', a, 'topic', 1, 'near', 0.5, 'untyped')
    insertEdge('atom', a, 'atom', b, 'requires', 1.0, 'declared')
    inferEdges(db, { nearK: 4, nearCosMin: 0.5, ...DUP })
    const kept = db.prepare("SELECT COUNT(*) AS n FROM edge WHERE origin <> 'inferred'").get()
    assert.equal(Number(kept.n), 2)
  })

  it('atom_pair 里的对会变成 duplicate 边，且不过阈值的不建', () => {
    const a = seedAtom(1, '甲条记忆的正文', unit([1, 0.9]))
    const b = seedAtom(1, '乙条记忆的正文', unit([1, 0.85]))
    const c = seedAtom(1, '丙条记忆的正文', unit([1, 0.8]))
    db.prepare('INSERT INTO atom_pair(a_id, b_id, cos, lexical) VALUES (?, ?, ?, ?)').run(a, b, 0.95, 0.9)
    db.prepare('INSERT INTO atom_pair(a_id, b_id, cos, lexical) VALUES (?, ?, ?, ?)').run(a, c, 0.95, 0.1)
    const r = inferEdges(db, { nearK: 0, nearCosMin: 0.5, ...DUP })
    assert.equal(r.stats.duplicateEdges, 1, '词面不过线的那一对不该建 duplicate 边')
    const rows = db.prepare("SELECT src_id, dst_id FROM edge WHERE kind = 'duplicate'").all()
    assert.equal(rows.length, 1)
    assert.equal(Number(rows[0].src_id), a)
    assert.equal(Number(rows[0].dst_id), b)
  })

  it('库里已有推断边时 ensureGraphEdges 不重建', () => {
    for (let i = 0; i < 3; i++) seedAtom(1, '第' + i + '条记忆的正文', unit([1, 0.9, 0.8]))
    const first = ensureGraphEdges(db, { nearK: 2, nearCosMin: 0.5, ...DUP })
    assert.equal(first.status, 'built')
    const later = ensureGraphEdges(db, { nearK: 2, nearCosMin: 0.5, ...DUP })
    assert.equal(later.status, 'fresh')
  })
})

describe('注入组装：路段只认 atom 之间的边', () => {
  function recallOf(hits, topics) {
    return {
      hits,
      topics,
      meta: {
        counts: { vec: 0, entry: 0, body: 0, graph: 0 },
        graphStatus: 'fresh',
        lexicalDegraded: false,
        shortTermMiss: false,
        vectorMissing: true,
        suppressed: 0,
        topCosine: 0,
        primaryHits: hits.length,
        secondaryHits: 0,
        elapsedMs: 0,
      },
    }
  }
  function hit(id, topicId, summary, score) {
    return {
      id,
      score,
      final: score,
      topicId,
      fit: 0.8,
      summary,
      origin: 'model',
      supersededBy: null,
      ranks: { entry: 1 },
      affiliation: 1,
    }
  }

  it('atom 到 topic 的边不会经 id 碰撞冒充一跳邻居', () => {
    const a = seedAtom(1, '甲条记忆的正文', unit([1, 0.9]))
    const b = seedAtom(1, '乙条记忆的正文', unit([1, 0.85]))
    // 碰撞：dst_id 故意取成另一个 atom 的 id，但 dst_type 是 topic。
    insertEdge('atom', a, 'topic', b, 'near', 0.99, 'untyped')
    const view = assembleView(
      db,
      recallOf([hit(a, 1, '甲的摘要', 1)], [{ topicId: 1, label: 'T1', hits: 1 }]),
      {},
    )
    assert.ok(!view.text.includes('【路】'), '不该把 topic 边的另一端当成邻居')
  })

  it('atom 之间的 near 边会进路段', () => {
    const a = seedAtom(1, '甲条记忆的正文', unit([1, 0.9]))
    const b = seedAtom(1, '乙条记忆的正文', unit([1, 0.85]))
    insertEdge('atom', a, 'atom', b, 'near', 0.9, 'inferred')
    const view = assembleView(
      db,
      recallOf([hit(a, 1, '甲的摘要', 1)], [{ topicId: 1, label: 'T1', hits: 1 }]),
      {},
    )
    assert.ok(view.text.includes('【路】'))
    assert.ok(view.text.includes('乙条记忆'), '邻居的摘要该出现在路段里')
  })
})

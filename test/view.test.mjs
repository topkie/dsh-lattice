// 注入组装测试。
//
// 直接构造 RecallResult 与库内 atom，不经过召回与编码 —— 组装逻辑的输入就是一个
// 结构体，真跑上游只会让测试更慢、边界更难构造。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { assembleView, MIN_ANCHORS, TRIM_ORDER } from '../dist/pipeline/view.js'

let dbFile = ''
let db = null

beforeEach(() => {
  dbFile = join(
    tmpdir(),
    'dsh-lattice-view-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db',
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

/** 往库里塞 topic + atom（带全文与摘要），返回 atom id。 */
function seedAnim(db, topicId, label, text, terms) {
  const now = Date.now()
  if (!db.prepare('SELECT 1 AS ok FROM topic WHERE id = ?').get(topicId)) {
    db.prepare(
      'INSERT INTO topic(id, domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at) VALUES (?, NULL, ?, zeroblob(2048), 1, 0.8, ?, ?)',
    ).run(topicId, label, now, now)
  }
  const r = db
    .prepare(
      'INSERT INTO atom(kind, text, summary, embedding, topic_id, fit, scope, project_key, source, source_ref, polarity, flags, created_at, updated_at) VALUES (' +
        String.fromCharCode(39) +
        '结论' +
        String.fromCharCode(39) +
        ', ?, ?, zeroblob(2048), ?, 0.8, ' +
        String.fromCharCode(39) +
        'global' +
        String.fromCharCode(39) +
        ', NULL, NULL, NULL, NULL, 0, ?, ?)',
    )
    .run(text, String(text).slice(0, 40), topicId, now, now)
  const id = Number(r.lastInsertRowid)
  db.prepare(
    'INSERT INTO atom_topic(atom_id, topic_id, weight, origin) VALUES (?, ?, 1.0, ' +
      String.fromCharCode(39) +
      'primary' +
      String.fromCharCode(39) +
      ')',
  ).run(id, topicId)
  for (const t of terms) {
    db.prepare(
      'INSERT INTO entry(atom_id, term, bigram, weight, origin, hits, last_seen, created_at) VALUES (?, ?, ?, 0.6, ' +
        String.fromCharCode(39) +
        'extracted' +
        String.fromCharCode(39) +
        ', 0, NULL, ?)',
    ).run(id, t, t, now)
  }
  return id
}

/** 造一个 recall 结果。 */
function recallOf(hits, topics) {
  return {
    hits,
    topics,
    meta: {
      counts: { vec: 0, entry: 0, body: 0, graph: 0 },
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
  return { id, score, final: score, topicId, fit: 0.8, summary, ranks: { entry: 1 }, affiliation: 1 }
}

describe('注入组装：状态标记', () => {
  it('用户说的与导入的会标记，模型写的且未被取代的不标', () => {
    const a1 = seedAnim(db, 1, '构建', '构建产物需要把环境变量注入到打包流程里。', ['构建'])
    const a2 = seedAnim(db, 1, '构建', '打包流程要区分开发与生产两套变量。', ['打包'])
    const a3 = seedAnim(db, 1, '构建', '构建脚本统一放在 scripts 目录下管理。', ['脚本'])
    const a4 = seedAnim(db, 1, '构建', '发布前要跑一次完整门禁再合并。', ['发布'])
    const v = assembleView(
      db,
      recallOf(
        [
          { ...hit(a1, 1, '构建产物', 1), origin: 'user' },
          { ...hit(a2, 1, '打包流程', 0.9), origin: 'import' },
          { ...hit(a3, 1, '脚本目录', 0.8), origin: 'model', supersededBy: 42 },
          { ...hit(a4, 1, '发布门禁', 0.7), origin: 'model' },
        ],
        [{ topicId: 1, label: '构建', hits: 4 }],
      ),
      {},
    )
    assert.ok(v.text.includes('[' + a1 + '·我]'), '用户说的要标「我」')
    assert.ok(v.text.includes('[' + a2 + '·导入]'), '导入的要标「导入」')
    assert.ok(v.text.includes('已被 #42 取代'), '被取代的要带后继 id')
    assert.ok(v.text.includes('[' + a4 + '] '), '模型写的且未被取代的不加标记')
  })
})

describe('注入组装：基本结构', () => {
  it('空召回产出空文本，不做无意义的空段头', () => {
    const v = assembleView(db, recallOf([], []), {})
    assert.equal(v.anchors, 0)
    assert.equal(v.text.includes('【入口】'), false)
    assert.equal(v.text.includes('【路】'), false)
  })

  it('只有锚时输出【锚】段，不含空的【入口】【路】', () => {
    const id = seedAnim(db, 1, '构建', '构建产物需要把环境变量注入到打包流程里。', ['构建', '产物'])
    const v = assembleView(
      db,
      recallOf([hit(id, 1, '构建产物需要把环境变量注入。', 1)], [{ topicId: 1, label: '构建', hits: 1 }]),
      {},
    )
    assert.equal(v.anchors, 1)
    assert.ok(v.text.startsWith('【锚】'))
    assert.ok(v.text.includes('构建产物'))
    assert.equal(v.text.includes('【路】'), false, '无关联边时不应出现路段')
  })

  it('锚用全文而不是摘要', () => {
    const long = '这是一段足够长的记忆正文，用来确认锚段取的是全文而不是只有摘要那么短。'.repeat(3)
    const id = seedAnim(db, 1, '长文', long, ['长文'])
    const v = assembleView(
      db,
      recallOf([hit(id, 1, '摘要很短。', 1)], [{ topicId: 1, label: '长文', hits: 1 }]),
      {},
    )
    assert.ok(v.text.includes('足够长的记忆正文'), '锚必须包含全文内容')
  })
})

describe('注入组装：预算与裁剪', () => {
  it('硬约束：任何预算下都不超预算', () => {
    for (let i = 1; i <= 30; i++)
      seedAnim(db, i, '主题' + i, '记忆正文第 ' + i + ' 条，' + '内容'.repeat(80), ['词' + i, '标' + i])
    const hits = []
    const topics = []
    for (let i = 1; i <= 30; i++) {
      hits.push(hit(i, i, '摘要 ' + i, 1 - i / 100))
      topics.push({ topicId: i, label: '主题' + i, hits: 1 })
    }
    const rc = recallOf(hits, topics)
    for (const budget of [600, 1200, 3000, 6000, 20000]) {
      const v = assembleView(db, rc, { budget })
      assert.ok(v.text.length <= budget, '预算 ' + budget + ' 超了：' + v.text.length)
    }
  })

  it('锚永不被砍到保底条数以下', () => {
    for (let i = 1; i <= 20; i++)
      seedAnim(db, i, '主题' + i, '记忆 ' + i + '：' + '正文内容'.repeat(100), ['词' + i])
    const hits = []
    const topics = []
    for (let i = 1; i <= 20; i++) {
      hits.push(hit(i, i, '摘要 ' + i, 1))
      topics.push({ topicId: i, label: '主题' + i, hits: 1 })
    }
    const v = assembleView(db, recallOf(hits, topics), { budget: 300 })
    assert.ok(v.anchors >= MIN_ANCHORS, '锚不得少于 ' + MIN_ANCHORS + ' 条，实际 ' + v.anchors)
  })

  it('裁剪只在超预算时发生，且按声明的顺序', () => {
    for (let i = 1; i <= 12; i++)
      seedAnim(db, i, '主题' + i, '记忆 ' + i + '：' + '内容'.repeat(60), ['词' + i])
    const hits = []
    const topics = []
    for (let i = 1; i <= 12; i++) {
      hits.push(hit(i, i, '摘要 ' + i, 1))
      topics.push({ topicId: i, label: '主题' + i, hits: 1 })
    }
    const rc = recallOf(hits, topics)
    const roomy = assembleView(db, rc, { budget: 6000 })
    assert.deepEqual(roomy.trimmed, [], '预算充足时不应触发任何裁剪')
    const tight = assembleView(db, rc, { budget: 400 })
    assert.ok(tight.trimmed.length > 0, '预算紧时必须触发裁剪')
    assert.deepEqual(
      tight.trimmed,
      TRIM_ORDER.slice(0, tight.trimmed.length),
      '裁剪必须按 TRIM_ORDER 顺序，不得跳步',
    )
  })
})

describe('注入组装：入口段与路段', () => {
  it('入口段按主题汇总，含该主题的入口词', () => {
    const id = seedAnim(db, 1, '网络', '系统代理必须走本地端口。', ['代理', '端口', '本地'])
    const v = assembleView(
      db,
      recallOf([hit(id, 1, '系统代理必须走本地端口。', 1)], [{ topicId: 1, label: '网络', hits: 1 }]),
      {},
    )
    const idx = v.text.indexOf('【入口】')
    assert.ok(idx > 0, '应当有入口段')
    const seg = v.text.slice(idx)
    assert.ok(seg.includes('网络'), '入口段应带主题标签')
    assert.ok(seg.includes('代理'), '入口段应含入口词')
  })

  it('路段来自一跳边，且不回引锚自身', () => {
    const a = seedAnim(db, 1, 'A', '第一条记忆的正文内容。', ['甲'])
    const b = seedAnim(db, 1, 'A', '第二条记忆的正文内容。', ['乙'])
    db.prepare(
      'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES (' +
        String.fromCharCode(39) +
        'atom' +
        String.fromCharCode(39) +
        ', ?, ' +
        String.fromCharCode(39) +
        'atom' +
        String.fromCharCode(39) +
        ', ?, ' +
        String.fromCharCode(39) +
        'near' +
        String.fromCharCode(39) +
        ', 0.9, ' +
        String.fromCharCode(39) +
        'untyped' +
        String.fromCharCode(39) +
        ', ?)',
    ).run(a, b, Date.now())
    const v = assembleView(
      db,
      recallOf([hit(a, 1, '第一条摘要。', 1)], [{ topicId: 1, label: 'A', hits: 1 }]),
      {},
    )
    assert.ok(v.pathLines >= 1, '应当从边里取到一条路')
    const seg = v.text.slice(v.text.indexOf('【路】'))
    assert.ok(seg.includes('near'), '路行应当带边类型')
    assert.ok(seg.includes('第二条'), '路行应当是邻居的摘要')
  })

  it('同主题下未进锚的条数汇总成一行，不静默丢弃', () => {
    const ids = []
    for (let i = 1; i <= 8; i++)
      ids.push(seedAnim(db, 1, '集中', '记忆 ' + i + '：' + '内容'.repeat(80), ['词' + i]))
    const hits = ids.map((id, i) => hit(id, 1, '摘要 ' + i, 1 - i / 10))
    // 预算必须小于「全部装下」所需，否则不会有被挤掉的条目：
    // 8 条 × 约 205 字符 ≈ 1640，而锚段配额只有预算的 55%（700 × 0.55 = 385），
    // 只放得下前 3 条保底，其余应当计入「另有 N 条」。
    const v = assembleView(db, recallOf(hits, [{ topicId: 1, label: '集中', hits: 8 }]), {
      budget: 700,
      anchorMaxChars: 200,
    })
    assert.ok(v.otherRelated > 0, '预算不足时应当有未进锚的条目')
    assert.ok(v.text.includes('另有 ' + v.otherRelated + ' 条'), '必须显式告知还有多少条')
  })
})

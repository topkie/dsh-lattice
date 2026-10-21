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
import { TIER_BRIEF_MIN, TIER_FULL_MIN, assembleView, tierOf } from '../dist/pipeline/view.js'

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

/** 造一个 recall 结果。extra 覆盖 meta 里的字段（如 hasContent）。 */
function recallOf(hits, topics, extra) {
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
      ...(extra ?? {}),
    },
  }
}

function hit(id, topicId, summary, score) {
  // source 缺省为 null：真重复压制只在有来源时比较（没有来源证明不了同源）。
  return {
    id,
    score,
    final: score,
    topicId,
    fit: 0.8,
    summary,
    ranks: { entry: 1 },
    affiliation: 1,
    source: null,
  }
}

describe('注入组装：档位', () => {
  it('tierOf 的边界是闭区间下界', () => {
    assert.equal(tierOf(TIER_FULL_MIN), 'full')
    assert.equal(tierOf(TIER_FULL_MIN - 0.01), 'brief')
    assert.equal(tierOf(TIER_BRIEF_MIN), 'brief')
    assert.equal(tierOf(TIER_BRIEF_MIN - 0.01), 'excerpt')
  })
  it('档位只作观测，不改变呈现内容', () => {
    const ids = []
    for (let i = 0; i < 12; i++) {
      ids.push(
        seedAnim(db, 1, '构建', '第' + i + '条足够长的正文内容，用来把三个档位的输出规模撑开。', ['词' + i]),
      )
    }
    const hits = ids.map((id, i) => ({ ...hit(id, 1, '摘要' + i, 1 - i * 0.01), origin: 'model' }))
    const topics = [{ topicId: 1, label: '构建', hits: 12 }]
    const at = (cos) => {
      const r = recallOf(hits, topics)
      r.meta.vectorMissing = false
      r.meta.topCosine = cos
      return assembleView(db, r, {})
    }
    const full = at(0.8)
    const brief = at(0.5)
    const excerpt = at(0.2)
    // 档位字段仍然如实反映最高余弦（供观测用），但三档的内容与条数完全一样：
    // 旧形态按档位收缩锚条数与入口数，新形态只按预算装，档位不再是呈现的输入。
    assert.equal(full.tier, 'full')
    assert.equal(brief.tier, 'brief')
    assert.equal(excerpt.tier, 'excerpt')
    assert.equal(full.text, brief.text, '档位不该改变呈现内容')
    assert.equal(brief.text, excerpt.text, '档位不该改变呈现内容')
  })
})

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

  it('只有一条时只出【入选】段，不含旧的入口与路段', () => {
    const id = seedAnim(db, 1, '构建', '构建产物需要把环境变量注入到打包流程里。', ['构建', '产物'])
    const v = assembleView(
      db,
      recallOf([hit(id, 1, '构建产物需要把环境变量注入。', 1)], [{ topicId: 1, label: '构建', hits: 1 }]),
      {},
    )
    assert.equal(v.anchors, 1)
    assert.ok(v.text.startsWith('【入选】'))
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
    assert.ok(v.anchors >= 1, '预算很紧时也要至少给出一条，实际 ' + v.anchors)
    assert.ok(v.text.includes('预算装不下了'), '装不下要说出来')
  })

  it('预算紧时逐条装到装不下为止，并说明还有几条未列', () => {
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
    assert.equal(roomy.overBudget, 0, '预算充足时不该有条目被挤掉')
    assert.equal(roomy.anchors, 12, '预算充足时全部装进去')
    const tight = assembleView(db, rc, { budget: 400 })
    assert.ok(tight.anchors < 12, '预算紧时必须少装几条')
    assert.ok(tight.overBudget > 0, '被挤掉的条数要记下来')
    assert.ok(
      tight.text.includes('预算装不下了，还有 ' + tight.overBudget + ' 条未列。'),
      '必须显式告知还有多少条没装下',
    )
    // 装到预算的 95% 以上：最后一条按剩余额度截断，不因一条过长而把额度空着。
    // 装到 85% 以上：预算里要给标题与「还有 N 条未列」留位置，最后一条还要按剩余额度截断，
    // 合成用例（每条 126 字）比真实语料（10–16 条 / 6000 字符）更容易撞上这个损耗。
    assert.ok(tight.text.length >= 400 * 0.85, '预算要基本用满，实际 ' + tight.text.length)
  })
})

describe('注入组装：两段', () => {
  it('不再有入口段与路段：正文之外只剩未入选说明', () => {
    const a = seedAnim(db, 1, '网络', '系统代理必须走本地端口。', ['代理', '端口', '本地'])
    const v = assembleView(
      db,
      recallOf([hit(a, 1, '系统代理必须走本地端口。', 1)], [{ topicId: 1, label: '网络', hits: 1 }]),
      {},
    )
    assert.ok(v.text.startsWith('【入选】'), '第一段是【入选】')
    assert.ok(v.text.includes('系统代理必须走本地端口'), '正文要出现')
    assert.ok(!v.text.includes('【入口】'), '旧形态的【入口】段已经取消')
    assert.ok(!v.text.includes('【路】'), '旧形态的【路】段已经取消')
  })

  it('同源逐字重复只留一条，并单独说清压了几条', () => {
    const text = '同一份材料被切成了两条一模一样的正文内容，用来验证同源重复压制。'
    const a = seedAnim(db, 1, '集中', text, ['甲'])
    const b = seedAnim(db, 1, '集中', text, ['乙'])
    const hits = [
      { ...hit(a, 1, '摘要甲', 1), source: '同一篇.md' },
      { ...hit(b, 1, '摘要乙', 0.9), source: '同一篇.md' },
    ]
    const v = assembleView(db, recallOf(hits, [{ topicId: 1, label: '集中', hits: 2 }]), {})
    assert.equal(v.duplicateDropped, 1, '逐字重复的同源条目应当压掉一条')
    assert.equal(v.anchors, 1)
    assert.ok(v.text.includes('另有 1 条与同源内容重复，未列出'), '压了几条要单独说')
  })

  it('不同来源的逐字重复不压：分桶单位是来源', () => {
    const text = '两个不同来源里出现了一模一样的一段正文，用来验证分桶单位。'
    const a = seedAnim(db, 1, '集中', text, ['甲'])
    const b = seedAnim(db, 1, '集中', text, ['乙'])
    const hits = [
      { ...hit(a, 1, '摘要甲', 1), source: '甲.md' },
      { ...hit(b, 1, '摘要乙', 0.9), source: '乙.md' },
    ]
    const v = assembleView(db, recallOf(hits, [{ topicId: 1, label: '集中', hits: 2 }]), {})
    assert.equal(v.duplicateDropped, 0, '不同来源不参与同源比较')
    assert.equal(v.anchors, 2)
  })

  it('预算不足时把没装下的条数汇总成一行，不静默丢弃', () => {
    const ids = []
    for (let i = 1; i <= 8; i++)
      ids.push(seedAnim(db, 1, '集中', '记忆 ' + i + '：' + '内容'.repeat(80), ['词' + i]))
    const hits = ids.map((id, i) => hit(id, 1, '摘要 ' + i, 1 - i / 10))
    // 预算必须小于「全部装下」所需：8 条 × 约 205 字符 ≈ 1640，700 只放得下 3 条左右。
    const v = assembleView(db, recallOf(hits, [{ topicId: 1, label: '集中', hits: 8 }]), {
      budget: 700,
      anchorMaxChars: 200,
    })
    assert.ok(v.overBudget > 0, '预算不足时应当有条目没装下')
    assert.ok(v.text.includes('还有 ' + v.overBudget + ' 条未列'), '必须显式告知还有多少条')
  })
})

describe('注入组装：判空', () => {
  it('判空时一条都不装：结论说没有内容，注入段就不能端出条目', () => {
    // 二十四条无关查询在旧形态下也能装满 6000 字符，字符数与真查询完全相同 —— 只靠回执
    // 挡住的话，直接调 assembleView 的调用方（验证脚本、界面）拿到的仍是满额文本。
    const a = seedAnim(db, 1, '网络', '系统代理必须走本地端口。', ['代理'])
    const r = recallOf(
      [hit(a, 1, '系统代理必须走本地端口。', 0.4)],
      [{ topicId: 1, label: '网络', hits: 1 }],
      {
        hasContent: false,
      },
    )
    const v = assembleView(db, r, {})
    assert.equal(v.text, '', '判空时注入段是空的')
    assert.equal(v.anchors, 0)
    assert.deepEqual(v.anchorIds, [])
    assert.equal(v.used.anchors, 0)
  })

  it('判有内容时照常装填：短路只认 false 这一个取值', () => {
    const a = seedAnim(db, 1, '网络', '系统代理必须走本地端口。', ['代理'])
    const r = recallOf(
      [hit(a, 1, '系统代理必须走本地端口。', 0.9)],
      [{ topicId: 1, label: '网络', hits: 1 }],
      {
        hasContent: true,
      },
    )
    const v = assembleView(db, r, {})
    assert.equal(v.anchors, 1)
    assert.ok(v.text.includes('系统代理必须走本地端口'))
  })

  it('没有判定结果（hasContent 为 null 或缺失）也照常装填', () => {
    // 老调用方构造的 RecallResult 没有这个字段；判空是新增的可选判定，不能因此变成「什么都不给」。
    const a = seedAnim(db, 1, '网络', '系统代理必须走本地端口。', ['代理'])
    const v = assembleView(
      db,
      recallOf([hit(a, 1, '系统代理必须走本地端口。', 0.9)], [{ topicId: 1, label: '网络', hits: 1 }]),
      {},
    )
    assert.equal(v.anchors, 1)
  })
})

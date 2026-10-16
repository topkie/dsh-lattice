// 写入管线测试。
//
// 这里**不加载真实模型**：所有向量由测试自己注入。原因不只是速度——落位判定的
// 判据是阈值，用真实模型反而无法构造出「刚好 0.76」这类边界样本。真实模型的表现
// 由 scripts/verify-encoder.mjs 单独验证，两者分工明确。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { VEC_DIM, decodeVec, l2norm } from '../dist/util/vec.js'
import { buildEntries, buildVocabIndex, extractedEntries } from '../dist/pipeline/entries.js'
import { createWriteCtx, decidePlacement, invalidateVocab, writeAtom } from '../dist/pipeline/write.js'

let dbFile = ''
let db = null

beforeEach(() => {
  dbFile = join(
    tmpdir(),
    `dsh-lattice-write-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )
  db = openVault(dbFile).db
})

afterEach(() => {
  try {
    db?.close()
  } catch {
    /* 已关闭 */
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + suffix, { force: true })
})

/** 单热向量：第 i 维为 1，其余为 0（本身已是单位向量）。 */
function oneHot(i) {
  const v = new Float32Array(VEC_DIM)
  v[i % VEC_DIM] = 1
  return v
}

/** 由文本确定性生成的伪随机单位向量——同一文本恒等，不同文本近乎正交。 */
function hashVec(text) {
  const v = new Float32Array(VEC_DIM)
  // 以文本的 FNV-1a 哈希为种子：同一文本恒得同一向量，不同文本近乎正交。
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

/** 关键词 → 固定向量的假编码器。 */
function keywordEncoder(map, fallback = hashVec) {
  return async (text) => {
    for (const [kw, vec] of map) if (text.includes(kw)) return vec
    return fallback(text)
  }
}

function topicCount() {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM topic').get().n)
}
function atomRows() {
  return db.prepare('SELECT id, topic_id, fit, summary FROM atom ORDER BY id').all()
}

describe('写入管线：落位（向量 + 词面双票）', () => {
  it('同主题的新记忆并入已有 topic', async () => {
    const A = oneHot(3)
    const encode = keywordEncoder([
      ['系统代理', A],
      ['走代理', A],
    ])
    const ctx = createWriteCtx(db, {}, { encode })

    const first = await writeAtom(ctx, { text: '系统代理必须走系统代理端口，否则连不上外网。' })
    assert.equal(first.action, 'created')
    assert.equal(first.created, 'far', '首个 atom 无候选，必须落未归类域')
    assert.equal(first.fit, 1)

    const second = await writeAtom(ctx, { text: '走代理时系统代理配置要写进环境变量。' })
    assert.equal(second.action, 'joined')
    assert.equal(second.topicId, first.topicId)
    assert.ok(second.evidence.sim1 >= 0.78, `sim1 应达到并入阈值，实际 ${second.evidence?.sim1}`)
    assert.ok(second.evidence.lex1 >= 0.05, `词面重叠应过阈值，实际 ${second.evidence?.lex1}`)
    assert.equal(topicCount(), 1)
  })

  it('向量很近但词面几乎不重叠时**不**并入（单票不足以合并）', async () => {
    const A = oneHot(5)
    const encode = keywordEncoder([['向量检索', A]])
    const ctx = createWriteCtx(db, {}, { encode })

    await writeAtom(ctx, { text: '向量检索用余弦相似度排序候选。' })
    // 同一向量、完全不同的话题词——这正是「单靠余弦会静默合并」的场景。
    const second = await writeAtom(ctx, { text: '梅雨季节晾晒衣物时室内湿度长期偏高。' })
    assert.equal(second.action, 'created')
    assert.equal(topicCount(), 2)
  })

  it('余弦落在双峰区间时判为 ambiguous 并保留 near 边', async () => {
    const encode = keywordEncoder([
      ['罗盘', oneHot(10)],
      ['星图', oneHot(11)],
    ])
    const ctx = createWriteCtx(db, {}, { encode })
    await writeAtom(ctx, { text: '罗盘校准记录：磁偏角随时间缓慢变化。' })
    await writeAtom(ctx, { text: '星图绘制记录：赤经赤纬的换算表。' })

    // 与两者等距的向量 → sim1 ≈ sim2 ≈ 0.707，落在 [τ_new, τ_join) 且差值 < 0.06。
    const mid = new Float32Array(VEC_DIM)
    mid[10] = 1 / Math.sqrt(2)
    mid[11] = 1 / Math.sqrt(2)
    const r = await writeAtom(createWriteCtx(db, {}, { encode: async () => mid }), {
      text: '天文观测记录：需要同时参考罗盘与星图的结论。',
    })
    assert.equal(r.action, 'created')
    assert.equal(r.created, 'ambiguous')
    assert.ok(Math.abs(r.evidence.sim1 - r.evidence.sim2) < 0.06)
    const edges = db
      .prepare("SELECT COUNT(*) AS n FROM edge WHERE kind = 'near' AND src_id = ?")
      .get(r.atomId)
    assert.equal(Number(edges.n), 1, 'ambiguous 必须留下 near 边，否则这条记忆彻底孤立')
  })

  it('远到低于 τ_new 时新建且不留 near 边', async () => {
    // 按文本给不同方向：两条记忆的余弦刻意压在 0.3 以下。
    const A = oneHot(20)
    const B = oneHot(21)
    const encode = async (t) => (t.includes('潮汐') ? A : B)
    const ctx = createWriteCtx(db, {}, { encode })
    await writeAtom(ctx, { text: '港口潮汐表每个月重新校核一次。' })
    const r = await writeAtom(ctx, { text: '棱镜色散实验的读数记录在实验本第三页。' })
    assert.equal(r.action, 'created')
    assert.equal(r.created, 'far')
    const edges = db.prepare('SELECT COUNT(*) AS n FROM edge WHERE src_id = ?').get(r.atomId)
    assert.equal(Number(edges.n), 0)
  })
})

describe('写入管线：编码降级', () => {
  it('无 encoder 时仅凭词面并入，阈值抬高到 tauLexOnly', async () => {
    const ctx = createWriteCtx(db, {}, {})
    const a = await writeAtom(ctx, { text: '系统代理配置需要写入环境变量，并重启终端。' })
    assert.equal(a.action, 'created')
    assert.equal(a.evidence.lexicalOnly, true)

    const b = await writeAtom(ctx, { text: '系统代理配置：环境变量与终端重启的注意事项。' })
    assert.equal(b.action, 'joined', '词面重叠很高时应并入')
    assert.equal(b.topicId, a.topicId)

    const c = await writeAtom(ctx, { text: '构建产物需要把环境变量注入到打包流程里。' })
    assert.equal(c.action, 'created', '重叠不足时必须拒绝并入')
  })

  it('encode 抛错不冒泡——降级为词面模式继续写入', async () => {
    const ctx = createWriteCtx(
      db,
      {},
      {
        encode: async () => {
          throw new Error('模型加载失败')
        },
      },
    )
    const r = await writeAtom(ctx, { text: '编码器不可用时这条记忆仍必须能写进去。' })
    assert.equal(r.action, 'created')
    assert.equal(r.evidence.lexicalOnly, true)
    const blob = db.prepare('SELECT embedding FROM atom WHERE id = ?').get(r.atomId).embedding
    assert.ok(l2norm(decodeVec(blob)) === 0, '降级时写入的必须是零向量占位')
  })

  it('encoderOn=false 时完全不调用 encode', async () => {
    let called = 0
    const ctx = createWriteCtx(
      db,
      {},
      {
        encoderOn: false,
        encode: async () => {
          called++
          return oneHot(1)
        },
      },
    )
    await writeAtom(ctx, { text: '纯词面模式下不应触碰编码器。' })
    assert.equal(called, 0)
  })
})

describe('写入管线：落库完整性', () => {
  it('一次写入留下 atom / topic / atom_topic / entry / atom_search 全套', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const r = await writeAtom(ctx, {
      text: 'SQLite 的 WAL 模式允许单写多读，但长事务会阻塞 checkpoint。',
      kind: '坑',
      refs: ['WAL', 'checkpoint'],
    })

    const atom = db.prepare('SELECT * FROM atom WHERE id = ?').get(r.atomId)
    assert.equal(atom.kind, '坑')
    assert.equal(Number(atom.topic_id), r.topicId)
    assert.ok(atom.summary.length > 0 && atom.summary.length <= 48)

    const link = db.prepare('SELECT * FROM atom_topic WHERE atom_id = ?').all(r.atomId)
    assert.equal(link.length, 1)
    assert.equal(link[0].origin, 'primary')
    assert.equal(Number(link[0].weight), 1)

    const terms = db.prepare('SELECT term, origin, weight FROM entry WHERE atom_id = ?').all(r.atomId)
    assert.ok(terms.some((t) => t.term === 'WAL' && t.origin === 'declared' && Number(t.weight) === 1))
    assert.ok(terms.some((t) => t.origin === 'extracted'))

    const search = db.prepare('SELECT body FROM atom_search WHERE id = ?').get(r.atomId)
    assert.ok(search.body.includes(atom.summary))
    // 触发器必须已经把它同步进 FTS，否则召回静默失效。
    const fts = db.prepare('SELECT COUNT(*) AS n FROM atom_fts WHERE atom_fts MATCH ?').get('WAL')
    assert.ok(Number(fts.n) >= 1)
  })

  it('两字中文入口能通过 entry_fts 命中（trigram 在此失效）', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    await writeAtom(ctx, { text: '系统代理配置写入环境变量后需要重启终端才能生效。' })
    const hit = db.prepare('SELECT COUNT(*) AS n FROM entry_fts WHERE entry_fts MATCH ?').get('代理')
    assert.ok(Number(hit.n) >= 1, 'entry_fts 是两字中文查询的唯一词面通路')
  })

  it('topic 的 sum_vec / n_atoms 随并入增量更新', async () => {
    const A = oneHot(7)
    // 两条都是「缓存击穿」：余弦为 1、词面重叠约 0.086——两票都过，必然并入。
    const ctx = createWriteCtx(db, {}, { encode: keywordEncoder([['缓存击穿', A]]) })
    const a = await writeAtom(ctx, { text: '缓存击穿：热点 key 失效瞬间大量请求打到数据库。' })
    const b = await writeAtom(ctx, { text: '缓存击穿与缓存雪崩的处理方式不同，不要混用。' })
    assert.equal(b.topicId, a.topicId)

    const t = db.prepare('SELECT sum_vec, n_atoms, mean_fit FROM topic WHERE id = ?').get(a.topicId)
    assert.equal(Number(t.n_atoms), 2)
    const sum = decodeVec(t.sum_vec)
    // 两个同向单位向量之和的模应为 2；归一后即得到单位 centroid。
    assert.ok(Math.abs(l2norm(sum) - 2) < 1e-5, `增量 sum 应等于成员向量之和，实际模 ${l2norm(sum)}`)
    assert.ok(Number(t.mean_fit) > 0 && Number(t.mean_fit) <= 1)
  })

  it('topic_hint 命中时跳过几何定位；未命中时回退并报告 hintMiss', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const a = await writeAtom(ctx, { text: '基准测试要在同一台机器上跑两次取中位数。' })

    const direct = await writeAtom(ctx, { text: '另一条完全不相干的记忆。', topicHint: a.topicId })
    assert.equal(direct.action, 'joined')
    assert.equal(direct.topicId, a.topicId)

    const miss = await writeAtom(ctx, { text: '第三条记忆，hint 指向不存在的主题。', topicHint: 999999 })
    assert.equal(miss.hintMiss, 999999)
    assert.equal(miss.action, 'created', 'hint 非法时不能阻塞写入')
  })

  it('写入失败时事务整体回滚，不留半个 atom', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    db.exec('DROP TRIGGER trg_search_ai')
    db.exec(
      "CREATE TRIGGER trg_search_ai AFTER INSERT ON atom_search BEGIN SELECT RAISE(ABORT, '故意失败'); END",
    )
    await assert.rejects(() => writeAtom(ctx, { text: '这条写入必须整体失败，不能留下 atom。' }))
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n), 0)
    assert.equal(topicCount(), 0, 'topic 也必须一起回滚')
  })

  it('空 text 直接报错，不静默写入空 atom', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    await assert.rejects(() => writeAtom(ctx, { text: '   ' }), /text 不能为空/)
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n), 0)
  })
})

describe('落位判据（decidePlacement 边界表）', () => {
  const T = { tauJoin: 0.78, tauLex: 0.05, tauNew: 0.5, tauLexOnly: 0.1 }
  /** 构造候选：第一个中心与 q 的余弦恰为 c1，第二个为 c2。 */
  function cands(c1, c2) {
    const q = oneHot(0)
    const mkV = (target) => {
      const v = new Float32Array(VEC_DIM)
      v[0] = target
      v[1] = Math.sqrt(Math.max(0, 1 - target * target))
      return v
    }
    const out = [{ id: 11, centroid: mkV(c1), n: 2 }]
    if (c2 !== null) out.push({ id: 22, centroid: mkV(c2), n: 2 })
    return { q, out }
  }
  const lexOf = (v) => () => v

  it('两票都过 → 并入最近 topic', () => {
    const { q, out } = cands(0.8, 0.4)
    const r = decidePlacement(q, out, lexOf(0.09), T)
    assert.equal(r.decision.kind, 'join')
    assert.equal(r.decision.topicId, 11)
    assert.equal(r.evidence.lexicalOnly, false)
  })

  it('余弦过线但词面不过 → 不并入', () => {
    const { q, out } = cands(0.8, 0.4)
    const r = decidePlacement(q, out, lexOf(0.01), T)
    assert.equal(r.decision.kind, 'create')
  })

  it('余弦低于 τ_new → far 且不指向任何 topic', () => {
    const { q, out } = cands(0.45, 0.1)
    const r = decidePlacement(q, out, lexOf(0.5), T)
    assert.equal(r.decision.kind, 'create')
    assert.equal(r.decision.reason, 'far')
    assert.equal(r.decision.nearId, null)
  })

  it('双峰（前两名几乎并列）→ ambiguous 并指向最近者', () => {
    const { q, out } = cands(0.7, 0.68)
    const r = decidePlacement(q, out, lexOf(0), T)
    assert.equal(r.decision.reason, 'ambiguous')
    assert.equal(r.decision.nearId, 11)
  })

  it('只有一个 topic 时不存在双峰 → 按 near 边新建', () => {
    const { q, out } = cands(0.6, null)
    const r = decidePlacement(q, out, lexOf(0), T)
    assert.equal(r.decision.kind, 'create')
    assert.equal(r.decision.reason, 'far')
    assert.equal(r.decision.nearId, 11)
  })

  it('无候选时直接 far，不产生 near 边', () => {
    const r = decidePlacement(oneHot(0), [], lexOf(0), T)
    assert.equal(r.decision.nearId, null)
    assert.equal(r.evidence.sim1, null)
  })

  it('无向量时只走词面，阈值用 tauLexOnly', () => {
    const { out } = cands(0.99, 0.99)
    const joined = decidePlacement(null, out, lexOf(0.12), T)
    assert.equal(joined.evidence.lexicalOnly, true)
    assert.equal(joined.decision.kind, 'join')
    const rejected = decidePlacement(null, out, lexOf(0.09), T)
    assert.equal(rejected.decision.kind, 'create')
  })

  it('中心向量维度不一致时该候选的余弦按 null 处理，不参与排序', () => {
    const short = { id: 33, centroid: new Float32Array(8), n: 1 }
    short.centroid[0] = 1
    const { q, out } = cands(0.8, 0.4)
    const r = decidePlacement(q, [...out, short], lexOf(0.09), T)
    assert.equal(r.decision.kind, 'join')
    assert.equal(r.decision.topicId, 11, '维度不符的候选不得抢到主属')
  })
})
describe('写入管线：入口生成', () => {
  it('抽取入口：真词入选，跨词边界碎片出局', () => {
    const recs = extractedEntries('系统代理配置与缓存索引的说明。', buildVocabIndex(db))
    const terms = recs.map((r) => r.term)
    assert.ok(terms.includes('代理'), '真词应当入选')
    assert.ok(terms.includes('缓存'), '真词应当入选')
    assert.ok(recs.every((r) => r.weight > 0 && r.weight <= 0.6))
  })

  it('边界自由度为零的碎片出局，观测不足的候选不被硬判', () => {
    // v4 的候选资格判据：左右邻汉字都只观测到一种取值 -> 出局。这里手工喂词表，
    // 因为要构造的正是「观测到恒定」那一档，写库反而要造很多条正文。
    const mk = (t, extra = {}) => ({
      df: 1,
      tf: 1,
      leftVaried: true,
      rightVaried: true,
      leftSeen: 5,
      rightSeen: 5,
      ...extra,
    })
    const stats = new Map([
      // 「值阈」永远是左「位」右「值」——两侧都恒定，且有足够观测 -> 判为碎片
      ['值阈', mk('值阈', { leftVaried: false, rightVaried: false })],
      // 「代理」在一侧恒定，另一侧多样 -> 不硬判（留在候选池里由降权处理）
      ['代理', mk('代理', { rightVaried: false })],
      // 只有一两次观测的候选：恒定还可能是抽样偶然 -> 不硬判
      ['新建', mk('新建', { leftVaried: false, rightVaried: false, leftSeen: 1, rightSeen: 2 })],
    ])
    const vocab = { df: (t) => (t === '值阈' ? 5 : 0), total: () => 100, stat: (t) => stats.get(t) }
    const terms = extractedEntries('值阈代理新建的说明。', vocab, 16).map((r) => r.term)
    assert.ok(!terms.includes('值阈'), '两侧都恒定且有观测的候选必须出局')
    assert.ok(terms.includes('代理'), '只有一侧恒定的候选不该被硬判')
    assert.ok(terms.includes('新建'), '观测不足时不下「恒定」这个结论')
  })

  it('整段中文（原文切片）不作为入口', () => {
    // 切词把「连续汉字」整段当一个词，于是正文里的任意片段都会成为候选。
    // 它们不会被任何查询命中，却占着每 atom 只有十几个的槽位。
    const recs = extractedEntries('这是一个用于测试的结论，因为所以但是因此。', buildVocabIndex(db))
    const terms = recs.map((r) => r.term)
    assert.ok(!terms.includes('因为所以但是因此'), '超过四字的整段中文是原文切片')
    assert.ok(!terms.includes('这是一个用于测试的结论'))
    assert.ok(!terms.includes('用于测试的'), '超过四字的片段出局（靠长度上限，v4 起不再依赖虚字表）')
  })

  it('declared 入口权重恒为 1.0，且同名入口不被 extracted 覆盖', () => {
    const recs = buildEntries('系统代理配置与缓存索引的说明。', { declared: ['索引'] }, buildVocabIndex(db))
    const byTerm = new Map(recs.map((r) => [r.term, r]))
    assert.equal(byTerm.get('索引').origin, 'declared')
    assert.equal(byTerm.get('索引').weight, 1)
  })

  it('泛词（df/N > 0.5）被动态丢弃 —— 但语料够规模才生效', async () => {
    const text = '坐标变换的补充说明。'
    // 过滤阈值是 MIN_VOCAB_FOR_DF(12)：小库上「出现一次」就等于半数，判据不成立。
    // 这里直接构造词表来验判据本身，不走写库（写 16 条才有规模）。
    const sparse = { df: (t) => (t === '坐标' ? 5 : 0), total: () => 5 }
    assert.ok(
      extractedEntries(text, sparse).some((r) => r.term === '坐标'),
      '语料不足时不得把词误判成泛词 —— 否则新库会写成一座空索引',
    )

    const dense = { df: (t) => (t === '坐标' ? 40 : 0), total: () => 40 }
    assert.ok(!extractedEntries(text, dense).some((r) => r.term === '坐标'), '语料够大时泛词必须被丢弃')

    it('非字母非汉字的词元不作入口（实测：数字与符号片段会挤占展示窗口）', () => {
      // 实测依据：入口段里混进过 u4e00 / 0x1c / 9_ / v1 / 0335。它们在大库里「绝无仅有」，
      // IDF 反而给最高分，会挤掉每个主题只展示 8 条的窗口。
      const recs = extractedEntries('采用 u4e00 与 0x1c 编码，版本 v1 的 9_ 字段，数据量 0335 条。')
      const terms = recs.map((r) => r.term)
      for (const bad of ['u4e00', '0x1c', 'v1', '9_', '0335']) {
        assert.ok(!terms.includes(bad), bad + ' 不该成为入口')
      }
    })

    it('纯字母的专有词与缩写必须保留（过滤不得误伤）', () => {
      const recs = extractedEntries('pnpm 装完依赖是空的，git 提交没生效，peer 依赖要绕过。')
      const terms = recs.map((r) => r.term)
      for (const good of ['pnpm', 'git', 'peer']) assert.ok(terms.includes(good), good + ' 必须保留')
    })
  })

  it('invalidateVocab 后重建索引能看见新写入的入口', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    await writeAtom(ctx, { text: '第一次写入带动词表缓存建立。' })
    const before = buildVocabIndex(db).total()
    await writeAtom(ctx, { text: '第二次写入后词表应扩大。' })
    invalidateVocab(ctx)
    assert.ok(buildVocabIndex(db).total() > before)
  })
})

describe('写入管线：批量导入', () => {
  it('连续写入 40 条不同文本不报错，且每条都可定位到 topic', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const topics = ['构建', '代理', '索引', '模型', '事务']
    for (let i = 0; i < 40; i++) {
      const kw = topics[i % topics.length]
      await writeAtom(ctx, {
        text: `第 ${i} 条${kw}记录：这是关于${kw}主题的一段可读描述，用于验证批量导入。`,
      })
    }
    const rows = atomRows()
    assert.equal(rows.length, 40)
    assert.ok(
      rows.every((r) => r.topic_id !== null),
      '不允许出现无主属的 atom',
    )
    assert.ok(topicCount() >= 1 && topicCount() <= 40)
  })
})

// 声明边：模型在写入时显式声明记忆之间的关系边。
//
// 每条用例对应验证判据里的一条（编号写在用例名里）。判据 1/3/6/7 走**真实工具入口**
// （apply + 独立临时目录），因为它们验的是「模型看见了什么」；2/4/5 走 pipeline 层
// （直接读库与召回元数据），因为它们验的是落库与重算的性质。
//
// 隔离纪律：每个用例自己建库目录（test/isolation.test.mjs 守着「不许回落到用户真实库」），
// 钩子只写在自己的辅助函数里 —— 顶层 before/after 是全局的，会与其他文件串。

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { apply } from '../dist/index.js'
import { openVault } from '../dist/db/open.js'
import { resetEncoder } from '../dist/encoder/index.js'
import { edgeOriginCounts, inferEdges } from '../dist/graph/infer.js'
import { recall } from '../dist/pipeline/search.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { assembleView } from '../dist/pipeline/view.js'
import { closeRuntime, getRuntime } from '../dist/state.js'
import { DECLARED_EDGE_HINT, DECLARED_EDGE_ONLY_NOTE } from '../dist/tools/index.js'
import { VEC_DIM } from '../dist/util/vec.js'
import { openRuler } from './ro-ruler.mjs'

const DUP = { dupCos: 0.92, dupLex: 0.72 }

/** 每个用例一份独立目录：库文件与日志都落在里面，结束时整个删掉。 */
function tmpDir(tag) {
  return mkdtempSync(join(tmpdir(), 'dsh-lattice-declared-' + tag + '-'))
}

/** 起一套真实工具 + 独立数据目录；无论成败都关运行时并删目录。 */
async function withTools(tag, fn, overrides = {}) {
  resetEncoder()
  closeRuntime()
  const dir = tmpDir(tag)
  const cfg = {
    enabled: true,
    dataDir: dir,
    encoderEnabled: false,
    encoderModel: 'Xenova/bge-small-zh-v1.5',
    encoderMirror: '',
    encoderCacheDir: '',
    tauJoin: 0.78,
    tauLex: 0.05,
    tauLexOnly: 0.1,
    tauNew: 0.5,
    topN: 24,
    mmapSize: 0,
    cacheSize: 0,
    busyTimeout: 0,
    ...overrides,
  }
  const ctx = {
    registered: [],
    get: (k) => (k === 'tools' ? { register: (t) => ctx.registered.push(t) } : undefined),
    effect: (fn2) => fn2(),
    inject: () => {},
  }
  apply(ctx, cfg)
  const tool = (name) => {
    const t = ctx.registered.find((x) => x.name === name)
    if (t === undefined) throw new Error('工具未注册: ' + name)
    return t
  }
  try {
    await fn({ dir, cfg, tool })
  } finally {
    closeRuntime()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 只在这条用例自己的库上开连接；用完即关、删目录。 */
async function withDb(tag, fn) {
  const dir = tmpDir(tag)
  const file = join(dir, 'lattice.db')
  const { db } = openVault(file)
  try {
    await fn(db, dir)
  } finally {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 从写入回执里取 atom id（回执第一处 #N 就是它）。 */
function atomIdOf(receipt) {
  const m = /已写入记忆 #(\d+)/.exec(receipt)
  assert.ok(m !== null, '回执里没有 atom id：' + receipt)
  return Number(m[1])
}

/** 声明边的行快照：按 (kind, dst, origin) 排序，便于整表比对。 */
function declaredRows(db, srcId) {
  return db
    .prepare(
      'SELECT kind, dst_id, origin, confidence FROM edge' +
        " WHERE src_type = 'atom' AND dst_type = 'atom' AND src_id = ?" +
        ' ORDER BY kind, dst_id',
    )
    .all(srcId)
    .map((r) => [String(r.kind), Number(r.dst_id), String(r.origin), Number(r.confidence)])
}

/** 边表按 origin 的分布（判据 2 的「重建前后」证据）。 */
function originDistribution(db) {
  return db
    .prepare('SELECT origin, COUNT(*) AS n FROM edge GROUP BY origin ORDER BY origin')
    .all()
    .map((r) => [String(r.origin), Number(r.n)])
}

describe('判据 1：写入声明两条边，展开能看到', () => {
  it('两条 edges 落库为 origin = declared，lattice_expand 逐条列出', async () => {
    await withTools('c1', async ({ cfg, tool }) => {
      const w = tool('lattice_write')
      const a = atomIdOf(await w.execute({ text: '系统代理必须走本地端口，否则访问境外源会超时。' }))
      const b = atomIdOf(await w.execute({ text: '缓存击穿是热点 key 同时失效导致的。' }))
      const receipt = await w.execute({
        text: '依赖解析失败时先看解析策略，再看锁文件。',
        edges: [
          { type: 'related', target: a },
          { type: 'requires', target: b },
        ],
      })
      const c = atomIdOf(receipt)
      assert.ok(receipt.includes('关系 2 条（声明）'), '回执应当报出落库条数：' + receipt)

      const db = getRuntime(cfg).db
      assert.deepEqual(declaredRows(db, c), [
        ['related', a, 'declared', 1],
        ['requires', b, 'declared', 1],
      ])

      const expanded = await tool('lattice_expand').execute({ atom_id: c })
      assert.ok(expanded.includes('关系（声明）2 条'), '展开应当列出声明边：' + expanded)
      assert.ok(expanded.includes('related → #' + a), '展开缺 related 那条：' + expanded)
      assert.ok(expanded.includes('requires → #' + b), '展开缺 requires 那条：' + expanded)
      // 这两类边不是「只记录关系」：related / requires 不改变任何状态，别给它们加那句说明。
      assert.equal(receipt.includes(DECLARED_EDGE_ONLY_NOTE), false, receipt)
    })
  })
})

describe('关系边：edges 不收 supersedes（2026-10-21 起）', () => {
  it('声明 supersedes 的边被拒且回执说明改用顶层参数；duplicate 仍只记录关系', async () => {
    await withTools('c1b', async ({ cfg, tool }) => {
      const w = tool('lattice_write')
      const oldId = atomIdOf(await w.execute({ text: '旧说法：缓存击穿是热点 key 同时失效导致的。' }))
      const receipt = await w.execute({
        text: '新说法：缓存击穿发生在单个热点 key 失效的瞬间。',
        edges: [
          { type: 'supersedes', target: oldId },
          { type: 'duplicate', target: oldId },
        ],
      })
      const fresh = atomIdOf(receipt)
      // 被拒的边必须回显原因：不说的话，调用方会以为取代关系已经建立。
      assert.ok(receipt.includes('取代请用写入参数 supersedes'), receipt)
      assert.ok(receipt.includes('supersedes → #' + oldId), receipt)
      const db = getRuntime(cfg).db
      const supersededBy = (id) =>
        db.prepare('SELECT superseded_by FROM atom WHERE id = ?').get(id).superseded_by
      assert.equal(supersededBy(oldId), null, '被拒的边更不该写 superseded_by')
      assert.equal(supersededBy(fresh), null)
      // 只有 duplicate 落了库：supersedes 一行都不该有。
      assert.deepEqual(declaredRows(db, fresh), [['duplicate', oldId, 'declared', 1]])

      const expanded = await tool('lattice_expand').execute({ atom_id: fresh })
      assert.ok(!expanded.includes('supersedes → #' + oldId), '被拒的边不该出现在展开里：' + expanded)
      const noted = expanded.split('\n').filter((l) => l.includes(DECLARED_EDGE_ONLY_NOTE))
      assert.equal(noted.length, 1, '只剩 duplicate 一条带「只记录关系」：' + expanded)
      assert.ok(expanded.includes('duplicate → #' + oldId + ' '), expanded)
    })
  })
})

describe('判据 2：重算不覆盖声明边', () => {
  it('全量边重建前后，边表行数与 origin 分布不变', async () => {
    await withDb('c2', async (db) => {
      // 有真实向量，推断才会有东西可建、可删 —— 否则「重建」是个空操作，证明不了什么。
      const hot = (i) => {
        const v = new Float32Array(VEC_DIM)
        v[i] = 1
        return v
      }
      const encode = async (text) => (text.includes('甲') ? hot(1) : text.includes('乙') ? hot(1) : hot(5))
      const ctx = createWriteCtx(db, {}, { encode })
      const a = await writeAtom(ctx, { text: '甲条记忆的正文，讲的是同一件事。' })
      const b = await writeAtom(ctx, { text: '乙条记忆的正文，讲的是同一件事。' })
      const first = inferEdges(db, DUP)
      assert.ok(first.stats.nearEdges > 0, '两条近邻应当建出 near 边：' + JSON.stringify(first.stats))

      const c = await writeAtom(ctx, {
        text: '丙条记忆的正文，换一个话题。',
        edges: [
          { type: 'related', target: a.atomId },
          { type: 'refines', target: b.atomId },
        ],
      })
      assert.equal(c.edgesDeclared, 2)
      const before = originDistribution(db)
      const beforeTotal = before.reduce((s, [, n]) => s + n, 0)

      const second = inferEdges(db, DUP)
      assert.ok(second.stats.removedEdges > 0, '这一次重建应当删掉上一次写的那批 inferred 边')

      const after = originDistribution(db)
      const afterTotal = after.reduce((s, [, n]) => s + n, 0)
      assert.deepEqual(after, before, '重建改变了边的 origin 分布' + JSON.stringify({ before, after }))
      assert.equal(afterTotal, beforeTotal)
      assert.equal(edgeOriginCounts(db).declared, 2, '两条声明边必须原样还在')
      assert.deepEqual(declaredRows(db, c.atomId), [
        ['refines', b.atomId, 'declared', 1],
        ['related', a.atomId, 'declared', 1],
      ])
    })
  })

  it('声明边的 kind 与推断撞名时，重建也不把它改写成 inferred', async () => {
    await withDb('c2b', async (db) => {
      const hot = (i) => {
        const v = new Float32Array(VEC_DIM)
        v[i] = 1
        return v
      }
      // 两条向量完全相同：推断一定会产出 near 边，于是「声明 kind=near」与它撞同一个唯一键。
      const ctx = createWriteCtx(db, {}, { encode: async () => hot(1) })
      const a = await writeAtom(ctx, { text: '甲条记忆的正文，讲的是同一件事。' })
      const c = await writeAtom(ctx, {
        text: '乙条记忆的正文，另起的说法。',
        edges: [{ type: 'near', target: a.atomId }],
      })
      assert.equal(c.edgesDeclared, 1)
      const built = inferEdges(db, DUP)
      assert.ok(built.stats.nearEdges > 0, '推断应当产出 near 边：' + JSON.stringify(built.stats))
      const rows = db
        .prepare("SELECT origin FROM edge WHERE src_id = ? AND dst_id = ? AND kind = 'near'")
        .all(c.atomId, a.atomId)
      assert.equal(rows.length, 1)
      assert.equal(String(rows[0].origin), 'declared', '声明边被重建改写成推断了')
    })
  })
})

describe('判据 3：非法输入不落库且拒因可见', () => {
  it('target 不存在 / 自指 / type 超长 / 字符集不符：边一条都不落库，拒因逐条回执', async () => {
    await withTools('c3', async ({ cfg, tool }) => {
      const w = tool('lattice_write')
      const a = atomIdOf(await w.execute({ text: '系统代理必须走本地端口，否则访问境外源会超时。' }))
      const db = getRuntime(cfg).db
      // 自指只能在事务内判（事务外不知道新 atom 拿哪个 id），所以这里用「下一个 id」构造。
      const nextId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM atom').get().n)
      const receipt = await w.execute({
        text: '依赖解析失败时先看解析策略，再看锁文件。',
        edges: [
          { type: 'related', target: 987654 },
          { type: 'related', target: nextId },
          { type: 'a'.repeat(40), target: a },
          { type: 'Not lower', target: a },
        ],
      })
      const c = atomIdOf(receipt)
      assert.ok(receipt.includes('关系未建立'), '拒因必须回到回执：' + receipt)
      assert.ok(receipt.includes('#987654') && receipt.includes('不存在'), receipt)
      assert.ok(receipt.includes('不能指向自己'), receipt)
      assert.ok(receipt.includes('超过 32 个字符'), receipt)
      assert.ok(receipt.includes('小写字母'), receipt)

      // 一行都没有落库：声明边的条数按 src 数，而不是「有没有边表行」。
      assert.deepEqual(declaredRows(db, c), [])
      // 记忆本身照写：边是线索，不该拖住本体。
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM atom WHERE id = ?').get(c).n), 1)
    })
  })

  it('edges 不是数组时也给拒因，不静默丢弃（直接调写入管线，工具层由宿主先挡）', async () => {
    await withDb('c3b', async (db) => {
      const ctx = createWriteCtx(db)
      const r = await writeAtom(ctx, { text: '依赖解析失败时先看解析策略，再看锁文件。', edges: 'related' })
      assert.equal(r.atomId > 0, true, '记忆照写')
      assert.equal(r.edgesRejected?.length, 1)
      assert.ok(r.edgesRejected[0].reason.includes('数组'), JSON.stringify(r.edgesRejected))
    })
  })
})

describe('判据 4：graphStatus 分开报数，且只有声明边的库图路不为 0', () => {
  function unitAt(i) {
    const v = new Float32Array(VEC_DIM)
    v[i] = 1
    return v
  }
  function blobOf(v) {
    const b = new Uint8Array(v.length * 4)
    new Float32Array(b.buffer, b.byteOffset, v.length).set(v)
    return b
  }
  function seed(db, text, vec, summary) {
    const now = Date.now()
    db.prepare(
      'INSERT OR IGNORE INTO topic(id, domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at)' +
        ' VALUES (1, NULL, ?, zeroblob(2048), 1, 0.8, ?, ?)',
    ).run('T1', now, now)
    const r = db
      .prepare(
        'INSERT INTO atom(kind, text, summary, embedding, topic_id, fit, scope, source, source_ref,' +
          " polarity, flags, created_at, updated_at) VALUES ('结论', ?, ?, ?, 1, 0.8, 'global', NULL, NULL, NULL, 0, ?, ?)",
      )
      .run(text, summary, blobOf(vec), now, now)
    const id = Number(r.lastInsertRowid)
    db.prepare("INSERT INTO atom_topic(atom_id, topic_id, weight, origin) VALUES (?, 1, 1.0, 'primary')").run(
      id,
    )
    return id
  }

  it('库里一条 inferred 边都没有，图路仍然经声明边拿到候选', async () => {
    await withDb('c4', async (db) => {
      const a = seed(db, '依赖解析要开 hoisted 才不重复装包', unitAt(0), '依赖解析要开 hoisted 才不重复装包')
      // 第二条用**维度不符**的向量：模拟别的模型写下的老 atom —— 它既进不了向量路，
      // 也进不了近邻推断，于是它与 a 之间只可能有「声明」这一条边。
      const b = seed(
        db,
        '装包链接失败时先看解析策略',
        new Float32Array(8).fill(1),
        '装包链接失败时先看解析策略',
      )
      db.prepare(
        'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at)' +
          " VALUES ('atom', ?, 'atom', ?, 'related', 1.0, 'declared', ?)",
      ).run(a, b, Date.now())

      const q = '依赖解析要开 hoisted 才不重复装包'
      const res = recall(db, q, unitAt(0), { topN: 2 })
      assert.ok(res.meta.counts.graph > 0, '图路必须不为 0：' + JSON.stringify(res.meta.counts))
      assert.ok(res.meta.graphStatus.includes('声明边 1 条'), res.meta.graphStatus)
      assert.ok(res.meta.graphStatus.includes('推断边 0 条'), res.meta.graphStatus)
      assert.deepEqual(edgeOriginCounts(db), { declared: 1, inferred: 0 }, '库里应当只有声明边')

      // 声明边的作用是「把邻居带进候选」，不再单独渲染一段：
      // 放宽 topN 后 b 应当进候选并装进【入选】，注入文本里不再有【路】段。
      assert.ok(
        res.hits.map((h) => h.id).includes(b),
        '声明边的邻居应当进候选：' + JSON.stringify(res.hits.map((h) => h.id)),
      )
      const view = assembleView(db, res, {})
      assert.ok(!view.text.includes('【路】'), '路段已经取消：' + view.text)
      assert.ok(view.text.includes('装包链接失败时先看解析策略'), '进了候选的邻居装进【入选】')
    })
  })
})

describe('判据 5：声明边不被自动提权（名次不变）', () => {
  it('加声明边前后，同一批查询的名次与得分逐条相同', async () => {
    await withDb('c5', async (db) => {
      const hot = (i) => {
        const v = new Float32Array(VEC_DIM)
        v[i] = 1
        return v
      }
      const vectors = { 代理: hot(1), WAL: hot(2), 缓存: hot(3), 索引: hot(4) }
      const encode = async (text) => {
        for (const [kw, v] of Object.entries(vectors)) if (text.includes(kw)) return v
        return hot(5)
      }
      const ctx = createWriteCtx(db, {}, { encode })
      const as = []
      as.push(await writeAtom(ctx, { text: '系统代理必须走本地端口，否则访问境外源会超时。' }))
      as.push(await writeAtom(ctx, { text: 'SQLite 的 WAL 模式允许一写多读，只有一个写者。' }))
      as.push(await writeAtom(ctx, { text: '缓存击穿是热点 key 同时失效导致的。' }))
      as.push(await writeAtom(ctx, { text: 'B 树索引在等值查询上比全表扫快得多。' }))
      as.push(await writeAtom(ctx, { text: '把索引建在低基数列上几乎没有收益。' }))

      const queries = [
        ['系统代理', hot(1)],
        ['WAL 模式', hot(2)],
        ['缓存击穿', hot(3)],
        ['索引', hot(4)],
      ]
      const before = queries.map(([q, v]) => recall(db, q, v, { topN: 24 }))

      // 声明边把「本来就在结果里」与「本来不在结果里」的两对都连上：
      // 前者才是最容易被误伤成「提权」的情形。
      const now = Date.now()
      const ins = db.prepare(
        'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at)' +
          " VALUES ('atom', ?, 'atom', ?, ?, 1.0, 'declared', ?)",
      )
      ins.run(as[0].atomId, as[1].atomId, 'related', now)
      ins.run(as[0].atomId, as[2].atomId, 'requires', now)
      ins.run(as[3].atomId, as[4].atomId, 'related', now)

      const after = queries.map(([q, v]) => recall(db, q, v, { topN: 24 }))

      for (let i = 0; i < queries.length; i++) {
        const b = before[i].hits
        const a = after[i].hits
        const beforeIds = b.map((h) => h.id)
        const beforeSet = new Set(beforeIds)
        const kept = a.filter((h) => beforeSet.has(h.id)).map((h) => h.id)
        assert.deepEqual(kept, beforeIds, '第 ' + (i + 1) + ' 条查询的名次变了')
        const afterById = new Map(a.map((h) => [h.id, h]))
        for (const h of b) {
          const now2 = afterById.get(h.id)
          assert.equal(now2.score, h.score, '得分变了：声明边的 confidence 漏进了打分')
          assert.equal(now2.final, h.final)
        }
      }
    })
  })
})

describe('判据 6：一次写入只产生一个库文件', () => {
  it('声明边只落主库 edge（origin = declared），数据目录里没有第二个库', async () => {
    // 原判据是「edges 不写样本库」。样本库退役后它变成了更强的形式：
    // 插件只允许有一个库文件 —— 多出一个 .db 就说明有旁路又在偷偷落盘，
    // 而这正是当年 samples/ 造成的形状（一个不参与召回、只在后台累积的库）。
    await withTools('c6', async ({ cfg, dir, tool }) => {
      const w = tool('lattice_write')
      await tool('lattice_ping').execute({})
      const a = atomIdOf(await w.execute({ text: '系统代理必须走本地端口，否则访问境外源会超时。' }))
      await tool('lattice_recall').execute({ query: '系统代理' })
      const receipt = await w.execute({
        text: '依赖解析失败时先看解析策略，再看锁文件。',
        edges: [{ type: 'related', target: a }],
      })
      const c = atomIdOf(receipt)
      assert.deepEqual(declaredRows(getRuntime(cfg).db, c), [['related', a, 'declared', 1]])
      const dbFiles = readdirSync(dir)
        .filter((f) => f.endsWith('.db'))
        .sort()
      assert.deepEqual(dbFiles, ['lattice.db'], '数据目录里只应有主库，实有：' + dbFiles.join(', '))
    })
  })
})

describe('判据 7：可发现性（工具描述 + 召回末尾提示）', () => {
  it('lattice_write 的 edges 参数描述含 4 个推荐 type，并写明取代不走 edges', async () => {
    await withTools('c7a', async ({ tool }) => {
      const spec = tool('lattice_write').parameters.properties.edges
      assert.ok(spec !== undefined, 'edges 参数必须存在')
      for (const t of ['related', 'refines', 'duplicate', 'requires']) {
        assert.ok(spec.description.includes(t), 'edges 描述缺推荐值 ' + t + '：' + spec.description)
      }
      // supersedes 已移出推荐值，但描述里要提到它 —— 否则读的人会照着旧习惯再试一次。
      assert.ok(spec.description.includes('supersedes'), '要说明取代不走这里：' + spec.description)
      assert.ok(spec.description.includes('会被拒'), spec.description)
      // 参数边界也要写出来：target 从哪取、条数上限、非法边的后果。
      assert.ok(spec.description.includes('target'), spec.description)
      assert.ok(spec.description.includes('跳过'), spec.description)
    })
  })

  it('有命中时末尾出现提示句，且提示不写表、不引入额外写入', async () => {
    await withTools('c7b', async ({ dir, tool }) => {
      const w = tool('lattice_write')
      await w.execute({ text: '系统代理必须走本地端口，否则访问境外源会超时。' })
      // 先跑一次让图路建边（首次召回会建），第二次才是「提示本身有没有副作用」的对照。
      await tool('lattice_recall').execute({ query: '系统代理' })
      // 观测走另一个只读连接：同连接读 PRAGMA data_version 看不到本连接自己的写，
      // 那样写成的断言恒真。只读连接必须在被测操作之前打开、前后用同一个。
      const ruler = openRuler(join(dir, 'lattice.db'))
      try {
        const before = ruler.read()
        const out = await tool('lattice_recall').execute({ query: '系统代理' })
        const after = ruler.read()

        assert.ok(out.includes('【入选】'), '应当有命中：' + out)
        assert.ok(out.trimEnd().endsWith('（' + DECLARED_EDGE_HINT + '）'), '末尾应当有提示句：' + out)
        assert.equal(out.split(DECLARED_EDGE_HINT).length - 1, 1, '提示句只出现一次')
        // 召回工具本身会记命中计数（recordRecall）：那是「召回」的既有语义，不是提示带来的写入。
        // 所以这里断言的是「除这一次计数之外，提示不产生任何写入」：
        // 表行数与库结构版本不变；data_version 只涨 1（命中计数那一次提交）；
        // recall_hits 总和只涨 1（本例库里只有一条 atom，两次召回各命中它一次）。
        assert.equal(after.userVersion, before.userVersion, '提示不得改库结构')
        assert.deepEqual(after.rows, before.rows, '提示不得写任何表')
        assert.equal(after.dataVersion, before.dataVersion + 1, '除召回自己的命中计数外不得有别的提交')
        assert.equal(after.recallHits, before.recallHits + 1, '除召回自己的命中计数外不得改数据')
      } finally {
        ruler.close()
      }
    })
  })

  /**
   * 判据「提示不写库」的**排除法**形态。
   *
   * 原先的观测对象是「整次工具调用」，而那次调用里有两条**与提示无关**的写入：
   * 命中计数（recordRecall）与入口反哺（feedLearned）。用整次调用当观测对象，
   * 就只能靠一个「+1」的例外把它俩糊过去 —— 而例外一多，判据就不再能构造失败。
   *
   * 对照法（两份库各召回一次）试过，**不可构造**：声明边会把「只有这条边可达」的
   * 节点带进命中集合（实测：加一条 requires 边后 graph 路从 0 变 1，hits 多出一条），
   * 两份库的命中集合本来就不同，它们的写入量因此本来就该不同。
   *
   * 剩下的做法就是把那两个已知写入**排除在观测之外**：只跑「召回 → 渲染 → 末尾拼提示」
   * 这一段（工具层那行 return 表达式的全部内容），它必须零写入。
   * 用只读连接跑：这条路径一旦尝试写库会当场抛错，而不是悄悄改一个数。
   */
  it('判据 7：排除命中计数与入口反哺之后，渲染与拼提示零写入', async () => {
    await withTools('c7c', async ({ dir, tool }) => {
      await tool('lattice_write').execute({ text: '系统代理必须走本地端口，否则访问境外源会超时。' })
      await tool('lattice_write').execute({ text: '系统代理的白名单里放了内网段。' })
      // 先跑一次：首次召回会建推断边，那是一次真正的写库，不属于「渲染与提示」。
      await tool('lattice_recall').execute({ query: '系统代理' })

      const ruler = openRuler(join(dir, 'lattice.db'))
      const ro = new DatabaseSync(join(dir, 'lattice.db'), { readOnly: true })
      try {
        const before = ruler.read()
        const recalled = recall(ro, '系统代理', null, {})
        const view = assembleView(ro, recalled, { scene: '系统代理', budget: 6000 })
        const text = view.text + '\n\n（' + DECLARED_EDGE_HINT + '）'
        const after = ruler.read()
        assert.ok(text.includes(DECLARED_EDGE_HINT), '提示应当在返回文本里：' + text.slice(-60))
        assert.equal(after.dataVersion, before.dataVersion, '渲染与拼提示不得产生任何提交')
        assert.deepEqual(after.rows, before.rows, '渲染与拼提示不得写任何表')
        assert.equal(after.userVersion, before.userVersion, '也不得改库结构')
      } finally {
        ro.close()
        ruler.close()
      }
    })
  })

  it('判据 7：提示与渲染不改排序 —— 工具层返回的锚序就是命中序的前缀', async () => {
    await withTools('c7d', async ({ dir, tool }) => {
      for (const t of [
        '系统代理必须走本地端口。',
        '系统代理的白名单里放了内网段。',
        '系统代理的端口号与 HTTP_PROXY 必须一致。',
      ]) {
        await tool('lattice_write').execute({ text: t })
      }
      const out = await tool('lattice_recall').execute({ query: '系统代理' })
      const shown = [...out.matchAll(/^- \[(\d+)/gm)].map((m) => Number(m[1]))
      assert.ok(shown.length > 1, '本例应当命中多条：' + out)

      const ro = new DatabaseSync(join(dir, 'lattice.db'), { readOnly: true })
      try {
        const recalled = recall(ro, '系统代理', null, {})
        const view = assembleView(ro, recalled, { scene: '系统代理', budget: 6000 })
        assert.deepEqual(shown, view.anchorIds, '工具层不得重排锚段')
        assert.deepEqual(
          view.anchorIds,
          recalled.hits.slice(0, view.anchorIds.length).map((h) => h.id),
          '锚序必须是命中序的前缀 —— 提示与渲染不许改变顺序',
        )
      } finally {
        ro.close()
      }
    })
  })
})

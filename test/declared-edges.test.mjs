// 声明边（T38）：模型在写入时显式声明记忆之间的关系边。
//
// 每条用例对应验证判据里的一条（编号写在用例名里）。判据 1/3/6/7 走**真实工具入口**
// （apply + 独立临时目录），因为它们验的是「模型看见了什么」；2/4/5 走 pipeline 层
// （直接读库与召回元数据），因为它们验的是落库与重算的性质。
//
// 隔离纪律：每个用例自己建库目录（test/isolation.test.mjs 守着「不许回落到用户真实库」），
// 钩子只写在自己的辅助函数里 —— 顶层 before/after 是全局的，会与其他文件串。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
import { SAMPLE_DB_NAME, SAMPLES_DIR_NAME } from '../dist/samples/store.js'
import { closeRuntime, getRuntime } from '../dist/state.js'
import { DECLARED_EDGE_HINT } from '../dist/tools/index.js'
import { VEC_DIM } from '../dist/util/vec.js'

const DUP = { dupCos: 0.92, dupLex: 0.72 }

/** 每个用例一份独立目录：库文件、样本库、日志都落在里面，结束时整个删掉。 */
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
    viewBudget: 6000,
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

/** 读样本库的行数：库文件可能还没建（从没写过样本），那也算 0 行。 */
function sampleRows(dir) {
  const file = join(dir, SAMPLES_DIR_NAME, SAMPLE_DB_NAME)
  if (!existsSync(file)) return 0
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    if (!db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'recall_sample'").get().n) return 0
    return Number(db.prepare('SELECT COUNT(*) AS n FROM recall_sample').get().n)
  } finally {
    db.close()
  }
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
        'INSERT INTO atom(kind, text, summary, embedding, topic_id, fit, scope, project_key, source, source_ref,' +
          " polarity, flags, created_at, updated_at) VALUES ('结论', ?, ?, ?, 1, 0.8, 'global', NULL, NULL, NULL, NULL, 0, ?, ?)",
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
      const res = recall(db, q, unitAt(0), { topN: 1 })
      assert.ok(res.meta.counts.graph > 0, '图路必须不为 0：' + JSON.stringify(res.meta.counts))
      assert.ok(res.meta.graphStatus.includes('声明边 1 条'), res.meta.graphStatus)
      assert.ok(res.meta.graphStatus.includes('推断边 0 条'), res.meta.graphStatus)
      assert.deepEqual(edgeOriginCounts(db), { declared: 1, inferred: 0 }, '库里应当只有声明边')

      // 图路段真的有内容：b 的摘要出现在【路】段里，并带「声明」标记（与 near 分开）。
      const view = assembleView(db, res, {})
      assert.ok(view.text.includes('【路】'), '应当有路段：' + view.text)
      assert.ok(view.text.includes('装包链接失败时先看解析策略'), '路段里应当有声明边的邻居：' + view.text)
      assert.ok(view.text.includes('声明'), '路段应当标出这条边是声明的：' + view.text)
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

describe('判据 6：edges 不写样本库', () => {
  it('声明边只落主库 edge（origin = declared），样本库行数不变', async () => {
    // samplesEnabled=false 只关「自动收集」，不关样本库本身 —— 用它让 feedback 的写入
    // 成为这一组里唯一的样本来源，行数才是确定的。
    await withTools(
      'c6',
      async ({ cfg, dir, tool }) => {
        const w = tool('lattice_write')
        await tool('lattice_ping').execute({})
        const a = atomIdOf(await w.execute({ text: '系统代理必须走本地端口，否则访问境外源会超时。' }))
        await tool('lattice_recall').execute({ query: '系统代理' })
        const fb = await tool('lattice_feedback').execute({ kind: 'positive', ref: 1 })
        assert.ok(fb.includes('已记下反馈'), '样本库要先有一条真实样本：' + fb)
        assert.equal(sampleRows(dir), 1)

        const before = sampleRows(dir)
        const receipt = await w.execute({
          text: '依赖解析失败时先看解析策略，再看锁文件。',
          edges: [{ type: 'related', target: a }],
        })
        const c = atomIdOf(receipt)
        assert.equal(sampleRows(dir), before, '声明边不得写样本库')
        assert.deepEqual(declaredRows(getRuntime(cfg).db, c), [['related', a, 'declared', 1]])
      },
      { samplesEnabled: false },
    )
  })
})

describe('判据 7：可发现性（工具描述 + 召回末尾提示）', () => {
  it('lattice_write 的 edges 参数描述含 5 个推荐 type', async () => {
    await withTools('c7a', async ({ tool }) => {
      const spec = tool('lattice_write').parameters.properties.edges
      assert.ok(spec !== undefined, 'edges 参数必须存在')
      for (const t of ['related', 'refines', 'supersedes', 'duplicate', 'requires']) {
        assert.ok(spec.description.includes(t), 'edges 描述缺推荐值 ' + t + '：' + spec.description)
      }
      // 参数边界也要写出来：target 从哪取、条数上限、非法边的后果。
      assert.ok(spec.description.includes('target'), spec.description)
      assert.ok(spec.description.includes('跳过'), spec.description)
    })
  })

  it('有命中时末尾出现提示句，且提示不改排序、不写库', async () => {
    await withTools('c7b', async ({ cfg, tool }) => {
      const w = tool('lattice_write')
      await w.execute({ text: '系统代理必须走本地端口，否则访问境外源会超时。' })
      const db = getRuntime(cfg).db
      const snapshot = () => ({
        atoms: Number(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n),
        edges: Number(db.prepare('SELECT COUNT(*) AS n FROM edge').get().n),
        version: Number(db.prepare('PRAGMA data_version').get().data_version),
      })
      // 先跑一次让图路建边（首次召回会建），第二次才是「提示本身有没有副作用」的对照。
      await tool('lattice_recall').execute({ query: '系统代理' })
      const before = snapshot()
      const out = await tool('lattice_recall').execute({ query: '系统代理' })
      const after = snapshot()

      assert.ok(out.includes('【锚】'), '应当有命中：' + out)
      assert.ok(out.trimEnd().endsWith('（' + DECLARED_EDGE_HINT + '）'), '末尾应当有提示句：' + out)
      assert.equal(out.split(DECLARED_EDGE_HINT).length - 1, 1, '提示句只出现一次')
      assert.deepEqual(after, before, '提示不得写库（atom / edge 行数与 data_version 都不变）')
    })
  })
})

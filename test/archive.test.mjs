// 归档（T26）：默认不召回、仍可显式检索。
//
// 这里验的是「可见性开关」这一件事的两面：
//   1. 默认路径（召回四路、注入三段、目录默认结果）看不到归档条目；
//   2. 归档**没有动数据**：内容、向量、入口、atom_topic、superseded_by 都还在，
//      恢复后同一条查询得到的注入文本与归档前逐字符相同。
//
// 与删除（forget.ts）的用例刻意不共用：删除是物理删除 + 墓碑 + 防写回，
// 归档没有任何一项；把两者的断言混在一起，会让「归档没删东西」这条证据变弱。
//
// 每个用例在自己的临时库目录里跑（仓库有 test/isolation.test.mjs 守着这条）。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { apply } from '../dist/index.js'
import { closeRuntime } from '../dist/state.js'
import { openVault } from '../dist/db/open.js'
import { VEC_DIM } from '../dist/util/vec.js'
import { FLAG_AMBIGUOUS, FLAG_ARCHIVED, createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { setArchived } from '../dist/pipeline/archive.js'
import { DUP_COS, DUP_LEX, recall } from '../dist/pipeline/search.js'
import { assembleView } from '../dist/pipeline/view.js'
import { listAtoms, listAtomsByIds } from '../dist/pipeline/list.js'
import { audit } from '../dist/pipeline/audit.js'
import { inferEdges } from '../dist/graph/infer.js'

/** 单热向量。 */
function oneHot(i) {
  const v = new Float32Array(VEC_DIM)
  v[i % VEC_DIM] = 1
  return v
}

let dir = ''
let db = null

describe('归档：默认不可见、显式可检索（T26）', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-archive-'))
    db = openVault(join(dir, 'lattice.db')).db
  })

  afterEach(() => {
    // 工具层用例会经 apply 打开运行时连接；无论它怎么结束，这里都复位一次。
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

  function counts(tables) {
    const out = {}
    for (const t of tables) out[t] = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n)
    return out
  }

  it('判据 1/3：归档后锚里没有它、列表默认也没有；恢复后注入文本逐字符相同', async () => {
    const V = oneHot(3)
    const ids = await seed([
      ['系统代理必须走本地端口，否则访问境外源会直接超时。', V],
      ['棱镜色散实验的读数记录在实验本第三页。', oneHot(4)],
    ])

    const before = recall(db, '代理', V, {})
    assert.ok(
      before.hits.some((h) => h.id === ids[0]),
      '归档前应当命中代理那条',
    )
    const viewBefore = assembleView(db, before, {}).text
    assert.ok(viewBefore.includes('系统代理必须走本地端口'), '锚段应当带正文')
    // 入口路在归档前的基线：不先证明它能命中，下面那句「归档后为空」就是空断言。
    assert.deepEqual(
      recall(db, '代理', null, {}).hits.map((h) => h.id),
      [ids[0]],
      '前提：两字查询靠入口路命中',
    )

    const archived = setArchived(db, { atomId: ids[0], archived: true })
    assert.equal(archived.changed, true)
    assert.equal(archived.flags & FLAG_ARCHIVED, FLAG_ARCHIVED)

    const after = recall(db, '代理', V, {})
    assert.ok(!after.hits.some((h) => h.id === ids[0]), '默认召回不得包含归档条目')
    const viewAfter = assembleView(db, after, {}).text
    assert.ok(!viewAfter.includes('系统代理必须走本地端口'), '锚段不得出现归档正文')
    assert.ok(!viewAfter.includes('代理'), '入口段不得出现归档条目的入口词')

    // 入口路单独验一次：两字查询只有入口路有货（正文路的 trigram 对两字词必然落空）。
    const lexical = recall(db, '代理', null, {})
    assert.equal(lexical.hits.length, 0, '入口路也必须过滤归档条目')

    const listed = listAtoms(db, { limit: 50 })
    assert.ok(!listed.rows.some((r) => r.id === ids[0]), '列表默认结果不含归档条目')

    // 向量路：查询词与正文毫无重叠，只有向量能到；归档的那条仍必须被跳过。
    const vecOnly = recall(db, '毫无重叠的查询词', V, {})
    assert.ok(!vecOnly.hits.some((h) => h.id === ids[0]), '向量路也必须过滤归档条目')

    const restored = setArchived(db, { atomId: ids[0], archived: false })
    assert.equal(restored.flags & FLAG_ARCHIVED, 0)
    const again = recall(db, '代理', V, {})
    assert.deepEqual(
      again.hits.map((h) => h.id),
      before.hits.map((h) => h.id),
      '恢复后命中集合回到原样',
    )
    assert.equal(
      assembleView(db, again, {}).text,
      viewBefore,
      '恢复后注入文本必须逐字符相同 —— 归档是开关，不是重算',
    )
  })

  it('判据 1/2：归档条目的入口词不再出现在【入口】、摘要不再出现在【路】，但行都在库里', async () => {
    const V0 = oneHot(10)
    // 0.8 × 方向 10 + 0.6 × 方向 11 已经是单位向量，与 V0 的余弦恰好 0.8（≥ tauJoin 0.78）→
    // 与第一条同主题，但查询向量（V0）与它的相似度够低，不会把它拉进命中。
    const mix = new Float32Array(VEC_DIM)
    mix[10] = 0.8
    mix[11] = 0.6
    const ids = await seed([
      ['系统代理必须走本地端口，否则访问境外源会直接超时。', V0],
      ['本地端口被防火墙挡住时，境外源会直接超时。', mix],
      ['棱镜色散实验的读数记录在实验本第三页。', oneHot(12)],
    ])
    const topicOf = (id) => Number(db.prepare('SELECT topic_id FROM atom WHERE id = ?').get(id).topic_id)
    assert.equal(topicOf(ids[0]), topicOf(ids[1]), '前提：两条必须同主题，否则【入口】这一路测不到')

    // 给第二条补一个「只在它身上」的入口词，并把两条连起来：这两样都不能靠写入管线的默认行为保证。
    const now = Date.now()
    db.prepare(
      'INSERT INTO entry(atom_id, term, bigram, weight, origin, hits, last_seen, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, 0, NULL, ?)',
    ).run(ids[1], '归档专用入口词', '归档 档专 专用 用入 入口 口词', 9.9, 'declared', now)
    db.prepare(
      'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at)' +
        " VALUES ('atom', ?, 'atom', ?, 'near', 0.9, 'inferred', ?)",
    ).run(ids[0], ids[1], now)
    // superseded_by 非空：证明归档不会顺手清掉这一列。
    db.prepare('UPDATE atom SET superseded_by = ? WHERE id = ?').run(ids[0], ids[1])

    const before = {
      counts: counts(['atom', 'entry', 'atom_topic', 'edge']),
      vec: db.prepare('SELECT hex(embedding) AS h FROM atom WHERE id = ?').get(ids[1]).h,
      superseded: db.prepare('SELECT superseded_by AS s FROM atom WHERE id = ?').get(ids[1]).s,
    }

    // 纯词面查询：只命中第一条（第二条没有「代理」）。没有查询向量，图路就不参与 ——
    // 这样【路】段里的第二条只能来自边，不能来自向量粗筛。
    const r0 = recall(db, '代理', null, {})
    assert.deepEqual(
      r0.hits.map((h) => h.id),
      [ids[0]],
      '前提：第二条不该被这一问命中',
    )
    const view0 = assembleView(db, r0, {}).text
    assert.ok(view0.includes('归档专用入口词'), '前提：【入口】里应当有这个入口词')
    assert.ok(view0.includes('本地端口被防火墙挡住时'), '前提：【路】里应当有邻居摘要')

    setArchived(db, { atomId: ids[1], archived: true })

    const r1 = recall(db, '代理', null, {})
    assert.deepEqual(
      r1.hits.map((h) => h.id),
      [ids[0]],
      '另一条未归档的命中不受影响',
    )
    const view1 = assembleView(db, r1, {}).text
    assert.ok(!view1.includes('归档专用入口词'), '【入口】不得出现归档条目的入口词')
    assert.ok(!view1.includes('本地端口被防火墙挡住时'), '【路】不得出现归档条目的摘要')

    // 判据 2：内容与关系一行没少，向量一个字节没变。
    const after = {
      counts: counts(['atom', 'entry', 'atom_topic', 'edge']),
      vec: db.prepare('SELECT hex(embedding) AS h FROM atom WHERE id = ?').get(ids[1]).h,
      superseded: db.prepare('SELECT superseded_by AS s FROM atom WHERE id = ?').get(ids[1]).s,
    }
    assert.deepEqual(after, before, '归档只改 flags：行数、向量、superseded_by 都不许变')
    const flags = Number(db.prepare('SELECT flags FROM atom WHERE id = ?').get(ids[1]).flags)
    assert.equal(flags & FLAG_ARCHIVED, FLAG_ARCHIVED)
  })

  it('判据 1（正文路 / 图路）：靠正文索引与边才能到的两条路，同样过滤归档', async () => {
    // 正文路：先删掉这条的入口行，让查询只能从 atom_fts 命中 —— 否则测到的是入口路。
    const bodyIds = await seed([['SQLite 的 WAL 模式允许一写多读，读操作不会阻塞写入。', oneHot(60)]])
    db.prepare('DELETE FROM entry WHERE atom_id = ?').run(bodyIds[0])
    assert.deepEqual(
      recall(db, 'SQLite', null, {}).hits.map((h) => h.id),
      [bodyIds[0]],
      '前提：正文路能命中',
    )
    setArchived(db, { atomId: bodyIds[0], archived: true })
    assert.equal(recall(db, 'SQLite', null, {}).hits.length, 0, '正文路也必须过滤归档条目')

    // 图路：邻居故意用「向量长度不对」的一条 —— 它进不了向量路，只能经边到达。
    const V = oneHot(61)
    const seedIds = await seed([['缓存击穿：热点 key 失效瞬间大量请求打到数据库。', V]])
    const now = Date.now()
    const neighborId = Number(
      db
        .prepare(
          'INSERT INTO atom (kind, text, summary, embedding, created_at, updated_at, flags)' +
            ' VALUES (?, ?, ?, ?, ?, ?, 0)',
        )
        .run(
          '知识',
          '棱镜色散实验的读数记录在实验本第三页。',
          '被归档的邻居摘要',
          new Uint8Array(4),
          now,
          now,
        ).lastInsertRowid,
    )
    db.prepare(
      'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at)' +
        " VALUES ('atom', ?, 'atom', ?, 'near', 0.9, 'inferred', ?)",
    ).run(seedIds[0], neighborId, now)
    const before = recall(db, '缓存击穿', V, {})
    assert.ok(
      before.hits.some((h) => h.id === neighborId),
      '前提：图路能把邻居捞起来',
    )
    setArchived(db, { atomId: neighborId, archived: true })
    assert.ok(!recall(db, '缓存击穿', V, {}).hits.some((h) => h.id === neighborId), '图路也必须过滤归档条目')
  })
  it('判据 4：显式检索仍然看得到 —— flags:16 与 includeArchived 各走一次', async () => {
    const ids = await seed([['缓存击穿：热点 key 失效瞬间大量请求打到数据库。', oneHot(20)]])
    // 同时带上「歧义」位：显式检索不该互相遮蔽。
    db.prepare('UPDATE atom SET flags = ? WHERE id = ?').run(FLAG_ARCHIVED | FLAG_AMBIGUOUS, ids[0])

    assert.equal(listAtoms(db, { limit: 50 }).total, 0, '默认列表看不到归档条目')
    assert.equal(listAtoms(db, { includeArchived: true, limit: 50 }).total, 1)
    const byFlag = listAtoms(db, { flags: FLAG_ARCHIVED, limit: 50 })
    assert.deepEqual(
      byFlag.rows.map((r) => r.id),
      [ids[0]],
      'flags:16 是显式检索出口',
    )
    assert.equal(byFlag.rows[0].flags & FLAG_ARCHIVED, FLAG_ARCHIVED)
    assert.equal(
      listAtoms(db, { flags: FLAG_AMBIGUOUS, limit: 50 }).total,
      1,
      '按别的位检索时同样能看到「既歧义又归档」的行 —— 两个条件不该互相遮蔽',
    )

    // 召回补行用的入口不受归档过滤影响：显式检索到归档条目时仍要能补齐字段。
    const rows = listAtomsByIds(db, [ids[0]])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].flags & FLAG_ARCHIVED, FLAG_ARCHIVED)
  })

  it('判据 4（工具层）：lattice_list 给 flags:16 才列归档，不给就看不到', async () => {
    const ids = await seed([['港口潮汐表每个月重新校核一次。', oneHot(70)]])
    setArchived(db, { atomId: ids[0], archived: true })
    // 换到 apply 注册出来的工具上再跑一遍：证明参数确实传到了目录查询，
    // 而不只是 listAtoms 本身的语义。
    db.close()
    const registered = []
    apply(
      {
        registered,
        get: (k) => (k === 'tools' ? { register: (t) => registered.push(t) } : undefined),
        effect: (fn) => fn(),
        inject: () => {},
      },
      {
        enabled: true,
        dataDir: dir,
        encoderEnabled: true,
        tauJoin: 0.78,
        tauLex: 0.05,
        tauNew: 0.5,
        viewBudget: 6000,
        topN: 24,
      },
    )
    try {
      const list = registered.find((t) => t.name === 'lattice_list')
      assert.ok(list, '工具应当已注册')
      const plain = await list.execute({})
      assert.ok(!plain.includes('港口潮汐表'), '不给 flags 时默认看不到归档条目')
      const explicit = await list.execute({ flags: 16 })
      assert.ok(explicit.includes('港口潮汐表'), 'flags:16 应当列出归档条目')
      assert.ok(explicit.includes('已归档'), '行标记要说明它已归档')
    } finally {
      closeRuntime()
    }
  })
  it('判据 6：重复归档 / 重复恢复幂等，且不动别的位', async () => {
    const ids = await seed([['港口潮汐表每个月重新校核一次。', oneHot(30)]])
    db.prepare('UPDATE atom SET flags = ? WHERE id = ?').run(FLAG_AMBIGUOUS, ids[0])

    const a1 = setArchived(db, { atomId: ids[0], archived: true })
    assert.equal(a1.changed, true)
    assert.equal(a1.flags, FLAG_AMBIGUOUS | FLAG_ARCHIVED)
    const a2 = setArchived(db, { atomId: ids[0], archived: true })
    assert.equal(a2.changed, false, '重复归档不报错，只报「没变」')
    assert.equal(a2.flags, FLAG_AMBIGUOUS | FLAG_ARCHIVED, '重复归档不许清掉别的位')

    const r1 = setArchived(db, { atomId: ids[0], archived: false })
    assert.equal(r1.changed, true)
    assert.equal(r1.flags, FLAG_AMBIGUOUS)
    const r2 = setArchived(db, { atomId: ids[0], archived: false })
    assert.equal(r2.changed, false)
    assert.equal(r2.flags, FLAG_AMBIGUOUS)

    assert.equal(setArchived(db, { atomId: 999999, archived: true }), null, '不存在的 id 返回 null')
  })

  it('判据 7：归档不影响建边 —— 全量重建之后归档 atom 仍然有边', async () => {
    const V = oneHot(40)
    const ids = await seed([
      ['甲：同一方向的记忆第一条。', V],
      ['乙：同一方向的记忆第二条。', V],
      ['丙：同一方向的记忆第三条。', V],
    ])
    setArchived(db, { atomId: ids[1], archived: true })

    const outcome = inferEdges(db, { dupCos: DUP_COS, dupLex: DUP_LEX })
    assert.equal(outcome.status, 'built')
    const edges = Number(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM edge WHERE origin = 'inferred'" +
            " AND ((src_type = 'atom' AND src_id = ?) OR (dst_type = 'atom' AND dst_id = ?))",
        )
        .get(ids[1], ids[1]).n,
    )
    assert.ok(edges > 0, '归档的 atom 仍要参与建边，否则恢复后会变成孤点')
  })

  it('判据 8：体检按整库计数，归档数单独报一项', async () => {
    const ids = await seed([
      ['系统代理必须走本地端口，否则访问境外源会直接超时。', oneHot(50)],
      ['棱镜色散实验的读数记录在实验本第三页。', oneHot(51)],
    ])
    setArchived(db, { atomId: ids[1], archived: true })
    const report = audit(db)
    assert.equal(report.topics.atoms, 2, 'atom 总数含归档条目')
    assert.equal(report.topics.archived, 1, '归档数单独报，不混进总数')
    assert.equal(report.recall.atoms, report.topics.atoms, '从未被召回的分母与总数同口径')
  })
})

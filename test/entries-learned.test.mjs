// learned 反哺（设计说明）：入口的第三级由召回写入，以及它的四条防抖。
//
// 这里验的是**行为**而不是结构：反哺进去的词下一次召回能不能用上、冷却会不会重复记账、
// 配额淘汰的是不是最弱的那条、遗忘会不会把陈证据清掉。另外守住一条最容易被本次改动破坏的
// 性质 —— recall() 仍然是只读的：反哺在工具层，不在召回路径里。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { recall } from '../dist/pipeline/search.js'
import { ENTRY_WEIGHT, LEARNED_MAX_PER_ATOM, clearLearned, feedLearned } from '../dist/pipeline/entries.js'

const DAY = 86_400_000
/** 固定的「现在」：反哺的所有判据都与时间有关，用真时钟会让用例不可复现。 */
const NOW = 1_770_000_000_000

let dbFile = ''
let db = null

describe('entries-learned', () => {
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-learned-' +
        process.pid +
        '-' +
        Date.now() +
        '-' +
        Math.random().toString(36).slice(2) +
        '.db',
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

  /** 三条互不相干的记忆。多数用例只需要「有库、有 atom id」。 */
  async function seed(extra = []) {
    const texts = [
      'pnpm 的 nodeLinker 必须设为 hoisted，否则创建符号链接会失败。',
      'SQLite 的 WAL 模式允许一写多读，读操作不会阻塞写入。',
      '系统代理必须走本地端口，否则访问境外源会直接超时。',
      ...extra,
    ]
    const ctx = createWriteCtx(db, {}, {})
    const ids = []
    for (const text of texts) ids.push((await writeAtom(ctx, { text, kind: '结论' })).atomId)
    return ids
  }

  function learnedRows() {
    return db
      .prepare(
        "SELECT id, atom_id, term, origin, hits, last_seen, weight FROM entry WHERE origin = 'learned' ORDER BY id",
      )
      .all()
  }

  /** 直接插一条 learned 行：用来构造「已经学了 12 条」「陈证据」这类起点。 */
  function putLearned(atomId, term, hits, lastSeen) {
    db.prepare(
      'INSERT INTO entry(atom_id, term, bigram, weight, origin, hits, last_seen, created_at)' +
        " VALUES (?, ?, ?, ?, 'learned', ?, ?, ?)",
    ).run(atomId, term, 'x', ENTRY_WEIGHT.learned, hits, lastSeen, lastSeen)
  }

  /** 特征词里有 atom#1 还没有的入口词（pnpm 之外的 依赖 / 报错），所以能看到新建。 */
  const Q_NEW = 'pnpm 装依赖报错'
  /** 特征词（创建 / 号链 / 失败）全都已经是 atom#1 的入口 —— 用来验「不制造重复行」。 */
  const Q_COVERED = '符号链接创建失败怎么办'

  describe('learned 反哺：命中写进入口表', () => {
    it('一次召回之后，命中的 atom 上出现 origin=learned 的行，且能被再次召回', async () => {
      await seed()
      const r = recall(db, Q_NEW, null, { topN: 8 })
      assert.ok(r.hits.length > 0, '先要有命中，反哺才有对象')
      const fb = feedLearned(
        db,
        Q_NEW,
        r.hits.map((h) => h.id),
        NOW,
      )
      assert.ok(fb.created > 0, '反哺应当新建 learned 行')
      assert.equal(fb.evicted, 0)
      const rows = learnedRows()
      assert.equal(rows.length, fb.created)
      for (const row of rows) {
        assert.equal(row.origin, 'learned')
        assert.equal(Number(row.hits), 1)
        assert.equal(Number(row.last_seen), NOW)
        assert.equal(Number(row.weight), ENTRY_WEIGHT.learned, '新学的入口按第三级权重记账')
      }
      // 反哺的意义就在这里：那个词从此能把这条 atom 召回来。
      for (const row of rows) {
        const again = recall(db, String(row.term), null, { topN: 8 })
        assert.ok(
          again.hits.some((h) => h.id === Number(row.atom_id)),
          '反哺进去的入口词应当能召回它所属的 atom：' + row.term,
        )
      }
    })

    it('该 atom 已有同名入口时不再建重复行（FTS 的 df 不该被同义词抬高）', async () => {
      const ids = await seed(['大文件下载要走代理，但回环地址不能走代理。'])
      const atomId = ids[3]
      db.prepare(
        'INSERT INTO entry(atom_id, term, bigram, weight, origin, hits, last_seen, created_at)' +
          " VALUES (?, '代理', 'dai li', 1.0, 'declared', 0, NULL, ?)",
      ).run(atomId, NOW)
      const before = Number(
        db.prepare("SELECT COUNT(*) AS n FROM entry WHERE atom_id = ? AND term = '代理'").get(atomId).n,
      )
      const fb = feedLearned(db, '代理', [atomId], NOW)
      assert.ok(fb.covered >= 1, '已有同名入口的词应当记进 covered，而不是新建一行')
      assert.equal(fb.created, 0)
      const learned = db
        .prepare("SELECT COUNT(*) AS n FROM entry WHERE atom_id = ? AND term = '代理' AND origin = 'learned'")
        .get(atomId)
      assert.equal(Number(learned.n), 0, '同一 (atom, term) 上不该多出一条 learned 重复行')
      const after = Number(
        db.prepare("SELECT COUNT(*) AS n FROM entry WHERE atom_id = ? AND term = '代理'").get(atomId).n,
      )
      assert.equal(after, before, '反哺不该改变这个 (atom, term) 上的行数')
    })
  })

  describe('learned 反哺：防抖', () => {
    it('冷却：同一对 24 h 内只记一次，跨天之后再记', async () => {
      await seed()
      const r = recall(db, Q_NEW, null, { topN: 8 })
      const ids = r.hits.map((h) => h.id)
      const first = feedLearned(db, Q_NEW, ids, NOW)
      assert.ok(first.created > 0)

      const second = feedLearned(db, Q_NEW, ids, NOW + 3_600_000)
      assert.equal(second.created, 0, '冷却窗内不该再建行')
      assert.equal(second.cooled, first.created, '新学的那些行应当全部被冷却挡下')
      assert.equal(second.reinforced, 0)
      for (const row of learnedRows()) assert.equal(Number(row.hits), 1, '冷却期内计数不该变')

      const third = feedLearned(db, Q_NEW, ids, NOW + 25 * 3_600_000)
      assert.equal(third.reinforced, first.created, '跨过 24 h 之后才记账')
      for (const row of learnedRows()) assert.equal(Number(row.hits), 2)
    })

    it('单 atom 上限：learned 行超过 12 条时淘汰 count_eff 最低的', async () => {
      const ids = await seed()
      // 挑一条与 Q_COVERED 无关的 atom：它的入口里没有那三个特征词，反哺一定新建行。
      const atomId = ids[1]
      for (let i = 0; i < LEARNED_MAX_PER_ATOM; i += 1) {
        putLearned(atomId, '陈旧' + String.fromCharCode(0x4e00 + i), 1, NOW - 10 * DAY)
      }
      const fb = feedLearned(db, Q_COVERED, [atomId], NOW)
      assert.ok(fb.created >= 1)
      assert.ok(fb.evicted >= 1, '超出上限应当淘汰')
      const n = db
        .prepare("SELECT COUNT(*) AS n FROM entry WHERE atom_id = ? AND origin = 'learned'")
        .get(atomId)
      assert.ok(
        Number(n.n) <= LEARNED_MAX_PER_ATOM,
        '单 atom 的 learned 入口不得超过 ' + LEARNED_MAX_PER_ATOM,
      )
      // 淘汰的是最弱的（10 天前的 0.93），不是刚学到的（1.0）
      const fresh = db
        .prepare('SELECT COUNT(*) AS n FROM entry WHERE atom_id = ? AND last_seen = ?')
        .get(atomId, NOW)
      assert.ok(Number(fresh.n) >= 1, '刚反哺的行不该被淘汰')
    })

    it('全局上限：learned 总数不超过 5 × atom 数', async () => {
      const ids = await seed()
      // 3 条 atom ⇒ 全局线 = 15。铺 20 条（每条 atom 10 条，都不触发单 atom 的 12）,
      // 让全局线先响。
      for (let i = 0; i < 10; i += 1) {
        putLearned(ids[0], '陈旧甲' + String.fromCharCode(0x4e00 + i), 1, NOW - 30 * DAY)
        putLearned(ids[1], '陈旧乙' + String.fromCharCode(0x4e00 + i), 1, NOW - 30 * DAY)
      }
      const fb = feedLearned(db, Q_COVERED, [ids[1]], NOW)
      assert.ok(fb.created >= 1)
      assert.ok(fb.evicted >= 1)
      const n = db.prepare("SELECT COUNT(*) AS n FROM entry WHERE origin = 'learned'").get()
      assert.ok(Number(n.n) <= 5 * 3, '全局上限 = 5 × atom 数（这里有 3 条 atom）')
    })

    it('遗忘：静默到 count_eff 低于遗忘线的行被删掉，新鲜的不动', async () => {
      const ids = await seed()
      putLearned(ids[0], '陈旧词', 1, NOW - 200 * DAY)
      putLearned(ids[1], '新鲜词', 1, NOW)
      const fb = feedLearned(db, Q_COVERED, [ids[2]], NOW)
      assert.equal(fb.forgotten, 1, '静默 200 天（> 2 个半衰期）的 1 次命中应当被遗忘')
      const terms = learnedRows().map((r) => String(r.term))
      assert.ok(!terms.includes('陈旧词'))
      assert.ok(terms.includes('新鲜词'))
    })
  })

  describe('learned 反哺：升档只改分值，不改来源', () => {
    it('证据够了升到 extracted 档的分值，静默久了降回；origin 始终是 learned', async () => {
      const ids = await seed()
      putLearned(ids[0], '够线的词', 8, NOW - DAY)
      const fb = feedLearned(db, Q_COVERED, [ids[2]], NOW)
      assert.ok(fb.promoted >= 1)
      const row = db.prepare("SELECT origin, weight FROM entry WHERE term = '够线的词'").get()
      assert.equal(String(row.origin), 'learned', '升档不写改来源 —— 改了它就不是「可重算」的那一类了')
      assert.equal(Number(row.weight), ENTRY_WEIGHT.extracted)
      assert.ok(ENTRY_WEIGHT.extracted < ENTRY_WEIGHT.declared, 'learned 永远够不到 declared 的分值')

      const fb2 = feedLearned(db, Q_COVERED, [ids[2]], NOW + 200 * DAY)
      assert.ok(fb2.demoted >= 1)
      const row2 = db.prepare("SELECT origin, weight FROM entry WHERE term = '够线的词'").get()
      assert.equal(String(row2.origin), 'learned')
      assert.equal(Number(row2.weight), ENTRY_WEIGHT.learned, '超出 30 天窗口后降回第三级')
    })
  })

  describe('召回路径的只读性', () => {
    it('recall() 跑完之后 entry 与 atom 两表都没被改过，也没有 learned 行冒出来', async () => {
      await seed()
      const snap = () =>
        JSON.stringify({
          entry: db
            .prepare('SELECT id, atom_id, term, origin, weight, hits, last_seen FROM entry ORDER BY id')
            .all(),
          atom: db.prepare('SELECT id, recall_hits, last_recalled_at FROM atom ORDER BY id').all(),
        })
      const before = snap()
      for (const q of [Q_COVERED, '代理', '数据库并发读写', 'WAL']) recall(db, q, null, { topN: 8 })
      assert.equal(snap(), before, 'recall() 不该写库（反哺是它在工具层之后的一次独立调用）')
      assert.equal(learnedRows().length, 0)
    })
  })

  describe('重建入口时清空反哺', () => {
    it('clearLearned 只删 learned 行，并返回条数（N=0 返回 0）', async () => {
      await writeAtom(createWriteCtx(db, {}, {}), { text: '罗盘校准记录：磁偏角随时间缓慢变化。' })
      const atomId = Number(db.prepare('SELECT id FROM atom LIMIT 1').get().id)
      // learned 行只有召回事件会造出来，测试里直接插最省事。
      const ins = db.prepare(
        "INSERT INTO entry (atom_id, term, bigram, weight, origin, hits, created_at) VALUES (?, ?, '', ?, 'learned', 1, ?)",
      )
      ins.run(atomId, '磁偏角', 0.5, NOW)
      ins.run(atomId, '校準', 0.5, NOW)
      const learnedBefore = Number(
        db.prepare("SELECT COUNT(*) AS n FROM entry WHERE origin = 'learned'").get().n,
      )
      const othersBefore = Number(
        db.prepare("SELECT COUNT(*) AS n FROM entry WHERE origin <> 'learned'").get().n,
      )
      assert.equal(learnedBefore, 2)

      assert.equal(clearLearned(db), 2, '返回被清掉的条数 —— 调用方要靠它留痕')
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM entry WHERE origin = 'learned'").get().n), 0)
      assert.equal(
        Number(db.prepare("SELECT COUNT(*) AS n FROM entry WHERE origin <> 'learned'").get().n),
        othersBefore,
        '只清使用史，extracted / declared 不动',
      )

      // 再清一次必须是 0 而不是 undefined：判据「N=0 也要打印」依赖这个返回值可打印。
      assert.equal(clearLearned(db), 0)
    })
  })
})

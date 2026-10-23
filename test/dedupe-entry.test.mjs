// 写入侧派生行为的验证：去重范围、去重排序、入口行初值、写入侧去重排除已取代行、召回不改真相层，各一条。
//
// 每个用例都自建一份临时目录（库文件、样本、日志都在里面，结束时整份删掉），
// 不依赖别的用例留下的状态。两种取数方式：
//   · 工具层（入口行初值与召回段的用例）：照 test/tools.test.mjs 的写法，用 apply() 注册工具，
//     再按名字取出来用 execute() 调用 —— 只有这条路径会真的走 tools/index.ts 里
//     recordRecall 与 feedLearned 那两段；
//   · 函数层（去重、排序与排除已取代行的用例）：照 test/supersede.test.mjs 的写法，
//     openVault 拿连接、createWriteCtx 造上下文、直接调 writeAtom —— 这样能看见
//     findDuplicate / forgetAtom 这些函数的返回值本身，而不只是工具回执里的文案。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { apply } from '../dist/index.js'
import { closeRuntime, getRuntime } from '../dist/state.js'
import { openVault } from '../dist/db/open.js'
import { resetEncoder } from '../dist/encoder/index.js'
import { VEC_DIM, zeroVec } from '../dist/util/vec.js'
import { ForgottenError, createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { DEFAULT_REVIEW_THRESHOLDS, findDuplicate } from '../dist/pipeline/review.js'
import { DEFAULT_FORGET_THRESHOLDS, forgetAtom } from '../dist/pipeline/forget.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView } from '../dist/pipeline/view.js'

/**
 * 最小假 ctx：只实现插件用到的那一个服务。
 * inject 给个不执行回调的替身，等价于「本用例的宿主没有 webServer 服务」。
 */
function fakeCtx() {
  const registered = []
  return {
    registered,
    get: (k) => (k === 'tools' ? { register: (t) => registered.push(t) } : undefined),
    effect: (fn) => fn(),
    inject: () => {},
  }
}

/** 插件配置。字段与 test/tools.test.mjs 里的 cfg() 一致，只把编码器关掉。 */
function cfg(dataDir) {
  return {
    enabled: true,
    dataDir,
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
  }
}

/**
 * 开一份临时库、注册好工具，把 { dir, config, tool, db } 交给用例，结束时关连接删目录。
 * db() 取的是运行时单例连接（getRuntime），与工具层用的是同一条连接。
 */
async function withVault(tag, fn) {
  // 编码器状态是模块级单例：别的测试文件可能已把它置为 ready，不复位会静默沿用。
  resetEncoder()
  closeRuntime()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-dedupe-' + tag + '-'))
  const config = cfg(dir)
  const ctx = fakeCtx()
  apply(ctx, config)
  const tools = ctx.registered
  const tool = (name) => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error('工具未注册: ' + name)
    return t
  }
  try {
    return await fn({ dir, config, tool, db: () => getRuntime(config).db })
  } finally {
    closeRuntime()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  }
}

/** 从写入回执里取 atom id（回执形如「已写入记忆 #12 …」，见 test/unsupersede.test.mjs 的写法）。 */
function atomIdOf(receipt) {
  const m = /已写入记忆 #(\d+)/.exec(String(receipt))
  if (!m) throw new Error('回执里没有 atom id：' + receipt)
  return Number(m[1])
}

/** 往第 i 个基向量上放的向量，长度 VEC_DIM。 */
function basis(i, weight = 1) {
  const v = new Float32Array(VEC_DIM)
  v[i] = weight
  return v
}

describe('写入侧派生验证', () => {
  it('去重只比主属主题的前 200 条，第 201 条等于没比', async () => {
    // 去重只看主属主题前 200 条
    await withVault('51', async ({ db }) => {
      // encoderOn: false 时 writeAtom 不调用编码器，向量取零向量占位 —— 200 条夹具不必付编码开销。
      const ctx = createWriteCtx(db(), {}, { encoderOn: false })
      // 第一条建主题；之后每条都带 topicHint，直接并进同一个主题、跳过几何定位。
      const seed = await writeAtom(ctx, { text: 'seed anchor words' })
      const topicId = seed.topicId
      for (let k = 1; k <= 199; k++) {
        await writeAtom(ctx, { text: 'm' + k + ' only', topicHint: topicId })
      }
      const target = '唯一目标句子内容写在最后一条里'
      const copy = await writeAtom(ctx, { text: target, topicHint: topicId })

      const total = Number(db().prepare('SELECT COUNT(*) AS n FROM atom WHERE topic_id = ?').get(topicId).n)
      assert.equal(total, 201, '前置：主题里应当有 201 条（1 条种子 + 199 条无关成员 + 1 条逐字相同）')
      const window = Number(
        db()
          .prepare(
            'SELECT COUNT(*) AS n FROM (SELECT id FROM atom WHERE topic_id = ? ORDER BY id ASC LIMIT 200)',
          )
          .get(topicId).n,
      )
      assert.equal(window, 200, '前置：扫描窗口只装得下 200 条')

      const scan = findDuplicate(db(), target, null, topicId)
      assert.equal(scan.hit, null, '第 201 条落在扫描窗口外，去重看不见它')
      assert.equal(scan.scanned, 200, '实际进比对的只有 200 条')
      assert.equal(scan.truncated, true, '主题 201 条 > 窗口 200 条，必须标出「没扫完」')

      // 写入通路上同一个结论：这条逐字相同的记忆写进去时也没有重复提示。
      assert.equal(copy.review, undefined, '写入侧没有给出重复/高相似提示')

      // 反证：窗口放到 201 条就能看见它 —— 说明上面的 null 是「没扫到」，不是「比不中」。
      const widened = findDuplicate(db(), target, null, topicId, {
        ...DEFAULT_REVIEW_THRESHOLDS,
        scanLimit: 201,
      })
      assert.notEqual(widened.hit, null)
      assert.equal(widened.hit.atomId, copy.atomId, '第 201 条正是那条逐字相同的')
      assert.equal(widened.hit.code, 'near-duplicate')
      assert.equal(widened.hit.lex, 1)
    })
  })

  it('去重与防写回都按 (cos ?? 0) * 2 + lex 排第一', async () => {
    // 去重排序值 = (cos ?? 0) * 2 + lex
    await withVault('57', async ({ db }) => {
      // T 有 5 个词；候选一与它词面交集 2 个 → 2/(5+2-2) = 0.4；候选二 1 个 → 1/(5+6-1) = 0.1
      const T = 'alpha bravo charlie delta echo'
      const ONE = 'alpha bravo'
      const TWO = 'echo foxtrot golf hotel india juliet'
      const e0 = basis(0)
      const vOne = new Float32Array(VEC_DIM)
      vOne[0] = 0.5
      vOne[1] = Math.sqrt(0.75) // 与 e0 的余弦 0.5
      const vTwo = new Float32Array(VEC_DIM)
      vTwo[0] = 0.6
      vTwo[2] = 0.8 // 与 e0 的余弦 0.6
      // 待写入的文本 T 也给一个向量（就是 e0）：不给的话 writeAtom 拿不到向量，
      // 余弦变成 null，排序值退化成纯词面，要验的「余弦参与排序」就不成立了。
      const vecs = new Map([
        [ONE, vOne],
        [TWO, vTwo],
        [T, e0],
      ])
      const encode = async (text) => vecs.get(text) ?? zeroVec()

      // 两条的排序值分别是 0.5*2+0.4 = 1.4 与 0.6*2+0.1 = 1.3：余弦更高的那条反而排第二。
      // 这正是本条要验的：排序不是单看余弦。
      // nearCos 从默认 0.72 调到 0.4：默认值会把两条都判成「不像同一件事」，
      // 那样 classify 直接返回 null，排序根本轮不到执行 —— 测的就不是排序了。
      const review = { ...DEFAULT_REVIEW_THRESHOLDS, nearCos: 0.4 }
      const forget = { ...DEFAULT_FORGET_THRESHOLDS, nearCos: 0.4 }
      const ctx = createWriteCtx(db(), {}, { encode, review, forget })

      const seed = await writeAtom(ctx, { text: 'zzseed zzother' }) // 零向量 → 建主题
      const topicId = seed.topicId
      const one = await writeAtom(ctx, { text: ONE, topicHint: topicId })
      const two = await writeAtom(ctx, { text: TWO, topicHint: topicId })
      // 写候选二时它自己不该被打中（与候选一的余弦 0.3 < nearCos 0.4），否则前置不干净。
      assert.equal(two.review, undefined)

      // ① 去重侧：两条都够格，选排序值大的第一条
      const scan = findDuplicate(db(), T, e0, topicId, review)
      // 主题里有三条未被取代的：种子 + 候选一 + 候选二
      assert.equal(scan.scanned, 3)
      assert.notEqual(scan.hit, null)
      assert.equal(scan.hit.atomId, one.atomId, '排序值 1.4 > 1.3，应当选余弦较低但词面更高的第一条')
      assert.ok(Math.abs(scan.hit.cos - 0.5) < 1e-6, '选中的那条余弦是 0.5')
      assert.ok(Math.abs(scan.hit.lex - 0.4) < 1e-9, '选中的那条词面是 0.4')

      // 反证：把第一条标成已取代，第二条就当选 —— 证明两条都够格，上面是排序做出来的选择。
      db().prepare('UPDATE atom SET superseded_by = ? WHERE id = ?').run(two.atomId, one.atomId)
      const fallback = findDuplicate(db(), T, e0, topicId, review)
      assert.equal(fallback.hit.atomId, two.atomId)
      assert.ok(Math.abs(fallback.hit.cos - 0.6) < 1e-6)
      db().prepare('UPDATE atom SET superseded_by = NULL WHERE id = ?').run(one.atomId)

      // 走一遍写入通路：提示里点名的也是第一条
      const written = await writeAtom(ctx, { text: T, topicHint: topicId })
      assert.equal(written.review.length, 1)
      assert.equal(written.review[0].code, 'near-duplicate')
      assert.match(written.review[0].message, new RegExp('与本主题的 #' + one.atomId + ' 高度相似'))

      // ② 防写回侧：同样的两枚墓碑，同样选排序值大的第一条
      forgetAtom(db(), { atomId: one.atomId })
      forgetAtom(db(), { atomId: two.atomId })
      let thrown = null
      try {
        await writeAtom(ctx, { text: T })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown instanceof ForgottenError, '应当被防写回拦下')
      assert.equal(thrown.evidence.atomId, one.atomId, '墓碑里被点名的是排序值 1.4 的那条')
      assert.ok(Math.abs(thrown.evidence.cos - 0.5) < 1e-6)
      assert.ok(Math.abs(thrown.evidence.lex - 0.4) < 1e-9)
      assert.equal(thrown.evidence.how, 'near')
      assert.equal(thrown.scanned, 2, '两枚墓碑都进了比对')
    })
  })

  it('写入的 entry 行 hits=0/last_seen=NULL，召回反哺的行 hits=1/last_seen=当时', async () => {
    // entry 行的 hits/last_seen 两种来源不同
    await withVault('68', async ({ tool, db }) => {
      const w = tool('lattice_write')
      const A = '端口缓存配置改了三次才稳定'
      const a = atomIdOf(await w.execute({ text: A }))

      const afterWrite = db()
        .prepare('SELECT term, origin, hits, last_seen FROM entry WHERE atom_id = ?')
        .all(a)
      assert.ok(afterWrite.length > 0, '前置：写入必须落下 entry 行')
      for (const row of afterWrite) {
        assert.equal(row.origin, 'extracted')
        assert.equal(Number(row.hits), 0, '写入产生的行 hits 固定为 0')
        assert.equal(row.last_seen, null, '写入产生的行 last_seen 固定为 NULL')
      }

      // 查询词里要有 A 正文里没有的二字组：反哺遇到「该 atom 已有同名入口」时只跳过、不建行，
      // 只用 A 自己的词去召回，learned 行一条也建不出来。
      // 这条种子只负责把「一二」「二三」「三四」三个二字组放进语料，A 的正文里没有它们。
      // 正文不足 12 字时工具会以「没有独立检索价值」为由拒写，所以它必须写成完整的一句。
      atomIdOf(await w.execute({ text: '记一条测试用的口令：一二三四五六七八九十，仅用于提供查询词。' }))
      const learnedBefore = Number(
        db().prepare("SELECT COUNT(*) AS n FROM entry WHERE atom_id = ? AND origin = 'learned'").get(a).n,
      )
      assert.equal(learnedBefore, 0, '前置：召回之前不该有 learned 行')

      const receipt = await tool('lattice_recall').execute({ query: '一二三四端口缓存' })
      assert.match(String(receipt), new RegExp(A), '前置：这条召回必须命中 A')

      const learned = db()
        .prepare("SELECT term, hits, last_seen FROM entry WHERE atom_id = ? AND origin = 'learned'")
        .all(a)
      assert.ok(learned.length > 0, '召回应当给命中的 atom 建 learned 行')
      for (const row of learned) {
        assert.equal(Number(row.hits), 1, '反哺新建的行 hits 固定为 1')
        assert.notEqual(row.last_seen, null, '反哺新建的行 last_seen 是当时的时间')
        assert.ok(!A.includes(String(row.term)), '这条 term 来自查询词，不在 A 的正文里：' + row.term)
      }
    })
  })

  it('写入侧去重排除已取代行', async () => {
    // 补缺-1：写入侧去重排除已取代行
    await withVault('11', async ({ db }) => {
      const ctx = createWriteCtx(db(), {}, { encoderOn: false })
      const A = '端口用 8080，别改成别的，这是本机固定配置。'
      const B = '端口改用 9090，旧的 8080 作废，迁移时注意。'
      const a = await writeAtom(ctx, { text: A })
      const b = await writeAtom(ctx, { text: B, topicHint: a.topicId })
      // supersedes 是工具层的动作；这里按 test/supersede.test.mjs 的写法直接改这一列，
      // 这样测到的就是 findDuplicate 的 SQL 条件本身，不掺工具层的参数解析。
      const mark = (oldId, newId) =>
        db().prepare('UPDATE atom SET superseded_by = ? WHERE id = ?').run(newId, oldId)
      const unmark = (oldId) => db().prepare('UPDATE atom SET superseded_by = NULL WHERE id = ?').run(oldId)
      mark(a.atomId, b.atomId)

      // 反证：把标记清掉，与 A 逐字相同的文本立刻被判成高相似 —— 说明这份素材是能打中的。
      unmark(a.atomId)
      const naive = findDuplicate(db(), A, null, a.topicId)
      assert.equal(naive.hit.atomId, a.atomId)
      assert.equal(naive.hit.lex, 1)
      mark(a.atomId, b.atomId)

      // 正式断言：A 已被取代，比对里不再有它，逐字相同的 C 不该拿到指向 A 的提示。
      const c = await writeAtom(ctx, { text: A, topicHint: a.topicId })
      assert.equal(c.review, undefined, 'C 与已取代的 A 逐字相同，但不该报重复/高相似')
      assert.equal(c.reviewScan.scanned, 1, '只有未被取代的那 1 条（B）进了比对窗口')
      // truncated 为 true 是因为窗口判定用的总数把已取代的 A 也算进去了 —— 如实记下，不改断言。
      assert.equal(c.reviewScan.truncated, true)
      const alive = Number(
        db()
          .prepare('SELECT COUNT(*) AS n FROM atom WHERE topic_id = ? AND superseded_by IS NULL')
          .get(a.topicId).n,
      )
      assert.equal(alive, 2, '前置：此刻主题里只剩 B 与刚写进去的 C 未被取代')
    })
  })

  it('召回不改真相层，只读连接给出同样的文本', async () => {
    // 补缺-3：召回不改真相层
    await withVault('93', async ({ dir, config, tool, db }) => {
      // 写入夹具走函数层，为的是能给向量：推断边（origin='inferred'）只从非零向量算出来，
      // 编码器关掉的话库里全是零向量，一张推断边也不会有，② 就成了「0 与 0 相等」。
      const e0 = basis(0)
      const closeToE0 = new Float32Array(VEC_DIM)
      closeToE0[0] = 0.9
      closeToE0[1] = Math.sqrt(1 - 0.81) // 与 e0 的余弦 0.9，过得了建边的余弦下限 0.7
      const vecs = new Map([
        ['端口缓存配置改了三次才稳定。', e0],
        ['缓存击穿是热点 key 同时失效，不是端口问题。', closeToE0],
        ['重聚类把主题算两遍，第二遍只读不写。', basis(2)],
      ])
      const encode = async (text) => vecs.get(text) ?? zeroVec()
      const own = openVault(join(dir, 'lattice.db'))
      try {
        const writeCtx = createWriteCtx(own.db, {}, { encode })
        // 顺带写一条 declared 入口：它属第 1 层，读之后同样一个字段都不许变。
        for (const text of vecs.keys()) await writeAtom(writeCtx, { text, refs: ['端口缓存'] })
      } finally {
        own.db.close()
      }

      // 之后一律走工具层：召回段真的会经过 tools/index.ts 的 recordRecall 与 feedLearned。
      const r = tool('lattice_recall')
      const q = '缓存 端口'
      // 先召一次：召回会写第 3 层（recall_hits 与 learned 入口），那是允许的追加，
      // 不属于这里要证的七列。第一次与第二次召回都会写，所以先把它消耗掉，
      // 再取快照、看第二次召回前后有没有变。
      await r.execute({ query: q })
      // 记下计数器的值：第二次召回之后它会变大，那就是「召回真的跑过」的证据 ——
      // 否则下面「七列没变」可能只是因为召回根本没命中任何东西。
      const hitsAfterFirst = Number(
        db().prepare('SELECT COALESCE(SUM(recall_hits), 0) AS n FROM atom').get().n,
      )
      const before = snapshot(db())
      assert.ok(before.inferredEdges.length > 0, '前置：库里应当已有推断边，否则②的「不变」是空的')
      assert.ok(before.sentinelEntries.length > 0, '前置：库里应当已有 origin=extracted 的入口行')
      assert.ok(
        before.sentinelEntries.some((e) => JSON.parse(e).origin === 'declared'),
        '前置：夹具里要有 origin=declared 的入口行，否则这一层没被测到',
      )

      await r.execute({ query: q })
      const hitsAfterSecond = Number(
        db().prepare('SELECT COALESCE(SUM(recall_hits), 0) AS n FROM atom').get().n,
      )
      assert.ok(
        hitsAfterSecond > hitsAfterFirst,
        '前置：第二次召回抬高了 recall_hits（' +
          hitsAfterFirst +
          ' → ' +
          hitsAfterSecond +
          '），说明召回路径真的执行了',
      )
      const after = snapshot(db())
      assert.deepEqual(after.atoms, before.atoms, 'atom 七列（不含 recall_hits/last_recalled_at）不得变化')
      assert.deepEqual(after.topics, before.topics, 'topic 行不得变化')
      assert.deepEqual(after.atomTopics, before.atomTopics, 'atom_topic 行不得变化')
      assert.deepEqual(after.inferredEdges, before.inferredEdges, '推断边不得变化')
      assert.deepEqual(after.pairs, before.pairs, 'atom_pair 行不得变化')
      assert.deepEqual(after.sentinelEntries, before.sentinelEntries, 'declared 与 extracted 入口行不得变化')

      // ④ 只读连接：同一条查询，文本逐字符相同、锚点 id 逐个相同。
      const recallOpts = { topN: config.topN }
      const viewOpts = { budget: config.viewBudget, scene: q }
      const recalledWritable = recall(db(), q, null, recallOpts)
      assert.ok(recalledWritable.hits.length > 0, '前置：这次召回要有命中，否则两边比的都是空文本')
      const asWritable = assembleView(db(), recalledWritable, viewOpts)
      const ro = openVault(join(dir, 'lattice.db'), { readOnly: true })
      let asReadOnly = null
      try {
        asReadOnly = assembleView(ro.db, recall(ro.db, q, null, recallOpts), viewOpts)
      } finally {
        ro.db.close()
      }
      assert.ok(asWritable.text.length > 0, '前置：这次召回应当有内容')
      assert.equal(asReadOnly.text, asWritable.text)
      assert.deepEqual(asReadOnly.anchorIds, asWritable.anchorIds)
    })
  })
})

/**
 * 取六份行集合的快照，每行序列化成一个字符串（行内键顺序由 SQL 固定，所以可以直接逐行比较）。
 * 六份分别是：atom 的真相列（七列 + 三个时间戳）、topic 行、atom_topic 行、推断边、atom_pair、
 * 非 learned 的入口行（declared 与 extracted）。
 * 故意**不**取 atom.recall_hits / last_recalled_at —— 召回本来就要改这两列；
 * 也**不**取 origin='learned' 的入口行 —— 那是第 3 层，召回本来就该升它的 hits 与 last_seen。
 */
function snapshot(db) {
  const rows = (sql) =>
    db
      .prepare(sql)
      .all()
      .map((row) => JSON.stringify(row))
  return {
    atoms: rows(
      'SELECT id, text, summary, kind, scope, origin, flags, superseded_by, created_at, updated_at, superseded_at FROM atom ORDER BY id',
    ),
    topics: rows(
      'SELECT id, domain_id, label, n_atoms, mean_fit, created_at, rebuilt_at FROM topic ORDER BY id',
    ),
    atomTopics: rows('SELECT atom_id, topic_id, weight, origin FROM atom_topic ORDER BY atom_id, topic_id'),
    inferredEdges: rows(
      "SELECT id, src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at FROM edge WHERE origin = 'inferred' ORDER BY id",
    ),
    pairs: rows('SELECT a_id, b_id, cos, lexical FROM atom_pair ORDER BY a_id, b_id'),
    sentinelEntries: rows(
      "SELECT id, atom_id, term, bigram, weight, origin, hits, last_seen, created_at FROM entry WHERE origin <> 'learned' ORDER BY id",
    ),
  }
}

// 显式删除测试（§44）：物理删除 / 留痕 / 防写回 / 级联清理。
//
// 这里**不加载真实模型**：所有向量由测试自己注入。理由与 write.test.mjs 相同 ——
// 这条管线要验的是判据与清理动作，用真实模型反而无法构造「刚好卡在线上」的样本。
// 真实模型下的判据分布由两个校准探针量（报告里有完整数字与判据比较表）。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync } from 'node:fs'
import { apply } from '../dist/index.js'
import { closeRuntime, getRuntime } from '../dist/state.js'
import { openVault } from '../dist/db/open.js'
import { VEC_DIM, encodeVec } from '../dist/util/vec.js'
import { createWriteCtx, writeAtom, ForgottenError } from '../dist/pipeline/write.js'
import {
  DEFAULT_FORGET_THRESHOLDS,
  FORGOTTEN_MIN_BIGRAMS,
  checkForgotten,
  fingerprintOf,
  forgetAtom,
  forgottenSet,
  termsOfFingerprint,
} from '../dist/pipeline/forget.js'

let dbFile = ''
let db = null

describe('forget', () => {
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-forget-' +
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
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + suffix, { force: true })
  })

  /** 单热向量：第 i 维为 1，其余为 0（本身已是单位向量）。 */
  function oneHot(i) {
    const v = new Float32Array(VEC_DIM)
    v[i % VEC_DIM] = 1
    return v
  }

  /** 关键词 → 固定向量。让同一个关键词的「改写」在余弦上是 1.0，用来单测几何兜底那一路。 */
  function keywordEncoder(map) {
    return async (text) => {
      for (const [kw, vec] of map) if (text.includes(kw)) return vec
      return oneHot(999)
    }
  }

  const T = DEFAULT_FORGET_THRESHOLDS
  const count = (sql) => Number(db.prepare(sql).get().n)

  /** 与 oneHot(0) 成 45° 的单位向量：余弦 0.707。 */
  function diagonal() {
    const v = new Float32Array(VEC_DIM)
    const a = 1 / Math.sqrt(2)
    v[0] = a
    v[1] = a
    return v
  }

  /**
   * 与 oneHot(1)（本文件 seed 默认用的那个）成 `theta` 角的单位向量：余弦 = cos(theta)。
   *
   * 用它来**落在判据线之间**：单测要能构造「余弦刚刚过这条线、但没过那条线」的样本，
   * 否则验不出兜底那条线与主判据是两条不同的线。
   */
  function atAngle(theta) {
    const v = new Float32Array(VEC_DIM)
    v[1] = Math.cos(theta)
    v[2] = Math.sin(theta)
    return v
  }

  describe('显式删除：物理删除与留痕', () => {
    it('删完 atom 就不在库里了，墓碑记下它的指纹 / kind / scope / 时间', async () => {
      const ctx = createWriteCtx(db, {}, { encode: keywordEncoder([['代理', oneHot(1)]]) })
      const w = await writeAtom(ctx, {
        text: '系统代理必须走本地端口，否则访问境外源会直接超时。',
        kind: '坑',
        scope: 'proj-a',
      })
      assert.equal(count('SELECT COUNT(*) AS n FROM atom'), 1)

      const r = forgetAtom(db, { atomId: w.atomId })
      assert.notEqual(r, null)
      assert.equal(r.alreadyForgotten, false)
      // 物理删除：库里真的没有这一行了，不是标记、不是隐藏。
      assert.equal(count('SELECT COUNT(*) AS n FROM atom'), 0)
      assert.equal(count('SELECT COUNT(*) AS n FROM forgotten'), 1)

      const row = db.prepare('SELECT * FROM forgotten').get()
      assert.equal(row.atom_id, w.atomId)
      assert.equal(row.kind, '坑')
      assert.equal(row.scope, 'proj-a')
      assert.ok(String(row.summary).length > 0, '墓碑要留下摘要，否则说不出删了什么')
      assert.ok(Number(row.deleted_at) > 0)
      assert.ok(termsOfFingerprint(String(row.fingerprint)).size >= FORGOTTEN_MIN_BIGRAMS)
      assert.equal(
        String(row.fingerprint),
        fingerprintOf('系统代理必须走本地端口，否则访问境外源会直接超时。'),
      )
    })

    it('级联清理：入口 / 次属 / 检索正文 / 边 / 取代关系 / 两个 FTS 都不留悬空', async () => {
      const ctx = createWriteCtx(
        db,
        {},
        {
          encode: keywordEncoder([
            ['代理', oneHot(1)],
            ['缓存', oneHot(2)],
          ]),
        },
      )
      const a = await writeAtom(ctx, { text: '系统代理必须走本地端口，否则访问境外源会直接超时。' })
      const b = await writeAtom(ctx, { text: '缓存要按内存比例给，SQLite 默认只有 2 MB，对万级 atom 偏小。' })
      const c = await writeAtom(ctx, { text: '代理配置从注册表读，不要硬编码，换机器会失效。' })

      // 手工造出「指向 a 的每一处引用」：次属、两条边（一进一出）、取代关系。
      db.prepare('INSERT INTO atom_topic(atom_id, topic_id, weight, origin) VALUES (?, ?, ?, ?)').run(
        a.atomId,
        b.topicId,
        0.5,
        'secondary',
      )
      const insEdge = db.prepare(
        'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      insEdge.run('atom', a.atomId, 'atom', b.atomId, 'related', 0.9, 'declared', Date.now())
      insEdge.run('atom', c.atomId, 'atom', a.atomId, 'related', 0.9, 'declared', Date.now())
      db.prepare('UPDATE atom SET superseded_by = ? WHERE id = ?').run(a.atomId, b.atomId)
      assert.ok(count('SELECT COUNT(*) AS n FROM edge') >= 2)

      forgetAtom(db, { atomId: a.atomId })

      // §36：悬空引用数 DR > 0 是硬失败。这就是那条判据的本地版。
      assert.equal(
        count(
          "SELECT COUNT(*) AS n FROM edge WHERE (src_type='atom' AND src_id NOT IN (SELECT id FROM atom)) OR (dst_type='atom' AND dst_id NOT IN (SELECT id FROM atom))",
        ),
        0,
        '不留悬空的边',
      )
      assert.equal(
        count('SELECT COUNT(*) AS n FROM atom_topic WHERE atom_id NOT IN (SELECT id FROM atom)'),
        0,
        '不留悬空的次属引用',
      )
      assert.equal(count('SELECT COUNT(*) AS n FROM entry WHERE atom_id NOT IN (SELECT id FROM atom)'), 0)
      assert.equal(count('SELECT COUNT(*) AS n FROM atom_search WHERE id NOT IN (SELECT id FROM atom)'), 0)
      assert.equal(
        count(
          'SELECT COUNT(*) AS n FROM atom WHERE superseded_by IS NOT NULL AND superseded_by NOT IN (SELECT id FROM atom)',
        ),
        0,
        '不留悬空的取代关系',
      )
      // 全文索引也要跟着走：entry_fts / atom_fts 不同步时**不会报错**，只会检索不到。
      assert.equal(
        count('SELECT COUNT(*) AS n FROM entry_fts WHERE rowid NOT IN (SELECT id FROM entry)'),
        0,
        'entry_fts 不留孤儿行',
      )
      assert.equal(
        count('SELECT COUNT(*) AS n FROM atom_fts WHERE rowid NOT IN (SELECT id FROM atom_search)'),
        0,
        'atom_fts 不留孤儿行',
      )
    })

    it('幂等：再删一次不多留墓碑，atom 本来就不在时返回 null', async () => {
      const ctx = createWriteCtx(db, {}, { encode: keywordEncoder([['代理', oneHot(1)]]) })
      const w = await writeAtom(ctx, { text: '系统代理必须走本地端口，否则访问境外源会直接超时。' })
      const first = forgetAtom(db, { atomId: w.atomId })
      const second = forgetAtom(db, { atomId: w.atomId })
      assert.equal(second.alreadyForgotten, true)
      assert.equal(second.tombstoneId, first.tombstoneId, '第二次不该新建墓碑')
      assert.equal(count('SELECT COUNT(*) AS n FROM forgotten'), 1)
      // 从来没存在过的 id：null，调用方据此回 404。
      assert.equal(forgetAtom(db, { atomId: 999999 }), null)
    })

    it('atom_id 不是正整数时显式失败，不静默什么都不做', () => {
      assert.throws(() => forgetAtom(db, { atomId: 0 }), /正整数/)
      assert.throws(() => forgetAtom(db, { atomId: 1.5 }), /正整数/)
    })
  })

  describe('防写回：判据、反馈与边界', () => {
    /** 埋一条墓碑，返回它的 atom id。 */
    async function seed(text, vec = oneHot(1), kind = '结论') {
      const ctx = createWriteCtx(db, {}, { encode: async () => vec })
      const w = await writeAtom(ctx, { text, kind })
      forgetAtom(db, { atomId: w.atomId })
      return w.atomId
    }

    const TOMB = '系统代理必须走本地端口，否则访问境外源会直接超时。'

    it('原文写不回来：抛 ForgottenError，且证据里说清命中的是哪条墓碑', async () => {
      const gone = await seed(TOMB)
      const ctx = createWriteCtx(db, {}, { encode: async () => oneHot(1) })
      await assert.rejects(
        () => writeAtom(ctx, { text: TOMB }),
        (err) => {
          assert.ok(err instanceof ForgottenError, '要能被区分出来，调用方才能给出具体反馈')
          assert.equal(err.evidence.atomId, gone)
          assert.equal(err.evidence.how, 'both', '原文应当两票都过')
          assert.ok(err.evidence.lex >= T.tauLex)
          assert.ok(err.evidence.cos >= T.tauJoin)
          assert.ok(err.evidence.tombstoneId > 0)
          assert.ok(String(err.evidence.summary).length > 0, '反馈里要能说出删的是哪条')
          return true
        },
      )
      // 拦下之后库里**确实没多出那条** —— 断言「没多出来」而不是「抛错了」，两件事。
      assert.equal(count('SELECT COUNT(*) AS n FROM atom'), 0)
    })

    it('判据②的陷阱：**改了说法仍然被拦**（只靠词面票是不够的）', async () => {
      await seed(TOMB)
      const ctx = createWriteCtx(db, {}, { encode: async () => oneHot(1) })
      // 这一句与原文的 bigram 重叠很低（词面票大概率不过），但它是同一件事。
      const rewrite = '不走本地端口的系统代理会让境外源访问超时。'
      const probe = checkForgotten(db, rewrite, oneHot(1))
      assert.equal(probe.hit, true, '改写也必须被拦下')
      assert.ok(probe.evidence.cos >= T.nearCos, '改写靠几何兜底命中')
      await assert.rejects(() => writeAtom(ctx, { text: rewrite }), ForgottenError)
      assert.equal(count('SELECT COUNT(*) AS n FROM atom'), 0)
    })

    it('改写幅度大到一个词都不重时，词面票不过 —— 如实报出来，不假装判过', async () => {
      await seed(TOMB)
      // 与原文完全不共享 bigram 的另一句话。余弦仍高（同一个假向量），所以几何兜底会拦住；
      // 这里要验的是**词面票确实是 0**，即「命中来自兜底而不是主判据」。
      const far = '登录态丢失时先看 cookie 的 SameSite。'
      const probe = checkForgotten(db, far, oneHot(1))
      assert.equal(probe.hit, true)
      assert.equal(probe.evidence.lex, 0)
      assert.equal(probe.evidence.how, 'near')
    })

    it('几何兜底是一条**独立**的线：词面票没过、余弦够高时仍然拦住', async () => {
      await seed(TOMB)
      // 余弦取 cos(30°) ≈ 0.866：过了 nearCos(0.72)，也过了 tauJoin —— 但词的写法完全不同。
      // 这条用例是「兜底不是死代码」的证据：主判据要求词面票也过，这里词面是 0。
      const probe = checkForgotten(db, '登录态丢失时先看 cookie 的 SameSite。', atAngle(Math.PI / 6))
      assert.equal(probe.hit, true)
      assert.equal(probe.evidence.lex, 0, '词面票是 0 —— 命中只可能来自兜底')
      assert.equal(probe.evidence.how, 'near')
      assert.ok(probe.evidence.cos >= T.nearCos)
    })

    it('兜底线**必须低于**主判据的余弦线，否则它是死代码', () => {
      // 这条断言守的是一个已经踩过的坑：兜底取 0.78（= tauJoin）时，「余弦 >= 0.78」
      // 是主判据条件之一，命中集合是主判据的子集 —— 实测表现与只做主判据逐格相同。
      assert.ok(T.nearCos < T.tauJoin, 'nearCos 必须严格小于 tauJoin，否则兜底多拦不到任何一条')
    })

    it('不同的事写得进去：余弦低时不拦（误拦是静默的，代价不对称）', async () => {
      await seed(TOMB)
      // 光换一维是不够的：正交向量余弦恒为 0，验不出「几何票真的算了数」。
      // 给一个与墓碑成 45° 的向量 —— 余弦 0.707，**低于** tauJoin / nearCos，必须放行。
      const ctx = createWriteCtx(db, {}, { encode: async () => diagonal() })
      const w = await writeAtom(ctx, { text: '缓存要按内存比例给，SQLite 默认只有 2 MB。' })
      assert.ok(w.atomId > 0)
      assert.equal(count('SELECT COUNT(*) AS n FROM atom'), 1)
      // 而且这次**确实比过**了 —— 痕迹留在结果上，不是静默跳过。
      assert.equal(w.forgotten.scanned, 1)
      assert.equal(w.forgotten.truncated, false)
    })

    it('没有墓碑时这一步零成本：scanned=0，结果上不留痕迹', async () => {
      const ctx = createWriteCtx(db, {}, { encode: async () => oneHot(1) })
      const w = await writeAtom(ctx, { text: TOMB })
      assert.equal(w.forgotten, undefined, '没有墓碑就不该在结果上写一笔')
      const probe = checkForgotten(db, TOMB, oneHot(1))
      assert.deepEqual(probe, { hit: false, scanned: 0, truncated: false })
    })

    it('无向量时几何票缺席：原文仍靠词面拦截，但只剩一票', async () => {
      await seed(TOMB)
      const probe = checkForgotten(db, TOMB, null)
      assert.equal(probe.hit, true)
      assert.equal(probe.evidence.cos, null, '没算就是没算，不写 0')
      // 无向量时只剩词面一票，门槛抬到 tauLexOnly —— 与落位在降级时同一方向。
      assert.equal(probe.evidence.how, 'both')
      assert.ok(probe.evidence.lex >= T.tauLexOnly)
    })

    it('短到判不了的文本不做判断：放行，但如实报出扫过多少条', async () => {
      await seed(TOMB)
      const probe = checkForgotten(db, '好', oneHot(1))
      assert.equal(probe.hit, false)
      assert.equal(probe.scanned, 1, '「放行」与「根本没比」必须分得开')
    })

    it('指纹是排序去重的 bigram 文本，与落位判据同粒度', () => {
      assert.equal(fingerprintOf('代理'), '代理')
      // 切词规则（`bigramTerms`）：整段 CJK 先作为一个 term（'系统代理'），
      // **再**在整串上滑二字窗（'系统' / '统代' / '代理'）—— 与 write.ts 的 atomLex 是
      // 同一个函数，所以指纹与落位判据同粒度。
      assert.deepEqual([...termsOfFingerprint(fingerprintOf('系统代理'))].sort(), [
        '代理',
        '系统',
        '系统代理',
        '统代',
      ])
      // 指纹是**集合**的排序视图，所以：重复与分隔不影响它。
      assert.equal(fingerprintOf('代理 代理'), fingerprintOf('代理'))
      assert.equal(fingerprintOf('代理'), fingerprintOf('代理。'))
      // 而**字序会**影响它：滑窗二字组取自相邻两个字，'系统代理' 与 '代理系统' 因此
      // 有不同的二字组（系统/统代/代理 vs 代理系统 整段 + 理系/系统）。这不是缺陷：
      // 落位判据的 atomLex 用的是同一个函数，指纹与它同粒度才是重点。
      assert.notEqual(fingerprintOf('系统代理'), fingerprintOf('代理系统'))
    })

    it('墓碑多到超过扫描上限时如实标出 truncated，不静默只比一部分', async () => {
      // 直接写墓碑而不是走 seed()：本用例验的是**扫描上限**这一路，
      // 而 seed 的第二次调用会被刚埋下的墓碑拦住 —— 那正是判据在正常工作。
      for (let i = 0; i < 3; i++) {
        db.prepare(
          'INSERT INTO forgotten(atom_id, fingerprint, embedding, kind, scope, origin, summary, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          1000 + i,
          fingerprintOf('第 ' + i + ' 条互不相干的技术结论，讲的是完全不同的事。'),
          encodeVec(oneHot(50 + i)),
          '结论',
          'global',
          'model',
          '第 ' + i + ' 条',
          Date.now(),
        )
      }
      const s = forgottenSet(db, 2)
      assert.equal(s.rows.length, 2)
      assert.equal(s.truncated, true)
      // checkForgotten 用默认扫描上限（2000）：三条墓碑全扫到，所以不标 truncated。
      // 上面的 forgottenSet(db, 2) 才是截断那一路的确定性证据。
      const probe = checkForgotten(db, TOMB, oneHot(1))
      assert.equal(probe.scanned, 3)
      assert.equal(probe.truncated, false)
    })
  })

  describe('防写回的反馈：走真实工具入口', () => {
    /**
     * 这一段**自成一套库**，不复用外层的 db/dbFile。
     *
     * 原因是 state.ts 的运行时是**进程级单例**（`getRuntime` 只初始化一次），而宿主半把
     * 库名固定成 `lattice.db`。所以「工具写的库」与「断言查的库」要一致，只有两条路：
     * 让工具打开本段的库，或者让本段的断言去查工具开的库。这里选前者 ——
     * `dataDir` 指到一个**新建的空目录**，先在别处 `closeRuntime()` 清掉单例，
     * 于是工具运行时打开的必定是本段这个库。
     *
     * 上一版踩过的坑写在这里：一开始用 mkdtemp 建了目录，却在**外层**的 db 上断言，
     * 那两条 `count(...)` 因此永远查的是另一份库、恒为 0 —— 断言恒真。
     */
    let dir = ''
    let toolDb = null
    let registered = []

    beforeEach(() => {
      closeRuntime()
      dir = join(
        tmpdir(),
        'dsh-lattice-forget-tool-' +
          process.pid +
          '-' +
          Date.now() +
          '-' +
          Math.random().toString(36).slice(2),
      )
      mkdirSync(dir, { recursive: true })
      registered = []
      const ctx = {
        get: (k) => (k === 'tools' ? { register: (x) => registered.push(x) } : undefined),
        effect: (fn) => fn(),
        inject: () => {},
      }
      // 与下面 getRuntime 的 cfg 逐字一致：同一个 dataDir、同一个开关。
      apply(ctx, cfgFor(dir))
      toolDb = getRuntime(cfgFor(dir)).db
    })

    afterEach(() => {
      try {
        closeRuntime()
      } catch {
        /* 未初始化 */
      }
      rmSync(dir, { recursive: true, force: true })
    })

    function cfgFor(d) {
      return {
        enabled: true,
        dataDir: d,
        encoderEnabled: false,
        encoderModel: '',
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

    const RE_WRITTEN = /已写入记忆 #(\d+)/
    const RE_REJECT = /写入被拒/
    /** 查**工具那个库**（不是外层那个）—— 这条管线写在哪，就在哪查。 */
    const inToolDb = (id) => Number(toolDb.prepare('SELECT COUNT(*) AS n FROM atom WHERE id = ' + id).get().n)

    const TEXT = '系统代理必须走本地端口，否则访问境外源会直接超时。'

    it('被拦时工具返回一条说清原因的文本，而不是抛错、也不是静默成功', async () => {
      const write = registered.find((x) => x.name === 'lattice_write')
      const first = await write.execute({ text: TEXT })
      const m = RE_WRITTEN.exec(first)
      assert.ok(m !== null, '第一次写入应当成功：' + first)
      const id = Number(m[1])
      assert.equal(inToolDb(id), 1, '这条确实进了工具那个库')

      // 模型调不到删除（lattice_forget 不在工具表里），所以这里直接删库里那一行 ——
      // 本用例要验的是**写入侧的反馈**，删除的执行由本文件其它用例覆盖。
      forgetAtom(toolDb, { atomId: id })
      assert.equal(inToolDb(id), 0, '删除真的生效了')

      const again = await write.execute({ text: TEXT })
      assert.match(again, RE_REJECT)
      assert.match(again, /用户删过/)
      assert.match(again, new RegExp('#' + id))
      assert.ok(!RE_WRITTEN.test(again), '被拒时不得再报「已写入」')
      assert.equal(inToolDb(id), 0, '库里确实没多出那条')
    })

    it('被拦后换一件事写，仍然写得进去（拦的是那条内容，不是这个人）', async () => {
      const write = registered.find((x) => x.name === 'lattice_write')
      const gone = await write.execute({ text: TEXT })
      forgetAtom(toolDb, { atomId: Number(RE_WRITTEN.exec(gone)[1]) })
      assert.match(await write.execute({ text: TEXT }), RE_REJECT)
      const other = await write.execute({ text: '缓存要按内存比例给，SQLite 默认只有 2 MB。' })
      assert.match(other, RE_WRITTEN)
    })
  })
})

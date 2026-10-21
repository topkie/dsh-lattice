// T29（pending_split 异步确认）的判据用例。
//
// 判据编号与任务描述一致：
//   1 候选产生   2 召回呈现   3 呈现不改排序与档位
//   4 确认 / 忽略可交互（含四条栅栏与幂等）   5 不执行实际拆分   6 呈现不写库
//
// 与其它测试文件同一条纪律：**每个用例用自己的临时库**，绝不碰用户真实库
// （test/isolation.test.mjs 守着这条）。
//
// 这一组不加载真实模型：向量由用例自己给（与 write.test.mjs 同一理由 —— 判据要在
// 确定的输入上可比，真实模型每次给的点不同）。工具侧那几个用例走的是编码器失败的
// 替身（test/stubs），也就是纯词面模式。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../dist/index.js'
import { openVault } from '../dist/db/open.js'
import { createWriteCtx, writeAtom, writeReviewed } from '../dist/pipeline/write.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView } from '../dist/pipeline/view.js'
import {
  SPLIT_CONFIRMED_MAX,
  confirmSplit,
  readConfirmedSplits,
  readPendingSegments,
} from '../dist/pipeline/split.js'
import { upsertSegments } from '../dist/db/split-queue.js'
import { closeRuntime, getRuntime } from '../dist/state.js'
import { closeLog, flushLog, logFilePath } from '../dist/log/index.js'
import { resetEncoder } from '../dist/encoder/index.js'
import { VEC_DIM } from '../dist/util/vec.js'
import { openRuler } from './ro-ruler.mjs'

/** 由文本确定性生成的伪随机单位向量：同一文本恒得同一向量。 */
function hashVec(text) {
  const v = new Float32Array(VEC_DIM)
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

/** 零向量 BLOB：手写 SQL 造 atom 时用它，长度必须是 VEC_DIM 个 float32。 */
const ZERO_VEC = new Uint8Array(VEC_DIM * 4)

/**
 * 超过单条上限、按句能切成 n 段的文本。每段都带同一个话题词（代理端口），
 * 这样召回查询「代理端口」能把每一段都捞上来。
 */
function longText(n) {
  let out = ''
  for (let i = 1; i <= n; i++) out += '代理端口第' + i + '段：' + '甲'.repeat(300) + '。'
  return out
}

/** 注入文本里某条锚行（没有就返回空串）。锚行形如 `- [#12·…] 正文`。 */
function anchorLine(text, id) {
  const re = new RegExp('^- \\[' + id + '(\\]|·)')
  return text.split('\n').find((l) => re.test(l)) ?? ''
}

/** 运行时配置的最小形状（与 index.ts 的默认值一致）。 */
function cfgOf(dataDir) {
  return {
    enabled: true,
    dataDir,
    encoderEnabled: true,
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
  }
}

/** 最小假 ctx：只实现插件用到的那两个服务，外加 inject（与 plugin.test.mjs 同形）。 */
function fakeCtx({ webServer } = {}) {
  const registered = []
  const ctx = {
    registered,
    get: (k) => {
      if (k === 'tools') return { register: (t) => registered.push(t) }
      if (k === 'webServer') return webServer
      return undefined
    },
    effect: (fn) => fn(),
    inject: (_deps, callback) => {
      if (webServer !== undefined) callback(Object.assign({}, ctx, { webServer }))
    },
  }
  return ctx
}

/** 最小 res 替身（必须是真 EventEmitter：ServerResponse.end 走 finish 事件）。 */
function fakeRes() {
  const res = new EventEmitter()
  res.out = { status: 0, body: null }
  res.writeHead = (status) => {
    res.out.status = status
    return res
  }
  res.end = (text) => {
    if (typeof text === 'string') {
      try {
        res.out.body = JSON.parse(text)
      } catch {
        res.out.body = text
      }
    }
    return res
  }
  return res
}

/** 最小 req 替身（必须是真 EventEmitter：body 要等 handler 挂上监听之后再发）。 */
function fakeReq({ remote = '127.0.0.1', method = 'POST', type = 'application/json', body = '{}' } = {}) {
  const req = new EventEmitter()
  req.socket = { remoteAddress: remote }
  req.method = method
  req.headers = type === null ? {} : { 'content-type': type }
  req.url = '/'
  req.destroy = () => {}
  setImmediate(() => {
    req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

// ─────────────────────────── 判据 1：候选产生（写入侧） ───────────────────────────

let dbFile = ''
let db = null

describe('T29 判据 1：按长度切分产生候选', () => {
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-split-' +
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
    db = null
    for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true })
  })

  it('判据 1：切成几段就置几个 bit0；单条写入不置', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const text = longText(3)
    assert.ok(text.length > 700, '用例输入必须超过 700 字，实际 ' + text.length)
    const out = await writeReviewed(ctx, { text })
    assert.equal(out.length.action, 'split')
    assert.ok(out.length.segments.length >= 2, '应切成 2 段以上，实际 ' + out.length.segments.length)
    assert.equal(out.results.length, out.length.segments.length)
    for (const r of out.results) {
      assert.equal(Number(r.flags) & 1, 1, '#' + r.atomId + ' 的回执应含 bit0，实际 flags=' + r.flags)
      const row = db.prepare('SELECT flags FROM atom WHERE id = ?').get(r.atomId)
      assert.equal(Number(row.flags) & 1, 1, '#' + r.atomId + ' 落库的 flags 应含 bit0')
    }
    // 单条写入（没有切点）不置这一位：没有需要确认的东西。
    // 它仍可能带「未归类」（新建主题时的那一位），判据只问 bit0。
    const single = await writeReviewed(ctx, { text: '代理端口固定为 7890，这是一条普通记忆。' })
    assert.equal(single.length.action, 'keep')
    assert.equal(Number(single.results[0].flags ?? 0) & 1, 0, '单条写入不该带 bit0')
    const row = db.prepare('SELECT flags FROM atom WHERE id = ?').get(single.results[0].atomId)
    assert.equal(Number(row.flags) & 1, 0)
  })
})

// ─────────────────────────── 判据 1：写入回执 ───────────────────────────

let receiptDir = ''
let receiptTools = []

describe('T29 判据 1：写入回执说明切了几段', () => {
  beforeEach(() => {
    resetEncoder()
    closeRuntime()
    receiptDir = mkdtempSync(join(tmpdir(), 'dsh-lattice-split-receipt-'))
    const ctx = fakeCtx()
    apply(ctx, cfgOf(receiptDir))
    receiptTools = ctx.registered
  })
  afterEach(() => {
    closeRuntime()
    closeLog()
    rmSync(receiptDir, { recursive: true, force: true })
  })

  it('判据 1：回执给出段数，并说明切点按长度定（不暗示做过内容判断）', async () => {
    const write = receiptTools.find((t) => t.name === 'lattice_write')
    const out = await write.execute({ text: longText(3) })
    assert.ok(out.includes('按长度切成 3 条'), '回执应给出段数，实际输出：\n' + out)
    assert.ok(out.includes('没有按内容判断'), '回执必须说明没做过内容判断，实际输出：\n' + out)
    assert.equal(out.includes('装了不止一件事'), false, '不允许暗示做过内容判断')
    assert.ok(out.includes('待拆分（按长度切出）'), '每段的标记要说明是怎么来的，实际输出：\n' + out)
    assert.ok(
      out.includes('flags=5') || out.includes('flags=1'),
      '回执应带可核对的 flags 值，实际输出：\n' + out,
    )
  })
})

// ─────────────────────────── 判据 2：召回呈现 ───────────────────────────

describe('T29 判据 2：召回时把候选连同使用场景给出来', () => {
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-split-scene-' +
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
    db = null
    for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true })
  })

  it('判据 2：锚行出现「疑似应拆分」，并带上本次查询词；普通记忆不带', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const control = await writeAtom(ctx, { text: '代理端口固定为 7890，这是一条普通记忆。' })
    const out = await writeReviewed(ctx, { text: longText(3) })
    const ids = out.results.map((r) => r.atomId)
    const q = '代理端口'
    const view = assembleView(db, recall(db, q, null, { topN: 24 }), { scene: q, budget: 6000 })
    for (const id of ids) {
      const line = anchorLine(view.text, id)
      assert.notEqual(line, '', '#' + id + ' 应当在锚段里，实际文本：\n' + view.text)
      assert.ok(
        line.includes('疑似应拆分（3 段，切点按长度，未判内容）'),
        '#' + id + ' 缺候选标记或段数：' + line,
      )
      assert.ok(line.includes('用于：' + q), '#' + id + ' 缺本次查询词：' + line)
    }
    const controlLine = anchorLine(view.text, control.atomId)
    assert.notEqual(controlLine, '', '对照条目也应当在锚段里')
    assert.equal(controlLine.includes('疑似应拆分'), false, '普通记忆不该出现候选标记')
    assert.equal(controlLine.includes('用于：'), false, '普通记忆不该出现使用场景')
  })

  it('判据 2：确认之后锚行换成「用户已确认应拆分」，不再是候选', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const out = await writeReviewed(ctx, { text: longText(2) })
    const id = out.results[0].atomId
    assert.ok(confirmSplit(db, id) !== null)
    const view = assembleView(db, recall(db, '代理端口', null, { topN: 24 }), { scene: '代理端口' })
    const line = anchorLine(view.text, id)
    assert.ok(line.includes('用户已确认应拆分（可按内容重写并声明 supersedes）'), '确认后应给下一步：' + line)
    assert.equal(line.includes('疑似应拆分'), false, '确认之后不再是候选')
    assert.equal(readPendingSegments(db).has(id), false, '确认之后这条的段数不该再占着表')
  })

  it('判据 2：段数读的是库，不是渲染代码里的字面量', async () => {
    // 上一条用例断言的是「锚行说 3 段」，而把 3 写死在 view.ts 里同样能通过它。
    // 这条把库里的数改掉再渲染一次：跟着变的才是真读库。
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const out = await writeReviewed(ctx, { text: longText(3) })
    const ids = out.results.map((r) => r.atomId)
    const q = '代理端口'
    for (const id of ids) {
      const line = anchorLine(assembleView(db, recall(db, q, null, { topN: 24 }), { scene: q }).text, id)
      assert.ok(line.includes('（3 段，'), '写入侧应当已经记下 3 段：' + line)
    }

    for (const id of ids) upsertSegments(db, id, 2)
    for (const id of ids) {
      const line = anchorLine(assembleView(db, recall(db, q, null, { topN: 24 }), { scene: q }).text, id)
      assert.ok(line.includes('（2 段，'), '库里改成 2，锚行就得说 2 段：' + line)
    }

    // 队列里没有段数：位还在，数没有。那句话仍然成立，只是少一个数。
    db.exec('DELETE FROM split_queue WHERE segments IS NOT NULL')
    for (const id of ids) {
      const line = anchorLine(assembleView(db, recall(db, q, null, { topN: 24 }), { scene: q }).text, id)
      assert.ok(line.includes('疑似应拆分（切点按长度，未判内容）'), '缺段数时退回固定串：' + line)
    }
  })
})

// ─────────────────────────── 判据 3：呈现不改排序与档位 ───────────────────────────

describe('T29 判据 3：标记只增文本，不改排序与档位', () => {
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-split-order-' +
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
    db = null
    for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true })
  })

  it('判据 3：带 bit0 与清掉 bit0 两种状态下，顺序 / final / 档位一致，单锚增量 ≤ 44 字', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    await writeAtom(ctx, { text: '代理端口的固定端口是 7890。' })
    await writeAtom(ctx, { text: '代理端口要同时配 Node 的环境变量。' })
    const out = await writeReviewed(ctx, { text: longText(3) })
    assert.ok(out.results.length >= 2)
    // 查询词故意给长：截断要在这一条判据里生效（16 字），否则单锚增量会超上限。
    // 上限 44 而非 40：提示里多了「3 段，」这 4 个字符（判据 2 要求的段数）。
    // 原实现的增量是 38，余量本来只有 2 字；放宽后余量仍是 2 字。
    const scene = '代理端口' + '，还有一些用来测截断的限定词'.repeat(3)
    const q = '代理端口'
    const before = recall(db, q, null, { topN: 24 })
    const viewBefore = assembleView(db, before, { scene, budget: 6000 })
    const idsBefore = before.hits.map((h) => h.id)
    const finalsBefore = before.hits.map((h) => h.final)
    assert.ok(idsBefore.length > 0)

    db.prepare('UPDATE atom SET flags = flags & ~1').run()
    const after = recall(db, q, null, { topN: 24 })
    const viewAfter = assembleView(db, after, { scene, budget: 6000 })
    assert.deepEqual(
      after.hits.map((h) => h.id),
      idsBefore,
      '命中顺序不该被标记改变',
    )
    assert.deepEqual(
      after.hits.map((h) => h.final),
      finalsBefore,
      'final 分值不该被标记改变',
    )
    assert.equal(viewAfter.tier, viewBefore.tier, '档位不该被标记改变')
    for (const id of idsBefore) {
      const delta = anchorLine(viewBefore.text, id).length - anchorLine(viewAfter.text, id).length
      assert.ok(delta >= 0 && delta <= 44, '#' + id + ' 的单锚文本增量应在 0~44 字，实际 ' + delta)
    }
  })
})

// ─────────────────────────── 判据 6：呈现不写库 ───────────────────────────

describe('T29 判据 6：召回不写库', () => {
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-split-ro-' +
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
    db = null
    for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true })
  })

  it('判据 6：召回前后 data_version 与各表行数不变（在另一个只读连接上量）', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const out = await writeReviewed(ctx, { text: longText(2) })
    assert.ok(out.results.length >= 2)
    // 预热一次：图路的首次建边（ensureGraphEdges）是召回路径上的既有行为，
    // 不属于「呈现」。先让它建完，再量「呈现」这一次有没有写库。
    recall(db, '代理端口', null, {})
    // 同连接读 PRAGMA data_version 看不到本连接自己的写，断言会恒真；
    // 观测因此换成操作前打开、全程不关的另一个只读连接。
    const ruler = openRuler(dbFile)
    try {
      const before = ruler.read()
      const view = assembleView(db, recall(db, '代理端口', null, {}), { scene: '代理端口' })
      assert.ok(view.text.includes('疑似应拆分'), '这一次召回应当确实命中了候选')
      assert.deepEqual(ruler.read(), before, '召回 + 组装不得写库')
    } finally {
      ruler.close()
    }
  })
})

// ─────────────────────── 判据 4 / 5：人的决定（两条写路由） ───────────────────────

const CONFIRM_PATH = '/api/lattice-split-confirm'
const IGNORE_PATH = '/api/lattice-split-ignore'

let routeDir = ''

/** 造一条带 bit0 的记忆（手写 SQL：这两个用例量的是路由，不是写入管线）。 */
function seedFlagged(dir) {
  const d = openVault(join(dir, 'lattice.db')).db
  const now = Date.now()
  const topicId = Number(
    d
      .prepare(
        'INSERT INTO topic (domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at)' +
          ' VALUES (NULL, ?, ?, 1, 0, ?, ?)',
      )
      .run('拆分候选主题', ZERO_VEC, now, now).lastInsertRowid,
  )
  const atomId = Number(
    d
      .prepare(
        'INSERT INTO atom (kind, text, summary, embedding, topic_id, fit, created_at, updated_at, flags)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        '结论',
        '待拆分用例的正文：这一段是从超长原文按长度切出来的，切点没有按内容判断过。',
        '待拆分用例',
        ZERO_VEC,
        topicId,
        1,
        now,
        now,
        1,
      ).lastInsertRowid,
  )
  d.prepare('INSERT INTO atom_topic (atom_id, topic_id, weight, origin) VALUES (?, ?, ?, ?)').run(
    atomId,
    topicId,
    1,
    'primary',
  )
  d.prepare(
    'INSERT INTO entry (atom_id, term, bigram, weight, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(atomId, '待拆分', '待拆分', 1, 'extracted', now)
  d.close()
  return atomId
}

/** 行数与正文快照：判据 5 用它证明「确认 / 忽略不执行拆分」。 */
function snapshotOf(dir, id) {
  const d = openVault(join(dir, 'lattice.db')).db
  try {
    const n = (sql) => Number(d.prepare(sql).get().n)
    const row = d.prepare('SELECT text, updated_at FROM atom WHERE id = ?').get(id)
    return {
      text: String(row.text),
      updatedAt: Number(row.updated_at),
      atoms: n('SELECT COUNT(*) AS n FROM atom'),
      atomTopics: n('SELECT COUNT(*) AS n FROM atom_topic'),
      entries: n('SELECT COUNT(*) AS n FROM entry'),
      topics: n('SELECT COUNT(*) AS n FROM topic'),
    }
  } finally {
    d.close()
  }
}

/** 挂上路由并返回（apply 注册出来的 handler 就是浏览器半打的那两个）。 */
function routesOf(dir) {
  const routes = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  }
  apply(fakeCtx({ webServer }), cfgOf(dir))
  return routes
}

function handlerOf(routes, path) {
  const route = routes.find((r) => r.path === path)
  assert.ok(route !== undefined, '路由未注册：' + path)
  return route.handler
}

/** 日志库里出现过的事件名（先 flush，否则还在内存队列里）。 */
function logEvents(dir) {
  const file = logFilePath(dir)
  if (!existsSync(file)) return []
  const logDb = new DatabaseSync(file, { readOnly: true })
  try {
    return logDb
      .prepare('SELECT event FROM log ORDER BY id')
      .all()
      .map((r) => String(r.event))
  } finally {
    logDb.close()
  }
}

describe('T29 判据 4 / 5：确认与忽略', () => {
  beforeEach(() => {
    resetEncoder()
    closeRuntime()
    closeLog()
    routeDir = mkdtempSync(join(tmpdir(), 'dsh-lattice-split-route-'))
  })
  afterEach(() => {
    closeRuntime()
    closeLog()
    rmSync(routeDir, { recursive: true, force: true })
  })

  it('判据 4 + 5：确认走通 —— 清 bit0、记一条状态，且不执行拆分', async () => {
    const id = seedFlagged(routeDir)
    const before = snapshotOf(routeDir, id)
    const confirm = handlerOf(routesOf(routeDir), CONFIRM_PATH)
    const res = fakeRes()
    await confirm(fakeReq({ body: JSON.stringify({ atom_id: id }) }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.ok, true)
    assert.equal(Number(res.out.body.flags) & 1, 0, 'bit0 应被清掉')
    assert.equal(res.out.body.changed, true)
    assert.equal(res.out.body.confirmedCount, 1, '确认要另记一条状态')
    closeRuntime()
    // 判据 5：文本、updated_at、atom / atom_topic / entry / topic 行数都不变。
    assert.deepEqual(snapshotOf(routeDir, id), before, '确认不得改动记忆本身')
    const d = openVault(join(routeDir, 'lattice.db')).db
    try {
      assert.deepEqual(readConfirmedSplits(d), [id], '确认状态要落在 split_queue 里')
    } finally {
      d.close()
    }
    flushLog()
    assert.ok(
      logEvents(routeDir).includes('split.confirmed'),
      '确认要留一条日志：队列按 added_at 淘汰，被挤掉的那条只剩日志能证明它被确认过',
    )
  })

  it('判据 4：忽略走通 —— 清 bit0、只写一条日志、不记状态', async () => {
    const id = seedFlagged(routeDir)
    const ignore = handlerOf(routesOf(routeDir), IGNORE_PATH)
    const res = fakeRes()
    await ignore(fakeReq({ body: JSON.stringify({ atom_id: id }) }), res)
    assert.equal(res.out.status, 200)
    assert.equal(Number(res.out.body.flags) & 1, 0, 'bit0 应被清掉')
    assert.equal(res.out.body.changed, true)
    assert.equal(res.out.body.confirmedCount, undefined, '忽略不记状态')
    closeRuntime()
    flushLog()
    assert.ok(logEvents(routeDir).includes('split.ignored'), '忽略要留一条日志')
    const d = openVault(join(routeDir, 'lattice.db')).db
    try {
      assert.deepEqual(readConfirmedSplits(d), [], '忽略不写确认清单')
    } finally {
      d.close()
    }
  })

  it('判据 4：两条路由各拒四种越权形态（非回环 / 非 POST / 非 json / 超长体）', async () => {
    const routes = routesOf(routeDir)
    for (const path of [CONFIRM_PATH, IGNORE_PATH]) {
      const handler = handlerOf(routes, path)
      let res = fakeRes()
      await handler(fakeReq({ remote: '10.0.0.7' }), res)
      assert.equal(res.out.status, 403, path + ' 必须拒绝非回环来源')

      res = fakeRes()
      await handler(fakeReq({ method: 'GET' }), res)
      assert.equal(res.out.status, 405, path + ' 只认 POST')

      res = fakeRes()
      await handler(fakeReq({ type: 'text/plain' }), res)
      assert.equal(res.out.status, 415, path + ' 只认 application/json')

      // 上限 4096 字节；超限要 400，不能被静默截断后当成合法请求。
      res = fakeRes()
      await handler(fakeReq({ body: '{"atom_id":' + '1'.repeat(5000) + '}' }), res)
      assert.equal(res.out.status, 400, path + ' 必须拒绝超长请求体')
      assert.equal(res.out.body.error, 'bad-body')
    }
  })

  it('判据 4：重复调用幂等，不存在的 id 报 404', async () => {
    const first = seedFlagged(routeDir)
    const second = seedFlagged(routeDir)
    const routes = routesOf(routeDir)
    const confirm = handlerOf(routes, CONFIRM_PATH)
    const ignore = handlerOf(routes, IGNORE_PATH)

    let res = fakeRes()
    await confirm(fakeReq({ body: JSON.stringify({ atom_id: first }) }), res)
    assert.equal(res.out.body.changed, true)
    res = fakeRes()
    await confirm(fakeReq({ body: JSON.stringify({ atom_id: first }) }), res)
    assert.equal(res.out.status, 200, '重复确认不是错误')
    assert.equal(res.out.body.changed, false, '第二次不该再改库')
    assert.equal(res.out.body.confirmedCount, 1, '清单里不该出现重复项')

    res = fakeRes()
    await ignore(fakeReq({ body: JSON.stringify({ atom_id: second }) }), res)
    assert.equal(res.out.body.changed, true)
    res = fakeRes()
    await ignore(fakeReq({ body: JSON.stringify({ atom_id: second }) }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.changed, false)
    closeRuntime()
    flushLog()
    const ignored = logEvents(routeDir).filter((e) => e === 'split.ignored')
    assert.equal(ignored.length, 1, '幂等的第二次忽略不该再写一条日志')
    const confirms = logEvents(routeDir).filter((e) => e === 'split.confirmed')
    assert.equal(confirms.length, 1, '幂等的第二次确认不该再写一条日志')

    res = fakeRes()
    await confirm(fakeReq({ body: JSON.stringify({ atom_id: 999999 }) }), res)
    assert.equal(res.out.status, 404, '界面要能区分「改了」与「本来就不在」')
  })

  it('判据 4：确认清单到上限后挤掉最旧的，并留一条只带条数的淘汰日志', () => {
    // 不走路由：这里验的是「清单满了会怎样」，路由形态已由上面四条用例覆盖。
    // 但必须起一次 runtime —— 日志目录是它在启动时配置的（state.ts 的 getRuntime），
    // 不配日志的话 confirmSplit 里的 log.info 一律被丢弃，用例会静默变成空断言。
    const rt = getRuntime(cfgOf(routeDir))
    const ids = []
    for (let i = 0; i < SPLIT_CONFIRMED_MAX + 1; i++) ids.push(seedFlagged(routeDir))
    for (const id of ids) assert.equal(confirmSplit(rt.db, id)?.changed, true)
    const left = readConfirmedSplits(rt.db)
    assert.equal(left.length, SPLIT_CONFIRMED_MAX, '清单不得超过上限')
    assert.ok(!left.includes(ids[0]), '最早确认的那条被挤出去（淘汰方向选最早）')
    assert.ok(left.includes(ids[ids.length - 1]), '最新确认的还在')
    flushLog()
    const events = logEvents(routeDir)
    assert.equal(
      events.filter((e) => e === 'split.confirmed').length,
      SPLIT_CONFIRMED_MAX + 1,
      '每条确认各留一条日志 —— 包括后来被挤掉的那条，这正是队列状态回答不了的',
    )
    assert.equal(events.filter((e) => e === 'split.evicted').length, 1, '挤掉一条就记一条')
    const logDb = new DatabaseSync(logFilePath(routeDir), { readOnly: true })
    try {
      const row = logDb.prepare("SELECT detail FROM log WHERE event = 'split.evicted'").get()
      assert.deepEqual(Object.keys(JSON.parse(String(row.detail))), ['evicted'], '只带条数，不带 id')
    } finally {
      logDb.close()
    }
  })

  it('判据 5：删掉记忆时它的队列行跟着消失（外键 ON DELETE CASCADE）', () => {
    const rt = getRuntime(cfgOf(routeDir))
    const id = seedFlagged(routeDir)
    upsertSegments(rt.db, id, 2)
    const count = (atomId) =>
      Number(rt.db.prepare('SELECT COUNT(*) AS n FROM split_queue WHERE atom_id = ?').get(atomId).n)
    assert.equal(count(id), 1, '先得有一行才谈得上消失')

    // 外键真的开着：指向不存在记忆的行必须被拒。
    assert.throws(
      () =>
        rt.db
          .prepare('INSERT INTO split_queue (atom_id, segments, confirmed, added_at) VALUES (?, 2, 0, ?)')
          .run(900000 + id, Date.now()),
      /FOREIGN KEY/i,
    )

    rt.db.prepare('DELETE FROM atom WHERE id = ?').run(id)
    assert.equal(count(id), 0, '记忆没了，队列行不能留着指向不存在的 id')
  })
})

// ─────────────────────────── 界面入口（源码级） ───────────────────────────

describe('T29：界面上的两个动作', () => {
  /**
   * 浏览器半是手写的发布产物（不参与 tsc、不 import 宿主半），所以这里的检查是**源码级**的：
   * 路径与位值两侧各写一遍，写错不会有任何编译错误。与 log.test.mjs 的界面用例同一条理由。
   */
  it('候选行给出两个动作，路径与位值与宿主半一致', () => {
    const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    assert.ok(client.includes("'/api/lattice-split-confirm'"), '确认要打到写路由')
    assert.ok(client.includes("'/api/lattice-split-ignore'"), '忽略要打到写路由')
    assert.ok(client.includes('确认要拆'), '按钮上要写清动作')
    assert.ok(client.includes('忽略'), '按钮上要写清动作')
    assert.ok(client.includes('const FLAG_SPLIT_PENDING = 1'), '位值必须与 FLAG_SPLIT_PENDING 一致')
    assert.ok(client.includes("parts.push('待拆分')"), '候选行要标出这一位')
  })
})

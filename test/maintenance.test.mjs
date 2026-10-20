// T47 判据 6（栅栏与 confirm）与 T50 四条判据的用例。
//
// **这一组完全不碰全局状态**（既不调 `apply`，也不 `configureLog`）。日志与 runtime 都是
// 进程级单例，本组一旦配置它们，`log.test.mjs` 的用例就会读不到自己刚写的日志 —— 实测过两次：
// 先是 `apply` 带进了 `configureLog`，后是本组的 `configureLog(dir)` 自己。
// 所以这里只测不需要全局状态的东西：内核函数的行为、纯函数、源码级的形状。
// 栅栏的四种拒绝形态由 split-pending.test.mjs 对同形写路由的用例覆盖 —— 用的是同一个
// `guardWrite`；这一组补的是「新路由确实调了它」这条源码级事实。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { clearLearned } from '../dist/pipeline/entries.js'
import { sanitizeEvent } from '../dist/log/policy.js'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-maint-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 造 n 条带 learned 入口的 atom（手写 SQL：这里量的是清空，不是写入管线）。 */
function seedLearned(db, n) {
  const now = Date.now()
  const insAtom = db.prepare(
    "INSERT INTO atom(kind, text, summary, embedding, topic_id, fit, scope, created_at, updated_at) VALUES ('结论', ?, ?, ?, NULL, 1, 'global', ?, ?)",
  )
  const insEntry = db.prepare(
    "INSERT INTO entry(atom_id, term, bigram, weight, origin, created_at) VALUES (?, ?, ?, 0.3, 'learned', ?)",
  )
  const zero = new Uint8Array(512 * 4)
  for (let i = 0; i < n; i++) {
    const id = Number(insAtom.run('第 ' + i + ' 条', '第 ' + i + ' 条', zero, now, now).lastInsertRowid)
    insEntry.run(id, '学到' + i, '学到' + i, now)
  }
}

function entryOrigins(db) {
  const out = {}
  for (const r of db.prepare('SELECT origin, COUNT(*) AS n FROM entry GROUP BY origin').all()) {
    out[String(r.origin)] = Number(r.n)
  }
  return out
}

describe('T50 判据 1：只删 learned', () => {
  it('清空之后只有 learned 消失，atom 与其它来源的入口一条不少', () => {
    const { db } = openVault(join(dir, 'lattice.db'))
    seedLearned(db, 3)
    const now = Date.now()
    const id = Number(db.prepare('SELECT id FROM atom LIMIT 1').get().id)
    db.prepare(
      "INSERT INTO entry(atom_id, term, bigram, weight, origin, created_at) VALUES (?, '声明', '声明', 1, 'declared', ?)",
    ).run(id, now)
    db.prepare(
      "INSERT INTO entry(atom_id, term, bigram, weight, origin, created_at) VALUES (?, '抽取', '抽取', 1, 'extracted', ?)",
    ).run(id, now)
    const atomsBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n)
    const before = entryOrigins(db)

    assert.equal(clearLearned(db), 3, '返回的条数必须等于实际删掉的条数')
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n),
      atomsBefore,
      '清空入口不得删记忆',
    )
    const after = entryOrigins(db)
    assert.equal(after.learned, undefined, 'learned 一条不剩')
    assert.equal(after.declared, before.declared, '声明入口不受影响')
    assert.equal(after.extracted, before.extracted, '抽取入口不受影响')
    db.close()
  })
})

describe('T50 判据 2：零条也留痕', () => {
  it('没有 learned 时返回 0、不报错；内核函数自己写一条留痕日志', () => {
    const { db } = openVault(join(dir, 'lattice.db'))
    assert.equal(clearLearned(db), 0, '零条是有效结果，不是错误')
    db.close()
    // 日志真的落库这一步不在这里测：配日志库就是抢全局单例（见文件头）。改为三条合起来：
    // 内核函数确实写了、事件在闭集里、detail 的形状合法（零也是合法值）。
    // 「白名单内的事件能落库」由 log.test.mjs 的通用用例覆盖。
    const src = readFileSync(new URL('../src/pipeline/entries.ts', import.meta.url), 'utf8')
    assert.ok(src.includes("log.info('entry.cleared', { cleared })"), '内核函数必须自己留痕，不靠调用方')
    const sanitized = sanitizeEvent('info', 'entry.cleared', { cleared: 0 })
    assert.ok(sanitized !== null, 'entry.cleared 必须在白名单里，且 info 级收')
    assert.equal(sanitized.event, 'entry.cleared')
    assert.equal(JSON.parse(String(sanitized.detail)).cleared, 0, '零条也是合法 detail')
  })
})
describe('T47 判据 6 与 T50 判据 3：栅栏与 confirm（源码级）', () => {
  it('两条整理路由与清空路由都走 guardWrite，且都有 confirm 分支', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const recluster = /async function reclusterRoute\(([\s\S]*?)\n}/.exec(src)
    assert.ok(recluster !== null, '找不到 reclusterRoute')
    assert.ok(recluster[1].includes('guardWrite(req, res)'), '整理路由必须走写栅栏')
    assert.ok(recluster[1].includes('confirm !== true'), '整理路由必须有 confirm 分支')
    assert.ok(recluster[1].includes("'running'"), '执行中取消要被单独识别出来')

    const clear = /async function learnedClearRoute\(([\s\S]*?)\n}/.exec(src)
    assert.ok(clear !== null, '找不到 learnedClearRoute')
    assert.ok(clear[1].includes('guardWrite(req, res)'), '清空路由必须走写栅栏')
    assert.ok(clear[1].includes('confirm !== true'), '清空路由必须有 confirm 分支')
    assert.ok(clear[1].includes('clearLearned('), '清空路由调的是那个内核函数')
  })
})

describe('界面一侧（源码级）：按钮带条数、两步确认、四态文案', () => {
  it('三个 URL 常量与宿主半同值，且文案含四态与两步确认的形状', () => {
    const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    assert.ok(client.includes("'/api/lattice-recluster-plan'"), '规划路由路径两侧同值')
    assert.ok(client.includes("'/api/lattice-recluster-cancel'"), '取消路由路径两侧同值')
    assert.ok(client.includes("'/api/lattice-learned-clear'"), '清空路由路径两侧同值')
    for (const word of ['未规划', '已规划', '正在整理', '失败可重试']) {
      assert.ok(client.includes(word), '四态文案缺：' + word)
    }
    assert.ok(client.includes("'清空学到的入口（'"), '清空按钮上要写条数')
    assert.ok(client.includes("'确认清空 '"), '第二步的按钮要写成「确认清空 N 条」')
    assert.ok(client.includes("'确认整理'"), '整理也要两步确认')
    assert.ok(client.includes('setPending('), '两步确认要有一个待确认状态')
    // 只有按钮没有说明，人不知道这两个词在动什么 —— 两块各要一行。
    assert.ok(client.includes('RECLUSTER_HELP'), '整理要有说明')
    assert.ok(client.includes('LEARNED_HELP'), '清空要有说明')
    assert.ok(client.includes("'学到的入口 · '"), '清空那一组要有自己的标题与条数')
    for (const phrase of ['只改归属', '不删数据', '重新长出来']) {
      assert.ok(client.includes(phrase), '说明里要写清后果：' + phrase)
    }
  })

  /**
   * 整理是异步的（规划后挂一次性延迟），而界面不主动刷新 —— 不轮询的话点了确认之后
   * 会停在「已规划」不动，直到手动点刷新，而那时它早跑完了。实测过：库里的状态已经正确
   * 清空，界面却还停着。所以那两个过渡态里必须有轮询，且必须只在它们里面。
   */
  it('只在这两个过渡态里轮询，且有次数上限', () => {
    const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const panel = /function MaintenancePanel\(([\s\S]*?)\n    }/.exec(client)
    assert.ok(panel !== null, '找不到 MaintenancePanel')
    assert.ok(panel[1].includes("phase !== 'planned'"), '已规划时必须轮询')
    assert.ok(panel[1].includes("phase !== 'running'"), '正在整理时必须轮询')
    assert.ok(panel[1].includes('setInterval('), '轮询用 setInterval')
    assert.ok(panel[1].includes('clearInterval('), '卸载与到达上限时要停')
    assert.ok(panel[1].includes('RECLUSTER_POLL_LIMIT'), '轮询必须有次数上限')
    assert.ok(client.includes('const RECLUSTER_POLL_LIMIT = 90'), '上限是 90 次')
    assert.ok(client.includes('const RECLUSTER_POLL_MS = 1000'), '间隔是 1 秒')
  })
})

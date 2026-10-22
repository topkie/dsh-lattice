// W1 第 2 步：结构与取代语义。
//
// 这一组只验本次改动新定的三件事：
//   1. 新建库的 atom 表有 superseded_at，且 calib_state 表已删除（meta 有意保留）；
//   2. 取代只写 superseded_by 与 superseded_at，不动 updated_at；
//   3. 取消取代把两列一起清回 NULL。
//
// 为什么单独一个文件：这三条守的是列与写入路径的约定。test/supersede.test.mjs 验的是
// 「被取代的条目不再当答案出现」，它的夹具直接写 SQL、绕开工具层，守不住第 2 条。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { apply } from '../dist/index.js'
import { closeRuntime, getRuntime } from '../dist/state.js'
import { resetEncoder } from '../dist/encoder/index.js'

let dir = ''
let tools = []

/** 最小假 ctx：只实现插件用到的那一个服务。 */
function fakeCtx() {
  const registered = []
  return {
    registered,
    get: (k) => (k === 'tools' ? { register: (t) => registered.push(t) } : undefined),
    effect: (fn) => fn(),
    inject: () => {},
  }
}

function cfg() {
  return {
    enabled: true,
    dataDir: dir,
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

function tool(name) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error('工具未注册: ' + name)
  return t
}

/** 从写入回执里取 atom id。 */
function atomIdOf(receipt) {
  const m = /已写入记忆 #(\d+)/.exec(receipt)
  if (!m) throw new Error('回执里没有 atom id：' + receipt)
  return Number(m[1])
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('W1 结构改动', () => {
  beforeEach(() => {
    resetEncoder()
    closeRuntime()
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-schema-w1-'))
    const ctx = fakeCtx()
    apply(ctx, cfg())
    tools = ctx.registered
  })

  afterEach(() => {
    closeRuntime()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不阻断 */
    }
  })

  describe('W1 结构：列与表', () => {
    it('新建库的 atom 表有 superseded_at，且没有 calib_state 表', () => {
      // 传 cfg：apply() 只注册工具，库要到第一次用到时才建，这里正是要用它。
      const db = getRuntime(cfg()).db
      const cols = db
        .prepare('PRAGMA table_info(atom)')
        .all()
        .map((c) => c.name)
      assert.ok(cols.includes('superseded_at'), 'atom 缺 superseded_at；实际列：' + cols.join(','))
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name)
      assert.ok(!tables.includes('calib_state'), 'calib_state 应已删除；实际表：' + tables.join(','))
      // meta 是外部标定包的快照位，本插件不写它，但删它会让标定包的写入抛错 —— 有意保留。
      assert.ok(tables.includes('meta'), 'meta 要保留（外部标定包写快照用）；实际表：' + tables.join(','))
    })
  })

  describe('W1 取代语义：只改关系，不改内容', () => {
    it('取代后 updated_at 不变、superseded_at 有值', async () => {
      const a = atomIdOf(
        await tool('lattice_write').execute({ text: '系统代理必须走本地端口，否则境外源超时。' }),
      )
      const before = getRuntime({}).db.prepare('SELECT updated_at FROM atom WHERE id = ?').get(a).updated_at
      // 跨过一毫秒，否则「updated_at 被重写」与「没被重写」观察到同一个值，这条就测不出东西。
      await sleep(10)
      const b = atomIdOf(
        await tool('lattice_write').execute({
          text: '代理端口改成了 7890，旧说法作废。',
          supersedes: a,
        }),
      )
      const row = getRuntime({})
        .db.prepare('SELECT superseded_by, superseded_at, updated_at FROM atom WHERE id = ?')
        .get(a)
      assert.equal(Number(row.superseded_by), b, 'superseded_by 应指向取代者')
      assert.ok(row.superseded_at !== null && row.superseded_at !== undefined, 'superseded_at 应有值')
      assert.equal(row.updated_at, before, '取代不该动 updated_at')
    })

    it('取消取代后 superseded_at 回到 NULL，updated_at 仍不变', async () => {
      const a = atomIdOf(
        await tool('lattice_write').execute({ text: '系统代理必须走本地端口，否则境外源超时。' }),
      )
      const before = getRuntime({}).db.prepare('SELECT updated_at FROM atom WHERE id = ?').get(a).updated_at
      await sleep(10)
      await tool('lattice_write').execute({ text: '代理端口改成了 7890，旧说法作废。', supersedes: a })
      await tool('lattice_write').execute({
        text: '上一段作废，端口回到 7890 是错的，改用 8080。',
        unsupersede: a,
      })
      const row = getRuntime({})
        .db.prepare('SELECT superseded_by, superseded_at, updated_at FROM atom WHERE id = ?')
        .get(a)
      assert.equal(row.superseded_by, null, 'superseded_by 应清回 NULL')
      assert.equal(row.superseded_at, null, 'superseded_at 应清回 NULL')
      assert.equal(row.updated_at, before, '取消取代也不该动 updated_at')
    })
  })
})

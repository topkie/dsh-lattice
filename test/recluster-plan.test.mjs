// 整理入口的用例：规划、取消、四态、一次性执行、一起回滚。
//
// 判据编号与 `4.4` 的「整理入口的判据」一一对应（第 6 条是栅栏，另有用例文件覆盖同形写法）。
//
// **这一组不加载真实模型**：向量是手写的（沿不同维度），够 runRecluster 分出簇即可。
// 判据要的是状态与行数，与向量质量无关。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { encodeVec } from '../dist/util/vec.js'
import { runRecluster } from '../dist/cluster/index.js'
import {
  cancelRecluster,
  clearPlanTimer,
  executePlannedRecluster,
  isExecuting,
  planRecluster,
  readReclusterState,
  resumeIfPending,
} from '../dist/cluster/executor.js'
import { readReclusterTimes, setReclusterPlanned, setReclusterStarted } from '../dist/db/recluster-state.js'

let dbFile = ''

beforeEach(() => {
  dbFile = join(
    tmpdir(),
    'dsh-lattice-plan-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db',
  )
})

afterEach(() => {
  clearPlanTimer()
  for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true })
})

/** 造 n 条互不相同的 atom（向量沿第 i 维），每条自带一个单成员 topic。 */
function seed(db, n) {
  const now = Date.now()
  const insTopic = db.prepare(
    'INSERT INTO topic(domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at) VALUES (NULL, ?, ?, 1, 0, ?, ?)',
  )
  const insAtom = db.prepare(
    "INSERT INTO atom(kind, text, summary, embedding, topic_id, fit, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'global', ?, ?)",
  )
  const attach = db.prepare(
    "INSERT INTO atom_topic(atom_id, topic_id, weight, origin) VALUES (?, ?, 1, 'primary')",
  )
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(512)
    v[i % 512] = 1
    const blob = encodeVec(v)
    const t = Number(insTopic.run('主题' + i, blob, now, now).lastInsertRowid)
    const a = Number(
      insAtom.run('结论', '第 ' + i + ' 条记忆', '第 ' + i + ' 条', blob, t, now, now).lastInsertRowid,
    )
    attach.run(a, t)
  }
}

/** 库的可比快照：行数 + 每行主题向量（按 id 排序拼接，顺序稳定）。 */
function snapshot(db) {
  const n = (sql) => Number(db.prepare(sql).get().n)
  return {
    atoms: n('SELECT COUNT(*) AS n FROM atom'),
    topics: n('SELECT COUNT(*) AS n FROM topic'),
    pairs: n('SELECT COUNT(*) AS n FROM atom_pair'),
    entries: n('SELECT COUNT(*) AS n FROM entry'),
    vecs: db
      .prepare("SELECT group_concat(hex(sum_vec), '|') AS s FROM (SELECT sum_vec FROM topic ORDER BY id)")
      .get().s,
  }
}

describe('整理入口判据 1：规划不改数据', () => {
  it('规划只写状态行：记忆 / 主题 / atom_pair / 入口的行数与主题向量都不动', () => {
    const { db } = openVault(dbFile)
    seed(db, 6)
    const before = snapshot(db)
    const state = planRecluster(db, () => {}, 60_000)
    assert.equal(state.phase, 'planned')
    assert.deepEqual(snapshot(db), before, '规划不得改任何数据行')
    assert.notEqual(readReclusterTimes(db).plannedAt, null, 'planned 要落库')
    clearPlanTimer()
    db.close()
  })
})

describe('整理入口判据 2：四态可区分', () => {
  it('idle / planned / running / failed 各报一个值', async () => {
    const { db } = openVault(dbFile)
    seed(db, 6)
    assert.equal(readReclusterState(db).phase, 'idle')

    planRecluster(db, () => {}, 60_000)
    assert.equal(readReclusterState(db).phase, 'planned')
    clearPlanTimer()

    // failed：planned 与 started 同时有值，但进程里没在跑 —— 那就是上次没跑完。
    setReclusterStarted(db, Date.now())
    assert.equal(readReclusterState(db).phase, 'failed')

    // running：执行器在开跑前让出一次事件循环，这一刻可以观测到。
    cancelRecluster(db)
    planRecluster(db, () => {}, 60_000)
    clearPlanTimer()
    const pending = executePlannedRecluster(db)
    assert.equal(readReclusterState(db).phase, 'running')
    assert.equal(isExecuting(), true)
    const outcome = await pending
    assert.equal(outcome.ok, true)
    assert.equal(readReclusterState(db).phase, 'idle')
    db.close()
  })
})

describe('整理入口判据 3：取消幂等，执行中拒收', () => {
  it('没计划时取消不报错；有计划时清干净；再取消幂等；执行中回拒', async () => {
    const { db } = openVault(dbFile)
    seed(db, 6)
    const none = cancelRecluster(db)
    assert.equal(none.ok, false)
    assert.equal(none.reason, 'not-planned')

    planRecluster(db, () => {}, 60_000)
    const first = cancelRecluster(db)
    assert.equal(first.ok, true)
    assert.equal(readReclusterTimes(db).plannedAt, null, '取消要删 planned')

    const again = cancelRecluster(db)
    assert.equal(again.ok, false, '重复取消不是错误')
    assert.equal(again.reason, 'not-planned')

    planRecluster(db, () => {}, 60_000)
    clearPlanTimer()
    const pending = executePlannedRecluster(db)
    const rejected = cancelRecluster(db)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.reason, 'running', '执行中一律拒绝')
    assert.equal(readReclusterTimes(db).startedAt !== null, true, '状态一个字不动')
    await pending
    db.close()
  })
})

describe('整理入口判据 4：延迟只跑一次', () => {
  it('到点跑一次；跑完计划与开始痕迹都清掉，状态回 idle', async () => {
    const { db } = openVault(dbFile)
    seed(db, 6)
    let runs = 0
    planRecluster(
      db,
      () => {
        runs++
        void executePlannedRecluster(db)
      },
      10,
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(runs, 1, '延迟只能触发一次')
    const times = readReclusterTimes(db)
    assert.equal(times.plannedAt, null)
    assert.equal(times.startedAt, null)
    assert.notEqual(times.completedAt, null, '成功一次要留下时间戳')
    assert.equal(readReclusterState(db).phase, 'idle')
    db.close()
  })

  it('启动补跑：有计划就再跑一遍；没计划什么也不做', async () => {
    const { db } = openVault(dbFile)
    seed(db, 6)
    const skipped = await resumeIfPending(db)
    assert.equal(skipped.skipped, true, '没有计划时不该跑')

    // 模拟「规划过、进程被杀」：只留 planned，没有 started。
    setReclusterPlanned(db, Date.now())
    const resumed = await resumeIfPending(db)
    assert.equal(resumed.ok, true)
    assert.equal(resumed.skipped, false)
    assert.equal(readReclusterState(db).phase, 'idle')
    db.close()
  })
})

describe('整理入口判据 5：一起回滚', () => {
  it('提交前抛错，主题表与 atom_pair 都回到调用前', async () => {
    const { db } = openVault(dbFile)
    seed(db, 8)
    // 先跑一次，让两个表都有可对比的内容。
    await runRecluster(db)
    const before = snapshot(db)
    assert.ok(before.pairs >= 0)

    await assert.rejects(
      runRecluster(db, {
        onCommit: () => {
          throw new Error('injected-failure')
        },
      }),
      /injected-failure/,
    )
    assert.deepEqual(snapshot(db), before, '事务里抛错之后，两处都必须回到调用前')
    db.close()
  })
})

// 写入路径的时间戳与事务边界。
//
// 四条各自守一件事：
//   1. 一条记忆的创建时间与更新时间取自同一次时钟读取；
//   2. 编码失败不阻断写入，向量退化为零向量，且编码发生在事务之外；
//   3. 提交之后的维护查询失败，不影响已经落库的记忆；
//   4. 并发写入不交错事务 —— 事务段里让出事件循环，第二条写入会踩进第一段。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { closeRuntime } from '../dist/state.js'
import { openVault } from '../dist/db/open.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { VEC_DIM, decodeVec } from '../dist/util/vec.js'

/** 记录事务语句的库代理：事务边界只能从 exec 上看出来。 */
function recordingDb(db) {
  const execs = []
  const proxy = new Proxy(db, {
    get(t, p) {
      if (p === 'exec') {
        return (sql) => {
          execs.push(String(sql).trim().toUpperCase())
          return t.exec(sql)
        }
      }
      const v = t[p]
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  return { db: proxy, execs }
}

/**
 * 让含某段 SQL 的 prepare 抛错的库代理：模拟提交之后的维护查询失败。
 *
 * onFail 每次注入命中时调一次，用来证明「注入真的被问到过」以及「问的时机在哪儿」。
 */
function failingPrepare(db, fragment, onFail) {
  return new Proxy(db, {
    get(t, p) {
      if (p === 'prepare') {
        return (sql) => {
          if (String(sql).includes(fragment)) {
            if (onFail !== undefined) onFail(String(sql))
            throw new Error('注入：维护查询失败')
          }
          return t.prepare(sql)
        }
      }
      const v = t[p]
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}

let dir = ''
let db = null

describe('写入路径：时间戳与事务边界', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-w1-id-tx-'))
    db = openVault(join(dir, 'lattice.db')).db
  })

  afterEach(() => {
    closeRuntime()
    try {
      db?.close()
    } catch {
      /* 已关闭 */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('创建时间与更新时间取自同一次时钟读取', async () => {
    const ctx = createWriteCtx(db)
    const r = await writeAtom(ctx, { text: '同一时刻的时间戳：写入只读一次时钟，两列必须相等。' })
    const row = db.prepare('SELECT created_at, updated_at FROM atom WHERE id = ?').get(r.atomId)
    assert.equal(Number(row.created_at), Number(row.updated_at))
  })

  it('编码失败不阻断写入，向量退化为零向量，且编码在事务之外', async () => {
    const { db: proxy, execs } = recordingDb(db)
    let calls = 0
    const ctx = createWriteCtx(
      proxy,
      {},
      {
        encode: async () => {
          calls += 1
          assert.ok(!execs.includes('BEGIN IMMEDIATE'), '编码必须在事务开始之前完成')
          throw new Error('注入：编码失败')
        },
      },
    )
    const r = await writeAtom(ctx, { text: '编码器失败时写入仍应成功，向量退化为零向量。' })
    assert.equal(calls, 1, '一条记忆只编码一次')
    const row = db.prepare('SELECT embedding FROM atom WHERE id = ?').get(r.atomId)
    const v = decodeVec(row.embedding)
    assert.equal(v.length, VEC_DIM)
    assert.ok(
      v.every((x) => x === 0),
      '编码失败应落零向量，而不是半截结果或上一条的向量',
    )
  })

  it('提交之后的维护查询失败不影响已落库的记忆', async () => {
    const { db: rec, execs } = recordingDb(db)
    // 每次注入命中都记下「当时 COMMIT 是否已经执行过」。
    const fails = []
    const proxy = failingPrepare(rec, 'SELECT AVG(fit) AS f FROM atom WHERE topic_id', () =>
      fails.push(execs.includes('COMMIT')),
    )
    const ctx = createWriteCtx(proxy)
    const r = await writeAtom(ctx, { text: '维护查询失败时，这条记忆仍应留在库里。' })
    // 少一条就等于这条用例从没走到失败分支上，测的是正常路径。
    assert.deepEqual(fails, [true], '注入必须命中一次，且命中时 COMMIT 已经执行过')
    const row = db.prepare('SELECT text FROM atom WHERE id = ?').get(r.atomId)
    assert.ok(row, '维护查询在提交之后，失败不该把已提交的行带走')
    assert.equal(String(row.text), '维护查询失败时，这条记忆仍应留在库里。')
  })

  it('并发写入不交错事务', async () => {
    const { db: proxy, execs } = recordingDb(db)
    const ctx = createWriteCtx(proxy)
    await Promise.all([
      writeAtom(ctx, { text: '并发写入的第一条：事务段必须整段完成再让出事件循环。' }),
      writeAtom(ctx, { text: '并发写入的第二条：事务段必须整段完成再让出事件循环。' }),
    ])
    const tx = execs.filter((s) => s === 'BEGIN IMMEDIATE' || s === 'COMMIT')
    assert.ok(tx.length >= 2, '一次写入至少要开一个事务')
    // 只断言「不嵌套」而不是固定序列：写入尾部的维护（补推断边、更新统计）
    // 也各开事务，条数会随实现变化，但「事务不能叠在一起」这条不能变。
    let open = false
    for (const s of tx) {
      if (s === 'BEGIN IMMEDIATE') {
        assert.ok(!open, '事务不能嵌套：出现了两个 BEGIN 之间没有 COMMIT')
        open = true
      } else {
        assert.ok(open, 'COMMIT 必须在 BEGIN 之后')
        open = false
      }
    }
    assert.equal(open, false, '最后一次事务必须已提交')
  })
})

// 取消取代：lattice_write 的 unsupersede 只清「被取代」标记。
//
// 判据对应：
//   1. 对被取代的 id 传 unsupersede → superseded_by 变 NULL，回执说「已取消」；
//   2. 取消之后用原文召回，它重新出现（取消前被压掉）；
//   3. 对本来没有取代关系的 id 传 unsupersede → 回执说明「本来就没有被取代」，不报错、不改行；
//   4. 库里已有的 supersedes 关系行不受影响；
//   5. 工具描述里查得到 unsupersede 与 supersedes 的区别。
// 另外两条：两个参数同时给时拒绝且不写库；id 不在库里时如实说明。
//
// 走真实工具入口（apply + 独立临时目录）：判据 1/3/5 验的是「调用方看见了什么」，
// 判据 2/4 验的是落库与召回的联动。隔离纪律同 declared-edges.test.mjs：每个用例自建目录。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { apply } from '../dist/index.js'
import { resetEncoder } from '../dist/encoder/index.js'
import { closeRuntime, getRuntime } from '../dist/state.js'

/** 每个用例一份独立目录：库文件与日志都落在里面，结束时整个删掉。 */
function tmpDir(tag) {
  return mkdtempSync(join(tmpdir(), 'dsh-lattice-unsupersede-' + tag + '-'))
}

/** 起一套真实工具 + 独立数据目录；无论成败都关运行时并删目录。 */
async function withTools(tag, fn) {
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
    topN: 24,
    mmapSize: 0,
    cacheSize: 0,
    busyTimeout: 0,
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

/** 从写入回执里取 atom id（回执第一处 #N 就是它）。 */
function atomIdOf(receipt) {
  const m = /已写入记忆 #(\d+)/.exec(receipt)
  assert.ok(m !== null, '回执里没有 atom id：' + receipt)
  return Number(m[1])
}

/** 读一行的取代列与更新时间：判据 3 要证明「一个字节都没动」。 */
function rowOf(db, id) {
  return db.prepare('SELECT superseded_by AS s, updated_at AS u FROM atom WHERE id = ?').get(id)
}

describe('判据 1/3：unsupersede 只清标记，三种结果分开说', () => {
  it('取消取代：superseded_by 变 NULL，回执说「已取消」', async () => {
    await withTools('c1', async ({ cfg, tool }) => {
      const w = tool('lattice_write')
      const a = atomIdOf(await w.execute({ text: '端口用 8080，别改成别的，这是本机的固定配置。' }))
      const b = atomIdOf(
        await w.execute({ text: '端口改用 9090，旧的 8080 作废，迁移时注意。', supersedes: a }),
      )
      const db = getRuntime(cfg).db
      assert.equal(Number(rowOf(db, a).s), b, '前置：a 应当已被 b 取代')

      const receipt = await w.execute({
        text: '撤销上一条改口：端口仍用 8080，本机配置没变过。',
        unsupersede: a,
      })
      assert.match(
        receipt,
        new RegExp('已取消 #' + a + ' 的被取代标记'),
        '回执要说清取消了哪一条：' + receipt,
      )
      assert.ok(receipt.includes('#' + b), '回执要指出谁不再取代它：' + receipt)
      assert.equal(rowOf(db, a).s, null, 'superseded_by 应当被清空')
      // 只清标记：两条记忆都还在，一个字节都没删。
      assert.ok(rowOf(db, a) !== undefined && rowOf(db, b) !== undefined, '两条记忆都必须还在')
    })
  })

  it('本来就没有被取代：如实说明，不报错、不改行', async () => {
    await withTools('c3', async ({ cfg, tool }) => {
      const w = tool('lattice_write')
      const a = atomIdOf(await w.execute({ text: '缓存击穿是热点 key 同时失效导致的，和雪崩不同。' }))
      const db = getRuntime(cfg).db
      const before = rowOf(db, a)

      const receipt = await w.execute({ text: '顺便记一句：这条记忆没有改过口，保持原样。', unsupersede: a })
      assert.match(receipt, new RegExp('#' + a + ' 本来就没有被取代'), '回执要说清原因：' + receipt)
      assert.ok(!receipt.includes('未改动任何东西'), '这不是「不存在」，不能混成一句话：' + receipt)
      assert.deepEqual(rowOf(db, a), before, '没有取代关系时一个字节都不该动（含 updated_at）')
    })
  })

  it('id 不在库里：说明找不到，不报错不改行', async () => {
    await withTools('c1b', async ({ cfg, tool }) => {
      const w = tool('lattice_write')
      const a = atomIdOf(await w.execute({ text: '端口用 8080，本机的固定配置，别随便改。' }))
      const db = getRuntime(cfg).db
      const before = rowOf(db, a)
      const receipt = await w.execute({
        text: '撤销一条不存在的改口：那条记录我在库里找不到。',
        unsupersede: 987654321,
      })
      assert.match(receipt, /不存在/, '要说清 id 不存在：' + receipt)
      assert.deepEqual(rowOf(db, a), before, '不该动别的行')
    })
  })

  it('两个参数同时给：拒绝，且这次不写库', async () => {
    await withTools('c1c', async ({ cfg, tool }) => {
      const w = tool('lattice_write')
      const a = atomIdOf(await w.execute({ text: '端口用 8080，本机的固定配置，别随便改。' }))
      const db = getRuntime(cfg).db
      const n0 = Number(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n)
      const receipt = await w.execute({
        text: '这条不该落库：两个参数同时给了，应当整次拒绝。',
        supersedes: a,
        unsupersede: a,
      })
      assert.match(receipt, /^写入失败/, '应当直接拒绝：' + receipt)
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n), n0, '拒绝时不许写')
      assert.equal(rowOf(db, a).s, null, '被拒绝时不许顺手改取代标记')
    })
  })
})

describe('判据 2：取消之后召回重新出现', () => {
  it('取消前压掉旧条，取消后两条都在', async () => {
    await withTools('c2', async ({ tool }) => {
      const w = tool('lattice_write')
      const a = atomIdOf(await w.execute({ text: '端口用 8080，别改成别的，这是本机的固定配置。' }))
      atomIdOf(await w.execute({ text: '端口改用 9090，旧的 8080 作废，迁移时注意。', supersedes: a }))

      const before = await tool('lattice_recall').execute({ query: '端口' })
      assert.ok(before.includes('端口改用 9090'), '前置：新条要能被召回到：' + before)
      assert.ok(!before.includes('端口用 8080'), '取消前旧条应当被压掉：' + before)
      // 压制要留下痕迹：否则「没出现」可能只是这次没命中，判据 2 就白测了。
      assert.ok(before.includes('已被取代'), '压制应当有「另有 N 条已被取代」的说明：' + before)

      await w.execute({ text: '撤销上一条改口：端口仍用 8080，本机配置没变过。', unsupersede: a })
      const after = await tool('lattice_recall').execute({ query: '端口' })
      assert.ok(after.includes('端口用 8080'), '取消后被取代的条目要重新出现：' + after)
    })
  })
})

describe('判据 4：关系行不受影响', () => {
  it('库里已有的 supersedes 行原样保留', async () => {
    await withTools('c4', async ({ cfg, tool }) => {
      const w = tool('lattice_write')
      const a = atomIdOf(await w.execute({ text: '端口用 8080，本机的固定配置，别随便改。' }))
      atomIdOf(await w.execute({ text: '端口改用 9090，旧的 8080 作废，迁移时注意。', supersedes: a }))
      const db = getRuntime(cfg).db
      // 手工补一条关系行：edges 早已不收 supersedes，但库里可能有历史行，取消取代不该动它们。
      db.prepare(
        'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) ' +
          "VALUES ('atom', (SELECT MAX(id) FROM atom), 'atom', ?, 'supersedes', 1.0, 'declared', ?)",
      ).run(a, Date.now())
      const before = Number(db.prepare("SELECT COUNT(*) AS n FROM edge WHERE kind = 'supersedes'").get().n)
      assert.equal(before, 1)

      await w.execute({ text: '撤销上一条改口：端口仍用 8080，别改成别的。', unsupersede: a })
      const after = Number(db.prepare("SELECT COUNT(*) AS n FROM edge WHERE kind = 'supersedes'").get().n)
      assert.equal(after, 1, '取消取代只清标记，不许删关系行')
    })
  })
})

describe('判据 5：可发现性', () => {
  it('工具描述与参数描述都写明两者的区别', async () => {
    await withTools('c5', async ({ tool }) => {
      const t = tool('lattice_write')
      assert.ok(t.description.includes('unsupersede'), '工具描述要让读的人看见这个参数：' + t.description)
      assert.ok(t.description.includes('supersedes'), t.description)
      assert.ok(t.description.includes('作用相反'), '要写明两者方向相反：' + t.description)
      const spec = t.parameters.properties.unsupersede
      assert.ok(spec !== undefined, 'unsupersede 参数必须存在')
      assert.ok(spec.description.includes('取消'), spec.description)
      assert.ok(spec.description.includes('被取代'), spec.description)
      assert.equal(spec.type, 'number')
    })
  })
})

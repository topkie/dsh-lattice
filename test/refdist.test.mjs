// 参考分布：判「这次召回有没有内容」的那条线从哪来。
//
// 这里只测本模块的契约：有没有编码器、库够不够大、线太高时怎么报、缓存什么时候失效。
// 线的实际数值由三个语料的对照实验决定（设计期成果，记录不在本仓库），不在这里复算。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import {
  invalidateReference,
  quantile,
  REFERENCE_MAX_LINE,
  REFERENCE_MIN_ATOMS,
  REFERENCE_QUESTIONS,
  REFERENCE_QUANTILE,
  referenceFor,
} from '../dist/pipeline/refdist.js'
import { VEC_DIM } from '../dist/util/vec.js'

let dbFile = ''
let db = null

describe('refdist', () => {
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-refdist-' +
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

  /** 单热向量。分量 0 留给「参考问句」，所以 atom 用 1 以上的分量。 */
  function oneHot(i) {
    const v = new Float32Array(VEC_DIM)
    v[i % VEC_DIM] = 1
    return v
  }

  /** 由文本确定性挑一个分量：不同文本落在不同方向，与分量 0 正交。 */
  function hotOf(text) {
    let h = 0
    for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) >>> 0
    return 1 + (h % (VEC_DIM - 1))
  }

  /** 塞 n 条带向量的 atom，绕开写入侧的去重与落位判断。 */
  async function seedAtoms(n, vecOf) {
    let i = 0
    const ctx = createWriteCtx(db, {}, { encode: async (t) => vecOf(t, i) })
    for (i = 0; i < n; i++) {
      const tags = '编号 ' + i + ' 的记忆，内容与日常生活的问句无关。'
      await writeAtom(ctx, { text: tags })
    }
  }

  describe('参考分位：线的取法与失效条件', () => {
    it('问句集 48 条，分位取 0.9，失效线 0.65', () => {
      assert.equal(REFERENCE_QUESTIONS.length, 48)
      assert.equal(REFERENCE_MIN_ATOMS, 48)
      assert.equal(REFERENCE_QUANTILE, 0.9)
      assert.equal(REFERENCE_MAX_LINE, 0.65)
    })

    it('分位是线性插值：空数组给 NaN，单值原样返回，两点取中位', () => {
      assert.ok(Number.isNaN(quantile([], 0.9)))
      assert.equal(quantile([0.4], 0.9), 0.4)
      assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
      assert.equal(quantile([1, 2, 3, 4], 0), 1)
      assert.equal(quantile([1, 2, 3, 4], 1), 4)
    })
  })

  describe('参考分布：三种不可用的情形各自说清原因', () => {
    it('编码器不可用：usable false、reason no-encoder，且不缓存半截结果', async () => {
      await seedAtoms(REFERENCE_MIN_ATOMS, (t) => oneHot(hotOf(t)))
      const d = await referenceFor(db, async () => null)
      assert.equal(d.usable, false)
      assert.equal(d.reason, 'no-encoder')
      assert.equal(d.n, 0, '一条也没编出来时 n 必须是 0，不能假装算过')
    })

    it('库比问句集还小：判「库还小」而不是判内容，线照给', async () => {
      await seedAtoms(3, (t) => oneHot(hotOf(t)))
      const d = await referenceFor(db, async () => oneHot(0))
      assert.equal(d.usable, false)
      assert.equal(d.reason, 'library-too-small')
      assert.equal(d.n, 48, '问句照编码，只是库太小估不准')
      assert.equal(d.atoms, 3)
    })

    it('线高过失效线：判「判定不稳」，不再按线判有没有内容', async () => {
      // atom 与问句同向时 top1 余弦都是 1.0 —— 构造「库里到处是通用中文」的极端情形。
      await seedAtoms(REFERENCE_MIN_ATOMS, () => oneHot(0))
      const d = await referenceFor(db, async () => oneHot(0))
      assert.equal(d.usable, false)
      assert.equal(d.reason, 'line-too-high')
      assert.ok(d.p90 > REFERENCE_MAX_LINE)
    })

    it('库够大且线正常：usable true，p50 ≤ p90 ≤ max', async () => {
      await seedAtoms(REFERENCE_MIN_ATOMS, (t) => oneHot(hotOf(t)))
      const d = await referenceFor(db, async () => oneHot(0))
      assert.equal(d.usable, true)
      assert.equal(d.reason, 'ok')
      assert.ok(d.p50 <= d.p90, 'p50 不能高于 p90')
      assert.ok(d.p90 <= d.max, 'p90 不能高于最大值')
    })
  })

  describe('参考分布：缓存按 atom 行数失效', () => {
    it('库没变不重算；库变大要重算；显式失效之后也重算', async () => {
      await seedAtoms(REFERENCE_MIN_ATOMS, (t) => oneHot(hotOf(t)))
      let calls = 0
      const enc = async () => {
        calls++
        return oneHot(0)
      }
      await referenceFor(db, enc)
      assert.equal(calls, REFERENCE_QUESTIONS.length, '首次要对每条问句各编码一次')
      await referenceFor(db, enc)
      assert.equal(calls, REFERENCE_QUESTIONS.length, '库没变时不得重算')

      await seedAtoms(1, (t) => oneHot(hotOf(t)))
      await referenceFor(db, enc)
      assert.equal(calls, REFERENCE_QUESTIONS.length * 2, 'atom 数变了必须重算')

      invalidateReference(db)
      await referenceFor(db, enc)
      assert.equal(calls, REFERENCE_QUESTIONS.length * 3, '显式失效之后必须重算')
    })
  })
})

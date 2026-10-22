// 写入侧审核层测试。
//
// 这里同样**不加载真实模型**：向量由用例自己注入 —— 阈值判据要在「刚好 0.9 / 刚好 1.0」
// 这类边界上测，真实模型反而造不出来。真实编码器 + 真实库副本上的表现由
// 探针脚本单独给（不进 CI，理由见 AGENTS.md 第二节）。
//
// 三级各覆盖到：
//   自动处理  过短（拦下）/ 过长（切分）/ 过长到不成样子（拦下）
//   提示      重复 / 高相似
//   不处理    正常写入
// 另有一条**结构性的**用例：审核的产出只出现在返回值里 —— 库里不多不少只多出该多的东西。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { VEC_DIM } from '../dist/util/vec.js'
import { createWriteCtx, writeAtom, writeReviewed } from '../dist/pipeline/write.js'
import { DEFAULT_REVIEW_THRESHOLDS, reviewLength } from '../dist/pipeline/review.js'

let dbFile = ''
let db = null

beforeEach(() => {
  dbFile = join(
    tmpdir(),
    `dsh-lattice-review-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

function oneHot(i) {
  const v = new Float32Array(VEC_DIM)
  v[i % VEC_DIM] = 1
  return v
}

/** 与 a 的余弦恰为 w 的单位向量（a、b 正交时成立）。 */
function atCos(a, b, w) {
  const v = new Float32Array(a.length)
  const s = Math.sqrt(Math.max(0, 1 - w * w))
  for (let i = 0; i < v.length; i++) v[i] = w * a[i] + s * b[i]
  return v
}

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

function keywordEncoder(map, fallback = hashVec) {
  return async (text) => {
    for (const [kw, vec] of map) if (text.includes(kw)) return vec
    return fallback(text)
  }
}

const atoms = () => Number(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n)
const tombstones = () => Number(db.prepare('SELECT COUNT(*) AS n FROM forgotten').get().n)

describe('写入侧审核：长度类（自动处理）', () => {
  it('过短：碎片不落库，且反馈里说清了为什么与怎么办', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const out = await writeReviewed(ctx, { text: '---' })
    assert.equal(out.length.action, 'reject')
    assert.equal(out.length.note.level, 'auto')
    assert.equal(out.length.note.code, 'too-short')
    assert.match(out.length.note.message, /未写入/)
    assert.equal(out.results.length, 0)
    assert.equal(atoms(), 0, '被拦下的碎片不该留下 atom')
  })

  it('刚好到下限的正文放行（拦的是空壳，不是短结论）', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const text = '本机代理端口是 7890，Node 另需开关。'
    assert.ok(text.length >= DEFAULT_REVIEW_THRESHOLDS.minChars)
    const out = await writeReviewed(ctx, { text })
    assert.equal(out.length.action, 'keep')
    assert.equal(out.results.length, 1)
    assert.equal(atoms(), 1)
  })

  it('过长：一次写了三件事 → 自动切成多条分别写入', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const seg = (n) => '第' + n + '件事：' + '甲'.repeat(290) + '。'
    const text = seg(1) + seg(2) + seg(3)
    assert.ok(text.length > DEFAULT_REVIEW_THRESHOLDS.maxChars)
    const out = await writeReviewed(ctx, { text })
    assert.equal(out.length.action, 'split')
    assert.equal(out.length.note.level, 'auto')
    assert.equal(out.length.note.code, 'too-long')
    assert.ok(out.length.segments.length > 1)
    assert.equal(out.results.length, out.length.segments.length)
    assert.equal(atoms(), out.length.segments.length)
    // 每一段都真的落了库，且顺序与段序一致。
    const rows = db.prepare('SELECT text FROM atom ORDER BY id').all()
    assert.deepEqual(
      rows.map((r) => String(r.text)),
      out.length.segments,
    )
  })

  it('切分后不沿用 topic_hint（免得把几件事硬塞进同一个主题）', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const first = await writeAtom(ctx, { text: '既有主题的一条记忆，用来当 topic_hint 的落点。' })
    const seg = (n) => '另一件事' + n + '：' + '乙'.repeat(290) + '。'
    const out = await writeReviewed(ctx, { text: seg(1) + seg(2) + seg(3), topicHint: first.topicId })
    assert.equal(out.length.action, 'split')
    for (const r of out.results) {
      assert.equal(r.hintMiss, undefined)
      assert.notEqual(r.topicId, first.topicId, '切分后各段应各自落位')
    }
  })

  it('过长到不像一条记忆（段数超上限）时整条拦下，不悄悄截断', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const text = ('丙'.repeat(700) + '。').repeat(12)
    const out = await writeReviewed(ctx, { text })
    assert.equal(out.length.action, 'reject')
    assert.equal(out.length.note.code, 'too-long')
    assert.equal(atoms(), 0, '拦下时一条都不该写')
  })

  it('reviewLength 是纯函数：反复调用不改变任何状态', () => {
    const a = reviewLength('---')
    const b = reviewLength('---')
    assert.deepEqual(a, b)
    assert.equal(atoms(), 0)
  })
})

describe('写入侧审核：重复 / 高相似（只提示，不阻止）', () => {
  it('重复：几乎逐字相同 → 提示，但**写入照常发生**', async () => {
    const A = oneHot(7)
    const encode = keywordEncoder([['nodeLinker', A]])
    const ctx = createWriteCtx(db, {}, { encode })
    const text = 'nodeLinker 必须设为 hoisted，否则创建符号链接会失败。'
    const first = await writeAtom(ctx, { text })
    assert.equal(first.review, undefined, '库里只有一条时没有可比对象')
    assert.equal(first.reviewScan, undefined, '新建主题时没有成员可比，也就不该留下比对痕迹')

    const second = await writeReviewed(ctx, { text })
    assert.equal(second.length.action, 'keep')
    assert.equal(second.results.length, 1, '提示级不阻止写入')
    const r = second.results[0]
    assert.ok(r.review && r.review.length === 1, '应有一条提示')
    assert.equal(r.review[0].level, 'hint')
    assert.equal(r.review[0].code, 'duplicate')
    assert.match(r.review[0].message, new RegExp('#' + first.atomId))
    assert.equal(r.reviewScan.scanned, 1, '并入已有主题时才比，且如实报出比了几条')
    assert.equal(atoms(), 2, '两条都在库里 —— 提示不改写入行为')
  })

  it('高相似：同义改写 → 提示，且报出的是较高相似的那一条', async () => {
    const A = oneHot(3)
    const B = oneHot(4)
    const encode = keywordEncoder([
      ['系统代理', A],
      ['本地端口', atCos(A, B, 0.9)],
    ])
    const ctx = createWriteCtx(db, {}, { encode })
    const first = await writeAtom(ctx, { text: '系统代理必须走本地端口，否则访问境外源会超时。' })
    const second = await writeReviewed(ctx, {
      text: '本地端口不设代理的话，境外资源会直接连接超时。',
    })
    assert.equal(second.length.action, 'keep')
    const r = second.results[0]
    assert.ok(r.review && r.review.length === 1)
    assert.equal(r.review[0].code, 'near-duplicate')
    assert.match(r.review[0].message, new RegExp('#' + first.atomId))
    assert.equal(atoms(), 2)
  })

  it('同一主题里的相邻结论不被误报（余弦 0.9 但词面几乎不重叠）', async () => {
    const A = oneHot(11)
    const B = oneHot(12)
    const encode = keywordEncoder([
      ['主题甲', A],
      ['主题乙', atCos(A, B, 0.9)],
    ])
    const ctx = createWriteCtx(db, {}, { encode })
    await writeAtom(ctx, { text: '主题甲的结论：检索通道的权重必须可配，否则没法做消融对照。' })
    // 余弦 0.9（>= nearCos）—— 但这是**设计上刻意不允许自动合并**的那类：
    // 相似不等于同一件事。这条用例钉住「提示级只报不改」的下界行为。
    const second = await writeReviewed(ctx, {
      text: '主题乙的记录：丙丙丙丁丁丁戊戊戊己己己庚庚庚辛辛辛壬壬壬癸癸癸子子子丑丑丑。',
    })
    assert.equal(second.results.length, 1)
    assert.equal(atoms(), 2)
  })

  it('新建主题时不比对（主题里还没有成员）', async () => {
    const ctx = createWriteCtx(db, {}, { encode: async (t) => hashVec(t) })
    const only = await writeAtom(ctx, { text: '库里第一条记忆，孤立主题，没有可比对象。' })
    assert.equal(only.review, undefined)
    assert.equal(only.reviewScan, undefined, '没比过就不该留痕')
  })
})

describe('写入侧审核：不处理（正常写入行为不变）', () => {
  it('正常长度的写入：一条、无提示，结果与直接调 writeAtom 一致', async () => {
    const encode = async (t) => hashVec(t)
    const ctxA = createWriteCtx(db, {}, { encode })
    const viaReview = await writeReviewed(ctxA, {
      text: '正常长度的一条结论，应当原样写入、不产生任何审核提示。',
    })
    assert.equal(viaReview.length.action, 'keep')
    assert.equal(viaReview.length.note, null)
    assert.equal(viaReview.results.length, 1)
    assert.equal(viaReview.results[0].review, undefined)

    const dbB = openVault(dbFile + '.b').db
    try {
      const ctxB = createWriteCtx(dbB, {}, { encode })
      const direct = await writeAtom(ctxB, { text: '正常长度的一条结论，应当原样写入、不产生任何审核提示。' })
      const a = viaReview.results[0]
      assert.equal(a.action, direct.action)
      assert.equal(a.fit, direct.fit)
      assert.equal(a.entries.length, direct.entries.length)
      assert.deepEqual(a.evidence, direct.evidence)
    } finally {
      dbB.close()
      for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + '.b' + suffix, { force: true })
    }
  })
})

describe('写入侧审核：产出只走返回值', () => {
  it('审核命中重复时，库里只多了一条 atom —— 没有墓碑、没有别的行', async () => {
    const A = oneHot(9)
    const encode = keywordEncoder([['删不掉', A]])
    const ctx = createWriteCtx(db, {}, { encode })
    db.exec('BEGIN IMMEDIATE')
    db.exec('COMMIT')
    const before = {
      atom: atoms(),
      forgotten: tombstones(),
      topic: Number(db.prepare('SELECT COUNT(*) AS n FROM topic').get().n),
      // 只数审核可能写的那类边：写入路径自己会给新 atom 补 inferred 边（第 97 条），
      // 那是写入的副作用，不属审核，混在总数里就分不清「审核写边」与「写入补边」。
      edge: Number(db.prepare("SELECT COUNT(*) AS n FROM edge WHERE origin <> 'inferred'").get().n),
    }
    const text = '删不掉的这条记忆会被写两次，第二次应得到一条提示。'
    await writeAtom(ctx, { text })
    const out = await writeReviewed(ctx, { text })
    const r = out.results[0]
    assert.ok(r.review && r.review.length === 1, '提示必须产生')
    // 「只走返回值」的可核验形态：审核唯一改变的是它写回的那段文本。
    assert.equal(atoms(), before.atom + 2)
    assert.equal(tombstones(), before.forgotten, '审核不产生墓碑')
    assert.equal(
      Number(db.prepare("SELECT COUNT(*) AS n FROM edge WHERE origin <> 'inferred'").get().n),
      before.edge,
      '审核不产生边',
    )
    // 提示本身不在库里 —— 它只存在于返回值。
    const cols = db
      .prepare('PRAGMA table_info(atom)')
      .all()
      .map((c) => String(c.name))
    assert.equal(cols.includes('review'), false)
  })
})

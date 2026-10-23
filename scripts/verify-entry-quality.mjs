// 入口词质量验证：拿**改动前**的库快照与「按当前代码重建入口」的库做对照。
//
// 用法（缺 --before 直接报错退出，不静默拿当前库跟自己比）：
//   node scripts/snapshot-baseline.mjs --label old-rule        # 改规则**之前**先另存
//   node scripts/verify-entry-quality.mjs --before .probe/snap/old-rule/lattice.db
//
// 判据：
//   1. gold 集的 Recall 不下降（对照的是 --before 那份库，不是「上一次跑的结果」）
//   2. 每个主题「权重最高 8 条」窗口里的噪声词数量不下降
//   3. 入口总数与平均注入字符如实报出，供人判断这次改动的形状
//
// **判据 2 在 v4 之后事实上失效（2026-10-17 实测，勿再拿这个数当证据）**：它恒为 0/2228，
//   跨所有 max 都不动 —— 入口候选资格 isUsableTerm 已要求「纯字母或汉字」，这条口径再也
//   测不出本层噪声（它在 v4 之前是有用的）。判据 1 在「空词表重建」这个口径下也偏恒真，
//   只能当「没有崩」的下限检查，不能当「召回提升」的证据。要看入口层真的会动的量，
//   用**纯 Entry 路 gold 召回** —— 该口径跨 max 可比、且随改动真的变化；
//   做法见前置测量记录。
//
// 已知局限：重建用的是空词表（泛词过滤关闭），库里词元构成会与迁移写入时略有出入，
// 因此「前后对比」不是纯净效应。要看隔离后的净效应，用 scripts/verify-entry-filter.mjs。
//
// 关于对照：脚本会打印两份库各自记录的入口规则。**两份规则相同时，差值必然接近 0**，
// 那是「没有对照组」而不是「没问题」—— 输出里会明说。

import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { recall } from '../dist/pipeline/search.js'
import { buildEntries, clearLearned } from '../dist/pipeline/entries.js'
import { copyToWork, describeDb, requireBeforeDb, requireGold, ruleOf } from './lib/compare-db.mjs'

const OUT = '.probe'
const WORK = join(OUT, 'entry-quality.db')
const MODEL = 'Xenova/bge-small-zh-v1.5'

const BEFORE = requireBeforeDb('scripts/verify-entry-quality.mjs')
const GOLD = requireGold('scripts/verify-entry-quality.mjs')
copyToWork(BEFORE, WORK)

/** 与候选资格过滤同义的噪声判定：只要不是「纯字母或汉字」就算噪声。 */
const isNoise = (t) => !/^[A-Za-z\u4e00-\u9fff]+$/.test(String(t))

/** 统计「每主题权重最高 N 条」窗口里的噪声数。 */
function windowNoise(db, perTopic = 8) {
  const rows = db.prepare("SELECT DISTINCT atom_id, term, weight FROM entry WHERE origin='extracted'").all()
  const byAtom = new Map()
  for (const r of rows) {
    const k = Number(r.atom_id)
    if (!byAtom.has(k)) byAtom.set(k, [])
    byAtom.get(k).push({ term: String(r.term), w: Number(r.weight) })
  }
  let total = 0,
    noise = 0
  for (const [, list] of byAtom) {
    list.sort((a, b) => b.w - a.w)
    for (const e of list.slice(0, perTopic)) {
      total++
      if (isNoise(e.term)) noise++
    }
  }
  return { total, noise, atoms: byAtom.size }
}

/** 用给定库内容跑一遍 gold 集，返回命中数与注入字符数。 */
async function score(db, gold, model, cardOf) {
  let hit12 = 0,
    hit24 = 0,
    chars = 0
  const { assembleView, DEFAULT_BUDGET } = await import('../dist/pipeline/view.js')
  for (const c of gold) {
    const vq = await encode(c.query, { model })
    const r = recall(db, c.query, vq, { topN: 24 })
    if (r.hits.slice(0, 12).some((h) => cardOf.get(h.id) === c.target)) hit12++
    if (r.hits.slice(0, 24).some((h) => cardOf.get(h.id) === c.target)) hit24++
    chars += assembleView(db, r, { budget: DEFAULT_BUDGET }).text.length
  }
  return { hit12, hit24, chars: chars / gold.length }
}

async function main() {
  const model = MODEL
  if (!(await ensureEncoder({ model }))) throw new Error('编码器不可用，无法验证召回')
  const { readFileSync } = await import('node:fs')
  const gold = JSON.parse(readFileSync(GOLD, 'utf8'))

  // ① 对照（改动前的入口）。只读打开，绝不写它。
  const { db: beforeDb } = openVault(BEFORE, { readOnly: true })
  const beforeRule = ruleOf(beforeDb)
  const cardOf = new Map(
    beforeDb
      .prepare('SELECT id, source_ref FROM atom')
      .all()
      .map((r) => [Number(r.id), String(r.source_ref ?? '')]),
  )
  const before = {
    entries: beforeDb.prepare('SELECT count(*) AS c FROM entry').get().c,
    win: windowNoise(beforeDb),
  }
  const goldBefore = await score(beforeDb, gold, model, cardOf)
  beforeDb.close()

  // ② 工作副本：按当前代码重新抽取每个 atom 的入口。
  const { db } = openVault(WORK)
  const afterRule = ruleOf(db)
  const atoms = db.prepare('SELECT id, text FROM atom').all()
  // 重建入口会把 learned（使用史）一起删掉 —— 按 PRINCIPLES §六 第三类，丢必须留痕。
  // 先数再删，N=0 也打印：分不清「没清」与「没打印」就等于没有留痕。
  const clearedLearned = clearLearned(db)
  console.log('  已清空 ' + clearedLearned + ' 条反哺')
  const del = db.prepare('DELETE FROM entry WHERE atom_id = ?')
  const ins = db.prepare(
    'INSERT OR REPLACE INTO entry (atom_id, term, bigram, weight, origin, hits, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
  const now = Date.now()
  db.exec('BEGIN')
  for (const a of atoms) {
    del.run(Number(a.id))
    for (const rec of buildEntries(String(a.text), {}, { df: () => 0, total: () => atoms.length })) {
      ins.run(Number(a.id), rec.term, rec.bigram, rec.weight, rec.origin, now)
    }
  }
  db.exec('COMMIT')
  const after = { entries: db.prepare('SELECT count(*) AS c FROM entry').get().c, win: windowNoise(db) }
  const goldAfter = await score(db, gold, model, cardOf)
  db.close()

  const pct = (a, b) => ((a / b) * 100).toFixed(1) + '%'
  console.log('入口词质量验证（真实编码器）')
  console.log('  对照库（改动前）' + describeDb(BEFORE) + '  规则 ' + beforeRule)
  console.log('  工作副本（改后）' + describeDb(WORK) + '  规则 ' + afterRule)
  if (beforeRule === afterRule)
    console.log('  ⚠ 两份规则相同：本次差值必然接近 0。那是「没有对照组」而不是「没问题」——')
  console.log('    确认你给的是**改动前**那份快照，而不是重建过的基准库。')
  console.log('')
  console.log(
    '  入口总数      ' +
      before.entries +
      ' → ' +
      after.entries +
      '（' +
      (after.entries - before.entries) +
      '）',
  )
  console.log(
    '  展示窗口噪声  ' +
      before.win.noise +
      '/' +
      before.win.total +
      ' (' +
      pct(before.win.noise, before.win.total) +
      ') → ' +
      after.win.noise +
      '/' +
      after.win.total +
      ' (' +
      pct(after.win.noise, after.win.total) +
      ')',
  )
  console.log(
    '  gold Recall@12 ' + pct(goldBefore.hit12, gold.length) + ' → ' + pct(goldAfter.hit12, gold.length),
  )
  console.log(
    '  gold Recall@24 ' + pct(goldBefore.hit24, gold.length) + ' → ' + pct(goldAfter.hit24, gold.length),
  )
  console.log('  gold 平均注入字符 ' + goldBefore.chars.toFixed(0) + ' → ' + goldAfter.chars.toFixed(0))
  const pass = goldAfter.hit12 >= goldBefore.hit12 && after.win.noise <= before.win.noise
  console.log('  结论：' + (pass ? '通过（召回未降、噪声未增）' : '未通过'))
  if (!pass) process.exitCode = 1
}

await main()

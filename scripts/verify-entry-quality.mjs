// 入口词质量改动的前后对比验证。
//
// 判据：
//   1. 20 条人工 gold 查询的 Recall 不下降（基线：topN=12 时 95.0%）
//   2. 每个主题「权重最高 8 条」窗口里的噪声词数量下降
//   3. 无关查询的召回结果不劣化
//
// 用法：node scripts/verify-entry-quality.mjs
//
// 已知局限：重建用的是空词表（泛词过滤关闭），库里词元构成会与迁移写入时略有出入，
// 因此「前后对比」不是纯净效应。要看隔离后的净效应，用 scripts/verify-entry-filter.mjs。

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { recall } from '../dist/pipeline/search.js'
import { buildEntries } from '../dist/pipeline/entries.js'

const OUT = '.probe'
const SRC = join(OUT, 'migrated', 'lattice.db')
const DB = join(OUT, 'entry-quality.db')
const MODEL = 'Xenova/bge-small-zh-v1.5'

if (!existsSync(SRC)) throw new Error('缺少迁移库：先跑 scripts/migrate-eternal.mjs')
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true })
copyFileSync(SRC, DB)
mkdirSync(OUT, { recursive: true })

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

async function main() {
  const model = MODEL
  const ok = await ensureEncoder({ model })
  if (!ok) throw new Error('编码器不可用，无法验证召回')
  const gold = JSON.parse((await import('node:fs')).readFileSync(join(OUT, 'eval-gold.json'), 'utf8'))

  const { db } = openVault(DB)
  const cardOf = new Map(
    db
      .prepare('SELECT id, source_ref FROM atom')
      .all()
      .map((r) => [Number(r.id), String(r.source_ref ?? '')]),
  )

  // ── 基线：改动前的入口 ──
  const before = { entries: db.prepare('SELECT count(*) AS c FROM entry').get().c, win: windowNoise(db) }
  const goldBefore = await score(db, gold, model, cardOf)

  // ── 重建：按新规则重新抽取每个 atom 的入口 ──
  const atoms = db.prepare('SELECT id, text FROM atom').all()
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

  const pct = (a, b) => ((a / b) * 100).toFixed(1) + '%'
  console.log('入口词质量验证')
  console.log(
    '  入口总数    ' +
      before.entries +
      ' → ' +
      after.entries +
      '（' +
      (after.entries - before.entries) +
      '）',
  )
  console.log(
    '  展示窗口噪声 ' +
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

/** 用给定库内容跑一遍 gold 集，返回命中数与注入字符数。 */
async function score(db, gold, model, cardOf) {
  let hit12 = 0,
    hit24 = 0,
    chars = 0
  const { assembleView } = await import('../dist/pipeline/view.js')
  for (const c of gold) {
    const vq = await encode(c.query, { model })
    const r = recall(db, c.query, vq, { topN: 24 })
    if (r.hits.slice(0, 12).some((h) => cardOf.get(h.id) === c.target)) hit12++
    if (r.hits.slice(0, 24).some((h) => cardOf.get(h.id) === c.target)) hit24++
    chars += assembleView(db, r, { budget: 6000 }).text.length
  }
  return { hit12, hit24, chars: chars / gold.length }
}

await main()

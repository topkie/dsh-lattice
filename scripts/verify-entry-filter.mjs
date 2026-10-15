// 定向对照：只剔除「含数字或下划线」的入口，看召回是否依赖它们。
// 与 verify-entry-quality.mjs 的分工：那个验「新规则重建后整体不劣化」，
// 这个隔离出「过滤本身」的净效应（不做任何重排）。

import { copyFileSync, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView } from '../dist/pipeline/view.js'

const OUT = '.probe'
const SRC = join(OUT, 'migrated', 'lattice.db')
const DB = join(OUT, 'entry-filter-only.db')
const MODEL = 'Xenova/bge-small-zh-v1.5'
if (!existsSync(SRC)) throw new Error('缺少迁移库')
mkdirSync(OUT, { recursive: true })
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true })
copyFileSync(SRC, DB)

await ensureEncoder({ model: MODEL })
const gold = JSON.parse(readFileSync(join(OUT, 'eval-gold.json'), 'utf8'))
const { db } = openVault(DB)
const cardOf = new Map(
  db
    .prepare('SELECT id, source_ref FROM atom')
    .all()
    .map((r) => [Number(r.id), String(r.source_ref ?? '')]),
)

async function score() {
  let h12 = 0,
    h24 = 0,
    chars = 0
  for (const c of gold) {
    const vq = await encode(c.query, { model: MODEL })
    const r = recall(db, c.query, vq, { topN: 24 })
    if (r.hits.slice(0, 12).some((h) => cardOf.get(h.id) === c.target)) h12++
    if (r.hits.slice(0, 24).some((h) => cardOf.get(h.id) === c.target)) h24++
    chars += assembleView(db, r, { budget: 6000 }).text.length
  }
  return { h12, h24, chars: chars / gold.length }
}

const before = await score()
const junk = db
  .prepare("SELECT count(*) AS c FROM entry WHERE term GLOB '*[0-9]*' OR term GLOB '*_*'")
  .get().c
db.exec("DELETE FROM entry WHERE term GLOB '*[0-9]*' OR term GLOB '*_*'")
const after = await score()

const N = gold.length
const p = (x) => ((x / N) * 100).toFixed(1) + '%'
console.log('入口过滤净效应（仅剔除 ' + junk + ' 条含数字或下划线的入口，不做重排）')
console.log('  gold Recall@12  ' + p(before.h12) + ' → ' + p(after.h12))
console.log('  gold Recall@24  ' + p(before.h24) + ' → ' + p(after.h24))
console.log('  平均注入字符    ' + before.chars.toFixed(0) + ' → ' + after.chars.toFixed(0))
const pass = after.h12 >= before.h12 && after.h24 >= before.h24
console.log('  结论：' + (pass ? '过滤本身不影响召回' : '过滤伤了召回，需要复核'))
if (!pass) process.exitCode = 1

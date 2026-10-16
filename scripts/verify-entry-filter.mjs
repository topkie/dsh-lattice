// 入口过滤的净效应：只剔除「含数字或下划线」的入口，不做任何重排，看召回是否依赖它们。
//
// 与 verify-entry-quality.mjs 的分工：那个验「按新规则重建后整体不劣化」，
// 这个隔离出「过滤本身」的净效应。
//
// 用法（缺 --before 直接报错退出，不静默拿当前库跟自己比）：
//   node scripts/snapshot-baseline.mjs --label old-rule        # 改规则**之前**先另存
//   node scripts/verify-entry-filter.mjs --before .probe/snap/old-rule/lattice.db
//
// 做法：把 --before 那份库复制成工作副本，先量一遍基线，再**只**删掉含数字/下划线的入口，
// 再量一遍。两次量的都是同一份工作副本（差别只有那一次 DELETE）—— 这正是「净效应」的含义。

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView } from '../dist/pipeline/view.js'
import { copyToWork, describeDb, requireBeforeDb, requireGold, ruleOf } from './lib/compare-db.mjs'

const OUT = '.probe'
const WORK = join(OUT, 'entry-filter-only.db')
const MODEL = 'Xenova/bge-small-zh-v1.5'

const BEFORE = requireBeforeDb('scripts/verify-entry-filter.mjs')
const GOLD = requireGold('scripts/verify-entry-filter.mjs')
copyToWork(BEFORE, WORK)

if (!(await ensureEncoder({ model: MODEL }))) {
  console.error('编码器不可用：本脚本必须在真实模型下跑。')
  process.exit(2)
}
const gold = JSON.parse(readFileSync(GOLD, 'utf8'))
const { db } = openVault(WORK)
const rule = ruleOf(db)
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

console.log('入口过滤净效应（真实编码器）')
console.log('  对照库       ' + describeDb(BEFORE) + '  规则 ' + rule)
console.log('  工作副本     ' + describeDb(WORK) + '（本脚本只对它做一次 DELETE）')
console.log('  剔除的入口   ' + junk + ' 条（含数字或下划线，不重排）')
console.log('  gold Recall@12  ' + p(before.h12) + ' → ' + p(after.h12))
console.log('  gold Recall@24  ' + p(before.h24) + ' → ' + p(after.h24))
console.log('  平均注入字符    ' + before.chars.toFixed(0) + ' → ' + after.chars.toFixed(0))
const pass = after.h12 >= before.h12 && after.h24 >= before.h24
console.log('  结论：' + (pass ? '过滤本身不影响召回' : '过滤伤了召回，需要复核'))
db.close()
if (!pass) process.exitCode = 1

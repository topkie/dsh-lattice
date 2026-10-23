// 基准库上的召回回归。
//
// 为什么单独有这个脚本：入口规则的任何改动都会改变召回，而「改完召回有没有掉」是唯一
// 能判定改动好坏的硬判据 ——「展示窗口看起来干净了」不是。它读标准验证库
//（见 docs/DEVELOPMENT.md 的「标准验证库」），因此结果与历史基线直接可比。
//
// 用法：
//   node scripts/verify-recall-baseline.mjs --db <库> [--gold <查询集>]
//
// **--db 是必填的**：「基准库」不是一个固定的路径，而是「这次要跟哪一份比」的问题。
// 此前它默认落到 .probe/baseline/lattice.db —— 而那个库会被按新规则重建，于是
// 「改动前先跑一次、改完再跑一次」两次跑的可能根本不是同一个库，读起来却像同比。
// 现在缺 --db 会停并给出取库的两条路（重建基准库 / 另存快照）。
//
// gold 集格式：[{ "query": "用你自己的话描述的查询", "target": "来源标识" }]
// target 与 atom.source_ref 对应；判据是「该来源切出的任一 atom 进入前 N 名」。
//
// 会加载真实模型（数十秒），因此不进 CI，属于「合并前手动跑一次」。

import { readFileSync } from 'node:fs'
import { openVault } from '../dist/db/open.js'
import { encode, ensureEncoder } from '../dist/encoder/index.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView, DEFAULT_BUDGET } from '../dist/pipeline/view.js'
import { argOf, describeDb, requireGold, ruleOf } from './lib/compare-db.mjs'

const MODEL = 'Xenova/bge-small-zh-v1.5'
/** 召回截断的位置；12 是实测的等价点（24 与 12 在 gold 集上同分，见 docs/DEVELOPMENT.md）。 */
const TOP_N = 24

const SCRIPT = 'scripts/verify-recall-baseline.mjs'
const DB = argOf('db', '')
if (DB === '') {
  console.error('缺少被测库：' + SCRIPT + ' 需要 --db <库>。')
  console.error('')
  console.error('取库的两条路：')
  console.error('  · 基准库（重建）：node scripts/build-baseline.mjs --source <cards.json> --label <名字>')
  console.error('                   然后 --db .probe/baseline/lattice.db')
  console.error('  · 改动前的快照：node scripts/snapshot-baseline.mjs --label <名字>')
  console.error('                   然后 --db .probe/snap/<名字>/lattice.db')
  console.error('')
  console.error('为什么不给默认值：库会被按新规则重建，默认路径会让「改动前后各跑一次」变成')
  console.error('跑两份不同的库却当成同一份同比。')
  process.exit(2)
}
const GOLD = requireGold(SCRIPT)

const ok = await ensureEncoder({ model: MODEL })
if (!ok) throw new Error('编码器不可用：本脚本必须在真实模型下跑')
const gold = JSON.parse(readFileSync(GOLD, 'utf8'))
const { db } = openVault(DB, { readOnly: true })

const sourceOf = new Map()
for (const r of db.prepare('SELECT id, source_ref FROM atom').all()) {
  sourceOf.set(Number(r.id), String(r.source_ref ?? ''))
}

let hit12 = 0
let hit24 = 0
let chars = 0
const ranks = []
for (const c of gold) {
  const vq = await encode(String(c.query), { model: MODEL })
  const r = recall(db, String(c.query), vq, { topN: TOP_N })
  const at = (n) => r.hits.slice(0, n).findIndex((h) => sourceOf.get(h.id) === c.target)
  const i12 = at(12)
  const i24 = at(TOP_N)
  if (i12 >= 0) hit12++
  if (i24 >= 0) hit24++
  ranks.push(i24 >= 0 ? i24 + 1 : 99)
  chars += assembleView(db, r, { budget: DEFAULT_BUDGET }).text.length
}
const pct = (x) => ((x / gold.length) * 100).toFixed(1) + '%'
console.log('库 ' + describeDb(DB) + '  规则 ' + ruleOf(db) + '   gold ' + gold.length + ' 条')
console.log(
  '  Recall@12 ' +
    pct(hit12) +
    '   Recall@24 ' +
    pct(hit24) +
    '   平均注入字符 ' +
    (chars / gold.length).toFixed(0),
)
console.log('  目标卡排名分布 ' + ranks.join(','))
db.close()

// 90% 是历史基线（两次规则变更都在 90~95%）。低于它先查清原因，不要当成噪声。
if (hit12 / gold.length < 0.9) {
  console.error('Recall@12 低于 90%：先查清原因再合并。')
  process.exitCode = 1
}

// 基准库上的召回回归。
//
// 为什么单独有这个脚本：入口规则的任何改动都会改变召回，而「改完召回有没有掉」是唯一
// 能判定改动好坏的硬判据 ——「展示窗口看起来干净了」不是。它读标准验证库
//（见 docs/DEVELOPMENT.md 的「标准验证库」），因此结果与历史基线直接可比。
//
// 用法：
//   node scripts/verify-recall-baseline.mjs [--db <库>] [--gold <查询集>]
//
// gold 集格式：[{ "query": "用你自己的话描述的查询", "target": "来源标识" }]
// target 与 atom.source_ref 对应；判据是「该来源切出的任一 atom 进入前 N 名」。
//
// 会加载真实模型（数十秒），因此不进 CI，属于「合并前手动跑一次」。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { encode, ensureEncoder } from '../dist/encoder/index.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView } from '../dist/pipeline/view.js'

const MODEL = 'Xenova/bge-small-zh-v1.5'
/** 召回截断的位置；12 是实测的等价点（24 与 12 在 gold 集上同分，见 docs/DEVELOPMENT.md）。 */
const TOP_N = 24

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const DB = arg('db', join('.probe', 'baseline', 'lattice.db'))
const GOLD = arg('gold', join('.probe', 'eval-gold.json'))

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
  chars += assembleView(db, r, { budget: 6000 }).text.length
}
const pct = (x) => ((x / gold.length) * 100).toFixed(1) + '%'
console.log('库 ' + DB + '   gold ' + gold.length + ' 条')
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

// 重建推断边。
//
// 为什么需要一条命令：推断边是几何派生物（设计 14 的分界 —— 凡是几何或统计产生的都可重算），
// 但「可重算」不等于「有人会去算」。读路径曾经在召回时顺手补一次全量重建，代价有三条：
// 只读连接建不了边（诊断与对照实验都走只读）、全量成本摊在用户第一次召回上、判据是
// 「表里有没有推断边」—— 只要有一条就不重建，真实的半建状态永远不修。
// 现在读侧只报状态；重建由写入路径（新 atom 由 linkNewAtom 局部补边）与这条命令负责。
//
// 用法：
//   node scripts/rebuild-graph.mjs --db <库路径>
//   node scripts/rebuild-graph.mjs --db <库路径> --dry-run    # 只报现状，不动库
//
// 只替换 origin = 'inferred' 的边（整批删除后重建），声明边（真相源）不动。
// atom 数超过全量推断上限时如实报拒绝，不做部分重建。

import { openVault } from '../dist/db/open.js'
import { GRAPH_INFER_MAX_ATOMS, GRAPH_KINDS, edgeOriginCounts, inferEdges } from '../dist/graph/infer.js'
import { DUP_COS, DUP_LEX } from '../dist/pipeline/search.js'

const Q = String.fromCharCode(39)
const argv = process.argv.slice(2)
function arg(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const dbPath = arg('--db')
const dryRun = argv.includes('--dry-run')

if (!dbPath) {
  console.error('用法：node scripts/rebuild-graph.mjs --db <库路径> [--dry-run]')
  process.exit(2)
}

const { db } = openVault(dbPath)

const KINDS = GRAPH_KINDS.map((k) => Q + k + Q).join(', ')
const ZERO_DEGREE_SQL =
  'SELECT COUNT(*) AS n FROM atom a WHERE NOT EXISTS (' +
  'SELECT 1 FROM edge e WHERE e.src_type = ' +
  Q +
  'atom' +
  Q +
  ' AND e.src_id = a.id AND e.dst_type = ' +
  Q +
  'atom' +
  Q +
  ' AND e.kind IN (' +
  KINDS +
  '))'

/** 现状快照：原子数、两类边数、图路出度为 0 的原子数。 */
function snapshot() {
  const atoms = Number(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n)
  const edges = edgeOriginCounts(db)
  const zero = Number(db.prepare(ZERO_DEGREE_SQL).get().n)
  return { atoms, inferred: edges.inferred, declared: edges.declared, zero }
}

function describe(tag, s, extra) {
  const pct = s.atoms === 0 ? '0.0' : ((s.zero / s.atoms) * 100).toFixed(1)
  return (
    tag +
    '：atom ' +
    s.atoms +
    ' 条，推断边 ' +
    s.inferred +
    ' 条，声明边 ' +
    s.declared +
    ' 条，图路出度为 0 的 atom ' +
    s.zero +
    ' 条（' +
    pct +
    '%）' +
    (extra === undefined ? '' : extra)
  )
}

const before = snapshot()
console.log('库：' + dbPath)
console.log(describe('重建前', before))

if (dryRun) {
  console.log('--dry-run：未改动库。')
  db.close()
  process.exit(0)
}

if (before.atoms > GRAPH_INFER_MAX_ATOMS) {
  console.error(
    '拒绝重建：atom ' +
      before.atoms +
      ' 条超过全量推断上限 ' +
      GRAPH_INFER_MAX_ATOMS +
      ' 条。这不是故障，是上限；不做部分重建。',
  )
  db.close()
  process.exit(1)
}

const t0 = Date.now()
const outcome = inferEdges(db, { dupCos: DUP_COS, dupLex: DUP_LEX })
const ms = Date.now() - t0

if (outcome.status === 'failed') {
  console.error('重建失败：' + outcome.detail)
  db.close()
  process.exit(1)
}

console.log(describe('重建后', snapshot(), '，耗时 ' + ms + ' ms'))
console.log('结果：' + outcome.detail)
db.close()

// 整库导出：把记忆本体（atom）、主题（topic）、关系（edge）写成一份快照或一份可读清单。
//
// 为什么不导出 entry：入口词能从正文重算（`buildEntries`）。本机 375 条 atom 带 9 千余条
// entry，带上会让文件大一个量级，而它没有独立信息。同理不导出 embedding 与 sum_vec ——
// 二进制、可重算，人也没法核对。判据是「能不能从别的列算回来」，不是「重不重要」。
//
// 为什么不做导入：导入要先定 id 重映射、取代关系怎么重建、与库里已有条目冲突时留谁。
// 混在一起，「导出的东西对不对」就没法单独判 —— 那是另一个任务。
//
// 时间戳一列不转：JSON 里保持库里的整数毫秒（字段名与库一致，供别的工具读），
// 给人看的日期只出现在 markdown 里。

import type { DatabaseSync } from 'node:sqlite'
import { FLAG_ARCHIVED } from '../db/flags.js'
import { SCHEMA_VERSION } from '../db/schema.js'

/** 导出的三部分规模。JSON 的 counts 与 markdown 的头部说明都用它。 */
export interface ExportCounts {
  atoms: number
  topics: number
  edges: number
}

/** 一次导出的结果。bytes 是 UTF-8 字节数，用来回答「文件多大」。 */
export interface MemoryExport {
  text: string
  counts: ExportCounts
  bytes: number
}

/** 导出参数。version 是插件版本；now 可注入，测试要固定时间戳。 */
export interface ExportOptions {
  version: string
  now?: number
}

// 列清单显式写出来，不用 SELECT *：库里加一列时，导出文件不该悄悄多一个字段。
// 三份清单与 src/db/schema.ts 的 SNAPSHOT_V5 对应，少一列测试会红。
const ATOM_COLUMNS =
  'id, kind, text, summary, topic_id, scope, source, source_ref, flags, ' +
  'superseded_by, origin, recall_hits, last_recalled_at, created_at, updated_at, superseded_at'
const TOPIC_COLUMNS = 'id, label, n_atoms, created_at, rebuilt_at'
const EDGE_COLUMNS = 'id, src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at'

type Row = Record<string, unknown>

/** 只读一次查表。表名与列清单都是本模块里的常量，不来自请求。 */
function rowsOf(db: DatabaseSync, table: string, columns: string): Row[] {
  return db.prepare('SELECT ' + columns + ' FROM ' + table + ' ORDER BY id').all() as Row[]
}

function countsOf(atoms: Row[], topics: Row[], edges: Row[]): ExportCounts {
  return { atoms: atoms.length, topics: topics.length, edges: edges.length }
}

/**
 * JSON 快照。
 *
 * 顶层四个键是契约（exportedAt / version / atoms / topics / edges），另外补 schemaVersion
 * 与 counts：读文件的人先看规模，再看逐条内容。
 */
export function exportJson(db: DatabaseSync, opts: ExportOptions): MemoryExport {
  const atoms = rowsOf(db, 'atom', ATOM_COLUMNS)
  const topics = rowsOf(db, 'topic', TOPIC_COLUMNS)
  const edges = rowsOf(db, 'edge', EDGE_COLUMNS)
  const counts = countsOf(atoms, topics, edges)
  const body = {
    exportedAt: new Date(opts.now ?? Date.now()).toISOString(),
    version: opts.version,
    schemaVersion: SCHEMA_VERSION,
    counts,
    atoms,
    topics,
    edges,
  }
  const text = JSON.stringify(body, null, 2) + '\n'
  return { text, counts, bytes: Buffer.byteLength(text) }
}

/** 所有换行、制表与连续空白压成一个空格：清单每条占一行，结构才不会被子内容撑破。 */
function oneLine(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 本地日期 YYYY-MM-DD。不用 toISOString：它会按 UTC 算，跨零点时差一天。 */
function dayOf(ms: unknown): string {
  const n = typeof ms === 'number' ? ms : Number(ms)
  if (!Number.isFinite(n)) return ''
  const d = new Date(n)
  const pad = (x: number): string => (x < 10 ? '0' + x : String(x))
  return String(d.getFullYear()) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 一条记忆在 markdown 里的一行。顺序固定：id、日期、类型、域、来源、状态、正文。 */
function atomLine(row: Row): string {
  const parts: string[] = ['- `#' + String(row.id) + '`']
  const day = dayOf(row.created_at)
  if (day !== '') parts.push(day)
  const kind = oneLine(row.kind)
  if (kind !== '') parts.push(kind)
  const scope = oneLine(row.scope)
  if (scope !== '' && scope !== 'global') parts.push('域 ' + scope)
  const src = oneLine(row.source_ref) || oneLine(row.source)
  if (src !== '') parts.push('来源 ' + src)
  const supersededBy = row.superseded_by
  if (typeof supersededBy === 'number' && supersededBy > 0) parts.push('已被 #' + supersededBy + ' 取代')
  const flags = typeof row.flags === 'number' ? row.flags : 0
  if ((flags & FLAG_ARCHIVED) !== 0) parts.push('已归档')
  const text = oneLine(row.text)
  return text === '' ? parts.join(' · ') : parts.join(' · ') + ' · ' + text
}

/** 一条关系在 markdown 里的一行。`src_type` / `dst_type` 也写出来：边不只在 atom 之间。 */
function edgeLine(row: Row): string {
  const conf = typeof row.confidence === 'number' ? row.confidence.toFixed(2) : ''
  const tail = [oneLine(row.origin)]
  if (conf !== '') tail.push(conf)
  return (
    '- `' +
    oneLine(row.src_type) +
    '#' +
    String(row.src_id) +
    '` —' +
    oneLine(row.kind) +
    '→ `' +
    oneLine(row.dst_type) +
    '#' +
    String(row.dst_id) +
    '` （' +
    tail.join(', ') +
    '）'
  )
}

/**
 * markdown 清单：按主题分组，主题内按 id 升序；没有归属的记忆排在最后的「未归类」。
 *
 * 为什么按主题分组：atom 只有一个 `topic_id`，光看 id 与正文读不出库的组织方式。
 * 空主题不出节 —— 空标题除了让人以为漏了内容以外没有别的用处。
 */
export function exportMarkdown(db: DatabaseSync, opts: ExportOptions): MemoryExport {
  const atoms = rowsOf(db, 'atom', ATOM_COLUMNS)
  const topics = rowsOf(db, 'topic', TOPIC_COLUMNS)
  const edges = rowsOf(db, 'edge', EDGE_COLUMNS)
  const counts = countsOf(atoms, topics, edges)
  const byTopic = new Map<number | null, Row[]>()
  for (const row of atoms) {
    const key = typeof row.topic_id === 'number' ? row.topic_id : null
    const bucket = byTopic.get(key)
    if (bucket === undefined) byTopic.set(key, [row])
    else bucket.push(row)
  }
  const out: string[] = [
    '# lattice 记忆库导出',
    '',
    '- 导出时间：' + new Date(opts.now ?? Date.now()).toISOString(),
    '- 插件版本：' + opts.version + '（结构版本 ' + SCHEMA_VERSION + '）',
    '- 规模：' + counts.atoms + ' 条记忆 / ' + counts.topics + ' 个主题 / ' + counts.edges + ' 条关系',
    '- 不含入口词、向量与日志：前两者能从正文重算，日志另有导出',
    '',
  ]
  for (const topic of topics) {
    const members = byTopic.get(topic.id as number)
    if (members === undefined || members.length === 0) continue
    out.push('## 主题 #' + String(topic.id) + ' · ' + oneLine(topic.label) + '（' + members.length + ' 条）')
    out.push('')
    for (const row of members) out.push(atomLine(row))
    out.push('')
  }
  const orphans = byTopic.get(null)
  if (orphans !== undefined && orphans.length > 0) {
    out.push('## 未归类（' + orphans.length + ' 条）')
    out.push('')
    for (const row of orphans) out.push(atomLine(row))
    out.push('')
  }
  if (edges.length > 0) {
    out.push('## 关系（' + edges.length + ' 条）')
    out.push('')
    for (const row of edges) out.push(edgeLine(row))
    out.push('')
  }
  const text = out.join('\n')
  return { text, counts, bytes: Buffer.byteLength(text) }
}

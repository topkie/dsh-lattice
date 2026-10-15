// 注入组装：把召回结果变成模型真正读到的那段文本。
//
// 三段式的分工，本质是把「信息本体」和「找到它的线索」分开计价：
//   锚  记忆正文本身。占预算一半以上，**永不为其他段让路**
//   入口  命中主题的别名与关键词，帮模型判断「这里还有别的说法」
//   路  一跳关联的摘要，纯辅助，预算不足时最先砍
//
// 预算比例（55/20/25）不是审美选择：锚决定回答质量，路只提供线索。
// 裁剪顺序（路 → 入口 → 锚降级 → 路清零 → 锚减量）也来自同一条判断：
// 宁可少给几条线索，也不能让信息本体被挤掉。

import type { DatabaseSync } from 'node:sqlite'
import type { RecallResult } from './search.js'

/** 各段的字符配额占比。三段之和为 1。 */
export const SEGMENT_RATIO = { anchors: 0.55, entries: 0.2, paths: 0.25 } as const

/** 锚段保底条数——预算再紧也要给这么多条记忆留位置。 */
export const MIN_ANCHORS = 3

/**
 * 超预算时的裁剪顺序。
 *
 * 这个数组是**行为契约**：测试直接依赖它的顺序，而不是依赖某个具体输出。
 * 想在中间插一步，就得同时想清楚它对「锚不被挤掉」这条不变量意味着什么。
 */
export const TRIM_ORDER = ['paths->5', 'entries->4', 'anchors->summary', 'paths->0', 'anchors->3'] as const

export type TrimStep = (typeof TRIM_ORDER)[number]

export interface ViewOptions {
  /** 总字符预算。 */
  budget?: number
  /** 锚段每条最多给多少字符（全文很长时截断，避免一条吃掉整段）。 */
  anchorMaxChars?: number
  /** 每个主题最多给几条入口。 */
  entriesPerTopic?: number
  /** 单个主题的入口行字符上限（防止一行过长挤占锚段）。 */
  entryLineMaxChars?: number
  /** 路段的整体行数上限。 */
  pathLines?: number
}

export interface ViewResult {
  /** 完整文本，直接注入。 */
  text: string
  anchors: number
  entryTopics: number
  pathLines: number
  /** 因预算被降级为摘要的锚条数。 */
  demotedAnchors: number
  /** 同主题下未进锚的条数（汇总成一行提示）。 */
  otherRelated: number
  /** 本段实际用掉的字符。 */
  used: { anchors: number; entries: number; paths: number; total: number }
  /** 触发了哪些裁剪步骤。 */
  trimmed: TrimStep[]
}

const DEFAULT_BUDGET = 6000
const DEFAULT_ANCHOR_MAX = 1200
const DEFAULT_ENTRIES_PER_TOPIC = 8
const DEFAULT_ENTRY_LINE_MAX = 160
const DEFAULT_PATH_LINES = 15
/** 一条锚的正文，按需从库里取。 */
function loadTexts(db: DatabaseSync, ids: number[]): Map<number, string> {
  const out = new Map<number, string>()
  if (ids.length === 0) return out
  const ph = ids.map(() => '?').join(', ')
  const rows = db.prepare('SELECT id, text FROM atom WHERE id IN (' + ph + ')').all(...ids) as Array<{
    id: number | bigint
    text: string
  }>
  for (const r of rows) out.set(Number(r.id), String(r.text))
  return out
}

/** 某个主题下命中的 atom 的入口词，按权重降序。 */
function topicEntries(db: DatabaseSync, topicId: number, limit: number): string[] {
  const rows = db
    .prepare(
      'SELECT e.term AS term, MAX(e.weight) AS w FROM entry e' +
        ' JOIN atom a ON a.id = e.atom_id WHERE a.topic_id = ?' +
        ' GROUP BY e.term ORDER BY w DESC, e.term LIMIT ?',
    )
    .all(topicId, limit) as Array<{ term: string; w: number }>
  return rows.map((r) => String(r.term))
}

/** 一跳关联的摘要行。只走结构化边，且不重复锚里已有的条目。 */
function pathLinesFor(db: DatabaseSync, anchors: number[], exclude: Set<number>, limit: number): string[] {
  if (anchors.length === 0 || limit <= 0) return []
  const ph = anchors.map(() => '?').join(', ')
  const sql =
    'SELECT e.kind AS kind, e.confidence AS conf, b.id AS oid, b.summary AS summary FROM edge e' +
    " JOIN atom b ON b.id = CASE WHEN e.src_type = 'atom' AND e.src_id IN (" +
    ph +
    ') THEN e.dst_id ELSE e.src_id END' +
    " WHERE ((e.src_type = 'atom' AND e.src_id IN (" +
    ph +
    '))' +
    "    OR (e.dst_type = 'atom' AND e.dst_id IN (" +
    ph +
    ')))' +
    '   AND b.id NOT IN (' +
    ph +
    ')' +
    ' ORDER BY e.confidence DESC LIMIT ?'
  const rows = db.prepare(sql).all(...anchors, ...anchors, ...anchors, ...anchors, limit) as Array<{
    kind: string
    conf: number
    oid: number | bigint
    summary: string
  }>
  const seen = new Set<number>()
  const out: string[] = []
  for (const r of rows) {
    const id = Number(r.oid)
    if (exclude.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push('[' + r.kind + ' ' + Number(r.conf).toFixed(2) + '] ' + clip(String(r.summary), 80))
  }
  return out
}

/** 按字符截断（码点安全，避免劈开代理对）。 */
function clip(s: string, max: number): string {
  const chars = Array.from(s)
  if (chars.length <= max) return s
  return chars.slice(0, Math.max(1, max - 1)).join('') + '…'
}

/**
 * 把召回结果组装成三段式文本。
 *
 * 只需 db + 召回结果：不读配置、不碰编码器，便于单测直接喂构造好的 RecallResult。
 */
export function assembleView(db: DatabaseSync, recalled: RecallResult, opts: ViewOptions = {}): ViewResult {
  const budget = opts.budget ?? DEFAULT_BUDGET
  const anchorMax = opts.anchorMaxChars ?? DEFAULT_ANCHOR_MAX
  const pathLimit = opts.pathLines ?? DEFAULT_PATH_LINES
  const trimmed: TrimStep[] = []

  // 裁剪状态机：每执行一步就重新渲染并检查，直到装得下。
  // 逐步降级而不是一次算到位 —— 每一步的效果都要看真实字符数，预算是字符而非条数。
  const st = {
    pathLimit,
    perTopic: opts.entriesPerTopic ?? DEFAULT_ENTRIES_PER_TOPIC,
    anchorToSummary: false,
    pathsOff: false,
    anchorCap: Number.POSITIVE_INFINITY,
  }

  const fullTexts = loadTexts(
    db,
    recalled.hits.map((h) => h.id),
  )
  const anchorQuota = Math.floor(budget * SEGMENT_RATIO.anchors)
  const entryQuota = Math.floor(budget * SEGMENT_RATIO.entries)
  const pathQuota = Math.floor(budget * SEGMENT_RATIO.paths)

  interface Built {
    anchorLines: string[]
    anchorsUsed: number
    anchorIds: number[]
    demoted: number
    otherRelated: number
    entryLines: string[]
    entriesUsed: number
    pathLines: string[]
    pathsUsed: number
    text: string
  }

  const build = (): Built => {
    // ── 锚：全文优先；空间不够时后续条目降级为摘要 ──
    const anchorLines: string[] = []
    const anchorIds: number[] = []
    let anchorsUsed = 0
    let demoted = 0
    const cap = Number.isFinite(st.anchorCap) ? Math.max(MIN_ANCHORS, Math.floor(st.anchorCap)) : Infinity
    for (const h of recalled.hits) {
      if (anchorLines.length >= cap) break
      const full = st.anchorToSummary ? h.summary : (fullTexts.get(h.id) ?? h.summary)
      const isSummary = st.anchorToSummary || full === h.summary
      const body = clip(full, st.anchorToSummary ? 64 : anchorMax)
      // 带 atom id：它是 lattice_expand 的入参；id 自增，也就等于天然的写入顺序。
      const line = '- [' + h.id + '] ' + body
      const cost = line.length + 1
      // 前 MIN_ANCHORS 条无论如何都要留下（保底），之后才看配额。
      if (anchorLines.length < MIN_ANCHORS || anchorsUsed + cost <= anchorQuota) {
        anchorLines.push(line)
        anchorIds.push(h.id)
        anchorsUsed += cost
        if (isSummary) demoted++
      } else if (!st.anchorToSummary) {
        const short = '- [' + h.id + '] ' + clip(h.summary, 60)
        const sc = short.length + 1
        if (anchorsUsed + sc <= anchorQuota) {
          anchorLines.push(short)
          anchorIds.push(h.id)
          anchorsUsed += sc
          demoted++
        } else break
      } else {
        break
      }
    }
    const otherRelated = Math.max(0, recalled.hits.length - anchorIds.length)

    // ── 入口：每个命中主题一行 ──
    // 单行上限：入口词条数与主题数都可能很多，不设限会挤占锚段。
    const entryLineMax = opts.entryLineMaxChars ?? DEFAULT_ENTRY_LINE_MAX
    const entryLines: string[] = []
    let entriesUsed = 0
    for (const t of recalled.topics) {
      const terms = topicEntries(db, t.topicId, st.perTopic)
      if (terms.length === 0) continue
      const line = clip('[' + clip(t.label, 16) + '] ' + terms.join(' '), entryLineMax)
      if (entriesUsed + line.length + 1 > entryQuota) break
      entryLines.push(line)
      entriesUsed += line.length + 1
    }

    // ── 路：一跳关联 ──
    const pathLines = st.pathsOff ? [] : pathLinesFor(db, anchorIds, new Set(anchorIds), st.pathLimit)
    const kept: string[] = []
    let pathsUsed = 0
    for (const l of pathLines) {
      if (pathsUsed + l.length + 1 > pathQuota) break
      kept.push(l)
      pathsUsed += l.length + 1
    }

    const parts: string[] = ['【锚】', ...anchorLines]
    if (otherRelated > 0) parts.push('[该主题下另有 ' + otherRelated + ' 条相关记忆]')
    if (entryLines.length > 0) parts.push('', '【入口】', ...entryLines)
    if (kept.length > 0) parts.push('', '【路】', ...kept)
    return {
      anchorLines,
      anchorsUsed,
      anchorIds,
      demoted,
      otherRelated,
      entryLines,
      entriesUsed,
      pathLines: kept,
      pathsUsed,
      text: parts.join('\n'),
    }
  }

  let b = build()
  // 按 TRIM_ORDER 依次降级，直到装得下。
  if (b.text.length > budget) {
    applyTrim(st, 'paths->5')
    trimmed.push('paths->5')
    b = build()
  }
  if (b.text.length > budget) {
    st.perTopic = 4
    trimmed.push('entries->4')
    b = build()
  }
  if (b.text.length > budget) {
    st.anchorToSummary = true
    trimmed.push('anchors->summary')
    b = build()
  }
  if (b.text.length > budget) {
    st.pathsOff = true
    trimmed.push('paths->0')
    b = build()
  }
  if (b.text.length > budget) {
    st.anchorCap = MIN_ANCHORS
    trimmed.push('anchors->3')
    b = build()
  }

  return {
    text: b.text,
    anchors: b.anchorLines.length,
    entryTopics: b.entryLines.length,
    pathLines: b.pathLines.length,
    demotedAnchors: b.demoted,
    otherRelated: b.otherRelated,
    used: {
      anchors: b.anchorsUsed,
      entries: b.entriesUsed,
      paths: b.pathsUsed,
      total: b.anchorsUsed + b.entriesUsed + b.pathsUsed,
    },
    trimmed,
  }
}

/** 应用一个裁剪步骤。集中在一处，便于对照 TRIM_ORDER 审查。 */
function applyTrim(st: { pathLimit: number }, step: TrimStep): void {
  if (step === 'paths->5') st.pathLimit = Math.min(st.pathLimit, 5)
}

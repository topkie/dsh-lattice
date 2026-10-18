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
import { briefMinForDb } from './calibrate.js'
import { DECLARED_ORIGIN, GRAPH_KINDS } from '../graph/infer.js'
import type { RecallResult } from './search.js'
import { FLAG_ARCHIVED, TERM_CHARS, TOPIC_LABEL_CHARS } from './write.js'

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

/**
 * 裁剪第一步把路段行数上限压到的值。
 *
 * 与 DEFAULT_PATH_LINES（15）不是同一个量：那是初始上限，这是「超预算后先降到多少」。
 * 步骤名 `paths->5` 里带着这个值（TRIM_ORDER 是行为契约，测试依赖它的顺序与字面量），
 * 改这里必须同步那个字符串 —— 这也是它此前一直没有名字的代价。
 */
export const TRIM_PATHS_LIMIT = 5

export interface ViewOptions {
  /** 总字符预算。 */
  budget?: number
  /**
   * 注入档位。省略时按召回结果的最高余弦自动判定（无向量时一律 full）。
   * 显式传值只用于测试与对照，正常调用方不该覆盖它。
   */
  tier?: ViewTier
  /** 锚段每条最多给多少字符（全文很长时截断，避免一条吃掉整段）。 */
  anchorMaxChars?: number
  /** 每个主题最多给几条入口。 */
  entriesPerTopic?: number
  /** 单个主题的入口行字符上限（防止一行过长挤占锚段）。 */
  entryLineMaxChars?: number
  /** 路段的整体行数上限。 */
  pathLines?: number
  /**
   * 召回时用的 scope；给了就按同一语义过滤【路】段的邻居。
   *
   * 为什么必须传：锚是召回结果（已按 scope 过滤），而【路】段的邻居是从边里取的。
   * 不传时邻居不受限 —— 别的域里的 atom 摘要会写进注入文本，hits 里却没有它。
   */
  scope?: string
  /**
   * 本地标定值（快照里的「精简档下界」）。**给了就用它，不再按库规模插值**。
   *
   * 为什么由调用方传：快照的读取发生在运行时（state.ts），而 pipeline 层不认识运行时 ——
   * 依赖方向是 `tools → pipeline`，反向引用会把「谁读库」这件事弄乱。
   */
  briefMin?: number
}

export interface ViewResult {
  /** 本次用的档位。写进结果是为了能观测，不是调用方需要读它。 */
  tier: ViewTier
  /** 本次生效的精简档下界（按库规模标定）。写进结果是为了能观测。 */
  briefMin: number
  /** 完整文本，直接注入。 */
  text: string
  /**
   * 本次真正展示的 atom id，按**展示顺序**。
   *
   * 与 `anchors` 的区别：`anchors` 只是条数。给 id 是因为 `lattice_feedback` 的 `ref`
   * 数的是模型看见的那几行（【锚】段），而预算裁剪后展示的条目是 `recalled.hits` 的前缀，
   * 两者容易混淆 —— 把「展示的是哪几条」原样交出去，序号解析才有唯一的依据。
   */
  anchorIds: readonly number[]
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

export const DEFAULT_BUDGET = 6000
export const DEFAULT_ANCHOR_MAX = 1200
export const DEFAULT_ENTRIES_PER_TOPIC = 8
export const DEFAULT_ENTRY_LINE_MAX = 160
export const DEFAULT_PATH_LINES = 15

/**
 * 路段每行摘要的截断长度：20 个词。
 *
 * 路只提供线索，所以比锚段更短；它与 ANCHOR_SUMMARY_CHARS（16 个词）、
 * DEMOTED_ANCHOR_CHARS（15 个词）是三个**不同角色**的截断，不是同一个数的三份拷贝
 * （词数也不同）。三个数都按「一行给几个词 × TERM_CHARS」折算，不再各写一个字符数 ——
 * 此前 80 / 64 / 60 三个字符数彼此只差几个字符，读者看不出它们其实是同一量纲上的三档。
 */
export const PATH_SUMMARY_CHARS = 20 * TERM_CHARS
/** 锚降级为摘要时的截断长度：16 个词（摘录档整段走这条）。 */
export const ANCHOR_SUMMARY_CHARS = 16 * TERM_CHARS
/** 空间不足时把单条锚降级为短摘要所截断的长度：15 个词（与上一条是两条不同分支）。 */
export const DEMOTED_ANCHOR_CHARS = 15 * TERM_CHARS

/**
 * 注入档位：按匹配质量决定这次给多少。
 *
 * 为什么是分档而不是门槛：边界判错时，分档最坏只是相邻档位的效率损失；门槛判错
 * 要么全给要么全不给 —— 而「全不给」正是最坏的那种（模型什么也没看到，却以为自己查过了）。
 *
 * 完整档的线来自实测（279 条基准库、20 条 gold 查询 + 4 条无关查询）：
 *   相关 top1  min 0.524 / p50 0.683 ｜ 无关 top1  max 0.398
 * 两者之间是空的，所以取值本身不敏感；取空隙中间是为了容错，不是为了拟合。
 *
 * 精简档的线**不再是常数**：它是库规模的函数，见 calibrate.ts。原因是那次标定用的 0.45
 * 依赖「无关 top1 上界 0.398」这个前提，而该上界随库长大单调上移（1374 条库上已是 0.515），
 * 于是 0.45 会落进无关分布内部、提示线静默失效。TIER_BRIEF_MIN 保留为**库小到没法标定
 * 时的默认值**，不再等于生效值。
 */
export type ViewTier = 'full' | 'brief' | 'excerpt'

/** 完整档的下界。不参与按库规模重标，理由见 calibrate.ts 末节。 */
export const TIER_FULL_MIN = 0.55
/** 精简档下界的**默认值**（库小于锚点表下端时用它）；生效值见 calibrate.ts。 */
export const TIER_BRIEF_MIN = 0.45

/**
 * 按最高余弦判档。
 *
 * `briefMin` 省略时用 TIER_BRIEF_MIN —— 纯函数口径，测试与对照用；
 * 生产路径由 inferTier 传入按库规模标定出的值。
 */
export function tierOf(topCosine: number, briefMin: number = TIER_BRIEF_MIN): ViewTier {
  if (topCosine >= TIER_FULL_MIN) return 'full'
  if (topCosine >= briefMin) return 'brief'
  return 'excerpt'
}

/** 各档的锚条数上限。full 不设上限，交给预算去管。 */
const TIER_ANCHOR_CAP: Readonly<Record<ViewTier, number>> = {
  full: Number.POSITIVE_INFINITY,
  brief: 8,
  excerpt: MIN_ANCHORS,
}
/** 各档每个主题给几条入口。低相关时入口段是主角，但也要收窄。 */
const TIER_ENTRIES: Readonly<Record<ViewTier, number>> = {
  full: DEFAULT_ENTRIES_PER_TOPIC,
  brief: DEFAULT_ENTRIES_PER_TOPIC,
  excerpt: 4,
}

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

/**
 * 某个主题下命中的 atom 的入口词，按权重降序。
 *
 * 已归档的 atom 不进【入口】段（T26）：它的 entry 行还在库里，但默认不该被看见 ——
 * 漏了这一处，模型仍然能从入口词读出归档内容，而锚段看起来一切正常。
 */
function topicEntries(db: DatabaseSync, topicId: number, limit: number): string[] {
  const rows = db
    .prepare(
      'SELECT e.term AS term, MAX(e.weight) AS w FROM entry e' +
        ' JOIN atom a ON a.id = e.atom_id WHERE a.topic_id = ?' +
        ' AND (a.flags & ' +
        FLAG_ARCHIVED +
        ') = 0' +
        ' GROUP BY e.term ORDER BY w DESC, e.term LIMIT ?',
    )
    .all(topicId, limit) as Array<{ term: string; w: number }>
  return rows.map((r) => String(r.term))
}

/**
 * 一跳关联的摘要行。只走结构化边，且不重复锚里已有的条目。
 *
 * **两条限定是修 bug 加的，不是防御性写法**：改之前这里只检查「边的一端在锚里」，
 * 没检查「另一端也是 atom」。而写入路径产的边全是 `atom → topic`，它的 dst_id 是
 * **topic id** —— 在 id 空间重叠的库上，`JOIN atom ON atom.id = topic_id` 会命中一个
 * 完全无关的 atom，于是【路】段列出一批假邻居，还挂着那条 topic 边的 confidence。
 * 判据里的 graph 通道恒为 0，而这些假行照常出现，所以它长期没有被发现。
 *
 * kind 白名单与 search.ts 的图路共用同一个定义（GRAPH_KINDS），避免两处各写一份。
 */
function pathLinesFor(
  db: DatabaseSync,
  anchors: number[],
  exclude: Set<number>,
  limit: number,
  scope?: string,
): string[] {
  if (anchors.length === 0 || limit <= 0) return []
  const ph = anchors.map(() => '?').join(', ')
  const kinds = GRAPH_KINDS.map((x) => "'" + x + "'").join(', ')
  // 邻居也要过 scope。锚是召回结果（已被 scope 过滤），邻居不是 —— 不过滤时【路】段会把
  // 别的域里的 atom 摘要写进注入文本，虽然 hits 里没有它，模型照样看得见。
  const scopeSql = scope === undefined ? '' : " AND (b.scope = ? OR b.scope = 'global')"
  // 另一端：边的一端落进锚里时，邻居是另一端。两端都是 atom 已由 WHERE 保证。
  const other = 'CASE WHEN e.src_id IN (' + ph + ') THEN e.dst_id ELSE e.src_id END'
  const sql =
    'SELECT e.kind AS kind, e.confidence AS conf, e.origin AS origin, b.id AS oid, b.summary AS summary FROM edge e' +
    ' JOIN atom b ON b.id = ' +
    other +
    " WHERE e.src_type = 'atom' AND e.dst_type = 'atom'" +
    '   AND e.kind IN (' +
    kinds +
    ')' +
    '   AND (e.src_id IN (' +
    ph +
    ') OR e.dst_id IN (' +
    ph +
    '))' +
    '   AND b.id NOT IN (' +
    ph +
    ')' +
    scopeSql +
    // 已归档的邻居不进【路】段（T26）：边还在（归档不删边），但默认不该被看见。
    '   AND (b.flags & ' +
    FLAG_ARCHIVED +
    ') = 0' +
    ' ORDER BY e.confidence DESC LIMIT ?'
  const args: Array<string | number> =
    scope === undefined
      ? [...anchors, ...anchors, ...anchors, ...anchors, limit]
      : [...anchors, ...anchors, ...anchors, ...anchors, scope, limit]
  const rows = db.prepare(sql).all(...args) as Array<{
    kind: string
    conf: number
    origin: string
    oid: number | bigint
    summary: string
  }>
  const seen = new Set<number>()
  const out: string[] = []
  for (const r of rows) {
    const id = Number(r.oid)
    if (exclude.has(id) || seen.has(id)) continue
    seen.add(id)
    // 声明边与推断边**分开标**：前者是模型说过的（真相源，重建后仍在），后者是向量近邻
    // （派生物，重建会整批换掉）。两者在注入文本里长得一样时，模型无法判断这条线索
    // 该不该信 —— 一句「·声明」把这件事说清，且不占置信度那格（declared 恒为 1.0，
    // 显示出来只是噪声）。
    // ORDER BY confidence DESC 因此也把声明边排在推断边前面：声明就是证据。
    const mark = String(r.origin) === DECLARED_ORIGIN ? '·声明' : ' ' + Number(r.conf).toFixed(2)
    out.push('[' + r.kind + mark + '] ' + clip(String(r.summary), PATH_SUMMARY_CHARS))
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
/**
 * 锚段行里的状态标记。
 *
 * 默认（模型写的、未被取代的）**不加标记** —— 大多数记忆都是这一类，给它们各加两个字
 * 只是白占预算。只标需要区分的：用户亲口说的、从别处导入的、已被取代的。
 *
 * 为什么标在锚段、而不是另起一段清单：这三件事都改变「这条记忆该不该信」，而模型读到
 * 锚段的时刻，正是它要做这个判断的时刻。id 本身是自增的，也就等于天然的写入顺序。
 */
function stateMark(h: { origin?: string; supersededBy?: number | null }): string {
  const parts: string[] = []
  if (h.origin === 'user') parts.push('我')
  else if (h.origin === 'import') parts.push('导入')
  if (h.supersededBy !== null && h.supersededBy !== undefined) {
    parts.push('已被 #' + h.supersededBy + ' 取代')
  }
  return parts.length === 0 ? '' : '·' + parts.join('·')
}

/**
 * 按召回结果推断档位。
 *
 * 纯词面模式（无查询向量）没有余弦可依，**不降档** —— 宁可多给几条，也不要因为
 * 「测不出来」而少给：降档是真的丢信息，多给只是多花一点预算。
 */
function inferTier(
  recalled: RecallResult,
  db: DatabaseSync,
  override?: number,
): { tier: ViewTier; briefMin: number } {
  // 纯词面模式没有余弦可依，档位用不到精简档的线；这里仍把标定值算出来，
  // 是为了让结果里的 briefMin 始终是「本库当前生效的那条线」，不至于两种情形下语义不同。
  //
  // override（本地标定值）优先：它是用本库样本重算出来的，比发布方锚点表的插值更贴近本库。
  const briefMin = override ?? briefMinForDb(db, TIER_BRIEF_MIN)
  if (recalled.meta.vectorMissing) return { tier: 'full', briefMin }
  return { tier: tierOf(recalled.meta.topCosine, briefMin), briefMin }
}

export function assembleView(db: DatabaseSync, recalled: RecallResult, opts: ViewOptions = {}): ViewResult {
  const budget = opts.budget ?? DEFAULT_BUDGET
  const anchorMax = opts.anchorMaxChars ?? DEFAULT_ANCHOR_MAX
  const pathLimit = opts.pathLines ?? DEFAULT_PATH_LINES
  const trimmed: TrimStep[] = []

  // 裁剪状态机：每执行一步就重新渲染并检查，直到装得下。
  // 逐步降级而不是一次算到位 —— 每一步的效果都要看真实字符数，预算是字符而非条数。
  //
  // 档位只改**初值**：超预算时仍然按 TRIM_ORDER 依次降级，「锚不为其他段让路」
  // 那条行为契约不因分档而改变，只是起点不同。
  const inferred = inferTier(recalled, db, opts.briefMin)
  const tier = opts.tier ?? inferred.tier
  const st = {
    pathLimit,
    perTopic: opts.entriesPerTopic ?? TIER_ENTRIES[tier],
    anchorToSummary: tier === 'excerpt',
    pathsOff: tier !== 'full',
    anchorCap: TIER_ANCHOR_CAP[tier],
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
      const body = clip(full, st.anchorToSummary ? ANCHOR_SUMMARY_CHARS : anchorMax)
      // 带 atom id：它是 lattice_expand 的入参；id 自增，也就等于天然的写入顺序。
      const line = '- [' + h.id + stateMark(h) + '] ' + body
      const cost = line.length + 1
      // 前 MIN_ANCHORS 条无论如何都要留下（保底），之后才看配额。
      if (anchorLines.length < MIN_ANCHORS || anchorsUsed + cost <= anchorQuota) {
        anchorLines.push(line)
        anchorIds.push(h.id)
        anchorsUsed += cost
        if (isSummary) demoted++
      } else if (!st.anchorToSummary) {
        const short = '- [' + h.id + stateMark(h) + '] ' + clip(h.summary, DEMOTED_ANCHOR_CHARS)
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
      const line = clip('[' + clip(t.label, TOPIC_LABEL_CHARS) + '] ' + terms.join(' '), entryLineMax)
      if (entriesUsed + line.length + 1 > entryQuota) break
      entryLines.push(line)
      entriesUsed += line.length + 1
    }

    // ── 路：一跳关联 ──
    const pathLines = st.pathsOff
      ? []
      : pathLinesFor(db, anchorIds, new Set(anchorIds), st.pathLimit, opts.scope)
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
    tier,
    briefMin: inferred.briefMin,
    text: b.text,
    anchorIds: b.anchorIds,
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
  if (step === 'paths->5') st.pathLimit = Math.min(st.pathLimit, TRIM_PATHS_LIMIT)
}

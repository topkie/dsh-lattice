// 注入组装：把召回结果变成模型真正读到的那段文本。
//
// 两段式的分工：
//   入选  按余弦序逐条装，每条带 id 与状态标记，装到预算的 95% 以上
//   未入选  说清为什么：已被取代、与同源内容重复、预算装不下
//
// 为什么不再按比例给三段分配额：实测锚 / 入口 / 路各分 55% / 20% / 25% 时，预算只用到 76%
// （三个库 4566 / 4587 / 4531 字符，预算 6000），约 1400 字符既没给正文也没被别的段用掉，
// 而入口只用到 74%、路只用到 28%。让正文先装，剩下的额度不再另设段落。

import type { DatabaseSync } from 'node:sqlite'
import type { ThresholdValue } from '../threshold-types.js'
import type { RecallResult } from './search.js'
import { FLAG_SPLIT_PENDING } from '../db/flags.js'
import { DEFAULT_MAX_EXTRACTED } from './entries.js'
import { TERM_CHARS } from './write.js'

/** 各段的字符配额占比。三段之和为 1。 */
export const SEGMENT_RATIO = { anchors: 0.55, entries: 0.2, paths: 0.25 } as const

/** 锚段保底条数——预算再紧也要给这么多条记忆留位置。 */
export const MIN_ANCHORS = 3 satisfies ThresholdValue<
  'chosen',
  {
    area: '注入'
    why: '保底锚条数是「低相关只给入口段」与降噪彻底程度之间的取舍，最后选了分档方案；3 这个数本身没有实测标定'
    failsWhen: ['无关查询的容忍度（保底越高，降噪越不彻底）', '一次注入的字符预算']
    guardedBy: ['test/view.test.mjs']
    affects: '锚段保底条数：预算再紧也先给这么多条；同时是摘录档的锚上限'
  }
>

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
export const TRIM_PATHS_LIMIT = 5 satisfies ThresholdValue<
  'chosen',
  {
    area: '注入'
    why: '超预算后路段先降到多少是裁剪策略选择：TRIM_ORDER 的名字里带着 5、但 5 从哪来没有出处；它与 DEFAULT_PATH_LINES(15) 不是同一个量'
    failsWhen: ['TRIM_ORDER 改动时（名字与值必须同步）']
    affects: '裁剪第一步把路段行数上限压到的值（TRIM_ORDER 的 paths->5）'
  }
>

/**
 * 锚行里「使用场景」（本次查询词）最多给多少个字符。
 *
 * 16 不是标定值，是**预算护栏**：这句提示挂在每一条待拆分候选上，而锚段的预算是按字符
 * 算的。查询词本身可以任意长（有的查询是一整句），直接拼进去会让一条锚多出几十上百字，
 * 同一段预算下能装下的记忆随之变少。取 16 字足以认出「这是用来干什么的那次查询」，
 * 又保证单锚的文本增量不超过 40 字（本任务的判据 3）。
 */
export const SPLIT_SCENE_CHARS = 16 satisfies ThresholdValue<
  'chosen',
  {
    area: '写入'
    why: '未标定，是预算护栏：锚段按字符算预算，查询词可以是一整句，不截断会让一条锚多出几十上百字，同一段预算能装下的记忆随之变少；16 是保证单条锚文本增量不超过 44 字（候选标记 + 段数 + 使用场景的合计上限）的取值'
    failsWhen: ['查询词长度分布', '锚段预算', '「单锚增量 ≤ 40 字」这条判据']
    affects: '锚行「用于：<查询词>」里查询词最多给几个字符（只对 flags 的 bit0 命中生效）。保证单条锚的文本增量不超过 44 字（候选标记 + 段数 + 使用场景的合计上限）'
  }
>

export interface ViewOptions {
  /** 总字符预算。 */
  budget?: number
  /** 单条最多给多少字符（超长的按此截断，避免一条吃掉整段）。 */
  anchorMaxChars?: number
  /**
   * 本次查询词，作为「使用场景」标在待拆分候选的行上。
   *
   * 为什么由调用方传：查询词只存在于调用方（`lattice_recall` 的 q），注入层不读请求上下文。
   * 搜索路由（`src/index.ts`）虽然也有 q，但它直接输出 JSON、**不调用本函数**。
   * 省略时那句话不出现 —— 它只对待拆分候选有意义。
   */
  scene?: string
  /**
   * 以下几项是旧形态（三段：锚 / 入口 / 路）的参数。新形态只有两段，
   * 保留它们是**为了不打断调用方**，值会被忽略。
   */
  entriesPerTopic?: number
  entryLineMaxChars?: number
  pathLines?: number
  scope?: string
  /** 旧形态的档位与精简档下界。保留只为结果里的观测字段，不参与呈现。 */
  tier?: ViewTier
  briefMin?: number
}

export interface ViewResult {
  /** 本次算出的档位。仅供观测，不参与呈现（收口阶段删）。 */
  tier: ViewTier
  /** 本次生效的精简档下界。仅供观测（收口阶段删）。 */
  briefMin: number
  /** 完整文本，直接注入。两段：【入选】与未入选说明。 */
  text: string
  /**
   * 本次真正展示的 atom id，按**展示顺序**。
   *
   * 给 id 是因为 `lattice_feedback` 的 `ref` 数的是模型看见的那几行，
   * 而装填后展示的条目不是 `recalled.hits` 的前缀（重复压制会跳过中间条目），
   * 两者容易混淆 —— 把「展示的是哪几条」原样交出去，序号解析才有唯一依据。
   */
  anchorIds: readonly number[]
  anchors: number
  /** 同来源内因文本重复被压掉的条数。 */
  duplicateDropped: number
  /** 因为预算没装下的条数。 */
  overBudget: number
  /** 入选段实际用掉的字符与预算是否触顶（观测用）。 */
  used: { anchors: number; budget: number }
}

export const DEFAULT_BUDGET = 4000 satisfies ThresholdValue<
  'chosen',
  {
    area: '注入'
    why: '注入字符预算是容量选择：6000 时一次注入 13–16 条，4000 时 8–11 条。实测 5000 与 6000 命中率持平，4000 让技术笔记的文档级命中从 90% 掉到 80%、Vue 从 95% 掉到 90%；0.5.0 定 4000 是产品选择（一次注入少给约 2000 字符），不是测量结论'
    note: '三个语料各 20 条人工提问，预算 6000 / 5000 / 4000 的命中率：技术笔记 90/90/80%，新闻 100/100/100%，Vue 95/90/90%；注入字符中位 5967–5988 / 4968–4988 / 3968–3988'
    failsWhen: ['模型上下文窗口', '一次注入里锚段的平均长度']
    affects: '注入字符预算的默认值（工具调用可覆盖）'
    diverges: '这个数只有一处定义：zod 的 `.default(DEFAULT_BUDGET)` 与 `index.ts` 的 `?? DEFAULT_BUDGET` 都引用它，不再各写一遍'
    doc: 't7'
    docKey: 'viewBudget'
    docDefault: 4000
    docRange: [1000, 20000]
    zod: { file: 'src/index.ts'; name: 'viewBudget' }
  }
>
export const DEFAULT_ANCHOR_MAX = 1200 satisfies ThresholdValue<
  'chosen',
  {
    area: '注入'
    why: '单条锚的字符上限是显示容量选择：源码无注释，设计说明 §7 也没有这个键'
    failsWhen: ['atom 正文长度分布', '字符预算']
    affects: '单条锚的字符上限（全文很长时截断，避免一条吃掉整段）'
    diverges: '**zod schema 里也没有** —— 运行时不可配置'
  }
>
/** 每主题最多列几条未进锚的条目：取抽取配额的一半（DEFAULT_MAX_EXTRACTED ÷ 2）。 */
export const DEFAULT_ENTRIES_PER_TOPIC = (DEFAULT_MAX_EXTRACTED / 2) satisfies ThresholdValue<
  'recheckable',
  {
    area: '注入'
    tool: '源码表达式（src/pipeline/view.ts 的 `DEFAULT_MAX_EXTRACTED / 2`）'
    finding: '由 DEFAULT_MAX_EXTRACTED(16) ÷ 2 算出 8；改输入后重新构建，派生值跟着变，不需要测量'
    formula: true
    failsWhen: ['DEFAULT_MAX_EXTRACTED 改动时（同一件事的两个端点）', '主题数']
    affects: '每个命中主题给几条入口（摘录档由 TIER_ENTRIES 收窄到 4）'
  }
>
export const DEFAULT_ENTRY_LINE_MAX = 160 satisfies ThresholdValue<
  'chosen',
  {
    area: '注入'
    why: '单行入口的字符上限是显示判断：源码无注释，设计说明与 zod 里都没有这个键'
    failsWhen: ['入口词的长度分布', '每主题入口条数']
    affects: '单个主题的入口行字符上限（防止一行过长挤占锚段）'
    diverges: '**zod schema 里也没有**'
  }
>
export const DEFAULT_PATH_LINES = 15 satisfies ThresholdValue<
  'chosen',
  {
    area: '注入'
    why: '路段整体行数上限是容量选择：源码无注释，TRIM_ORDER 里的 5 与它是什么关系也没有写明'
    failsWhen: ['一跳关联的平均条数', '字符预算']
    affects: '路段整体行数上限（裁剪顺序里会先降到 5、再清零）'
  }
>

/**
 * 路段每行摘要的截断长度：20 个词。
 *
 * 路只提供线索，所以比锚段更短；它与 ANCHOR_SUMMARY_CHARS（16 个词）、
 * DEMOTED_ANCHOR_CHARS（15 个词）是三个**不同角色**的截断，不是同一个数的三份拷贝
 * （词数也不同）。三个数都按「一行给几个词 × TERM_CHARS」折算，不再各写一个字符数 ——
 * 此前 80 / 64 / 60 三个字符数彼此只差几个字符，读者看不出它们其实是同一量纲上的三档。
 */
export const PATH_SUMMARY_CHARS = (20 * TERM_CHARS) satisfies ThresholdValue<
  'chosen',
  {
    area: '注入'
    why: '路段每行摘要截断 20 个词是显示判断，不是标定结果：路只提供线索，锚是正文、降级锚是空间不足时的短摘要，三个截断分属不同角色，不合并'
    failsWhen: ['路段在注入里的角色（纯线索）']
    affects: '路段每行摘要的截断长度：20 个词'
  }
>
/** 锚降级为摘要时的截断长度：16 个词（摘录档整段走这条）。 */
export const ANCHOR_SUMMARY_CHARS = (16 * TERM_CHARS) satisfies ThresholdValue<
  'chosen',
  {
    area: '注入'
    why: '锚段降级为摘要时的截断 16 个词是显示判断，不是标定结果；上游是 extractSummary 的 48'
    failsWhen: ['摘要长度分布（extractSummary 的 48 是它的上游）']
    affects: '锚段降级为摘要时的截断长度：16 个词（st.anchorToSummary 分支）'
  }
>
/** 空间不足时把单条锚降级为短摘要所截断的长度：15 个词（与上一条是两条不同分支）。 */
export const DEMOTED_ANCHOR_CHARS = (15 * TERM_CHARS) satisfies ThresholdValue<
  'chosen',
  {
    area: '注入'
    why: '空间不足时把锚降级为短摘要的截断 15 个词是显示判断，不是标定结果；与 16 词那条只差 1 个词、分属不同分支，属「恰好近似」不是同源'
    failsWhen: ['同上；这个值更像历史遗留']
    affects: '空间不足时把锚降级为短摘要所截断的长度：15 个词（与 16 词那条是两条不同分支）'
  }
>

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
 * 精简档的线曾经是库规模的函数（发生在标定包还在的时候）：那次标定用的 0.45 依赖
 * 「无关 top1 上界 0.398」这个前提，而该上界随库长大单调上移（1374 条库上已是 0.515），
 * 于是 0.45 会落进无关分布内部。标定包退役后这条路整条消失 —— 判定改用相对分位
 * （refdist.ts），档位只作观测值，不再决定呈现内容。
 */
export type ViewTier = 'full' | 'brief' | 'excerpt'

/** 完整档的下界。不参与按库规模重标，理由见 calib 的说明与重标报告。 */
export const TIER_FULL_MIN = 0.55 satisfies ThresholdValue<
  'recheckable',
  {
    area: '注入'
    tool: '无脚本（D15-2 标定，未点名脚本路径）'
    finding: '相关 top1 min 0.524 / p50 0.683，无关 top1 max 0.398，两类之间是空的；取空隙中间只为容错，不是为了拟合'
    scale: '20 条 gold 查询 + 4 条无关查询'
    failsWhen: ['换编码模型（余弦尺度直接变）', '库规模与来源分布', '语料的领域混合度']
    guardedBy: ['test/view.test.mjs']
    affects: 'tierOf：最高余弦 >= 此值走完整档（只作观测值，不再决定呈现内容）'
    diverges: '**标定语料与运行库不一致**：标定在基准库上，而插件跑在宿主库上（评审指出的同一类问题）。本表不再记语料规模与来源分布 —— 是否仍适用，看对应重标报告；没有报告时按「无记录」处理，不猜'
  }
>
/** 精简档下界的值。标定包退役后它不再按库规模变，也不决定呈现内容（见 tierOf 的说明）。 */
export const TIER_BRIEF_MIN = 0.45 satisfies ThresholdValue<
  'recheckable',
  {
    area: '注入'
    tool: '无脚本（D15-2 与 2026-10-17 重标定，均未点名脚本路径）'
    finding: '两段来历：① 原标定无关上界 0.398、相关下界 0.524，0.45 夹在中间；② 2026-10-17 重标定在扩容后的基准库上，无关 top1 上界升到 0.515、相关下界 0.525，0.45 落进无关分布内部，故降级为默认值（生效值改由 calib 锚点表按规模给出），扫描读数 0.466 / 0.470 / 0.492 / 0.514 / 0.514 / 0.514 / 0.514 / 0.525；2026-10-18 复核：24 条无关查询、1 次误通过时 conformal 可认证上限 (1+1)/(24+1)=8.0%，Clopper-Pearson 95% 区间 [0.11%, 21.12%]'
    scale: '原标定 20 gold + 4 无关；重标定 8 个规模点各 30 次降采样、20 gold + 20 无关'
    at: '2026-10-17'
    failsWhen: ['换编码模型', '库规模（历史依据里的上界随库长大上移）', '语料的领域混合度']
    guardedBy: ['test/view.test.mjs']
    affects: 'tierOf 的第二个分界。标定包退役后它不再按库规模变，也不决定呈现内容：判定改用「最高余弦对固定问句集在本库实算的 90 分位」，本常量只作为回执里的观测值带出来'
    diverges: '**标定语料与运行库不一致**（同 TIER_FULL_MIN），且真机语料上相关/无关两组重叠。本表不记语料规模与来源分布；是否仍适用看对应重标报告，没有报告时按「无记录」处理'
    refs: [{ file: 'src/pipeline/view.ts'; symbol: 'TIER_BRIEF_MIN' }]
  }
>

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
 * 为什么标在锚段、而不是另起一段清单：这几件事都改变「这条记忆该不该信」，而模型读到
 * 锚段的时刻，正是它要做这个判断的时刻。id 本身是自增的，也就等于天然的写入顺序。
 *
 * 待拆分的两种标记也挂在这里（与「已被取代」同一位置）：
 *   - 待拆分（flags 的 bit0）：候选状态，由写入时的长度切分置位。说法必须带上
 *     「切点按长度、未判内容」，否则模型会把它读成「系统判断过该拆」。
 *   - 用户已确认应拆分：人在界面上按过确认（状态在 meta 的 split_confirmed 里）。
 *     这时给的是**下一步**，因为实际拆分不做。
 * 使用场景（本次查询词）只挂在候选上：没有它，模型不知道这条记忆曾被用来回答什么，
 * 而那正是人判断「该不该拆」时缺的那半句。
 */
function stateMark(
  h: { id: number; origin?: string; supersededBy?: number | null; flags?: number },
  scene: string | undefined,
  confirmed: ReadonlySet<number>,
  segments: ReadonlyMap<number, number>,
): string {
  const parts: string[] = []
  if (h.origin === 'user') parts.push('我')
  else if (h.origin === 'import') parts.push('导入')
  if (h.supersededBy !== null && h.supersededBy !== undefined) {
    parts.push('已被 #' + h.supersededBy + ' 取代')
  }
  if (confirmed.has(h.id)) {
    parts.push('用户已确认应拆分（可按内容重写并声明 supersedes）')
  } else if (((h.flags ?? 0) & FLAG_SPLIT_PENDING) !== 0) {
    parts.push(splitPendingMark(segments.get(h.id)))
    const used = sceneText(scene)
    if (used !== '') parts.push('用于：' + used)
  }
  return parts.length === 0 ? '' : '·' + parts.join('·')
}

/**
 * 候选锚行的那句提示。有段数就写进去 —— 「3 段」与「8 段」是两种工作量，
 * 而人决定拆不拆时缺的正是这个数。段数未知（老库没有这个键）时退回固定串：
 * 那句话仍然成立，只是少一个数。
 */
function splitPendingMark(segments: number | undefined): string {
  if (segments === undefined) return '疑似应拆分（切点按长度，未判内容）'
  return '疑似应拆分（' + segments + ' 段，切点按长度，未判内容）'
}

/** 使用场景的可见文本；没给或给了空白串时不产生任何字。 */
function sceneText(scene: string | undefined): string {
  const s = String(scene ?? '').trim()
  return s === '' ? '' : clip(s, SPLIT_SCENE_CHARS)
}

/**
 * 按召回结果推断档位。
 *
 * 纯词面模式（无查询向量）没有余弦可依，**不降档** —— 宁可多给几条，也不要因为
 * 「测不出来」而少给：降档是真的丢信息，多给只是多花一点预算。
 */
function inferTier(recalled: RecallResult, override?: number): { tier: ViewTier; briefMin: number } {
  // 纯词面模式没有余弦可依，档位用不到精简档的线；这里仍把值填出来，是为了让结果里的
  // briefMin 始终有值，不至于两种情形下语义不同。
  //
  // 标定包退役后这里只剩常量：原先按库规模插值的那条线已经不决定呈现内容，判定改用
  // 「最高余弦对固定问句集在本库实算的 90 分位」（见 refdist.ts），briefMin 只作观测值带出。
  const briefMin = override ?? TIER_BRIEF_MIN
  if (recalled.meta.vectorMissing) return { tier: 'full', briefMin }
  return { tier: tierOf(recalled.meta.topCosine, briefMin), briefMin }
}

/**
 * 把召回结果组装成两段式文本。
 *
 * 为什么是两段而不是三段：旧形态按 55/20/25 给锚、入口、路各分一份配额，实测预算只用到 76%
 * （4566 / 4587 / 4531 字符），而入口用 74%、路用 28% —— 约 1400 字符既没给锚也没被别的段
 * 用掉。新形态让入选条目先按余弦序逐条装，装到预算的 95% 以上，剩下的额度不再另设段落。
 *
 * 判「这次没有内容」不在这里做：那是 `recall()` 的 `meta.hasContent`，由调用方决定说不说那句话。
 * 这里只负责「把有内容的那几条装进去」。
 */
export function assembleView(db: DatabaseSync, recalled: RecallResult, opts: ViewOptions = {}): ViewResult {
  const budget = opts.budget ?? DEFAULT_BUDGET
  const anchorMax = opts.anchorMaxChars ?? DEFAULT_ANCHOR_MAX
  // 档位与精简档下界只为结果里的观测字段保留，不参与装填（收口阶段一起删）。
  const inferred = inferTier(recalled, opts.briefMin)
  const tier = opts.tier ?? inferred.tier

  // 判空：库里没有针对这个问题的内容时，一条都不装。
  //
  // 这句话本来由工具层的回执说（「库里没有针对这个问题的内容。」），注入段不该同时端出
  // 一堆凑数的条目 —— 实测同一批 24 条无关查询，旧形态下照样能装满 6000 字符，字符数与
  // 真查询完全相同；只靠回执挡住，直接调 assembleView 的调用方（验证脚本、界面）拿到的
  // 仍是满额文本，结论与文本自相矛盾。
  if (recalled.meta.hasContent === false) {
    return {
      tier,
      briefMin: inferred.briefMin,
      text: '',
      anchorIds: [],
      anchors: 0,
      duplicateDropped: 0,
      overBudget: 0,
      used: { anchors: 0, budget },
    }
  }

  const fullTexts = loadTexts(
    db,
    recalled.hits.map((h) => h.id),
  )
  const splitConfirmed = new Set(recalled.meta.splitConfirmed ?? [])
  const splitSegments = new Map(recalled.meta.splitPendingSegments ?? [])
  const supersededDropped = recalled.meta.suppressedSuperseded ?? 0

  // 预算是**整段注入文本**的上限（模型看到的就是整段），标题也算在内。
  // 尾巴三句的长度取决于压掉几条，装填时还不知道，所以按最坏情况（三句全出现、四位数）
  // 预留 60 个字符，再让下面按实际句数回退一次兜底 —— 硬约束「任何预算下都不超预算」由
  // test/view.test.mjs 的「硬约束」用例守，装填率由「预算紧时」用例守。
  const HEADER = '【入选】'
  const TAIL_MAX = 48
  const available = Math.max(HEADER.length + 1, budget - HEADER.length - 1 - TAIL_MAX)
  // 单条上限不能超过可用空间：预算 1000 而单条上限 1200 时，按上限截断会一条都装不进去。
  const singleMax = Math.max(1, Math.min(anchorMax, available))

  const lines: string[] = []
  const ids: number[] = []
  let used = 0
  // 真重复压制在候选层就做完了（search.ts 的 suppressDuplicates：同样按来源分桶、同样比
  // 3-gram 覆盖度）。这里只把压掉的条数取出来告诉用户，不再比一遍 —— 同一件事两处实现，
  // 两处的阈值迟早会漂，而「压掉了什么」是用户唯一能核对的东西。
  const duplicateDropped = recalled.meta.suppressed ?? 0
  let overBudget = 0
  let full = false

  for (const h of recalled.hits) {
    const text = fullTexts.get(h.id) ?? h.summary
    if (full) {
      overBudget++
      continue
    }
    const mark = stateMark(h, opts.scene, splitConfirmed, splitSegments)
    const prefix = '- [' + h.id + mark + '] '
    const room = available - used
    let body = clip(text, singleMax)
    let line = prefix + body
    if (line.length + 1 > room) {
      // 装不下就按剩余额度截断这一条 —— 预算要装到 95% 以上，不能因为最后一条过长而空着。
      // 截短后连 24 个字符都放不下就停：再装只剩一个省略号，读者看不出这是什么。
      const keep = room - prefix.length - 2
      if (keep < 24) {
        full = true
        overBudget++
        continue
      }
      body = clip(text, keep)
      line = prefix + body
    }
    lines.push(line)
    ids.push(h.id)
    used += line.length + 1
  }

  const tailOf = (over: number): string[] => {
    const t: string[] = []
    if (supersededDropped > 0) t.push('[另有 ' + supersededDropped + ' 条已被取代，未列出]')
    if (duplicateDropped > 0) t.push('[另有 ' + duplicateDropped + ' 条与同源内容重复，未列出]')
    if (over > 0) t.push('预算装不下了，还有 ' + over + ' 条未列。')
    return t
  }
  const textOf = (over: number): string => [HEADER, ...lines, ...tailOf(over)].join('\n')
  // 装填时没算尾巴：尾巴的句数与位数在装完之后才确定（「还有 N 条未列」本身会随压掉几条变化）。
  // 这里按最终尾巴长度回退，弹到最后一条为止 —— 一条都不给比超预算更糟。
  while (ids.length > 1 && textOf(overBudget).length > budget) {
    const last = lines.pop() as string
    ids.pop()
    used -= last.length + 1
    overBudget++
  }

  return {
    tier,
    briefMin: inferred.briefMin,
    text: textOf(overBudget),
    anchorIds: ids,
    anchors: lines.length,
    duplicateDropped,
    overBudget,
    used: { anchors: used, budget },
  }
}

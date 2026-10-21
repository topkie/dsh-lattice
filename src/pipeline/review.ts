// 写入侧审核层（M3-T22）：按「修复成本」把一次写入分成三级处理。
//
// 分级的原则不是「问题有多严重」，而是「**修错的代价有多大**」：
//
//   自动处理  长度类 —— 过短（碎片）/ 过长（一次写了太多件事）。
//             判据只看文本本身（不依赖库的分布，客观），修起来是切一刀 / 合一合（便宜）。
//   提示      重复 / 高相似 —— 与库里已有内容的字面重合。
//             「是不是重复」要判断**意图**（同一件事换个说法不等于重复），而判错要把
//             该留的并掉 —— 静默的知识损坏。所以这里只把证据交回调用方，写入照常进行。
//   不处理    其余 —— 原样写入。
//
// **边界（设计报告 §11.1「判定归模型，可见性归插件」）**：判据归模型，插件只提供判断
// 所需的信息。本模块产出的一切都**只走 `lattice_write` 的返回值**：不写库、不建队列、
// 不弹窗、不产生需要人处理的待办。下面三个函数里只有 `findDuplicate` 读库，且是只读。
//
// **阈值尽量不新造**（§44「复用已有判据，不发明新阈值」）：
//   过长     ← migrate/split.ts 的 MAX_ATOM_CHARS（写入正文与迁移小节受同一组约束：
//              FTS 索引体积 + 落位会被平均掉）
//   重复     ← pipeline/search.ts 的 DUP_COS / DUP_LEX（§20 的「重复的几何判据」）
//   高相似   ← pipeline/forget.ts 的 tauLex / tauJoin / nearCos（与防写回同一组票）
// 新造的只有三个数，且都不是从语料标定出来的：碎片线、切分段数上限、扫描条数上限。
// 三个都在 src/thresholds.ts 里如实登记了它们的出处。

import type { DatabaseSync } from 'node:sqlite'
import type { ThresholdValue } from '../threshold-types.js'
import { MAX_ATOM_CHARS, MIN_ATOM_CHARS, splitBySentence } from '../migrate/split.js'
import { bigramTerms, jaccard } from '../util/text.js'
import { cosine, decodeVec, isValidVecBlob } from '../util/vec.js'
import { DEFAULT_FORGET_THRESHOLDS } from './forget.js'
import { DUP_COS, DUP_LEX } from './search.js'

/**
 * 碎片线：正文字符数低于它的写入不落库。
 *
 * **为什么不复用 MIN_ATOM_CHARS（80）**：那是**迁移**的界 —— 它切的是卡片里的小节，
 * 一个小节短于 80 字通常真的没有独立检索价值。写入侧不是同一种输入：`lattice_write`
 * 的契约是「一句话讲清一个结论」，而一句合法的参数型结论（「本机代理端口是 7890。」）
 * 只有十几个字。把迁移的界直接搬过来会拦掉大量合法写入 —— 那正是本表开头说的
 * 「阈值取自某个场景却用在另一个场景」这一类错误。
 *
 * **12 的出处与为什么取靠下的那个数**：
 *   - 基准库 1374 条 atom 的正文长度分布里，低于 12 字的只有 2 条（0.15%），
 *     且两条都是 `---` 这种不可能被召回的空壳；第 3 短的一条（29 字）已经是一句完整结论。
 *   - 真机库 2026-10-17 现取 14 条，最短 81 字，0 条低于此线。
 *   - 也就是说 **3 字与 29 字之间一个实测样本都没有**，这条线落在空档里，位置本身不敏感。
 *     既然如此就取**靠下**的一端：误拦让一条合法记忆写不进去（调用方当场收到失败，
 *     用户看得见），漏拦只是库里多一条短记忆（可在召回里被压下去）。两类错误代价不对称，
 *     与 `write.ts` 标定 tauJoin 时「取底线而非中点」是同一条理由。
 *   - **不是在运行语料上标定的**：真机库样本量不足以定下界（见报告「未确定项」）。
 */
export const REVIEW_MIN_CHARS = 12 satisfies ThresholdValue<
  'recheckable',
  {
    tool: '无脚本（一次分布核对，未点名脚本路径）'
    finding: '**不是标定值，是一次分布核对**：基准库正文字符数分布里低于 20 字的只有 2 条（0.15%），且两条都是 `---` 这种不可能被召回的空壳；第 3 短的一条（29 字）已是一句完整结论。真机库 2026-10-17 现取 14 条、最短 81 字，样本量不足以定下界。依据是「在基准库上只抓空壳」+「一句合法中文结论的下界约 15 字」，不是运行语料上的标定；刻意不复用 MIN_ATOM_CHARS(80)'
    scale: '基准库 1374 条 atom（真机库 14 条）'
    at: '2026-10-17'
    failsWhen: ['「一句话讲一件事」这条写入约定的实际长度分布', '语言', '正文里是否允许单句参数']
    guardedBy: ['test/review.test.mjs']
    affects: '写入侧审核「自动处理·过短」：正文短于它的写入被拦下、不落库'
    diverges: '`lattice_write` 的入参契约里也没有这条下限'
  }
>

/** 过长线：与迁移切分共用同一个界（同一个函数切、同一组约束）。 */
export const REVIEW_MAX_CHARS = MAX_ATOM_CHARS satisfies ThresholdValue<
  'chosen',
  {
    why: '它直接引用 migrate/split.ts 的 MAX_ATOM_CHARS，是同一个数、同一个界；该界本身无标定记录（两条路径受同一组约束：FTS 索引体积、落位会被平均掉），没有测量给出它'
    failsWhen: ['同 MAX_ATOM_CHARS（atom 正文长度分布、FTS 索引体积、落位质量）']
    guardedBy: ['test/migrate.test.mjs', 'test/review.test.mjs']
    affects: '写入侧审核「自动处理·过长」：正文长于它的写入按句自动切分后分别写入'
  }
>

/**
 * 一次写入（切分 + 逐段落库）的耗时预算，毫秒。
 *
 * 这是**产品侧的时延预算**，不是从语料标定出来的：一次工具调用最多花 1 秒。
 * 它只用来把下面两个结构性上界换算成具体条数。
 */
export const REVIEW_WRITE_BUDGET_MS = 1000 satisfies ThresholdValue<
  'chosen',
  {
    why: '产品侧时延预算，不是语料标定：一次工具调用最多花 1 秒，没有实测出处，取值是判断；只用来换算切分段数上限'
    failsWhen: ['宿主对一次工具调用的时延预期']
    affects: '一次写入（切分 + 逐段落库）的时间预算；只用来换算切分段数上限'
    display: '{v} ms'
    unit: 'ms'
  }
>

/**
 * 单段写入的实测耗时，毫秒。
 *
 * 2026-10-18 在 1374 条 atom 的库副本上量得 111–148 ms（8 次单段写入；每段含一次编码
 * 与一次全量词表重建，后者约占 113 ms）。取区间中位附近的 125 ms。换机器、换库规模时
 * 这个数会变 —— 它记的是「本机一次实测」，不是常数。
 */
export const REVIEW_SEGMENT_MS = 125 satisfies ThresholdValue<
  'recheckable',
  {
    tool: '无脚本（本机实测，未点名脚本路径）'
    finding: '8 次单段写入耗时 111–148 ms（每段含一次编码与一次全量词表重建，后者约 113 ms），取 125 ms；换机器或库规模会变，届时上限自动跟着变'
    scale: '1374 条 atom 的库副本，8 次单段写入'
    at: '2026-10-18'
    failsWhen: ['编码器速度', '词表重建耗时（库规模）']
    affects: '把写入预算换算成段数：1000 / 125 = 8'
    display: '{v} ms（本机实测的单段写入耗时）'
    unit: 'ms'
  }
>

/**
 * 一次写入最多切成多少段：**由时间预算 ÷ 单段实测耗时派生**（1000 / 125 = 8）。
 *
 * 原先直接写 8，依据是「一条记忆里不该装着 8 件以上的事」—— 那条判断仍然成立，现在
 * 同一个整数另有了一条可复算的来源：超过时间预算的切分，写入会变成秒级卡顿。两种口径
 * 给出同一个数，才保留 8；任一条变了，这个值会跟着动，而不是继续写死。
 *
 * 为什么不是「不设上限」：每段都要过一次编码器与词表重建，段数不设上限等于让一次调用
 * 把写入路径变成秒级卡顿。
 */
export const REVIEW_MAX_SEGMENTS = Math.floor(
  REVIEW_WRITE_BUDGET_MS / REVIEW_SEGMENT_MS,
) satisfies ThresholdValue<
  'recheckable',
  {
    tool: '源码表达式（src/pipeline/review.ts 的 `REVIEW_WRITE_BUDGET_MS / REVIEW_SEGMENT_MS`）'
    finding: '由 REVIEW_WRITE_BUDGET_MS ÷ REVIEW_SEGMENT_MS 算出 8；改输入后重新构建，派生值跟着变。旧口径「一条记忆里不该装着 8 件以上的事」与时间预算给出同一个整数'
    formula: true
    failsWhen: ['单段写入耗时（编码器与词表重建）', '一次工具调用的时延预算']
    guardedBy: ['test/review.test.mjs']
    affects: '一次写入最多自动切成多少条；超过则整条不写入，交回调用方自己拆'
    display: '{v}（= 写入预算 {REVIEW_WRITE_BUDGET_MS} ms ÷ 单段实测 {REVIEW_SEGMENT_MS} ms）'
  }
>

/** 重复检测的时间预算，毫秒：每次写入都要走这一段，只给它 10 ms。 */
export const REVIEW_SCAN_BUDGET_MS = 10 satisfies ThresholdValue<
  'chosen',
  {
    why: '产品侧时延预算，不是语料标定：重复检测加在每次写入上，只给它 10 ms，是判断；只用来换算一次比对多少条成员'
    failsWhen: ['宿主对一次工具调用的时延预期']
    affects: '重复检测的时间预算；只用来换算一次比对多少条成员'
    display: '{v} ms'
    unit: 'ms'
  }
>

/**
 * 单条成员比对的实测耗时，毫秒。
 *
 * 2026-10-18 在基准库最大的主题（37 个成员）上量得：findDuplicate 单次 1.663 ms ÷ 37
 * ≈ 0.045 ms/条；纯比对循环（bigram-Jaccard + 512 维余弦）另测得 0.038 ms/条。
 * 取 0.05（向上取整）—— 宁可少扫几条，也不要让判定卡在预算边缘。
 */
export const REVIEW_MEMBER_SCAN_MS = 0.05 satisfies ThresholdValue<
  'recheckable',
  {
    tool: '无脚本（本机实测，未点名脚本路径）'
    finding: '在基准库最大主题上 findDuplicate 单次 1.663 ms、均摊 0.045 ms/条；纯比对循环（bigram-Jaccard + 512 维余弦）0.038 ms/条；取 0.05（向上取整，宁可少扫）'
    scale: '基准库最大主题 37 个成员'
    at: '2026-10-18'
    failsWhen: ['成员正文长度', '向量维度']
    affects: '把扫描预算换算成条数：10 / 0.05 = 200'
    display: '{v} ms（本机实测的单条比对耗时，向上取整）'
    unit: 'ms'
  }
>

/**
 * 重复 / 高相似一次最多比多少个同主题成员：**由扫描预算 ÷ 单条实测耗时派生**
 * （10 / 0.05 = 200）。
 *
 * 原先直接写 200，依据是「足以覆盖同一个主题下的近期成员」。这个覆盖判断与时间预算
 * 在今天的实测上给出同一个数。到上限时不静默 —— 结果里带 `scanned` / `truncated`，
 * 调用方能分清「比过了不重复」与「根本没比完」。
 */
export const REVIEW_SCAN_LIMIT = Math.floor(
  REVIEW_SCAN_BUDGET_MS / REVIEW_MEMBER_SCAN_MS,
) satisfies ThresholdValue<
  'recheckable',
  {
    tool: '源码表达式（src/pipeline/review.ts 的 `REVIEW_SCAN_BUDGET_MS / REVIEW_MEMBER_SCAN_MS`）'
    finding: '由 REVIEW_SCAN_BUDGET_MS ÷ REVIEW_MEMBER_SCAN_MS 算出 200；改输入后重新构建，派生值跟着变。旧口径「200 条足以覆盖同一主题下的近期成员」与时间预算给出同一个整数'
    formula: true
    failsWhen: ['单个主题的成员数分布', 'atom 正文的平均长度']
    affects: '重复 / 高相似检测一次最多比多少个同主题成员（**只读，不写库**）'
    display: '{v}（= 扫描预算 {REVIEW_SCAN_BUDGET_MS} ms ÷ 单条实测 {REVIEW_MEMBER_SCAN_MS} ms）'
  }
>

export interface ReviewThresholds {
  minChars: number
  maxChars: number
  maxSegments: number
  scanLimit: number
  dupCos: number
  dupLex: number
  tauJoin: number
  tauLex: number
  tauLexOnly: number
  nearCos: number
}

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  minChars: REVIEW_MIN_CHARS,
  maxChars: REVIEW_MAX_CHARS,
  maxSegments: REVIEW_MAX_SEGMENTS,
  scanLimit: REVIEW_SCAN_LIMIT,
  dupCos: DUP_COS,
  dupLex: DUP_LEX,
  tauJoin: DEFAULT_FORGET_THRESHOLDS.tauJoin,
  tauLex: DEFAULT_FORGET_THRESHOLDS.tauLex,
  tauLexOnly: DEFAULT_FORGET_THRESHOLDS.tauLexOnly,
  nearCos: DEFAULT_FORGET_THRESHOLDS.nearCos,
}

/** 审核级别。`auto` = 插件动了手；`hint` = 只把证据交回去。 */
export type ReviewLevel = 'auto' | 'hint'

export type ReviewCode = 'too-short' | 'too-long' | 'duplicate' | 'near-duplicate'

/**
 * 一条审核结果。**它的消费者是模型，不是日志** —— 所以 message 写成一个可直接照做的
 * 句子，而不是一个错误码加一段说明。
 */
export interface ReviewNote {
  level: ReviewLevel
  code: ReviewCode
  message: string
}

/** 长度审核的结论。 */
export type LengthAction = 'keep' | 'split' | 'reject'

export interface LengthReview {
  action: LengthAction
  /** `action='split'` 时是各段正文（已做过过短段合并）；其余情况为空。 */
  segments: string[]
  note: ReviewNote | null
}

/**
 * 切分后把过短的小段并回相邻段。
 *
 * 语义与 migrate/split.ts 的 `draftAtoms` 一致（那里是「短小节向后并」）：合并的方向必须
 * 与迁移一致，否则同一段文本在两条路径上会切出不同的原子。
 *
 * 与迁移的唯一差别：**并完不再检查上界**。迁移那边也不查。多出来的几十个字落在
 * `buildSearchBody` 的 1600 字截断之内，代价只是那一段略长，而不是又一次切分。
 */
function mergeShortSegments(segments: readonly string[]): string[] {
  const out: string[] = []
  for (const s of segments) {
    const last = out[out.length - 1]
    if (last !== undefined && last.length < MIN_ATOM_CHARS) {
      out[out.length - 1] = last + '\n\n' + s
      continue
    }
    out.push(s)
  }
  // 收尾：最后一段仍过短、且前面还有内容时就并回前一段（没有「下一段」可并了）。
  const tail = out[out.length - 1]
  if (tail !== undefined && out.length > 1 && tail.length < MIN_ATOM_CHARS) {
    const prev = out[out.length - 2]!
    out[out.length - 2] = prev + '\n\n' + tail
    out.pop()
  }
  // 只切出一段时不叫切分 —— 原样写入，连提示都不给（避免「看起来在工作」的恒真提示）。
  return out
}

/**
 * 长度审核：**只看文本，不碰库**。
 *
 * 三个出口对应三级里的两级：「自动处理」在这里动手（拦下碎片 / 预先切好），
 * 「不处理」原样放行。重复与高相似不在这里 —— 它们要读库，见 `findDuplicate`。
 */
export function reviewLength(text: string, t: ReviewThresholds = DEFAULT_REVIEW_THRESHOLDS): LengthReview {
  const body = String(text ?? '').trim()
  if (body.length < t.minChars) {
    return {
      action: 'reject',
      segments: [],
      note: {
        level: 'auto',
        code: 'too-short',
        message:
          '这条只有 ' +
          body.length +
          ' 个字（下限 ' +
          t.minChars +
          '），没有独立检索价值，**未写入**。它应当**合并**进它所解释的那条记忆：' +
          '把上下文补进去重写一次，或直接用 lattice_list 找到那条、把这句话并进它的正文。',
      },
    }
  }
  if (body.length <= t.maxChars) return { action: 'keep', segments: [body], note: null }

  const segments = mergeShortSegments(splitBySentence(body, t.maxChars))
  if (segments.length <= 1) return { action: 'keep', segments: [body], note: null }
  if (segments.length > t.maxSegments) {
    return {
      action: 'reject',
      segments: [],
      note: {
        level: 'auto',
        code: 'too-long',
        message:
          '这条 ' +
          body.length +
          ' 个字会被切成 ' +
          segments.length +
          ' 条，超过一次写入的上限 ' +
          t.maxSegments +
          ' 条 —— 这个量已经不是一条记忆而是一篇文档了，**未写入**。请自己按主题拆成多次写入。',
      },
    }
  }
  return {
    action: 'split',
    segments,
    // 措辞只给后果、不给判断（T29 判据 7）：切点是**按长度**定的，这里没有读过内容。
    // 早先写的是「装了不止一件事」—— 那句话替写入方做了一个它没做过的判断。
    note: {
      level: 'auto',
      code: 'too-long',
      message:
        '这条 ' +
        body.length +
        ' 个字超过单条上限，已**按长度切成 ' +
        segments.length +
        ' 条**分别写入（切点按句边界定，没有按内容判断；过短的段已并回相邻段）。',
    },
  }
}

/** 命中的重复项。留着结构化字段是为了让用例能直接断言数字，而不是去解析文案。 */
export interface DuplicateHit {
  code: 'duplicate' | 'near-duplicate'
  atomId: number
  summary: string
  /** 与那条的余弦；无向量 / 向量不可比时为 null。 */
  cos: number | null
  /** 与那条的词面重叠（正文 bigram-Jaccard）。 */
  lex: number
}

/** 这次比对的范围，用于区分「比过了不重复」与「根本没比完」。 */
export interface DuplicateScan {
  hit: DuplicateHit | null
  scanned: number
  truncated: boolean
}

interface AtomRow {
  id: number | bigint
  text: string
  summary: string
  embedding: Uint8Array
}

function isAllZero(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false
  return true
}

/** 向量指纹不可比时返回 null，不硬算 —— 与落位、防写回同一处理。 */
function vectorFromBlob(blob: Uint8Array | null | undefined): Float32Array | null {
  if (blob === null || blob === undefined) return null
  const raw = blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBufferLike)
  if (!isValidVecBlob(raw)) return null
  const v = decodeVec(raw)
  return isAllZero(v) ? null : v
}

/**
 * 重复 / 高相似检测：与**主属主题内**已有的记忆比一遍。
 *
 * **为什么只比一个主题，而不是全库**：写入侧的落位判定已经决定了这条要并进哪个主题 ——
 * 一条真正的重复必然落在同一个主题里（否则它早就被落位分开了，那是另一个问题）。
 * 全库扫是 O(库规模)，而写入是热路径；只扫主属主题把代价钉在「主题成员数」上，
 * 再用 `scanLimit` 封顶。代价是**跨主题的重复不会被提示**，这是刻意的取舍。
 *
 * **为什么不阻止**：判据是几何相似度，「相似」不等于「同一件事」—— 同义改写要拦，
 * 同一主题下的相邻结论不能拦。判错的代价是静默覆盖一条有信息的记忆，而收益只是
 * 少一条重复。所以这里只报，**写入照常**。
 */
export function findDuplicate(
  db: DatabaseSync,
  text: string,
  vec: Float32Array | null,
  topicId: number,
  t: ReviewThresholds = DEFAULT_REVIEW_THRESHOLDS,
): DuplicateScan {
  // 新建主题时主题里还没有成员，「重复」在这个时刻不成立。
  if (!Number.isFinite(topicId) || topicId <= 0) return { hit: null, scanned: 0, truncated: false }

  const total = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM atom WHERE topic_id = ?').get(topicId) as { n: number | bigint })
      .n,
  )
  if (total === 0) return { hit: null, scanned: 0, truncated: false }

  const rows = db
    .prepare(
      'SELECT id, text, summary, embedding FROM atom WHERE topic_id = ? AND superseded_by IS NULL ORDER BY id ASC LIMIT ?',
    )
    .all(topicId, t.scanLimit) as unknown as AtomRow[]

  const atomLex = bigramTerms(text)
  const usable = vec !== null && !isAllZero(vec)
  let best: DuplicateHit | null = null
  let bestRank = -1
  for (const r of rows) {
    const lex = jaccard(atomLex, bigramTerms(String(r.text)))
    let cos: number | null = null
    if (usable) {
      const other = vectorFromBlob(r.embedding)
      if (other !== null && other.length === vec.length) cos = cosine(vec, other)
    }
    const code = classify(cos, lex, usable, t)
    if (code === null) continue
    // 排序：余弦优先（区分度更高），并列看词面 —— 与 forget.ts 的 rank 同一口径。
    const rank = (cos ?? 0) * 2 + lex
    if (rank <= bestRank) continue
    bestRank = rank
    best = { code, atomId: Number(r.id), summary: String(r.summary), cos, lex }
  }
  return { hit: best, scanned: rows.length, truncated: total > rows.length }
}

/**
 * 两级判据。**都是复用来的，一个新数都没造**：
 *
 *   重复     余弦 >= DUP_COS(0.92) 且 词面 >= DUP_LEX(0.72) —— 几乎逐字重复。
 *             §20 的去重判据，标定记录说「只有几乎逐字重复才会被压制」。
 *   高相似   两票（词面 >= tauLex 且 余弦 >= tauJoin）或几何兜底（余弦 >= nearCos）
 *             —— 与防写回 (`checkForgotten`) 逐条同源：同一个「是不是同一件事」的判据，
 *             只是一个比墓碑、一个比活着的 atom。
 *   无向量   词面单独抬到 tauLexOnly（与落位在降级时的方向一致）。
 */
function classify(
  cos: number | null,
  lex: number,
  usable: boolean,
  t: ReviewThresholds,
): 'duplicate' | 'near-duplicate' | null {
  if (cos !== null) {
    if (cos >= t.dupCos && lex >= t.dupLex) return 'duplicate'
    if (lex >= t.tauLex && cos >= t.tauJoin) return 'near-duplicate'
    if (cos >= t.nearCos) return 'near-duplicate'
    return null
  }
  if (!usable && lex >= t.tauLexOnly) return 'near-duplicate'
  return null
}

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + '…')

/** 把命中翻成给模型的提示。写入**照常**，所以措辞是「已写入，另外……」而不是「没写入」。 */
export function duplicateNote(hit: DuplicateHit, truncated: boolean): ReviewNote {
  const how = hit.code === 'duplicate' ? '几乎重复' : '高度相似'
  const cos = hit.cos === null ? '无（向量不可比）' : hit.cos.toFixed(3)
  return {
    level: 'hint',
    code: hit.code,
    message:
      '【提示·未阻止】与本主题的 #' +
      hit.atomId +
      ' ' +
      how +
      '（余弦 ' +
      cos +
      '，词面 ' +
      hit.lex.toFixed(3) +
      '）：' +
      clip(hit.summary, 40) +
      '。**若说的是同一件事**，把两条收成一条（本条改成对旧条目的修订，或把旧条目作废）；' +
      '**若只是同一主题下的相邻结论**，忽略本条即可 —— 这条判据只报不改。' +
      (truncated ? '（只比对了最近 ' + REVIEW_SCAN_LIMIT + ' 条，未覆盖全主题）' : ''),
  }
}

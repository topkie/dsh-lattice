// 入口（Entry）生成：写入侧的词面索引来源。
//
// 入口是「免 token 的检索键」——它不进入正文向量，因此**不影响知识正交**：无论入口
// 造得多还是少，topic 中心、归属判定、切分评分都不看它一眼。入口只影响召回能不能
// 找到这条记忆。所以这里的取向很明确：宁可多给几个不那么优雅的入口，也不要漏。
//
// 三级权重（declared 1.0 / extracted 0.6 / learned 0.3）：写入侧只产前两级，
// learned 由召回命中反哺 —— 反哺也在这个模块里（feedLearned），但不在写入路径上：
// 它由 lattice_recall 工具在返回前显式调用。入口不进正文向量，所以这一层冗余
// 不影响知识正交。

import type { DatabaseSync } from 'node:sqlite'
import type { ThresholdValue } from '../threshold-types.js'
import { bigramTerms, toSearchColumn } from '../util/text.js'
import { log } from '../log/index.js'

/** 入口级别。learned 由召回反哺，不在写入侧产生。 */
export type EntryOrigin = 'declared' | 'extracted' | 'learned'

/** 一条待落库的入口。 */
export interface EntryRecord {
  term: string
  bigram: string
  weight: number
  origin: EntryOrigin
}

export interface EntryOptions {
  /** 每个 atom 抽取的入口数上限。 */
  max?: number
  /** 写入方显式声明的入口（原样保留，不参与抽取竞争）。 */
  declared?: Iterable<string>
}

/** 基础权重——级别越高越可信。 */
export const ENTRY_WEIGHT: Readonly<Record<EntryOrigin, number>> = {
  declared: 1.0,
  extracted: 0.6,
  learned: 0.3,
}

/**
 * 默认抽取数。
 *
 * **这个值是实测调上来的**：原设计取 8，理由是「每 atom 8 条入口，索引体积可忽略」。
 * 但中文没有词边界，一段 25 字的记忆会切出约 17 个 bigram，取前 8 等于丢掉一半候选 ——
 * 实测「大文件下载要走代理，但回环地址不能走代理」这条，两次出现的「代理」都被挤出
 * 前 8，只剩「走代」，于是查「代理」时它一无所获。
 *
 * 放宽到 16 后同一批查询全部命中。代价是入口行数翻倍，但入口索引只占 trigram 正文层
 * 的百分之几，而**召回不到是功能损失、索引变大只是存储成本**，两者不对等。
 * 真实记忆通常 40~180 字，16 个槽位基本覆盖得住。
 */
export const DEFAULT_MAX_EXTRACTED = 16 satisfies ThresholdValue<
  'recheckable',
  {
    area: '入口'
    tool: '无脚本（2026-10-17 全库扫描与配对 bootstrap，未点名脚本路径）'
    finding: '纯 Entry 路 gold 召回 8 与 12 比 16 低 25 个百分点（95% 区间不含 0），16→32 只多 10 个百分点（区间含 0），16 是收益拐点；端到端在 8~32 全区间不动；三种预算化形态都不优于固定 16'
    scale: '六点 + 四个补点的全库扫描（配对 bootstrap 4000 次）'
    at: '2026-10-17'
    failsWhen: ['中文 bigram 的候选密度（切词规则）', '正文长度分布', '语料语言']
    affects: '每个 atom 抽取的入口数上限（declared 入口不参与这个竞争）'
  }
>

/**
 * 入口抽取规则标识。
 *
 * **任何会改变抽取结果的改动都必须改这个值**：库会把它记进 meta 表，验证脚本据此
 * 判断基准库与当前代码是不是同一套规则。漏改的后果很隐蔽 —— 跨规则对比得出的差值
 * 会被当成那次改动的效果，而它其实只是规则差异。
 *
 * v1：候选只过滤长度、空白与虚字。
 * v2：候选必须是纯字母或汉字（`u4e00`、`0x1c`、`9_`、`v1` 这类残片出局）。
 * v3：词表改从正文统计（原先数的是「已被选中的词」，让 IDF 退化成字典序）；
 *     边界自由度为零的候选降权；并列时按语料频次兜底而不是字典序；
 *     整段中文（原文切片）限制在四字以内且不许含虚字。
 * v4：删掉单字虚词表，两处调用点都换成同一个几何判据（边界自由度为零即出局）。
 *     字表是人工语言知识，与「插件侧全是几何运算」冲突；换算的依据与实测见
 *     hasBoundaryFreedom 与 isUsableTerm 的注释。
 */
export const ENTRY_RULE_ID = 'bigram-idf-v4'

/** 95% 置信区间的 z 值（双侧）。只用于推导 MIN_VOCAB_FOR_DF 的语料规模线。 */
export const DF_FILTER_CONFIDENCE_Z = 1.96 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '95% 双侧正态分位是统计惯例，不是在本库上标定的值；它只用于把规模线换算成可复算的数，不参与运行时判定'
    failsWhen: ['对规模线置信水平的要求']
    affects: '推导 MIN_VOCAB_FOR_DF 时的置信水平；不参与运行时的过滤判定'
    display: '{v}（95% 双侧）'
  }
>

/**
 * 泛词线处可接受的 95% 区间半宽：四分之一个比例单位。
 *
 * 这是一个**精度要求**，不是从语料标定出来的：df/N 的估计误差超过四分之一时，
 * 「大约一半」与「大约四分之一」就分不开，df/N > 0.5 这条判据也就无从谈起。
 */
export const DF_FILTER_HALF_WIDTH = 0.25 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '对 df/N 估计精度的要求：误差超过四分之一时「大约一半」与「大约四分之一」分不开。取值是判断而不是语料标定'
    failsWhen: ['对 df/N 估计精度的要求']
    affects: '推导 MIN_VOCAB_FOR_DF 时的精度要求；不参与运行时的过滤判定'
    display: '{v}（四分之一个比例单位）'
  }
>

/** p=0.5 处、样本量为 n 的 Wilson 95% 区间半宽。 */
function wilsonHalfWidthAtHalf(n: number, z: number): number {
  const z2 = z * z
  return (z / (1 + z2 / n)) * Math.sqrt(0.25 / n + z2 / (4 * n * n))
}

/** 满足「半宽不超过目标」的最小语料规模。半宽随 n 单调收窄，线性找第一个即可。 */
function minCorpusForDfHalfWidth(
  z: number = DF_FILTER_CONFIDENCE_Z,
  target: number = DF_FILTER_HALF_WIDTH,
): number {
  // 上限只防死循环：任何合理的半宽目标都会在几十以内收敛。
  for (let n = 2; n <= 1000; n++) if (wilsonHalfWidthAtHalf(n, z) <= target) return n
  return 1000
}

/**
 * 泛词过滤（df/N > 0.5）生效所需的最小语料规模：**由区间半宽派生**。
 *
 * 低于这个规模，「出现在半数 atom 里」不携带任何信息：库里 2 条记忆时出现一次就是
 * 半数，于是两个词都会被当作泛词丢掉。英文语料上这个问题不明显（词表大），
 * 中文 bigram 候选密集，小库上会被放得很大。
 *
 * **规模线是算出来的，不是拍出来的**：要求 df/N 在 p=0.5 处的 95% Wilson 区间半宽
 * 不超过 DF_FILTER_HALF_WIDTH（0.25）。半宽随 N 单调收窄，满足条件的最小 N 就是 12
 * （N=11 时约 0.254，N=12 时约 0.246）—— 与旧值逐位相同，所以每个词的 df 触发点
 * 一条也不变。
 *
 * **为什么不用「Wilson 下限 > 0.5」当判据**：那会改变触发点（N=12 时要 df≥10 才触发，
 * 旧判据是 df≥7；N=279 时要 df≥156，旧判据是 df≥140）—— 那是改行为，不是换实现。
 * 这里只把「规模够不够」的界线换成可复算的精度要求，过滤逻辑本身不动。
 */
export const MIN_VOCAB_FOR_DF = minCorpusForDfHalfWidth()

/**
 * 泛词线：df/N 超过这个比例的词元直接出局（不参与入口竞争）。
 *
 * 它与 MIN_VOCAB_FOR_DF 是一对：那条管「什么时候这条判据才可信」，这条管「可信之后
 * 划在哪」。0.5 的出处是「过半数即无区分度」这句直觉，不是某次测量 —— 标定缺口见阈值表。
 */
export const DF_FILTER_RATIO = 0.5 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '「过半数即无区分度」这句直觉定下的线：df/N 超过一半的词元直接丢弃。M2 审核 T11 记录该判据在基准库上够不到、从未在目标语料上触发，即没有任何测量给出 0.5'
    failsWhen: ['库内 atom 数与来源分布', '语言（英文词表大，问题不明显）']
    affects: '泛词过滤：df/N 超过此比例的词元直接丢弃（不参与入口竞争）'
    diverges: '**本任务要治的原始病例**：判据取自直觉、在运行语料上不触发、且没有任何地方记着它的标定来源。治理（改相对判据）属后续执行点，本次只登记不改值'
  }
>

/**
 * IDF 平滑项（Robertson-Sparck Jones 形式里的 0.5）。
 *
 * 属算法惯例而非实测取值；把它提成具名常量是因为同一个公式里它出现两次
 * （分子与分母各一次），此前是两处各写一个 0.5。
 */
export const IDF_PRIOR = 0.5 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: 'IDF 平滑项的常规写法（Robertson-Sparck Jones 形式）：0.5 属算法惯例，不是在本库上测出来的'
    failsWhen: ['仅在换用别的 IDF 变体时']
    affects: '入口打分的 IDF 平滑项：log((N - df + IDF_PRIOR) / (df + IDF_PRIOR) + 1)'
  }
>

/** 入口词元的长度区间（按码点）。 */
export const MIN_TERM = 2 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '「二字词是中文检索的主力」这条设计判断；M1 B 类表只把它归为「汉语词长分布」，没有一次实测'
    failsWhen: ['上游切词规则（改成词级切分后长度含义会变）', '换成英文/日文语料']
    affects: '入口词元的长度下界（按码点）；低于它不参选'
  }
>
export const MAX_TERM = 8 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '同 MIN_TERM：上界取汉语词长分布的常见上端，B 类表归为「汉语词长分布」，无实测记录'
    failsWhen: ['上游切词规则', '语料语言', '正文的书写粒度']
    affects: '入口词元的长度上界（按码点）；超过它不参选'
  }
>

/**
 * 整段中文作为入口时的长度上限。
 *
 * 切词把「连续汉字」整段当成一个词（见 util/text.ts），于是正文里的任意片段都会成为
 * 候选：「全程没有建分支」「为什么会这样」「写在文档里」。它们只是原文的切片，不会被
 * 任何查询命中，却实打实占着每 atom 只有十几个的槽位。
 *
 * 真词里超过四字的极少（尤其在「一句话讲一件事」的 atom 里），所以按四字封顶。
 *
 * v4 起这里只剩长度封顶这一条约束：原先还有「不许含虚字」，已随单字虚词表一起换成
 * 几何判据（见 isUsableTerm）。
 */
export const MAX_HAN_TERM = 4 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: 'D11-6 的理由是「真词里超过四字的极少」—— 定性判断，未做词长统计；整段连续汉字超过四字即出局'
    failsWhen: ['语料语言', '正文的书写粒度（一句话讲一件事的实际长度）']
    affects: '整段连续汉字作为入口时的长度上限（超过四字即出局）；三字以上另需通过边界自由度判据（v4 起）'
  }
>

/** 单码点是否为汉字。 */
const isHan = (ch: string): boolean => ch >= '\u4e00' && ch <= '\u9fff'

/**
 * 「只剩一侧边界自由度」的候选（疑似跨词边界碎片）的降权系数。
 *
 * 判据本身有数据支持：对每个二字组统计它左右两侧汉字邻居的种类数，碎片总有一侧恒定
 * ——「位阈」永远左「位」右「值」。人工标注的 60 个样本上，「两侧邻居都多于一种」
 * 把真词与碎片分开到 96.7%（AUC 0.973）。
 *
 * 但它**高精度、低召回**：判为碎片的那一组里仍有约三成是真词，硬过滤会连带扔掉它们。
 * 所以只降权。系数取得足够小，让碎片落到「有真词可选」的槽位之外，又不至于在候选
 * 不足时把槽位空出来 —— 空槽位比一个次优入口更糟。
 *
 * v4 起这条只覆盖「一侧恒定且有观测」的候选：**两侧都恒定**的已在候选资格里直接出局
 *（见 hasBoundaryFreedom），两者是分工而不是强弱两档。
 */
export const FRAGMENT_PENALTY = 0.35 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '系数幅度按「让碎片落到有真词可选的槽位之外、又不至于候选不足时把槽位空出来」这条要求取；证据明写幅度是判断、不是扫描出来的。它引的标注测量测的是边界自由度判据的分开度，不是本系数'
    failsWhen: ['边界自由度判据本身的变化', '语料里真词与碎片的比例']
    affects: '边界自由度缺一侧的候选（疑似跨词边界碎片）得分乘以该系数；降权而非剔除（v4 起两侧都恒定的已直接出局）'
    diverges: 'M2 审核实测：单靠该降权**不足以把二字碎片挤出展示窗口**（审核报告「二字汉字碎片」一节）。v4 因此把它上面的那档（两侧都恒定）改成硬判出局，本条只管「只剩一侧、或观测不足」的候选'
  }
>

/**
 * 该词元是否值得作为入口。
 *
 * 判据全部是**候选资格**（进不进候选池），不是打分。
 *
 * 这条边界当初是拿一个错误的前提划的：那时 df 从 entry 表统计，于是它的取值被压成
 * 0~5 六个值、权重大量并列，看上去「打分在小库上不工作」。真正的原因在统计来源，
 * 不在打分本身 —— 改成从正文统计后取值域展开，打分随即恢复工作（见 buildVocabIndex）。
 * 候选资格过滤仍然值得保留：它管的是「明显不像词的东西」，那本来就不该由打分负责。
 *
 * 判据（必须纯字母或汉字）来自实测：入口段里混进的 `u4e00`、`0x1c`、`9_`、`v1`、
 * `0335` 全部含数字或符号。它们在库里「绝无仅有」，因此 IDF 反而给最高分，
 * 会挤占每个主题只展示 8 条的窗口。代价是 `x86` 这类纯字母数字组合的专有词会
 * 被一并剔除——实测全库只有 1 个 atom 受影响，而这些词本可以写进 declared 入口。
 *
 * **边界自由度那一层**：两个调用点（二字组、三字以上整段）用的是同一个判据 ——
 * 候选自己的左右邻汉字是否都出现过不止一种。v3 在这两处各查一次人工单字虚词表，
 * v4 把两处都换成它。字表是**人工语言知识**，与 PRINCIPLES §四(2)「插件侧全是几何运算」
 * 冲突（它的 161 个字没有任何一处是从语料算出来的）；而邻居取值种类是从语料现算的，
 * 换语料会自己变。
 *
 * **必须和 FRAGMENT_PENALTY 一起读**：打分里那条降权管的是「有一侧为零」，
 * 这里硬判的是「两侧都为零」。两者覆盖不同的候选，不是同一件事的强弱两档。
 *
 * **已知的不等价（本次实测出来的，不掩饰）**：几何判据放回了一批旧字表会挡的高频泛词
 * （不是 / 一个 / 什么 / 需要 / 用户 / 内容 / 问题…）。它们两侧都多样，几何量分不开 ——
 * 「不是」确实是词，只是不携带主题信息。这类词现在靠 IDF 与十六个槽位自己竞争，
 * 不再是字表一刀切。**这是本次替换的真实代价，判据没覆盖它**。
 *
 * **光换这一层不够**：两处调用点删掉字表后，纯 Entry 路的 gold 召回从 65% 掉到 50%
 * （见实现报告）。原因是打分 —— IDF 对 df=1 的候选一律给最高分，而语料里这种候选占绝大
 * 多数（每 atom 89.5 个候选抢十六个槽位），谁入选基本由码点顺序决定。字表原本是靠
 * 「把常见字组成的候选整片删掉」间接压住了这一点。所以 v4 同时改了打分：把词频作为
 * **证据强度**乘进去（见 extractedEntries）。这是本次另一处必要改动，不是顺带的调参。
 */
function isUsableTerm(term: string, stat?: TermStat): boolean {
  const t = term
  if (t.length < MIN_TERM || t.length > MAX_TERM) return false
  if (/\s/.test(t)) return false
  // 纯字母或汉字：数字、下划线、其他符号一律不作入口。
  if (!/^[A-Za-z\u4e00-\u9fff]+$/.test(t)) return false
  const cps = Array.from(t)
  // 三字以上的整段中文走的是「连续汉字不被分隔符切开」那条路，不是切出来的词，
  // 因此多给它一条只在整段上才有意义的约束：长度封顶。
  if (cps.length > 2 && cps.every(isHan)) {
    if (cps.length > MAX_HAN_TERM) return false
    return hasBoundaryFreedom(stat)
  }
  // 二字组与纯字母词：同样要求有边界自由度。纯字母词在语料里没有汉字邻居，
  // 判据对它无从谈起（stat 缺席），此时放行，交给打分与 DF 阈值管。
  return hasBoundaryFreedom(stat)
}

/**
 * 边界自由度是否非零 —— 这是 v4 用来顶替单字虚词表的那条判据。
 *
 * **判据线在零，不是调出来的阈值。** 返回 false 只有一种情形：左右邻汉字**都只观测到
 * 一种取值**，且两侧都**观测到过第二次**。这就是「边界自由度为零」，是判据本身的定义。
 *
 * 「观测到过第二次」不是另一个阈值，而是证据的**形态**：只观测到一次时，「邻居恒定」是
 * 必然的 —— 任何一次出现都只有一个左邻、一个右邻。要让「总是跟在同一个字后面」成为一条
 * 结论，至少要有一次重复观测可供比较。这里判的是「有没有可比较的重复」，不是「次数够不
 * 够多」—— 后者需要一个次数阈值，前者不需要。旧实现记的是两侧次数再与 2 比较，两者在
 * 本判据真正生效的那条路径上（两侧都恒定）是同一件事，见下方旧实现注释。
 *
 * **为什么敢在候选资格上做硬判（而不是像 FRAGMENT_PENALTY 那样只降权）**
 *
 * v3 用一张人工单字虚词表顶这一层，实测它挡住纯汉字二字型的 61.93%。换成几何判据后
 * 要在同一个位置上站住，强度必须相当 —— 降权不够，因为每个 atom 只有十六个槽位，
 * 而候选池平均 89.5 个/atom（全库 17497 个纯汉字二字型），碎片被降权后仍然排在真词前面。
 *
 * **与 §五 第四条（不确定处不做二值判断）的关系**：那条管的是**注入给多少**，判错时只损失
 * 相邻档位的效率；这里是**候选资格**，十六个槽位本身就是一个必须二选一的约束，硬判不违反
 * 它。而真正「不确定」的那批（还没有重复观测，下不了「边界自由度为零」这个结论）仍走
 * 降权，见 extractedEntries 里 `!st.leftVaried || !st.rightVaried` 那一行。
 *
 * **实测的强度差别（这是本次最要紧的一条）**：在 279 atom 基准库的 8685 个纯汉字二字型上，
 * 旧字表挡 5379 条（61.93%），本判据只挡 460 条（5.30%）—— 判据本身**没有**字表那么强的
 * 拦截面。两者的差集（字表挡、本判据放回）5135 条，其中含大批高频真词
 * （记忆 57 / 实测 50 / 判据 38 / 目录 30 / 合并 30 / 验证 22…）。
 *
 * 拦住剩下那批靠的不是这一层，而是打分（见 extractedEntries）：**只换这一层、不改打分，
 * 二十条 gold 查询的纯 Entry 路召回从 65% 掉到 50%；补上词频项之后是 70%**。
 * 也就是说字表原本承担的两件事（挡碎片 / 压住「df=1 一律最高分」）里，本判据只接了前一件
 * 的一小半，后一件必须由打分接。完整口径与数字见 2026-10-17 实现报告。
 *
 * **邻接证据缺席时返回 true** —— 词表没提供 stat（手写最小词表 / 空词表），或该候选
 * 在语料里一个汉字邻居都没观测到。拿不到证据就不下结论，让 IDF 与 DF 阈值去管它；
 * 若这里反过来判 false，空词表会把每个候选都拦掉。
 */
function hasBoundaryFreedom(stat: TermStat | undefined): boolean {
  if (stat === undefined) return true
  if (stat.leftVaried || stat.rightVaried) return true
  // 两侧都只观测到一种取值。此时「恒定」这个结论只在两侧都有过一次重复观测时才成立；
  // 任一侧只有单次观测，结论不成立 —— 和旧实现里「次数不足 2」放行的结果逐条一致。
  return !(stat.leftRepeated && stat.rightRepeated)
}

/** 一个词元在语料里的全部统计。 */
export interface TermStat {
  /** 出现在多少个 atom 里。 */
  df: number
  /** 在整个语料里出现的总次数。 */
  tf: number
  /**
   * 左邻汉字是否不止一种。false 表示**观测到**它总是紧跟在同一个字后面。
   *
   * 「一个邻居都没观测到」（词只出现在开头，或邻居全是标点/空白）取 true，不取 false ——
   * 判据是「恒定性」，没有证据不等于恒定；取 false 会把空词表/新语料整片拦掉。
   */
  leftVaried: boolean
  /** 右邻汉字是否不止一种。口径同 leftVaried。 */
  rightVaried: boolean
  /**
   * 这一侧是否**观测到过第二次**（不是次数）。false 表示这一侧只观测到过一次，或一次也没有。
   *
   * 用途只有一个：让「恒定」这个结论只在有可比较的重复观测时下。只出现一次的候选，
   * 两侧都恰好只见过一种邻居是常态（「代理」在只有两条 atom 的库里就是如此），
   * 拿这种观测判碎片，等于把小语料上的真词一起扔掉。只记「有没有重复」而不记次数，
   * 是因为判据要的是证据形态，不是计数阈值。
   */
  leftRepeated: boolean
  rightRepeated: boolean
}

/**
 * 词表索引：term → 它的语料统计。
 *
 * 为什么用 DF 动态阈值而不是把停用词表做大：**泛词是相对于语料定义的**，不是绝对属性。
 * 「代理」在代理配置占主导的库里是泛词，在别的库里是有效入口。用 df/N 判定，等于让
 * 语料自己决定哪些词该被丢掉——这条规则不需要维护，也不会随语料迁移而失效。
 *
 * **统计来源必须是 atom 正文，不能是 entry 表。** 这一点当初搞错了，后果很隐蔽：
 * 从 entry 表统计，数的是「已经被选为入口的词」，绝大多数候选的 df 恒为 0，取值域被
 * 压成 0~5 这六个值。实测 279 条 atom 的库里 75.99% 的 atom 十六个权重**完全并列**，
 * IDF 排序退化成字典序 —— 实际选出的是「候选里码点最小的 16 个」。高频真词因此被
 * 系统性挤掉（「记忆」在 57 条 atom 里出现过，入选 0 次），一次性噪声反而被奖励。
 *
 * 代价：每次写入都全量扫一遍 atom 正文。样本量下是可接受的毫秒量级；
 * 库大到成为瓶颈时再引入汇总表，届时不必改动本模块的对外接口。
 */
export interface VocabIndex {
  /** 该 term 出现在多少个 atom 里。 */
  df(term: string): number
  /** 语料总 atom 数（至少为 1）。 */
  total(): number
  /** 完整统计。手写的最小词表可以不提供，调用方必须容忍它缺席。 */
  stat?(term: string): TermStat | undefined
  /**
   * 词表里不同 term 的个数（M5-T60：报缓存占用用）。
   *
   * 选填，与 `stat` 同一条理由：手写的最小词表不必为「报占用」实现它；
   * 缺省时按 0 报，而不是让健康检查去遍历一个拿不到的 Map。
   */
  size?(): number
}

/**
 * 累积中的统计。
 *
 * 邻居这一侧只留三样东西：第一种取值、**有没有见过不同的取值**、**有没有第二次观测**。
 * 不保留第二种取值的样本，也不保留观测次数 —— 判据要问的两个问题分别是「取值是否只有
 * 一种」与「这个结论有没有可比较的重复观测」，两者都是布尔量。旧实现保留两个取值槽位
 * （第二个不同值即判为多样）与两个计数，再用样本数 2 与次数 2 去判；这里改成直接记
 * 那两个布尔量，两个「2」随之消失。
 */
interface MutableStat {
  df: number
  tf: number
  /** 这一侧观测到的第一种邻居（'' 表示还没有观测）。 */
  left1: string
  right1: string
  /** 这一侧是否见过与第一种不同的邻居。 */
  leftOther: boolean
  rightOther: boolean
  /** 这一侧是否观测到过第二次（不区分第二次是不是同一种取值）。 */
  leftRepeated: boolean
  rightRepeated: boolean
}

function noteNeighbor(s: MutableStat, side: string, ch: string): void {
  const first = side === 'left' ? s.left1 : s.right1
  if (first === '') {
    if (side === 'left') s.left1 = ch
    else s.right1 = ch
    return
  }
  // 第二次及以后的观测：可能重复同一种邻居，也可能换了一种。
  if (side === 'left') {
    s.leftRepeated = true
    if (ch !== s.left1) s.leftOther = true
  } else {
    s.rightRepeated = true
    if (ch !== s.right1) s.rightOther = true
  }
}

/** 把一条正文的二字组统计并进词表。按码点走，避免劈开代理对。 */
function accumulate(text: string, into: Map<string, MutableStat>): void {
  const cps = Array.from(text)
  const seen = new Set<string>()
  for (let i = 0; i + 1 < cps.length; i++) {
    const term = String(cps[i]) + String(cps[i + 1])
    let s = into.get(term)
    if (s === undefined) {
      s = {
        df: 0,
        tf: 0,
        left1: '',
        right1: '',
        leftOther: false,
        rightOther: false,
        leftRepeated: false,
        rightRepeated: false,
      }
      into.set(term, s)
    }
    s.tf++
    if (!seen.has(term)) {
      seen.add(term)
      s.df++
    }
    // 邻居只认汉字：标点与空白虽然也是边界证据，但它们同时也是「词可以在此结束」的
    // 证据，把它算进来会削弱判据的指向性。
    const l = i > 0 ? String(cps[i - 1]) : ''
    const r = i + 2 < cps.length ? String(cps[i + 2]) : ''
    if (l !== '' && isHan(l)) noteNeighbor(s, 'left', l)
    if (r !== '' && isHan(r)) noteNeighbor(s, 'right', r)
  }
}

/** 从全部 atom 正文构建词表索引。 */
export function buildVocabIndex(db: DatabaseSync): VocabIndex {
  const rows = db.prepare('SELECT text FROM atom').all() as Array<{ text: unknown }>
  const map = new Map<string, MutableStat>()
  for (const r of rows) accumulate(String(r.text), map)
  const total = Math.max(1, rows.length)
  return {
    df: (t: string) => map.get(t)?.df ?? 0,
    total: () => total,
    size: () => map.size,
    stat: (t: string) => {
      const s = map.get(t)
      if (s === undefined) return undefined
      // 邻居一个都没观测到（s.left1 === ''）时取 varied，见 TermStat.leftVaried 的注释。
      return {
        df: s.df,
        tf: s.tf,
        leftVaried: s.left1 === '' || s.leftOther,
        rightVaried: s.right1 === '' || s.rightOther,
        leftRepeated: s.leftRepeated,
        rightRepeated: s.rightRepeated,
      }
    },
  }
}

/** 空词表——用于首次写入（此时库里没有 atom，不必查库）。 */
export const EMPTY_VOCAB: VocabIndex = { df: () => 0, total: () => 1 }

/** 由入口词生成 bigram 检索串（entry_fts 的 unicode61 按空白切分）。 */
function bigramOf(term: string): string {
  return toSearchColumn(bigramTerms(term))
}

/**
 * 抽取式入口：TF-IDF 打分取 top-K。
 *
 * 打分用 IDF 而非裸词频——裸词频会让「系统」「是否」这类泛词霸占名额，而这恰好是
 * IDF 存在的意义。得分再按本次最高分归一，得到提取级别的相对权重。
 *
 * **v4 起 IDF 要乘一个词频项。** 这不是调参，是把一个原本被字表掩盖的缺陷修掉：
 * IDF 对每个 df=1 的候选都给同一个最高分，而语料里 df=1 的候选占绝大多数（基准库上
 * 每 atom 89.5 个候选抢十六个槽位），于是「谁进窗口」几乎由码点顺序决定。v3 的单字虚词表
 * 之所以看着有用，一半原因就是它把这类候选整片删掉了。
 *
 * 词频是**证据强度**：同一个词在一篇正文里出现三次，比出现一次更不像是一次切分偶然。
 * 取 log2(1+tf) 而不是 tf 本身，是为了让重复次数的边际收益递减——出现十次的词不该拿到
 * 出现一次的词十倍的分。**tf=1 时这一项恰为 1**（log2 2 = 1），此时打分退化成纯 IDF，
 * 与 v3 同式；也就是说这个因子只对出现过两次以上的候选起作用。
 *
 * **实测**（基准库、20 条 gold、纯 Entry 路、无向量）：只删字表不改打分，召回从 65% 掉到
 * 50%；同时乘上这一项之后是 70%。两处改动是配套的，只做前者会把召回做坏。
 */
export function extractedEntries(
  text: string,
  vocab: VocabIndex = EMPTY_VOCAB,
  max = DEFAULT_MAX_EXTRACTED,
): EntryRecord[] {
  const candidates = bigramTerms(text)
  const scored: Array<{ term: string; score: number; tf: number }> = []
  // 分母要把**正在写入的这一条**算进去：词表是在落库前建的，不含它。
  // 不加这个 1，库里只有一条 atom 时 df/N = 1/1，眼下这条记忆会被自己压成泛词。
  const N = vocab.total() + 1
  // 泛词过滤要等到语料有规模才成立：N 小的时候「出现在半数 atom 里」不构成任何证据
  //（N=2 时出现一次就是半数）。样本不足时宁可多留入口，也不要把新库写成一座空索引。
  const dfFilterActive = N >= MIN_VOCAB_FOR_DF
  for (const term of candidates) {
    // stat 先取：候选资格里那条边界自由度判据要靠它（v4 起，原先靠单字虚词表）。
    const st = vocab.stat?.(term)
    if (!isUsableTerm(term, st)) continue
    const df = vocab.df(term)
    // 泛词直接丢弃：出现在半数以上 atom 里的词元区分度为 0（等同停用词）。
    if (dfFilterActive && df / N > DF_FILTER_RATIO) continue
    const tf = st?.tf ?? 0
    // IDF（区分度）× log2(1+tf)（证据强度）。tf=1 时后一项恰为 1，退回纯 IDF。
    let score = Math.log((N - df + IDF_PRIOR) / (df + IDF_PRIOR) + 1) * Math.log2(1 + tf)
    // 边界自由度缺一侧的候选再降权。两侧都恒定且观测足够的已在候选资格里剔除；
    // 观测不足的那批按「不确定处不做二值判断」留在这里，用降权而不是剔除。
    // 降权而非剔除的理由见 FRAGMENT_PENALTY。
    if (st !== undefined && (!st.leftVaried || !st.rightVaried)) score *= FRAGMENT_PENALTY
    scored.push({ term, score, tf })
  }
  // 兜底用 tf 而不是字典序：权重并列时（小库上很常见），出现过更多次的更可能是个真词，
  // 至少是一个与检索有关的量；字典序选出来的是「码点最小的那几个」，没有任何含义。
  scored.sort((a, b) => b.score - a.score || b.tf - a.tf || (a.term < b.term ? -1 : 1))
  const top = scored.slice(0, Math.max(0, max))
  const maxScore = top.length > 0 ? top[0]!.score : 0
  return top.map((s) => ({
    term: s.term,
    bigram: bigramOf(s.term),
    // 归一后落在 [0, 0.6]：抽取入口永远不越过 declared 的 1.0。
    weight: maxScore > 0 ? ENTRY_WEIGHT.extracted * (s.score / maxScore) : ENTRY_WEIGHT.extracted,
    origin: 'extracted' as const,
  }))
}

/**
 * 汇总一条 atom 的全部入口。
 *
 * 去重取**最大权重**：同一个词既是 declared 又是 extracted 时，应以写入方的显式
 * 声明为准——这正是 declared 存在的理由。
 */
export function buildEntries(
  text: string,
  opts: EntryOptions = {},
  vocab: VocabIndex = EMPTY_VOCAB,
): EntryRecord[] {
  const byTerm = new Map<string, EntryRecord>()
  const keep = (rec: EntryRecord): void => {
    const prev = byTerm.get(rec.term)
    if (prev === undefined || rec.weight > prev.weight) byTerm.set(rec.term, rec)
  }
  for (const term of opts.declared ?? []) {
    const t = String(term).trim()
    if (t) keep({ term: t, bigram: bigramOf(t), weight: ENTRY_WEIGHT.declared, origin: 'declared' })
  }
  for (const rec of extractedEntries(text, vocab, opts.max ?? DEFAULT_MAX_EXTRACTED)) keep(rec)
  return [...byTerm.values()]
}

// ───────────────────────── learned 反哺（召回 → 入口）─────────────────────────

// 三级权重里只有前两级由写入产生。第三级 learned 是**召回的反哺**：一次召回把 query 的
// 特征词记到它命中的 atom 上，于是同一个问法下次能直接命中入口层。入口不进正文向量，
// 所以这一点点冗余不污染知识正交 —— 见文件头与 §27 防抖第 6 条。
//
// 触发点在 lattice_recall 工具里（本插件只有工具、没有 hook）：recall() 保持只读，
// 反哺是它返回前的一次**显式**调用。下面这组常量决定「记什么、记多久、什么时候删」，
// 全部登记在 thresholds.ts。

/** 反哺时取 query 的几条特征词。 */
export const LEARNED_FEATURE_TERMS = 3 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '设计报告 §27「取 query 的 TF-IDF top-3 特征词」给定的个数，未在本库标定；取几个特征词是反哺强度与噪声之间的取舍'
    failsWhen: ['查询长度分布', '一次召回命中多少条 atom（乘数效应）', '冷启动阶段库还小、IDF 不稳']
    affects: '一次召回反哺几个查询特征词（取 query 的 TF-IDF 前三，与写入侧同一套抽取规则）'
    doc: 't17'
    docKey: '反哺三步 · 第 1 条'
    docDefault: 3
  }
>

/** 一天的毫秒数。冷却与半衰期都以「天」为语义单位，换算只写在这里。 */
export const MILLIS_PER_DAY = 86_400_000 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '一天有多少毫秒是单位定义，不是取值选择；它不是测出来的，也不是选出来的'
    failsWhen: ['不随时间或语料变化']
    affects: 'learned 的冷却与半衰期换算（本模块里唯一一处「天」到毫秒的换算）'
  }
>

/** 冷却：同一（查询词, atom）在这么多小时内只记一次。 */
export const LEARNED_COOLDOWN_HOURS = 24 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '§27 防抖第 1 条「24 h 内只记 1 次」给的值，未在本库标定；窗口多长是「重复同一问法算不算新证据」的取舍'
    failsWhen: ['一次会话里重复同一问法的频率', '召回频次（低频库里冷却几乎不触发）']
    affects: '冷却：同一（查询词, atom）在这个窗口内只记 1 次，重复查询不构成重复证据'
    doc: 't17'
    docKey: '防抖第 1 条（单位与代码一致，都是小时）'
    docDefault: 24
  }
>

/** 遗忘：证据强度 count_eff 的半衰期（天）。 */
export const LEARNED_HALF_LIFE_DAYS = 90 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '§27 防抖第 2 条「90 天半衰期」给的值，未在本库标定；半衰期取决于记忆的实际复用周期，要真实使用期才能测出'
    failsWhen: ['记忆的实际复用周期', '召回频次']
    affects: '遗忘与淘汰共用的证据强度 count_eff 的半衰期'
    doc: 't17'
    docKey: '防抖第 2 条'
    docDefault: 90
  }
>

/**
 * 遗忘线：count_eff 低于此值的 learned 行删掉。
 *
 * **与设计文档 §27 的 1.5 分叉，理由在存储层。** 文档的公式是
 * `count += exp(-Δt_days/90)`，即 count 是**实数累加**；而 entry.hits 是
 * `INTEGER NOT NULL`，本仓库也没有第二个能存小数累加值的列。整数事件数下 1.5 是
 * **自相矛盾**的线：count_eff = hits × 2^(-Δ/90) ≤ hits，所以只出现过一次的条目
 * （hits=1）在写下的那一刻 count_eff 就已经 ≤ 1 < 1.5，会被立刻删掉 —— 反哺等于没做。
 * 这里改用 0.5，含义是「残留证据不足半个事件」：hits=1 静默 90 天后消失，
 * hits=2 静默 180 天后消失。整数计数下这是这条线唯一说得通的位置。
 */
export const LEARNED_FORGET_COUNT_EFF = 0.5 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '文档取 1.5、代码取 0.5：文档的 count 是实数累加，而 entry.hits 是 INTEGER NOT NULL，没有第二列存小数；整数事件数下 1.5 会把 hits=1 的行写下即删，0.5 是「整数计数下这条线唯一说得通的位置」，不是标定结果'
    failsWhen: ['hits 的存储口径（若将来改成小数累加，这条线要按文档回到 1.5）', '召回频次']
    affects: '遗忘线：count_eff 低于它的 learned 行删除'
    divergence: '文档的 count 是实数累加，hits 是整数列 —— 这不是调参分歧，是存储口径不一致导致同一个数字无法照抄'
    doc: 't17'
    docKey: '防抖第 2 条（文档取 1.5，代码取 0.5，见 divergence）'
    docDefault: 1.5
  }
>

/** 单个 atom 的 learned 入口上限。 */
export const LEARNED_MAX_PER_ATOM = 12 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '§27 防抖第 3 条「learned 入口 ≤ 12 条」给的值，未在本库标定；上限值本身是槽位额度的取舍'
    failsWhen: [
      'extracted 入口上限（DEFAULT_MAX_EXTRACTED=16）—— 两者是同一批槽位的两半',
      '真实召回里「查询词不属于该 atom 已有入口」的比例（T17 探针实测这个比例很高，上限很少触发）',
    ]
    guardedBy: ['test/entries-learned.test.mjs']
    affects: '单 atom 的 learned 入口上限，超出按 count_eff 淘汰最低的'
    doc: 't17'
    docKey: '防抖第 3 条'
    docDefault: 12
  }
>

/** 全局 learned 上限 = 此系数 × 库里的 atom 数。 */
export const LEARNED_GLOBAL_FACTOR = 5 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '§27 防抖第 4 条「learned 总数 ≤ 5 × n_atoms」给的值，未在本库标定；随库增长的额度是反哺总量的取舍'
    failsWhen: ['库的 atom 数（这个上限随库增长，因此不是固定额度）']
    affects: '全局 learned 上限 = 此系数 × 库里的 atom 数，超出按 count_eff 淘汰最低的'
    doc: 't17'
    docKey: '防抖第 4 条'
    docDefault: 5
  }
>

/** 升档线：count_eff 达到此值即把分值升到 extracted 档。 */
export const LEARNED_PROMOTE_COUNT = 5 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '§27 反哺三步第 3 条「count ≥ 5」给的值，未在本库标定；升档线定在几次命中是「够了」的判断，低频库里几乎不会发生'
    failsWhen: [
      '冷却窗口（24 h）与整数计数：hits ≥ 5 意味着至少 5 个跨 24 h 的事件，即约 5~7 天的使用',
      '召回频次；低频库里升档几乎不会发生',
    ]
    affects: '升档线：count_eff 到线且最近有命中时，learned 行的分值升到 extracted 档（0.6）'
    doc: 't17'
    docKey: '反哺三步 · 第 3 条（文档的 count 也是实数累加）'
    docDefault: 5
  }
>

/** 升档要求的最近命中窗口（天）。 */
export const LEARNED_PROMOTE_RECENT_DAYS = 30 satisfies ThresholdValue<
  'chosen',
  {
    area: '入口'
    why: '§27 第 3 条「30 天内出现 ≥ 2 次」的时间窗，未在本库标定；表里只有 hits 与 last_seen 两列，只能守住「最近一次命中在窗口内」这半边，另半边要事件级时间戳'
    failsWhen: ['召回频次', '若将来给 entry 加一列「首次命中时间」，就能按文档实现完整的 30 天窗口']
    affects: '升档与**降档**的时间窗：最近一次命中超出这个窗口就不再够格，已升档的降回 0.3'
    diverges: '**只实现了「最近一次命中在 30 天内」，没有实现「30 天内出现 ≥ 2 次」**：后者要事件级时间戳，表里只有 hits 与 last_seen。这是收窄，不是放宽'
    doc: 't17'
    docKey: '反哺三步 · 第 3 条的「30 天内」'
    docDefault: 30
  }
>

/**
 * 升档后的分值上限 —— **只到 extracted 的 0.6，永不等于 declared 的 1.0**。
 *
 * 为什么升档改的是 weight 而不是 origin：origin 是**来源**，weight 是**分值**。
 * 把 learned 行的 origin 改成 extracted，等于声称「这个入口是从正文抽出来的」，而
 * schema.ts 那句 `declared/learned 是真相源，extracted 可重算` 正是靠 origin 区分
 * 「能不能重算」的：被改写的行会在下一次重算抽取时**静默消失**。改成 declared 更重 ——
 * 那等于把「这个词被查得多」写成「写入方声明过这个词」。
 *
 * 分值升到 extracted 档已经拿到升档能带来的**全部**效果：weight 只被注入层的入口展示读
 * （view.ts 的 topicEntries 按 MAX(weight) 排序），不参与召回打分 —— entryPath 用的是
 * FTS 的 bm25，不看 weight。所以「升 origin」换不到任何召回收益，只换来一份伪造的来源。
 *
 * 另有一重结构自带的限幅：view.ts 取 `MAX(e.weight)`，同一个 term 上 declared 行恒为
 * 1.0，升过档的 learned 行永远压不过写入方显式声明的入口。
 */
export const LEARNED_PROMOTE_MAX_WEIGHT = ENTRY_WEIGHT.extracted

/** 一轮反哺的账。调用方可以忽略；测试与诊断靠它区分「没记」与「记了但被防抖挡住」。 */
export interface LearnedFeedback {
  /** 新建的 learned 行数。 */
  created: number
  /** 命中冷却后只把计数加一的行数。 */
  reinforced: number
  /** 因冷却被跳过的（查询词, atom）对数。 */
  cooled: number
  /** 该 atom 已有同名入口（declared / extracted）而跳过的对数 —— 不制造重复行。 */
  covered: number
  /** 本轮分值升到 extracted 档的次数。 */
  promoted: number
  /** 本轮因证据过期从 extracted 档**降回** learned 档的次数。 */
  demoted: number
  /** 因配额（单 atom / 全局）淘汰的行数。 */
  evicted: number
  /** 因证据衰减到遗忘线以下而删除的行数。 */
  forgotten: number
}

/**
 * learned 行的证据强度：整数事件数按半衰期衰减。
 *
 * 衰减在**读**的时候算，不落库。「每次事件把整段历史乘一次衰减再存回整数列」这条路
 * 走不通：hits=1 乘 0.99 取整还是 1，计数永远停在 1，衰减等于不存在。读时算没有这个问题；
 * 代价是「上次命中之前」的整段历史按同一时刻计权，比逐事件衰减略高估，高估量不超过 hits。
 */
export function learnedCountEff(hits: number, lastSeen: number, now: number): number {
  const days = Math.max(0, (now - lastSeen) / MILLIS_PER_DAY)
  return hits * Math.pow(2, -days / LEARNED_HALF_LIFE_DAYS)
}

/** 是否够升档：累计证据 count_eff 到线，**且**最近一次命中还在窗口内。 */
function isPromoted(hits: number, lastSeen: number, now: number): boolean {
  if (now - lastSeen > LEARNED_PROMOTE_RECENT_DAYS * MILLIS_PER_DAY) return false
  return learnedCountEff(hits, lastSeen, now) >= LEARNED_PROMOTE_COUNT
}

/**
 * 取 query 的特征词。**用写入侧同一套规则**（extractedEntries）—— 查询侧与写入侧共用
 * 切词与打分，是这份索引早已定下的对称性要求。
 *
 * 顺带把泛词挡在门外：df/N > 0.5 的词在写入侧就被丢掉了，反哺若放它进来，
 * 一次「之前定过什么」这样的提问就能把泛词写成某条记忆的入口，此后任何人问都会命中它。
 */
function learnedFeatureTerms(db: DatabaseSync, query: string): EntryRecord[] {
  const q = String(query ?? '').trim()
  if (q === '') return []
  // 同一个词元在候选里可能出现多次（正文里重复出现），这里按 term 收敛成一条：
  // 否则同一轮的同一个 (atom, term) 会被处理两遍，计数与账目都对不上。
  const seen = new Set<string>()
  const out: EntryRecord[] = []
  for (const rec of extractedEntries(q, readVocab(db), LEARNED_FEATURE_TERMS)) {
    if (seen.has(rec.term)) continue
    seen.add(rec.term)
    out.push(rec)
  }
  return out
}

/**
 * 查询侧用的词表缓存：**只给反哺取特征词用**，写入侧仍然每次现算（见 write.ts 的 vocabOf）。
 *
 * 为什么这里敢缓存，而写入侧明确不缓：写入侧出过的事故是「失效之后在只有 1 条 atom 的库上
 * 重建」，词表当场失真、整条记忆一个入口都生不出来 —— 那是**重建时机**错，不是缓存本身错。
 * 这里的缓存键是 atom 表的 (行数, 最大 id, 最大 updated_at)，三者任一变化即重建；
 * 而且它只决定「这次 query 的哪三个词被反哺」，不参与任何索引内容的生成。
 *
 * 不缓存的代价是实测的：1374 条 atom 的库上 buildVocabIndex 要 **113 ms**（T17 探针），
 * 而这段开销会被加进每一次召回的返回路径。
 */
const READ_VOCAB = new WeakMap<DatabaseSync, { stamp: string; index: VocabIndex }>()

function readVocab(db: DatabaseSync): VocabIndex {
  const row = db.prepare('SELECT COUNT(*) AS n, MAX(id) AS mx, MAX(updated_at) AS mt FROM atom').get() as {
    n: number | bigint
    mx: number | bigint | null
    mt: number | bigint | null
  }
  const stamp = row.n + '/' + row.mx + '/' + row.mt
  const hit = READ_VOCAB.get(db)
  if (hit !== undefined && hit.stamp === stamp) return hit.index
  const index = buildVocabIndex(db)
  READ_VOCAB.set(db, { stamp, index })
  return index
}

/**
 * 查询侧词表缓存的**实时**读数（M5-T60）。
 *
 * `entries` 报的是**词表里不同 bigram 的个数**，不是「有几份缓存」—— 缓存对每个
 * 连接最多只有一份，报 1 看不出它有多大，而「113 ms、整表正文扫出来的 Map」正是
 * 需要被看见的那件事。是否已缓存由 `cached` 单独回答，两者不混。
 *
 * **不调用 readVocab**：那条路会先查一次 stamp、再在失配时重建整份词表 ——
 * 健康检查不能因为「看一眼占用」而付 113 ms。
 */
export function readVocabCacheUsage(db: DatabaseSync): { cached: boolean; entries: number } {
  const hit = READ_VOCAB.get(db)
  if (hit === undefined) return { cached: false, entries: 0 }
  return { cached: true, entries: hit.index.size?.() ?? 0 }
}

/** (atom, term) 的复合键。用 \u0000 分隔，避免两个字段拼起来撞键。 */
function entryKey(atomId: number, term: string): string {
  return atomId + '\u0000' + term
}

/**
 * 配额、遗忘与升档。一次扫过全部 learned 行，按**同一个量** count_eff 做四件事：
 *
 *   ① 遗忘：count_eff < LEARNED_FORGET_COUNT_EFF 的删掉（时间驱动的下界）
 *   ② 单 atom 上限：某个 atom 的 learned 多于 LEARNED_MAX_PER_ATOM 时，删它最低的几条
 *   ③ 全局上限：learned 总数多于 LEARNED_GLOBAL_FACTOR × atom 数时，删全局最低的几条
 *   ④ 升档 / 降档：够线的把分值升到 extracted 档，静默久了再降回来（origin 不动）
 *
 * 四条规则共用一个量是刻意的：若一个看次数、一个看新旧，「最低的那条」在两条规则下会是
 * 不同的行，淘汰顺序就无从解释，调参也只能靠猜。
 *
 * 代价是每轮反哺一次全表扫（entry 上 origin 没有索引）。实测开销见 T17 报告；
 * 库大到这一步成为瓶颈时，正确做法是给 entry(origin) 加索引，而不是把扫描改成抽样 ——
 * 抽样会让「谁被淘汰」变成不可复现的。
 */
/**
 * 清空 learned 入口（使用史），返回清掉的条数。
 *
 * 用在**重建入口**的时候：重建按 atom 重新抽词，会把 learned 行一起删掉 ——
 * 而那是召回事件累积出来的，重算不出来（PRINCIPLES §六 的第三类）。
 *
 * 为什么必须把条数交出去、由调用方打印：使用史**可以丢，丢时必须留痕**。
 * 否则「重建一次库就把反哺静默清零」这件事无法被看见。N=0 也要打印 ——
 * 分不清「没清」与「没打印」，等于没有留痕。
 */
export function clearLearned(db: DatabaseSync): number {
  const r = db.prepare("DELETE FROM entry WHERE origin = 'learned'").run()
  const cleared = Number(r.changes)
  // 日志回答「发生过」，回执回答「清了几条」。零条也写一条 —— 理由同上：
  // 分不清「清空了 0 条」与「根本没执行」，等于没有留痕。
  log.info('entry.cleared', { cleared })
  return cleared
}

function sweepLearned(db: DatabaseSync, now: number, out: LearnedFeedback): void {
  const rows = db
    .prepare("SELECT id, atom_id, hits, last_seen, weight FROM entry WHERE origin = 'learned'")
    .all() as Array<{
    id: number | bigint
    atom_id: number | bigint
    hits: number | bigint
    last_seen: number | bigint | null
    weight: number
  }>
  if (rows.length === 0) return

  const scored = rows.map((r) => {
    const lastSeen = r.last_seen === null ? 0 : Number(r.last_seen)
    return {
      id: Number(r.id),
      atomId: Number(r.atom_id),
      eff: learnedCountEff(Number(r.hits), lastSeen, now),
      weight: Number(r.weight),
      promoted: isPromoted(Number(r.hits), lastSeen, now),
    }
  })

  const doomed = new Set<number>()
  const drop = (row: { id: number }, kind: 'forgotten' | 'evicted'): void => {
    if (doomed.has(row.id)) return
    doomed.add(row.id)
    out[kind]++
  }

  // ① 遗忘
  for (const s of scored) if (s.eff < LEARNED_FORGET_COUNT_EFF) drop(s, 'forgotten')

  // ② 单 atom 上限
  const byAtom = new Map<number, typeof scored>()
  for (const s of scored) {
    const list = byAtom.get(s.atomId)
    if (list === undefined) byAtom.set(s.atomId, [s])
    else list.push(s)
  }
  const weakestFirst = (a: { eff: number; id: number }, b: { eff: number; id: number }): number =>
    a.eff - b.eff || a.id - b.id
  for (const list of byAtom.values()) {
    if (list.length <= LEARNED_MAX_PER_ATOM) continue
    list.sort(weakestFirst)
    for (const s of list.slice(0, list.length - LEARNED_MAX_PER_ATOM)) drop(s, 'evicted')
  }

  // ③ 全局上限
  const nAtoms = Number((db.prepare('SELECT COUNT(*) AS n FROM atom').get() as { n: number | bigint }).n)
  const cap = LEARNED_GLOBAL_FACTOR * nAtoms
  const survivors = scored.filter((s) => !doomed.has(s.id))
  if (survivors.length > cap) {
    survivors.sort(weakestFirst)
    for (const s of survivors.slice(0, survivors.length - cap)) drop(s, 'evicted')
  }

  const del = db.prepare('DELETE FROM entry WHERE id = ?')
  for (const id of doomed) del.run(id)

  // ④ 分值升档 / 降档。放在删除之后，是因为它是**时间驱动**的：一条升过档的条目静默久了要
  // 自己降回去，而「静默」这件事只有扫描时才知道。判据与遗忘、淘汰共用 count_eff，
  // 额外要求最近一次命中还在窗口内。已经淘汰的行不再动 weight。
  const setWeight = db.prepare('UPDATE entry SET weight = ? WHERE id = ?')
  for (const s of scored) {
    if (doomed.has(s.id)) continue
    const want = s.promoted ? LEARNED_PROMOTE_MAX_WEIGHT : ENTRY_WEIGHT.learned
    if (s.weight === want) continue
    setWeight.run(want, s.id)
    if (want === LEARNED_PROMOTE_MAX_WEIGHT) out.promoted++
    else out.demoted++
  }
}

/**
 * 把一次召回反哺进入口表：query 的特征词记到命中的 atom 上。
 *
 * **会写库**，且写在调用方的事务之外（自己开一个）。因此不进 recall() —— 那一条路径的
 * 契约是只读，混进来就再也没法从签名上看出「这次调用会不会改库」。
 *
 * 两处「不记」值得说明，它们都不是省事，是防冗余：
 *   · 该 atom **已有同名入口**（declared / extracted）时不再建 learned 行。入口层的匹配
 *     是 `term IN (...)` 与 entry_fts 的 bigram MATCH，多一行同义词只会让这个词在 FTS 里
 *     的 df 变大、区分度下降 —— 这正是「越学越糊」的机制之一。
 *   · 同一 (查询词, atom) 在冷却窗内只记一次。同一次会话里反复问同一件事，不该被当成反复证据。
 */
export function feedLearned(
  db: DatabaseSync,
  query: string,
  atomIds: readonly number[],
  now = Date.now(),
): LearnedFeedback {
  const out: LearnedFeedback = {
    created: 0,
    reinforced: 0,
    cooled: 0,
    covered: 0,
    promoted: 0,
    demoted: 0,
    evicted: 0,
    forgotten: 0,
  }
  const ids = [...new Set(atomIds)].filter((n) => Number.isFinite(n))
  if (ids.length === 0) return out
  const feats = learnedFeatureTerms(db, query)
  if (feats.length === 0) return out

  // 参与的 atom 的现有入口一次取回：冷却与「已有同名入口」两个判据都只需要这一批。
  const ph = ids.map(() => '?').join(', ')
  const rows = db
    .prepare('SELECT id, atom_id, term, origin, hits, last_seen FROM entry WHERE atom_id IN (' + ph + ')')
    .all(...ids) as Array<{
    id: number | bigint
    atom_id: number | bigint
    term: string
    origin: string
    hits: number | bigint
    last_seen: number | bigint | null
  }>
  const occupied = new Set<string>()
  const learned = new Map<string, { id: number; hits: number; lastSeen: number }>()
  for (const r of rows) {
    const atomId = Number(r.atom_id)
    const key = entryKey(atomId, String(r.term))
    occupied.add(key)
    if (String(r.origin) === 'learned') {
      learned.set(key, {
        id: Number(r.id),
        hits: Number(r.hits),
        lastSeen: r.last_seen === null ? 0 : Number(r.last_seen),
      })
    }
  }

  const insert = db.prepare(
    'INSERT OR IGNORE INTO entry(atom_id, term, bigram, weight, origin, hits, last_seen, created_at)' +
      " VALUES (?, ?, ?, ?, 'learned', 1, ?, ?)",
  )
  // 只动计数：分值由 sweepLearned 一处说了算（升档与降档用同一条判据，见那里）。
  const touch = db.prepare('UPDATE entry SET hits = ?, last_seen = ? WHERE id = ?')
  // 一小时的毫秒数由 MILLIS_PER_DAY 除出来，不再写第二个单位字面量。
  const cooldownMs = LEARNED_COOLDOWN_HOURS * (MILLIS_PER_DAY / 24)

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const atomId of ids) {
      for (const f of feats) {
        const key = entryKey(atomId, f.term)
        const prev = learned.get(key)
        if (prev === undefined) {
          if (occupied.has(key)) {
            out.covered++
            continue
          }
          insert.run(atomId, f.term, f.bigram, ENTRY_WEIGHT.learned, now, now)
          occupied.add(key)
          out.created++
          continue
        }
        if (now - prev.lastSeen < cooldownMs) {
          out.cooled++
          continue
        }
        touch.run(prev.hits + 1, now, prev.id)
        prev.hits++
        prev.lastSeen = now
        out.reinforced++
      }
    }
    sweepLearned(db, now, out)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return out
}

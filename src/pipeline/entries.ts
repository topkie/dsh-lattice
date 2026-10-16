// 入口（Entry）生成：写入侧的词面索引来源。
//
// 入口是「免 token 的检索键」——它不进入正文向量，因此**不影响知识正交**：无论入口
// 造得多还是少，topic 中心、归属判定、切分评分都不看它一眼。入口只影响召回能不能
// 找到这条记忆。所以这里的取向很明确：宁可多给几个不那么优雅的入口，也不要漏。
//
// 三级权重（declared 1.0 / extracted 0.6 / learned 0.3）：写入侧只产前两级，
// learned 由召回命中反哺，本模块不涉及。

import type { DatabaseSync } from 'node:sqlite'
import { bigramTerms, toSearchColumn } from '../util/text.js'

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
export const DEFAULT_MAX_EXTRACTED = 16

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

/**
 * 泛词过滤（df/N > 0.5）生效所需的最小语料规模。
 *
 * 低于这个规模，「出现在半数 atom 里」不携带任何信息：库里 2 条记忆时出现一次就是
 * 半数，于是两个词都会被当作泛词丢掉。英文语料上这个问题不明显（词表大），
 * 中文 bigram 候选密集，小库上会被放得很大。
 */
export const MIN_VOCAB_FOR_DF = 12

/** 入口词元的长度区间（按码点）。 */
export const MIN_TERM = 2
export const MAX_TERM = 8

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
export const MAX_HAN_TERM = 4

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
export const FRAGMENT_PENALTY = 0.35

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
 * 判「边界自由度为零」所需的**单侧最少观测次数**。
 *
 * 判据线在零，但「恒定」这个结论要有证据才下。只有一两次观测的候选，两侧都恰好只见过
 * 一种邻居是常态 —— 写库测试里「代理」在两条 atom 的语料上就是 leftSeen=1 / rightSeen=1，
 * 照此判它就是碎片。观测数达到本值之后，「总是跟在同一个字后面」才不再是抽样偶然。
 *
 * 取 2 是量出来的，也是**能被测试守住的最小值**：写库测试里「代理」在两条 atom 的语料上
 * 是 leftSeen=1 / rightSeen=1，取 2 就放它过去。取 3 与取 2 在基准库上对纯 Entry 路 gold
 * 召回完全同分（实现报告的证据一节），所以取小的一端 —— 判据能少拦就少拦。
 */
export const MIN_NEIGHBOR_EVIDENCE = 2

/**
 * 边界自由度是否非零 —— 这是 v4 用来顶替单字虚词表的那条判据。
 *
 * **判据线在零，不是调出来的阈值。** 返回 false 只有一种情形：左右邻汉字**都只观测到
 * 一种取值**（且两侧观测数都不少于 MIN_NEIGHBOR_EVIDENCE）。这就是「边界自由度为零」，
 * 是判据本身的定义。
 *
 * **为什么敢在候选资格上做硬判（而不是像 FRAGMENT_PENALTY 那样只降权）**
 *
 * v3 用一张人工单字虚词表顶这一层，实测它挡住纯汉字二字型的 61.93%。换成几何判据后
 * 要在同一个位置上站住，强度必须相当 —— 降权不够，因为每个 atom 只有十六个槽位，
 * 而候选池平均 89.5 个/atom（全库 17497 个纯汉字二字型），碎片被降权后仍然排在真词前面。
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
  // 两侧都被观测到「恒定」——但观测太少时不下这个结论，见 MIN_NEIGHBOR_EVIDENCE。
  return stat.leftSeen < MIN_NEIGHBOR_EVIDENCE || stat.rightSeen < MIN_NEIGHBOR_EVIDENCE
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
   * 左侧 / 右侧**观测到**的汉字邻居次数（是次数，不是种类数）。0 表示这一侧没有观测。
   *
   * 用途只有一个：让「恒定」这个结论只在有证据时下。出现一两次的候选，两侧都恰好只见过
   * 一种邻居是常态（「代理」在只有两条 atom 的库里就是如此），拿这种观测判碎片，
   * 等于把小语料上的真词一起扔掉。
   */
  leftSeen: number
  rightSeen: number
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
}

/** 累积中的统计：只需保留前两个不同的邻居，就足以判断「是否只有一种」。 */
interface MutableStat {
  df: number
  tf: number
  left1: string
  left2: string | null
  right1: string
  right2: string | null
  /** 两侧各观测到多少次汉字邻居（只用来判断「恒定」这个结论有没有证据）。 */
  leftN: number
  rightN: number
}

function noteNeighbor(s: MutableStat, side: string, ch: string): void {
  if (side === 'left') {
    s.leftN++
    if (s.left1 === '') s.left1 = ch
    else if (s.left1 !== ch && s.left2 === null) s.left2 = ch
    return
  }
  s.rightN++
  if (s.right1 === '') s.right1 = ch
  else if (s.right1 !== ch && s.right2 === null) s.right2 = ch
}

/** 把一条正文的二字组统计并进词表。按码点走，避免劈开代理对。 */
function accumulate(text: string, into: Map<string, MutableStat>): void {
  const cps = Array.from(text)
  const seen = new Set<string>()
  for (let i = 0; i + 1 < cps.length; i++) {
    const term = String(cps[i]) + String(cps[i + 1])
    let s = into.get(term)
    if (s === undefined) {
      s = { df: 0, tf: 0, left1: '', left2: null, right1: '', right2: null, leftN: 0, rightN: 0 }
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
    stat: (t: string) => {
      const s = map.get(t)
      if (s === undefined) return undefined
      // 邻居一个都没观测到（s.left1 === ''）时取 varied，见 TermStat.leftVaried 的注释。
      return {
        df: s.df,
        tf: s.tf,
        leftVaried: s.left1 === '' || s.left2 !== null,
        rightVaried: s.right1 === '' || s.right2 !== null,
        leftSeen: s.leftN,
        rightSeen: s.rightN,
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
    if (dfFilterActive && df / N > 0.5) continue
    const tf = st?.tf ?? 0
    // IDF（区分度）× log2(1+tf)（证据强度）。tf=1 时后一项恰为 1，退回纯 IDF。
    let score = Math.log((N - df + 0.5) / (df + 0.5) + 1) * Math.log2(1 + tf)
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

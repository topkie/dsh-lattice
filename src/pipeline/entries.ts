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

/** 默认抽取数。少于这个数，长记忆的召回面会明显变窄。 */
export const DEFAULT_MAX_EXTRACTED = 8

/**
 * 虚字表：含这些字的二字组几乎不携带主题信息。
 *
 * 它只做**粗过滤**，真正的泛词治理靠 DF 动态阈值（见 vocabIndex 的注释）。
 * 所以这里不追求完备——漏掉的会被动态阈值兜住，不需要为此把表做成大词典。
 */
const STOP_CHARS = new Set(
  (
    '的了是在有和与就不都而及或一个上也很到说要去你会着没有看好自己这那么些什么可以因为所以' +
    '如果虽然但是因此然后而且并且以及或者对于关于通过进行用于可以需要应该必须已经正在将要' +
    '我们你们他们它们这个那个这样那样怎么为了由于根据按照目前现在同时另外此外其中之间' +
    '时候问题情况方式方面内容部分以及等等之后之前一些这些那些不能不是没有一样只是还是' +
    '可能一定一旦甚至尤其例如比如包括通过采用使用实现提供支持增加减少变化影响作用结果' +
    '原因方法步骤参数结论注意建议补充说明实现设计开发测试运行验证观察记录选择决定'
  ).split(''),
)

/** 入口词元的长度区间（按码点）。 */
const MIN_TERM = 2
const MAX_TERM = 8

/** 该词元是否值得作为入口。 */
function isUsableTerm(term: string): boolean {
  const t = term
  if (t.length < MIN_TERM || t.length > MAX_TERM) return false
  if (/s/.test(t)) return false
  const cps = Array.from(t)
  if (cps.length === 2) {
    for (const cp of cps) if (STOP_CHARS.has(cp)) return false
  }
  return true
}

/**
 * 词表索引：term → 使用该 term 的不同 atom 数。
 *
 * 为什么用 DF 动态阈值而不是把停用词表做大：**泛词是相对于语料定义的**，不是绝对属性。
 * 「代理」在代理配置占主导的库里是泛词，在别的库里是有效入口。用 df/N 判定，等于让
 * 语料自己决定哪些词该被丢掉——这条规则不需要维护，也不会随语料迁移而失效。
 *
 * 代价：每次写入都全量扫一遍 entry 表。样本量下（万级）是可接受的毫秒量级；
 * 库大到成为瓶颈时再引入 term_df 汇总表，届时不必改动本模块的对外接口。
 */
export interface VocabIndex {
  /** 该 term 出现在多少个 atom 里。 */
  df(term: string): number
  /** 语料总 atom 数（至少为 1）。 */
  total(): number
}

/** 从 entry 表构建词表索引。 */
export function buildVocabIndex(db: DatabaseSync): VocabIndex {
  // DISTINCT 保证 df 数的是 atom 而不是入口行；同一 atom 的 declared 与 extracted
  // 撞词时不会把它算成两个 atom。
  const rows = db.prepare('SELECT DISTINCT term, atom_id FROM entry').all() as Array<{
    term: string
    atom_id: number | bigint
  }>
  const map = new Map<string, number>()
  for (const r of rows) map.set(String(r.term), (map.get(String(r.term)) ?? 0) + 1)
  const total = Math.max(1, new Set(rows.map((r) => String(r.atom_id))).size)
  return { df: (t: string) => map.get(t) ?? 0, total: () => total }
}

/** 空词表——用于首次写入（此时 entry 表为空，不必查库）。 */
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
 */
export function extractedEntries(
  text: string,
  vocab: VocabIndex = EMPTY_VOCAB,
  max = DEFAULT_MAX_EXTRACTED,
): EntryRecord[] {
  const candidates = bigramTerms(text)
  const scored: Array<{ term: string; score: number }> = []
  const N = vocab.total()
  for (const term of candidates) {
    if (!isUsableTerm(term)) continue
    const df = vocab.df(term)
    // 泛词直接丢弃：出现在半数以上 atom 里的词元区分度为 0（等同停用词）。
    if (df / N > 0.5) continue
    scored.push({ term, score: Math.log((N - df + 0.5) / (df + 0.5) + 1) })
  }
  scored.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : 1))
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
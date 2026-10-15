// 文本工具：CJK 切词、摘要抽取、token 估算。
//
// 切词规则：
//   非 CJK 按整词（字母/数字/下划线连续段），CJK 按全部相邻二字组（bigram）。
//
// bigram 是刻意的选择：FTS5 的 trigram 分词器按 3 字符滑窗建索引，对长度 ≤2 的中文
// 查询返回 0 命中，而中文技术查询里两字词（代理 / 缓存 / 索引）极常见。bigram 恰好
// 覆盖任意长度的查询，代价是多一个噪声 token（「系统代理」会切出「统代」）。

/** 词/字分隔符：非字母、非数字、非下划线即切分（\u 正则带 u 标志以匹配 Unicode 字母）。 */
const SEPARATOR = /[^\p{L}\p{N}_]+/u

/** 连续 CJK 段：切词时逐字取 bigram 的范围。 */
const HAN = /\p{Script=Han}/u

/** 是否为 CJK 汉字（单码点判断）。 */
export function isCjkChar(ch: string): boolean {
  return HAN.test(ch)
}

/**
 * 切词：非 CJK 整词（小写化）+ CJK 全部相邻二字组。
 *
 * 例：`"系统代理 v2"` → `{"系统代理", "v2", "系统", "统代", "代理"}`
 * 注意 **CJK 整段会作为一个 term 保留**（中文属于 \\p{L}，不被分隔符切开）——
 * 这样整词走精确匹配、bigram 走任意长度召回，两者互补。
 * 写入侧与查询侧必须用同一函数，保证对称。
 */
export function bigramTerms(text: string): Set<string> {
  const out = new Set<string>()
  const s = String(text ?? '')
  for (const w of s.split(SEPARATOR)) if (w) out.add(w.toLowerCase())
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]!
    const b = s[i + 1]!
    if (HAN.test(a) && HAN.test(b)) out.add(a + b)
  }
  return out
}

/** 仅取 CJK bigram（不含非 CJK 整词），用于判断查询是否"短词"。 */
export function cjkBigrams(text: string): string[] {
  const s = String(text ?? '')
  const out: string[] = []
  for (let i = 0; i < s.length - 1; i++) {
    if (HAN.test(s[i]!) && HAN.test(s[i + 1]!)) out.push(s.slice(i, i + 2))
  }
  return out
}

/** 查询长度 ≤2 的 CJK 词——这些词 trigram 查不到，必须走 Entry 层兜底。 */
export function shortCjkTerms(text: string): Set<string> {
  const out = new Set<string>()
  for (const t of bigramTerms(text)) {
    if (t.length <= 2 && HAN.test(t[0] ?? '')) out.add(t)
  }
  return out
}

/** 把 todo 列表拼成 FTS5 可用的空格分隔串（unicode61 按空白切分）。 */
export function toSearchColumn(terms: Iterable<string>): string {
  return [...terms].join(' ')
}

/** 去掉 Markdown 装饰，保留可读正文。 */
export function stripMarkdown(text: string): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\|.*\|\s*$/gm, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 抽取式摘要：取第一句，超长截断。
 *
 * 约束：≤ max 个字符。**按码点计数**，避免把 emoji / 罕用汉字
 * 从中间劈开产生半个代理对。
 */
export function extractSummary(text: string, max = 48): string {
  const clean = stripMarkdown(text)
  if (!clean) return ''
  const firstSentence = clean.split(/[。！？!?]|\n/)[0]?.trim() ?? ''
  const base = firstSentence || clean
  const chars = Array.from(base)
  if (chars.length <= max) return base
  return chars.slice(0, Math.max(1, max - 1)).join('') + '…'
}

/**
 * 粗略 token 估算（仅用于预算与日志，不参与任何判据）。
 *
 * 规则：CJK 约 1 字 1 token，其余约 4 字符 1 token。
 */
export function estimateTokens(text: string): number {
  const s = String(text ?? '')
  let cjk = 0
  for (const ch of s) if (HAN.test(ch)) cjk++
  const rest = s.length - cjk
  return cjk + Math.ceil(rest / 4)
}

/**
 * 词面 Jaccard——落位判定的第二票（第一票是向量余弦）。
 *
 * 依据：仅靠向量余弦无法区分同一大类内的主题（技术类文本上，域内最小与域间最大
 * 会重叠），而词面重叠的区分度更高。两者必须同时满足才允许并入。
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const x of small) if (large.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 两段文本的词面 Jaccard（内部各自切词）。 */
export function textJaccard(a: string, b: string): number {
  return jaccard(bigramTerms(a), bigramTerms(b))
}
// 迁移切分：把一张记忆卡切成若干 atom 候选。
//
// 切分单位选 H2 小节，不是段落也不是整卡：
//   - 整卡：一张卡常含多个主题，与「一卡一事」的正交要求冲突
//   - 段落：太碎，一个论断常跨两三段，切开会丢上下文
//   - H2 小节：写卡规范本来就要求「一节讲一件事」，边界天然存在
//
// 两种要修正的极端：
//   < MIN_ATOM_CHARS：碎片。合并到相邻小节（否则会产生大量召不回来的短原子）
//   > MAX_ATOM_CHARS：过长。按句子边界再切（否则 FTS 索引膨胀，且落位会被平均掉）

/** 小于这个字符数的小节并入相邻小节 —— 太短的内容没有独立检索价值。 */
export const MIN_ATOM_CHARS = 80
/** 大于这个字符数的小节按句子边界再切 —— 受 FTS 索引体积与落位质量双重约束。 */
export const MAX_ATOM_CHARS = 600

export interface RawSection {
  /** H2 标题（`## ` 之后的部分）。引言块为空串。 */
  heading: string
  /** 小节正文（含标题行本身，便于校验「原样可见」）。 */
  body: string
}

export interface AtomDraft {
  /** 来源卡片路径，用于追溯。 */
  sourcePath: string
  /** 来源 H2 标题；合并/拆分后会记录全部来源。 */
  headings: string[]
  /** 原子正文。 */
  text: string
}

/**
 * 剥掉卡片开头的 YAML frontmatter，返回元数据与正文。
 *
 * 为什么要剥：别处的卡片正文带一段 `---\nformatVersion: 1\nkind: ...\ntitle: ...\n---`，
 * 迁移时它会成为一个独立的「原子」（实测 57 张卡就有 57 个这样的无意义 atom），
 * 既污染相似度分布（这些块彼此高度相似），又不可能被任何查询召回。
 * 元数据本身不丢：kind 与 title 会被调用方用作 atom 的 kind / 主题标签。
 */
export function stripFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const src = String(text ?? '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  if (m === null) return { meta: {}, body: src.trim() }
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (kv !== null) meta[kv[1]!] = kv[2]!.trim()
  }
  return { meta, body: src.slice(m[0].length).trim() }
}

/** 把一张卡的正文按 H2 切成小节。无 H2 时整卡作为一节。 */
export function splitSections(text: string): RawSection[] {
  const lines = String(text ?? '').split('\n')
  const marks: Array<{ i: number; h: string }> = []
  lines.forEach((l, i) => {
    if (/^##\s+\S/.test(l)) marks.push({ i, h: l.replace(/^##\s+/, '').trim() })
  })
  if (marks.length === 0) {
    const body = text.trim()
    return body === '' ? [] : [{ heading: '', body }]
  }
  const out: RawSection[] = []
  const pre = lines.slice(0, marks[0]!.i).join('\n').trim()
  // 引言块（标题与首个 H2 之间的正文）单独成节 —— 它常是全卡的结论段。
  if (pre !== '') out.push({ heading: '', body: pre })
  for (let k = 0; k < marks.length; k++) {
    const end = k + 1 < marks.length ? marks[k + 1]!.i : lines.length
    const body = lines.slice(marks[k]!.i, end).join('\n').trim()
    if (body !== '') out.push({ heading: marks[k]!.h, body })
  }
  return out
}

/** 在句子边界把长文本切成若干块，每块尽量不超过 max。 */
export function splitBySentence(text: string, max = MAX_ATOM_CHARS): string[] {
  // 主切分符：句末标点与换行。切完再贪心装箱，避免切出过多碎片。
  const parts = text.split(/(?<=[。！？!?；;\n])/).filter((s) => s.trim() !== '')
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    if (cur !== '' && (cur + p).length > max) {
      out.push(cur.trim())
      cur = p
    } else {
      cur += p
    }
  }
  if (cur.trim() !== '') out.push(cur.trim())
  // 仍超长（单句就超）时按长度硬切，保证上界。
  const bounded: string[] = []
  for (const s of out) {
    if (s.length <= max) {
      bounded.push(s)
      continue
    }
    for (let i = 0; i < s.length; i += max) bounded.push(s.slice(i, i + max))
  }
  return bounded
}

/**
 * 把一张卡切成 atom 草稿。
 *
 * 顺序：先按 H2 切，再把过短小节向后合并、把过长小节按句切。
 * 合并是「向后吞并」而不是「向前」：这样短小节与其后的内容合在一起，
 * 语义上更接近「这一节的上下文」，而不是被塞进上一节的尾巴。
 */
export function draftAtoms(sourcePath: string, text: string): AtomDraft[] {
  const secs = splitSections(text)
  const merged: RawSection[] = []
  const push = (s: RawSection) => {
    // 过短就并入**后**一节。这里对每个元素都检查，包括第一个 ——
    // 早先写成「检查已入列的最后一个」，结果第一个元素（常见是卡片标题 + 摘要的引言块）
    // 永远不会被合并，短引言就自成了一个召不回来的 atom。
    const last = merged[merged.length - 1]
    if (last !== undefined && last.body.length < MIN_ATOM_CHARS) {
      merged[merged.length - 1] = { heading: last.heading, body: last.body + '\n\n' + s.body }
      return
    }
    merged.push(s)
  }
  for (const s of secs) push(s)
  // 收尾：最后一个仍过短、且前面有内容时就并回前一节（没有「下一节」可并了）。
  const tail = merged[merged.length - 1]
  if (tail !== undefined && merged.length > 1 && tail.body.length < MIN_ATOM_CHARS) {
    const prev = merged[merged.length - 2]!
    merged[merged.length - 2] = { heading: prev.heading, body: prev.body + '\n\n' + tail.body }
    merged.pop()
  }
  const out: AtomDraft[] = []
  for (const s of merged) {
    const pieces = s.body.length <= MAX_ATOM_CHARS ? [s.body] : splitBySentence(s.body)
    for (const piece of pieces) {
      out.push({ sourcePath, headings: s.heading === '' ? [] : [s.heading], text: piece })
    }
  }
  return out
}

// 显式删除：物理删除 + 留痕 + 防写回（设计报告 §44）。
//
// 三件事，不是一个：
//   1. **物理删除**：删完那条 atom 就真的不在库里了，立刻不可召回。
//   2. **留痕**：在 `forgotten` 里留一份「它曾经存在过」的凭证。
//   3. **防写回**：模型下次把同一件事写进来时拦得住 —— 这才是留痕存在的理由。
//
// 为什么留痕而不是真删了事：真删之后「写回」就**不可检测**了。模型在后续会话里把
// 同一件事重新写进库，它没有恶意，只是不知道用户删过；库里于是又出现了那条记忆，
// 而用户无从察觉「它又回来了」。真删把「删除」变成一次无痕操作，而用户需要的是
// 一次**有效的**操作。
//
// 调用点只有两处：`pipeline/write.ts`（写入路径上比对）与 `index.ts` 的写端点
// （唯一的删除入口）。`lattice_forget` **不进模型可见的工具表** —— §11.1 的边界：
// 物理删除归用户，模型只能提议。那个边界在 `tools/index.ts` 里有注释说明。

import type { DatabaseSync } from 'node:sqlite'
import type { ThresholdValue } from '../threshold-types.js'
import { SUMMARY_CHARS, bigramTerms, extractSummary, jaccard } from '../util/text.js'
import { VEC_DIM, cosine, decodeVec, encodeVec, isValidVecBlob } from '../util/vec.js'

/**
 * 一个字符都不留的最小 bigram 数：两侧都至少要这么多，才允许做判断。
 *
 * 不是为了调参，是为了**让这个比值有意义**：Jaccard 是两边一比算出来的，
 * 2 个 bigram 对 20 个 bigram 也能得 0.09，而那多半只是碰巧共用两个词。
 * 低于这个数就不判断（放过去），并把它记进证据里，而不是假装判过了。
 *
 * 取 2 而不是另立一个数：bigram 的最小语义单位就是 2 个字符，
 * `entries.ts` 的 `MIN_TERM = 2` 已经把这条线定过一次。
 */
export const FORGOTTEN_MIN_BIGRAMS = 2 satisfies ThresholdValue<
  'chosen',
  {
    area: '显式删除'
    why: '不是标定值，是一条有意义性下限：Jaccard 是两边一比算出来的，2 个 bigram 对 20 个也能得 0.09。取 2 是复用 entries.ts 的 MIN_TERM = 2（bigram 的最小语义单位就是 2 个字符），不是另立一个数。真正需要标定的是「多短算太短」，那要拿真实短记忆的分布来定，本轮没有这份分布'
    failsWhen: ['写入约定里一条记忆的最短长度']
    guardedBy: ['test/forget.test.mjs']
    affects: '防写回判据的**可判下限**：两侧任一不足这么多 bigram 就不做判断（放行）'
    diverges: '**不是阈值而是下限**，登记它是为了让「防写回在多短的文本上不生效」可被一条命令查出来'
  }
>

/** 一次比对最多扫多少条墓碑。见 `forgottenSet` 里「为什么不是全表」的说明。 */
export const FORGOTTEN_SCAN_LIMIT = 2000 satisfies ThresholdValue<
  'chosen',
  {
    area: '显式删除'
    why: '无记录，是资源上限而非质量阈值：墓碑数与用户删除过的条数同阶，正常到不了；取 2000 是为了让写入有界 —— 无上限的全表读会让写入随删除次数悄悄变慢'
    failsWhen: ['用户删除的累计条数', '写入路径的延迟预算']
    affects: '写入时最多比对多少条墓碑；超过时结果带 truncated，写入结果上会标出来'
  }
>

/** `forgotten` 表的一行，按其实际列形状手写 —— 库里就是这些字段。 */
interface ForgottenRow {
  id: number | bigint
  atom_id: number | bigint
  fingerprint: string
  embedding: Uint8Array
  kind: string
  scope: string
  origin: string
  summary: string
  deleted_at: number | bigint
}

/** 墓碑的一条：库里的行 + 现场还原出的 bigram 集合。 */
export interface ForgottenRecord {
  /** `forgotten.id`。写入方在拦截反馈里报这个号，用户能拿它对上「我删过哪条」。 */
  tombstoneId: number
  /** 被删的那条 atom 的 id。墓碑留它，是为了「重复删除」能幂等。 */
  atomId: number
  fingerprint: string
  kind: string
  scope: string
  origin: string
  summary: string
  deletedAt: number
  terms: Set<string>
  /** 被删那条的向量指纹；无效/缺失时为 null（此时几何票算不了）。 */
  vector: Float32Array | null
}

/**
 * 墓碑指纹：bigram 集合，排序去重后拼成空格分隔的文本。
 *
 * **为什么复用 bigram 而不是另立一套**（§44）：防写回要拦的是「同一件事又被写进来」，
 * 而「同一件事」在本项目里已经有定义 —— §3/§20 的落位判据就是它（词面 bigram + 余弦）。
 * 另立一套会带来它自己的阈值，而本项目的规矩是**阈值必须带标定依据**；复用已有判据
 * 就不产生新阈值。
 *
 * 存文本而不是哈希：一条 `SELECT fingerprint FROM forgotten` 就能看出「拦的是哪几句
 * 话」。调试一个只在删除后才生效的判据，可读性值这点体积。
 */
export function fingerprintOf(text: string): string {
  return [...bigramTerms(text)].sort().join(' ')
}

/** 把库里的指纹文本还原成集合。空文本给空集（老行可能就是空，不报错）。 */
export function termsOfFingerprint(fingerprint: string): Set<string> {
  const out = new Set<string>()
  for (const t of String(fingerprint ?? '').split(' ')) if (t !== '') out.add(t)
  return out
}

/**
 * 取墓碑集合。**只在有墓碑时才做**：空表直接返回空数组，绝大多数情况零成本。
 *
 * 为什么设 `FORGOTTEN_SCAN_LIMIT` 而不是无上限全表扫：墓碑数与「用户删除过的条数」
 * 同阶，正常永远到不了上限；但写入是热路径，一条无上限的全表读意味着「用户反复删除」
 * 时写入会越来越慢，而那种退化没有任何人会提前发现。到上限时**不静默**：
 * 返回值里带 `truncated`，调用方据此在写入结果上标一句。
 */
export function forgottenSet(
  db: DatabaseSync,
  limit = FORGOTTEN_SCAN_LIMIT,
): { rows: ForgottenRecord[]; truncated: boolean } {
  const total = Number((db.prepare('SELECT COUNT(*) AS n FROM forgotten').get() as { n: number | bigint }).n)
  if (total === 0) return { rows: [], truncated: false }
  const rows = db
    .prepare(
      'SELECT id, atom_id, fingerprint, embedding, kind, scope, origin, summary, deleted_at FROM forgotten ORDER BY id DESC LIMIT ?',
    )
    .all(limit) as unknown as ForgottenRow[]
  return {
    rows: rows.map((r) => ({
      tombstoneId: Number(r.id),
      atomId: Number(r.atom_id),
      fingerprint: String(r.fingerprint),
      kind: String(r.kind),
      scope: String(r.scope),
      origin: String(r.origin),
      summary: String(r.summary),
      deletedAt: Number(r.deleted_at),
      terms: termsOfFingerprint(String(r.fingerprint)),
      vector: vectorFromBlob(r.embedding),
    })),
    truncated: total > rows.length,
  }
}

/** 命中方式。`both` = 两票；`near` = 几何兜底。 */
export type ForgetMatch = 'both' | 'near'

/** 拦截证据。写入方收到的反馈就是它 —— 「拦下之后不静默丢弃」是 §44 的明文要求。 */
export interface ForgottenEvidence {
  /** 命中的墓碑。 */
  tombstoneId: number
  /** 原来那条 atom 的 id。 */
  atomId: number
  kind: string
  scope: string
  summary: string
  deletedAt: number
  /** 与墓碑的词面重叠（bigram-Jaccard）。 */
  lex: number
  /** 与墓碑向量指纹的余弦；没算（无向量 / 不可比）时为 null。 */
  cos: number | null
  how: ForgetMatch
}

export type ForgottenCheck =
  | { hit: false; scanned: number; truncated: boolean }
  | { hit: true; scanned: number; truncated: boolean; evidence: ForgottenEvidence }

/**
 * 词面票、几何票与几何兜底的阈值。
 *
 * **默认就是落位判据的那两个，不另立**（§44）：`tauLex` / `tauJoin` 与 `write.ts` 的
 * `DEFAULT_THRESHOLDS` 同源。`nearCos` 复用 `DUP_COS`（search.ts 的 0.72，§20 的
 * 「重复的几何判据」）而不是新写一个数 —— 新数就是新阈值，而新阈值必须带标定依据。
 */
export interface ForgetThresholds {
  /** 词面票；默认 = 落位的 tauLex。 */
  tauLex: number
  /** 几何票（两票之一）；默认 = 落位的 tauJoin。 */
  tauJoin: number
  /** 无向量（几何票缺席）时词面所需的更高门槛；默认 = 落位的 tauLexOnly。 */
  tauLexOnly: number
  /**
   * 几何兜底：**词面票没过、但余弦够高**时仍判「像是同一件事」。
   *
   * 这条线必须**严格低于 `tauJoin`**，否则它是死代码：主判据是
   * 「词面 ≥ tauLex **且** 余弦 ≥ tauJoin」，而余弦 ≥ tauJoin 是它的条件之一 ——
   * 兜底若也取 tauJoin，命中集合就是主判据的子集，一个用例都多拦不到。
   * （本文件踩过这一脚：写成 0.78，实测表现与「只做主判据」逐格相同。）
   *
   * 取 `DUP_COS`（search.ts 的 0.72，§20 的「重复的几何判据」）—— 用的是一个**已经标定过**
   * 的数，本项目里「新阈值必须带标定依据」这条债因此不产生。
   *
   * 为什么不再低：0.72 之下紧邻着「不同的事」的实测上界 0.6964（间隔 0.034），
   * 再低就开始误拦 —— 而误拦会让用户写不进他没删过的记忆，且**不报错**。
   *
   * 先试过 0.92：**永不触发**（要拦的「同一件事换个说法」余弦落在 0.65~0.85），等于没写。
   */
  nearCos: number
}

export const DEFAULT_FORGET_THRESHOLDS: ForgetThresholds = {
  tauLex: 0.05,
  tauJoin: 0.78,
  tauLexOnly: 0.1,
  nearCos: 0.72,
}

function isAllZero(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false
  return true
}

/**
 * 把 atom.embedding 规范化成墓碑要存的字节。
 *
 * 列是 NOT NULL，而库里可能存在无效形状的历史向量（别的模型 / 早期版本）—— 那时存一个
 * 零向量占位，语义与「不可比」一致：几何票算不了，但墓碑本身照留。
 */
function normalizeVecBlob(blob: Uint8Array): Uint8Array {
  const raw = blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBufferLike)
  return isValidVecBlob(raw) ? raw : encodeVec(new Float32Array(VEC_DIM))
}

/** BLOB → 可比向量。**不可比时返回 null**，不硬算（与落位同一处理）。 */
function vectorFromBlob(blob: Uint8Array | null | undefined): Float32Array | null {
  if (blob === null || blob === undefined) return null
  const raw = blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBufferLike)
  if (!isValidVecBlob(raw)) return null
  const v = decodeVec(raw)
  return isAllZero(v) ? null : v
}

/** 排序用：余弦优先（区分度更高），缺失按 0；并列时看词面。 */
function rank(e: ForgottenEvidence): number {
  return (e.cos ?? 0) * 2 + e.lex
}

/**
 * 写入路径上的比对：这条新记忆是不是「用户删过的某一条」。
 *
 * **两条判据，各自对应一种失败形态**：
 *
 *   主判据  词面 >= tauLex **且** 余弦 >= tauJoin  -> `both`
 *           §44 说的「复用落位判据」的字面读法：与「是不是一件事」同一个判据、同一组阈值。
 *   兜底    余弦 >= nearCos（DUP_COS = 0.72）     -> `near`
 *           改写幅度大时词面票必然掉下去，但语义仍在。**实测**（见 T20 报告，18 组同义
 *           改写 x 13 组「不同的事」）：只做主判据拦到 13/18、误拦 0/13；加这条兜底到
 *           17/18、误拦仍是 0/13。**两条线都在 0.78 时的实测是 13/18** —— 那正是
 *           「兜底必须低于主判据的余弦线」这条约束的来源。
 *
 * **为什么不把兜底做成一条更低的词面线**：实测词面在两类上完全重叠（改写最低 0.037，
 * 「不同的事」最高 0.1154）—— 任何只靠词面的线都会带来误拦，而误拦会静默地不让用户
 * 写入他没删过的记忆。余弦上的重叠小得多，兜底因此选余弦。
 *
 * **已知判不了的情况**：两侧任一不足 `FORGOTTEN_MIN_BIGRAMS` 个 bigram 时不做判断 ——
 * 比值没有意义，拦了就是拿噪声当证据。这时 `hit:false` 但 `scanned` 仍如实报出，
 * 让调用方分得清「比过了不命中」与「根本没比」。
 */
export function checkForgotten(
  db: DatabaseSync,
  text: string,
  vec: Float32Array | null,
  thresholds: ForgetThresholds = DEFAULT_FORGET_THRESHOLDS,
): ForgottenCheck {
  const base = forgottenSet(db)
  if (base.rows.length === 0) return { hit: false, scanned: 0, truncated: false }

  const atomLex = bigramTerms(text)
  if (atomLex.size < FORGOTTEN_MIN_BIGRAMS) {
    return { hit: false, scanned: base.rows.length, truncated: base.truncated }
  }

  const usable = vec !== null && !isAllZero(vec)
  let best: ForgottenEvidence | null = null
  for (const row of base.rows) {
    if (row.terms.size < FORGOTTEN_MIN_BIGRAMS) continue
    const lex = jaccard(atomLex, row.terms)
    let cos: number | null = null
    if (usable) {
      // 向量取自**墓碑**，不是 atom 表 —— 被删的那条已经不在 atom 里了。
      // 维度不同说明墓碑是别的模型/早期版本的向量 —— **跳过而不是硬算**，
      // 否则会得到一个看起来正常、实际无意义的相似度。与落位同一处理。
      const other = row.vector
      if (other !== null && other.length === vec.length) cos = cosine(vec, other)
    }
    // 两条判据，各自可独立命中。
    //
    // 无向量时（编码器降级 / 早期零向量行）**只剩词面这一票**，此时用的词面线抬到
    // `tauLexOnly` —— 与落位在降级时的方向完全一致：没有第二票兜底，同一票就必须更严。
    // 一开始这里写成「两票都要过」，于是无向量时 `both` 恒为 false，**防写回整个失效**；
    // 而它的失效形态恰好是静默放行（库里多出一条用户删过的记忆，不报错），
    // 所以这个分支必须显式写出来，不能指望几何票缺席时它自己成立。
    //
    // 注意降级下 `near` 不可能命中（cos 为 null）—— 这不是漏，是没有第二路可用；
    // 判据②在这种部署里因此只靠原文与轻度改写，这一点写在 T20 报告的未确定项里。
    const both = usable
      ? lex >= thresholds.tauLex && cos !== null && cos >= thresholds.tauJoin
      : lex >= thresholds.tauLexOnly
    const near = cos !== null && cos >= thresholds.nearCos
    if (!both && !near) continue
    const evidence: ForgottenEvidence = {
      tombstoneId: row.tombstoneId,
      atomId: row.atomId,
      kind: row.kind,
      scope: row.scope,
      summary: row.summary,
      deletedAt: row.deletedAt,
      lex,
      cos,
      how: both ? 'both' : 'near',
    }
    // 命中多条时报**最像的那条**：反馈里给一条具体的记忆比给一个集合有用。
    if (best === null || rank(evidence) > rank(best)) best = evidence
  }
  if (best === null) return { hit: false, scanned: base.rows.length, truncated: base.truncated }
  return { hit: true, scanned: base.rows.length, truncated: base.truncated, evidence: best }
}
export interface ForgetInput {
  /** 要删的 atom id。 */
  atomId: number
  /** 删除原因。可选；只进这次调用的反馈，不进墓碑（墓碑的字段是 schema，改要迁移）。 */
  reason?: string
}

export interface ForgetResult {
  /** 被物理删除的 atom id。 */
  atomId: number
  /** 本次新建的墓碑 id；`alreadyForgotten` 为真时是**已有**那条的 id。 */
  tombstoneId: number
  deletedAt: number
  /** 指纹里的 bigram 数 —— 让调用方看得出这块墓碑的分辨力有多少。 */
  fingerprintTerms: number
  kind: string
  scope: string
  summary: string
  /** 之前已经删过（幂等：第二次调用不会多留一块墓碑）。 */
  alreadyForgotten: boolean
  reason?: string
}

/** 按 atom id 找已有墓碑。`forgotten.atom_id` 就是为这一步存在的。 */
function findTombstoneOf(
  db: DatabaseSync,
  atomId: number,
): {
  tombstoneId: number
  deletedAt: number
  terms: number
  kind: string
  scope: string
  summary: string
} | null {
  const row = db
    .prepare(
      'SELECT id, fingerprint, kind, scope, summary, deleted_at FROM forgotten WHERE atom_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(atomId) as
    | {
        id: number | bigint
        fingerprint: string
        kind: string
        scope: string
        summary: string
        deleted_at: number | bigint
      }
    | undefined
  if (row === undefined) return null
  return {
    tombstoneId: Number(row.id),
    deletedAt: Number(row.deleted_at),
    terms: termsOfFingerprint(String(row.fingerprint)).size,
    kind: String(row.kind),
    scope: String(row.scope),
    summary: String(row.summary),
  }
}

/**
 * 物理删一条 atom，并把指向它的**每一处引用**清掉。
 *
 * 为什么**显式**删这些子表，明明 `entry` / `atom_topic` 已经声明了 ON DELETE CASCADE：
 * cascade 由**父表的 DELETE 触发器**实现，而「级联动作会不会再触发 AFTER DELETE 触发器」
 * 取决于 `PRAGMA recursive_triggers`（默认关闭）。`entry` 上挂着维护 `entry_fts` 的
 * AFTER DELETE 触发器 —— 同样的代码在不同 pragma 下会留下一个悄悄不同步的全文索引。
 * 显式按序删掉子行，cascade 就无事可做，结果与 pragma 无关。
 * （`atom_search` 同理，它维护 `atom_fts`，而且压根没有外键。）
 *
 * 顺序从叶子到根：先删引用别人的，最后删被引用的。
 */
function cascadeClean(db: DatabaseSync, atomId: number): void {
  // 入口：entry_fts 靠它的 AFTER DELETE 触发器同步。这里是**直接**删，触发器必然执行。
  db.prepare('DELETE FROM entry WHERE atom_id = ?').run(atomId)
  // 次属引用：主属那一行会随 atom 一起走，这里只清次属（否则 topic 成员数会虚高）。
  db.prepare("DELETE FROM atom_topic WHERE atom_id = ? AND origin <> 'primary'").run(atomId)
  // 检索正文：它维护 atom_fts，且没有外键。
  db.prepare('DELETE FROM atom_search WHERE id = ?').run(atomId)
  // 边：两端都要清。edge 用 (src_type, src_id) / (dst_type, dst_id) 这种通用形状、
  // 没有外键 —— 这是 DR 指标里最容易漏掉的一处。
  db.prepare("DELETE FROM edge WHERE src_type = 'atom' AND src_id = ?").run(atomId)
  db.prepare("DELETE FROM edge WHERE dst_type = 'atom' AND dst_id = ?").run(atomId)
  // 别处指向它的取代关系。`superseded_by` 声明了 ON DELETE SET NULL，本来就会被置空；
  // 显式写一遍是为了**不依赖** cascade 的行为，也让「清了什么」在这一个函数里看得全。
  db.prepare('UPDATE atom SET superseded_by = NULL WHERE superseded_by = ?').run(atomId)
  db.prepare('DELETE FROM atom WHERE id = ?').run(atomId)
}

/** 这条 atom 影响到的 topic：主属 + 次属。必须在删除**之前**取。 */
function affectedTopicIds(db: DatabaseSync, atomId: number): number[] {
  const ids = new Set<number>()
  const rows = db.prepare('SELECT topic_id FROM atom_topic WHERE atom_id = ?').all(atomId) as Array<{
    topic_id: number | bigint
  }>
  for (const r of rows) ids.add(Number(r.topic_id))
  return [...ids]
}
/**
 * 重算受影响 topic 的成员数、拟合均值和 sum_vec。**在原子删掉之后**调用。
 *
 * **为什么重算而不是 `n_atoms = n_atoms - 1`**：减法只在「一切都对」时成立，而错误会
 * **累积**进一个再也没人重算的列；重算的代价是 O(该 topic 的成员数)，而删除是低频动作，
 * 用户点一次才发生一次。`sum_vec` 是派生量（见 schema.ts 文件头第 3 条）：少一个成员
 * 却不减 sum_vec，会让这个主题的中心向量永久偏向已经删掉的那条记忆。
 *
 * **空 topic 留在库里**（n_atoms = 0）：`loadCandidates` 跳过它，界面的目录也不列它，
 * 而删掉它要动 topic_id 外键与 atom_topic —— 风险大于收益。这是有意的取舍，不是遗漏。
 */
function rebuildTopicAggregates(db: DatabaseSync, topicIds: readonly number[]): void {
  for (const topicId of topicIds) {
    const rows = db
      .prepare('SELECT embedding FROM atom WHERE topic_id = ? ORDER BY id')
      .all(topicId) as Array<{
      embedding: Uint8Array
    }>
    let acc: Float32Array | null = null
    for (const r of rows) {
      const raw =
        r.embedding instanceof Uint8Array ? r.embedding : new Uint8Array(r.embedding as ArrayBufferLike)
      if (!isValidVecBlob(raw)) continue
      const v = decodeVec(raw)
      if (acc === null) acc = new Float32Array(v.length)
      if (acc.length !== v.length) continue
      for (let i = 0; i < v.length; i++) acc[i] += v[i]
    }
    const mean = db.prepare('SELECT AVG(fit) AS f FROM atom WHERE topic_id = ?').get(topicId) as
      { f: number | null } | undefined
    const meanFit = typeof mean?.f === 'number' ? mean.f : 0
    db.prepare('UPDATE topic SET n_atoms = ?, mean_fit = ?, rebuilt_at = ? WHERE id = ?').run(
      rows.length,
      meanFit,
      Date.now(),
      topicId,
    )
    // 没有任何可用向量时（降级期写入的 topic）**不动 sum_vec**：写成零长度 blob 会让
    // isValidVecBlob 判为无效，而「无效」与「零向量」在候选侧语义不同（见 loadCandidates）。
    if (acc !== null) {
      // 读—改—写而不是让 SQL 直接赋值 BLOB：UPDATE 里绑定 2 KB 的 BLOB 参数在本机 sqlite
      // 上表现为「静默不生效」（列值不变、changes 却报 1）。写入管线为此专门绕开了这条
      // 路径（见 write.ts 的 commitWrite 注释），这里同样绕开。
      db.prepare('UPDATE topic SET sum_vec = ? WHERE id = ?').run(encodeVec(acc), topicId)
    }
  }
}

/**
 * 删掉一条记忆：先留痕，再物理删，最后级联清干净。
 *
 * **顺序不能反**：先写墓碑再删 atom。反过来（先删再写墓碑）中间崩溃就会留下一条
 * 「删了但没留痕」的记忆 —— 那种状态下写回无法检测，而用户以为已经删干净了。
 * 两者在同一个事务里，正常不会撕开；顺序只是让「万一」落在更安全的一侧。
 *
 * **幂等**：atom 已不在、也没有它的墓碑时返回 `null`（调用方据此说「这条不在库里」）；
 * 墓碑还在时**不重复留痕** —— 反复点删除不该堆出一摞同样的墓碑。
 *
 * **级联清理是硬要求**（§44）：必须同时清掉指向它的次属引用与边，否则会撞上 §36
 * 第 9 项健康指标 —— 悬空引用数 DR > 0 是硬失败、阻断发布。
 */
export function forgetAtom(db: DatabaseSync, input: ForgetInput): ForgetResult | null {
  const atomId = Number(input.atomId)
  if (!Number.isInteger(atomId) || atomId <= 0) throw new Error('atom_id 必须是正整数')

  const atom = db
    .prepare('SELECT id, kind, text, summary, embedding, scope, project_key, origin FROM atom WHERE id = ?')
    .get(atomId) as
    | {
        id: number | bigint
        kind: string
        text: string
        summary: string
        embedding: Uint8Array
        scope: string
        project_key: string | null
        origin: string
      }
    | undefined

  if (atom === undefined) {
    const prev = findTombstoneOf(db, atomId)
    if (prev === null) return null
    return {
      atomId,
      tombstoneId: prev.tombstoneId,
      deletedAt: prev.deletedAt,
      fingerprintTerms: prev.terms,
      kind: prev.kind,
      scope: prev.scope,
      summary: prev.summary,
      alreadyForgotten: true,
    }
  }

  // 受影响 topic 要在删之前取：atom_topic 的次属行马上就不在了。
  const topics = affectedTopicIds(db, atomId)
  const now = Date.now()
  const fingerprint = fingerprintOf(String(atom.text))
  const nTerms = termsOfFingerprint(fingerprint).size

  db.exec('BEGIN IMMEDIATE')
  let tombstoneId: number
  try {
    tombstoneId = Number(
      db
        .prepare(
          'INSERT INTO forgotten(atom_id, fingerprint, embedding, kind, scope, project_key, origin, summary, deleted_at)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          atomId,
          fingerprint,
          normalizeVecBlob(atom.embedding),
          String(atom.kind),
          String(atom.scope ?? 'global'),
          atom.project_key ?? null,
          String(atom.origin ?? 'model'),
          String(atom.summary ?? extractSummary(String(atom.text), SUMMARY_CHARS)),
          now,
        ).lastInsertRowid,
    )
    cascadeClean(db, atomId)
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败不覆盖原始错误 */
    }
    throw err
  }

  // topic 聚合在事务**之外**重算：它是要按 topic 扫成员的，不该把写锁拖长。
  rebuildTopicAggregates(db, topics)

  const result: ForgetResult = {
    atomId,
    tombstoneId,
    deletedAt: now,
    fingerprintTerms: nTerms,
    kind: String(atom.kind),
    scope: String(atom.scope ?? 'global'),
    summary: String(atom.summary ?? ''),
    alreadyForgotten: false,
  }
  if (input.reason !== undefined && input.reason !== '') result.reason = input.reason
  return result
}

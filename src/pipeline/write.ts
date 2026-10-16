// 写入管线：把一条记忆落成 atom，并决定它归入哪个 topic。
//
// 事务纪律（设计上的硬约束，不是风格偏好）：
//   1. 事务内**固定 O(1) 行数**——不聚类、不抽词、不扫描。所有判据在事务外算好，
//      进事务的只有常量。
//   2. 写锁只在毫秒级持有。WAL 只允许单写者，长任务持锁会让整个插件卡死。
//   3. 事务内绝不调用 encoder。编码是异步且可能耗时数百毫秒的首加载。
//
// 落位为什么必须「向量 + 词面」两票：实测同域不同主题的余弦可达 0.73，而同主题
// 最低约 0.75——区间重叠。单靠向量会把不同主题**静默合并**（不报错，只是主题慢慢
// 糊掉）。词面的区分度更高，两票都过才允许并入。

import type { DatabaseSync } from 'node:sqlite'
import { normalizeOrigin } from '../db/schema.js'
import {
  cosine,
  decodeVec,
  decodeVecCopy,
  encodeVec,
  isZeroVec,
  isValidVecBlob,
  l2norm,
  normalized,
  zeroVec,
} from '../util/vec.js'
import { bigramTerms, extractSummary, jaccard, stripMarkdown } from '../util/text.js'
import { buildEntries, buildVocabIndex, type EntryRecord, type VocabIndex } from './entries.js'
import {
  DEFAULT_FORGET_THRESHOLDS,
  checkForgotten,
  type ForgetThresholds,
  type ForgottenEvidence,
} from './forget.js'

/** 落位动作。rejected（双峰拒绝且写入方未指定主属）由上层处理，见文件末尾说明。 */
export type WriteAction = 'joined' | 'created'

/** 新建 topic 的原因，供健康指标与调参使用。 */
export type CreateReason = 'far' | 'ambiguous'

/** 写入契约。除 text 外全部可省——全默认也必须能工作。 */
export interface WriteInput {
  text: string
  kind?: string
  scope?: string
  projectKey?: string
  source?: string
  sourceRef?: string
  /** 写入方显式声明的入口词（原样保留，权重 1.0）。 */
  refs?: string[]
  /** 写入方指定主属 topic：跳过几何定位，直接归属。 */
  topicHint?: number
  /**
   * 这条记忆的所有权归属：user / model / import，默认 model。
   * 不认识的值会被收敛回默认（见 db/schema.ts 的 normalizeOrigin），脏值不进库。
   */
  origin?: string
}

/** 落位判定的证据。全部保留，便于事后复盘「为什么归到了这里」。 */
export interface PlacementEvidence {
  /** 与最近 topic 的余弦；无向量时为 null。 */
  sim1: number | null
  /** 与次近 topic 的余弦；只有一个 topic 或走词面模式时为 null。 */
  sim2: number | null
  /** 与 sim1 对应 topic 的词面重叠。 */
  lex1: number
  /** 判定是否走了「仅词面」的降级路径。 */
  lexicalOnly: boolean
  /** 次近 topic 的 id；无则 null。 */
  secondId: number | null
}

export interface WriteResult {
  atomId: number
  topicId: number
  action: WriteAction
  /** 该 atom 与主属 topic 的拟合度；新建时为 1.0。 */
  fit: number
  /** action=created 时为新建原因。 */
  created?: CreateReason
  /** 写入方指定的主属不存在时给出提示，但不阻塞写入。 */
  hintMiss?: number
  evidence?: PlacementEvidence
  /** 本次真正落库的入口。 */
  entries: EntryRecord[]
  /**
   * 防写回这次的比对痕迹。**只在「有墓碑、但没命中」时才带**，用来区分两种「没命中」：
   * 「比过了不命中」与「库里根本没有墓碑 / 根本没比」。
   *
   * 为什么这个区分要有：这个判据只在删除之后才生效，而它失效时的形态恰好是**静默放行**
   * —— 库里多出一条用户删过的记忆，没有任何报错。痕迹留着，才有办法在事后看出
   * 「当时到底比了没有」。
   */
  forgotten?: { scanned: number; truncated: boolean }
}

/**
 * 写入被防写回判据拦下。
 *
 * 单独一个类而不是抛通用 Error：调用方（工具层 / 写端点）要据此给出一条**具体的**反馈
 * ——「你写的这条与用户删过的 #N 重合」。§44 明文要求「拦下之后不静默丢弃」：写入方
 * 必须知道它被拒了、以及为什么，否则它会以为写成功了。
 */
export class ForgottenError extends Error {
  readonly evidence: ForgottenEvidence
  /** 这次实际比过多少条墓碑。 */
  readonly scanned: number
  /** 墓碑多到只比了最近的一部分。 */
  readonly truncated: boolean
  constructor(evidence: ForgottenEvidence, scanned: number, truncated: boolean) {
    super('这条内容已被用户删除过（墓碑 #' + evidence.tombstoneId + '），拒绝写入')
    this.name = 'ForgottenError'
    this.evidence = evidence
    this.scanned = scanned
    this.truncated = truncated
  }
}

/** 阈值。与插件 Config 一一对应，此处独立一份便于测试直接构造。 */
export interface WriteThresholds {
  tauJoin: number
  tauLex: number
  tauNew: number
  /** 无向量时并入所需的词面重叠（比两票模式高，因为没有第二票兜底）。 */
  tauLexOnly: number
}

/**
 * 实例级状态。
 *
 * 词表（atom 正文的 DF / 频次 / 边界自由度索引）**每次现算，不做缓存** —— 理由见 vocabOf。
 * 库大之后会成为写入路径的第一个瓶颈；缓存失效靠写入侧在入口变化时显式 bump。
 */
export interface WriteCtx {
  db: DatabaseSync
  thresholds: WriteThresholds
  /** false 表示强制纯词面模式；省略表示运行时探测（编码失败即降级）。 */
  encoderOn?: boolean
  /** 编码函数。缺省表示无 encoder，走纯词面路径。 */
  encode?: (text: string) => Promise<Float32Array | null>
  /** 已废弃：词表不再缓存（每次现算）。保留字段以免破坏既有调用点。 */
  vocab?: VocabIndex | null
  /** 落位候选上限。 */
  topN?: number
  /**
   * 防写回的阈值。省略时用 `forget.ts` 的默认值 —— 那**就是落位判据的两个阈值**，
   * 所以正常部署下这个字段根本不需要给（§44：复用已有判据，不发明新阈值）。
   */
  forget?: ForgetThresholds
}

/**
 * 默认阈值由真实模型（Xenova/bge-small-zh-v1.5）在 8 组 × 3 条同义改写上
 * **实测标定**（脚本 scripts/probe-threshold.mjs，可复跑）：
 *
 *   样本对    余弦 min / p50 / max     原文 bigram-Jaccard min / p50 / max
 *   同主题    0.811 / 0.897 / 0.956    0.059 / 0.229 / 0.471
 *   跨主题    0.375 / 0.509 / 0.633    0.000 / 0.000 / 0.061
 *
 * 两个量都**完全分离**，所以取的是一条贴近下界的保守线：余弦 0.78 在同主题最小
 * 值 0.811 之下、跨主题最大值 0.633 之上；词面 0.05 在同主题最小值 0.059 之下、
 * 噪声最大值 0.061 之下。取底线而非中点，是因为两类错误代价不对称——**误并是
 * 静默的知识损坏，漏并只是多出一个主题**，后者可靠重聚类纠正，前者会一路污染
 * centroid 与召回结果。
 *
 * 一个必须知道的边界：这些数字只说明「同一件事的不同说法」能稳定落在 0.8 以上，
 * **不说明「同一技术域」也能落在 0.8**。同一域下的不同子话题（例如「WAL 允许
 * 一写多读」与「WAL 只允许单写者」）余弦只有 0.5~0.7，会被（也应当被）分成不同
 * 主题。想让它们并入，只能靠写入方显式声明，而不是把阈值调低。
 *
 * 无向量时没有任何几何粗筛，词面线抬到 0.10（同主题 p50 之上、噪声 max 之上）。
 */
export const DEFAULT_THRESHOLDS: WriteThresholds = {
  tauJoin: 0.78,
  tauLex: 0.05,
  tauNew: 0.5,
  tauLexOnly: 0.1,
}
/** 计算词面这一票的候选数上限（词面比余弦贵得多）。 */
const LEX_CANDIDATES = 8
/** 无向量时先取多少个 topic 参与词面预筛。 */
const WORD_ONLY_CANDIDATES = 64
export const DEFAULT_TOP_N = 24
/**
 * 无向量预筛的候选放大倍数：词面筛掉一批之后还要留够 decidePlacement 的输入。
 * 导出是为了让阈值登记表引用真值而不是复制一份。
 */
export const WORD_ONLY_TOP_N_FACTOR = 2

/**
 * 取词表索引（DF）。**每次调用都重建，不做缓存。**
 *
 * 这里踩过一个坑，值得留在这里给后来者：原本把词表缓存在 ctx 上，靠写入后调用来失效。
 * 表面看没问题，实际会让**第二条写入的空入口率飙升** —— 缓存一旦失效，第二次构建时
 * 库里还只有 1 个 atom，于是每个词元的 df/N 都成了 1/1 = 1，全部超过 0.5 的泛词线，
 * 结果整条记忆一个入口都生成不出来：不报错、不警告，只是这条记忆永远查不到。
 *
 * 代价是一次全表扫（万级毫秒量级），换来的是「词表永远与库一致」这个不需要论证的性质。
 * 真要优化，正确做法是加 term_df 汇总表并由写入维护，而不是加一层会静默失准的缓存。
 */
function vocabOf(ctx: WriteCtx): VocabIndex {
  return buildVocabIndex(ctx.db)
}

/** 兼容旧调用点：现在词表不做缓存，此函数无需再做任何事。 */
export function invalidateVocab(_ctx: WriteCtx): void {
  // 保留空实现以免破坏调用点；语义上「已经不需要失效了」。
}

/**
 * 每个 topic 的**词面指纹**缓存：成员正文的 bigram 并集。
 *
 * 为什么用"成员正文的 bigram"而不是"成员的入口词"：入口词是**抽过一轮的子集**
 * （每 atom 上限定 8 个），拿它和查询全文的 bigram 求 Jaccard 是两种粒度相比——
 * 分母被全文撑大、分子被入口上限压小，同主题文本的重叠会被系统性低估，唯一
 * 的后果是"该并入的没并入"。用同一粒度（都是全文 bigram）才可比。
 *
 * 为什么要截断到 FINGERPRINT_CHARS：指纹只用于估重叠度，前缀已经能覆盖摘要与
 * 背景段；不截断的话单个大 topic 的指纹会到 MB 级，而它每次落位都要参与比较。
 *
 * 缓存不主动失效——它只影响"新建还是并入"的保守程度，陈旧不会写坏数据；
 * 事务提交后由 bumpTopicLex 清掉对应项，保证本实例的写入立即可见。
 */
const topicLexCache = new WeakMap<DatabaseSync, Map<number, Set<string>>>()
/** 单个成员贡献给 topic 指纹的正文字符数。 */
export const FINGERPRINT_CHARS = 400
/** 单个 topic 最多取多少个成员的指纹。 */
export const FINGERPRINT_MEMBERS = 40

function topicLexOf(ctx: WriteCtx, topicId: number): Set<string> {
  let per = topicLexCache.get(ctx.db)
  if (per === undefined) {
    per = new Map()
    topicLexCache.set(ctx.db, per)
  }
  const hit = per.get(topicId)
  if (hit !== undefined) return hit
  // 按 atom id 取前 N 个成员，保证结果确定（否则判定会随查询计划抖动）。
  const rows = ctx.db
    .prepare(
      'SELECT s.body AS body FROM atom_search s JOIN atom_topic t ON t.atom_id = s.id WHERE t.topic_id = ? ORDER BY s.id LIMIT ?',
    )
    .all(topicId, FINGERPRINT_MEMBERS) as Array<{ body: string }>
  const set = new Set<string>()
  for (const r of rows) {
    for (const t of bigramTerms(String(r.body).slice(0, FINGERPRINT_CHARS))) set.add(t)
  }
  per.set(topicId, set)
  return set
}

/** 清掉某个 topic 的入口缓存（该 topic 刚吸收了新成员）。 */
export function bumpTopicLex(db: DatabaseSync, topicId: number): void {
  topicLexCache.get(db)?.delete(topicId)
}

interface Candidate {
  id: number
  /** 单位化的中心向量；完全无向量时为 null（词面模式下会出现）。 */
  centroid: Float32Array | null
  n: number
}

/**
 * 取落位候选 topic。
 *
 * 不做全表扫描：按 rebuilt_at 倒序取前 N——新建/刚更新的 topic 优先，同时天然限制
 * 了工作量。代价是极冷的老 topic 可能不在候选里；在「新记忆通常与近期记忆相关」
 * 这一前提下，这个近似是划算的。
 */
function loadCandidates(ctx: WriteCtx, limit = DEFAULT_TOP_N): Candidate[] {
  const rows = ctx.db
    .prepare('SELECT id, sum_vec, n_atoms FROM topic WHERE n_atoms > 0 ORDER BY rebuilt_at DESC LIMIT ?')
    .all(limit) as Array<{ id: number | bigint; sum_vec: Uint8Array; n_atoms: number | bigint }>
  const out: Candidate[] = []
  for (const r of rows) {
    const raw = r.sum_vec instanceof Uint8Array ? r.sum_vec : new Uint8Array(r.sum_vec as ArrayBufferLike)
    let centroid: Float32Array | null = null
    if (isValidVecBlob(raw)) {
      const sum = decodeVec(raw)
      const n = l2norm(sum)
      if (n > 1e-8) {
        centroid = new Float32Array(sum.length)
        for (let i = 0; i < sum.length; i++) centroid[i] = sum[i]! / n
      }
    }
    // 注意：sum_vec 为零向量时**不能丢弃该 topic**——降级期写入的 topic 中心就是零
    // 向量，丢掉它等于让纯词面模式永远没有候选、只能无限新建主题。向量不可用只是
    // 意味着"这一路用不了"，词面那一票仍然有效。
    out.push({ id: Number(r.id), centroid, n: Number(r.n_atoms) })
  }
  return out
}

type Decision =
  | { kind: 'join'; topicId: number; sim: number }
  | { kind: 'create'; reason: CreateReason; nearId: number | null; sim: number | null }
/**
 * 落位判定。返回证据与决定，**不写库**。
 *
 * 判据表（τ 为初值，须用真实语料重新标定）：
 *   sim1 ≥ τ_join 且 lex1 ≥ τ_lex        → 并入
 *   sim1 < τ_new                          → 新建（far，落未归类域）
 *   sim1 - sim2 < 0.06 且 sim1 ≥ τ_new    → 双峰：语义上说不清属于哪边，交给写入方
 *   其余（τ_new ≤ sim1 < τ_join）         → 新建（保留 near 边指向最近的 topic）
 *   无向量（降级）                         → 仅凭 lex1，阈值抬高到 TAU_LEX_ONLY
 */
export function decidePlacement(
  vec: Float32Array | null,
  candidates: Candidate[],
  lexOf: (topicId: number) => number,
  thresholds: WriteThresholds = DEFAULT_THRESHOLDS,
): { decision: Decision; evidence: PlacementEvidence } {
  const lexicalOnly = vec === null || isZeroVec(vec)
  const scored: Array<{ c: Candidate; sim: number | null; lex: number }> = []
  for (const c of candidates) {
    // 维度不一致说明库里存的是别的模型/早期版本的向量——跳过而不是硬算，
    // 否则会得到一个看起来正常、实际上无意义的相似度。
    const sim =
      lexicalOnly || c.centroid === null || vec.length !== c.centroid.length ? null : cosine(vec, c.centroid)
    scored.push({ c, sim, lex: 0 })
  }
  if (lexicalOnly) {
    // 纯词面：没有余弦可用，只能全量算词面——但候选已被 writeAtom 预筛过
    // （重叠为 0 的进不来），所以这里的候选数与"真正相关的 topic 数"同阶。
    for (const s of scored) s.lex = lexOf(s.c.id)
    scored.sort((a, b) => b.lex - a.lex)
  } else {
    scored.sort((a, b) => (b.sim ?? 0) - (a.sim ?? 0))
    // 词面是**昂贵的第二票**（每 topic 一次索引查询），只给余弦靠前的候选算。
    // 这是安全的近似：sim < τ_new 的候选本来就走不到「并入」分支，也拿不到主属，
    // 它的词面值只用于 near 边的选择，而那本就只是个提示。
    for (const s of scored.slice(0, LEX_CANDIDATES)) s.lex = lexOf(s.c.id)
  }

  const best = scored[0]
  const second = scored[1]
  const sim1 = best?.sim ?? null
  const sim2 = second?.sim ?? null
  const lex1 = best?.lex ?? 0
  const evidence: PlacementEvidence = {
    sim1,
    sim2,
    lex1,
    lexicalOnly,
    secondId: second?.c.id ?? null,
  }

  if (best === undefined)
    return { decision: { kind: 'create', reason: 'far', nearId: null, sim: null }, evidence }

  if (lexicalOnly) {
    if (lex1 >= thresholds.tauLexOnly) {
      return { decision: { kind: 'join', topicId: best.c.id, sim: lex1 }, evidence }
    }
    // 词面模式下"新建"总是指向最近的那个 topic：既然连词面都没过阈值，
    // 说明它对任何已有主题都只是泛泛相关，near 边指过去没有意义。
    return { decision: { kind: 'create', reason: 'far', nearId: null, sim: null }, evidence }
  }

  const s1 = sim1 ?? 0
  if (s1 >= thresholds.tauJoin && lex1 >= thresholds.tauLex) {
    return { decision: { kind: 'join', topicId: best.c.id, sim: s1 }, evidence }
  }
  if (s1 < thresholds.tauNew) {
    return { decision: { kind: 'create', reason: 'far', nearId: null, sim: s1 }, evidence }
  }
  // 只有一个 topic 时不存在「双峰」，第二票缺席不算歧义。
  if (second !== undefined && s1 - (sim2 ?? 0) < 0.06) {
    return { decision: { kind: 'create', reason: 'ambiguous', nearId: best.c.id, sim: s1 }, evidence }
  }
  // 落位没把握到能并入，但确实比「全新」更像已有主题——记一条 near 边，把候选留给图扩展。
  return { decision: { kind: 'create', reason: 'far', nearId: best.c.id, sim: s1 }, evidence }
}

/**
 * 组装检索正文。
 *
 * 摘要重复一次是刻意的：BM25 里 tf 有正向作用，而摘要通常是整条记忆信息密度最高的
 * 一句；trigram 索引对短正文本来就不友好。
 */
export function buildSearchBody(summary: string, text: string, entries: EntryRecord[]): string {
  const body = stripMarkdown(text)
  const terms = entries.map((e) => e.term).join(' ')
  if (body.length <= 1600) return `${summary} ${summary} ${body} ${terms}`
  return `${summary} ${summary} ${body.slice(0, 1600)} ${terms}`
}

interface CommitRow {
  kind: string
  text: string
  summary: string
  embedding: Uint8Array
  topicId: number
  newTopic: boolean
  fit: number
  scope: string
  projectKey: string | null
  source: string | null
  sourceRef: string | null
  origin: string
  nearId: number | null
  nearConf: number | null
}

/** 在事务内落库，固定 O(1) 行数。返回 atom id。 */
function commitWrite(ctx: WriteCtx, row: CommitRow, entries: EntryRecord[]): number {
  const db = ctx.db
  const now = Date.now()
  const body = buildSearchBody(row.summary, row.text, entries)

  const insertTopic = db.prepare(
    `INSERT INTO topic(domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at)
     VALUES (NULL, ?, ?, 1, 0, ?, ?)`,
  )
  const bumpTopic = db.prepare(
    `UPDATE topic SET sum_vec = ?, n_atoms = n_atoms + 1, rebuilt_at = ? WHERE id = ?`,
  )
  const insertAtom = db.prepare(
    `INSERT INTO atom(kind, text, summary, embedding, topic_id, fit, scope, project_key,
                      source, source_ref, origin, polarity, flags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
  )
  const insertAtomTopic = db.prepare(
    'INSERT INTO atom_topic(atom_id, topic_id, weight, origin) VALUES (?, ?, ?, ?)',
  )
  const insertEntry = db.prepare(
    'INSERT INTO entry(atom_id, term, bigram, weight, origin, hits, last_seen, created_at) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)',
  )
  const insertEdge = db.prepare(
    `INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(src_type, src_id, dst_type, dst_id, kind) DO NOTHING`,
  )
  const upsertSearch = db.prepare(
    'INSERT INTO atom_search(id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body',
  )

  db.exec('BEGIN IMMEDIATE')
  try {
    let topicId = row.topicId
    if (row.newTopic) {
      // 新建 topic 时 sum_vec 直接取该 atom 的向量，n_atoms 直接记 1——本函数
      // 接下来插入的 atom 就是它的第一个成员，走"零向量再累加"会白算一次，
      // 而零 sum_vec 的 topic 在候选侧是不可用的（loadCandidates 要求 n_atoms > 0）。
      const r = insertTopic.run(row.summary.slice(0, 16) || '未命名', row.embedding, now, now)
      topicId = Number(r.lastInsertRowid)
    }
    const atomId = Number(
      insertAtom.run(
        row.kind,
        row.text,
        row.summary,
        row.embedding,
        topicId,
        row.fit,
        row.scope,
        row.projectKey,
        row.source,
        row.sourceRef,
        row.origin,
        now,
        now,
      ).lastInsertRowid,
    )
    insertAtomTopic.run(atomId, topicId, 1.0, 'primary')
    for (const e of entries) insertEntry.run(atomId, e.term, e.bigram, e.weight, e.origin, now)
    if (row.nearId !== null) {
      insertEdge.run('atom', atomId, 'topic', row.nearId, 'near', row.nearConf ?? 0.5, 'untyped', now)
    }
    upsertSearch.run(atomId, body)
    if (!row.newTopic) {
      // 读—改—写，而不是让 SQL 直接赋值 BLOB：UPDATE 里绑定 2 KB 的 BLOB 参数在
      // 本机 sqlite 上表现为"静默不生效"（列值不变、changes 却报 1），而
      // atom 的 INSERT 绑同一个值却完全正常。避开这条不可靠路径，
      // 顺带把精度问题收敛到一处可测的代码里。
      {
        const cur = db.prepare('SELECT sum_vec FROM topic WHERE id = ?').get(topicId) as
          { sum_vec: Uint8Array } | undefined
        const sum = cur !== undefined && isValidVecBlob(cur.sum_vec) ? decodeVecCopy(cur.sum_vec) : zeroVec()
        const add = decodeVec(row.embedding)
        const n = Math.min(sum.length, add.length)
        for (let i = 0; i < n; i++) sum[i] = sum[i]! + add[i]!
        bumpTopic.run(encodeVec(sum), now, topicId)
      }
    }
    db.exec('COMMIT')
    bumpTopicLex(db, topicId)
    return atomId
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败不覆盖原始错误 */
    }
    throw err
  }
}

/** 提交后的维护统计：只做常数时间的聚合，绝不做全量重算。 */
function afterWrite(ctx: WriteCtx, topicId: number, atomId: number, entryCount: number): void {
  const db = ctx.db
  if (entryCount > 0) invalidateVocab(ctx)
  try {
    const m = db.prepare('SELECT AVG(fit) AS f FROM atom WHERE topic_id = ?').get(topicId) as
      { f: number | null } | undefined
    if (typeof m?.f === 'number') db.prepare('UPDATE topic SET mean_fit = ? WHERE id = ?').run(m.f, topicId)
  } catch {
    // 维护统计失败不影响本次写入——它只会让健康指标短暂不准，不该让写入报错。
  }
  void atomId
}

/** 便捷构造：多数调用点只需要给 db 与阈值。 */
export function createWriteCtx(
  db: DatabaseSync,
  thresholds: Partial<WriteThresholds> = {},
  extra: Partial<WriteCtx> = {},
): WriteCtx {
  return { db, thresholds: { ...DEFAULT_THRESHOLDS, ...thresholds }, ...extra }
}

function readTopicOf(db: DatabaseSync, atomId: number): number {
  const row = db.prepare('SELECT topic_id FROM atom WHERE id = ?').get(atomId) as
    { topic_id: number | bigint } | undefined
  return Number(row?.topic_id ?? 0)
}

/**
 * 写入一条记忆。
 *
 * 失败语义分层：可预期的输入问题抛 Error（调用方给错参数，不该静默吞掉）；环境问题
 * （编码失败）不抛——降级为词面模式继续，并把降级痕迹留在 evidence.lexicalOnly。
 */
export async function writeAtom(ctx: WriteCtx, input: WriteInput): Promise<WriteResult> {
  const text = String(input.text ?? '').trim()
  if (text.length === 0) throw new Error('text 不能为空')
  const summary = extractSummary(text, 48)
  const kind = String(input.kind ?? '结论')

  // ① 编码。事务外、可失败、失败即降级。
  let vec: Float32Array | null = null
  if (ctx.encoderOn !== false && ctx.encode !== undefined) {
    try {
      vec = await ctx.encode(text)
    } catch {
      vec = null
    }
  }
  // 降级时写零向量占位，而不是 NULL——「是否已编码」由向量是否为零判定，
  // 少一个可空列，也就少一处 IS NULL 分支。
  const embedding = encodeVec(vec !== null && !isZeroVec(vec) ? normalized(vec) : zeroVec())

  // ② 防写回：这条内容是不是用户删过的某一条（§44）。
  //
  // 为什么在**写入路径**上比：这是唯一能拦住写回的时机 —— 召回时拦没有意义，内容已经
  // 进库了。为什么在入口与落位**之前**比：被拦下时不该再做那两件更贵的事（建词表索引、
  // 取候选 topic），而且越早拒绝，写入方拿到的反馈越干净。
  //
  // 阈值用的是 `forget.ts` 的默认值（= 落位的 tauLex / tauJoin / tauLexOnly），不读插件
  // config：防写回没有、也不该有配置旋钮 —— 它是判据的一部分，不是一个可调参数。
  // 无向量时两票退化成词面一票，那条线跟着抬到 tauLexOnly，方向与落位一致。
  const forgottenCheck = checkForgotten(ctx.db, text, vec, ctx.forget ?? DEFAULT_FORGET_THRESHOLDS)
  if (forgottenCheck.hit) {
    throw new ForgottenError(forgottenCheck.evidence, forgottenCheck.scanned, forgottenCheck.truncated)
  }

  // ③ 入口。写入侧与查询侧必须用同一套切词（bigramTerms），否则索引与查询不对称。
  const entries = buildEntries(text, { declared: input.refs ?? [] }, vocabOf(ctx))

  // ④ 落位。
  let decision: Decision
  let evidence: PlacementEvidence | undefined
  let hintMiss: number | undefined
  let fit = 1.0
  let newTopic = true
  let nearId: number | null = null
  let nearConf: number | null = null

  const hint = input.topicHint
  const hintExists =
    hint === undefined
      ? false
      : (ctx.db.prepare('SELECT 1 AS ok FROM topic WHERE id = ?').get(hint) as
          { ok?: number } | undefined) !== undefined

  if (hint !== undefined && hintExists) {
    // 写入方有把握时跳过几何定位——这正是 topic_hint 存在的意义。
    decision = { kind: 'join', topicId: hint, sim: 1 }
    newTopic = false
  } else {
    if (hint !== undefined) hintMiss = hint
    const usable = vec !== null && !isZeroVec(vec)
    const atomLex = bigramTerms(text)
    const lexOf = (topicId: number): number => jaccard(atomLex, topicLexOf(ctx, topicId))

    // 无向量时先按词面把候选筛出来：没有余弦可用，能连上话的 topic 才算候选。
    // 这一步不能省——降级期的 topic 中心是零向量，如果候选只按时间取，
    // 真正相关但很久没更新的 topic 会排在候选之外，词面那一票根本没机会投。
    let candidates = loadCandidates(ctx, usable ? (ctx.topN ?? DEFAULT_TOP_N) : WORD_ONLY_CANDIDATES)
    if (!usable) {
      const lexed = candidates
        .map((c) => ({ c, lex: lexOf(c.id) }))
        .filter((x) => x.lex > 0)
        .sort((a, b) => b.lex - a.lex)
        .slice(0, (ctx.topN ?? DEFAULT_TOP_N) * WORD_ONLY_TOP_N_FACTOR)
      candidates = lexed.map((x) => x.c)
    }
    const placed = decidePlacement(usable ? vec : null, candidates, lexOf, ctx.thresholds)
    decision = placed.decision
    evidence = placed.evidence
    if (decision.kind === 'join') {
      newTopic = false
      fit = decision.sim
    } else {
      newTopic = true
      nearId = decision.nearId
      nearConf = decision.sim
    }
  }

  const topicId = decision.kind === 'join' ? decision.topicId : -1
  const atomId = commitWrite(
    ctx,
    {
      kind,
      text,
      summary,
      embedding,
      topicId,
      newTopic,
      fit,
      scope: String(input.scope ?? 'global'),
      projectKey: input.projectKey ?? null,
      source: input.source ?? null,
      sourceRef: input.sourceRef ?? null,
      origin: normalizeOrigin(input.origin),
      nearId,
      nearConf,
    },
    entries,
  )

  const result: WriteResult = {
    atomId,
    topicId: newTopic ? readTopicOf(ctx.db, atomId) : topicId,
    action: newTopic ? 'created' : 'joined',
    fit,
    entries,
  }
  if (newTopic) result.created = decision.kind === 'create' ? decision.reason : 'far'
  if (hintMiss !== undefined) result.hintMiss = hintMiss
  if (evidence !== undefined) result.evidence = evidence
  // 只在「确实比过」时才留痕：scanned=0 表示库里没有墓碑，那是常态、不必写进结果。
  if (forgottenCheck.scanned > 0) {
    result.forgotten = { scanned: forgottenCheck.scanned, truncated: forgottenCheck.truncated }
  }

  afterWrite(ctx, result.topicId, atomId, entries.length)
  return result
}

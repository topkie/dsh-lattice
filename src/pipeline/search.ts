// 召回管线：四路并行召回，用 RRF 融合，再乘归属因子。
//
// 四条路各自的性格：
//   向量  粗筛强、细分弱 —— 决定「相关不相关」
//   Entry 短查询的主力。FTS5 的 trigram 对 ≤2 字的中文查询返回 0 命中，
//         而中文技术查询里两字词极常见，所以入口层单独建了 bigram 索引兜底
//   正文  长查询与细节命中（≥3 字才有效，短查询返回空是预期行为，不是错误）
//   图     一跳边扩展，补多跳关联
//
// RRF 用排名而不是分数做融合：四路的分数根本不同量纲（余弦 / bm25 / 置信度），
// 归一化到同一尺度既不可靠也没必要 —— 排名天然可比。

import type { DatabaseSync } from 'node:sqlite'
import type { ThresholdValue } from '../threshold-types.js'
import { bigramTerms } from '../util/text.js'
import { cosine, decodeVec, isValidVecBlob, VEC_DIM } from '../util/vec.js'
import { edgeOriginCounts, GRAPH_KINDS, OUT_DEGREE_CAP } from '../graph/infer.js'
import { FLAG_ARCHIVED } from '../db/flags.js'
import { readConfirmedSplits, readPendingSegments } from './split.js'

/** 召回路的名字，也是融合时的权重键。 */
export type Channel = 'vec' | 'entry' | 'body' | 'graph'

/** RRF 权重。Entry 高于正文，符合「入口冗余」原理：短查询要找的多半是入口。 */
export const CHANNEL_WEIGHT: Readonly<Record<Channel, number>> = {
  vec: 1.0,
  entry: 0.8,
  body: 0.5,
  graph: 0.5,
}

/** RRF 常数。60 是常用取值：压低头部排名的垄断，让多路共识浮现。 */
export const RRF_K = 60 satisfies ThresholdValue<
  'chosen',
  {
    area: '召回融合'
    why: '60 是 RRF 的常用取值（算法惯例），无实测记录；它压平头部排名垄断的程度由融合方式决定'
    failsWhen: ['换成别的融合方式时']
    affects: 'RRF 融合常数：分越高越压平头部排名的垄断，让多路共识浮现'
    diverges: '**zod schema 里没有它** —— 文档给了 10-100 的范围，运行时不生效、不可调'
    doc: 'config'
    docKey: 'rrfK'
    docDefault: 60
    docRange: [10, 100]
  }
>

/** 归属因子：主属 > 仅次属 > 仅由图路引入。 */
export const AFFILIATION = { primary: 1.0, secondary: 0.76, graphOnly: 0.7 } as const

export interface RecallOptions {
  /** 融合后返回的条数（交注入层）。 */
  topN?: number
  /** 向量/词面两路各自取多少条进融合。 */
  kVec?: number
  kLex?: number
  /** 图路取多少条。 */
  kGraph?: number
  /** 只召回该 scope 的 atom。 */
  scope?: string
  /** 融合后可再截断到更少（注入层预算不足时用），但要先做归属加权。 */
  dropInactive?: boolean
  /**
   * 判「这次召回有没有内容」的参考线与它的可用性（见 pipeline/refdist.ts）。
   *
   * 由调用方算好传入，不在这里算：参考线要把 48 条内置问句各编码一次（首次约 1 秒），
   * 而 recall 是同步函数、本模块也不加载模型。不传时不做判定，meta.hasContent 为 null。
   */
  reference?: { line: number; usable: boolean; reason: string }
}

/** 一条命中。分数字段全部保留 —— 调参与事后复盘都要靠它们。 */
export interface RecallHit {
  id: number
  score: number
  /** 归属加权后的最终分。 */
  final: number
  topicId: number
  fit: number
  summary: string
  /** 该 atom 在每一路里的名次（1 起）；未进该路则没有这个键。 */
  ranks: Partial<Record<Channel, number>>
  /** 归属因子，1.0 表示主属命中。 */
  affiliation: number
  /** 所有权归属：user / model / import。见 db/schema.ts 的 AtomOrigin。 */
  origin: string
  /** 被哪条记忆取代（atom id）；未被取代时为 null。 */
  supersededBy: number | null
  /**
   * 整行的 `atom.flags`。注入层要按位判读（bit0 = 待拆分），不能只带一个布尔 ——
   * 位定义只有 write.ts 一处，读侧按位取用，不新造第二套状态字段。
   */
  flags: number
  /** 来源标识，写入时给的那个值；没有则为 null。 */
  source: string | null
}

/** 召回元数据。退化必须可观测，不允许静默失效。 */
export interface RecallMeta {
  /** 每路实际召回到的条数。 */
  counts: Record<Channel, number>
  /** 词面两路全空但向量路有货 —— 只剩向量，是功能缩水而非结构崩坏。 */
  lexicalDegraded: boolean
  /** 查询里有两字中文词，但 Entry 路一条都没命中 —— 索引或切词出了问题。 */
  shortTermMiss: boolean
  /** 是否走的是纯词面模式（无查询向量）。 */
  vectorMissing: boolean
  /** 被标记为重复而压制的 atom 数。 */
  suppressed: number
  /**
   * 因「已被取代」而不出现在结果里的 atom 数。
   *
   * 与 `suppressed` 分开报：重复是两条讲同一件事、取分高的那条；取代是旧条的内容已被
   * 新条替代、旧条不该再当答案。合成一个数时，「为什么少了一条」不可解释。
   */
  suppressedSuperseded: number
  /** 主属命中数 / 次属命中数。 */
  primaryHits: number
  secondaryHits: number
  /**
   * 命中里最高的余弦相似度；无向量时为 0。
   *
   * 为什么需要它：召回**总会**返回 topN 条，不管相关性多低。调用方只看「有没有命中」
   * 无法判断质量，会以为「完全不相关的问题」也命中了。把这个数报出来，调用方才有依据
   * 决定是采纳还是忽略。
   */
  topCosine: number
  /**
   * 图路的输入现状：`声明边 N 条，推断边 M 条`。只报数，不带状态前缀 ——
   * 读路径不建边，所以这里没有「本次建边的结果」可报。
   *
   * 为什么必须报出来：图路为空有两种完全不同的原因 —— 「库里还没有边」与
   * 「有边但这次没扩展出东西」。前者是接线问题，后者是数据性质。不区分就会让
   * 「图路恒为 0」这种故障再次以一个安静的数字通过验收。
   *
   * **两种边分开报数**：图路非 0 可能来自模型声明的关系（真相源，重建后仍在），也可能
   * 来自向量近邻的推断（派生物，重建会整批换掉）。合成一个数时「图路有值」不可解释 ——
   * 读者分不清它是不是重建一次就没了。
   */
  graphStatus: string
  /**
   * 用户已确认「这条应当拆分」的 atom id。来自 split_queue 里 confirmed = 1 的行，
   * 上限由 SPLIT_CONFIRMED_MAX 夹住（FIFO）。注入层据此把锚行提示换成「已确认」的说法。
   *
   * 为什么由召回带出来而不是让注入层自己读：库是这一层的东西，注入层只该认识
   * RecallResult —— 它连 getMeta 都不该 import（依赖方向是 tools → pipeline：读库的
   * 决定在这里做一次，而不是每个渲染分支各做一次）。
   */
  splitConfirmed: number[]
  /**
   * 待拆分候选的段数：`[atomId, 切成了几段]`。来自 split_queue 的 segments 列，
   * 上限由 SPLIT_SEGMENTS_MAX 夹住（FIFO）。锚行据此把「疑似应拆分」写成「疑似应拆分（3 段）」。
   *
   * 为什么不是 Map：这是纯数据接口，要能原样序列化（回执与快照都会序列化它）；
   * 缺项（老库没有这个键）按空数组处理，锚行退回不带段数的固定串。
   */
  splitPendingSegments: Array<[number, number]>
  /**
   * 这次召回有没有内容：`topCosine` 是否越过本库参考线。
   *
   * `null` 有三种来源（无参考线、库太小、线太高），区别在 `referenceReason` 里。
   * 三态而不是布尔：把「判不了」和「判了没有」合成 false，回执就只能说「没有内容」，
   * 而那正好是判不了时最不该说的话。
   */
  hasContent: boolean | null
  /** 判定用的线；判不了时为 null。 */
  referenceLine: number | null
  /** 参考线的可用性：ok / no-encoder / library-too-small / line-too-high / none。 */
  referenceReason: string
  elapsedMs: number
}

/** 某个被命中的主题的汇总信息，供注入层生成「入口」段。 */
export interface TopicSummary {
  topicId: number
  label: string
  /** 该主题下命中的 atom 数。 */
  hits: number
}

export interface RecallResult {
  hits: RecallHit[]
  topics: TopicSummary[]
  meta: RecallMeta
}
/** 检索用的最小 atom 信息。热点只在这些数字上转，正文只在最后按需取。 */
interface AtomRow {
  id: number
  topicId: number
  fit: number
  summary: string
  origin: string
  supersededBy: number | null
  flags: number
  /** 来源标识（同一份材料分几次写入时相同）。真重复压制按它分桶。 */
  source: string | null
}

/**
 * 向量缓存：一个连接算一份，避免每次召回都全表读 BLOB。
 *
 * 1 万条 atom 就是 20 MB，逐次读会让召回从毫秒级掉到几十毫秒。
 * 失效靠写入侧显式调用 invalidateVecCache —— 隐式比对行数会在「删一条加一条」时漏判。
 */
interface VecCache {
  ids: number[]
  vecs: Float32Array[]
  offset: Map<number, number>
  /** 建缓存时的 atom 行数，用于廉价地发现库已变化。 */
  count: number
}
const VEC_CACHE = new WeakMap<DatabaseSync, VecCache>()

/** 写入侧调用：让本连接的向量缓存失效。 */
export function invalidateVecCache(db: DatabaseSync): void {
  VEC_CACHE.delete(db)
}

/**
 * 向量缓存当前占用的**实时**读数。
 *
 * `entries` 是缓存里**真正持有的向量条数**，不是库里的 atom 数：维度不符的旧向量
 * 在建缓存时就被跳过了，它们不占这份内存，报进来会让人低估剩下的空间、也会让
 * 「库里有 3 条、缓存里 2 条」看起来像 bug。
 *
 * 只读 WeakMap，**不调用 loadVecCache** —— 健康检查顺手把缓存建起来，等于让观测
 * 本身产生被观测的对象，那次 20 MB / 数十毫秒的开销会记在一次 ping 的账上。
 */
export function vecCacheUsage(db: DatabaseSync): { cached: boolean; entries: number } {
  const hit = VEC_CACHE.get(db)
  if (hit === undefined) return { cached: false, entries: 0 }
  return { cached: true, entries: hit.ids.length }
}

export function loadVecCache(db: DatabaseSync): VecCache {
  const hit = VEC_CACHE.get(db)
  if (hit !== undefined) {
    // 用行数做失效探测：写入侧可能绕过本模块（测试、迁移脚本、别的进程），
    // 只靠显式 invalidate 会漏。一次 count 查询远比读到陈旧向量便宜。
    const now = Number((db.prepare('SELECT COUNT(*) AS n FROM atom').get() as { n: number | bigint }).n)
    if (now === hit.count) return hit
    VEC_CACHE.delete(db)
  }
  const rows = db.prepare('SELECT id, embedding FROM atom ORDER BY id').all() as Array<{
    id: number | bigint
    embedding: Uint8Array
  }>
  const ids: number[] = []
  const vecs: Float32Array[] = []
  const offset = new Map<number, number>()
  for (const r of rows) {
    const raw =
      r.embedding instanceof Uint8Array ? r.embedding : new Uint8Array(r.embedding as ArrayBufferLike)
    // 维度不符说明是别的模型/早期版本写的向量：跳过而不是硬算，
    // 否则会得到一个看起来正常、实际无意义的相似度。
    if (!isValidVecBlob(raw, VEC_DIM)) continue
    const v = decodeVec(raw)
    const id = Number(r.id)
    offset.set(id, ids.length)
    ids.push(id)
    vecs.push(v)
  }
  const cache: VecCache = { ids, vecs, offset, count: rows.length }
  VEC_CACHE.set(db, cache)
  return cache
}

/** 查询词里 ≤2 字的 CJK 词 —— 这些词 trigram 查不到，必须靠 Entry 层兜底。 */
const HAN = /\p{Script=Han}/u
function shortCjk(terms: Iterable<string>): string[] {
  const out: string[] = []
  for (const t of terms) if (t.length <= 2 && HAN.test(t[0] ?? '')) out.push(t)
  return out
}

/** FTS5 短语：用双引号包住，内部的引号按 FTS5 规则翻倍。 */
function ftsPhrase(t: string): string {
  return '"' + t.replace(/"/g, '""') + '"'
}

/**
 * Entry 路：bigram 索引（任意长度可查）+ 精确兜底。
 *
 * 为什么要两段并起来：bigram 索引覆盖任意长度，但词元必须是 bigram 切词的产物；
 * 而入口里可能有整体保留的词（非 CJK 整词、或写入方声明的原样词条），
 * 它们只在 term 列里，靠 bigram 查不到 —— 用 term 精确匹配补齐。
 */
function entryPath(db: DatabaseSync, query: string, k: number, scope?: string): number[] {
  const terms = [...bigramTerms(query)].slice(0, MAX_QUERY_TERMS)
  if (terms.length === 0) return []
  const orExpr = terms.map(ftsPhrase).join(' OR ')
  const placeholders = terms.map(() => '?').join(', ')
  const scopeSql = scope === undefined ? '' : " AND (a.scope = ? OR a.scope = 'global')"
  const args: Array<string | number> = [orExpr, ...terms]
  if (scope !== undefined) args.push(scope)
  args.push(k)
  const rows = db
    .prepare(
      'SELECT a.id AS id, MIN(f.bm25) AS s FROM (' +
        'SELECT rowid AS rid, bm25(entry_fts) AS bm25 FROM entry_fts WHERE bigram MATCH ? ' +
        ' UNION ALL ' +
        'SELECT id AS rid, 0 AS bm25 FROM entry WHERE term IN (' +
        placeholders +
        ') ' +
        ') f JOIN entry e ON e.id = f.rid JOIN atom a ON a.id = e.atom_id ' +
        ' WHERE 1 = 1' +
        scopeSql +
        NOT_ARCHIVED_SQL +
        ' GROUP BY a.id ORDER BY s LIMIT ?',
    )
    .all(...args) as Array<{ id: number | bigint; s: number }>
  return rows.map((r) => Number(r.id))
}

/**
 * 默认召回不含已归档的 atom（归档 = 默认不出现，显式检索才出现）。
 *
 * 写成 SQL 片段而不是在结果上过滤：三路词面/图路本来就是 SQL，加在结果上要多一次
 * 往返，还会让 meta.counts 与实际候选数对不上。向量路没有 SQL 可加，见 vecPath。
 *
 * 为什么可以是模块级常量：位定义在 `../db/flags.js`（没有内部依赖），本模块不再反向
 * import write.ts，于是模块图里那条 write → review → search 的环已经断开 —— 拼串时读到
 * 的必然是已初始化的绑定。
 */
const NOT_ARCHIVED_SQL = ' AND (a.flags & ' + FLAG_ARCHIVED + ') = 0'

/**
 * 正文路：trigram 索引。
 *
 * 只喂 ≥3 字符的词：trigram 对更短的词返回 0 命中（是预期行为，不是错误）。
 * 查询词里若没有 ≥3 字的词，这一路就直接缺席 —— 融合时缺失路不计项，不影响其他路。
 */
function bodyPath(db: DatabaseSync, query: string, k: number, scope?: string): number[] {
  const long = [...bigramTerms(query)].filter((t) => t.length >= 3).slice(0, MAX_QUERY_TERMS)
  if (long.length === 0) return []
  const orExpr = long.map(ftsPhrase).join(' OR ')
  const scopeSql = scope === undefined ? '' : " AND (a.scope = ? OR a.scope = 'global')"
  const args: Array<string | number> = [orExpr]
  if (scope !== undefined) args.push(scope)
  args.push(k)
  const rows = db
    .prepare(
      'SELECT a.id AS id, bm25(atom_fts) AS s FROM atom_fts ' +
        'JOIN atom a ON a.id = atom_fts.rowid ' +
        ' WHERE atom_fts MATCH ?' +
        scopeSql +
        NOT_ARCHIVED_SQL +
        ' ORDER BY s LIMIT ?',
    )
    .all(...args) as Array<{ id: number | bigint; s: number }>
  return rows.map((r) => Number(r.id))
}

/**
 * 图路：从种子做一跳扩展，只走结构化边。
 *
 * **每个种子各自限量**，而不是所有种子合起来抢一个 LIMIT。差别不是性能：合起来限量时，
 * 一个高度数的种子就能吃掉全部名额，其余种子一条都出不来 —— 十路种子等于只有一路在
 * 工作。这正是 §40 说的「1 跳扩展失去判别力」的形态，所以在查询侧也要各自封顶。
 *
 * 这里只做**出度**封顶，不设 confidence 线：截断线在生成侧（graph/infer.ts）是唯一
 * 真相源，两处各写一条线会让「边为什么没出来」变成一个要读两个文件才能回答的问题。
 */
function graphPath(db: DatabaseSync, seeds: number[], k: number, scope?: string): number[] {
  if (seeds.length === 0) return []
  const ph = seeds.map(() => '?').join(', ')
  const kinds = GRAPH_KINDS.map((x) => "'" + x + "'").join(', ')
  // 列名带 e. 前缀：下面 JOIN 了 atom，而 atom 表也有一个 kind 列，不限定会报歧义。
  const atomAtom = "e.src_type = 'atom' AND e.dst_type = 'atom' AND e.kind IN (" + kinds + ')'
  // 一跳邻居同样要过 scope。种子（向量路）是过滤过的，**邻居不是** —— 只在种子那侧过滤时，
  // 一条跨域的边就能把别的域的 atom 带进结果。实测（scripts/verify-scope-write.mjs 的
  // 判据 2/4/5）：scope=global 的召回里曾出现项目域 atom，来源正是这条路。
  const scopeSql = scope === undefined ? '' : " AND (a.scope = ? OR a.scope = 'global')"
  const sql =
    'WITH nb(seed, id, c) AS (' +
    'SELECT e.src_id AS seed, e.dst_id AS id, e.confidence AS c FROM edge e ' +
    'JOIN atom a ON a.id = e.dst_id WHERE ' +
    atomAtom +
    ' AND e.src_id IN (' +
    ph +
    ')' +
    scopeSql +
    NOT_ARCHIVED_SQL +
    ' UNION ALL ' +
    'SELECT e.dst_id AS seed, e.src_id AS id, e.confidence AS c FROM edge e ' +
    'JOIN atom a ON a.id = e.src_id WHERE ' +
    atomAtom +
    ' AND e.dst_id IN (' +
    ph +
    ')' +
    scopeSql +
    NOT_ARCHIVED_SQL +
    '), ranked AS (' +
    'SELECT id, c, ROW_NUMBER() OVER (PARTITION BY seed ORDER BY c DESC) AS rn FROM nb WHERE id <> seed' +
    ') SELECT id, MAX(c) AS s FROM ranked WHERE rn <= ? GROUP BY id ORDER BY s DESC LIMIT ?'
  // 参数按 SQL 里出现的顺序压：种子 → 该路的 scope → 另一侧的种子 → scope → 出度 → 条数。
  const args: Array<string | number> =
    scope === undefined
      ? [...seeds, ...seeds, OUT_DEGREE_CAP, k]
      : [...seeds, scope, ...seeds, scope, OUT_DEGREE_CAP, k]
  const rows = db.prepare(sql).all(...args) as Array<{
    id: number | bigint
    s: number
  }>
  return rows.map((r) => Number(r.id))
}

/** 向量路的中间结果：id + 余弦，按余弦降序。 */
interface VecHit {
  id: number
  cos: number
}

/**
 * 已归档的 atom id 集合，供向量路跳过。
 *
 * 为什么不把 flags 一起塞进向量缓存：那个缓存只按**行数**失效，而归档不改行数。
 * 把状态缓存进去，归档会对向量路静默失效（词面三路已经过滤、向量路照旧命中），
 * 这种「一路漏过滤」正是归档改动要防的形态。现查一次走 `idx_atom_flags` 的部分索引，
 * 代价远小于一次召回本身。
 */
function archivedIdSet(db: DatabaseSync): Set<number> {
  const rows = db.prepare('SELECT id FROM atom WHERE (flags & ?) <> 0').all(FLAG_ARCHIVED) as Array<{
    id: number | bigint
  }>
  return new Set(rows.map((r) => Number(r.id)))
}

/**
 * 向量路：暴力点积。
 *
 * 为什么不用 SQL 逐条读向量：BLOB 解码 + 跨语言边界调用的开销远大于点积本身。
 * 向量常驻内存后，这里就是纯算术。
 */
function vecPath(db: DatabaseSync, q: Float32Array | null, k: number, scope?: string): VecHit[] {
  if (q === null || q.length !== VEC_DIM) return []
  const cache = loadVecCache(db)
  const archived = archivedIdSet(db)
  const allowed =
    scope === undefined
      ? null
      : new Set(
          (
            db.prepare("SELECT id FROM atom WHERE scope = ? OR scope = 'global'").all(scope) as Array<{
              id: number | bigint
            }>
          ).map((r) => Number(r.id)),
        )
  // 简单的 top-k 维护：用升序数组当小顶堆，k=100 时开销可忽略。
  const best: VecHit[] = []
  for (let i = 0; i < cache.ids.length; i++) {
    const id = cache.ids[i]!
    if (archived.has(id)) continue
    if (allowed !== null && !allowed.has(id)) continue
    const v = cache.vecs[i]!
    let s = 0
    for (let j = 0; j < VEC_DIM; j++) s += q[j]! * v[j]!
    if (best.length < k) {
      best.push({ id, cos: s })
      best.sort((a, b) => a.cos - b.cos)
    } else if (s > best[0]!.cos) {
      best[0] = { id, cos: s }
      best.sort((a, b) => a.cos - b.cos)
    }
  }
  return best.sort((a, b) => b.cos - a.cos)
}
/** 单路最多用多少个词进 FTS 查询。长查询切出的 bigram 会很多，超出部分区分度也低。 */
export const MAX_QUERY_TERMS = 48 satisfies ThresholdValue<
  'chosen',
  {
    area: '召回融合'
    why: '单路最多用多少词进 FTS 查询是判断：长查询切出的 bigram 会很多，超出部分区分度也低；分类表把它归为「中文 bigram 的候选密度」，但无实测'
    failsWhen: ['库规模', '查询长度分布', '中文 bigram 的候选密度']
    affects: '单路最多用多少个词进 FTS 查询'
    diverges: '它已被列为「按实际候选数取、用 FTS5 查询复杂度上限兜底」的待办项，未做'
  }
>

/**
 * 四路各自取多少条进融合：向量路 100、词面两路各 100、图路 50。
 *
 * 三个值是三个量，不是「同一个数的三份拷贝」：kVec 决定向量粗筛的宽度，kLex 决定
 * 词面两路（Entry 与正文）各自的名额，kGraph 决定图路一跳扩展的上限。取值随库规模
 * 变化，固定上限在库长大时会让召回质量悄悄退化 —— 改预算制属后续执行点（第二批），
 * 本次只把它们从内联字面量提成具名常量，取值未变。
 */
export const K_VEC = 100 satisfies ThresholdValue<
  'chosen',
  {
    area: '召回融合'
    why: '向量路进融合的固定条数上限：随库规模变化、实际约束的是召回质量而不是性能，无记录、无实测；取多少是固定上限的取舍'
    failsWhen: ['库规模（库长大时固定取前 N 会让召回质量悄悄退化）']
    affects: '向量路取多少条进融合（向量粗筛的宽度）'
    diverges: '**zod schema 里也没有** —— 固定上限改预算制是第二批的事（与另一项合并）'
  }
>
export const K_LEX = 100 satisfies ThresholdValue<
  'chosen',
  {
    area: '召回融合'
    why: '与 K_VEC 同一次盘点、同一类：词面两路各取多少条进融合，无记录、无实测；固定上限随库规模漂移'
    failsWhen: ['库规模', '中文 bigram 的候选密度']
    affects: '词面两路（Entry 与正文）各取多少条进融合'
    diverges: '**zod schema 里也没有**'
  }
>
export const K_GRAPH = 50 satisfies ThresholdValue<
  'chosen',
  {
    area: '召回融合'
    why: '图路一跳取多少条进融合是容量分配，没有测量过程能给出这个数；与 K_VEC 同一次盘点、同一类，无实测'
    failsWhen: ['图路的边密度', '库规模']
    affects: '图路一跳扩展取多少条进融合（与 OUT_DEGREE_CAP 分工：那条限每个种子的出度，这条限总量）'
    diverges: '**zod schema 里也没有**'
  }
>

/**
 * 图路拿向量路的前多少条做种子。
 *
 * 图路是「补多跳关联」，不是主召回，所以只从最像的那几条出发；种子多了会把
 * 一跳扩展的候选池灌满噪声。取值依据与 kGraph 属同一类（无实测记录）。
 */
export const DEFAULT_SEED_COUNT = 10 satisfies ThresholdValue<
  'chosen',
  {
    area: '召回融合'
    why: '图路用向量路的前多少条做种子：源码无注释、设计说明里也没有这个数，是固定条数上的取舍，无测量'
    failsWhen: ['图路的边密度与精度', '库规模']
    affects: '图路用向量路的前多少条做种子（A.slice(0, DEFAULT_SEED_COUNT)）'
  }
>

/**
 * 召回交给注入层的默认条数（调用方不传 topN 时用它）。
 *
 * 与写入侧的 DEFAULT_TOP_N 同为 24，但**不是同一个量**：那个是落位时取多少个 topic
 * 候选，这个是召回返回多少条。两者同值纯属巧合，合并会把「调落位候选数」变成
 * 「改注入条数」。运行时实际生效的默认值来自配置项 topN（见 tools/index.ts）。
 */
export const RECALL_TOP_N = 24 satisfies ThresholdValue<
  'chosen',
  {
    area: '召回融合'
    why: '24 只在调用方不传 topN 时起作用，生产路径实际生效的是配置项 topN（zod 默认 24）；默认条数是容量选择，没有测量给出它'
    failsWhen: ['注入字符预算', '一次注入能容纳的摘要条数']
    affects: '召回交给注入层的默认条数（调用方不传 topN 时用它）'
    diverges: '**与 DEFAULT_TOP_N 同为 24、不同量**（第一批判定为恰好同值，不合并）：那个是落位时取多少个 topic 候选，这个是召回交注入层的条数。设计说明 §7 的 topN 指后者'
    doc: 'config'
    docKey: 'topN'
    docDefault: 24
    docRange: [5, 50]
    zod: { file: 'src/index.ts'; name: 'topN' }
  }
>

/**
 * RRF 融合。
 *
 * 只累加**出现过的路**：某路缺席（比如短查询时正文路返回空）不该被当成排名靠后，
 * 否则缺席路的候选会集体被稀释，等于惩罚了那些本来就没打算参与的路。
 */
export function fuse(
  lists: Partial<Record<Channel, readonly number[]>>,
): Map<number, { score: number; ranks: Partial<Record<Channel, number>> }> {
  const acc = new Map<number, { score: number; ranks: Partial<Record<Channel, number>> }>()
  for (const ch of Object.keys(lists) as Channel[]) {
    const list = lists[ch]
    if (list === undefined) continue
    const w = CHANNEL_WEIGHT[ch]
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!
      const e = acc.get(id) ?? { score: 0, ranks: {} }
      e.score += w / (RRF_K + i + 1)
      e.ranks[ch] = i + 1
      acc.set(id, e)
    }
  }
  return acc
}

/** 归属因子：按 atom_topic 里是否存在非 primary 记录判断。 */
function affiliationFactor(secondary: boolean, onlyGraph: boolean): number {
  if (!secondary) return AFFILIATION.primary
  return onlyGraph ? AFFILIATION.graphOnly : AFFILIATION.secondary
}

/**
 * 标记重复并压制。
 *
 * 先按主属 topic 分桶再两两比较：桶内规模是个位数，**全局两两比较是 O(N²)**，
 * 200 个候选就是 2 万次，而分桶后通常只有几十次。
 *
 * 现在改用词面兜底判断（原设计依赖 atom_pair 表）：cos ≥ 0.92 且词面重叠 ≥ 0.5 才算重复，
 * 两个条件都严格 —— 同义换述被词面挡掉、纯噪声被 cos 挡掉，所以用摘要而不是全文就够。
 * 精度更高的 atom_pair 表由重聚类任务建立，接入后这里可以直接换成查表。
 */
export const DUP_COS = 0.92 satisfies ThresholdValue<
  'chosen',
  {
    area: '重排去重'
    why: '0.92 沿用原设计 atom_pair 表的既有取值，改成词面判定后没有重测；没有一次「不同说法的同一件事」实测（DUP_LEX 才有）。几何票的门槛是旧接口留下的数'
    failsWhen: ['换编码模型（余弦尺度会变）', '同义改写的相似度分布']
    guardedBy: ['test/archive.test.mjs']
    affects: '重复压制：余弦低于此值即不判重复（两票中的几何票）；仅在同主属 topic 桶内两两比较'
  }
>
/**
 * 判定重复所需的词面重叠。
 *
 * 原设计取 0.5，实测发现**中文短文本上太松**：「系统代理必须走本地端口，否则访问
 * 境外源会超时」与「系统代理配置本地端口，否则访问境外源会超时」的 bigram-Jaccard
 * 是 0.64 —— 它们讲的是同一件事，但一条强调「必须」、一条强调「配置」，各自都有
 * 信息，都不该被折叠。0.5 会把这类记忆压掉，而那正是本设计要保住的东西。
 *
 * 取 0.72：只有几乎逐字重复才会被压制。真正重复的（同一段文本）实测 Jaccard 为 1.0，
 * 稳过。宁可漏压（多出一条），也不误压（丢掉一条信息）。
 */
export const DUP_LEX = 0.72 satisfies ThresholdValue<
  'recheckable',
  {
    area: '重排去重'
    tool: '无脚本（构造的对照句对，直接算 bigram-Jaccard）'
    finding: '0.5 时「系统代理必须走本地端口……」与「系统代理配置本地端口……」的 bigram-Jaccard 为 0.64，两者讲同一件事但各有信息、不该折叠；取 0.72 后只有几乎逐字重复才被压制（同一段文本 Jaccard 为 1.0）'
    encoderModel: '不适用（纯词面 bigram-Jaccard，不用向量）'
    scale: '构造的对照句对：1 组近义改写 + 1 组逐字相同'
    failsWhen: ['语料语言与书写粒度', '摘要长度（词面 Jaccard 对短文本更敏感）']
    guardedBy: ['test/archive.test.mjs']
    affects: '重复压制：词面重叠低于此值即不判重复（两票中的词面票）'
  }
>

/**
 * 召回层的真重复判据：字符 3-gram 覆盖度。
 *
 * 与上面的 `DUP_COS` / `DUP_LEX` 不是一回事 —— 那两个定义库里「两个 atom 算不算重复」，
 * 是 `atom_pair` 表的判据，写入侧、图推断、聚类重建都在用。这条只服务召回时的压制，
 * 它面对的条件更差：只看得见这次候选，且必须避免误压。
 *
 * 为什么用字符 3-gram 覆盖度而不是余弦：真重复对的余弦可以低到 0.42（同一段话被切成
 * 两条、各自带进了不同的上下文），用余弦筛会全部漏掉。为什么用覆盖度而不是 Jaccard：
 * 一条是另一条的前缀时（切分造成的重复常态），Jaccard 只有 0.5 上下，覆盖度接近 1.0。
 *
 * 取 0.7 的依据：逐字相同的两段实测 1.000；同一条记忆被切断、大半相同尾部不同 0.860；
 * 「系统代理必须走本地端口……」对「系统代理配置本地端口……」0.242（它们各有一条信息，
 * 不该折叠）；同一份材料里不同小节之间 0.24–0.57。0.7 落在「逐字重复」与「同一篇的
 * 不同内容」之间，宁漏压不误压。
 */
export const DUP_TEXT = 0.7 satisfies ThresholdValue<
  'recheckable',
  {
    area: '重排去重'
    tool: '无脚本（构造的对照句对，直接算字符 3-gram 覆盖度）'
    finding: '逐字相同 1.000、切断留尾 0.860、同一篇不同小节 0.24–0.57、各有信息的近义改写 0.242；0.7 落在逐字重复与同篇不同内容之间'
    failsWhen: [
      '语言与书写粒度（代码块、表格里 3-gram 的重复率与散文不同）',
      '极短 atom（少于 3 个字符时没有 3-gram）',
    ]
    scale: '三个语料共 4216 个 atom（同来源组内 top3 比较）+ 5 组构造句对'
    guardedBy: ['test/search.test.mjs']
    affects: '召回压制：同一来源（source）桶内 3-gram 覆盖度达到此值即判为真重复；来源为空的条目不参与比较（没有来源证明不了同源）'
  }
>

/**
 * 全库最高余弦：给定查询向量，库内所有有向量的 atom 里最高的那个相似度。
 *
 * 与 `vecPath`（按 kVec 截断）不同，它不做截断 —— 判「有没有内容」要的就是这个数。
 * 拿候选池内最高分代替它会把「库很大但这次候选少」错判成没内容，而候选池大小是
 * 容量选择（topN），不该影响「库里有不有相关内容」这个事实。
 */
export function top1Cosine(db: DatabaseSync, queryVec: Float32Array): number {
  const cache = loadVecCache(db)
  let best = -1
  for (let i = 0; i < cache.vecs.length; i++) {
    const c = cosine(queryVec, cache.vecs[i]!)
    if (c > best) best = c
  }
  return best < 0 ? 0 : best
}

/**
 * 取代压制：一条记忆被另一条取代时，只要取代它的那条也在本次候选里，就不出被取代的那条。
 *
 * **为什么条件是「取代者在候选里」**：取代者这次没命中却把旧条压掉，等于这一组什么都不给 ——
 * 用户看不到新条，也看不到旧条。旧条是唯一还能用的信息（注入层会标「已被取代」）。
 *
 * **为什么不管 final 高低**：重复压制（suppressDuplicates）是「两条讲同一件事」，所以取分高
 * 的那条；取代是「旧条的内容已经过期」，旧条分再高也是过时答案 —— 只留新条。
 *
 * 只跳一跳：A→B→C 这种链只处理 A 被 B 取代，不再追到 C。链式取代目前没有写入方，
 * 真出现时留给以后按证据处理，不在这里猜。
 */
function suppressSuperseded(items: RecallHit[]): { dropped: RecallHit[] } {
  if (items.length === 0) return { dropped: [] }
  const alive = new Set(items.map((h) => h.id))
  const dropped: RecallHit[] = []
  for (const h of items) {
    const by = h.supersededBy
    if (by === null || by === h.id) continue // 自指是数据损坏，不据此压制
    if (!alive.has(by)) continue // 取代者不在候选里：保留旧条
    dropped.push(h)
  }
  if (dropped.length === 0) return { dropped }
  const drop = new Set(dropped.map((h) => h.id))
  const kept = items.filter((h) => !drop.has(h.id))
  items.length = 0
  items.push(...kept)
  return { dropped }
}

/** 字符 3-gram。中文没有空格可切，按字符切才对得上「几乎逐字重复」这个直觉。 */
export function trigramsOf(text: string): Set<string> {
  const t = text.replace(/\s+/g, ' ')
  const out = new Set<string>()
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
  return out
}

/** 覆盖度：小集合里有多大比例出现在大集合里。一条是另一条的前缀时接近 1.0。 */
export function coverageOf(a: Set<string>, b: Set<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  if (small.size === 0) return 0
  let n = 0
  for (const g of small) if (big.has(g)) n++
  return n / small.size
}

/** 只读候选集的正文。压制是唯一需要正文的环节（摘要太短，3-gram 比不出重复）。 */
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
 * 真重复压制：同一来源内逐字重复的两条只留一条。
 *
 * 分桶单位是 `source`（写入时给的那个值），不是主题：同一个主题下讲两件事是常态
 * （实测三个库 59%–90% 的同篇条目落在不同主题），拿主题分桶会把它们放进同一组去比；
 * 反过来同一来源才可能逐字重复。`source` 为空时**不进任何桶** —— 没有来源就证明不了
 * 同源，而整库一个桶等于让全库互相比。实测后果：手写记忆里「系统代理必须走本地端口…」
 * 与「系统代理配置本地端口…」的 3-gram 覆盖度是 0.800，会被判成真重复压掉一条，
 * 而这两条在写入侧早就过了 `DUP_COS`/`DUP_LEX` 那一层。传了 `source` 的条目才参与比较。
 *
 * 判据只看文本重叠，不看余弦（见 DUP_TEXT 的说明）。
 */
function suppressDuplicates(db: DatabaseSync, items: RecallHit[]): number {
  if (items.length < 2) return 0
  const texts = loadTexts(
    db,
    items.map((h) => h.id),
  )
  const bySource = new Map<string, RecallHit[]>()
  for (const h of items) {
    if (h.source === null) continue
    const arr = bySource.get(h.source) ?? []
    arr.push(h)
    bySource.set(h.source, arr)
  }
  const dropped = new Set<number>()
  for (const bucket of bySource.values()) {
    if (bucket.length < 2) continue
    bucket.sort((a, b) => b.final - a.final)
    const kept: Array<{ id: number; grams: Set<string>; len: number }> = []
    for (const h of bucket) {
      if (dropped.has(h.id)) continue
      const body = texts.get(h.id)
      if (body === undefined) continue
      const grams = trigramsOf(body)
      if (grams.size === 0) continue
      let dup = false
      for (const prev of kept) {
        // 长度预筛：覆盖度的上界是 min/max，长度差一倍以上时不可能达到 0.7，
        // 直接跳过。候选多时这一条把 O(n²) 的比较砍掉大半。
        const ratio = Math.min(prev.len, body.length) / Math.max(prev.len, body.length)
        if (ratio < DUP_TEXT) continue
        if (coverageOf(grams, prev.grams) >= DUP_TEXT) {
          dup = true
          break
        }
      }
      if (dup) dropped.add(h.id)
      else kept.push({ id: h.id, grams, len: body.length })
    }
  }
  if (dropped.size === 0) return 0
  const kept = items.filter((h) => !dropped.has(h.id))
  items.length = 0
  items.push(...kept)
  return dropped.size
}

/** 取命中 atom 的摘要与主属（只查命中集合，不碰全表）。 */
function loadAtomInfo(db: DatabaseSync, ids: number[]): Map<number, AtomRow> {
  const out = new Map<number, AtomRow>()
  if (ids.length === 0) return out
  const ph = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      'SELECT id, topic_id, fit, summary, origin, superseded_by, flags, source, source_ref FROM atom WHERE id IN (' +
        ph +
        ')',
    )
    .all(...ids) as Array<{
    id: number | bigint
    topic_id: number | bigint
    fit: number
    summary: string
    origin: string
    superseded_by: number | bigint | null
    flags: number | bigint | null
    source: string | null
    source_ref: string | null
  }>
  for (const r of rows) {
    out.set(Number(r.id), {
      id: Number(r.id),
      topicId: Number(r.topic_id),
      fit: Number(r.fit),
      summary: String(r.summary),
      origin: String(r.origin),
      supersededBy: r.superseded_by === null ? null : Number(r.superseded_by),
      flags: r.flags === null ? 0 : Number(r.flags),
      // 「来源」取两列里有值的那一列，**优先 source_ref**。
      //
      // 优先顺序不是随意的：导入脚本把 source 填成构建标签（语料名），source_ref 才是整篇的
      // 路径；文档级命中统计与同源分桶都以「同一篇」为单位，所以路径这一列优先。工具写入
      // 只填 source（没有文档路径），这时用它分桶仍然成立。空串按没填处理。
      source:
        r.source_ref !== null && String(r.source_ref) !== ''
          ? String(r.source_ref)
          : r.source !== null && String(r.source) !== ''
            ? String(r.source)
            : null,
    })
  }
  return out
}

/** 哪些 atom 有次属（用于归属因子）。 */
function secondarySet(db: DatabaseSync, ids: number[]): Set<number> {
  if (ids.length === 0) return new Set()
  const ph = ids.map(() => '?').join(', ')
  const rows = db
    .prepare("SELECT DISTINCT atom_id FROM atom_topic WHERE origin <> 'primary' AND atom_id IN (" + ph + ')')
    .all(...ids) as Array<{ atom_id: number | bigint }>
  return new Set(rows.map((r) => Number(r.atom_id)))
}
/**
 * 召回入口。
 *
 * 契约要点：
 *   - 只读：不写库、不记查询日志。learned 反哺**不在这里**，由 lattice_recall 工具在返回前
 *     显式调用 entries.ts 的 feedLearned 完成。原先这里写的是「由上层异步做」—— 而本插件
 *     只有工具、没有 hook（见 tools/index.ts 的文件头），那个「上层」并不存在，
 *     照着它去找调度层只会白找。
 *   - 查询向量由调用方传入：本模块不加载模型，便于单测注入假向量
 *   - 失败不留白：任何一路缺席都体现在 meta 里
 */
/**
 * 记一次召回命中。
 *
 * 「命中」在这里的含义严格地是**被召回并进入了注入**，不是「模型用了它」—— 后者需要
 * 反馈信号，而本插件不对模型的心思做假设。名字与文档都要守住这个区别，否则这个计数
 * 会被读成它没有的含义。
 *
 * 会写库，因此调用方必须确保连接可写（工具侧可以，只读的复盘脚本不可以）。
 */
export function recordRecall(db: DatabaseSync, ids: readonly number[], now = Date.now()): number {
  if (ids.length === 0) return 0
  const ph = ids.map(() => '?').join(', ')
  const r = db
    .prepare('UPDATE atom SET recall_hits = recall_hits + 1, last_recalled_at = ? WHERE id IN (' + ph + ')')
    .run(now, ...ids)
  return Number(r.changes)
}

export function recall(
  db: DatabaseSync,
  query: string,
  queryVec: Float32Array | null,
  opts: RecallOptions = {},
): RecallResult {
  const t0 = Date.now()
  const kVec = opts.kVec ?? K_VEC
  const kLex = opts.kLex ?? K_LEX
  const kGraph = opts.kGraph ?? K_GRAPH
  const topN = opts.topN ?? RECALL_TOP_N
  const scope = opts.scope
  const reference = opts.reference

  const q = String(query ?? '').trim()
  const terms = bigramTerms(q)
  const shorts = shortCjk(terms)

  // 四路各自召回。向量路同时提供图路的种子。
  const vecHits = vecPath(db, queryVec, kVec, scope)
  const A = vecHits.map((h) => h.id)
  const E = entryPath(db, q, kLex, scope)
  const B = bodyPath(db, q, kLex, scope)
  // 图路的输入是推断边（src/graph/infer.ts）。这里**只读**：读路径不建边 —— 推断边是
  // 几何派生物（设计 14 的分界），可由写入路径（linkNewAtom）与显式命令
  // （scripts/rebuild-graph.mjs）重建，但不由读触发。读只报边表现状，缺口交给那两处。
  // 声明边（origin = declared）不是本模块的产出，但它同样进图路（GRAPH_KINDS 有 related）——
  // 分开报，读者才知道「图路有值」是来自真相源还是派生物。
  const graphEdges = edgeOriginCounts(db)
  const graphStatus = '声明边 ' + graphEdges.declared + ' 条，推断边 ' + graphEdges.inferred + ' 条'
  const G = graphPath(db, A.slice(0, DEFAULT_SEED_COUNT), kGraph, scope)

  // 图路只负责**引入别处没有的候选**，不对已有候选重复计票。
  //
  // 为什么必须有这一条限定：RRF 的前提是各路信息互补。而本轮推断出的 near 边是**几何
  // 近邻**，与向量路同源 —— 对同一个候选计两票，等于把「它离查询近」这件事算了两遍，
  // 头部被放大、中段的正确答案被挤下去。实测（基准库 + 20 条 gold）：不做这一步过滤时
  // Recall@12 从 95.0% 掉到 80.0%，Recall@24 不变 —— 正是 §40 说的「MOD 涨而检索
  // 不变好」的形态。加上过滤后逐条与改动前一致。
  //
  // 这不是「让图路失效」：等到库里有 declared / co_occur 这类**非几何**的边时，它们带来
  // 的候选不在向量路里，图路照样能把它们引进来。
  const lexicalIds = new Set<number>([...A, ...E, ...B])
  const freshGraph = G.filter((id) => !lexicalIds.has(id))
  const fused = fuse({ vec: A, entry: E, body: B, graph: freshGraph })
  const ids = [...fused.keys()]
  const info = loadAtomInfo(db, ids)
  const secondary = secondarySet(db, ids)

  // 归属因子：主属命中 1.0；仅次属 0.76；只由图路引入 0.70。
  const rankOrdered = [...fused.entries()].sort((a, b) => b[1].score - a[1].score)
  const hits: RecallHit[] = []
  const vecMap = new Map<number, Float32Array>()
  // 这里必须无条件加载：重复检测要用 atom 自己的向量，与「有没有查询向量」无关。
  // 早先写成 queryVec === null ? null : ...，结果是纯词面召回时重复检测**永远拿不到向量**，
  // 压制率恒为 0 —— 又是一个不报错的静默失效。
  const vecCache = loadVecCache(db)
  let primaryHits = 0
  let secondaryHits = 0
  let maxCosine = 0
  for (const [id, acc] of rankOrdered) {
    const row = info.get(id)
    if (row === undefined) continue
    const isSecondary = secondary.has(id)
    const onlyGraph = Object.keys(acc.ranks).length === 1 && acc.ranks.graph !== undefined
    const aff = affiliationFactor(isSecondary, onlyGraph)
    if (isSecondary) secondaryHits++
    else primaryHits++
    const v = vecCache.vecs[vecCache.offset.get(id) ?? -1]
    if (v !== undefined) vecMap.set(id, v)
    // 排序分就是余弦，不是融合分乘归属因子。
    //
    // 为什么必须换成同一个量：融合分与「有多相关」不是一回事 —— 它是 w/(60+名次) 逐路
    // 累加，top1 恒在 0.0164 附近，只携带「命中几路、排第几」，没有相关性的语义。原先
    // 排序用融合分、判档用余弦，等于同一批结果被两把刻度量了两次。实测在技术笔记与新闻
    // 上，融合分下相关查询的 p10 低于无关查询的 p90（分不开），余弦下三个库都分得开。
    //
    // 没有查询向量（纯词面召回）时退回融合分：那时余弦无从算起，meta.vectorMissing 会说明。
    let final = acc.score
    if (v !== undefined && queryVec !== null) {
      const c = cosine(queryVec, v)
      final = c
      if (c > maxCosine) maxCosine = c
    }
    hits.push({
      id,
      score: acc.score,
      final,
      topicId: row.topicId,
      fit: row.fit,
      summary: row.summary,
      origin: row.origin,
      supersededBy: row.supersededBy,
      flags: row.flags,
      ranks: acc.ranks,
      affiliation: aff,
      source: row.source,
    })
  }
  // 余弦降序。判定（分位线）与排序用同一个量，所以「装进来的第一条」就是判据看的那个分 ——
  // 这也让分位线的含义可以被用户自己核对：他自己编码一句问句，算一遍库里的最高余弦即可。
  hits.sort((a, b) => b.final - a.final)
  // 最高余弦：只统计有向量的命中（词面命中也在列表里，但它们不带余弦）。
  const topCosine = maxCosine
  // 先取代、后重复：取代是 O(n) 的一次扫，先跑能减少重复检测的输入（那个是组内 O(n²)）。
  const superseded = suppressSuperseded(hits)
  const suppressed = suppressDuplicates(db, hits)
  let kept = hits.slice(0, topN)
  // 取代者可能只在候选集里、没进最终的 topN（比如查询与那一组都不太相关）。那种时候把旧条
  // 压掉等于这一组什么都不给 —— 恢复旧条，注入层会标「已被取代」，比「一条都没有」有用。
  // 判据是「压掉之后取代者在不在结果里」，所以必须等 topN 截断之后才能判，不能在压制那一步判。
  let suppressedSuperseded = superseded.dropped.length
  if (superseded.dropped.length > 0) {
    const keptIds = new Set(kept.map((h) => h.id))
    const restore = superseded.dropped.filter((h) => h.supersededBy !== null && !keptIds.has(h.supersededBy))
    if (restore.length > 0) {
      hits.push(...restore)
      hits.sort((a, b) => b.final - a.final)
      kept = hits.slice(0, topN)
      suppressedSuperseded -= restore.length
    }
  }

  // 命中的主题汇总：注入层据此生成「入口」段。
  const topicCount = new Map<number, number>()
  for (const h of kept) topicCount.set(h.topicId, (topicCount.get(h.topicId) ?? 0) + 1)
  const topics: TopicSummary[] = []
  for (const [topicId, n] of topicCount) {
    const row = db.prepare('SELECT label FROM topic WHERE id = ?').get(topicId) as
      { label: string } | undefined
    topics.push({ topicId, label: row?.label ?? '', hits: n })
  }
  topics.sort((a, b) => b.hits - a.hits)

  // 退化必须可观测：词面两路全空、但向量路有货 —— 只剩向量，静默失效要留痕。
  const lexicalDegraded = E.length === 0 && B.length === 0 && A.length > 0
  const shortTermMiss = E.length === 0 && shorts.length > 0

  // 判定：这次召回有没有内容。判的是 `maxCosine`（全库最高），不是 `kept[0]` ——
  // 后者受候选池与压制影响，会让「库里有相关内容但这次没选进来」看起来像「库里没有」。
  // 判据不可用（库太小、线太高、没有参考线）时给 null，由回执说明判不了的原因。
  const hasContent = reference === undefined || !reference.usable ? null : topCosine >= reference.line

  return {
    hits: kept,
    topics,
    meta: {
      counts: { vec: A.length, entry: E.length, body: B.length, graph: G.length },
      graphStatus,
      lexicalDegraded,
      shortTermMiss,
      vectorMissing: queryVec === null,
      suppressed,
      suppressedSuperseded,
      topCosine,
      hasContent,
      referenceLine: reference !== undefined && reference.usable ? reference.line : null,
      referenceReason: reference?.reason ?? 'none',
      primaryHits,
      secondaryHits,
      // 只读一次 split_queue。它不进任何打分，只决定锚行那句提示的措辞。
      splitConfirmed: readConfirmedSplits(db),
      splitPendingSegments: [...readPendingSegments(db)],
      elapsedMs: Date.now() - t0,
    },
  }
}

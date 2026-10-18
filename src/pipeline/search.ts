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
import { bigramTerms, jaccard } from '../util/text.js'
import { cosine, decodeVec, isValidVecBlob, VEC_DIM } from '../util/vec.js'
import { edgeOriginCounts, ensureGraphEdges, GRAPH_KINDS, OUT_DEGREE_CAP } from '../graph/infer.js'
import { FLAG_ARCHIVED } from './write.js'
import { readConfirmedSplits } from './split.js'

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
export const RRF_K = 60

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
   * 图路的输入状态：`<状态>（声明边 N 条，推断边 M 条）`。状态前缀是
   * graph/infer.ts 的 InferOutcome.status 原值。
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
   * 用户已确认「这条应当拆分」的 atom id（T29）。来自 meta 的 split_confirmed 清单，
   * 上限由 SPLIT_CONFIRMED_MAX 夹住（FIFO）。注入层据此把锚行提示换成「已确认」的说法。
   *
   * 为什么由召回带出来而不是让注入层自己读：meta 是库里的东西，注入层只该认识
   * RecallResult —— 它连 getMeta 都不该 import（依赖方向是 tools → pipeline：读库的
   * 决定在这里做一次，而不是每个渲染分支各做一次）。
   */
  splitConfirmed: number[]
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

function loadVecCache(db: DatabaseSync): VecCache {
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
        notArchived() +
        ' GROUP BY a.id ORDER BY s LIMIT ?',
    )
    .all(...args) as Array<{ id: number | bigint; s: number }>
  return rows.map((r) => Number(r.id))
}

/**
 * 默认召回不含已归档的 atom（T26：归档 = 默认不出现，显式检索才出现）。
 *
 * 写成 SQL 片段而不是在结果上过滤：三路词面/图路本来就是 SQL，加在结果上要多一次
 * 往返，还会让 meta.counts 与实际候选数对不上。向量路没有 SQL 可加，见 vecPath。
 *
 * 为什么是函数而不是模块级字符串常量：模块图里有一条环 write → review → search → write。
 * 模块级拼串会在 write.ts 还没初始化完时读 FLAG_ARCHIVED（TDZ 报错）；函数在调用时读，
 * 那时它早已就绪。拆这条环属于 review/search 的职责边界，不是本任务该动的地方。
 */
function notArchived(): string {
  return ' AND (a.flags & ' + FLAG_ARCHIVED + ') = 0'
}

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
        notArchived() +
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
    notArchived() +
    ' UNION ALL ' +
    'SELECT e.dst_id AS seed, e.src_id AS id, e.confidence AS c FROM edge e ' +
    'JOIN atom a ON a.id = e.src_id WHERE ' +
    atomAtom +
    ' AND e.dst_id IN (' +
    ph +
    ')' +
    scopeSql +
    notArchived() +
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

/**
 * 确保库里有推断边，每个连接只尝试一次。
 *
 * 为什么图路的建边挂在召回上：本次改动允许碰的文件里，只有 search.ts 是「每次召回都会
 * 经过」的那个。其余两个自然挂载点（写入路径 write.ts、工具入口 tools/index.ts）都在
 * 边界之外。不挂的话，图路在宿主里仍然是 0 —— 那等于没做这件事。
 *
 * 代价与边界：**只读连接建不了边**（诊断、对照实验都走只读）。那不是错误，是被允许的
 * 用法，所以这里捕获异常并把状态如实报进 meta，而不是让它变成一个安静的空结果。
 */
const graphEnsureState = new WeakMap<DatabaseSync, string>()

function ensureGraphOnce(db: DatabaseSync): string {
  const known = graphEnsureState.get(db)
  if (known !== undefined) return known
  let status: string
  try {
    status = ensureGraphEdges(db, { dupCos: DUP_COS, dupLex: DUP_LEX }).status
  } catch (err) {
    status = 'unavailable: ' + (err instanceof Error ? err.message : String(err))
  }
  graphEnsureState.set(db, status)
  return status
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
 * 这种「一路漏过滤」正是 T26 要防的形态。现查一次走 `idx_atom_flags` 的部分索引，
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
export const MAX_QUERY_TERMS = 48

/**
 * 四路各自取多少条进融合：向量路 100、词面两路各 100、图路 50。
 *
 * 三个值是三个量，不是「同一个数的三份拷贝」：kVec 决定向量粗筛的宽度，kLex 决定
 * 词面两路（Entry 与正文）各自的名额，kGraph 决定图路一跳扩展的上限。取值随库规模
 * 变化，固定上限在库长大时会让召回质量悄悄退化 —— 改预算制属后续执行点（T45 批二），
 * 本次只把它们从内联字面量提成具名常量，取值未变。
 */
export const K_VEC = 100
export const K_LEX = 100
export const K_GRAPH = 50

/**
 * 图路拿向量路的前多少条做种子。
 *
 * 图路是「补多跳关联」，不是主召回，所以只从最像的那几条出发；种子多了会把
 * 一跳扩展的候选池灌满噪声。取值依据与 kGraph 属同一类（无实测记录）。
 */
export const DEFAULT_SEED_COUNT = 10

/**
 * 召回交给注入层的默认条数（调用方不传 topN 时用它）。
 *
 * 与写入侧的 DEFAULT_TOP_N 同为 24，但**不是同一个量**：那个是落位时取多少个 topic
 * 候选，这个是召回返回多少条。两者同值纯属巧合，合并会把「调落位候选数」变成
 * 「改注入条数」。运行时实际生效的默认值来自配置项 topN（见 tools/index.ts）。
 */
export const RECALL_TOP_N = 24

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
export const DUP_COS = 0.92
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
export const DUP_LEX = 0.72

function suppressDuplicates(
  db: DatabaseSync,
  items: RecallHit[],
  vectors: Map<number, Float32Array>,
): number {
  const byTopic = new Map<number, RecallHit[]>()
  for (const h of items) {
    if (h.topicId <= 0) continue
    const arr = byTopic.get(h.topicId) ?? []
    arr.push(h)
    byTopic.set(h.topicId, arr)
  }
  const lexOf = new Map<number, Set<string>>()
  for (const h of items) lexOf.set(h.id, bigramTerms(h.summary))
  const dropped = new Set<number>()
  for (const bucket of byTopic.values()) {
    if (bucket.length < 2) continue
    bucket.sort((a, b) => b.final - a.final)
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i]!
      if (dropped.has(a.id)) continue
      const va = vectors.get(a.id)
      if (va === undefined) continue
      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j]!
        if (dropped.has(b.id)) continue
        const vb = vectors.get(b.id)
        if (vb === undefined) continue
        if (cosine(va, vb) < DUP_COS) continue
        if (jaccard(lexOf.get(a.id)!, lexOf.get(b.id)!) < DUP_LEX) continue
        dropped.add(b.id) // final 更低的进「另有 N 条」
      }
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
      'SELECT id, topic_id, fit, summary, origin, superseded_by, flags FROM atom WHERE id IN (' + ph + ')',
    )
    .all(...ids) as Array<{
    id: number | bigint
    topic_id: number | bigint
    fit: number
    summary: string
    origin: string
    superseded_by: number | bigint | null
    flags: number | bigint | null
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

  const q = String(query ?? '').trim()
  const terms = bigramTerms(q)
  const shorts = shortCjk(terms)

  // 四路各自召回。向量路同时提供图路的种子。
  const vecHits = vecPath(db, queryVec, kVec, scope)
  const A = vecHits.map((h) => h.id)
  const E = entryPath(db, q, kLex, scope)
  const B = bodyPath(db, q, kLex, scope)
  // 图路的输入是推断边（src/graph/infer.ts）：库里还没有时先建一次。
  // 建完再读 origin 分布，所以这一次重建的结果也在报出的数里。
  // 声明边（origin = declared）不是本模块的产出，但它同样进图路（GRAPH_KINDS 有 related）——
  // 分开报，读者才知道「图路有值」是来自真相源还是派生物。
  const graphEdges = edgeOriginCounts(db)
  const graphStatus =
    ensureGraphOnce(db) + '（声明边 ' + graphEdges.declared + ' 条，推断边 ' + graphEdges.inferred + ' 条）'
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
    hits.push({
      id,
      score: acc.score,
      final: acc.score * aff,
      topicId: row.topicId,
      fit: row.fit,
      summary: row.summary,
      origin: row.origin,
      supersededBy: row.supersededBy,
      flags: row.flags,
      ranks: acc.ranks,
      affiliation: aff,
    })
  }
  hits.sort((a, b) => b.final - a.final)
  // 最高余弦：只统计有向量的命中（词面命中也在列表里，但它们不带余弦）。
  let topCosine = 0
  if (queryVec !== null) {
    for (const h of hits) {
      const v = vecMap.get(h.id)
      if (v === undefined) continue
      const c = cosine(queryVec, v)
      if (c > topCosine) topCosine = c
    }
  }
  const suppressed = suppressDuplicates(db, hits, vecMap)
  const kept = hits.slice(0, topN)

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
      topCosine,
      primaryHits,
      secondaryHits,
      // 只读一次 meta（一个键）。它不进任何打分，只决定锚行那句提示的措辞。
      splitConfirmed: readConfirmedSplits(db),
      elapsedMs: Date.now() - t0,
    },
  }
}

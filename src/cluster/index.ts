// 重聚类入口：把 A→D 四组串成一次可复跑的重算。
//
// 设计原则（与 write.ts 的单条写入路径刻意不同）：
//   · **这是全量重算，不是增量维护**。写入侧只做常数时间的聚合，任何 O(N) 以上的
//     活都推到这里 —— 所以它可以慢、但必须正确，而且必须能重跑。
//   · **读阶段与写阶段分离**。所有几何计算在写库之前完成，中间不读库（避免读到
//     自己写了一半的状态）。库只在两头被碰：开头读向量与旧 topic，结尾落库。
//   · **每一步都计量**。重聚类是宿主里最长的一次同步操作，分步耗时是唯一的
//     「下次该优化哪里」的依据；不给计量就只能靠猜。

import type { DatabaseSync } from 'node:sqlite'
import { decodeVec, isValidVecBlob, VEC_DIM } from '../util/vec.js'
import { buildKnnGraph, coreDistances, mutualReachabilityEdges, knnGraphStats } from './graph.js'
import type { KnnGraphStats } from './graph.js'
import { boruvkaMST } from './mst.js'
import { buildLinkageTree, computeStability, selectClusters, DEFAULT_MIN_CLUSTER_SIZE } from './hierarchy.js'
import { extractClusters, rankClustersByStability, clusterProbabilities } from './extract.js'
import { alignTopics, centroidsOf, DEFAULT_ALIGN_COS } from './align.js'
import type { Alignment } from './align.js'
import { DEFAULT_KNN_K } from './graph.js'
import {
  rebuildTopicTables,
  recomputeTopicSum,
  rebuildAtomPairs,
  loadOldTopicCentroids,
  remapSecondaryAttachments,
  countDanglingTopicRefs,
  RECLUSTER_BATCH_ATOMS,
  resolveOldToNewTopics,
} from './rebuild.js'
import type { TopicWrite, RebuildStats } from './rebuild.js'

/** 分步耗时（毫秒）。 */
export interface StepTiming {
  name: string
  ms: number
}

/** 重聚类的全部可调参数。默认值即设计报告给的参数。 */
export interface ReclusterOptions {
  /** k 近邻图的每点邻居数，同时也是 min_samples（核心距离取第几近邻）。 */
  k?: number
  /** 簇的规模门槛。 */
  minClusterSize?: number
  /** 身份对齐的余弦门槛。 */
  alignCos?: number
  /** atom_pair 的 cos 线，默认取 search.ts 的 DUP_COS。 */
  pairCosMin?: number
  /** atom_pair 的词面线，默认取 search.ts 的 DUP_LEX。 */
  pairLexMin?: number
  /** 分批回填的每批条数。 */
  batchAtoms?: number
  /** 只算不写（干跑），用于体量与耗时评估。 */
  dryRun?: boolean
  /** 进度回调（写库阶段按批调用）。宿主侧可据此让出事件循环。 */
  onProgress?: (stage: string, done: number, total: number) => void
}

/** 重聚类结果。 */
export interface ReclusterResult {
  /** 参与聚类的 atom 数（有合法向量的那些）。 */
  atoms: number
  /** 因向量维度不符被跳过的 atom 数。 */
  skipped: number
  /** 簇数（不含未归类）。 */
  clusters: number
  /** 未归类的 atom 数（label = -1）。 */
  noise: number
  noiseRatio: number
  /** 每簇规模，按簇号。 */
  sizes: number[]
  /** 每簇继承到的旧 topic id（null = 新分配）。 */
  inheritedIds: Array<number | null>
  /** 身份对齐的明细。 */
  alignment: Alignment
  /** 近邻图健康指标。 */
  graph: KnnGraphStats
  /** 分步耗时。 */
  timings: StepTiming[]
  /** 落库统计；干跑时为 null。 */
  rebuild: RebuildStats | null
  /** atom_pair 的写入统计；干跑时为 null。 */
  pairs: { rows: number; scanned: number; batches: number; cosHistogram: number[] } | null
  /** 未归类 atom 的 id（按 id 升序）。 */
  noiseIds: number[]
  /** 每个参与聚类的 atom 的标签（与 ids 同序）。 */
  label: Int32Array
  /** 参与聚类的 atom id（与 label 同序，按 id 升序）。 */
  ids: number[]
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * 从库里读出参与聚类的原子：(id, 向量)，按 id 升序。
 *
 * **维度不符的直接跳过**，不抛错：那是别的模型或早期版本写的向量（`loadVecCache`
 * 同样这么处理），硬算会得到一个看起来正常、实际无意义的相似度 —— 这正是「静默
 * 错簇」最隐蔽的一种来源，所以跳过量必须被回报出来。
 */
export function readClusterInputs(db: DatabaseSync): {
  ids: number[]
  vecs: Float32Array[]
  skipped: number
  texts: Map<number, string>
} {
  const rows = db.prepare('SELECT id, embedding, text FROM atom ORDER BY id').all() as Array<{
    id: number | bigint
    embedding: Uint8Array
    text: string
  }>
  const ids: number[] = []
  const vecs: Float32Array[] = []
  const texts = new Map<number, string>()
  let skipped = 0
  for (const r of rows) {
    const raw =
      r.embedding instanceof Uint8Array ? r.embedding : new Uint8Array(r.embedding as ArrayBufferLike)
    if (!isValidVecBlob(raw, VEC_DIM)) {
      skipped++
      continue
    }
    const id = Number(r.id)
    ids.push(id)
    vecs.push(decodeVec(raw))
    texts.set(id, r.text)
  }
  return { ids, vecs, skipped, texts }
}
/** 纯几何阶段的产出（不碰库）。 */
export interface ClusterPipelineResult {
  label: Int32Array
  clusters: number
  members: number[][]
  sizes: number[]
  /** 每簇的归一化质心（未归类点不参与）。 */
  centroids: Array<Float32Array | null>
  /** 每簇内各点的隶属度（与 members 一一对应）。 */
  probs: number[][]
  /** 每簇的稳定性（排序后）。 */
  stability: number[]
  graph: KnnGraphStats
  timings: StepTiming[]
}

/**
 * A→C 三段：建图 → boruvka 近似 MST → 层次树 → 稳定性 → 选簇 → 标签。
 *
 * **不碰库、不改入参**，因此可以被探针直接调用（T16 的 oracle 对照就是这么跑的）。
 * 把这一半独立出来的另一个理由：它是唯一「错了不会崩、只会静默给出合法结果」的一段，
 * 隔离之后它可以被单独喂合成数据、单独断言 —— 而混在写库逻辑里就没法单测。
 */
export function runClusterPipeline(
  vecs: readonly Float32Array[],
  opts: { k?: number; minClusterSize?: number } = {},
): ClusterPipelineResult {
  const k = opts.k ?? DEFAULT_KNN_K
  const minClusterSize = opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE
  if (minClusterSize < 2) throw new Error('min_cluster_size 必须 ≥ 2，收到 ' + minClusterSize)
  // 核心距离取第 k 近邻，所以 min_samples 就是 k；这个断言把「两者被测成了两个数」
  // 这件事挡在这里 —— 它们本来就是一个参数。
  if (k < 1) throw new Error('k 必须 ≥ 1，收到 ' + k)
  const timings: StepTiming[] = []
  const step = <T>(name: string, fn: () => T): T => {
    const t0 = nowMs()
    const r = fn()
    timings.push({ name, ms: Math.round((nowMs() - t0) * 100) / 100 })
    return r
  }

  const n = vecs.length
  if (n === 0) {
    return {
      label: new Int32Array(0),
      clusters: 0,
      members: [],
      sizes: [],
      centroids: [],
      probs: [],
      stability: [],
      graph: {
        n: 0,
        k,
        distP50: 0,
        distP90: 0,
        distMax: 0,
        nearestP50: 0,
        exactDupPairs: 0,
        negativeCosPairs: 0,
        mutualNearestRatio: 0,
      },
      timings,
    }
  }

  const g = step('knn', () => buildKnnGraph(vecs, k))
  const core = step('core', () => coreDistances(g, k))
  const edges = step('mrd', () => mutualReachabilityEdges(g, core))
  const mst = step('mst', () => boruvkaMST(g.n, edges))
  const tree = step('linkage', () => buildLinkageTree(mst, g.n, minClusterSize))
  const stability = step('stability', () => computeStability(tree))
  const sel = step('select', () => selectClusters(tree, stability))
  const raw = step('extract', () => extractClusters(tree, sel, g.n))
  // 按稳定性重编号：稳定性高的簇号靠前（目录视图里编号是可见顺序）。
  const assign = rankClustersByStability(tree, sel, stability, raw)
  const prob = step('probability', () => clusterProbabilities(tree, stability, sel, assign))

  const centroids = step('centroids', () => centroidsOf(vecs, assign.members, vecs[0]!.length))
  const probs = assign.members.map((m) => m.map((p) => prob[p]!))
  const stabilities = sel.selected
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const d = stability[b.t]! - stability[a.t]!
      return d !== 0 ? d : a.t - b.t
    })
    .map((x) => stability[x.t]!)

  return {
    label: assign.label,
    clusters: assign.count,
    members: assign.members,
    sizes: assign.sizes,
    centroids,
    probs,
    stability: stabilities,
    graph: step('stats', () => knnGraphStats(g)),
    timings,
  }
}
/**
 * 从库里的现有 atom 文本给一个簇起标签。
 *
 * 规则与写入侧建 topic 时一致（`summary.slice(0, 16)`）—— **刻意复用而不是另立规则**：
 * 同一个库里的 topic 标签不该有两套宽度，否则目录视图会一行宽一行窄。
 * 取簇内**稳定度最高**（隶属度最大）的那条 atom 的 summary：它是这个簇的「典型」。
 *
 * 入参 `members` 是**下标**（向量数组里的位置），不是 atom id —— 换 id 由调用方做，
 * 因为「下标 → id」这件事只在一个地方有依据（读入时的顺序）。
 */
function labelOfCluster(
  members: readonly number[],
  probs: readonly number[],
  summaries: ReadonlyMap<number, string>,
  ids: readonly number[],
): string {
  let best = -1
  let bestProb = -1
  for (let i = 0; i < members.length; i++) {
    const p = probs[i] ?? 0
    if (p > bestProb) {
      bestProb = p
      best = i
    }
  }
  const atomId = best >= 0 ? (ids[members[best]!] ?? -1) : -1
  const s = summaries.get(atomId) ?? ''
  return s.slice(0, 16) || '未命名'
}

/**
 * 把几何结果与身份对齐合成「待落库的 topic 列表」。
 *
 * **这里是「点下标 → atom id」的唯一换算点**，也是上一版静默出错的地方：
 * 几何阶段全程用下标（向量数组里的位置 0..n-1），而 `atom.id` 是另一套编号
 * （本插件从 1 起、且可能不连续 —— 删过的 id 不回收）。把下标当 id 写进
 * `atom_topic` 时，SQLite 只会在外键上失败（原子 0 不存在），而如果那个库里恰好
 * 有 id 等于某个下标的 atom，它会**静默**把归属写到错的记忆上。
 */
function buildTopicWrites(
  assignMembers: number[][],
  assignProbs: number[][],
  centroids: Array<Float32Array | null>,
  alignment: Alignment,
  summaries: ReadonlyMap<number, string>,
  fits: ReadonlyMap<number, number>,
  ids: readonly number[],
): TopicWrite[] {
  const out: TopicWrite[] = []
  for (let c = 0; c < assignMembers.length; c++) {
    const at = assignMembers[c]!
    const centroid = centroids[c]
    if (centroid === null) {
      // 质心为空只可能是「簇内所有向量维度都不对」，而那种点在读入阶段就被跳过了。
      // 走到这里说明不变量被破坏，明说比落一个零向量 topic 好。
      throw new Error('簇 ' + c + ' 没有可用质心，无法落库')
    }
    // 换算成 atom id。越界不静默跳过 —— 那会让簇的成员数比 sizes 少，且不报错。
    const members = at.map((p) => {
      const id = ids[p]
      if (id === undefined) throw new Error('簇 ' + c + ' 的成员下标越界：' + p)
      return id
    })
    let fitSum = 0
    for (const m of members) fitSum += fits.get(m) ?? 0
    out.push({
      cluster: c,
      inheritId: alignment.topicOfCluster.get(c) ?? null,
      label: labelOfCluster(at, assignProbs[c]!, summaries, ids),
      // sum_vec 存**未归一化**的和（与写入侧的增量累加口径一致）：
      // 质心是「和 / n」再归一化，而 sum_vec 这一列的名字与语义都是「和」。
      sumVec: scaledCentroid(centroid, members.length),
      nAtoms: members.length,
      meanFit: members.length === 0 ? 0 : fitSum / members.length,
      members,
      probs: assignProbs[c]!,
    })
  }
  return out
}

/** 质心（单位向量）乘回簇大小 —— 即「成员向量之和」的方向与长度。 */
function scaledCentroid(centroid: Float32Array, n: number): Float32Array {
  const out = new Float32Array(centroid.length)
  for (let i = 0; i < centroid.length; i++) out[i] = centroid[i]! * n
  return out
}

/**
 * 重聚类的完整流程：读 → 聚类 → 对齐 → 落库 → 重算导数。
 *
 * 调用方负责事务边界之外的「让出事件循环」：`onProgress` 会在每个写阶段之后被调用，
 * 异步宿主应当在回调里 `await` 一次微任务/宏任务，否则同步写库会把事件循环按住。
 */
export async function runRecluster(db: DatabaseSync, opts: ReclusterOptions = {}): Promise<ReclusterResult> {
  const timings: StepTiming[] = []
  const mark = <T>(name: string, fn: () => T): T => {
    const t0 = nowMs()
    const r = fn()
    timings.push({ name, ms: Math.round((nowMs() - t0) * 100) / 100 })
    return r
  }

  const input = mark('read', () => readClusterInputs(db))
  if (input.ids.length < 3) {
    throw new Error('参与聚类的 atom 少于 3 条（' + input.ids.length + '），重聚类无意义')
  }
  const cluster = mark('cluster', () =>
    runClusterPipeline(input.vecs, { k: opts.k, minClusterSize: opts.minClusterSize }),
  )

  // 旧 topic 的质心必须在**写库之前**读 —— 写库会先改成员归属，之后就取不到了。
  const oldTopics = mark('oldTopics', () => loadOldTopicCentroids(db))
  const summaries = mark('summaries', () => {
    const m = new Map<number, string>()
    const rows = db.prepare('SELECT id, summary FROM atom').all() as Array<{
      id: number | bigint
      summary: string
    }>
    for (const r of rows) m.set(Number(r.id), r.summary)
    return m
  })
  const fits = mark('fits', () => {
    const m = new Map<number, number>()
    const rows = db.prepare('SELECT id, fit FROM atom').all() as Array<{ id: number | bigint; fit: number }>
    for (const r of rows) m.set(Number(r.id), r.fit)
    return m
  })

  const alignCos = opts.alignCos ?? DEFAULT_ALIGN_COS
  const alignment = mark('align', () =>
    alignTopics(
      cluster.centroids.map((c, i) => ({ index: i, centroid: c, size: cluster.sizes[i]! })),
      oldTopics,
      alignCos,
    ),
  )

  const noiseIds: number[] = []
  for (let i = 0; i < cluster.label.length; i++) {
    if (cluster.label[i] === -1) noiseIds.push(input.ids[i]!)
  }

  const base = {
    atoms: input.ids.length,
    skipped: input.skipped,
    clusters: cluster.clusters,
    noise: noiseIds.length,
    noiseRatio: input.ids.length === 0 ? 0 : noiseIds.length / input.ids.length,
    sizes: cluster.sizes,
    inheritedIds: cluster.members.map((_, c) => alignment.topicOfCluster.get(c) ?? null),
    alignment,
    graph: cluster.graph,
    timings,
    label: cluster.label,
    ids: input.ids,
    noiseIds,
  }

  if (opts.dryRun === true) {
    return { ...base, rebuild: null, pairs: null }
  }

  const writes = buildTopicWrites(
    cluster.members,
    cluster.probs,
    cluster.centroids,
    alignment,
    summaries,
    fits,
    input.ids,
  )
  const rebuild = mark('rebuild', () => rebuildTopicTables(db, writes, { batchAtoms: opts.batchAtoms }))
  opts.onProgress?.('rebuild', writes.length, writes.length)

  // 次属引用与边都跟着身份对齐走。**映射从库里的实际状态反推**，而不是只用 alignment
  // 里那份：新分配的 topic id 是 INSERT 出来的自增号，只有写库那一步知道，
  // 而此刻它已经落在 atom.topic_id 上了 —— 那才是可以依赖的真相源。
  const oldToNewTopic = mark('oldToNew', () => resolveOldToNewTopics(db, input.ids))
  mark('secondary', () => remapSecondaryAttachments(db, oldToNewTopic))
  const recomputed = mark('recomputeSum', () => recomputeTopicSum(db))
  void recomputed

  const vecMap = new Map<number, Float32Array>()
  for (let i = 0; i < input.ids.length; i++) vecMap.set(input.ids[i]!, input.vecs[i]!)
  const pairs = mark('atomPairs', () =>
    rebuildAtomPairs(db, vecMap, {
      cosMin: opts.pairCosMin,
      lexMin: opts.pairLexMin,
      texts: input.texts,
      batchPairs: opts.batchAtoms,
    }),
  )
  opts.onProgress?.('atomPairs', pairs.rows, pairs.rows)

  const dangling = countDanglingTopicRefs(db)
  const finalRebuild: RebuildStats = { ...rebuild, danglingRefs: dangling }
  return { ...base, rebuild: finalRebuild, pairs }
}

/** 默认参数（探针与文档引用同一份）。 */
export const RECLUSTER_DEFAULTS = {
  k: DEFAULT_KNN_K,
  minClusterSize: DEFAULT_MIN_CLUSTER_SIZE,
  alignCos: DEFAULT_ALIGN_COS,
  batchAtoms: RECLUSTER_BATCH_ATOMS,
} as const

export { RECLUSTER_BATCH_ATOMS }

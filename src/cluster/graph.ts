// 重聚类 A 组：k 近邻图与互可达距离。
//
// **距离尺度只有一种：`d = 1 - cos`**（向量已 L2 归一化，点积即余弦）。
//
// 为什么必须统一到这里、以及为什么这件事值得写一段注释：HDBSCAN 的稳定性用
// `λ = 1 / 边权`，而 `1 - cos` 与 `√(2 - 2cos)` 之间是**非线性**变换 ——
// 边权的**序**不变，但 `λ` 的**差**会变，于是「父簇的稳定性和 vs 子簇之和」
// 这个比较可能翻向。也就是说换尺度不是等比缩放，而是换一种划分。
// 所以全链路只允许出现 `1 - cos`；探针里另行测过 `√(2 - 2cos)` 看差多少。
//
// 为什么在 k 近邻图上算，而不是全对：全对是 O(N²) 内存（本项目 1e3 档就要
// 上百 MB、5k 档到 GB），而 boruvka 只需要每个点的一条最小出边。
// 代价是 MST 只是近似的（k 近邻图可能漏掉真正的最近边），见 `knnGraphStats` 的用途。

import { dot } from '../util/vec.js'

/**
 * 每点保留的最近邻个数 k 的默认值。
 *
 * 取 2 有两个理由，**都不是「随便挑的」**：
 *   1. 设计报告给的 `min_samples = 2`，而 min_samples 的语义就是「核心距离取第几近邻」，
 *      即 `k`。两者是同一个参数，代码里也只留一个。
 *   2. 本机在基准库（1 374 条真实向量）上扫过 k ∈ {2,3,4,6,8,16}，只有 k=2 能把
 *      簇数 / 噪声比例落在参照实现（clusternova，`mpts=2`）的同一区间；
 *      k≥6 时划分塌缩到个位数簇。
 *
 * **k 变大不是「更稳」，而是「更糊」**：k 近邻图变密 → 互可达距离的核心距离项变大
 * → 小簇被抹平。这条与「k 越大近似 MST 越准」方向相反，是本项最反直觉的一处。
 */
export const DEFAULT_KNN_K = 2

/** 每点第 k 近邻距离 = 核心距离时，k 至少是 1（取最近的那个邻居）。 */
const MIN_K = 1

/**
 * k 近邻图。**扁平 CSR 式布局**：第 i 点的第 t 个邻居在 `i * k + t`。
 *
 * 邻居按距离升序（`dist[i*k] <= dist[i*k+1] <= ...`），这样
 * `coreDistances` 直接取第 k 个、不用再排一次。
 *
 * 入参 `vecs` 是**已归一化**的向量；未归一化时本函数仍然返回数值，
 * 但那个数值不是余弦距离 —— 调用方负责归一化（`util/vec.ts` 的 `normalized`）。
 */
export interface KnnGraph {
  /** 点数。 */
  n: number
  /** 每点的邻居数。 */
  k: number
  /** 邻居下标，长度 n*k。 */
  idx: Int32Array
  /** 邻居距离（`1 - cos`），长度 n*k，升序。 */
  dist: Float32Array
}

/**
 * 建 k 近邻图。
 *
 * 维护一个长度 k 的**有序插入缓冲**而不是先全算再排序：全算再排是 O(n log n) 一次
 * 加 O(n) 内存，而这里只需要 O(k) 内存、且 n 大时省掉一次全排序。
 * k 很小（2）时插入位移几乎不发生，是这个形状最划算的地方。
 */
export function buildKnnGraph(vecs: readonly Float32Array[], k: number): KnnGraph {
  const n = vecs.length
  if (!Number.isInteger(k) || k < MIN_K) throw new Error('k 必须是 ≥ ' + MIN_K + ' 的整数，收到 ' + k)
  if (n === 0) throw new Error('向量为空，无法建近邻图')
  if (k >= n) throw new Error('k 必须小于点数：k=' + k + '，点数=' + n)

  const idx = new Int32Array(n * k)
  const dist = new Float32Array(n * k)
  // 复用缓冲，避免每点各分配一次（n 次 GC 压力在 1e3 档已可测）。
  const bi = new Int32Array(k)
  const bd = new Float32Array(k)

  for (let i = 0; i < n; i++) {
    const a = vecs[i]!
    let m = 0
    let worst = Infinity
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const d = 1 - dot(a, vecs[j]!)
      if (m < k) {
        // 缓冲未满：插入排序放进去。
        let p = m++
        while (p > 0 && bd[p - 1]! > d) {
          bd[p] = bd[p - 1]!
          bi[p] = bi[p - 1]!
          p--
        }
        bd[p] = d
        bi[p] = j
        if (m === k) worst = bd[k - 1]!
      } else if (d < worst) {
        // 缓冲已满且更近：挤掉最后一个。
        let p = k - 1
        while (p > 0 && bd[p - 1]! > d) {
          bd[p] = bd[p - 1]!
          bi[p] = bi[p - 1]!
          p--
        }
        bd[p] = d
        bi[p] = j
        worst = bd[k - 1]!
      }
    }
    idx.set(bi.subarray(0, k), i * k)
    dist.set(bd.subarray(0, k), i * k)
  }
  return { n, k, idx, dist }
}

/**
 * 核心距离：每点到第 k 近邻的距离。
 *
 * `k` 参数是 `min_samples`，与建图时的 k 是同一个数。之所以还要传一次而不从图里读，
 * 是为了让「用第几个邻居当核心距离」在调用点可见 —— 它决定链式效应被压制的强度，
 * 是这套算法里第二个带语义的参数（第一个是 min_cluster_size）。
 */
export function coreDistances(g: KnnGraph, k: number): Float32Array {
  if (k < MIN_K || k > g.k) {
    throw new Error('核心距离的 k 必须落在 [1, 图的 k] 内：k=' + k + '，图的 k=' + g.k)
  }
  const core = new Float32Array(g.n)
  for (let i = 0; i < g.n; i++) core[i] = g.dist[i * g.k + (k - 1)]!
  return core
}

/**
 * 互可达距离图上的边：`mrd(a,b) = max(core(a), core(b), d(a,b))`。
 *
 * 这一步是整套算法**抗链式效应**的所在（调研 §3.1 第 2 步）：光有「距离小于阈值就合并」
 * 会把整库连成一团，而把每个点自己所在区域的密度（核心距离）抬进边权之后，
 * 稀疏处的边权被抬到该处的密度水平，跨簇的「桥」自动变贵。
 *
 * 去重按 `(min(a,b), max(a,b))`：两个点互相是对方的近邻时会出现两条反向边，
 * 不过滤会让 MST 的边数虚高、并让「每轮每个分量选最小出边」重复比较同一对点。
 * 返回**扁平三数组**而不是对象数组：边数在 1e3 档是 1e3~1e4，对象数组的分配与
 * 后续排序都明显更贵，而 boruvka 只按下标顺序扫一遍。
 */
export interface EdgeList {
  a: Int32Array
  b: Int32Array
  w: Float32Array
}

export function mutualReachabilityEdges(g: KnnGraph, core: Float32Array): EdgeList {
  const n = g.n
  const k = g.k
  // key = lo * n + hi。用 Map 而不是 n×n 的邻接矩阵：矩阵在 1e3 档是 1.9M 项、
  // 5k 档是 25M 项，而实际边数只有 n*k 这个量级。
  const w = new Map<number, number>()
  for (let a = 0; a < n; a++) {
    for (let t = 0; t < k; t++) {
      const b = g.idx[a * k + t]!
      const lo = a < b ? a : b
      const hi = a < b ? b : a
      const key = lo * n + hi
      if (w.has(key)) continue
      let m = g.dist[a * k + t]!
      if (core[a]! > m) m = core[a]!
      if (core[b]! > m) m = core[b]!
      w.set(key, m)
    }
  }
  const m = w.size
  const ea = new Int32Array(m)
  const eb = new Int32Array(m)
  const ew = new Float32Array(m)
  let p = 0
  for (const [key, val] of w) {
    ea[p] = Math.floor(key / n)
    eb[p] = key % n
    ew[p] = val
    p++
  }
  return { a: ea, b: eb, w: ew }
}

/** 近邻图的健康指标。 */
export interface KnnGraphStats {
  n: number
  k: number
  /** k 近邻距离的中位数。密度的一个粗尺度。 */
  distP50: number
  distP90: number
  distMax: number
  /** 各点最近邻距离的中位数 —— 与 distP50 一起看，能看出「近邻是不是都同样远」。 */
  nearestP50: number
  /** 距离为 0 的邻居对条数（重复向量）。为 0 说明数据里没有完全重复的条目。 */
  exactDupPairs: number
  /**
   * **显著**负距离（小于 -1e-4）的邻居对条数。接近 n*k 说明尺度用错了（没归一化）。
   *
   * 为什么要给容差：向量是 float32，而 `dot(v, v)` 在 float32 上会因舍入略大于 1
   * （实测约 +5.8e-8），于是 `1 - dot` 会是一个绝对值极小的负数。那**不是**负余弦，
   * 是浮点噪声 —— 不带容差地数 `d < 0` 会把自洽的正常数据报成「尺度用错」。
   * 而尺度真错时（例如没归一化，两个向量夹角 120 度）距离是 -0.5 这个量级，
   * 与 1e-7 相差六个数量级，容差不会掩盖它。
   */
  negativeCosPairs: number
  /** 最近邻是双向的点的比例。单向最近邻多说明近邻图不对称、k 可能偏小。 */
  mutualNearestRatio: number
}

/**
 * 出近邻图的统计量。
 *
 * 这个函数的存在理由是**防静默错簇**：本项错了不会崩，只会给出「全噪声」或
 * 「一个巨大簇」这种合法形状。把这几个量在跑之前打出来，就能在跑完之后判断
 * 「结果可疑」到底是数据如此还是代码坏了 —— 例如 `negativeCosPairs` 接近 n*k
 * 就意味着向量没归一化（点积不是余弦），而那种情况下整条链路都会算错却不报错。
 */
export function knnGraphStats(g: KnnGraph): KnnGraphStats {
  const { n, k } = g
  const all = new Float32Array(n * k)
  all.set(g.dist)
  const sorted = Array.prototype.slice.call(all).sort((a, b) => a - b) as number[]
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!

  const nearest = new Float32Array(n)
  let exact = 0
  let negative = 0
  for (let i = 0; i < n; i++) {
    nearest[i] = g.dist[i * k]!
    for (let t = 0; t < k; t++) {
      const d = g.dist[i * k + t]!
      if (d === 0) exact++
      // 容差见 negativeCosPairs 的注释：1e-7 量级是 float32 噪声，不是尺度错。
      if (d < -1e-4) negative++
    }
  }
  const nearSorted = Array.prototype.slice.call(nearest).sort((a, b) => a - b) as number[]
  const nq = (p: number): number =>
    nearSorted[Math.min(nearSorted.length - 1, Math.floor(p * nearSorted.length))]!

  // 「互为最近邻」：i 的最近邻 j 是否也把 i 当最近邻。
  let mutual = 0
  for (let i = 0; i < n; i++) {
    const j = g.idx[i * k]!
    if (g.idx[j * k] === i) mutual++
  }

  return {
    n,
    k,
    distP50: q(0.5),
    distP90: q(0.9),
    distMax: sorted[sorted.length - 1]!,
    nearestP50: nq(0.5),
    exactDupPairs: Math.floor(exact / 2),
    negativeCosPairs: negative,
    mutualNearestRatio: n === 0 ? 0 : mutual / n,
  }
}

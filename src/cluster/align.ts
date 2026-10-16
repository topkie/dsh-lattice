// 重聚类 D 组（一）：身份对齐。
//
// 时序文档 4.3 把这一步写成**不变量**，理由只有一句但足够硬：
// 「缺了它，所有 declared 关联会在重算后指向不存在的 topic」。
//
// 这句话要展开才看得出手上有什么要保：
//   · `atom_topic`（主属 + 次属归属）
//   · `edge` 里 `src_type=atom, dst_type=topic, kind=near` 的关联边
//   · `atom.topic_id` 这个主属外键
// 三处都是「指向 topic 的引用」。重聚类会重建 topic 表；若直接删旧建新，
// 三处引用全指向已不存在的 id。外键上声明了 ON DELETE，所以不会报错 ——
// 它会**静默**把引用置空或整行删掉。这就是「不变量」三个字的分量。
//
// 对齐的做法是给旧 topic 与新簇之间找一个**几何上说得通**的对应，让被保留的
// 旧 id 继续承载同一个主题；找不到对应的旧 topic 才是真的解散，对应的引用也才
// 真的该断。

import { cosine } from '../util/vec.js'

/**
 * 身份对齐的余弦门槛默认值（时序文档 4.3 给的 `cos >= 0.80`）。
 *
 * 0.80 与落位的 `tauJoin = 0.78` 是**两件事**，不要合并：落位问的是「这条新记忆
 * 该不该并进这个主题」（误并是静默的知识损坏）；对齐问的是「这个新簇是不是原来那个
 * 主题」（配错会让旧 id 挂到一个语义不同的簇上，代价同样是静默的）。
 * 但两者共用一个尺度，所以数值接近不是巧合。
 */
export const DEFAULT_ALIGN_COS = 0.8

/** 一个旧 topic 的质心（或它没有可用质心）。 */
export interface OldTopicCentroid {
  id: number
  /** 归一化质心；`n_atoms = 0` 或 sum_vec 维度不符时为 null。 */
  centroid: Float32Array | null
  nAtoms: number
}

/** 一个新簇的质心。 */
export interface NewClusterCentroid {
  /** 簇号（`ClusterAssignment` 里的下标）。 */
  index: number
  centroid: Float32Array | null
  size: number
}

/** 一条配对：新簇 `cluster` 继承旧 topic `topicId`。 */
export interface Alignment {
  pairs: Array<{ cluster: number; topicId: number; cos: number }>
  /** 没有配到新簇、因而不再有成员的旧 topic。 */
  dissolved: number[]
  /** 没有配到旧 topic、因而需要新分配 id 的簇。 */
  fresh: number[]
  /** 新簇 → 旧 topic id（供落库用）；未配对的簇不在表里。 */
  topicOfCluster: Map<number, number>
  /** 旧 topic id → 新簇号；未配对的不在表里。 */
  clusterOfTopic: Map<number, number>
}

/**
 * 贪心配对：按相似度从高到低取，一个旧 topic 只能被一个簇继承。
 *
 * **贪心不是最优解**，这是有意的取舍：最优解是二分图匹配（匈牙利算法），
 * 但它的复杂度与实现量都不合这个用途 —— 对齐配错的后果是「旧 id 挂到语义相近的
 * 另一个簇上」，而**能进入候选的配对都已经过了 0.80 这条线**，两个候选之间的差别
 * 远小于「配错 vs 不配」的差别。真正要防的是「配到 0.3 相似度的簇上」，
 * 门槛已经防住了。
 *
 * 三条边界：
 *   · 没有质心的旧 topic（零 sum_vec，编码器降级期建的）**不参与配对**，直接进
 *     `dissolved`。给它配一个随机簇比让它解散更糟：它的成员本来就是降级期写的，
 *     没有几何依据说它属于谁。
 *   · 没有质心的新簇同理进 `fresh`（理论上不该出现，簇的质心由成员向量算得）。
 *   · 旧 topic 数可能远大于新簇数（历史上一个 atom 一个 topic 的库就是这样），
 *     所以 `dissolved` 通常远长于 `pairs` —— 这是正常的，不是丢数据。
 */
export function alignTopics(
  clusters: readonly NewClusterCentroid[],
  oldTopics: readonly OldTopicCentroid[],
  threshold: number = DEFAULT_ALIGN_COS,
): Alignment {
  const candidates: Array<{ cluster: number; topicId: number; cos: number }> = []
  for (const c of clusters) {
    if (c.centroid === null) continue
    for (const t of oldTopics) {
      if (t.centroid === null) continue
      if (c.centroid.length !== t.centroid.length) continue
      const cs = cosine(c.centroid, t.centroid)
      // NaN 守卫：cosine 对零向量返回 0，但维度不符或非有限值会漏过来。
      // 不加这个守卫，NaN 会让下面所有 `>= threshold` 静默为假 —— 结果看起来
      // 像「一个都没配上」，而不是报错。
      if (!Number.isFinite(cs)) continue
      if (cs >= threshold) candidates.push({ cluster: c.index, topicId: t.id, cos: cs })
    }
  }
  // 相似度降序；同分时按 (簇号, topic id) 定序 —— 否则结果依赖数组的遍历顺序，
  // 换个库（行序不同）就会得到另一套配对，而那会让「同一份输入重跑结果一致」失效。
  candidates.sort((a, b) => {
    const d = b.cos - a.cos
    if (d !== 0) return d
    if (a.cluster !== b.cluster) return a.cluster - b.cluster
    return a.topicId - b.topicId
  })

  const usedCluster = new Set<number>()
  const usedTopic = new Set<number>()
  const pairs: Alignment['pairs'] = []
  for (const c of candidates) {
    if (usedCluster.has(c.cluster) || usedTopic.has(c.topicId)) continue
    usedCluster.add(c.cluster)
    usedTopic.add(c.topicId)
    pairs.push(c)
  }

  const topicOfCluster = new Map<number, number>()
  const clusterOfTopic = new Map<number, number>()
  for (const p of pairs) {
    topicOfCluster.set(p.cluster, p.topicId)
    clusterOfTopic.set(p.topicId, p.cluster)
  }
  const fresh: number[] = []
  for (const c of clusters) if (!usedCluster.has(c.index)) fresh.push(c.index)
  const dissolved: number[] = []
  for (const t of oldTopics) if (!usedTopic.has(t.id)) dissolved.push(t.id)
  return { pairs, dissolved, fresh, topicOfCluster, clusterOfTopic }
}

/**
 * 把一批向量按「分组」求质心（L2 归一化）。
 *
 * 为什么现算而不读 `topic.sum_vec`：旧 topic 的 sum_vec 是增量累加出来的，
 * 而这次要比较的是**新簇**与**旧 topic**，新簇没有 sum_vec 可读 —— 两边用同一套
 * 算法（成员向量求和再归一化）才算同一个尺度。旧 topic 那侧读 sum_vec 也是对的
 * （它逐位等于成员和），但增量累加与全量重算之间的浮点差会让两边差一点点；
 * 现算绕开这个不确定性。
 */
export function centroidsOf(
  vecs: readonly Float32Array[],
  groups: ReadonlyArray<readonly number[]>,
  dim: number,
): Array<Float32Array | null> {
  return groups.map((g) => {
    if (g.length === 0) return null
    const sum = new Float64Array(dim)
    let used = 0
    for (const p of g) {
      const v = vecs[p]
      if (v === undefined || v.length !== dim) continue
      for (let i = 0; i < dim; i++) sum[i]! += v[i]!
      used++
    }
    if (used === 0) return null
    let norm = 0
    for (let i = 0; i < dim; i++) norm += sum[i]! * sum[i]!
    norm = Math.sqrt(norm)
    if (norm === 0) return null
    const out = new Float32Array(dim)
    for (let i = 0; i < dim; i++) out[i] = sum[i]! / norm
    return out
  })
}

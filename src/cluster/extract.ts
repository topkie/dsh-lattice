// 重聚类 C 组：簇提取、标签、隶属度。
//
// 这一步的产出就是设计报告说的「未归类域」：**没有落进任何选中簇的点标 -1**。
// 少了这个语义，重聚类会把噪声也塞进某个簇，而噪声点正是「还看不出属于哪个主题」
// 的那些记忆 —— 把它们硬塞进某个主题比留空更糟（召回时会以错误的主属身份参与打分）。

import type { LinkageTree, Selection } from './hierarchy.js'

/** -1 = 未归类（噪声）。 */
export const NOISE_LABEL = -1

/** 提取结果。 */
export interface ClusterAssignment {
  /** 每个点的簇号（0..count-1），未归类为 -1。 */
  label: Int32Array
  /** 簇数（不含噪声）。 */
  count: number
  /** 每簇的成员点下标，与簇号一一对应。 */
  members: number[][]
  /** 每簇的质心下标记：成员点下标之和的均值由调用方按向量算，这里只给成员。 */
  sizes: number[]
}

/**
 * 把「选中的层次树节点」摊平成「每个点属于哪个簇」。
 *
 * 簇号按层次树下标升序编号 —— 即「先诞生的簇号小」。这一点被身份对齐依赖：
 * 编号本身不含语义，但**稳定性**排序之后才有意义（见 `rankClustersByStability`）。
 *
 * 一个点理论上只属于一个选中簇（选中集是层次树的**反链**），但这不是靠断言保证的：
 * 若选择阶段出错（例如父簇与子簇同时被选中），后面的簇会覆盖前面的标签 ——
 * 于是 `members` 里会出现重复成员、`count` 也不等于互斥簇数。
 * `extractClusters` 因此**显式检查互斥性**，而不是假设它成立。
 */
export function extractClusters(tree: LinkageTree, sel: Selection, n: number): ClusterAssignment {
  const label = new Int32Array(n).fill(NOISE_LABEL)
  const members: number[][] = sel.selected.map(() => [])
  for (let c = 0; c < sel.selected.length; c++) {
    const els = tree.elements[sel.selected[c]!]!
    let taken = 0
    for (let i = 0; i < els.length; i++) {
      const p = els[i]!
      // 成员下标必须落在 [0, n)。越界在 JS 里不会抛错：读 label[p] 得 undefined、
      // 写 label[p] 只是往数组上挂一个属性，而 members 里会留下一个 **undefined 或
      // 非法 id**，一路带到落库那一步才以 FOREIGN KEY 失败的形式暴露出来。
      if (!Number.isInteger(p) || p < 0 || p >= n) {
        throw new Error('层次树的成员下标越界：' + p + '（n = ' + n + '）')
      }
      if (label[p] !== NOISE_LABEL) continue
      label[p] = c
      members[c]!.push(p)
      taken++
    }
    if (taken !== els.length) {
      throw new Error(
        '选中簇之间不互斥：第 ' + c + ' 个簇有 ' + (els.length - taken) + ' 个成员已被别的簇占用',
      )
    }
  }
  // 成员表按点下标升序，便于比对与落库（顺序本身不影响正确性）。
  for (const m of members) m.sort((a, b) => a - b)
  return {
    label,
    count: members.length,
    members,
    sizes: members.map((m) => m.length),
  }
}

/**
 * 按稳定性给簇排序并重编号。**可选**，但重聚类落库时应当用：稳定性高的簇
 * 更可能是真实存在的主题，编号自然应该靠前（编号在目录视图里是可见顺序）。
 *
 * 为什么不在 `extractClusters` 里顺手做：提取与排序是两件事，混在一起会让
 * 「簇号含义」变得含糊 —— 提取阶段簇号 = 层次树下标，排序之后簇号 = 稳定性名次。
 * 分开之后，两个语义各自有明确的名字。
 */
export function rankClustersByStability(
  tree: LinkageTree,
  sel: Selection,
  stability: Float64Array,
  assign: ClusterAssignment,
): ClusterAssignment {
  const order = sel.selected.map((t, i) => ({ t, i }))
  order.sort((a, b) => {
    const d = stability[b.t]! - stability[a.t]!
    return d !== 0 ? d : a.t - b.t
  })
  const label = new Int32Array(assign.label.length).fill(NOISE_LABEL)
  const members: number[][] = []
  for (let rank = 0; rank < order.length; rank++) {
    const old = order[rank]!.i
    members.push(assign.members[old]!)
    for (const p of assign.members[old]!) label[p] = rank
  }
  return { label, count: members.length, members, sizes: members.map((m) => m.length) }
}

/**
 * 每点隶属度：`(λ_p − λ_birth) / λ_p`，落在 [0, 1]。
 *
 * 语义是「这个点相对于它所属簇的诞生密度，有多深地埋在里面」。设计报告没有要求它，
 * 但落位判定（§20）需要「这条记忆对该主题有多典型」—— 中心余弦只回答「像不像」，
 * 隶属度回答「是不是这个簇的**核心**」。两者是不同的问题，用同一个数会混。
 *
 * 未归类的点记 0（不是 NaN）：0 与「深度为 0」在数值上不可区分，但一个可比较的
 * 0 比 NaN 安全 —— NaN 参与的任何比较都是 false，会静默地把分支走错。
 */
export function clusterProbabilities(
  tree: LinkageTree,
  stability: Float64Array,
  sel: Selection,
  assign: ClusterAssignment,
): Float32Array {
  const n = assign.label.length
  const out = new Float32Array(n)
  void stability
  for (let c = 0; c < sel.selected.length; c++) {
    const t = sel.selected[c]!
    const ps = tree.lambdaPs[t]!
    const birth = tree.kids[t] === null ? 0 : tree.lambdaBirth[t]!
    const els = tree.elements[t]!
    // lambdaPs 与 elements 一一对应（同一趟里一起维护的）。
    for (let j = 0; j < els.length; j++) {
      const p = els[j]!
      const lam = ps[j]!
      if (lam <= 0 || !Number.isFinite(lam)) {
        out[p] = 1
        continue
      }
      const prob = (lam - birth) / lam
      out[p] = prob < 0 ? 0 : prob > 1 ? 1 : prob
    }
  }
  return out
}

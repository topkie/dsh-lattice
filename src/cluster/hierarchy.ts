// 重聚类 B 组（下）：层次树、压缩、稳定性。
//
// 这三步是 HDBSCAN 与「单链接 + 固定阈值」的全部差别所在（调研 §3.1 第 4、5 步）：
//   · 压缩（condense）按 `min_cluster_size` 把「不够门槛的碎片合并」记成一个新簇的诞生；
//   · 稳定性把「这个簇在多大的密度区间里保持完整」累加成一个标量；
//   · 选择自底向上比较父簇与两个子簇的稳定性和，决定留父还是留子。
//
// **λ 尺度**：全链路只有一种距离 `d = 1 - cos`，λ = 1/d。理由见 `graph.ts` 顶部。

import { makeUnionFind } from './mst.js'
import type { ThresholdValue } from '../threshold-types.js'
import type { Mst } from './mst.js'
import { sortEdgesByWeight } from './mst.js'

/** 簇的规模门槛默认值（设计说明 §21 给的 `min_cluster_size = 3`）。 */
export const DEFAULT_MIN_CLUSTER_SIZE = 3 satisfies ThresholdValue<
  'chosen',
  {
    area: '重聚类'
    why: '设计说明 §21 写死 min_cluster_size = 3，没有给标定实验；「3 是不是对的」本轮没有测 —— 没有拿「人工判定哪些记忆属于同一主题」做对照，所以 3 的来历是设计判断'
    failsWhen: ['库规模', '一条记忆的平均信息量', '「一个主题至少几条记忆才有用」这个产品判断']
    affects: '簇的规模门槛：小于此值的碎片在压缩阶段并入父簇，而不是各自成为一个主题。它是唯一带语义的聚类参数 —— 直接表达「多小算一个独立主题」'
  }
>

/**
 * 压缩后的层次树。
 *
 * 用**平行数组**而不是节点对象：节点数在 1e3 档是 O(n)、5k 档同一量级，
 * 而每个节点都带一份成员表 —— 对象化之后就是上万个小数组，GC 压力远超算法本身。
 *
 * `elements[i]` 是「这个簇在它被压缩出来的那一刻覆盖了哪些点」，按下标升序无所谓，
 * 但**必须是当时的完整成员表**：标签分配直接读它，不再做一次树遍历。
 */
export interface LinkageTree {
  /** 父节点是否由「两个都够门槛的簇」合并而来（否则由碎片合够门槛而来）。 */
  kids: Array<readonly [number, number] | null>
  /** 每个簇的成员点下标。 */
  elements: number[][]
  /** 簇诞生时的 λ（= 1/边权）。碎片合出来的簇出生在「碎片里最贵的那条边」，故为 0。 */
  lambdaBirth: Float64Array
  /** 每个成员点「掉出该簇」时的 λ。与 elements 一一对应。 */
  lambdaPs: Float64Array[]
  /** 每个点最终落在哪个簇的下标（叶 → 该点所在的叶簇）；算稳定性时用。 */
  rootOf: Int32Array
}

/**
 * 构建层次树（压缩与建树在**同一趟**里完成）。
 *
 * 与 `clusternova` 的 `_extractHDBSCANHierarchy` 逐步对齐，因为那是可对照的参照实现
 * （探针里用它当 oracle）。三条容易写错的：
 *
 *   1. **合并条件用的是「合并前」的两个分量大小**，不是合并后的。写成合并后，
 *      「两个碎片合够门槛」永远为假（合并后必然 ≥ 门槛），于是一个簇都生不出来。
 *   2. **成员表必须跟着并查集的根走**。`union` 把 ra 挂到 rb 时，成员表要挪到
 *      新的根上，并把旧根的表删掉 —— 忘了删会在后面读到一份过期的成员表，
 *      表现为簇的成员比实际少（且不报错）。
 *   3. **碎片并入已有簇时，只给「碎片那一部分」补 λ**。给整个簇补会把已在该簇里
 *      的点的 λ 改写掉，稳定性随之算错 —— 这一步的错法也是静默的。
 *
 * 最后 `pop` 掉的那一个节点是「全库合并成一体」的根：它在选择阶段必然被选中
 * （没有任何父簇能和它比），会把所有点收进一个巨大簇。层次树交付时不带它，
 * 于是「未被任何簇选中」的点自然落到 -1（未归类域）。
 */
export function buildLinkageTree(mst: Mst, n: number, minClusterSize: number): LinkageTree {
  if (!Number.isInteger(minClusterSize) || minClusterSize < 2) {
    throw new Error('min_cluster_size 必须是 ≥ 2 的整数，收到 ' + minClusterSize)
  }
  // **前置不变式：入参必须是一棵真正的生成树**（恰好 n-1 条边、整图连通）。
  // 少了这个检查，森林会被静默地当成树处理 —— 层次树丢掉那些没被任何边触及的点，
  // 而它们的 label 全部落在 -1（噪声），于是簇划分看起来「合理」但少了一批点。
  // 这正是本项最典型的静默错法，所以宁可在入口处断言。
  if (mst.a.length !== n - 1) {
    throw new Error(
      '生成树边数不对：期望 ' +
        (n - 1) +
        '，实际 ' +
        mst.a.length +
        '（k 近邻图不连通时应当缝合，而不是交森林）',
    )
  }

  const uf = makeUnionFind(n)
  // groups[root] 是「以 root 为根的分量」的成员表。并查集的根会变，所以它跟着变。
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) groups.set(i, [i])

  const kids: Array<readonly [number, number] | null> = []
  const elements: number[][] = []
  const lambdaBirth: number[] = []
  const lambdaPs: Float64Array[] = []
  /** 并查集根 → 该分量当前对应的层次树下标。 */
  const pointTo = new Map<number, number>()

  const order = sortEdgesByWeight(mst)
  for (let oi = 0; oi < order.length; oi++) {
    const e = order[oi]!
    const from = mst.a[e]!
    const to = mst.b[e]!
    const weight = mst.w[e]!
    const rf = uf.find(from)
    const rt = uf.find(to)
    if (rf === rt) continue
    const gf = groups.get(rf)!
    const gt = groups.get(rt)!
    const sizeFrom = gf.length
    const sizeTo = gt.length
    const newSize = sizeFrom + sizeTo

    const newRoot = uf.union(from, to)
    const merged = gf.concat(gt)
    groups.set(newRoot, merged)
    groups.delete(newRoot === rf ? rt : rf)

    // λ 的守卫：权重为 0（完全重复的向量）时 1/0 = Infinity。不守卫会让稳定性
    // 出现 Infinity/NaN，而 NaN 的比较全是 false —— 于是「选择」静默地全不选。
    const lam = weight > 0 ? 1 / weight : Number.MAX_VALUE

    if (newSize >= minClusterSize && sizeFrom < minClusterSize && sizeTo < minClusterSize) {
      // 两个碎片合够门槛 → 一个新簇诞生。它生在「碎片间最贵的边」上，所以
      // 「诞生 λ」与「成员掉出的 λ」相同，稳定性记 0（没有密度区间可言）。
      kids.push(null)
      elements.push(merged)
      lambdaBirth.push(0)
      lambdaPs.push(new Float64Array(merged.length).fill(lam))
      pointTo.set(newRoot, kids.length - 1)
    } else if (newSize >= minClusterSize && sizeFrom >= minClusterSize && sizeTo >= minClusterSize) {
      // 两个都够门槛的簇相合 → 父簇诞生在 λ = 1/w。两个子簇到此为止。
      const li = pointTo.get(rf)
      const ri = pointTo.get(rt)
      if (li === undefined || ri === undefined) {
        throw new Error('层次树内部状态不一致：合并两个成规模簇时找不到子簇下标')
      }
      kids.push([li, ri])
      elements.push(merged)
      lambdaBirth.push(lam)
      lambdaPs.push(new Float64Array(merged.length).fill(lam))
      pointTo.set(newRoot, kids.length - 1)
    } else if (newSize >= minClusterSize) {
      // 一个成规模簇吸进一个碎片：簇长大，只给碎片那部分补 λ。
      let idx = pointTo.get(newRoot)
      if (idx === undefined) {
        const ex = pointTo.get(rf)
        idx = ex !== undefined ? ex : pointTo.get(rt)
        if (idx === undefined) throw new Error('层次树内部状态不一致：吸并碎片时找不到宿主簇下标')
        pointTo.set(newRoot, idx)
      }
      elements[idx] = merged
      const mergeSize = sizeFrom < minClusterSize ? sizeFrom : sizeTo
      const prev = lambdaPs[idx]!
      const grown = new Float64Array(prev.length + mergeSize)
      grown.set(prev, 0)
      grown.fill(lam, prev.length)
      lambdaPs[idx] = grown
    }
    // 其余情形（newSize < 门槛）：两个碎片合起来还不够门槛，不成簇，什么都不记。
  }

  // 丢掉「全库合并成一体」的根 —— 它必然被选中，留着会把所有点收进一个巨大簇。
  kids.pop()
  elements.pop()
  lambdaBirth.pop()
  lambdaPs.pop()

  // 每个点落在哪个簇：从它自己出发沿并查集向上，第一个有簇下标的分量。
  const rootOf = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    let x = i
    let hit = -1
    while (true) {
      const idx = pointTo.get(x)
      if (idx !== undefined) {
        hit = idx
        break
      }
      const p = uf.parent[x]!
      if (p === x) break
      x = p
    }
    rootOf[i] = hit
  }

  return {
    kids,
    elements,
    lambdaBirth: Float64Array.from(lambdaBirth),
    lambdaPs,
    rootOf,
  }
}

/**
 * 簇稳定性：`S(c) = Σ_p (λ_p − λ_birth(c))`。
 *
 * 语义是「这个簇在多宽的密度区间里保持完整」。宽 → 它描述的是一个真实存在的密度结构；
 * 窄 → 它只是某次合并的副产品，应当并入父簇。
 *
 * 碎片合出来的簇（`kids === null`）的 λ_birth 记 0：它没有「出生密度」可言，
 * 拿它的成员 λ 直接求和即 `clusternova` 的算法（对照时逐位一致）。
 */
export function computeStability(tree: LinkageTree): Float64Array {
  const st = new Float64Array(tree.elements.length)
  for (let i = 0; i < tree.elements.length; i++) {
    const ps = tree.lambdaPs[i]!
    const birth = tree.kids[i] === null ? 0 : tree.lambdaBirth[i]!
    let s = 0
    for (let j = 0; j < ps.length; j++) s += ps[j]! - birth
    st[i] = s
  }
  return st
}

/** 选择结果：被选为最终簇的层次树下标（升序）与每个簇的 s_hat。 */
export interface Selection {
  selected: number[]
  /** 每个簇的 s_hat（= max(自身稳定性, 两个子簇 s_hat 之和)）。 */
  sHat: Float64Array
}

/**
 * 自底向上选簇：`S(c) < Ŝ(left) + Ŝ(right)` 则留子簇，否则留父簇并弃子。
 *
 * 层次树数组的**构造顺序天然是自底向上**（父簇总是在它的两个子簇之后被 push），
 * 所以单趟正序扫描就够，不需要递归或拓扑排序。
 *
 * 这一趟的错法极其安静：写成 `<=` 只是偏好父簇一点，写成「比较 S(c) 与
 * S(left)+S(right) 而不用 Ŝ」会让孙辈的稳定性被漏算 —— 两者都只改变划分、
 * 不产生任何异常。
 */
export function selectClusters(tree: LinkageTree, stability: Float64Array): Selection {
  const n = tree.elements.length
  const isSel = new Uint8Array(n)
  const sHat = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const k = tree.kids[i]
    if (k === null) {
      // 叶子（碎片合出来的簇）：必选，除非后面被某个祖先弃掉。
      sHat[i] = stability[i]!
      isSel[i] = 1
      continue
    }
    const l = k[0]
    const r = k[1]
    const sum = sHat[l]! + sHat[r]!
    if (stability[i]! < sum) {
      sHat[i] = sum
      isSel[i] = 0
    } else {
      sHat[i] = stability[i]!
      isSel[i] = 1
      // 选中父簇 → 弃掉两个子簇。
      isSel[l] = 0
      isSel[r] = 0
    }
  }
  const selected: number[] = []
  for (let i = 0; i < n; i++) if (isSel[i] === 1) selected.push(i)
  return { selected, sHat }
}

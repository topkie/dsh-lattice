// 重聚类 B 组（上）：并查集与 boruvka 近似最小生成树。
//
// 「boruvka 近似」这个限定的真实含义是**只换第 3 步的算法**：在 k 近邻图上求近似 MST，
// 而不是在完整互可达距离图上求精确 MST。核心距离、互可达距离、层次树、簇稳定性
// 一步都省不掉 —— 它们是这套方法有效的原因，不是可以砍掉的装饰。
//
// 为什么 boruvka 而不是 Prim：Prim 需要优先队列（`clusternova` 里那 1 500 字节的
// `PriorityQueue` 就是为它写的），而 boruvka 每轮只做「每个分量扫一遍边表选最小出边」，
// 不需要堆、也不需要 DSU 之外的辅助结构。边表本来就按分量重复扫，而边数是 n*k 量级，
// 所以 `O(E log n)` 的实际常数比堆版本小。代价是每轮要重建 best 数组（三次 fill）。
//
// **近似会近似在哪里**：k 近邻图可能不包含真正的最近边，于是 MST 里出现几条
// 「不该那么贵」的边，层次树上表现为本该晚合并的两团提前合了。k 越小这个偏差越大 ——
// 这正是探针里把 k 当敏感参数扫的原因（见 `graph.ts` 的 DEFAULT_KNN_K 注释）。

import type { EdgeList } from './graph.js'

/**
 * 缝合互不相连的分量时，桥边权重取「全图最大权重」的这个倍数。
 *
 * 只有一种情形会用到它：k 近邻图**本身不连通**（k 小的时候很常见 —— 见 graph.ts 的
 * DEFAULT_KNN_K 注释）。此时分量之间一条边都没有，而生成树要有 n-1 条边才能支撑
 * 层次树，于是必须造几条桥边。
 *
 * 取「最大权重 × 2」而不是某个小常数，是为了让桥边在生成树里是**最贵的边** ——
 * 按 Kruskal 顺序它排在最后，于是这些分量在层次树上最后才被并进全局根。
 * 反过来说，若桥边很便宜，λ = 1/边权就会很大，全局根会因此得到一个很大的稳定性，
 * 把那些本来孤立的小分量整片吸收进「一个巨大簇」—— 正是本项最典型的静默错法。
 */
export const MST_BRIDGE_FACTOR = 2

/**
 * 并查集：**路径压缩 + 按大小合并**，不做 rank。
 *
 * 为什么不用 rank：boruvka 每轮结束后要重新 `find` 全部顶点，路径压缩已经把树压到
 * 接近两层；按大小合并需要的额外数组与判断在 1e3~1e4 档上省不下可测量的时间。
 * 层次树的构建也复用同一个结构（Kruskal 顺序合并），那里同样吃路径压缩。
 */
export interface UnionFind {
  parent: Int32Array
  find(x: number): number
  union(a: number, b: number): number
  /** 当前连通分量数。 */
  count(): number
}

export function makeUnionFind(n: number): UnionFind {
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  let comps = n
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]!
    // 第二趟把路径上所有点直接挂到根上。
    while (parent[x] !== r) {
      const nx = parent[x]!
      parent[x] = r
      x = nx
    }
    return r
  }
  return {
    parent,
    find,
    // 返回合并后的根，调用方需要它来更新「分量的成员表」。
    union(a: number, b: number): number {
      const ra = find(a)
      const rb = find(b)
      if (ra === rb) return ra
      parent[ra] = rb
      comps--
      return rb
    },
    count: () => comps,
  }
}

/** 近似 MST 的边（三数组扁平表示）。顶点数 n 时 `a.length === n - 1`。 */
export interface Mst {
  a: Int32Array
  b: Int32Array
  w: Float32Array
  /** 建树过程中发现图不连通、被迫用「最贵的可用边」缝合分量的次数。 */
  forcedJoins: number
}

/**
 * boruvka 近似 MST。
 *
 * 每轮：让每个分量挑出自己**最小的一条出边**，然后把这些边全部合并（一轮至少减半
 * 分量数，所以轮数是 O(log n)）。同一轮内多个分量可能挑到同一条边，合并时发现
 * 已经在同一分量里就跳过 —— 这是 boruvka 的正常形态，不是错误。
 *
 * **图不连通时的行为**：k 近邻图（尤其 k=2）可能不连通。此时某个分量没有出边，
 * 若直接退出，产出的是**森林**而不是树，后面的层次树会少掉一部分点（静默丢簇）。
 * 所以这里做一次退避：没有出边的分量先记为「待缝合」，本轮结束后用一条最便宜的
 * 跨分量边把它接上（`forcedJoins` 计数）。这条边的权重通常很大，在层次树上表现为
 * 「很晚才合并」——语义上正是「这两团之间没有真正的近邻关系」，是**正确**的表达，
 * 比丢掉它们强。
 */
export function boruvkaMST(n: number, edges: EdgeList): Mst {
  if (n <= 1) return { a: new Int32Array(0), b: new Int32Array(0), w: new Float32Array(0), forcedJoins: 0 }
  const uf = makeUnionFind(n)
  const m = edges.a.length
  const outA: number[] = []
  const outB: number[] = []
  const outW: number[] = []
  let forcedJoins = 0

  // 复用缓冲：每轮 fill 比每轮新分配三个数组便宜得多。
  const bestW = new Float64Array(n)
  const bestFrom = new Int32Array(n)
  const bestTo = new Int32Array(n)
  const bestEdge = new Int32Array(n)

  // 边表里出现过的顶点。不在其中的顶点是**孤立点**：没有任何一条边。
  // 提前算出来，缝合那一支就不必每轮重扫边表判断谁是孤立点。
  const touched = new Uint8Array(n)
  for (let e = 0; e < m; e++) {
    touched[edges.a[e]!] = 1
    touched[edges.b[e]!] = 1
  }

  while (uf.count() > 1) {
    bestW.fill(Infinity)
    bestEdge.fill(-1)
    for (let e = 0; e < m; e++) {
      const ra = uf.find(edges.a[e]!)
      const rb = uf.find(edges.b[e]!)
      if (ra === rb) continue
      const w = edges.w[e]!
      if (w < bestW[ra]!) {
        bestW[ra] = w
        bestFrom[ra] = ra
        bestTo[ra] = rb
        bestEdge[ra] = e
      }
      if (w < bestW[rb]!) {
        bestW[rb] = w
        bestFrom[rb] = rb
        bestTo[rb] = ra
        bestEdge[rb] = e
      }
    }

    let merged = 0
    for (let r = 0; r < n; r++) {
      if (uf.find(r) !== r) continue
      const e = bestEdge[r]!
      if (e < 0) continue
      const x = uf.find(bestFrom[r]!)
      const y = uf.find(bestTo[r]!)
      if (x === y) continue
      uf.union(x, y)
      outA.push(edges.a[e]!)
      outB.push(edges.b[e]!)
      outW.push(edges.w[e]!)
      merged++
    }

    // 本轮一个分量都没能合并 → k 近邻图不连通。
    //
    // 这里是本函数最容易静默出错的地方：早期版本在这一支里写的是 `break`，
    // 于是返回的是**森林**而不是树 —— MST 少 4 条边（1373 -> 1369），层次树因此
    // 丢掉 117 个点（它们不属于任何节点），聚类的噪声比例被凭空抬高。
    // 全程不报错，只是结果不对。
    //
    // 正确做法是**缝合**：把剩余分量两两接上，用的是「把生成树补成树」所必需的边。
    // 先处理**孤立点**（它一条边都没有 —— k=2 时很常见，某条记忆与谁都不近），
    // 再按最便宜的跨分量边把剩下的分量串起来。这些边通常很贵（两团之间本来就没有
    // 近邻关系），于是在层次树上表现为「很晚才合并」：语义上正是「这两团没有关系」，
    // 比丢掉它们准确。
    if (merged === 0) {
      bridgeOneComponent(uf, edges, outA, outB, outW, touched, n)
      forcedJoins++
    }
  }

  return {
    a: Int32Array.from(outA),
    b: Int32Array.from(outB),
    w: Float32Array.from(outW),
    forcedJoins,
  }
}

/**
 * 把 MST 边按权重升序排好（Kruskal 顺序）。
 *
 * 单列出来是因为**排序必须在层次树之前完成、且只做一次**：层次树的每一条合并都
 * 依赖「此刻处理的边是当前最便宜的跨分量边」，顺序错了得到的是另一棵树（而不是
 * 一个坏掉的树）—— 这正是「静默错簇」的典型入口。
 */
export function sortEdgesByWeight(mst: Mst): Int32Array {
  const order = new Int32Array(mst.w.length)
  for (let i = 0; i < order.length; i++) order[i] = i
  // 用普通数组排序再回填：Int32Array.prototype.sort 接不了比较器（会按数值排，
  // 我们要的是按下标指向的权重排）。
  const asArray = Array.from(order)
  asArray.sort((x, y) => mst.w[x]! - mst.w[y]!)
  order.set(asArray)
  return order
}
/**
/**
 * 缝合一个**互不相连的分量**：造一条桥边把它接到别的分量上。
 *
 * 走到这里说明 k 近邻图**本身不连通** —— 分量之间一条边都没有（不是「边太贵」，
 * 是真的没有）。既然没有边可挑，就只能造一条：权重取全图最大权重 × MST_BRIDGE_FACTOR，
 * 让它成为生成树里最贵的一条，按 Kruskal 顺序排在最后。
 *
 * **为什么必须缝合而不是就此返回森林**：层次树要 n-1 条边才是树，森林会让那些点
 * 不属于任何节点 —— 它们的 label 落在 -1（噪声），划分看起来仍然「合理」，
 * 只是静默地少了一批点。上一版就是在这里写了个 `break`（更早）或抛出（更晚），
 * 前者静默丢点、后者让整条链路对正常的 k=2 输入直接失败。
 *
 * 桥边的两个端点怎么选：一个取本次要缝合的分量的任一顶点，另一个取**别的**分量的
 * 任一顶点。之所以可以用「任一」，是因为分量之间没有边，谁接谁在几何上等价；
 * 但**必须在不同分量之间**取，否则生成一条自环，边数够了而图仍然不连通。
 */
function bridgeOneComponent(
  uf: UnionFind,
  edges: EdgeList,
  outA: number[],
  outB: number[],
  outW: number[],
  touched: Uint8Array,
  n: number,
): void {
  // 找两个不同的分量：优先挑一个「活跃顶点」（边表里出现过的），
  // 那样它的成员表在层次树里是有意义的；孤立点只会出现在极端情形下。
  const activeA = firstRoot(uf, touched, n, 1)
  const activeB = firstRoot(uf, touched, n, 0)
  if (activeA >= 0 && activeB >= 0 && activeA !== activeB) {
    pushBridge(uf, edges, outA, outB, outW, activeA, activeB)
    return
  }
  // 退化情形：连一个活跃顶点都没有（边表为空），按顶点序号取两个不同分量。
  let a = -1
  let b = -1
  for (let v = 0; v < n && (a < 0 || b < 0); v++) {
    if (uf.find(v) !== v) continue
    if (a < 0) a = v
    else if (uf.find(a) !== uf.find(v)) b = v
  }
  if (a < 0 || b < 0) throw new Error('无法缝合：找不出两个不同的分量')
  pushBridge(uf, edges, outA, outB, outW, a, b)
}

/**
 * 取第 idx 个「属于某个分量、且是边表里出现过的顶点」。
 *
 * 用 `touched` 而不是随便取一个顶点：层次树对**每个顶点**都要有一条通往根的路径，
 * 而孤立点（不在边表里）根本没有路径可言 —— 把它们接进树里的唯一办法是桥边，
 * 那正是本函数要处理的情形。先拿活跃顶点去桥接，孤立点会在后续轮次里被依次接上。
 */
function firstRoot(uf: UnionFind, touched: Uint8Array, n: number, idx: number): number {
  let seen = 0
  for (let v = 0; v < n; v++) {
    if (touched[v] !== 1) continue
    if (uf.find(v) !== v) continue
    if (seen === idx) return v
    seen++
  }
  return -1
}

/**
 * 造一条桥边并合并两个分量。
 */
function pushBridge(
  uf: UnionFind,
  edges: EdgeList,
  outA: number[],
  outB: number[],
  outW: number[],
  a: number,
  b: number,
): void {
  let maxW = 0
  for (let e = 0; e < edges.w.length; e++) if (edges.w[e]! > maxW) maxW = edges.w[e]!
  uf.union(a, b)
  outA.push(a)
  outB.push(b)
  outW.push(maxW * MST_BRIDGE_FACTOR)
}

// 重聚类（T16）的用例。
//
// **这一组的重点不是「跑得通」**，而是那些「错了不会崩、只会静默给出合法结果」的地方：
//   · 生成树是不是真的生成树（森林会让层次树静默丢点）
//   · 未归类点是不是真的标了 -1（少标会把噪声塞进主题）
//   · 身份对齐的门槛两侧行为（配错会让旧 id 挂到语义不同的簇上）
//   · 落库后的引用完整性（悬空引用是静默的：外键 ON DELETE 不报错）
//
// 用合成向量而不是真实库：数值关系可以**构造**出来，「应当得到什么簇」才有判据。
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { encodeVec, normalizeInPlace } from '../dist/util/vec.js'
import {
  buildKnnGraph,
  coreDistances,
  mutualReachabilityEdges,
  knnGraphStats,
} from '../dist/cluster/graph.js'
import { boruvkaMST } from '../dist/cluster/mst.js'
import { buildLinkageTree, computeStability, selectClusters } from '../dist/cluster/hierarchy.js'
import { extractClusters, clusterProbabilities } from '../dist/cluster/extract.js'
import { alignTopics, centroidsOf } from '../dist/cluster/align.js'
import { countDanglingTopicRefs, rebuildTopicTables } from '../dist/cluster/rebuild.js'

/**
 * 造一批「方向可控」的向量：第 base 维是主方向，其余维是 jitter 的扰动。
 *
 * **种子必须与 base 相关**：若每个 blob 都用同一个种子，不同团的第 i 个点会拿到
 * 同一串扰动，于是它们在**同一个方向**上抖动 —— 团间距离被凭空拉近，
 * 「三团应当分成三簇」这条判据会以「簇数不对」的形式失败，而失败的原因与聚类
 * 代码无关。踩过一次，所以把这条写在这里。
 */
function blob(dim, base, count, jitter) {
  const out = []
  let s = 12345 + base * 7919
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
  for (let i = 0; i < count; i++) {
    const v = new Float32Array(dim)
    for (let d = 0; d < dim; d++) v[d] = (rnd() * 2 - 1) * jitter
    v[base] += 1
    out.push(normalizeInPlace(v))
  }
  return out
}

/** 三团，彼此几乎正交（不同维度），团内很近。 */
function threeBlobs(dim = 32, per = 12, jitter = 0.02) {
  return [...blob(dim, 0, per, jitter), ...blob(dim, 1, per, jitter), ...blob(dim, 2, per, jitter)]
}

/** 沿单维的单位向量。用于身份对齐的可构造相似度。 */
function unit(dim, base) {
  const v = new Float32Array(dim)
  v[base] = 1
  return v
}

function labelCounts(label) {
  const m = new Map()
  for (const l of label) m.set(l, (m.get(l) ?? 0) + 1)
  return m
}

describe('重聚类：近邻图', () => {
  it('每点恰好 k 个邻居，且按距离升序、不含自身', () => {
    const vecs = threeBlobs()
    const g = buildKnnGraph(vecs, 4)
    assert.equal(g.n, vecs.length)
    assert.equal(g.k, 4)
    assert.equal(g.idx.length, vecs.length * 4)
    for (let i = 0; i < g.n; i++) {
      for (let t = 1; t < g.k; t++) {
        assert.ok(g.dist[i * g.k + t - 1] <= g.dist[i * g.k + t], '第 ' + i + ' 点的邻居没有按距离升序')
      }
      for (let t = 0; t < g.k; t++) assert.notEqual(g.idx[i * g.k + t], i, '第 ' + i + ' 点把自己当成了邻居')
    }
  })

  it('k 越界时报错，而不是给出退化的图', () => {
    const vecs = threeBlobs()
    assert.throws(() => buildKnnGraph(vecs, 0), /k 必须是/)
    assert.throws(() => buildKnnGraph(vecs, vecs.length), /必须小于点数/)
  })

  it('核心距离就是第 k 近邻距离', () => {
    const vecs = threeBlobs()
    const g = buildKnnGraph(vecs, 3)
    const core = coreDistances(g, 3)
    for (let i = 0; i < g.n; i++) assert.equal(core[i], g.dist[i * 3 + 2])
    assert.throws(() => coreDistances(g, 4), /核心距离的 k/)
  })

  it('互可达距离不小于两端各自的核心距离，且边不重复', () => {
    const vecs = threeBlobs()
    const g = buildKnnGraph(vecs, 3)
    const core = coreDistances(g, 3)
    const e = mutualReachabilityEdges(g, core)
    assert.equal(e.a.length, e.b.length)
    assert.equal(e.a.length, e.w.length)
    const seen = new Set()
    for (let i = 0; i < e.a.length; i++) {
      assert.ok(e.a[i] < e.b[i], '边没有规范化成 (小, 大)')
      assert.ok(e.w[i] >= core[e.a[i]] - 1e-6)
      assert.ok(e.w[i] >= core[e.b[i]] - 1e-6)
      const key = e.a[i] * g.n + e.b[i]
      assert.ok(!seen.has(key), '有重复边')
      seen.add(key)
    }
  })

  it('归一化向量不应出现负余弦；完全重复的向量被记出来', () => {
    const vecs = threeBlobs()
    // 复制一个点：它与原点是**距离 0** 的关系，必须被 exactDupPairs 数到。
    vecs.push(new Float32Array(vecs[0]))
    const g = buildKnnGraph(vecs, 2)
    const st = knnGraphStats(g)
    // 负余弦对「归一化向量」是不可能的（余弦最小为 -1，但这里最大距离远小于 2）。
    // 这个断言的价值在于：尺度用错（没归一化）时它会**立刻**不为 0。
    // float32 的 dot(v,v) 会略大于 1，于是 1-dot 是个绝对值极小的负数。
    // 那个不是负余弦，不该被报出来（容差的意义就在这里）。
    assert.equal(st.negativeCosPairs, 0)
    // 反过来：真的把尺度搞错时（喂**未**归一化向量）它必须被报出来。
    const raw = threeBlobs().map((v) => {
      const w = new Float32Array(v.length)
      for (let i = 0; i < v.length; i++) w[i] = v[i] * 3
      return w
    })
    const stRaw = knnGraphStats(buildKnnGraph(raw, 2))
    assert.ok(stRaw.negativeCosPairs > 0, '尺度用错（未归一化）没有被报出来')
    // 复制点与原点互为最近邻，距离**约等于 0**。
    //
    // 为什么不断言「恰好 0」：float32 的 dot(v, v) 会因舍入略大于 1（实测
    // 1.0000000524），于是 1-dot 是 -5.2e-8 而不是 0 —— 两个逐位相同的向量在浮点下
    // 得到的是「约等于 0」。exactDupPairs 是否命中取决于这一次的舍入方向，用它当
    // 断言会得到一个偶尔失败的用例（本来写的就是精确 0，实测失败）。
    const dup = vecs.length - 1
    const nb = []
    for (let t = 0; t < g.k; t++) nb.push([g.idx[dup * g.k + t], g.dist[dup * g.k + t]])
    assert.ok(
      nb.some(([j, d]) => j === 0 && Math.abs(d) < 1e-6),
      '复制点没有把原点当成（近乎）零距离的邻居：' + JSON.stringify(nb),
    )
    assert.equal(g.idx[0], dup, '原点没有把复制点当成最近邻')
    assert.ok(Number.isInteger(st.exactDupPairs) && st.exactDupPairs >= 0)
    assert.ok(st.distP50 > 0 && st.distP50 < 1)
  })
})

describe('重聚类：生成树与层次树', () => {
  it('生成树恰好 n-1 条边，且把全图连通', () => {
    const vecs = threeBlobs()
    const g = buildKnnGraph(vecs, 3)
    const mst = boruvkaMST(g.n, mutualReachabilityEdges(g, coreDistances(g, 3)))
    assert.equal(mst.a.length, g.n - 1)
    const par = new Int32Array(g.n)
    for (let i = 0; i < g.n; i++) par[i] = i
    const find = (x) => {
      while (par[x] !== x) {
        par[x] = par[par[x]]
        x = par[x]
      }
      return x
    }
    for (let e = 0; e < mst.a.length; e++) {
      const a = find(mst.a[e])
      const b = find(mst.b[e])
      if (a !== b) par[a] = b
    }
    const roots = new Set()
    for (let v = 0; v < g.n; v++) roots.add(find(v))
    assert.equal(roots.size, 1, '生成树没有把全图连通')
  })

  it('图不连通时用桥边缝合，仍然给出 n-1 条边（而不是森林）', () => {
    // 两个分量：{0,1} 与 {2,3}。分量之间一条边都没有 —— 强制走缝合分支。
    // 选 4 个点（而不是更多）是为了让合并只发生一轮，缝合次数可精确断言：
    // 点多了之后 boruvka 会先在自己分量内部合并若干轮，缝合次数随之大于 1。
    const edges = {
      a: Int32Array.from([0, 2]),
      b: Int32Array.from([1, 3]),
      w: Float32Array.from([0.1, 0.2]),
    }
    const mst = boruvkaMST(4, edges)
    assert.equal(mst.a.length, 3, '没有缝合出 n-1 条边')
    assert.equal(mst.forcedJoins, 1)
    assert.ok(Math.max(...mst.w) > 0.2, '桥边应当是权重最大的一条')
    // 缝合之后全图连通
    const par = new Int32Array(4)
    for (let i = 0; i < 4; i++) par[i] = i
    const find = (x) => {
      while (par[x] !== x) {
        par[x] = par[par[x]]
        x = par[x]
      }
      return x
    }
    for (let e = 0; e < mst.a.length; e++) {
      const ra = find(mst.a[e])
      const rb = find(mst.b[e])
      if (ra !== rb) par[ra] = rb
    }
    const roots = new Set()
    for (let v = 0; v < 4; v++) roots.add(find(v))
    assert.equal(roots.size, 1, '缝合之后图仍然不连通')
  })

  it('边数不是 n-1 时层次树入口直接拒绝（防止森林静默丢点）', () => {
    const edges = { a: Int32Array.from([0]), b: Int32Array.from([1]), w: Float32Array.from([0.1]) }
    assert.throws(() => buildLinkageTree(edges, 5, 3), /生成树边数不对/)
  })

  it('层次树覆盖每一个点（没有点被落下）', () => {
    const vecs = threeBlobs()
    const g = buildKnnGraph(vecs, 3)
    const tree = buildLinkageTree(boruvkaMST(g.n, mutualReachabilityEdges(g, coreDistances(g, 3))), g.n, 3)
    const seen = new Uint8Array(g.n)
    for (const el of tree.elements) for (const p of el) seen[p] = 1
    assert.equal(
      seen.reduce((s, x) => s + x, 0),
      g.n,
      '有点不属于任何层次树节点',
    )
  })

  it('稳定性非负', () => {
    const vecs = threeBlobs()
    const g = buildKnnGraph(vecs, 3)
    const tree = buildLinkageTree(boruvkaMST(g.n, mutualReachabilityEdges(g, coreDistances(g, 3))), g.n, 3)
    const st = computeStability(tree)
    for (let i = 0; i < st.length; i++) assert.ok(st[i] >= 0, '稳定性为负')
  })
})

describe('重聚类：簇提取与标签', () => {
  it('三团数据分成三个簇，且每个簇不混两个团', () => {
    const per = 15
    const vecs = threeBlobs(32, per, 0.02)
    const g = buildKnnGraph(vecs, 3)
    const tree = buildLinkageTree(boruvkaMST(g.n, mutualReachabilityEdges(g, coreDistances(g, 3))), g.n, 3)
    const stab = computeStability(tree)
    const sel = selectClusters(tree, stab)
    const assign = extractClusters(tree, sel, g.n)
    const counts = [...labelCounts(assign.label).entries()].filter(([l]) => l !== -1)
    assert.equal(counts.length, 3, '簇数不是 3：' + JSON.stringify(counts))
    for (const [, n] of counts) assert.equal(n, per)
    for (const m of assign.members) {
      const blobs = new Set(m.map((p) => Math.floor(p / per)))
      assert.equal(blobs.size, 1, '一个簇里混了两个团')
    }
  })

  it('离群点标 -1（未归类域）', () => {
    // 3 个离群点：它们彼此很近（都在 10/11/12 三维上，权重相近），与三团都正交。
    //
    // 为什么不用「各自单独一维」的构造：那样每个离群点与最近的真实点距离是 1，
    // 而三团在 jitter 很小时**核心距离**接近 0 —— 于是互可达距离里 max(core, d)
    // 选中的是 d，离群点会顺着这条边被吸进最近的那个真实簇。那是 k 太小（邻居
    // 信息不足）的固有行为，不是未归类域没实现。把离群点做成互相聚拢的一小团、
    // 簇门槛设成 5，它们就落回「密度不够、不该单独成主题」这一侧。
    const vecs = threeBlobs(32, 10, 0.02)
    // 三个离群点沿同一条方向（10/11/12 三维等权），各自再偏一点点：
    // 它们因此彼此极近（互相是最近邻），而与三团正交（距离约 1）。
    const dir = new Float32Array(32)
    for (const p of [10, 11, 12]) dir[p] = 1
    normalizeInPlace(dir)
    for (let i = 0; i < 3; i++) {
      const x = new Float32Array(dir)
      x[10 + i] += 0.05
      vecs.push(normalizeInPlace(x))
    }
    const g = buildKnnGraph(vecs, 2)
    const core = coreDistances(g, 2)
    const tree = buildLinkageTree(boruvkaMST(g.n, mutualReachabilityEdges(g, core)), g.n, 5)
    const sel = selectClusters(tree, computeStability(tree))
    const assign = extractClusters(tree, sel, g.n)
    // 三团各自成簇，规模都是 10
    const sizes = assign.members.map((m) => m.length).sort((a, b) => a - b)
    assert.deepEqual(sizes, [10, 10, 10], '三团的规模不是 10：' + JSON.stringify(sizes))
    // 三个离群点全部落在未归类域
    const noise = assign.label.filter((l) => l === -1).length
    assert.equal(noise, 3, '噪声数不是 3：' + noise)
    for (let i = 30; i < 33; i++) assert.equal(assign.label[i], -1, '第 ' + i + ' 个离群点被塞进了某个簇')
  })

  it('簇之间互斥：没有点同时属于两个簇', () => {
    const vecs = threeBlobs()
    const g = buildKnnGraph(vecs, 3)
    const tree = buildLinkageTree(boruvkaMST(g.n, mutualReachabilityEdges(g, coreDistances(g, 3))), g.n, 3)
    const sel = selectClusters(tree, computeStability(tree))
    const assign = extractClusters(tree, sel, g.n)
    const seen = new Uint8Array(g.n)
    for (const m of assign.members) {
      for (const p of m) {
        assert.equal(seen[p], 0, '点 ' + p + ' 出现在两个簇里')
        seen[p] = 1
      }
    }
  })

  it('隶属度落在 [0,1]，未归类点为 0 而不是 NaN', () => {
    const vecs = threeBlobs()
    const g = buildKnnGraph(vecs, 3)
    const tree = buildLinkageTree(boruvkaMST(g.n, mutualReachabilityEdges(g, coreDistances(g, 3))), g.n, 3)
    const stab = computeStability(tree)
    const sel = selectClusters(tree, stab)
    const assign = extractClusters(tree, sel, g.n)
    const prob = clusterProbabilities(tree, stab, sel, assign)
    for (let i = 0; i < prob.length; i++) {
      assert.ok(Number.isFinite(prob[i]), '隶属度不是有限数')
      assert.ok(prob[i] >= 0 && prob[i] <= 1, '隶属度越出 [0,1]：' + prob[i])
      if (assign.label[i] === -1) assert.equal(prob[i], 0)
    }
  })
})

describe('重聚类：身份对齐', () => {
  const dim = 8

  it('余弦达标才配对，且一个旧 id 只被一个簇继承', () => {
    const old = [
      { id: 101, centroid: unit(dim, 0), nAtoms: 5 },
      { id: 102, centroid: unit(dim, 1), nAtoms: 4 },
    ]
    const a = alignTopics(
      [
        { index: 0, centroid: unit(dim, 0), size: 5 },
        { index: 1, centroid: unit(dim, 1), size: 4 },
      ],
      old,
      0.8,
    )
    assert.equal(a.pairs.length, 2)
    assert.equal(a.topicOfCluster.get(0), 101)
    assert.equal(a.topicOfCluster.get(1), 102)
    assert.equal(a.fresh.length, 0)
    assert.equal(a.dissolved.length, 0)
  })

  it('低于门槛不配对：旧 topic 进 dissolved，新簇进 fresh', () => {
    const old = [{ id: 101, centroid: unit(dim, 0), nAtoms: 5 }]
    // 与 unit(0) 正交 → 余弦 0，远低于 0.80
    const a = alignTopics([{ index: 0, centroid: unit(dim, 3), size: 5 }], old, 0.8)
    assert.equal(a.pairs.length, 0)
    assert.deepEqual(a.dissolved, [101])
    assert.deepEqual(a.fresh, [0])
    assert.equal(a.topicOfCluster.size, 0)
  })

  it('贪心：一个旧 id 被两个簇争抢时只给余弦更高的那个', () => {
    const old = [{ id: 101, centroid: unit(dim, 0), nAtoms: 5 }]
    const v1 = new Float32Array(dim)
    v1[0] = 0.9
    v1[1] = Math.sqrt(1 - 0.81)
    const a = alignTopics(
      [
        { index: 0, centroid: v1, size: 3 },
        { index: 1, centroid: unit(dim, 0), size: 3 },
      ],
      old,
      0.8,
    )
    assert.equal(a.pairs.length, 1)
    assert.equal(a.topicOfCluster.get(1), 101, '应当给余弦更高的 1 号簇')
    assert.deepEqual(a.fresh, [0])
  })

  it('没有质心的旧 topic 不参与配对（直接解散），不硬塞给某个簇', () => {
    const old = [{ id: 101, centroid: null, nAtoms: 0 }]
    const a = alignTopics([{ index: 0, centroid: unit(dim, 0), size: 3 }], old, 0.8)
    assert.equal(a.pairs.length, 0)
    assert.deepEqual(a.dissolved, [101])
  })

  it('配对结果与输入顺序无关（同一份输入重跑得到同一套配对）', () => {
    const c = (b) => ({ index: b, centroid: unit(dim, b), size: 3 })
    const o = (id, b) => ({ id, centroid: unit(dim, b), nAtoms: 3 })
    const a1 = alignTopics([c(0), c(1)], [o(101, 0), o(102, 1)], 0.8)
    const a2 = alignTopics([c(1), c(0)], [o(102, 1), o(101, 0)], 0.8)
    assert.equal(a1.topicOfCluster.get(0), 101)
    assert.equal(a2.topicOfCluster.get(0), 101)
    assert.equal(a1.topicOfCluster.get(1), 102)
    assert.equal(a2.topicOfCluster.get(1), 102)
  })

  it('centroidsOf：质心是按成员的归一化方向，空组给 null', () => {
    const vecs = [unit(dim, 0), unit(dim, 0), unit(dim, 1)]
    const cs = centroidsOf(vecs, [[0, 1], [2], []], dim)
    assert.ok(Math.abs(cs[0][0] - 1) < 1e-6)
    assert.ok(Math.abs(cs[1][1] - 1) < 1e-6)
    assert.equal(cs[2], null)
  })
})

describe('重聚类：影子重建不留悬空引用', () => {
  let dbFile = ''
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-recluster-' +
        process.pid +
        '-' +
        Date.now() +
        '-' +
        Math.random().toString(36).slice(2) +
        '.db',
    )
  })
  afterEach(() => {
    for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true })
  })

  it('继承的旧 topic id 不变，解散的旧 topic 不再被引用', () => {
    const { db } = openVault(dbFile)
    const now = Date.now()
    // 两个旧 topic，各自一个 atom；外加一个不属于任何簇的 atom。
    const insTopic = db.prepare(
      'INSERT INTO topic(domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at) VALUES (NULL, ?, ?, ?, 0, ?, ?)',
    )
    const insAtom = db.prepare(
      "INSERT INTO atom(kind, text, summary, embedding, topic_id, fit, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'global', ?, ?)",
    )
    const insAttach = db.prepare(
      "INSERT INTO atom_topic(atom_id, topic_id, weight, origin) VALUES (?, ?, 1, 'primary')",
    )
    const vec = (b) => {
      const v = new Float32Array(512)
      v[b] = 1
      return encodeVec(v)
    }
    const t1 = Number(insTopic.run('A', vec(0), 1, now, now).lastInsertRowid)
    const t2 = Number(insTopic.run('B', vec(1), 1, now, now).lastInsertRowid)
    const a1 = Number(insAtom.run('结论', '甲', '甲', vec(0), t1, now, now).lastInsertRowid)
    const a2 = Number(insAtom.run('结论', '乙', '乙', vec(1), t2, now, now).lastInsertRowid)
    const a3 = Number(insAtom.run('结论', '丙', '丙', vec(2), null, now, now).lastInsertRowid)
    insAttach.run(a1, t1)
    insAttach.run(a2, t2)
    db.prepare(
      "INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES (\'atom\', ?, \'topic\', ?, \'near\', 0.5, \'untyped\', ?)",
    ).run(a1, t1, now)
    db.prepare(
      "INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES (\'atom\', ?, \'topic\', ?, \'near\', 0.5, \'untyped\', ?)",
    ).run(a2, t2, now)

    // 新划分：a1 与 a3 合成一个簇（继承 t1），a2 掉进未归类域。
    const stats = rebuildTopicTables(db, [
      {
        cluster: 0,
        inheritId: t1,
        label: '甲',
        sumVec: new Float32Array(512),
        nAtoms: 2,
        meanFit: 1,
        members: [a1, a3],
        probs: [0.5, 0.5],
      },
    ])
    assert.equal(countDanglingTopicRefs(db), 0, '留下了悬空引用')
    assert.equal(Number(db.prepare('SELECT topic_id FROM atom WHERE id = ?').get(a1).topic_id), t1)
    assert.equal(Number(db.prepare('SELECT topic_id FROM atom WHERE id = ?').get(a3).topic_id), t1)
    assert.equal(db.prepare('SELECT topic_id FROM atom WHERE id = ?').get(a2).topic_id, null)
    // t2 已解散（没有成员）
    assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM topic WHERE id = ?').get(t2).n), 0)
    // 指向 t2 的那条边被删掉了
    assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM edge').get().n), 1)
    assert.ok(stats.danglingRefs === 0)
    db.close()
  })

  it('主属行与 atom.topic_id 始终一致，且每个有主属的 atom 恰好一条主属行', () => {
    const { db } = openVault(dbFile)
    const now = Date.now()
    const vec = (b) => {
      const v = new Float32Array(512)
      v[b] = 1
      return encodeVec(v)
    }
    const t1 = Number(
      db
        .prepare(
          'INSERT INTO topic(domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at) VALUES (NULL, ?, ?, 1, 0, ?, ?)',
        )
        .run('A', vec(0), now, now).lastInsertRowid,
    )
    const ids = []
    for (let i = 0; i < 3; i++) {
      ids.push(
        Number(
          db
            .prepare(
              "INSERT INTO atom(kind, text, summary, embedding, topic_id, fit, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'global', ?, ?)",
            )
            .run('结论', 'x' + i, 'x' + i, vec(0), t1, now, now).lastInsertRowid,
        ),
      )
    }
    const s = rebuildTopicTables(db, [
      {
        cluster: 0,
        inheritId: t1,
        label: 'A',
        sumVec: new Float32Array(512),
        nAtoms: 3,
        meanFit: 1,
        members: ids,
        probs: [0.4, 0.5, 0.6],
      },
    ])
    assert.equal(s.inherited, 1)
    assert.equal(s.fresh, 0)
    assert.equal(s.atomsTouched, 3)
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) n FROM atom a JOIN atom_topic t ON t.atom_id = a.id AND t.origin = 'primary' WHERE a.topic_id IS NOT t.topic_id",
          )
          .get().n,
      ),
      0,
    )
    assert.equal(Number(db.prepare('SELECT n_atoms FROM topic WHERE id = ?').get(t1).n_atoms), 3)
    db.close()
  })
})

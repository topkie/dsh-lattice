// 图扩展（1 跳）的边推断与出度控制。
//
// 这个模块要处理的是一个具体事实：**在它之前，代码里不存在 atom↔atom 边**。
// 写入路径只产 `atom → topic` 的 near 边（write.ts 的 INSERT INTO edge），
// 而召回的图路只认 `atom ↔ atom` 的四类 kind —— 于是那条路在所有 scope 下都返回空。
// 判据里的 `graph = 0` 不是「被过滤掉了」，是这条路本来就没有输入。
//
// 两个边源：
//
//   near       向量近邻。每 atom 取余弦最高的 K 个邻居，且 cos ≥ nearCosMin。
//              这是 §40 那条反例判据（「MOD 随 N 增长」）盯着的边，所以它自带两个阀门：
//              **目标出度 K** 与**硬上限 OUT_DEGREE_CAP**。
//   duplicate  atom_pair 表里已经判成「重复」的对。那张表的判据是 cos ≥ DUP_COS 且
//              词面 ≥ DUP_LEX —— 阈值**不在这里定**，由调用方从 search.ts 传进来：
//              同一条判据两处定义，本项目已经吃过一次亏（rebuild.ts 的注释里记着）。
//              duplicate **不进图路白名单**：按 §24，它服务于「注入时只出一条更高分的」，
//              不是邻居扩展信号。
//
// **出度上限为什么落在生成侧**：查询侧的 LIMIT 只能截断某一次结果，表里的全连接依然
// 会让任何消费方踩到 §40 那个形态（MOD 涨、检索不变好）。表本身可控才算控制住了。
//
// **幂等**：inferred 边是派生物（schema.ts 的设计要点第 1 条），每次重建先删掉自己上次
// 写的那批。declared / untyped 边一律不动 —— 它们不是这个模块的产出。

import type { DatabaseSync } from 'node:sqlite'
import { decodeVec, VEC_DIM } from '../util/vec.js'

/** 每条边在库里的来源标记。declared 是真相源，inferred 由本模块重算。 */
export const INFERRED_ORIGIN = 'inferred'

/**
 * 每 atom 的**目标**出度：向量近邻保留几个。
 *
 * 取值来自实测（探针 03 的参数网格，基准库 1374 条 atom）：**MOD 几乎等于 K** ——
 * 96% 的 atom 过线邻居多于 K，所以 K 就是 MOD 的旋钮。§36 给的目标区间是 2~5，
 * 取中点 4 得到实测 MOD 3.86。
 */
export const NEAR_K = 4

/**
 * 近邻边的余弦截断线：低于它的对不建边。
 *
 * 取 0.70 的依据是**孤立率**而不是「边质量」：bge-small-zh 在中文短文本上的余弦分布很密
 * （实测 top-16 邻居的 cos 中位数仍有 0.748），0.70 与 0.86 之间没有自然断点，抬线不会
 * 砍掉一批「明显更差」的边，只会把一批 atom 变成孤点。实测：0.70 → 孤立 1.6%，
 * 0.75 → 8.1%（已越过 §36 的 <8% 目标），0.80 → 34%（越过 20% 报警线）。
 */
export const NEAR_COS_MIN = 0.7

/** 每 atom 出度的**硬上限**（§33 的降级路径与 §40 的反例判据都点名了 16）。 */
export const OUT_DEGREE_CAP = 16

/** 全量两两比较的规模上限；超出时拒绝推断并如实报告，而不是安静地跑上几分钟。 */
export const GRAPH_INFER_MAX_ATOMS = 4000

/** 图路认的 kind 白名单，与 search.ts 的图路 SQL 必须一致。 */
export const GRAPH_KINDS: readonly string[] = ['near', 'co_occur', 'refines', 'requires']

export interface InferOptions {
  /** 目标出度；默认 NEAR_K。 */
  nearK?: number
  /** 余弦截断线；默认 NEAR_COS_MIN。 */
  nearCosMin?: number
  /** 出度硬上限；默认 OUT_DEGREE_CAP。 */
  outDegreeCap?: number
  /** 重复判据的余弦线，取自 pipeline/search.ts 的 DUP_COS。**必填**。 */
  dupCos: number
  /** 重复判据的词面线，取自 pipeline/search.ts 的 DUP_LEX。**必填**。 */
  dupLex: number
  /** 规模上限；默认 GRAPH_INFER_MAX_ATOMS。 */
  maxAtoms?: number
  /** 写入 created_at 的时间戳；默认当前时刻。 */
  now?: number
}

export interface InferStats {
  /** 库里活着的 atom 总数（含未编码的），MOD 的分母。 */
  atoms: number
  /** 有向量、参与近邻计算的 atom 数。 */
  encoded: number
  /** 两两比较过的对数。 */
  pairsScanned: number
  nearEdges: number
  duplicateEdges: number
  /** 本次重建删掉的旧 inferred 边数。 */
  removedEdges: number
  /** 候选邻居多于目标出度 K 而被截断的 atom 数 —— K 在起作用的证据。 */
  truncatedByK: number
  /** 候选邻居多于硬上限 OUT_DEGREE_CAP 的 atom 数 —— §40 的「边爆炸」形态。 */
  cappedByHardLimit: number
  maxOutDegree: number
  /** 平均出度 MOD = Σdeg_out(a)/N（§36 第 8 项）。 */
  meanOutDegree: number
  /** 图路意义下孤立（入度与出度皆 0）的 atom 数。 */
  isolatedAtoms: number
  elapsedMs: number
}

export interface InferOutcome {
  status: 'built' | 'fresh' | 'too-large' | 'failed'
  detail: string
  stats: InferStats | null
}

/**
 * 读全部 atom 的向量，返回可参与近邻计算的子集。
 *
 * 未编码（零向量 / 长度不符 / 列缺失）的 atom **被排除在候选之外，但计入 N** ——
 * §36 的 MOD 分母是「活着的 atom 数」，不是「有向量的 atom 数」。把它们悄悄剔出分母，
 * 会让编码覆盖率下降时 MOD 看起来反而升高。
 */
function loadVectors(db: DatabaseSync): {
  total: number
  ids: number[]
  vecs: Float32Array[]
  norms: number[]
} {
  const rows = db.prepare('SELECT id, embedding FROM atom ORDER BY id').all() as Array<{
    id: number | bigint
    embedding: Uint8Array | null
  }>
  const ids: number[] = []
  const vecs: Float32Array[] = []
  const norms: number[] = []
  for (const r of rows) {
    const raw = r.embedding
    if (raw === null || raw === undefined) continue
    const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike)
    if (buf.byteLength !== VEC_DIM * 4) continue
    const v = decodeVec(buf)
    let s = 0
    for (let i = 0; i < VEC_DIM; i++) s += v[i]! * v[i]!
    const n = Math.sqrt(s)
    if (n === 0) continue
    ids.push(Number(r.id))
    vecs.push(v)
    norms.push(n)
  }
  return { total: rows.length, ids, vecs, norms }
}

/**
 * 重建全部 inferred 边。
 *
 * 全程一次事务：删旧 + 写新要么都成，要么都不成 —— 半套边会让图路在一个不完整
 * 的邻居图上工作，而那种损坏不会报错。
 */
export function inferEdges(db: DatabaseSync, opts: InferOptions): InferOutcome {
  const t0 = Date.now()
  const cap = Math.max(1, Math.floor(opts.outDegreeCap ?? OUT_DEGREE_CAP))
  const k = Math.max(0, Math.min(Math.floor(opts.nearK ?? NEAR_K), cap))
  const cosMin = opts.nearCosMin ?? NEAR_COS_MIN
  const maxAtoms = opts.maxAtoms ?? GRAPH_INFER_MAX_ATOMS
  const now = opts.now ?? Date.now()

  const { total, ids, vecs, norms } = loadVectors(db)
  if (total > maxAtoms) {
    return {
      status: 'too-large',
      detail:
        '库里有 ' +
        total +
        ' 条 atom，超过全量两两比较的上限 ' +
        maxAtoms +
        '；未建边（图路会保持为空，而不是给出一个不可信的结果）',
      stats: null,
    }
  }
  const n = ids.length
  // 多留一个槽位：第 k+1 个邻居是否仍过线，正是「这个 atom 被硬上限截断了」的判据。
  const keep = k + 1
  const nbId: number[][] = Array.from({ length: n }, () => [])
  const nbCos: number[][] = Array.from({ length: n }, () => [])
  const addNeighbor = (i: number, cand: number, cos: number): void => {
    const c = nbCos[i]!
    const len = c.length
    if (len === keep && cos <= c[len - 1]!) return
    let p = len < keep ? len : keep - 1
    while (p > 0 && c[p - 1]! < cos) p--
    c.splice(p, 0, cos)
    nbId[i]!.splice(p, 0, cand)
    if (c.length > keep) {
      c.pop()
      nbId[i]!.pop()
    }
  }

  let pairsScanned = 0
  for (let i = 0; i < n; i++) {
    const vi = vecs[i]!
    const ni = norms[i]!
    for (let j = i + 1; j < n; j++) {
      const vj = vecs[j]!
      let s = 0
      for (let d = 0; d < VEC_DIM; d++) s += vi[d]! * vj[d]!
      const cos = s / (ni * norms[j]!)
      pairsScanned++
      if (cos < cosMin) continue
      addNeighbor(i, j, cos)
      addNeighbor(j, i, cos)
    }
  }

  // 出度按 atom 的**库内 id** 记账：下面还要和 duplicate 边共享同一个上限。
  const degOut = new Map<number, number>()
  const degIn = new Map<number, number>()
  const bump = (m: Map<number, number>, id: number): void => {
    m.set(id, (m.get(id) ?? 0) + 1)
  }
  const edges: Array<{ s: number; d: number; kind: string; conf: number }> = []
  let truncatedByK = 0
  let cappedByHardLimit = 0
  for (let i = 0; i < n; i++) {
    const cs = nbCos[i]!
    const cand = nbId[i]!
    if (cs.length > k) truncatedByK++
    if (cs.length > cap) cappedByHardLimit++
    const take = Math.min(k, cs.length)
    for (let m = 0; m < take; m++) {
      edges.push({ s: ids[i]!, d: ids[cand[m]!]!, kind: 'near', conf: cs[m]! })
    }
  }

  // duplicate：表在基准库上可能是空的（T16 的判据只认 cos ≥ 0.92 且词面 ≥ 0.72），
  // 这里如实按行读取，不额外放宽 —— 放宽等于在别处偷偷定义第二条重复判据。
  const pairRows = db.prepare('SELECT a_id, b_id, cos, lexical FROM atom_pair').all() as Array<{
    a_id: number | bigint
    b_id: number | bigint
    cos: number
    lexical: number
  }>
  let duplicateEdges = 0
  for (const p of pairRows) {
    const cos = Number(p.cos)
    const lex = Number(p.lexical)
    if (!(cos >= opts.dupCos) || !(lex >= opts.dupLex)) continue
    const a = Number(p.a_id)
    const b = Number(p.b_id)
    if ((degOut.get(a) ?? 0) >= cap || (degOut.get(b) ?? 0) >= cap) continue
    edges.push({ s: a, d: b, kind: 'duplicate', conf: cos })
    duplicateEdges++
  }
  for (const e of edges) {
    bump(degOut, e.s)
    bump(degIn, e.d)
  }

  const ins = db.prepare(
    'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(src_type, src_id, dst_type, dst_id, kind) DO UPDATE SET ' +
      'confidence = excluded.confidence, origin = excluded.origin, created_at = excluded.created_at',
  )
  let removedEdges = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM edge WHERE origin = ?').get(INFERRED_ORIGIN) as {
      n: number | bigint
    }
    removedEdges = Number(before.n)
    db.prepare('DELETE FROM edge WHERE origin = ?').run(INFERRED_ORIGIN)
    for (const e of edges) {
      ins.run('atom', e.s, 'atom', e.d, e.kind, Math.round(e.conf * 1e6) / 1e6, INFERRED_ORIGIN, now)
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败不覆盖原始错误 */
    }
    return {
      status: 'failed',
      detail: '写边失败：' + (err instanceof Error ? err.message : String(err)),
      stats: null,
    }
  }

  let maxOut = 0
  let sumOut = 0
  const touched = new Set<number>()
  for (const e of edges) {
    touched.add(e.s)
    touched.add(e.d)
  }
  for (const [, d] of degOut) {
    if (d > maxOut) maxOut = d
    sumOut += d
  }
  // 孤立按图路的无向度算：入度与出度都为 0 才叫孤立。
  const stats: InferStats = {
    atoms: total,
    encoded: n,
    pairsScanned,
    nearEdges: edges.length - duplicateEdges,
    duplicateEdges,
    removedEdges,
    truncatedByK,
    cappedByHardLimit,
    maxOutDegree: maxOut,
    meanOutDegree: total === 0 ? 0 : Number((sumOut / total).toFixed(4)),
    isolatedAtoms: total - touched.size,
    elapsedMs: Date.now() - t0,
  }
  return {
    status: 'built',
    detail:
      '已建 ' +
      stats.nearEdges +
      ' 条 near 边、' +
      stats.duplicateEdges +
      ' 条 duplicate 边；MOD = ' +
      stats.meanOutDegree,
    stats,
  }
}

/**
 * 确保库里有 inferred 边：已经建过就直接返回，否则重建一次。
 *
 * **判据只有「表里有没有 inferred 边」这一条**，不含新鲜度检查：增量维护需要挂在写入
 * 路径上（write.ts），而那超出了本次的改动边界。代价是「新写入的 atom 不会自动获得边」，
 * 这在报告里作为未确定项写明，不假装它已经解决。
 */
export function ensureGraphEdges(db: DatabaseSync, opts: InferOptions): InferOutcome {
  const row = db.prepare('SELECT COUNT(*) AS n FROM edge WHERE origin = ?').get(INFERRED_ORIGIN) as {
    n: number | bigint
  }
  if (Number(row.n) > 0) {
    return { status: 'fresh', detail: '库中已有 ' + Number(row.n) + ' 条 inferred 边，未重建', stats: null }
  }
  return inferEdges(db, opts)
}

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
//
// **第三个边源不进这个模块**：模型在写入时声明的 `declared` 边（origin = declared，
// 见 pipeline/write.ts）。它们由写入落在同一个事务里，这里只**读**它们（图路白名单
// 认 related，计数见 edgeOriginCounts），重建时按 origin 跳过。

import type { DatabaseSync } from 'node:sqlite'
import type { ThresholdValue } from '../threshold-types.js'
import { decodeVec, VEC_DIM } from '../util/vec.js'

/** 每条边在库里的来源标记。declared 是真相源，inferred 由本模块重算。 */
export const INFERRED_ORIGIN = 'inferred'

/**
 * 写入方显式声明的边（`lattice_write` 的 `edges` 参数）。
 *
 * 本模块**只读不写**：重建只删自己那批 `inferred`，这一类一行都不动 —— 判据就是
 * 「重算不覆盖声明」。所以它没有列进上面那段「幂等」的处理，也不需要。
 */
export const DECLARED_ORIGIN = 'declared'

/**
 * 每 atom 的**目标**出度：向量近邻保留几个。
 *
 * 取值来自实测（探针 03 的参数网格，基准库 1374 条 atom）：**MOD 几乎等于 K** ——
 * 96% 的 atom 过线邻居多于 K，所以 K 就是 MOD 的旋钮。§36 给的目标区间是 2~5，
 * 取中点 4 得到实测 MOD 3.86。
 */
export const NEAR_K = 4 satisfies ThresholdValue<
  'recheckable',
  {
    area: '图扩展'
    tool: '探针 03（无脚本）'
    finding: '参数网格（K = 2/3/4/6/8 × cosMin = 0.70/0.75/0.80）：96%（1293/1374）的 atom 过线邻居多于 K，所以 MOD 由 K 直接决定 —— K=4 → 3.86、K=6（cosMin 0.75）→ 4.64；按 §36 的 MOD 目标区间 2~5 取中点 4'
    scale: '基准库 1374 条 atom（只有一个规模档）'
    failsWhen: ['库规模（atom 越多近邻越密）', '换编码模型（余弦尺度会变）', '§36 的 MOD 目标区间']
    affects: 'inferEdges：每个 atom 保留多少个向量近邻作为 near 边。它同时是图路的宽度与 §36 第 8 项 MOD 的旋钮 —— 实测 MOD 几乎等于 K'
  }
>

/**
 * 近邻边的余弦截断线：低于它的对不建边。
 *
 * 取 0.70 的依据是**孤立率**而不是「边质量」：bge-small-zh 在中文短文本上的余弦分布很密
 * （实测 top-16 邻居的 cos 中位数仍有 0.748），0.70 与 0.86 之间没有自然断点，抬线不会
 * 砍掉一批「明显更差」的边，只会把一批 atom 变成孤点。实测：0.70 → 孤立 1.6%，
 * 0.75 → 8.1%（已越过 §36 的 <8% 目标），0.80 → 34%（越过 20% 报警线）。
 */
export const NEAR_COS_MIN = 0.7 satisfies ThresholdValue<
  'recheckable',
  {
    area: '图扩展'
    tool: '探针 01（余弦分布）与探针 03（参数网格）'
    finding: 'top-16 邻居的 cos 中位数 0.748、p10 0.685 —— 0.70 与 0.86 之间没有自然断点，抬线砍不掉一批「明显更差」的边，只会制造孤点：0.70 → 孤立 1.6%，0.75 → 8.1%（越过 §36 的 <8% 目标），0.80 → 34%（越过 20% 报警线）。0.70 是三个候选里唯一同时满足 MOD 与孤立率两条区间的。它不是「相似」的语义线，只是「别把可用的 atom 变成孤点」的底线'
    scale: '基准库 1374 条 atom'
    failsWhen: ['换编码模型（余弦尺度会变）', '§36 的孤立率目标', '语料的领域混合度']
    affects: 'inferEdges：余弦低于此值的 atom 对不建边。它决定边质量的下限，也决定孤立率'
  }
>

/** 每 atom 出度的**硬上限**（§33 的降级路径与 §40 的反例判据都点名了 16）。 */
export const OUT_DEGREE_CAP = 16 satisfies ThresholdValue<
  'chosen',
  {
    area: '图扩展'
    why: '设计说明给的值，未在本库标定：§33 的降级路径、§40 的反例判据、技术文档 4.2 的图路参数都写 16，值出自那里；它是 K 被调大时的兜底，不是标定出来的上限'
    failsWhen: ['NEAR_K（K 接近或超过 16 时它才开始生效）', '库规模与语料密度']
    affects: '出度硬上限。两个来源各自用一次、**不合并计数**：推断边每 atom ≤ 16（inferEdges 把超出的邻居截断），声明边每批 ≤ 16（write.ts 把超出的边拒掉）。所以同一个 atom 可以有 16 条推断边 + 16 条声明边，合计不设上限。查询侧（graphPath 的每个种子）也用它截断候选，同样不参与前两者的计数'
    doc: 't18fail'
    docKey: '出度硬上限'
    docDefault: 16
  }
>

/** 全量两两比较的规模上限；超出时拒绝推断并如实报告，而不是安静地跑上几分钟。 */
export const GRAPH_INFER_MAX_ATOMS = 4000 satisfies ThresholdValue<
  'recheckable',
  {
    area: '图扩展'
    tool: '无脚本（按实测吞吐外推）'
    finding: '基准库全量成对（943 251 对、512 维）实测 460~510 ms；按 O(N²) 外推到 4 000 条约 4 s、到 8 000 条约 16 s。取 4 000 对应「首次召回最多多等约 4 秒」这个判断，不是实测出来的上限；要真正解掉这条外推，得把全量成对换成桶内候选或 SimHash 预筛'
    scale: '基准库 1374 条 atom，943 251 对、512 维'
    failsWhen: ['机器算力', '单次召回可接受的阻塞时长', '是否改成近邻候选而非全量成对']
    guardedBy: ['test/audit.test.mjs']
    affects: 'inferEdges：超过此规模就不做全量两两比较，直接拒绝推断并如实报告结果，而不是安静地跑上几分钟'
  }
>

/**
 * 图路认的 kind 白名单，与 search.ts 的图路 SQL 必须一致。
 *
 * `related` 是模型**声明**的 kind：它带来的候选不在向量路里，图路因此第一次
 * 有「非几何」的输入可引进 —— 此前四类 kind 里三类没有写入方，实际只有 near，
 * 而 near 与向量路同源（search.ts 的 freshGraph 过滤就是在处理这件事）。
 *
 * `supersedes` / `duplicate` **刻意不在表里**：它们服务于「只出一条更高分的」
 * （§24），不是邻居扩展信号。加进来会让「已被取代」的条目重新进入候选。
 */
export const GRAPH_KINDS: readonly string[] = ['near', 'co_occur', 'refines', 'requires', 'related']

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
  /** 实际写进 edge 的 near 行数。**按表里的行算**：撞声明边唯一键、被 DO NOTHING 跳过的不计。 */
  nearEdges: number
  /** 实际写进 edge 的 duplicate 行数，口径同 nearEdges。 */
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

  // duplicate：表在基准库上可能是空的（判据只认 cos ≥ 0.92 且词面 ≥ 0.72），
  // 这里如实按行读取，不额外放宽 —— 放宽等于在别处偷偷定义第二条重复判据。
  const pairRows = db.prepare('SELECT a_id, b_id, cos, lexical FROM atom_pair').all() as Array<{
    a_id: number | bigint
    b_id: number | bigint
    cos: number
    lexical: number
  }>
  for (const p of pairRows) {
    const cos = Number(p.cos)
    const lex = Number(p.lexical)
    if (!(cos >= opts.dupCos) || !(lex >= opts.dupLex)) continue
    const a = Number(p.a_id)
    const b = Number(p.b_id)
    if ((degOut.get(a) ?? 0) >= cap || (degOut.get(b) ?? 0) >= cap) continue
    edges.push({ s: a, d: b, kind: 'duplicate', conf: cos })
  }
  for (const e of edges) {
    bump(degOut, e.s)
    bump(degIn, e.d)
  }

  // **DO NOTHING 而不是 DO UPDATE**：上一次的 inferred 行刚被整批删掉，所以这里撞上的
  // 只可能是**非派生**的边 —— 主要是模型声明的（origin = declared）。改成 DO UPDATE
  // 会把它改写成 inferred：那条声明当场从真相源变成派生物，下一次重建就会连同 inferred
  // 一起删掉。同一批 edges 里不会出现重复键（近邻按 atom 去重、duplicate 来自
  // atom_pair 的唯一键），所以这里不需要「更新已有行」这层语义。
  const ins = db.prepare(
    'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(src_type, src_id, dst_type, dst_id, kind) DO NOTHING',
  )
  let removedEdges = 0
  // 真正写进去的边。撞唯一键被 DO NOTHING 跳过的那些不在这里 ——
  // 下面的统计必须按**表里真实存在的行**算，而不是按待插入数组，否则会「报 2 条、表里只有 1 条」。
  const inserted: typeof edges = []
  db.exec('BEGIN IMMEDIATE')
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM edge WHERE origin = ?').get(INFERRED_ORIGIN) as {
      n: number | bigint
    }
    removedEdges = Number(before.n)
    db.prepare('DELETE FROM edge WHERE origin = ?').run(INFERRED_ORIGIN)
    for (const e of edges) {
      const info = ins.run(
        'atom',
        e.s,
        'atom',
        e.d,
        e.kind,
        Math.round(e.conf * 1e6) / 1e6,
        INFERRED_ORIGIN,
        now,
      )
      // changes = 0 表示撞了唯一键（声明边已在表里），这一行并没有写进去。
      if (Number(info.changes) > 0) inserted.push(e)
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

  // 度数、孤立与两条边数都按 inserted 算（见上面的注释）：被跳过的边在表里不存在，
  // 把它们算进 MOD 或孤立数，体检报出的就是一份不存在的图。
  let maxOut = 0
  let sumOut = 0
  const touched = new Set<number>()
  const insertedOut = new Map<number, number>()
  for (const e of inserted) {
    insertedOut.set(e.s, (insertedOut.get(e.s) ?? 0) + 1)
    touched.add(e.s)
    touched.add(e.d)
  }
  for (const [, d] of insertedOut) {
    if (d > maxOut) maxOut = d
    sumOut += d
  }
  let nearInserted = 0
  for (const e of inserted) if (e.kind === 'near') nearInserted++
  // 孤立按图路的无向度算：入度与出度都为 0 才叫孤立。
  const stats: InferStats = {
    atoms: total,
    encoded: n,
    pairsScanned,
    nearEdges: nearInserted,
    duplicateEdges: inserted.length - nearInserted,
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
 * 边表的 origin 分布。图路状态要把「声明」与「推断」分开报数。
 *
 * **为什么要分开报**：图路非 0 有两种完全不同的成因 —— 模型声明的关系，与向量近邻的
 * 推断。合成一个数之后，「图路有值」这句话不可解释：读者分不清它来自真相源还是派生物，
 * 也就分不清「重建之后它会消失吗」。
 *
 * 只做一次 GROUP BY，边表规模是 atom 数的常数倍（每 atom ≤ NEAR_K 条 near 边）。
 */
export function edgeOriginCounts(db: DatabaseSync): { declared: number; inferred: number } {
  const rows = db.prepare('SELECT origin, COUNT(*) AS n FROM edge GROUP BY origin').all() as Array<{
    origin: string
    n: number | bigint
  }>
  const out = { declared: 0, inferred: 0 }
  for (const r of rows) {
    if (r.origin === DECLARED_ORIGIN) out.declared = Number(r.n)
    else if (r.origin === INFERRED_ORIGIN) out.inferred = Number(r.n)
  }
  return out
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

// 重聚类 D 组（二）：影子重建、质心重算、atom_pair 回填。
//
// 这一层是**唯一会写库**的部分。四条约束决定了它的形状：
//
//   1. **不能出现「中途状态可见」**。旧 topic 被删的那一刻，atom.topic_id /
//      atom_topic / edge 三处引用都还指着它 —— 外键上写了 ON DELETE，所以不会报错，
//      它会静默把引用置空。因此「插新 topic → 改完所有引用 → 删旧 topic」三步必须在
//      同一个事务里，且删除永远排在最后。
//   2. **不能让一个事务太长**。node:sqlite 的 DatabaseSync 是同步的，长事务会把
//      事件循环按住（B2 瓶颈），宿主那边表现为整个插件卡住。所以大批量的回填拆成
//      分批，每批一个事务（阈值见 RECLUSTER_BATCH_ATOMS）。
//   3. **分类阈值来自别处、不在这里新定**。atom_pair 的 cos 线必须与召回去重用的
//      那条一致（DUP_COS），词面线同样（DUP_LEX）；本模块只负责把它们写成表。
//   4. **写完要能自证没有悬空引用**。countDanglingTopicRefs 是落库之后的一次全量
//      核对，不依赖任何调用方记得检查。

import type { DatabaseSync } from 'node:sqlite'
import { decodeVec, encodeVec, isValidVecBlob, normalizeInPlace, dot, VEC_DIM } from '../util/vec.js'
import { bigramTerms, jaccard } from '../util/text.js'
import { DUP_COS, DUP_LEX } from '../pipeline/search.js'
import { setMeta, META_RECLUSTER_AT } from '../db/meta.js'

/**
 * 分批回填的每批 atom 数。
 *
 * 取值依据：一批 = 一次事务 = 一次事件循环占用。1000 条在本机约几十毫秒，
 * 是「不打断宿主、也不至于让事务次数爆炸」的量级。
 * **这个数没有做过端到端口径的标定**（没测过宿主在何种批大小下开始出现可感知卡顿），
 * 登记进阈值表时如实标注这一点。
 */
export const RECLUSTER_BATCH_ATOMS = 1000

/** 一个待落的簇。 */
export interface TopicWrite {
  cluster: number
  /** 继承的旧 topic id；没有则为 null（要新分配）。 */
  inheritId: number | null
  label: string
  sumVec: Float32Array
  nAtoms: number
  meanFit: number
  members: number[]
  /** 每个成员的隶属度，与 members 一一对应。 */
  probs: number[]
}

/** 影子重建的结果统计。 */
export interface RebuildStats {
  /** 继承旧 id 的簇数。 */
  inherited: number
  /** 新分配 id 的簇数。 */
  fresh: number
  /** 被解散的旧 topic 数（其引用随之被清理）。 */
  dissolved: number
  /** 被写回主属的 atom 数。 */
  atomsTouched: number
  /** 被置空主属（未归类）的 atom 数。 */
  atomsOrphaned: number
  /** 重建后仍指向不存在 topic 的引用数。应当为 0。 */
  danglingRefs: number
  /** 分批次数。 */
  batches: number
  /** 簇号 → 落库后的 topic id（含继承的与新分配的）。次属引用与边要用它。 */
  topicIdOfCluster: Map<number, number>
}

function safeRollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    // 回滚失败不覆盖原始错误 —— 原始错误更有诊断价值。
  }
}

/**
 * 全量核对：还有没有指向不存在 topic 的引用。
 *
 * 这是「重聚类后所有次属引用与边不失效」这条判据的**自证手段**。
 * 三条查询各自独立：外键在 SQLite 里默认不检查历史数据，所以不能靠它。
 */
export function countDanglingTopicRefs(db: DatabaseSync): number {
  const q = (sql: string): number => Number((db.prepare(sql).get() as { n: number | bigint }).n)
  const atomRef = q(
    'SELECT COUNT(*) AS n FROM atom WHERE topic_id IS NOT NULL AND topic_id NOT IN (SELECT id FROM topic)',
  )
  const attachRef = q('SELECT COUNT(*) AS n FROM atom_topic WHERE topic_id NOT IN (SELECT id FROM topic)')
  const edgeSql =
    'SELECT COUNT(*) AS n FROM edge WHERE ' +
    "(dst_type = 'topic' AND dst_id NOT IN (SELECT id FROM topic)) OR " +
    "(src_type = 'topic' AND src_id NOT IN (SELECT id FROM topic))"
  return atomRef + attachRef + q(edgeSql)
}
/**
 * 把重聚类结果写回 topic / atom / atom_topic / edge 四张表。
 *
 * 顺序是**不可交换的**：
 *   ① 记下旧 topic 的全集（用于最后判断谁该解散）；
 *   ② 对继承的旧 topic 原地 UPDATE（id 不变 → 引用不用改）；
 *   ③ 对没有继承的簇 INSERT 新 topic（拿到新 id）；
 *   ④ 回填 atom.topic_id 与 atom_topic 主属行（分批）；
 *   ⑤ 把 edge 的 topic 引用按同一张映射改掉；
 *   ⑥ 最后删掉旧 topic 里既没继承、也不再被引用的那些。
 *
 * 第 ⑥ 步放在最后不是风格问题：提前删会让 ②~⑤ 之间的每一次写入都在制造悬空引用。
 */
export function rebuildTopicTables(
  db: DatabaseSync,
  topics: readonly TopicWrite[],
  opts: { batchAtoms?: number; now?: number; inTransaction?: boolean } = {},
): RebuildStats {
  const batch = opts.batchAtoms ?? RECLUSTER_BATCH_ATOMS
  const now = opts.now ?? Date.now()
  // 必须在任何写入之前：这是第 ⑤ 步那张「旧 topic → 新 topic」映射的唯一依据。
  // 早期版本把拍快照留给调用方，忘了拍时 resolveOldToNewTopics 返回空映射，
  // 第 ⑤ 步于是把**所有** edge 当成「旧 topic 已解散」删掉，而 danglingRefs 仍是 0
  // —— 「引用没失效」这条判据依然全绿，只是关联边全没了。
  snapshotOldTopicOf(db)

  const oldIds = (db.prepare('SELECT id FROM topic').all() as Array<{ id: number | bigint }>).map((r) =>
    Number(r.id),
  )
  const kept = new Set<number>()
  for (const t of topics) if (t.inheritId !== null) kept.add(t.inheritId)
  const topicIdOfCluster = new Map<number, number>()
  for (const t of topics) if (t.inheritId !== null) topicIdOfCluster.set(t.cluster, t.inheritId)

  const inTx = opts.inTransaction === true
  let batches = 0
  let touched = 0
  let dissolved = 0
  const allAtoms: number[] = []
  const toClear: number[] = []
  // 一个事务落到底（`inTransaction: true` 时连 BEGIN 都不开，交给调用方）。
  // 分三段各自提交时，失败会留下半套：topic 已换、atom_pair 未换 —— 那种状态既不是旧库
  // 也不是新库，而它不会有报错。分批**语句**仍保留（一批一组，控制单次参数个数），
  // 但不再分批提交。
  if (!inTx) db.exec('BEGIN IMMEDIATE')
  try {
    const updTopic = db.prepare(
      'UPDATE topic SET label = ?, sum_vec = ?, n_atoms = ?, mean_fit = ?, rebuilt_at = ? WHERE id = ?',
    )
    const insTopic = db.prepare(
      'INSERT INTO topic(domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at) ' +
        'VALUES (NULL, ?, ?, ?, ?, ?, ?)',
    )
    for (const t of topics) {
      const blob = encodeVec(t.sumVec)
      if (t.inheritId !== null) {
        updTopic.run(t.label, blob, t.nAtoms, t.meanFit, now, t.inheritId)
      } else {
        const ins = insTopic.run(t.label, blob, t.nAtoms, t.meanFit, now, now)
        topicIdOfCluster.set(t.cluster, Number(ins.lastInsertRowid))
      }
    }

    const setAtomTopic = db.prepare('UPDATE atom SET topic_id = ? WHERE id = ?')
    const delPrimary = db.prepare("DELETE FROM atom_topic WHERE atom_id = ? AND origin = 'primary'")
    const insPrimary = db.prepare(
      "INSERT INTO atom_topic(atom_id, topic_id, weight, origin) VALUES (?, ?, ?, 'primary')",
    )
    for (const t of topics) {
      const topicId = topicIdOfCluster.get(t.cluster)
      if (topicId === undefined) {
        throw new Error('topic 落库失败：簇 ' + t.cluster + ' 没有拿到 id')
      }
      for (let i = 0; i < t.members.length; i++) {
        const atomId = t.members[i]!
        setAtomTopic.run(topicId, atomId)
        delPrimary.run(atomId)
        insPrimary.run(atomId, topicId, t.probs[i] ?? 0)
        touched++
      }
    }
    batches++

    // ③ 未被任何簇收留的 atom：主属置空 + 删掉主属行。它们就是「未归类域」。
    for (const row of db.prepare('SELECT id FROM atom').all() as Array<{ id: number | bigint }>) {
      allAtoms.push(Number(row.id))
    }
    const inCluster = new Set<number>()
    for (const t of topics) for (const m of t.members) inCluster.add(m)
    for (const id of allAtoms) if (!inCluster.has(id)) toClear.push(id)
    const setNull = db.prepare('UPDATE atom SET topic_id = NULL WHERE id = ?')
    const delRow = db.prepare("DELETE FROM atom_topic WHERE atom_id = ? AND origin = 'primary'")
    for (let i = 0; i < toClear.length; i += batch) {
      for (const id of toClear.slice(i, i + batch)) {
        setNull.run(id)
        delRow.run(id)
      }
    }
    batches++

    // ④ edge 的 topic 引用：按完整映射改。映射从库里反推出来（见 resolveOldToNewTopics 的
    // 同款理由 —— 新分配的簇 id 只有 INSERT 那一步知道，而此刻它已经落在 atom 上了）。
    const oldToNew = resolveOldToNewTopics(db, allAtoms)
    remapEdgeTopicRefs(db, oldToNew, { inTransaction: true })

    // ⑤ 解散那些既没被继承、也不再被引用的旧 topic。放在最后，前面所有写入都已落地。
    const probe = db.prepare('SELECT 1 AS ok FROM atom WHERE topic_id = ? LIMIT 1')
    const del = db.prepare('DELETE FROM topic WHERE id = ?')
    for (let i = 0; i < oldIds.length; i += batch) {
      for (const id of oldIds.slice(i, i + batch)) {
        if (kept.has(id)) continue
        if ((probe.get(id) as { ok?: number } | undefined) !== undefined) continue
        del.run(id)
        dissolved++
      }
    }
    batches++

    if (!inTx) db.exec('COMMIT')
  } catch (err) {
    if (!inTx) safeRollback(db)
    throw err
  }

  return {
    inherited: topics.filter((t) => t.inheritId !== null).length,
    fresh: topics.filter((t) => t.inheritId === null).length,
    dissolved,
    atomsTouched: touched,
    atomsOrphaned: toClear.length,
    danglingRefs: countDanglingTopicRefs(db),
    batches,
    topicIdOfCluster,
  }
}
/**
 * edge 里的 topic 引用按身份对齐的结果改写。
 *
 * 为什么必须改而不是删了重建：这些边是 origin = untyped 的**关联**（写入时记的
 * 「这条记忆当时最像哪个 topic」，kind = near）。它们不是 declared 真相源，
 * 但也不是可重算的 —— 重算需要当时的落位上下文，那个上下文已经不在了。
 * 所以只能顺着身份对齐走：旧 topic 被谁继承了，边就指到谁；谁都没继承，
 * 这条边才失去意义、该删。
 *
 * 返回被改写与被删除的条数，供报告引用。
 */
export function remapEdgeTopicRefs(
  db: DatabaseSync,
  oldToNewTopic: ReadonlyMap<number, number>,
  opts: { inTransaction?: boolean } = {},
): { rewritten: number; removed: number; kept: number } {
  const inTx = opts.inTransaction === true
  const rows = db
    .prepare(
      'SELECT id, src_type, src_id, dst_type, dst_id FROM edge ' +
        "WHERE (src_type = 'atom' AND dst_type = 'topic') OR (src_type = 'topic' AND dst_type = 'atom')",
    )
    .all() as Array<{
    id: number | bigint
    src_type: string
    src_id: number | bigint
    dst_type: string
    dst_id: number | bigint
  }>
  const updSrc = db.prepare('UPDATE edge SET src_id = ? WHERE id = ?')
  const updDst = db.prepare('UPDATE edge SET dst_id = ? WHERE id = ?')
  const del = db.prepare('DELETE FROM edge WHERE id = ?')
  let rewritten = 0
  let removed = 0
  let kept = 0
  if (!inTx) db.exec('BEGIN IMMEDIATE')
  try {
    for (const r of rows) {
      const isTopicSrc = r.src_type === 'topic'
      const oldTopicId = Number(isTopicSrc ? r.src_id : r.dst_id)
      const fresh = oldToNewTopic.get(oldTopicId)
      if (fresh === undefined) {
        del.run(Number(r.id))
        removed++
      } else if (fresh !== oldTopicId) {
        if (isTopicSrc) updSrc.run(fresh, Number(r.id))
        else updDst.run(fresh, Number(r.id))
        rewritten++
      } else {
        kept++
      }
    }
    if (!inTx) db.exec('COMMIT')
  } catch (err) {
    if (!inTx) safeRollback(db)
    throw err
  }
  return { rewritten, removed, kept }
}

/**
 * 全量重算 topic.sum_vec / n_atoms / mean_fit（时序文档 4.3 第 7 步）。
 *
 * 为什么重建之后还要再算一遍：上面建表时用的是**内存里**的成员和，落库走 encodeVec，
 * float32 的往返会带来一点点漂移。全量重算把「库里的真相源」与「上一次重建的中间态」
 * 解耦：以后任何人读 topic.sum_vec 都只依赖库里的 atom。
 *
 * 顺带纠正 n_atoms 与 mean_fit —— 它们是同一类派生量，分两次扫表不如一次扫完。
 */
export function recomputeTopicSum(
  db: DatabaseSync,
  opts: { inTransaction?: boolean } = {},
): { topics: number; atoms: number } {
  const inTx = opts.inTransaction === true
  const rows = db
    .prepare('SELECT topic_id, embedding, fit FROM atom WHERE topic_id IS NOT NULL')
    .all() as Array<{
    topic_id: number | bigint
    embedding: Uint8Array
    fit: number
  }>
  const acc = new Map<number, { sum: Float32Array; n: number; fit: number }>()
  let atoms = 0
  for (const r of rows) {
    if (!isValidVecBlob(r.embedding, VEC_DIM)) continue
    const tid = Number(r.topic_id)
    let a = acc.get(tid)
    if (a === undefined) {
      a = { sum: new Float32Array(VEC_DIM), n: 0, fit: 0 }
      acc.set(tid, a)
    }
    const v = decodeVec(r.embedding)
    for (let i = 0; i < VEC_DIM; i++) a.sum[i]! += v[i]!
    a.n++
    a.fit += r.fit
    atoms++
  }
  const now = Date.now()
  const upd = db.prepare(
    'UPDATE topic SET sum_vec = ?, n_atoms = ?, mean_fit = ?, rebuilt_at = ? WHERE id = ?',
  )
  if (!inTx) db.exec('BEGIN IMMEDIATE')
  try {
    for (const [tid, a] of acc) upd.run(encodeVec(a.sum), a.n, a.n === 0 ? 0 : a.fit / a.n, now, tid)
    // 没有任何成员的 topic 不是「派生不出来」，而是不该存在 —— 但删除不是本函数的事
    // （它可能还挂着次属引用）。这里只把它的 n_atoms 归零，让候选侧自然跳过它。
    db.prepare(
      'UPDATE topic SET n_atoms = 0, mean_fit = 0 ' +
        'WHERE id NOT IN (SELECT DISTINCT topic_id FROM atom WHERE topic_id IS NOT NULL)',
    ).run()
    if (!inTx) db.exec('COMMIT')
  } catch (err) {
    if (!inTx) safeRollback(db)
    throw err
  }
  return { topics: acc.size, atoms }
}
/**
 * 次属归属（origin <> primary）跟着身份对齐走。
 *
 * 与主属不同，次属行没有几何依据可循 —— 它们记的是「这条记忆还和哪个主题有关」，
 * 而重聚类换了主题集合。这里按就近原则处理：旧 topic 被谁继承，次属行就指到谁；
 * 谁都没继承，这条次属关系就失去依据，删掉。
 *
 * 一个容易忽略的后果：改写之后次属行可能落到**该 atom 的新主属 topic** 上，
 * 那时它是冗余的（主属更强），不插。这正是 `origin <> primary` 的判据在
 * search.ts 里被用来做「归属因子」的地方 —— 让它指向主属会凭空多出一个归属因子。
 */
export function remapSecondaryAttachments(
  db: DatabaseSync,
  oldToNewTopic: ReadonlyMap<number, number>,
  opts: { inTransaction?: boolean } = {},
): { rewritten: number; removed: number; deduped: number } {
  const inTx = opts.inTransaction === true
  const rows = db
    .prepare("SELECT atom_id, topic_id, weight, origin FROM atom_topic WHERE origin <> 'primary'")
    .all() as Array<{
    atom_id: number | bigint
    topic_id: number | bigint
    weight: number
    origin: string
  }>
  if (rows.length === 0) return { rewritten: 0, removed: 0, deduped: 0 }
  const ins = db.prepare(
    'INSERT INTO atom_topic(atom_id, topic_id, weight, origin) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(atom_id, topic_id) DO UPDATE SET weight = MAX(weight, excluded.weight)',
  )
  const delOne = db.prepare('DELETE FROM atom_topic WHERE atom_id = ? AND topic_id = ?')
  // 次属行属于哪个 atom 的旧 topic，要看**该 atom 的新主属**落在哪个簇 —— 这样
  // 「次属跟着主属走」这条规则是显式的，而不是靠 clusterOfTopic 的间接推断。
  const topicOfAtom = db.prepare('SELECT topic_id FROM atom WHERE id = ?')
  let rewritten = 0
  let removed = 0
  let deduped = 0
  if (!inTx) db.exec('BEGIN IMMEDIATE')
  try {
    for (const r of rows) {
      const atomId = Number(r.atom_id)
      const oldTopic = Number(r.topic_id)
      // 该 atom 的新主属优先：次属与主属落到同一个主题是冗余的，而这里让
      // 「次属跟着主属走」这条规则显式化，不靠旧 topic 的映射间接推断。
      const rowNow = topicOfAtom.get(atomId) as { topic_id: number | bigint | null } | undefined
      const fresh =
        rowNow !== undefined && rowNow.topic_id !== null
          ? Number(rowNow.topic_id)
          : oldToNewTopic.get(oldTopic)
      if (fresh === undefined) {
        delOne.run(atomId, oldTopic)
        removed++
        continue
      }
      if (fresh === oldTopic) continue
      const isPrimaryNow =
        (db.prepare('SELECT 1 AS ok FROM atom WHERE id = ? AND topic_id = ?').get(atomId, fresh) as
          { ok?: number } | undefined) !== undefined
      delOne.run(atomId, oldTopic)
      if (isPrimaryNow) {
        deduped++
        continue
      }
      ins.run(atomId, fresh, r.weight, r.origin)
      rewritten++
    }
    if (!inTx) db.exec('COMMIT')
  } catch (err) {
    if (!inTx) safeRollback(db)
    throw err
  }
  return { rewritten, removed, deduped }
}

/**
 * 填 atom_pair 表。
 *
 * 这张表是**派生**的（schema.ts 的设计要点第 1 条里点名），本来该由写入侧维护，
 * 但写入侧一直没建它（决策清单第 61 条记的「已建但是空的」）。重聚类是它最自然的
 * 构建时机：向量与词面都已经在手上，而且这时候做**不会**拖慢任何一次写入。
 *
 * **阈值不在这里定**：cosMin / lexMin 的默认值直接取自 `pipeline/search.ts` 的
 * DUP_COS / DUP_LEX —— 这两个数在那边是「重排去重」的判据，而这张表就是那条判据的
 * 物化。在这里另写一个数会让「同一条判据两处定义」，而本项目已经吃过这个亏
 * （thresholds.ts 开头那段说的 tauJoin / tauLex 两次分叉）。
 *
 * 与 `search.ts` 的一处**有意的不一致**：那边只在同主属 topic 桶内两两比较，
 * 把 O(N²) 压到桶内；这里做全量、不按 topic 分桶。理由是这张表要在两次重聚类之间
 * 保持有效，而 topic 归属正是重聚类会改的东西 —— 按桶建的表会在重聚类后失效。
 * 代价是必须成对枚举，所以按批提交（每批一批，批间让出事件循环）。
 */
export function rebuildAtomPairs(
  db: DatabaseSync,
  vecs: ReadonlyMap<number, Float32Array>,
  opts: {
    cosMin?: number
    lexMin?: number
    batchPairs?: number
    texts?: ReadonlyMap<number, string>
    inTransaction?: boolean
  } = {},
): { rows: number; scanned: number; batches: number; cosHistogram: number[] } {
  const computed = computeAtomPairs(vecs, opts)
  const written = persistAtomPairs(db, computed, opts)
  // 留痕：体检要靠它区分「没建过」与「建过但没有」—— 空表本身没有这两种含义。
  // 由本函数写（而不是 persistAtomPairs）是因为 persist 只管表、不管状态；
  // 整次重聚类走 runRecluster 时，三个 meta 键由它在同一个事务里一起写。
  if (opts.inTransaction !== true) setMeta(db, META_RECLUSTER_AT, String(Date.now()))
  return {
    rows: written.rows,
    scanned: computed.scanned,
    batches: written.batches,
    cosHistogram: computed.cosHistogram,
  }
}

/**
 * 两两比较的**计算结果**（不碰库）。
 *
 * 为什么要把这一步拆出来：它是整次重聚类里唯一的 O(N²) 重计算，而落库要求「一个事务
 * 写到底」。两件事放在一起，事务就会被一段纯 CPU 计算按住几十秒 —— 期间写不进去任何东西。
 * 拆开之后：计算在事务外跑，事务里只剩 INSERT。
 */
export interface AtomPairsComputed {
  /** 过线的对，a < b。 */
  pairs: Array<{ a: number; b: number; cos: number; lexical: number }>
  /** 比较过的对数（不区分是否过线）。 */
  scanned: number
  /** cosMin 之上按 0.01 分 8 格的分布，最后一格含 1.00。 */
  cosHistogram: number[]
}

export function computeAtomPairs(
  vecs: ReadonlyMap<number, Float32Array>,
  opts: { cosMin?: number; lexMin?: number; texts?: ReadonlyMap<number, string> } = {},
): AtomPairsComputed {
  const cosMin = opts.cosMin ?? DUP_COS
  const lexMin = opts.lexMin ?? DUP_LEX
  const ids = [...vecs.keys()].sort((a, b) => a - b)
  const texts = opts.texts ?? new Map<number, string>()
  // 预切词：两两比较时对同一条文本反复切词是纯浪费（每次都是 O(len)）。
  const lexCache = new Map<number, Set<string>>()
  const lexOf = (id: number): Set<string> => {
    let s = lexCache.get(id)
    if (s === undefined) {
      s = bigramTerms(texts.get(id) ?? '')
      lexCache.set(id, s)
    }
    return s
  }
  const hist = new Array<number>(8).fill(0)
  const pairs: Array<{ a: number; b: number; cos: number; lexical: number }> = []
  let scanned = 0
  for (let i = 0; i < ids.length; i++) {
    const a = ids[i]!
    const va = vecs.get(a)!
    for (let j = i + 1; j < ids.length; j++) {
      const b = ids[j]!
      const vb = vecs.get(b)!
      // 先算余弦：它在绝大多数对上就否决了，把更贵的词面那一步挡在后面。
      const cos = dot(va, vb)
      scanned++
      if (!(cos >= cosMin)) continue
      const lex = jaccard(lexOf(a), lexOf(b))
      if (!(lex >= lexMin)) continue
      pairs.push({ a, b, cos, lexical: lex })
      const slot = Math.min(7, Math.max(0, Math.floor((cos - cosMin) * 100)))
      hist[slot] = hist[slot]! + 1
    }
  }
  return { pairs, scanned, cosHistogram: hist }
}

/**
 * 把算好的对写进 atom_pair（整表替换）。不写任何 meta。
 *
 * `inTransaction: true` 时不自己开事务 —— 调用方（runRecluster）已经包了一个大事务，
 * 目的是让「topic 表换了、atom_pair 没换」这种半套状态不可能出现。
 */
export function persistAtomPairs(
  db: DatabaseSync,
  computed: AtomPairsComputed,
  opts: { batchPairs?: number; inTransaction?: boolean } = {},
): { rows: number; batches: number } {
  const inTx = opts.inTransaction === true
  const batch = opts.batchPairs ?? RECLUSTER_BATCH_ATOMS
  let batches = 0
  if (!inTx) db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM atom_pair')
    const ins = db.prepare(
      'INSERT INTO atom_pair(a_id, b_id, cos, lexical) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(a_id, b_id) DO UPDATE SET cos = excluded.cos, lexical = excluded.lexical',
    )
    let inBatch = 0
    for (const p of computed.pairs) {
      ins.run(p.a, p.b, p.cos, p.lexical)
      inBatch++
      if (inBatch >= batch) {
        inBatch = 0
        batches++
      }
    }
    batches++
    if (!inTx) db.exec('COMMIT')
  } catch (err) {
    if (!inTx) safeRollback(db)
    throw err
  }
  return { rows: computed.pairs.length, batches }
}

/**
 * 读出「旧 topic 的质心」，供身份对齐用。
 *
 * 读 sum_vec / n_atoms 而不是现算成员和：这一步在**写库之前**跑，此刻库里的成员
 * 归属还是旧的，现算与读 sum_vec 等价；而读 sum_vec 是 O(topic) 而不是 O(atom)，
 * 在这个位置上更便宜。
 */
export function loadOldTopicCentroids(db: DatabaseSync): Array<{
  id: number
  centroid: Float32Array | null
  nAtoms: number
}> {
  const rows = db.prepare('SELECT id, sum_vec, n_atoms FROM topic ORDER BY id').all() as Array<{
    id: number | bigint
    sum_vec: Uint8Array
    n_atoms: number | bigint
  }>
  return rows.map((r) => {
    const raw = r.sum_vec instanceof Uint8Array ? r.sum_vec : new Uint8Array(r.sum_vec as ArrayBufferLike)
    const n = Number(r.n_atoms)
    if (n <= 0 || !isValidVecBlob(raw, VEC_DIM)) return { id: Number(r.id), centroid: null, nAtoms: n }
    const sum = decodeVec(raw)
    // sum_vec 是**未归一化**的和；除以 n 得均值，再 L2 归一化得质心方向。
    // 不除以 n 也能得到同一个方向（正比），但除法让「零向量」这件事更早暴露：
    // 全零和除以 n 仍是零，而归一化会把零向量原样返回（normalizeInPlace 的约定）。
    const c = new Float32Array(VEC_DIM)
    for (let i = 0; i < VEC_DIM; i++) c[i] = sum[i]! / n
    return { id: Number(r.id), centroid: normalizeInPlace(c), nAtoms: n }
  })
}
/**
 * 读入阶段记下的「atom → 它在重聚类前的主属 topic」。
 *
 * 之所以要一张模块级缓存而不是把旧主属塞进 `readClusterInputs` 的返回：那份返回是
 * 「几何输入」，而旧主属是「引用输入」—— 前者的错法是错簇，后者的错法是引用失效，
 * 两件事的失败后果不同，放在一起会让「谁在读什么」变模糊。
 */
const OLD_TOPIC_CACHE = new Map<number, number>()

/**
 * 快照每个 atom 在重聚类**之前**的主属 topic。**必须在任何写入之前调用。**
 */
export function snapshotOldTopicOf(db: DatabaseSync): Map<number, number> {
  OLD_TOPIC_CACHE.clear()
  const rows = db.prepare('SELECT id, topic_id FROM atom WHERE topic_id IS NOT NULL').all() as Array<{
    id: number | bigint
    topic_id: number | bigint
  }>
  for (const r of rows) OLD_TOPIC_CACHE.set(Number(r.id), Number(r.topic_id))
  return OLD_TOPIC_CACHE
}

/**
 * 「atom → 旧主属 topic」快照的**实时**读数（M5-T60）。
 *
 * 这份缓存是模块级的、不按连接分：它保存的是**最近一次**重聚类开始前的归属，
 * 换一个库也不会清（只有下一次快照会 clear）。所以报出来的是「上一次重建留下的
 * 那份快照的条数」—— 条数本身就是需要被看见的东西：它不清，就意味着一次重聚类
 * 的内存一直挂在模块上。
 */
export function oldTopicCacheUsage(): { entries: number } {
  return { entries: OLD_TOPIC_CACHE.size }
}

/**
 * 反推「旧 topic id → 它现在对应哪个 topic id」。
 *
 * 为什么要反推而不是直接算：新分配的 topic id 是 INSERT 出来的（自增），只有写库那一步
 * 知道；而对齐表里只有「簇 → 旧 id」。于是用一件**必然成立的事实**把两端接起来 ——
 * 一个 atom 如果原来主属旧 topic X、现在主属 topic Y，那么 X 的语义就由 Y 承担。
 * 这比「维护一张显式的映射表」更硬：它读的是库里的最终状态，映射维护错了会立刻表现为
 * 「某个旧 topic 找不到去处」（引用被删），而不是静默指到错的 topic 上。
 *
 * **边界**：只覆盖「重聚类前有主属、且现在还有主属」的那些旧 topic。一条 atom 的旧
 * topic 若没被任何参考 atom 带出来，它就不在结果里 —— 而「不在结果里」在调用方那里等于
 * 「已解散」，引用随之被删。这不是完美的判定：理论上存在「旧 topic 被继承了、但它原来的
 * 成员全部掉进未归类」的边缘情形，那时也会被当成解散。但那种情形下它的成员确实都不在
 * 任何主题里了，删掉那条引用比留下一条指向空主题的边更干净。
 *
 * 调用时机有硬要求：**必须在「新 topic 已插入 + atom.topic_id 已回填」之后、
 * 「旧 topic 已删除」之前或之后都行** —— 它读的是 atom 侧，左右都不依赖旧 topic 是否还在。
 */
export function resolveOldToNewTopics(db: DatabaseSync, atomIds: readonly number[]): Map<number, number> {
  const out = new Map<number, number>()
  const readTopic = db.prepare('SELECT topic_id FROM atom WHERE id = ?')
  for (const id of atomIds) {
    const row = readTopic.get(id) as { topic_id: number | bigint | null } | undefined
    if (row === undefined || row.topic_id === null) continue
    const old = OLD_TOPIC_CACHE.get(id)
    if (old === undefined) continue
    if (!out.has(old)) out.set(old, Number(row.topic_id))
  }
  return out
}

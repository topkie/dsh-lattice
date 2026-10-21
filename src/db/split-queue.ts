// 拆分队列：一张表（split_queue）同时承担两件事 ——
//   ① 「用户已确认应拆分」的清单（confirmed = 1）；
//   ② 「这条切成了几段」的映射（segments 有值）。
//
// 两件事共用一行，因为键都是 atom_id，生命周期也一样：这条记忆的拆分结论一旦给出，
// 段数提示就不再需要（确认时一起清掉，忽略时由调用方清）。
//
// 与旧实现的差别在**删除**：旧实现把两份清单都存在 meta 的 JSON 值里，删一条记忆只清
// atom 行 —— 清单里留下一个指向不存在 id 的死项，读的时候只能靠「过滤脏 id」兜。
// 现在 atom_id 是外键（ON DELETE CASCADE），删记忆时它的队列行**跟着消失**。
//
// FIFO 上限不在这里：两个上限（确认清单 32 条、段数映射 32 条）是写入侧的护栏，
// 由 pipeline/split.ts 用常量传参数给 prune*，避免这里的读函数与阈值互相依赖。

import type { DatabaseSync } from 'node:sqlite'

/** 段数 ≤ 1 表示「没切」，不是一份可展示的信息。 */
const SEGMENTS_MIN = 2

/**
 * 「用户已确认应拆分」的清单，**按确认先后升序**。
 *
 * 排序不是可选项：FIFO 淘汰依靠它，锚行提示也按它展示。同一毫秒确认的按 id 升序，
 * 保证同一份库在任何机器上读出同一个顺序。
 */
export function readConfirmedSplits(db: DatabaseSync): number[] {
  const rows = db
    .prepare('SELECT atom_id FROM split_queue WHERE confirmed = 1 ORDER BY added_at ASC, atom_id ASC')
    .all() as Array<{ atom_id: unknown }>
  const out: number[] = []
  for (const row of rows) {
    const id = Number(row.atom_id)
    if (Number.isInteger(id) && id > 0) out.push(id)
  }
  return out
}

/**
 * 「切分时共几段」的映射。
 *
 * 段数 ≤ 1 的项跳过 —— 那表示「没切」，不是一份可展示的信息。
 */
export function readPendingSegments(db: DatabaseSync): Map<number, number> {
  const out = new Map<number, number>()
  const rows = db
    .prepare('SELECT atom_id, segments FROM split_queue WHERE segments IS NOT NULL')
    .all() as Array<{ atom_id: unknown; segments: unknown }>
  for (const row of rows) {
    const id = Number(row.atom_id)
    const n = Number(row.segments)
    if (!Number.isInteger(id) || id <= 0) continue
    if (!Number.isInteger(n) || n < SEGMENTS_MIN) continue
    out.set(id, n)
  }
  return out
}

/**
 * 记下这条切成了几段。**同一个 id 再记一次就盖掉旧值并排到最后** ——
 * 那条记忆后来又被切了一次的话，新的段数才是它现在的样子，而排在最后意味着它离淘汰最远。
 *
 * `WHERE split_queue.confirmed = 0`：已经有确认结论的行不该再被写上段数提示。
 * 不加这个条件的后果是「确认过应拆分」的那一行突然又多了一份待打理的段数 ——
 * 界面上看起来像是同一个决定出现了两次。
 *
 * 不加事务：几段正文已经各自落库，段数只影响锚行一句提示的措辞。
 */
export function upsertSegments(db: DatabaseSync, atomId: number, segments: number, now = Date.now()): void {
  if (!Number.isInteger(atomId) || atomId <= 0) return
  if (!Number.isInteger(segments) || segments < SEGMENTS_MIN) return
  db.prepare(
    'INSERT INTO split_queue(atom_id, segments, confirmed, added_at) VALUES (?, ?, 0, ?) ' +
      'ON CONFLICT(atom_id) DO UPDATE SET segments = excluded.segments, added_at = excluded.added_at ' +
      'WHERE split_queue.confirmed = 0',
  ).run(atomId, segments, now)
}

/**
 * 这条已经有了人的结论，段数提示不会再出现，把这个值清掉。
 *
 * 清完后若这一行既没结论也没段数，整行删掉：留着是死数据，占着同一个上限，
 * 却没有任何人再读它。
 */
export function clearSegments(db: DatabaseSync, atomId: number): void {
  if (!Number.isInteger(atomId) || atomId <= 0) return
  db.prepare('UPDATE split_queue SET segments = NULL WHERE atom_id = ?').run(atomId)
  db.prepare('DELETE FROM split_queue WHERE atom_id = ? AND confirmed = 0 AND segments IS NULL').run(atomId)
}

/**
 * 记「用户确认应拆分」。返回**是否新进**清单（重复确认返回 false，且不改任何列）。
 *
 * 幂等靠一条 UPSERT 表达：已经在清单里的行，`added_at` 保持原值（CASE 里取旧值）——
 * 重复点按钮不该把它挪到队尾，那会让「最早确认的」这个淘汰顺序变成「最后点过的」。
 */
export function markConfirmed(db: DatabaseSync, atomId: number, now = Date.now()): boolean {
  if (!Number.isInteger(atomId) || atomId <= 0) return false
  const row = db.prepare('SELECT confirmed FROM split_queue WHERE atom_id = ?').get(atomId) as
    { confirmed: unknown } | undefined
  const already = row !== undefined && Number(row.confirmed) === 1
  db.prepare(
    'INSERT INTO split_queue(atom_id, segments, confirmed, added_at) VALUES (?, NULL, 1, ?) ' +
      'ON CONFLICT(atom_id) DO UPDATE SET segments = NULL, confirmed = 1, ' +
      'added_at = CASE WHEN split_queue.confirmed = 1 THEN split_queue.added_at ELSE excluded.added_at END',
  ).run(atomId, now)
  return !already
}

function prune(db: DatabaseSync, where: string, keep: number, orderBy: string): number {
  const limit = Number.isInteger(keep) && keep > 0 ? keep : 0
  const rows = db
    .prepare('SELECT atom_id FROM split_queue WHERE ' + where + ' ORDER BY ' + orderBy)
    .all() as Array<{ atom_id: unknown }>
  const excess = rows.length - limit
  if (excess <= 0) return 0
  const drop = rows.slice(limit).map((r) => Number(r.atom_id))
  const stmt = db.prepare('DELETE FROM split_queue WHERE atom_id = ?')
  for (const id of drop) stmt.run(id)
  return drop.length
}

/**
 * 确认清单的 FIFO 淘汰：只留**最近确认的 keep 条**，返回删掉了几行。
 *
 * 参数由调用方给（`SPLIT_CONFIRMED_MAX`）—— 上限是写入侧的护栏，属于阈值登记的范围，
 * 不属于这张表的定义。
 */
export function pruneConfirmed(db: DatabaseSync, keep: number): number {
  return prune(db, 'confirmed = 1', keep, 'added_at DESC, atom_id DESC')
}

/** 段数映射的 FIFO 淘汰：只留最近记录的 keep 条，返回删掉了几行。同 pruneConfirmed。 */
export function pruneSegments(db: DatabaseSync, keep: number): number {
  return prune(db, 'segments IS NOT NULL', keep, 'added_at DESC, atom_id DESC')
}

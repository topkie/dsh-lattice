// 重聚类的进度：计划时间、开始时间、上次成功时间。
//
// **为什么是三列而不是一个状态字段**：三列各自回答一个问题 ——
//   planned_at 有值   → 有人点过「开始整理」，且它还没跑完；
//   started_at 有值   → 那次执行**开始过**（开始过却还留着，说明它没成功）；
//   completed_at 有值 → 上一次成功的时间（跑完才写，与主数据同一个事务）。
// 合成一个枚举字段会让「失败」与「正在跑」在库里长得一模一样，只能靠进程内状态区分。
//
// 三列在同一行，所以「清 planned 与 started」是一次 UPDATE：旧实现是三次独立的键删除，
// 中间任何一次失败都会留下「计划已取消、但 started 还在」这种库内自相矛盾的状态。

import type { DatabaseSync } from 'node:sqlite'

export interface ReclusterTimes {
  plannedAt: number | null
  startedAt: number | null
  completedAt: number | null
}

interface Row {
  planned_at: unknown
  started_at: unknown
  completed_at: unknown
}

function stampOf(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 读三个时间戳。纯读，不写库；没有这一行时三列都是 null。 */
export function readReclusterTimes(db: DatabaseSync): ReclusterTimes {
  const row = db
    .prepare('SELECT planned_at, started_at, completed_at FROM recluster_state WHERE id = 1')
    .get() as Row | undefined
  if (row === undefined) return { plannedAt: null, startedAt: null, completedAt: null }
  return {
    plannedAt: stampOf(row.planned_at),
    startedAt: stampOf(row.started_at),
    completedAt: stampOf(row.completed_at),
  }
}

function setColumn(
  db: DatabaseSync,
  column: 'planned_at' | 'started_at' | 'completed_at',
  at: number | null,
): void {
  db.prepare(
    'INSERT INTO recluster_state(id, ' +
      column +
      ') VALUES (1, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET ' +
      column +
      ' = excluded.' +
      column,
  ).run(at)
}

export function setReclusterPlanned(db: DatabaseSync, at: number): void {
  setColumn(db, 'planned_at', at)
}

export function clearReclusterPlanned(db: DatabaseSync): void {
  setColumn(db, 'planned_at', null)
}

export function setReclusterStarted(db: DatabaseSync, at: number): void {
  setColumn(db, 'started_at', at)
}

export function clearReclusterStarted(db: DatabaseSync): void {
  setColumn(db, 'started_at', null)
}

/** 记一次成功。与主数据在同一个事务里写（见 cluster/rebuild 的 onCommit）。 */
export function setReclusterCompleted(db: DatabaseSync, at: number): void {
  setColumn(db, 'completed_at', at)
}

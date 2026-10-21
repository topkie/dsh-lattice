// 重标（判 S）的进度：上次判过的时间与上次失败的原因码。
//
// 两列各管一件事，而且**它们的时间线不一样**：last_check_at 只在「算成功」后写，
// last_error 只在失败时写且成功不清 —— 于是「上次成功很久以前、最近一直失败」这种
// 状态在库里能同时被看到。分成两个键时这一点靠调用方自觉，现在是表结构本身的性质。

import type { DatabaseSync } from 'node:sqlite'

export interface CalibState {
  /** 上次判 S 的时间（epoch 毫秒）；null 表示从未判过。 */
  lastCheckAt: number | null
  /** 上次失败的原因码；null 表示上次没失败或从未失败过。 */
  lastError: string | null
}

interface Row {
  last_check_at: unknown
  last_error: unknown
}

export function readCalibState(db: DatabaseSync): CalibState {
  const row = db.prepare('SELECT last_check_at, last_error FROM calib_state WHERE id = 1').get() as
    Row | undefined
  if (row === undefined) return { lastCheckAt: null, lastError: null }
  const at = Number(row.last_check_at)
  return {
    lastCheckAt: Number.isFinite(at) && at > 0 ? at : null,
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
  }
}

/** 记「判过 S」。**只在算成功之后调用** —— 失败也记的话，一次算不出会换来一个冷却期。 */
export function setCalibLastCheck(db: DatabaseSync, at: number): void {
  db.prepare(
    'INSERT INTO calib_state(id, last_check_at) VALUES (1, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET last_check_at = excluded.last_check_at',
  ).run(at)
}

/** 记失败原因码。**不清 last_check_at**：失败不改变「上次判过」这个事实。 */
export function setCalibLastError(db: DatabaseSync, code: string): void {
  db.prepare(
    'INSERT INTO calib_state(id, last_error) VALUES (1, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error',
  ).run(code)
}

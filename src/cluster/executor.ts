// 整理入口的执行器（T47）：规划、取消、一次性执行、启动恢复，以及四态的判定。
//
// 为什么单独一个文件：`cluster/index.ts` 是纯计算（不碰定时器、不碰进程状态），
// 而「推迟几秒再跑」「进程重启后补跑」都是进程级的东西。混进去会让那个模块带上宿主生命周期，
// 而它现在是能脱离宿主单跑的（探针与用例都直接调它）。
//
// **四态为什么不能只看库**：`planned` 有值 + `started` 有值，在库里有两种含义 ——
// 「正在跑」与「上次跑失败了」。区分它们需要一个进程内的标志（executing）。
// 本插件是单进程单实例，这个假设成立；多实例部署时这条要重写。

import type { DatabaseSync } from 'node:sqlite'
import {
  META_RECLUSTER_AT,
  META_RECLUSTER_PLANNED_AT,
  META_RECLUSTER_STARTED_AT,
  deleteMeta,
  getMeta,
  setMeta,
} from '../db/meta.js'
import { reasonCodeOf } from '../log/policy.js'
import { runRecluster, type ReclusterResult } from './index.js'

/**
 * 规划之后等多久才真的开跑（毫秒）。
 *
 * 为什么要有这段等待：整理是一次会重排全库主题的动作，点错了要能立刻撤。等几秒的窗口
 * 里「取消」是有效的，之后就只能等它跑完。3 秒是产品口味，不是标定值 —— 太长显得没反应，
 * 太短来不及取消。
 */
export const RECLUSTER_PLAN_DELAY_MS = 3000

/** 整理入口的四种状态。语句取自裁决：未规划 / 已规划 / 正在整理 / 失败可重试。 */
export type ReclusterPhase = 'idle' | 'planned' | 'running' | 'failed'

export interface ReclusterState {
  phase: ReclusterPhase
  /** 计划时间；null 表示没规划过。 */
  plannedAt: number | null
  /** 上一次执行开始的时间；与 plannedAt 同时有值且不在跑，就是「失败可重试」。 */
  startedAt: number | null
  /** 上一次成功的时间（`recluster_at`）；null 表示从未跑成功过。 */
  lastAt: number | null
}

/** 进程内「正在跑」标志。**只有它能把 running 与 failed 分开**，库里两者同形。 */
let executing = false

/** 挂着的延迟句柄。取消与关停都要清掉它。 */
let timer: ReturnType<typeof setTimeout> | null = null

function stampOf(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 读四态。纯读，不写库。 */
export function readReclusterState(db: DatabaseSync): ReclusterState {
  const plannedAt = stampOf(getMeta(db, META_RECLUSTER_PLANNED_AT))
  const startedAt = stampOf(getMeta(db, META_RECLUSTER_STARTED_AT))
  const lastAt = stampOf(getMeta(db, META_RECLUSTER_AT))
  let phase: ReclusterPhase = 'idle'
  if (executing) phase = 'running'
  else if (plannedAt !== null && startedAt !== null) phase = 'failed'
  else if (plannedAt !== null) phase = 'planned'
  return { phase, plannedAt, startedAt, lastAt }
}

/** 清掉挂着的延迟。不写库（那是 cancelRecluster 的事）。 */
export function clearPlanTimer(): void {
  if (timer === null) return
  clearTimeout(timer)
  timer = null
}

/**
 * 规划一次整理：写 `planned_at`，挂一个一次性延迟，到点调 `run`。
 *
 * 重新规划会**清掉上一次的 started 痕迹**：那是一次作废的执行，留着会让新计划一出生
 * 就显示成「失败」。
 *
 * `unref()`：这个定时器不该拖着进程退出。
 */
export function planRecluster(
  db: DatabaseSync,
  run: () => void,
  delayMs = RECLUSTER_PLAN_DELAY_MS,
): ReclusterState {
  setMeta(db, META_RECLUSTER_PLANNED_AT, String(Date.now()))
  deleteMeta(db, META_RECLUSTER_STARTED_AT)
  clearPlanTimer()
  const handle = setTimeout(() => {
    timer = null
    run()
  }, delayMs)
  handle.unref?.()
  timer = handle
  return readReclusterState(db)
}

export type CancelResult =
  { ok: true; state: ReclusterState } | { ok: false; reason: 'running' | 'not-planned' }

export type ExecuteOutcome = {
  ok: boolean
  /** 没有可执行的计划（从未规划，或已经跑完）。 */
  skipped: boolean
  result?: ReclusterResult
  /** 失败原因码（错误类名 / 错误码），**不含消息** —— 消息可能带路径。 */
  reason?: string
}

/**
 * 取消一次计划。
 *
 * **执行中一律拒绝**：取消只对「已规划未开始」有意义。接受它等于「取消失败但
 * 按钮不说」；而尽力中断要把回滚路径重新验一遍，回滚正是这一波最大的风险点。
 */
export function cancelRecluster(db: DatabaseSync): CancelResult {
  if (executing) return { ok: false, reason: 'running' }
  if (getMeta(db, META_RECLUSTER_PLANNED_AT) === undefined) return { ok: false, reason: 'not-planned' }
  clearPlanTimer()
  deleteMeta(db, META_RECLUSTER_PLANNED_AT)
  deleteMeta(db, META_RECLUSTER_STARTED_AT)
  return { ok: true, state: readReclusterState(db) }
}

/**
 * 按现有的计划跑一次。
 *
 * 成功时才清 `planned` 与 `started` —— 在 `runRecluster` 的 `onCommit` 里清，也就是与
 * 主题表、atom_pair 的改动**同一个事务**。失败时两者都留着，状态于是成为「失败可重试」。
 */
export async function executePlannedRecluster(db: DatabaseSync): Promise<ExecuteOutcome> {
  if (executing) return { ok: false, skipped: true }
  if (getMeta(db, META_RECLUSTER_PLANNED_AT) === undefined) return { ok: true, skipped: true }
  executing = true
  setMeta(db, META_RECLUSTER_STARTED_AT, String(Date.now()))
  // 让出一次事件循环（**在事务外，安全**）：界面点刷新时要能读到「正在整理」。
  // 不留这个空隙的话，整段执行是同步的 —— 请求会被挡住一秒多，用户看到的是「点了没反应，
  // 然后突然变好」，四态里的「正在整理」形同不存在。
  // 这个 0ms 定时器**不 unref**：它是这次执行的一部分，unref 之后若没有别的待处理项，
  // 进程会直接退出，这个 Promise 永远不 resolve。
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  try {
    const result = await runRecluster(db, {
      onCommit: () => {
        deleteMeta(db, META_RECLUSTER_PLANNED_AT)
        deleteMeta(db, META_RECLUSTER_STARTED_AT)
      },
    })
    return { ok: true, skipped: false, result }
  } catch (err) {
    return { ok: false, skipped: false, reason: reasonCodeOf(err) }
  } finally {
    executing = false
  }
}

/** 有没有待执行的计划。启动补跑先问这一句，避免为一个「没有」去开户。 */
export function hasPendingPlan(db: DatabaseSync): boolean {
  return getMeta(db, META_RECLUSTER_PLANNED_AT) !== undefined
}

/**
 * 启动时补跑：上次规划过但没跑完的，直接跑一次。
 *
 * 判据是「`planned` 有值」而不是「某个时间是否过期」—— **不依赖时钟**。
 * 进程崩溃、断电、用户关窗口，都会留下同一个痕迹：有计划、没成功。
 */
export async function resumeIfPending(db: DatabaseSync): Promise<ExecuteOutcome> {
  return executePlannedRecluster(db)
}

/** 当前是否正在跑。给路由与用例用。 */
export function isExecuting(): boolean {
  return executing
}

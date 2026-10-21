// 拆分候选的「人的决定」：确认与忽略（T29）。
//
// 候选从哪来：写入时按长度切分（write.ts 的 writeReviewed），切出来的每一段都置
// `atom.flags` 的 bit0。**这个位说的是「切点按长度定的，没有按内容判断过」**，
// 不是「这条一定该拆」—— 一条 601 字、只讲一件事的文本同样会被标上。
//
// 两个动作都清 bit0、都写一条日志（log.info），差别在有没有状态：
//   确认 → 另记一条状态（split_queue 里一行，confirmed = 1），下次召回命中这条时锚行提示
//          「用户已确认应拆分」，并说明下一步（按内容重写、声明 supersedes）。
//   忽略 → 没有状态、没有待办、不改变任何召回行为。
//
// **为什么两个动作都要日志**：日志回答「发生过」，表回答「当前状态」。而清单
// 是 FIFO 的 —— 被挤出去的那一条在状态里不留任何痕迹，「它被确认过」这句话就只剩
// 日志能回答。「留痕（日志）」说的是这件事，表只是顺带有了状态。
//
// **两者都不执行拆分**：不改正文、不改条数、不迁移入口与边。执行拆分要动
// 入口 / 边 / topic 归属，设计里没有定义，留给后续任务。
//
// 状态存在 split_queue 表（一条记忆一行，键是 atom_id）：它是外键，删记忆时队列行跟着
// 消失，不必在读的时候过滤脏 id。两份清单（确认结论、段数）共用一行 —— 键与生命周期
// 都一致。上限与 FIFO 淘汰见 SPLIT_CONFIRMED_MAX / SPLIT_SEGMENTS_MAX。

import type { DatabaseSync } from 'node:sqlite'
import type { ThresholdValue } from '../threshold-types.js'
import {
  clearSegments,
  markConfirmed,
  pruneConfirmed,
  pruneSegments,
  readConfirmedSplits,
  readPendingSegments,
  upsertSegments,
} from '../db/split-queue.js'
import { log } from '../log/index.js'
import { FLAG_SPLIT_PENDING } from '../db/flags.js'

/**
 * 「用户已确认应拆分」清单的条数上限（FIFO：满了淘汰最早的那条）。
 *
 * 32 不是标定值，是护栏：这份清单只用来在召回时给锚行加一句提示，而一次召回最多展示
 * 二十几条锚。清单比锚段还长时，多出来的部分对任何一次召回都没有影响，却会让 meta 的
 * 值无限增长。淘汰方向选「最早确认的」：越靠近现在的决定越可能还在被处理。
 */
export const SPLIT_CONFIRMED_MAX = 32 satisfies ThresholdValue<
  'chosen',
  {
    area: '写入'
    why: '未标定，是护栏：一次召回最多展示二十几条锚，清单比锚段还长时多出来的部分对任何一次召回都没有影响，却会让这张表无限增长'
    failsWhen: ['锚段条数（topN 与实际预算）', '用户对候选的处理速度']
    guardedBy: ['test/split-pending.test.mjs']
    affects: '「用户已确认应拆分」清单的条数上限（split_queue 里 confirmed = 1 的行，FIFO 淘汰最早的一条）。满了只影响更早的确认还能不能出现在锚行提示里，不改变任何召回与写入行为'
  }
>

/**
 * 「切分时共几段」这张表的条数上限（FIFO，与 SPLIT_CONFIRMED_MAX 同口径）。
 *
 * 一次写入最多切 REVIEW_MAX_SEGMENTS 段（8），所以这个上限容得下四次切分写入；
 * 超出的部分对任何一次召回都没有影响（一次最多展示二十几条锚），留着只让这张表涨。
 */
export const SPLIT_SEGMENTS_MAX = 32 satisfies ThresholdValue<
  'chosen',
  {
    area: '写入'
    why: '未标定，是护栏：一次写入最多切 8 段，这个上限容得下四次切分写入；比锚段还长时多出来的部分对召回没有影响，设它是为了让这张表不无限增长'
    failsWhen: ['一次写入的切分段数上限（REVIEW_MAX_SEGMENTS）', '锚段条数（topN 与实际预算）']
    affects: '「切分时共几段」映射的条数上限（split_queue 里 segments 有值的行，FIFO）。满了只影响更早的候选还能不能显示段数，段数未知时锚行退回不带段数的固定串'
  }
>

/** 一次确认 / 忽略之后的状态。`changed=false` 表示位本来就清了（幂等，不是错误）。 */
export interface SplitDecision {
  atomId: number
  /** 处理完之后整行的 flags（其它位原样保留）。 */
  flags: number
  /** 本次是否真的改了 flags。 */
  changed: boolean
  /** 确认之后的清单（按确认先后，最早的在最前）；忽略时不带。 */
  confirmed?: number[]
}

/**
 * 读「用户已确认应拆分」的清单（按确认先后升序）与「切分时共几段」的映射。
 *
 * 实现在 db/split-queue.ts；这里只做转发，因为读取入口一直是 pipeline/split.ts ——
 * search.ts 与测试都从这里取，改动它们没有好处。
 *
 * 旧实现的坏值容错（不是 JSON、元素形状不对就整份按空处理）不再需要：值不再是一整份
 * 可损坏的 JSON，坏行只影响它自己那一行。
 */
export { readConfirmedSplits, readPendingSegments }
/**
 * 记下这次切分的段数：**每一段各记一行**，值都是同一个数。
 *
 * 同一个 id 再次被记时盖掉旧值并排到最后：这条记忆后来又被切过一次的话，新的段数才是
 * 它现在的样子；排在最后也意味着它离淘汰最远。
 *
 * 不加事务：几段正文已经各自落库，段数只影响一句提示。丢了这个数，锚行退回不带段数的
 * 固定串 —— 少一句信息，但召回不失败。
 */
export function recordPendingSegments(
  db: DatabaseSync,
  atomIds: readonly number[],
  segments: number,
  now = Date.now(),
): void {
  if (!Number.isInteger(segments) || segments <= 1) return
  if (atomIds.length === 0) return
  for (const id of atomIds) upsertSegments(db, id, segments, now)
  pruneSegments(db, SPLIT_SEGMENTS_MAX)
}

/**
 * 这条已经有了人的结论（确认或忽略），段数提示不会再出现，把这个值清掉。
 *
 * 清完若这一行既没结论也没段数，整行就删掉 —— 留着是死数据，占着同一个上限，
 * 却没有任何人再读它。
 */
function dropPendingSegments(db: DatabaseSync, atomId: number): void {
  clearSegments(db, atomId)
}

interface ClearResult {
  flags: number
  changed: boolean
}

/**
 * 清掉 bit0。返回 null 表示这个 id 不在库里（路由据此回 404）。
 *
 * **不更新 `updated_at`**：那一列记的是内容变更；确认 / 忽略改的是「人做过的判断」，
 * 不是内容。与 archive.ts 同一条理由 —— 混用会让「最近改过的记忆」多出一批只是被
 * 点过按钮的条目。
 */
function clearSplitPending(db: DatabaseSync, atomId: number): ClearResult | null {
  const row = db.prepare('SELECT flags FROM atom WHERE id = ?').get(atomId) as
    { flags: number | bigint | null } | undefined
  if (row === undefined) return null
  const before = row.flags === null || row.flags === undefined ? 0 : Number(row.flags)
  if ((before & FLAG_SPLIT_PENDING) === 0) return { flags: before, changed: false }
  const after = before & ~FLAG_SPLIT_PENDING
  db.prepare('UPDATE atom SET flags = ? WHERE id = ?').run(after, atomId)
  return { flags: after, changed: true }
}

/**
 * 确认「这一条应当拆分」：清 bit0，并把这条记进 split_queue 的确认清单。
 *
 * 两步（flags 与队列行）放在同一个事务里：只清位不记账，用户确认过这件事就丢了；
 * 只记账不清位，界面会一直显示同一条候选。两者都是**没有报错**的失败形态。
 *
 * 幂等：重复确认不重复记账、不重复写库，只把 `changed` 说成 false。
 *
 * 日志在**提交之后**写：回滚掉的那一次确认不算「发生过」。淘汰条数也在这里报 ——
 * 淘汰发生在事务里，但只有提交成功它才真的生效。
 */
export function confirmSplit(db: DatabaseSync, atomId: number, now = Date.now()): SplitDecision | null {
  if (!Number.isInteger(atomId) || atomId <= 0) throw new Error('atom_id 必须是正整数')
  const exists = db.prepare('SELECT 1 AS ok FROM atom WHERE id = ?').get(atomId)
  if (exists === undefined) return null

  let flags = 0
  let changed = false
  /** 这一条是否**新进了**清单。与 `changed`（位有没有变）是两件事，留痕取两者的并集。 */
  let recorded = false
  /** 本次被 FIFO 挤掉的条数。 */
  let evicted = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    const cleared = clearSplitPending(db, atomId)!
    flags = cleared.flags
    changed = cleared.changed
    // 一行 UPSERT 同时做两件事：进清单、清段数。旧实现要把整份 JSON 读出来、改、再写回，
    // 于是「清单」与「段数」这两份状态各有一次整份覆写的机会互相踩。
    recorded = markConfirmed(db, atomId, now)
    evicted = pruneConfirmed(db, SPLIT_CONFIRMED_MAX)
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败不覆盖原始错误 */
    }
    throw err
  }
  // 位被清掉、或新进了清单，都算「用户确认过一次」；两者都没有（重复点）就不写。
  if (changed || recorded) log.info('split.confirmed')
  if (evicted > 0) log.info('split.evicted', { evicted })
  return { atomId, flags, changed: changed || recorded, confirmed: readConfirmedSplits(db) }
}

/**
 * 忽略这条候选：只清 bit0，写一条日志留痕。
 *
 * **不记账**：忽略的意思是「这条不用管」，把它记进状态清单等于把「管过了」再存一份，
 * 而下次召回又会因为清单里没有它而不提示 —— 两份状态说的是同一件事，没有必要。
 * 日志只记「发生过」：atom id 不进日志（见 log/policy.ts 的白名单，id 与正文都不落库）。
 */
export function ignoreSplit(db: DatabaseSync, atomId: number): SplitDecision | null {
  if (!Number.isInteger(atomId) || atomId <= 0) throw new Error('atom_id 必须是正整数')
  const cleared = clearSplitPending(db, atomId)
  if (cleared === null) return null
  if (cleared.changed) log.info('split.ignored')
  // 不包事务：位已经清了，这一步只是删一条不会再被读到的提示数据。
  dropPendingSegments(db, atomId)
  return { atomId, flags: cleared.flags, changed: cleared.changed }
}

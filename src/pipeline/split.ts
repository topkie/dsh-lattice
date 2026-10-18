// 拆分候选的「人的决定」：确认与忽略（T29）。
//
// 候选从哪来：写入时按长度切分（write.ts 的 writeReviewed），切出来的每一段都置
// `atom.flags` 的 bit0。**这个位说的是「切点按长度定的，没有按内容判断过」**，
// 不是「这条一定该拆」—— 一条 601 字、只讲一件事的文本同样会被标上。
//
// 两个动作都清 bit0，差别只有一处：
//   确认 → 另记一条状态（meta 的 split_confirmed），下次召回命中这条时锚行提示
//          「用户已确认应拆分」，并说明下一步（按内容重写、声明 supersedes）。
//   忽略 → 只写一条日志（log.info），没有状态、没有待办、不改变任何召回行为。
//
// **两者都不执行拆分**（裁决 #42）：不改正文、不改条数、不迁移入口与边。执行拆分要动
// 入口 / 边 / topic 归属，设计里没有定义，留给后续任务。
//
// 为什么确认状态放在 meta 表而不是新表：它是一份「人做过的决定」的清单，没有查询维度、
// 不需要索引，也不需要与 atom 行同生命周期；加一张表就要一次迁移，而本任务的硬约束是
// 不升 user_version（现为 4）。上限与 FIFO 淘汰见 SPLIT_CONFIRMED_MAX。

import type { DatabaseSync } from 'node:sqlite'
import { META_SPLIT_CONFIRMED, getMeta, setMeta } from '../db/meta.js'
import { log } from '../log/index.js'
import { FLAG_SPLIT_PENDING } from '../db/flags.js'

/**
 * 「用户已确认应拆分」清单的条数上限（FIFO：满了淘汰最早的那条）。
 *
 * 32 不是标定值，是护栏：这份清单只用来在召回时给锚行加一句提示，而一次召回最多展示
 * 二十几条锚。清单比锚段还长时，多出来的部分对任何一次召回都没有影响，却会让 meta 的
 * 值无限增长。淘汰方向选「最早确认的」：越靠近现在的决定越可能还在被处理。
 */
export const SPLIT_CONFIRMED_MAX = 32

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
 * 读确认清单。
 *
 * 值坏了（不是 JSON、不是数组、元素不是正整数）时按空清单处理：这份清单只影响一句
 * 提示，为它抛错会让整次召回失败 —— 那比少一句提示重得多。
 */
export function readConfirmedSplits(db: DatabaseSync): number[] {
  const raw = getMeta(db, META_SPLIT_CONFIRMED)
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: number[] = []
  for (const v of parsed) {
    const id = Number(v)
    if (Number.isInteger(id) && id > 0) out.push(id)
  }
  return out
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
 * 确认「这一条应当拆分」：清 bit0，并把这条记进 meta 的确认清单。
 *
 * 两步（flags 与 meta）放在同一个事务里：只清位不记账，用户确认过这件事就丢了；
 * 只记账不清位，界面会一直显示同一条候选。两者都是**没有报错**的失败形态。
 *
 * 幂等：重复确认不重复记账、不重复写库，只把 `changed` 说成 false。
 */
export function confirmSplit(db: DatabaseSync, atomId: number, now = Date.now()): SplitDecision | null {
  if (!Number.isInteger(atomId) || atomId <= 0) throw new Error('atom_id 必须是正整数')
  const exists = db.prepare('SELECT 1 AS ok FROM atom WHERE id = ?').get(atomId)
  if (exists === undefined) return null

  const confirmed = readConfirmedSplits(db)
  const already = confirmed.includes(atomId)
  let flags = 0
  let changed = false
  db.exec('BEGIN IMMEDIATE')
  try {
    const cleared = clearSplitPending(db, atomId)!
    flags = cleared.flags
    changed = cleared.changed
    if (!already) {
      confirmed.push(atomId)
      while (confirmed.length > SPLIT_CONFIRMED_MAX) confirmed.shift()
      setMeta(db, META_SPLIT_CONFIRMED, JSON.stringify(confirmed), now)
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败不覆盖原始错误 */
    }
    throw err
  }
  return { atomId, flags, changed: changed || !already, confirmed }
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
  return { atomId, flags: cleared.flags, changed: cleared.changed }
}

// 归档：让一条记忆「默认不召回」，但不删除它。
//
// 这套机制与删除（forget.ts）**是两件事，不要合并**：
//   删除 = 物理删除 + 墓碑 + 防写回；内容不在库里，也回不来。
//   归档 = 只改 atom.flags 的 bit4；内容、向量、入口、关系边全都还在，取消归档即恢复可见。
//
// 为什么没有单独的归档表、也不做迁移：`atom.flags` 列与 bit4 都在设计文档里命名过，
// 列已存在，补位不动任何历史行的解释（旧行的 0 就是「没归档」）。
//
// 为什么归档与恢复只是同一条 UPDATE：可见性过滤发生在**读路径**上（search / view / list），
// 归档不是把条目挪走。证据是可逆性 —— 恢复之后，同一条查询得到的注入文本与归档前
// 逐字符相同（T26 判据 3）。若归档时重算了什么，这条证据就不成立。

import type { DatabaseSync } from 'node:sqlite'
import { FLAG_ARCHIVED } from '../db/flags.js'

export interface ArchiveInput {
  atomId: number
  /** true = 归档，false = 恢复。 */
  archived: boolean
}

export interface ArchiveResult {
  atomId: number
  /** 改完之后整行的 flags（其它位原样保留）。 */
  flags: number
  /** 改完之后的归档状态，由新 flags 算出来，不由入参回显。 */
  archived: boolean
  /** 本次是否真的改了库。false = 原本就是这个状态（幂等，不是错误）。 */
  changed: boolean
}

/**
 * 置上或清掉归档位。
 *
 * **只动 bit4**：按位或 / 按位与非，其余位（歧义 / 未归类）与内容列一律不碰。
 * 幂等：重复归档不报错、不重复写库，只把 `changed` 说成 false —— 界面据此显示
 * 「已归档」而不是一句失败。
 *
 * 不更新 `updated_at`：那一列记录的是内容变更。归档改的是可见性，不是内容；
 * 混用会让「最近改过的记忆」多出一批只是被归档的条目。
 *
 * 返回 null 表示这个 id 不在库里（调用方据此回 404），与删除路由的约定一致。
 */
export function setArchived(db: DatabaseSync, input: ArchiveInput): ArchiveResult | null {
  const atomId = Number(input.atomId)
  if (!Number.isInteger(atomId) || atomId <= 0) throw new Error('atom_id 必须是正整数')

  const row = db.prepare('SELECT flags FROM atom WHERE id = ?').get(atomId) as
    { flags: number | bigint | null } | undefined
  if (row === undefined) return null

  const before = row.flags === null || row.flags === undefined ? 0 : Number(row.flags)
  const after = input.archived ? before | FLAG_ARCHIVED : before & ~FLAG_ARCHIVED
  const archived = (after & FLAG_ARCHIVED) !== 0
  if (after === before) return { atomId, flags: before, archived, changed: false }

  db.prepare('UPDATE atom SET flags = ? WHERE id = ?').run(after, atomId)
  return { atomId, flags: after, archived, changed: true }
}

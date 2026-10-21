// 目录：把「库里有什么」变成一个可以直接回答的问题。
//
// 为什么需要它：其余工具都要求**先有查询或 id** —— recall 要查询词，expand 要 atom id，
// 于是「我的记忆库里有什么」无法被回答。看不见就无法审计，而审计是用户对记忆库的
// 最低要求。本模块属于形式层：只读、分页、可过滤，不做任何语义判断。
//
// 分页是硬要求而不是礼貌：几百条摘要一次读进上下文正是「注意力稀释」，而模型的默认
// 行为是把能拿到的都拿上。所以这里**总是**分页，没有「一次给全部」的开关。

import type { DatabaseSync } from 'node:sqlite'
import type { ThresholdValue } from '../threshold-types.js'
import { atomKindFilterValues } from '../db/schema.js'
import { FLAG_ARCHIVED } from '../db/flags.js'

/** 一页最多给多少条。 */
export const LIST_MAX_LIMIT = 50 satisfies ThresholdValue<
  'chosen',
  {
    area: '目录'
    why: '上限是硬边界、防止调用方一次拉空整个库（D13-1）：50 本身无实测记录，它约束的是注意力稀释，不是某个分布'
    failsWhen: ['一次注入能容纳的摘要条数', '库规模']
    guardedBy: ['test/list.test.mjs', 'test/audit.test.mjs']
    affects: '一页最多给多少条；请求值被强制钳制到 [1, 50]'
    diverges: '**zod schema 里也没有**（工具侧有测试守着钳制行为）'
  }
>

/** 默认页大小。取值偏小：列目录是为了定位，不是为了读完。 */
export const LIST_DEFAULT_LIMIT = 20 satisfies ThresholdValue<
  'chosen',
  {
    area: '目录'
    why: '`src/pipeline/list.ts` 的 `LIST_DEFAULT_LIMIT` 注释「取值偏小：列目录是为了定位，不是为了读完」：默认页大小是使用偏好选择，不是标定结果'
    failsWhen: ['同上']
    guardedBy: ['test/list.test.mjs', 'test/audit.test.mjs']
    affects: '默认页大小'
  }
>

/** 筛选条件。全部可选，全空即列出全部。 */
export interface ListOptions {
  kind?: string
  scope?: string
  origin?: string
  topicId?: number
  /**
   * 按位过滤：`flags & 该值` 非 0 即命中（位定义见 `../db/flags.ts` 的 FLAG_*）。
   *
   * **给了位过滤就不过滤归档**：那是显式检索 —— 例如 `flags: FLAG_ARCHIVED`
   * 就是要看归档条目。没给时默认排除（见 listAtoms 里的分支）。
   */
  flags?: number
  /** 显式要求把归档条目也列出来（界面上的「显示已归档」）。给 flags 时本项无意义。 */
  includeArchived?: boolean
  limit?: number
  offset?: number
}

/** 目录里的一行。字段是「审计时要看的那些」，不含正文 —— 正文用 lattice_expand 取。 */
export interface ListRow {
  id: number
  kind: string
  summary: string
  origin: string
  scope: string
  projectKey: string | null
  topicId: number | null
  supersededBy: number | null
  createdAt: number
  recallHits: number
  lastRecalledAt: number | null
  /** 位标志（歧义 / 未归类 / 待拆分）。只读展示，不参与打分。 */
  flags: number
}

export interface ListResult {
  rows: ListRow[]
  /** 满足筛选条件的**总条数**，不是本页条数。分页要靠它。 */
  total: number
  offset: number
  limit: number
}

/** 目录行的 SELECT 列表：listAtoms 与 listAtomsByIds 共用，免得两处字段慢慢分叉。 */
const LIST_COLUMNS =
  'id, kind, summary, origin, scope, project_key, topic_id, superseded_by, created_at, ' +
  'recall_hits, last_recalled_at, flags'

/** 一行原始记录 → 目录行。字段映射只有这一处（列名 → 驼峰字段）。 */
function toListRow(r: Record<string, unknown>): ListRow {
  return {
    id: Number(r.id),
    kind: String(r.kind),
    summary: String(r.summary),
    origin: String(r.origin),
    scope: String(r.scope),
    projectKey: r.project_key === null || r.project_key === undefined ? null : String(r.project_key),
    topicId: r.topic_id === null || r.topic_id === undefined ? null : Number(r.topic_id),
    supersededBy: r.superseded_by === null || r.superseded_by === undefined ? null : Number(r.superseded_by),
    createdAt: Number(r.created_at),
    recallHits: Number(r.recall_hits),
    lastRecalledAt:
      r.last_recalled_at === null || r.last_recalled_at === undefined ? null : Number(r.last_recalled_at),
    flags: r.flags === null || r.flags === undefined ? 0 : Number(r.flags),
  }
}

/**
 * 按筛选条件列目录。**只读**：不排序相关性、不碰编码器、不写库。
 *
 * 排序固定为 id 倒序（最近写入的在前）。id 自增即写入顺序，因此这同时也是时间序 ——
 * 不必依赖 created_at，也就不会因为时间戳相同而出现不稳定的分页。
 */
export function listAtoms(db: DatabaseSync, opts: ListOptions = {}): ListResult {
  const where: string[] = []
  const args: Array<string | number> = []
  if (opts.kind !== undefined && opts.kind !== '') {
    // 主名与历史别名一起匹配：改名不回溯旧行，只匹配主名会让旧条目从结果里消失。
    const values = atomKindFilterValues(opts.kind)
    where.push('kind IN (' + values.map(() => '?').join(', ') + ')')
    args.push(...values)
  }
  if (opts.origin !== undefined && opts.origin !== '') {
    where.push('origin = ?')
    args.push(opts.origin)
  }
  if (opts.scope !== undefined && opts.scope !== '') {
    // 与召回同语义：看某个项目时也能看到全局记忆 ——「本项目 + 全局」才是这个库对 scope
    // 的定义。两边若不一致，列表与召回会给出互相矛盾的答案。
    where.push("(scope = ? OR scope = 'global')")
    args.push(opts.scope)
  }
  if (opts.topicId !== undefined) {
    where.push('topic_id = ?')
    args.push(opts.topicId)
  }
  if (opts.flags !== undefined && opts.flags !== 0) {
    // 按位过滤而不是等值：一个 atom 可以同时有多个标记，等值匹配会让「查歧义」漏掉
    // 同时被标了「未归类」的行。
    //
    // 这一支**不排除归档**：给了位过滤就是显式检索。于是 flags=16 能列出归档条目，
    // flags=2 仍然能列出「既歧义又归档」的行 —— 两个条件都在问具体标记，不该互相遮蔽。
    where.push('(flags & ?) <> 0')
    args.push(opts.flags)
  } else if (opts.includeArchived !== true) {
    // 默认结果不含归档（默认不召回）。这是「没给位过滤」的那一支，
    // 与上面互斥 —— 两个分支都写归档条件会让 flags=16 永远为空。
    where.push('(flags & ?) = 0')
    args.push(FLAG_ARCHIVED)
  }
  const clause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''
  const total = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM atom' + clause).get(...args) as { n: number | bigint }).n,
  )
  const limit = Math.min(LIST_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? LIST_DEFAULT_LIMIT)))
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const rows = db
    .prepare('SELECT ' + LIST_COLUMNS + ' FROM atom' + clause + ' ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(...args, limit, offset) as Array<Record<string, unknown>>
  return { rows: rows.map(toListRow), total, offset, limit }
}

/**
 * 按 id 批量取目录行 —— 同一套字段映射，只换 WHERE。
 *
 * 为什么需要它：搜索结果由 recall 产出，而 RecallHit 只带 origin / supersededBy，
 * 不带「被取回几次、最后一次是什么时候」—— 归属显示会缺一半。这里用一次 IN 查询补齐，
 * 而不是让调用方（插件入口）自己写 SQL：ListRow 的投影归本模块所有，散出去两处就会分叉。
 *
 * 只读。空数组直接返回空（不生成非法的 `IN ()`）；顺序按 id 倒序，与 listAtoms 一致；
 * 入参里有不存在的 id 时，返回条数会少于入参条数。
 */
export function listAtomsByIds(db: DatabaseSync, ids: readonly number[]): ListRow[] {
  // 去重并剔掉非法值：调用方给的往往是召回结果的 id 列表，不保证干净。
  const clean = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0)
  if (clean.length === 0) return []
  const placeholders = clean.map(() => '?').join(', ')
  const rows = db
    .prepare('SELECT ' + LIST_COLUMNS + ' FROM atom WHERE id IN (' + placeholders + ') ORDER BY id DESC')
    .all(...clean) as Array<Record<string, unknown>>
  return rows.map(toListRow)
}

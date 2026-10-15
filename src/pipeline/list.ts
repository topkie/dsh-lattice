// 目录：把「库里有什么」变成一个可以直接回答的问题。
//
// 为什么需要它：其余工具都要求**先有查询或 id** —— recall 要查询词，expand 要 atom id，
// 于是「我的记忆库里有什么」无法被回答。看不见就无法审计，而审计是用户对记忆库的
// 最低要求。本模块属于形式层：只读、分页、可过滤，不做任何语义判断。
//
// 分页是硬要求而不是礼貌：几百条摘要一次读进上下文正是「注意力稀释」，而模型的默认
// 行为是把能拿到的都拿上。所以这里**总是**分页，没有「一次给全部」的开关。

import type { DatabaseSync } from 'node:sqlite'

/** 一页最多给多少条。 */
export const LIST_MAX_LIMIT = 50

/** 默认页大小。取值偏小：列目录是为了定位，不是为了读完。 */
export const LIST_DEFAULT_LIMIT = 20

/** 筛选条件。全部可选，全空即列出全部。 */
export interface ListOptions {
  kind?: string
  scope?: string
  origin?: string
  topicId?: number
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
}

export interface ListResult {
  rows: ListRow[]
  /** 满足筛选条件的**总条数**，不是本页条数。分页要靠它。 */
  total: number
  offset: number
  limit: number
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
    where.push('kind = ?')
    args.push(opts.kind)
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
  const clause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''
  const total = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM atom' + clause).get(...args) as { n: number | bigint }).n,
  )
  const limit = Math.min(LIST_MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? LIST_DEFAULT_LIMIT)))
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const rows = db
    .prepare(
      'SELECT id, kind, summary, origin, scope, project_key, topic_id, superseded_by, created_at, ' +
        'recall_hits, last_recalled_at FROM atom' +
        clause +
        ' ORDER BY id DESC LIMIT ? OFFSET ?',
    )
    .all(...args, limit, offset) as Array<Record<string, unknown>>
  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      kind: String(r.kind),
      summary: String(r.summary),
      origin: String(r.origin),
      scope: String(r.scope),
      projectKey: r.project_key === null || r.project_key === undefined ? null : String(r.project_key),
      topicId: r.topic_id === null || r.topic_id === undefined ? null : Number(r.topic_id),
      supersededBy:
        r.superseded_by === null || r.superseded_by === undefined ? null : Number(r.superseded_by),
      createdAt: Number(r.created_at),
      recallHits: Number(r.recall_hits),
      lastRecalledAt:
        r.last_recalled_at === null || r.last_recalled_at === undefined ? null : Number(r.last_recalled_at),
    })),
    total,
    offset,
    limit,
  }
}

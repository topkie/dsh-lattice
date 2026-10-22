// 条目详情：点开一条，看它的全文。
//
// 为什么需要它：目录（list.ts）只投影 summary，正文被刻意排除在 ListRow 之外 ——
// 那是**给模型的上下文预算决策**（目录行够模型定位就行，不必花掉整段上下文）。
// 界面复用同一份数据，于是人也只看得到摘要：条目「被截断」的第一现场在数据层，
// 不在 CSS。改样式修不好它。
//
// 所以详情是另一条读取路径，不是给目录加一列：一次按主键取数、不截断、不参与打分、
// 不记命中。列表页若预取正文，打开一个几百条的库就是几百 KB 的正文，而人通常只看两条 ——
// 「点开才取」既是上下文预算，也是流量预算。
//
// 只读：本模块只有一条 SELECT，没有写入口（判据：点开不能改库）。

import type { DatabaseSync } from 'node:sqlite'

/**
 * 一条记忆的详情。
 *
 * 字段是「点开之后要看到什么」：正文、字数、是不是被取代过。列表行里已有的
 * 归属字段（origin / scope / flags）一并带上，界面不必再回头查目录。
 */
export interface AtomDetail {
  id: number
  kind: string
  summary: string
  /** 全文。**不截断** —— 截断是列表的取舍，不是详情的。 */
  text: string
  /**
   * 正文字符数，由 SQLite 的 `length(text)` 数出来。
   *
   * 为什么不用 JS 的 `text.length`：那是 UTF-16 码元数，SQLite 数的是字符数，
   * 遇到代理对就会差一截。界面显示的字数要与库里那条 SQL 对得上，只能同源。
   */
  textLength: number
  origin: string
  scope: string
  topicId: number | null
  /** 被谁取代过。非空时界面必须说出来 —— 否则人会把旧条文当现行条文读。 */
  supersededBy: number | null
  createdAt: number
  recallHits: number
  lastRecalledAt: number | null
  flags: number
}

/**
 * 详情行的 SELECT 列表。
 *
 * 与 list.ts 的 LIST_COLUMNS 刻意分开：两处的**取舍不同**（目录要摘要、详情要正文），
 * 共用一份列表就意味着改一边会悄悄改另一边 —— 而「列表不带正文」本身是判据。
 */
const DETAIL_COLUMNS =
  'id, kind, summary, text, origin, scope, topic_id, superseded_by, created_at, ' +
  'recall_hits, last_recalled_at, flags, length(text) AS text_length'

/**
 * 按 id 取一条记忆的全文。**只读**：没有第二条语句，也不改任何状态。
 *
 * 返回 null 的两种情形都是「没有这一条」：id 不合法，或库里查不到。调用方据此回 400/404，
 * 不要在这里抛异常 —— 路由层要能分辨「请求写错了」与「读库失败了」。
 */
export function atomDetail(db: DatabaseSync, id: number): AtomDetail | null {
  if (!Number.isInteger(id) || id <= 0) return null
  const r = db.prepare('SELECT ' + DETAIL_COLUMNS + ' FROM atom WHERE id = ?').get(id) as
    Record<string, unknown> | undefined
  if (r === undefined) return null
  return {
    id: Number(r.id),
    kind: String(r.kind),
    summary: String(r.summary),
    text: String(r.text),
    textLength: Number(r.text_length),
    origin: String(r.origin),
    scope: String(r.scope),
    topicId: r.topic_id === null || r.topic_id === undefined ? null : Number(r.topic_id),
    supersededBy: r.superseded_by === null || r.superseded_by === undefined ? null : Number(r.superseded_by),
    createdAt: Number(r.created_at),
    recallHits: r.recall_hits === null || r.recall_hits === undefined ? 0 : Number(r.recall_hits),
    lastRecalledAt:
      r.last_recalled_at === null || r.last_recalled_at === undefined ? null : Number(r.last_recalled_at),
    flags: r.flags === null || r.flags === undefined ? 0 : Number(r.flags),
  }
}

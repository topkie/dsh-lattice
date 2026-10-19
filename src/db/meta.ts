// 库自描述元数据：meta 表的读写。
//
// 用途是**让库说清自己是什么** —— 尤其是「用哪套入口规则生成的」。验证与对比都建立在
// 「基准库与待测代码同规则」这个前提上；前提不成立时，测出来的差值可能全部来自规则差异，
// 而不是被验证的那次改动。
//
// 设计上刻意保持极简：一张 key-value 表 + 五个约定键，不做版本链、不留历史。
// 需要历史时由调用方自己带时间戳写值。

import type { DatabaseSync } from 'node:sqlite'

/** 库结构版本。与 PRAGMA user_version 冗余记录一份，便于只读打开时也能读到。 */
export const META_SCHEMA_VERSION = 'schema_version'
/** 入口抽取规则标识，取值来自 pipeline/entries.ts 的 ENTRY_RULE_ID。 */
export const META_ENTRY_RULE = 'entry_rule'
/** 建库时间（毫秒时间戳）。 */
export const META_BUILT_AT = 'built_at'
/** 数据来源标识（数据集名 / 目录名），仅供人工核对，不参与任何判断。 */
export const META_SOURCE = 'source'
/** 生成者标识（脚本名或 'runtime'）。 */
export const META_BUILDER = 'builder'

/** 上次判 S 的时间（epoch 毫秒）：重标冷却期用它，不靠内存变量（重启即失）。 */
export const META_CALIB_LAST_CHECK = 'calib_last_check_at'

/** 上次重标失败的原因码：判据 8 要求「失败要有记录」，而且不能只活在日志里。 */
export const META_CALIB_LAST_ERROR = 'calib_last_error'

/**
 * 上次重建 atom_pair 的时间（epoch 毫秒）。
 *
 * 为什么要有：atom_pair 只在重聚类时填，空表因此有两种含义 —— 「没建过」与
 * 「建过、但没有达到重复线的对」。体检（pipeline/audit.ts）要分开报这两件事
 * （T35 判据 7），而表自身没有留痕的列；由建立者写一个时间戳是最小的代价。
 * 只写不读的旧库缺这个键时按「没建过」处理：保守，且指向正确的下一步。
 */
export const META_RECLUSTER_AT = 'recluster_at'

/**
 * 用户已确认「这条应当拆分」的 atom id 清单（JSON 数组，T29）。
 *
 * 为什么放 meta 而不是新表：它没有查询维度（只在召回时整份读出来），也不需要与 atom
 * 行同生命周期；而新建一张表要一次迁移，本任务的约束是不升 user_version。
 * 上限与 FIFO 淘汰在 pipeline/split.ts 的 SPLIT_CONFIRMED_MAX。
 */
export const META_SPLIT_CONFIRMED = 'split_confirmed'

/**
 * 「这条是按长度切出来的、一共切了几段」的映射（JSON 数组 `[[atomId, 段数], ...]`，T29）。
 *
 * 为什么要存段数：锚行现在只说「疑似应拆分」，而人决定「拆不拆」时唯一有用的信息是
 * 「切成几段」—— 3 段和 8 段是两种工作量。这个数在写入侧本来就现成（reviewLength 的
 * segments），只是此前没落盘。
 *
 * 为什么每一段各记一条而不是只记第一段：锚行是按段逐条渲染的，第二段以后的锚行同样带
 * 待拆分位；只记第一段，后面几段就只能显示不带段数的固定串。
 *
 * 用数组而不是对象：FIFO 淘汰要「最早记的那条」，而 JSON 对象的键序不可依赖。
 * 上限与淘汰在 pipeline/split.ts 的 SPLIT_SEGMENTS_MAX。
 */
export const META_SPLIT_SEGMENTS = 'split_pending_segments'

/** 写入一个键（已存在则覆盖）。 */
export function setMeta(db: DatabaseSync, key: string, value: string, now = Date.now()): void {
  db.prepare(
    'INSERT INTO meta(key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, value, now)
}

/**
 * 键不存在时写入；已存在则**保持原值不动**。返回是否真的写了。
 *
 * 与 setMeta 的分工：setMeta 用于「我知道我在重建这个库」，ensureMeta 用于
 * 「顺手补上自描述，但绝不篡改已有记录」—— 后者是运行时的默认行为。
 */
export function ensureMeta(db: DatabaseSync, key: string, value: string, now = Date.now()): boolean {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: unknown } | undefined
  if (row !== undefined) return false
  setMeta(db, key, value, now)
  return true
}

/** 读一个键；不存在返回 undefined。 */
export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: unknown } | undefined
  return row === undefined ? undefined : String(row.value)
}

/** 读出全部元数据，键按字典序，便于稳定输出给健康检查。 */
export function readMeta(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM meta ORDER BY key').all() as Array<{
    key: unknown
    value: unknown
  }>
  const out: Record<string, string> = {}
  for (const r of rows) out[String(r.key)] = String(r.value)
  return out
}

/** 库的入口规则与当前代码的比对结果。 */
export interface RuleCheck {
  ok: boolean
  /** 库里记录的规则；从未记录过时为 null。 */
  stored: string | null
  /** 当前代码的规则。 */
  current: string
}

/**
 * 比对库记录的入口规则与当前代码。
 *
 * ok 为 false 有两种情况，调用方要分开说：
 *   - stored 为 null：库没有自描述（v1 及更早建的库），无从判断，按「不可比」处理；
 *   - stored 与 current 不同：库是另一套规则生成的，跨规则的数字不可比。
 * 两者都不该被静默当成一致 —— 那正是这个函数存在的理由。
 */
export function checkEntryRule(db: DatabaseSync, current: string): RuleCheck {
  const stored = getMeta(db, META_ENTRY_RULE) ?? null
  return { ok: stored === current, stored, current }
}

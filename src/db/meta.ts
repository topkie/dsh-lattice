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

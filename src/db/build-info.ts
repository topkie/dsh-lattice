// 库的自描述：这份库是谁建的、用哪套入口规则、数据从哪来。
//
// 用途是**让库说清自己是什么** —— 尤其是「用哪套入口规则生成的」。验证与对比都建立在
// 「基准库与待测代码同规则」这个前提上；前提不成立时，测出来的差值可能全部来自规则差异，
// 而不是被验证的那次改动。
//
// **这里不再记 schema 版本**：版本号的唯一真相源是 PRAGMA user_version。
// 旧实现另存了一份 schema_version 键，结果它与 user_version 漂成了两个值（库里 4、
// meta 里 3）—— 一个可以被读到的副本，只要没人负责同步，就一定会漂。

import type { DatabaseSync } from 'node:sqlite'

export interface BuildInfo {
  /** 入口抽取规则标识，取值来自 pipeline/entries.ts 的 ENTRY_RULE_ID。 */
  entryRule: string
  /** 生成者标识（脚本名或 'runtime'）。 */
  builder: string
  /** 建库时间（epoch 毫秒）。 */
  builtAt: number
  /** 数据来源标识（数据集名 / 目录名），仅供人工核对，不参与任何判断。 */
  source: string | null
}

interface Row {
  entry_rule: unknown
  builder: unknown
  built_at: unknown
  source: unknown
}

/** 读自描述；从未写过时返回 null（旧库与全新库都是这种状态，由调用方分开解释）。 */
export function readBuildInfo(db: DatabaseSync): BuildInfo | null {
  const row = db
    .prepare('SELECT entry_rule, builder, built_at, source FROM build_info WHERE id = 1')
    .get() as Row | undefined
  if (row === undefined) return null
  return {
    entryRule: String(row.entry_rule),
    builder: String(row.builder),
    builtAt: Number(row.built_at),
    source: row.source === null || row.source === undefined ? null : String(row.source),
  }
}

/** 覆盖写自描述（重建这个库的脚本用它）。 */
export function setBuildInfo(
  db: DatabaseSync,
  info: { entryRule: string; builder: string; builtAt?: number; source?: string | null },
): void {
  db.prepare(
    'INSERT INTO build_info(id, entry_rule, builder, built_at, source) VALUES (1, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET entry_rule = excluded.entry_rule, builder = excluded.builder, ' +
      'built_at = excluded.built_at, source = excluded.source',
  ).run(info.entryRule, info.builder, info.builtAt ?? Date.now(), info.source ?? null)
}

/**
 * 自描述不存在时补上；已存在则**一个字不动**。返回是否真的写了。
 *
 * 与 setBuildInfo 的分工：set 用于「我知道我在重建这个库」，ensure 用于「顺手补上自描述，
 * 但绝不篡改已有记录」—— 后者是运行时的默认行为。库若是另一套入口规则生成的，覆盖元数据
 * 只会把「不一致」这个事实抹掉，而它恰恰是需要被看见的东西（由 checkEntryRule 报告）。
 */
export function ensureBuildInfo(
  db: DatabaseSync,
  info: { entryRule: string; builder: string; builtAt?: number; source?: string | null },
): boolean {
  if (readBuildInfo(db) !== null) return false
  setBuildInfo(db, info)
  return true
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
 *   - stored 为 null：库没有自描述，无从判断，按「不可比」处理；
 *   - stored 与 current 不同：库是另一套规则生成的，跨规则的数字不可比。
 * 两者都不该被静默当成一致 —— 那正是这个函数存在的理由。
 */
export function checkEntryRule(db: DatabaseSync, current: string): RuleCheck {
  const info = readBuildInfo(db)
  const stored = info === null ? null : info.entryRule
  return { ok: stored === current, stored, current }
}

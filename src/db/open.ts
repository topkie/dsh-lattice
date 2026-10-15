// dsh-lattice 存储层：连接、PRAGMA 与版本迁移。
//
// 三条纪律：
//   1. PRAGMA 必须在事务之外执行（journal_mode 尤其）；
//   2. 迁移必须幂等，靠 PRAGMA user_version 判定；
//   3. 本模块是 db 层唯一允许 import node:sqlite 的地方之一，其余模块只拿 DatabaseSync。

import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { deriveResourceParams, type ResourceOverrides } from '../util/memory.js'
import { MIGRATIONS, pragmas, SCHEMA_VERSION } from './schema.js'

export interface OpenOptions {
  /** 只读打开（排查与分析用），此时不写 PRAGMA。 */
  readOnly?: boolean
  /**
   * 资源参数覆盖。省略时按机器内存与库大小推导；
   * 显式传入可以让「健康检查报出来的值」与「实际使用的值」永远是同一个。
   */
  resources?: ResourceOverrides
}

export interface MigrateResult {
  from: number
  to: number
  /** 本次执行的语句数；0 表示无需迁移。 */
  applied: number
}

export interface SchemaObject {
  type: string
  name: string
  table: string
}

/** 打开（必要时创建）库文件并设置 PRAGMA。返回连接与本次实际使用的资源参数。 */
export function openDb(file: string, opts: OpenOptions = {}): DatabaseSync {
  const db = new DatabaseSync(file, opts.readOnly ? { readOnly: true } : {})
  if (opts.readOnly) {
    // 只读连接不写 PRAGMA（会失败），但仍需要一个等待上限，避免读被写者饿死。
    db.exec('PRAGMA busy_timeout = ' + deriveResourceParams(0, opts.resources).busyTimeout)
    return db
  }
  // 库大小参与推导：mmap 窗口的大小要和库文件相称，库还没建时按 0 处理。
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    /* 文件还不存在：首次建库 */
  }
  for (const p of pragmas(deriveResourceParams(size, opts.resources))) db.exec(p)
  return db
}

/** 当前库的 schema 版本（PRAGMA user_version）。 */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number | bigint } | undefined
  return Number(row?.user_version ?? 0)
}

/** 列出库内全部 schema 对象，供建库校验与健康检查使用。 */
export function listObjects(db: DatabaseSync): SchemaObject[] {
  const rows = db
    .prepare(
      "SELECT type, name, COALESCE(tbl_name, '') AS tbl FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; tbl: string }>
  return rows.map((r) => ({ type: String(r.type), name: String(r.name), table: String(r.tbl) }))
}

/**
 * 把库推进到 SCHEMA_VERSION。幂等：已是最新版则直接返回。
 *
 * 版本高于插件支持时**拒绝降级**——旧代码读新库只会静默出错，不如显式失败。
 */
export function migrate(db: DatabaseSync): MigrateResult {
  const from = schemaVersion(db)
  if (from === SCHEMA_VERSION) return { from, to: from, applied: 0 }
  if (from > SCHEMA_VERSION) {
    throw new Error(`库的 schema 版本为 ${from}，高于本插件支持的 ${SCHEMA_VERSION}；拒绝降级，请升级插件`)
  }
  db.exec('BEGIN')
  let applied = 0
  try {
    // 只跑缺的那几步。v1 的库重跑 v1 的建表语句会因为表已存在而失败，
    // 所以这里按版本递进，而不是「一律执行全部 DDL」。
    for (let v = from; v < SCHEMA_VERSION; v++) {
      for (const stmt of MIGRATIONS[v] ?? []) {
        db.exec(stmt)
        applied++
      }
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 回滚失败不覆盖原始错误 */
    }
    throw err
  }
  return { from, to: SCHEMA_VERSION, applied }
}

/** 便捷入口：打开 + 迁移 + 返回连接。 */
export function openVault(
  file: string,
  opts: OpenOptions = {},
): { db: DatabaseSync; migration: MigrateResult } {
  const db = openDb(file, opts)
  const migration = migrate(db)
  return { db, migration }
}

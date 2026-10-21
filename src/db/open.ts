// dsh-lattice 存储层：连接、PRAGMA 与版本迁移。
//
// 四条纪律：
//   1. PRAGMA 必须在事务之外执行（journal_mode 尤其）；
//   2. 迁移必须幂等，靠 PRAGMA user_version 判定；
//   3. **版本号是声明，结构断言是证据** —— 迁完之后还要真去库里数对象，
//      因为「user_version 说是 5」和「库里真有 v5 的表」是两件事；
//   4. 本模块是 db 层唯一允许 import node:sqlite 的地方之一，其余模块只拿 DatabaseSync。

import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { deriveResourceParams, type ResourceOverrides } from '../util/memory.js'
import { DDL, MIGRATIONS, pragmas, SCHEMA_VERSION } from './schema.js'

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
  for (const stmt of pragmas(deriveResourceParams(size, opts.resources))) db.exec(stmt)
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

// 从 DDL 文本里认对象名。标识符在本项目的 DDL 里一律裸写（没有引号包裹），
// 所以这里只处理可选的方括号，不处理引号 —— 真出现了，校验会报「缺」，不会静默放过。
const TABLE_RE = /^\s*CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\[?([A-Za-z_][\w]*)/i
const INDEX_RE =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\[?([A-Za-z_][\w]*)\s+ON\s+\[?([A-Za-z_][\w]*)/i
const TRIGGER_RE =
  /^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?\[?([A-Za-z_][\w]*)[\s\S]*?\bON\s+\[?([A-Za-z_][\w]*)/i

/**
 * 从 DDL 文本里读出它应当建出哪些对象。
 *
 * 只认表 / 索引 / 触发器三类 —— 视图与其它对象本项目的 DDL 里没有，出现了就是有人
 * 绕过了这份清单，那时宁可校验报「缺」也不要静默放过。
 *
 * FTS5 的影子表（entry_fts_data 等）不在清单里：它们由虚表自动创建，
 * 所以校验只断言「清单里的都在」，不断言「库里没有别的」。
 */
export function declaredObjects(ddl: readonly string[] = DDL): SchemaObject[] {
  const out: SchemaObject[] = []
  for (const sql of ddl) {
    let m = TABLE_RE.exec(sql)
    if (m) {
      out.push({ type: 'table', name: m[1], table: m[1] })
      continue
    }
    m = INDEX_RE.exec(sql)
    if (m) {
      out.push({ type: 'index', name: m[1], table: m[2] })
      continue
    }
    m = TRIGGER_RE.exec(sql)
    if (m) {
      out.push({ type: 'trigger', name: m[1], table: m[2] })
    }
  }
  return out
}

const EXPECTED = declaredObjects()

/**
 * 库里缺哪些 DDL 声明过的对象（空数组表示结构齐全）。
 *
 * 与 `listObjects` 的差别：那个回答「库里有什么」，这个回答「该有的少了什么」。
 * 校验只比「名字 + 类型」，不比列定义 —— 列级漂移由迁移语句负责，而这里要挡的是
 * 「版本号写成了新版本、结构却还是旧的」这一类整表缺失。
 */
export function missingObjects(db: DatabaseSync): SchemaObject[] {
  const have = new Set(listObjects(db).map((o) => o.type + ':' + o.name))
  return EXPECTED.filter((o) => !have.has(o.type + ':' + o.name))
}

/**
 * 把库推进到 SCHEMA_VERSION。幂等：已是最新版则直接返回。
 *
 * **只认两个版本**：0（空库，直接建出快照）与 SCHEMA_VERSION（已是最新）。
 * 其余一律拒绝，而且要在动库之前就拒绝：
 *   - 高于本插件 → 旧代码读新库只会静默出错，拒绝降级；
 *   - 0 与最新之间 → 那些中间版本只在本项目内部存在过，从未发布。世上没有该由
 *     这条路升上来的库，于是也没有「升一半」的正确行为可写。宁可明确报错，
 *     让人从备份恢复或换对应版本的插件导出，也好过猜一个迁移路径。
 */
export function migrate(db: DatabaseSync): MigrateResult {
  const from = schemaVersion(db)
  if (from === SCHEMA_VERSION) return { from, to: from, applied: 0 }
  if (from > SCHEMA_VERSION) {
    throw new Error(`库的 schema 版本为 ${from}，高于本插件支持的 ${SCHEMA_VERSION}；拒绝降级，请升级插件`)
  }
  if (from !== 0) {
    throw new Error(
      `库的 schema 版本为 ${from}，本插件只接受 0（空库）或 ${SCHEMA_VERSION}。` +
        '该版本来自未发布的内部构建，没有迁移路径：请从备份恢复，' +
        '或用建出这个库的那一版插件导出内容后重新导入。本插件不会修改这个库。',
    )
  }
  db.exec('BEGIN')
  let applied = 0
  try {
    for (let v = from; v < SCHEMA_VERSION; v++) {
      for (const stmt of MIGRATIONS[v] ?? []) {
        db.exec(stmt)
        applied++
      }
    }
    db.exec('PRAGMA user_version = ' + SCHEMA_VERSION)
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

/**
 * 便捷入口：打开 + 迁移 + 校验 + 返回连接。
 *
 * **只读连接不做迁移，也不做校验** —— 迁移要写库，而只读连接写不了；校验要读结构，
 * 它对旧库同样有意义（诊断要读老库），但校验失败会让「读一个旧库」这件合法的事失败，
 * 所以只读路径放过。这不是错误处理，是语义：读旧库是合法用法，写旧库不是。
 *
 * 只读时返回的 `migration.to` 是**库的实际版本**，不是插件支持的版本 ——
 * 调用方若关心两者是否一致，自己比 `schemaVersion(db)` 与 `SCHEMA_VERSION`。
 */
export function openVault(
  file: string,
  opts: OpenOptions = {},
): { db: DatabaseSync; migration: MigrateResult } {
  const db = openDb(file, opts)
  if (opts.readOnly) {
    const v = schemaVersion(db)
    return { db, migration: { from: v, to: v, applied: 0 } }
  }
  // 迁移失败也要关连接：否则句柄留在进程里，文件删不掉、测试清理报 EPERM，
  // 而错误本身已经说明了原因。
  let migration: MigrateResult
  try {
    migration = migrate(db)
  } catch (err) {
    db.close()
    throw err
  }
  // 迁完（或本来就最新）之后再看一眼结构：版本号是声明，对象才是证据。
  const missing = missingObjects(db)
  if (missing.length > 0) {
    db.close()
    const names = missing.map((o) => o.type + ' ' + o.name).join('、')
    throw new Error(
      `库的版本号是 ${SCHEMA_VERSION}，但结构不符：缺少 ${missing.length} 个对象（${names}）。` +
        '这个库可能是被改动过的快照，或来自未发布的内部构建；请从备份恢复。',
    )
  }
  return { db, migration }
}

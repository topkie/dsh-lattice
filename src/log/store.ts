// 日志库的物理层：一个**独立**的 SQLite 文件、批量写、按大小轮换与清理。
//
// 为什么独立库而不是主库里的表：
//   1. 日志不是真相源，可以丢、可以删；主库是记忆的唯一真相源，两者不该共享生命周期；
//   2. 写日志若进主库事务，就会与写入路径争锁 —— 日志是用来观察降级的，不该制造降级；
//   3. 清空日志（用户在界面上点）只允许删这个文件，绝不能碰到记忆数据。
//
// 为什么 WAL + synchronous=NORMAL：日志的代价必须远小于它记录的那件事。
// 提交不逐次 fsync，崩溃时最多丢最近一批（一个 flush 窗口）—— 这个代价已由裁决接受。
//
// 轮换**不用定时器**：写前看一眼当前文件大小、启动时再看一眼，就够覆盖
// 「降级事件稀疏但长期存在」这个实际分布。定时器只会在没有日志可写的时候空转。
//
// 本文件是唯一知道日志库文件名与目录名的地方（门禁会检查 src/log 之外的源码不出现
// 日志库文件名，也不出现直接 INSERT INTO log）。

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import type { ThresholdValue } from '../threshold-types.js'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deriveResourceParams } from '../util/memory.js'
import type { LogRow } from './policy.js'

/** 日志目录名（位于 dataDir 之下）。 */
export const LOG_DIR_NAME = 'logs'

/** 当前日志库文件名。轮换后的历史文件名为 lattice-log-<毫秒时间戳>.db。 */
export const LOG_DB_NAME = 'lattice-log.db'

/** 日志库自带的版本号（PRAGMA user_version）。与主库 SCHEMA_VERSION 无关，不混用。 */
export const LOG_SCHEMA_VERSION = 1

/** 单文件轮换阈值：4 MB。 */
export const LOG_FILE_MAX_BYTES = (4 * 1024 * 1024) satisfies ThresholdValue<
  'chosen',
  {
    area: '降级日志'
    why: '没有日志事件速率的实测：4 MB 是产品决定的值，「降级事件稀疏、约能放数万条」是判断；本仓库没有事件速率与单条 detail 长度的实测'
    failsWhen: ['降级事件产生速率', '单条 detail 的长度', '愿意给日志的磁盘空间']
    affects: '写前与启动时检查：当前日志库达到此大小就改名为历史文件并新建（4 MB）'
  }
>

/** 保留文件数：5 个（含当前库）。5 x 4 MB 与总量上限 20 MB 对齐。 */
export const LOG_KEEP_FILES = 5 satisfies ThresholdValue<
  'chosen',
  {
    area: '降级日志'
    why: '取 5 个；5 个 × 4 MB 与总量 20 MB 相等，是产品决定的磁盘空间预算，没有测量出处'
    failsWhen: ['单文件阈值', '总量上限', '需要回溯多久的降级历史']
    affects: '清理：历史文件数 + 当前库不超过这个数，超出删最旧的（5 个，含当前库）'
  }
>

/** 全部日志文件的总量上限：保留文件数 × 单文件上限 = 20 MB。 */
export const LOG_TOTAL_MAX_BYTES = (LOG_KEEP_FILES * LOG_FILE_MAX_BYTES) satisfies ThresholdValue<
  'recheckable',
  {
    area: '降级日志'
    tool: '源码表达式（src/log/store.ts 的 `LOG_KEEP_FILES * LOG_FILE_MAX_BYTES`）'
    finding: '由 LOG_KEEP_FILES × LOG_FILE_MAX_BYTES 算出 20 MB；改两个因子后重新构建，派生值跟着变，不需要测量'
    formula: true
    failsWhen: ['单文件阈值', '保留文件数', '磁盘配额']
    affects: '清理：全部日志文件（含当前库）总大小超过此值就删最旧的历史文件（20 MB）'
  }
>

/** 轮换与清理的取值。测试可传更小的值来构造轮换，不必真写 4 MB。 */
export interface LogLimits {
  fileMaxBytes: number
  keepFiles: number
  totalMaxBytes: number
}

export const DEFAULT_LOG_LIMITS: LogLimits = {
  fileMaxBytes: LOG_FILE_MAX_BYTES,
  keepFiles: LOG_KEEP_FILES,
  totalMaxBytes: LOG_TOTAL_MAX_BYTES,
}

/** 只认本模块产出的历史文件名；目录里的其他文件一律不碰。 */
const ROTATED_NAME = /^lattice-log-(\d+)\.db$/

/** 日志目录：<dataDir>/logs。 */
export function logDirOf(dataDir: string): string {
  return join(dataDir, LOG_DIR_NAME)
}

/** 一个文件的磁盘占用：主文件 + 预写日志（-shm 是固定大小的共享内存，不计）。 */
function sizeOf(file: string): number {
  let total = 0
  for (const suffix of ['', '-wal']) {
    try {
      total += statSync(file + suffix).size
    } catch {
      /* 不存在的那一半不计 */
    }
  }
  return total
}

/**
 * 列出本模块管理的日志文件，按时间升序：先是历史文件（文件名里的时间戳升序），最后是当前库。
 *
 * 导出与清理都靠它拿到「同一个集合」；两处各自拼文件名就会漂移。
 */
export function logFilesIn(dir: string): string[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const rotated: Array<{ file: string; ts: number }> = []
  for (const name of names) {
    const m = ROTATED_NAME.exec(name)
    if (m === null) continue
    rotated.push({ file: join(dir, name), ts: Number(m[1]) })
  }
  rotated.sort((a, b) => a.ts - b.ts || a.file.localeCompare(b.file))
  const out = rotated.map((r) => r.file)
  if (existsSync(join(dir, LOG_DB_NAME))) out.push(join(dir, LOG_DB_NAME))
  return out
}

/** 清空失败（通常是文件被另一个进程占用）。消息面向用户，带可操作的建议。 */
export class LogClearError extends Error {
  /** 未能删除的文件数。 */
  readonly failed: number
  constructor(message: string, failed: number) {
    super(message)
    this.name = 'LogClearError'
    this.failed = failed
  }
}

/**
 * 删除本模块管理的全部日志文件（当前库 + 历史文件 + 它们的 -wal/-shm）。
 *
 * 为什么单独成函数而不是挂在 LogStore 上：清空前必须先**关连接**，而连接归上层
 * （log/index.ts）管；这里只做「按文件名模式删」这一件事，顺便把失败如实报出去。
 * 只认 lattice-log*.db 及其旁路文件，目录里的任何其他文件都不碰。
 */
export function clearLogFiles(dataDir: string): { removed: number } {
  const dir = logDirOf(dataDir)
  if (!existsSync(dir)) return { removed: 0 }
  let removed = 0
  let failed = 0
  for (const name of readdirSync(dir)) {
    if (!/^lattice-log.*\.db(?:-(?:wal|shm))?$/.test(name)) continue
    try {
      unlinkSync(join(dir, name))
      removed++
    } catch {
      // 单个文件失败不中断：继续删其余的，最后一次性报出来。
      failed++
    }
  }
  if (failed > 0) {
    throw new LogClearError('日志文件被占用，请关闭其他窗口后重试（' + failed + ' 个文件未能删除）', failed)
  }
  return { removed }
}

/**
 * 日志库句柄。**懒打开**：构造不碰磁盘，第一次 append 才建库、设 PRAGMA。
 *
 * 这样「插件激活」与「第一条降级事件」之间没有 IO；建库失败也只发生在真正要写的时候，
 * 由上层降级到内存（见 log/index.ts 的 noteWriteFailure）。
 */
export class LogStore {
  readonly dir: string
  readonly file: string
  private readonly limits: LogLimits
  private db: DatabaseSync | null = null

  constructor(dataDir: string, limits: LogLimits = DEFAULT_LOG_LIMITS) {
    this.dir = logDirOf(dataDir)
    this.file = join(this.dir, LOG_DB_NAME)
    this.limits = limits
  }

  /**
   * 批量落盘：一个事务。
   *
   * 失败**直接抛出** —— 这一层不吞错。降级到内存、限频记 log.write_failed 由上层负责，
   * 因为「写失败之后怎么办」属于模块级的策略，不是文件操作的一部分。
   */
  append(rows: readonly LogRow[]): void {
    if (rows.length === 0) return
    this.open()
    if (sizeOf(this.file) >= this.limits.fileMaxBytes) this.rotate()
    const db = this.db
    if (db === null) throw new Error('日志库未打开')
    db.exec('BEGIN')
    try {
      const stmt = db.prepare('INSERT INTO log (ts, level, event, detail) VALUES (?, ?, ?, ?)')
      for (const row of rows) stmt.run(row.ts, row.level, row.event, row.detail)
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 事务可能已经结束 */
      }
      throw err
    }
  }

  /** 关闭连接。关闭时 SQLite 会把 WAL 合并回主文件，故不额外 checkpoint。 */
  close(): void {
    if (this.db === null) return
    try {
      this.db.close()
    } catch {
      /* 已关闭或句柄失效 */
    }
    this.db = null
  }

  /** 打开连接：建目录、启动检查、建表。 */
  private open(): void {
    if (this.db !== null) return
    mkdirSync(this.dir, { recursive: true })
    this.startupCheck()
    // 版本不符（或库损坏）时**重建**，不迁移：日志不是真相源，保留旧格式没有价值，
    // 而一条迁移路径会变成第二个需要维护的 schema。
    let db: DatabaseSync | null = null
    try {
      db = this.openFresh()
      if (this.schemaVersionOf(db) !== LOG_SCHEMA_VERSION) {
        db.close()
        db = null
        this.removeAll(this.file)
        db = this.openFresh()
      }
      this.db = db
    } catch {
      try {
        db?.close()
      } catch {
        /* 忽略 */
      }
      // 重建一次；再失败就让异常抛给上层（降级到内存），不在这里无限重试。
      this.removeAll(this.file)
      this.db = this.openFresh()
    }
  }

  /** 建库并设 PRAGMA、建表。第一次创建与重建共用。 */
  private openFresh(): DatabaseSync {
    const db = new DatabaseSync(this.file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    // 与主库同一取值策略（util/memory.ts 的推导），但日志库没有大块读写，mmap 不设。
    db.exec('PRAGMA busy_timeout = ' + deriveResourceParams(0).busyTimeout)
    db.exec('PRAGMA user_version = ' + LOG_SCHEMA_VERSION)
    db.exec(
      'CREATE TABLE IF NOT EXISTS log (' +
        'id INTEGER PRIMARY KEY, ' +
        'ts INTEGER NOT NULL, ' +
        'level TEXT NOT NULL, ' +
        'event TEXT NOT NULL, ' +
        'detail TEXT)',
    )
    db.exec('CREATE INDEX IF NOT EXISTS log_ts ON log(ts)')
    return db
  }

  /** 读 PRAGMA user_version；读不到按 0（新建的库）处理。 */
  private schemaVersionOf(db: DatabaseSync): number {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number | bigint } | undefined
    return Number(row?.user_version ?? 0)
  }

  /**
   * 启动检查：当前文件已超阈值就先改名，再清理历史文件。
   *
   * 放在打开连接**之前**：超阈值的库不需要先打开再关掉，直接改名更省事，也避免
   * 「打开 → 发现超限 → 关闭」这个中间态留下 -wal 旁路文件。
   */
  private startupCheck(): void {
    this.close()
    if (existsSync(this.file) && sizeOf(this.file) >= this.limits.fileMaxBytes) this.rotateFileOnly()
    this.prune()
  }

  /** 写前轮换：关连接 → 改名 → 清理 → 建新库。 */
  private rotate(): void {
    this.close()
    this.rotateFileOnly()
    this.prune()
    this.open()
  }

  /** 把当前库改名为历史文件。用毫秒时间戳命名，撞名就往后顺延（文件名仍保持纯数字）。 */
  private rotateFileOnly(): void {
    if (!existsSync(this.file)) return
    let ts = Date.now()
    while (existsSync(join(this.dir, 'lattice-log-' + ts + '.db'))) ts++
    const target = join(this.dir, 'lattice-log-' + ts + '.db')
    renameSync(this.file, target)
    // 异常退出可能留下 -wal/-shm；它们属于旧库，必须跟着改名，否则会成为新库的旁路文件。
    for (const suffix of ['-wal', '-shm']) {
      if (!existsSync(this.file + suffix)) continue
      try {
        renameSync(this.file + suffix, target + suffix)
      } catch {
        /* 删不掉也不影响新库：新库会重新建自己的旁路文件 */
      }
    }
  }

  /**
   * 清理：历史文件数 + 当前库不超过 keepFiles，且总大小不超过 totalMaxBytes。
   *
   * **只删历史文件**，当前库永远保留 —— 删掉当前库等于让日志模块每次都要重建一次，
   * 而重建本身也会失败（例如目录不可写），那会把「清理」变成新的故障源。
   */
  private prune(): void {
    const current = join(this.dir, LOG_DB_NAME)
    const all = logFilesIn(this.dir)
    const rotated = all.filter((file) => file !== current)
    // 当前库不存在时也要占一个名额：prune 常在「刚把旧文件改名、新库还没建」之间执行，
    // 只数磁盘上已有的文件会让「保留 5 个」变成 5 个历史 + 1 个新库 = 6 个。
    let count = all.length + (existsSync(current) ? 0 : 1)
    const keep = Math.max(1, this.limits.keepFiles)
    while (rotated.length > 0 && (count > keep || this.totalBytes(all) > this.limits.totalMaxBytes)) {
      const victim = rotated.shift()
      if (victim === undefined) break
      this.removeAll(victim)
      count--
    }
  }

  /** 全部日志文件的总占用（含当前库）。 */
  private totalBytes(files: readonly string[]): number {
    let total = 0
    for (const file of files) total += sizeOf(file)
    return total
  }

  /** 删一个文件及其旁路文件。只用于本模块管理的文件名，调用方负责保证这一点。 */
  private removeAll(file: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(file + suffix)
      } catch {
        /* 不存在或删不掉（后者会在清空路径上显式报出来） */
      }
    }
  }
}

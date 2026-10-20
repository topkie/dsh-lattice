// 日志导出：把**全部保留的日志文件**（含轮换后的历史）按时间升序拼成一份 CSV。
//
// 三条约束都来自「导出是给人看的动作」：
//   1. **只读**：这里不 flush、不建库、不写任何一行。导出前后主库与日志库的
//      PRAGMA data_version 都不变。代价是「刚入队、还没 flush 的几十毫秒内的行」
//      不在文件里 —— 这是刻意选的：用户点导出时看到的应当是磁盘上已有的东西。
//   2. **只有白名单四列**：ts / level / event / detail。导出不改字段、不加字段；
//      用户拿到的就是已经白名单化的内容。
//   3. **有上限**：10 万行或 10 MB，谁先到就在那里截断，并在文件尾加一行 # truncated。
//      没有上限的导出等于让一次点击把整个日志库读进内存。
//
// 历史文件按文件名里的时间戳升序、当前库排最后：文件名记录的是「什么时候切出去的」，
// 而一个文件里的行一定比下一个文件里的行旧。

import { DatabaseSync } from 'node:sqlite'
import { logDirOf, logFilesIn } from './store.js'

/** 导出行数上限：10 万行。 */
export const LOG_EXPORT_MAX_ROWS = 100_000

/** 导出字节上限：10 MB。 */
export const LOG_EXPORT_MAX_BYTES = 10 * 1024 * 1024

/** CSV 表头。四列的顺序就是设计里定的顺序，导出侧与消费侧都不该自己改。 */
export const CSV_HEADER = 'ts,level,event,detail'

/** 截断标记。单独一行，以 # 开头 —— 它不是数据行，CSV 消费方可以整行忽略。 */
export const CSV_TRUNCATED = '# truncated'

/** 一次导出的结果。bytes 含表头与截断标记。 */
export interface LogExport {
  csv: string
  /** 数据行数（不含表头与截断标记）。 */
  rows: number
  truncated: boolean
  bytes: number
  /** 参与读取的日志文件数（读不了的文件不计入、也不让导出失败）。 */
  files: number
}

/** CSV 单元格转义：含逗号、引号或换行时整体加引号，内部引号翻倍。 */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value
}

/** 一行数据（detail 是 JSON 字符串，原样保留）。 */
function csvLine(ts: number, level: string, event: string, detail: string | null): string {
  return [String(ts), csvCell(level), csvCell(event), csvCell(detail ?? '')].join(',')
}

/** 读一个日志文件里的全部行；文件损坏或不存在时返回空数组（日志不是真相源，不让导出失败）。 */
function rowsOf(file: string): Array<{ ts: number; level: string; event: string; detail: string | null }> {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    return []
  }
  const out: Array<{ ts: number; level: string; event: string; detail: string | null }> = []
  try {
    const stmt = db.prepare('SELECT ts, level, event, detail FROM log ORDER BY ts, id')
    for (const raw of stmt.iterate() as Iterable<Record<string, unknown>>) {
      out.push({
        ts: Number(raw.ts),
        level: String(raw.level),
        event: String(raw.event),
        detail: raw.detail === null || raw.detail === undefined ? null : String(raw.detail),
      })
    }
  } catch {
    /* 打不开或没有 log 表：跳过这个文件 */
  } finally {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
  }
  return out
}

/**
 * 导出 CSV。
 *
 * `limits` 只在测试与嵌入方使用（构造 10 万行太慢）；插件路由始终用默认值。
 */
export function exportLogCsv(
  dataDir: string,
  limits: { maxRows?: number; maxBytes?: number } = {},
): LogExport {
  const maxRows = limits.maxRows ?? LOG_EXPORT_MAX_ROWS
  const maxBytes = limits.maxBytes ?? LOG_EXPORT_MAX_BYTES
  const files = logFilesIn(logDirOf(dataDir))
  const lines: string[] = [CSV_HEADER]
  let rows = 0
  let bytes = Buffer.byteLength(CSV_HEADER + '\n')
  let truncated = false
  let read = 0
  for (const file of files) {
    if (truncated) break
    const fileRows = rowsOf(file)
    read++
    for (const row of fileRows) {
      const line = csvLine(row.ts, row.level, row.event, row.detail)
      const lineBytes = Buffer.byteLength(line + '\n')
      if (rows + 1 > maxRows || bytes + lineBytes > maxBytes) {
        truncated = true
        break
      }
      lines.push(line)
      rows++
      bytes += lineBytes
    }
  }
  if (truncated) lines.push(CSV_TRUNCATED)
  const csv = lines.join('\n') + '\n'
  return { csv, rows, truncated, bytes: Buffer.byteLength(csv), files: read }
}

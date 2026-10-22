// 「不写库」的观测尺：从**另一个连接**上量。
//
// 为什么不能在被测连接上读 PRAGMA data_version：它只报告**别的连接**提交的改动，
// 本连接自己的写入在它眼里不算变化（实测：同一连接写入前后都读到同一个值）。
// 拿它当「这次操作没写库」的判据，断言恒真，等于没测。
//
// 为什么只读连接必须全程开着：新开的连接读到的是初值，与中间有没有写无关。
// 所以用法固定为——操作前 open，操作前后都用同一个实例 read，结束时 close。
//
// 量什么：data_version、user_version（结构版本），以及调用方点名的表各有多少行；
// recall_hits 是 atom 上的一列，单独按 SUM 量 —— 只改命中计数的写入不改行数。

import { DatabaseSync } from 'node:sqlite'

/** 默认量这几张表：写入、召回、体检路径会碰到的全部。 */
export const RULER_TABLES = ['atom', 'edge', 'topic', 'entry', 'atom_topic']

/**
 * 打开一把只读的观测尺。**必须在被测操作之前打开**，且操作前后用同一个实例读。
 *
 * tables 只接受代码里写死的表名（本文件与用例的字面量），不要传外部输入。
 */
export function openRuler(dbFile, tables = RULER_TABLES) {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  return {
    read() {
      const rows = {}
      for (const t of tables) {
        rows[t] = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n)
      }
      return {
        dataVersion: Number(db.prepare('PRAGMA data_version').get().data_version),
        userVersion: Number(db.prepare('PRAGMA user_version').get().user_version),
        recallHits: Number(db.prepare('SELECT COALESCE(SUM(recall_hits), 0) AS n FROM atom').get().n),
        rows,
      }
    },
    close() {
      db.close()
    },
  }
}

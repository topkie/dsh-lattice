// 校准样本库的物理层：一个**独立**的 SQLite 文件（<dataDir>/samples/recall-sample.db）。
//
// 为什么不放主库（与 src/log/store.ts 同一条纪律）：
//   1. 样本是**可丢、可重建**的旁路数据；主库是记忆的唯一真相源。两者保留策略不同
//      （样本 90 天淘汰、总量 1 万条，记忆不淘汰），放进同一个文件会让「清掉旧样本」
//      变成一次碰记忆库的写操作；
//   2. 「主库 sqlite_master 里没有 recall_sample」这条判据因此是**文件级事实**，
//      而不是「每条 SQL 都记得别写错库」；
//   3. 样本库损坏或被删掉时，召回与写入必须照常工作 —— 样本只服务重标。
//
// 为什么存向量而不存查询原文：原文是用户输入，进库等于给「用户问过什么」
// 留了一份比记忆本身更私密的副本；而重标（切点估计）只需要向量与 top1。
//
// **负样本的两档不建列**：`top1 < SAMPLE_OBVIOUS_MAX_TOP1`
// 是「明显无关」、`[SAMPLE_OBVIOUS_MAX_TOP1, SAMPLE_UNCERTAIN_MAX_TOP1]` 是「不确定带」——
// 档位是 top1 的函数，存第二遍就会与 top1 分叉（本项目反复吃过这个形态的亏）。
//
// 本文件是唯一知道样本库文件名与目录名的地方。

import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import type { ThresholdValue } from '../threshold-types.js'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deriveResourceParams } from '../util/memory.js'
import { decodeVec, encodeVec } from '../util/vec.js'

/** 样本目录名（位于 dataDir 之下）。 */
export const SAMPLES_DIR_NAME = 'samples'

/** 样本库文件名。 */
export const SAMPLE_DB_NAME = 'recall-sample.db'

/** 样本库自带的版本号（PRAGMA user_version）。与主库 SCHEMA_VERSION 无关，不混用。 */
export const SAMPLE_SCHEMA_VERSION = 1

/** 保留天数：90 天。 */
export const SAMPLE_RETAIN_DAYS = 90 satisfies ThresholdValue<
  'chosen',
  {
    why: '未标定：取 90 天，理由是「跨一个季度的对照仍有意义，再久语料族大概率已经变了」；这是判断而非实测，样本的实际衰减速率没有测过'
    failsWhen: ['语料族的更新周期', '重标频率']
    affects: '淘汰：写样本时删掉 created_at 早于「现在 - 90 天」的行'
  }
>

/** 总量上限：1 万条。超出按时间淘汰最旧。 */
export const SAMPLE_MAX_ROWS = 10000 satisfies ThresholdValue<
  'chosen',
  {
    why: '未标定：取 1 万条。10 万条向量约 200 MB 已明确不可行；1 万条是「够切点估计、又不超过一个普通库的量级」的判断，不是按样本量需求算出来的'
    failsWhen: ['切点估计所需的样本量', '愿意给的磁盘空间']
    affects: '总量：超过 1 万条时按 created_at 淘汰最旧的（约 20 MB：512 维 x 4 B x 1 万）'
  }
>

/** 「明显无关」负样本的上限：2000 条。 */
export const SAMPLE_NEG_OBVIOUS_MAX = 2000 satisfies ThresholdValue<
  'chosen',
  {
    why: '未标定：取 2000 条，理由是该档「对切点信息量低」，只需要少量代表；具体多少条够，要等 T46 的重标样本量与切点偏移实测'
    failsWhen: ['切点扫描对负样本数量的敏感度', '总条数上限']
    affects: '「明显无关」负样本的上限：满了删最旧的、保留最近 2000 条。「不确定带」的那一档不设上限（它才是切点信息的来源）'
  }
>

/** 「明显无关」的 top1 上界：低于它即明显无关。 */
export const SAMPLE_OBVIOUS_MAX_TOP1 = 0.4 satisfies ThresholdValue<
  'chosen',
  {
    why: '未标定：取 0.4 / 0.6 两条线，但没有说明依据；可对照的实测（view.ts 注释里的「无关查询 top1 上界」）量级相近但口径不同，不能当这条线的标定 —— 固定 0.4 在大库上会把「有点关系」的召回记成明显无关'
    failsWhen: ['库规模（无关 top1 随库长大上移）', '语料族', '编码模型']
    guardedBy: ['test/samples.test.mjs']
    affects: '负样本分档：top1 低于 0.4 记为「明显无关」（这一档有 2000 条上限）'
  }
>

/** 「不确定带」的 top1 上界：落在 [明显无关上界, 它] 之内优先保留。 */
export const SAMPLE_UNCERTAIN_MAX_TOP1 = 0.6 satisfies ThresholdValue<
  'chosen',
  {
    why: '未标定：取 0.6，与上一条同源 —— 两条线一起定，分开调没有意义；它们的位置应当由 T46 的切点扫描给出，本表只记录当前取值'
    failsWhen: ['库规模', '语料族', '编码模型', '切点的目标位置']
    guardedBy: ['test/samples.test.mjs']
    affects: '负样本分档：top1 在 0.4~0.6 记为「不确定带」（优先保留，供切点扫描）'
  }
>

/** 失效标记：换编码模型后旧样本**标失效不删**。 */
export const STALE_FLAG = 'stale_model'

/** 样本的正负。 */
export type SampleKind = 'positive' | 'negative'

/**
 * 样本来源（表结构的一列）。
 *
 * `feedback` 是模型显式反馈（lattice_feedback）；`annotation` 是用户标注；
 * `self_query` 是自查询正样本；`auto` 是自动收集的负样本。
 * 四种来源写进库是为了**重标时能按可信度分层**，不是为了展示。
 */
export type SampleSource = 'feedback' | 'annotation' | 'self_query' | 'auto'

/** 待落盘的一行（时间与模型名由模块层补齐，调用方只给语义字段）。 */
export interface SampleRow {
  /** 写入时刻（毫秒）。淘汰与「按时间取最近 N 条」都靠它。 */
  createdAt: number
  kind: SampleKind
  source: SampleSource
  /** 本次召回的 top1 余弦；无向量时为 0。 */
  top1: number
  /** 查询向量。**只存向量，不存原文**；编码器不可用时为 null。 */
  vec: Float32Array | null
  /** 命中的 atom id（1-based 序号在这里已解析完）；无命中时为空数组。 */
  hitIds: readonly number[]
  /** 写入时生效的编码模型名；换模型时据此标失效。 */
  encoderModel: string
}

/** 样本条数（ping 只报这三个数，不报任何原文）。 */
export interface SampleCounts {
  total: number
  positive: number
  negative: number
}

/** 淘汰与上限的取值。测试可传更小的值来构造淘汰，不必真攒 1 万条。 */
export interface SampleLimits {
  retainDays: number
  maxRows: number
  negObviousMax: number
}

export const DEFAULT_SAMPLE_LIMITS: SampleLimits = {
  retainDays: SAMPLE_RETAIN_DAYS,
  maxRows: SAMPLE_MAX_ROWS,
  negObviousMax: SAMPLE_NEG_OBVIOUS_MAX,
}

/** 样本目录：<dataDir>/samples。 */
export function sampleDirOf(dataDir: string): string {
  return join(dataDir, SAMPLES_DIR_NAME)
}

/** 样本库文件路径：排障时要知道它在哪，但**不要**把它写进日志。 */
export function sampleFilePath(dataDir: string): string {
  return join(sampleDirOf(dataDir), SAMPLE_DB_NAME)
}

/** 建表语句（只此一份；测试与文档都以它为准）。 */
const SAMPLE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS recall_sample (
    id            INTEGER PRIMARY KEY,
    created_at    INTEGER NOT NULL,
    kind          TEXT    NOT NULL,
    source        TEXT    NOT NULL,
    top1          REAL    NOT NULL,
    vec           BLOB,
    hit_ids       TEXT,
    flags         TEXT    NOT NULL DEFAULT '',
    encoder_model TEXT    NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS recall_sample_created ON recall_sample(created_at)`,
  `CREATE INDEX IF NOT EXISTS recall_sample_kind ON recall_sample(kind, source)`,
]

/**
 * 样本库句柄。**懒打开**：构造不碰磁盘，第一次 append 才建库、设 PRAGMA。
 *
 * 与 LogStore 的差别只有一处：这里**不轮换文件**。样本的容量由行数与天数控制，
 * 一条向量的字节数固定（VEC_DIM x 4），所以「文件多大」是可以直接从行数推出来的，
 * 再叠一层按文件大小的轮换只会多一种半满状态。
 */
export class SampleStore {
  readonly dir: string
  readonly file: string
  private readonly limits: SampleLimits
  private db: DatabaseSync | null = null

  constructor(dataDir: string, limits: SampleLimits = DEFAULT_SAMPLE_LIMITS) {
    this.dir = sampleDirOf(dataDir)
    this.file = join(this.dir, SAMPLE_DB_NAME)
    this.limits = limits
  }

  /**
   * 批量落盘：一个事务。
   *
   * 失败**直接抛出**：降级到内存、限频记日志属于模块级策略（见 src/samples/index.ts），
   * 不是文件操作的一部分 —— 与 LogStore.append 同一条分工。
   */
  append(rows: readonly SampleRow[]): void {
    if (rows.length === 0) return
    this.open()
    const db = this.db
    if (db === null) throw new Error('样本库未打开')
    db.exec('BEGIN')
    try {
      this.markStaleModels(db, rows)
      const ins = db.prepare(
        'INSERT INTO recall_sample (created_at, kind, source, top1, vec, hit_ids, flags, encoder_model) ' +
          "VALUES (?, ?, ?, ?, ?, ?, '', ?)",
      )
      for (const r of rows) {
        if (r.kind === 'negative' && r.source === 'auto' && r.top1 < SAMPLE_OBVIOUS_MAX_TOP1) {
          this.makeRoomForObvious(db)
        }
        ins.run(
          r.createdAt,
          r.kind,
          r.source,
          r.top1,
          r.vec === null ? null : encodeVec(r.vec),
          r.hitIds.length > 0 ? JSON.stringify(r.hitIds) : null,
          r.encoderModel,
        )
      }
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 事务可能已经结束 */
      }
      throw err
    }
    this.prune()
  }

  /** 按 kind 计数。ping 用它报条数。 */
  counts(): SampleCounts {
    this.open()
    const db = this.db
    if (db === null) return { total: 0, positive: 0, negative: 0 }
    const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM recall_sample GROUP BY kind').all() as Array<{
      kind: string
      n: number | bigint
    }>
    let positive = 0
    let negative = 0
    for (const row of rows) {
      if (row.kind === 'positive') positive = Number(row.n)
      else if (row.kind === 'negative') negative = Number(row.n)
    }
    return { total: positive + negative, positive, negative }
  }

  /**
   * 读出用于重标的样本（T44 判据 3/5/7 的输入）。
   *
   * 三条纪律写在这里，而不是让调用方各自实现：
   *   ① **跳过失效样本**（换过编码模型的旧行）：它们的 top1 是在另一个向量空间里量的，混进来会把切点拽偏；
   *   ② **只读、不写库**：重标的写入走 lattice-calib 的单事务快照；
   *   ③ 按时间倒序取上限条数 —— 分层取样（不确定带全取、明显无关取最近 N 条）由调用方
   *      按 top1 分档决定，库这一层只管把「候选」交出去。
   */
  readForCalibration(limit: number): Array<{
    kind: 'positive' | 'negative'
    source: string
    top1: number
    vec: Float32Array | null
    encoderModel: string
  }> {
    this.open()
    const db = this.db
    if (db === null) return []
    const rows = db
      .prepare(
        'SELECT kind, source, top1, vec, encoder_model FROM recall_sample ' +
          "WHERE flags = '' ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(limit) as Array<{
      kind: string
      source: string
      top1: number
      vec: Uint8Array | null
      encoder_model: string
    }>
    return rows.map((r) => ({
      kind: r.kind === 'positive' ? ('positive' as const) : ('negative' as const),
      source: String(r.source),
      top1: Number(r.top1),
      vec: r.vec === null ? null : decodeVec(r.vec as Uint8Array),
      encoderModel: String(r.encoder_model),
    }))
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

  /**
   * 换模型：把「不是当前模型」的旧样本标失效，**不删**。
   *
   * 空模型名（编码器关掉）不参与：那时的样本本来就没有向量，拿它去标失效等于
   * 「用户临时关一次编码器，历史样本全变废纸」—— 而它们与模型无关。
   *
   * 只标 flags，不改 created_at：失效样本仍要能被「按时间取最近 N 条」取到，
   * 否则「留作对照」就落空了。
   */
  private markStaleModels(db: DatabaseSync, rows: readonly SampleRow[]): void {
    const models = new Set(rows.map((r) => r.encoderModel).filter((m) => m !== ''))
    for (const model of models) {
      db.prepare('UPDATE recall_sample SET flags = ? WHERE encoder_model <> ? AND instr(flags, ?) = 0').run(
        STALE_FLAG,
        model,
        STALE_FLAG,
      )
    }
  }

  /**
   * 给「明显无关」负样本腾位置：满了就删最旧的，保留最近 2000 条。
   *
   * 为什么删最旧而不是「满了就不再写」：明显无关这一档的用途是「取最近 N 条」做
   * 分层取样；一个冻结在库里、永远是同一批的 2000 条，对切点没有新的信息。
   */
  private makeRoomForObvious(db: DatabaseSync): void {
    const n = Number(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM recall_sample WHERE kind = ? AND source = ? AND top1 < ?')
          .get('negative', 'auto', SAMPLE_OBVIOUS_MAX_TOP1) as { n: number | bigint }
      ).n,
    )
    if (n < this.limits.negObviousMax) return
    db.prepare(
      'DELETE FROM recall_sample WHERE id IN (' +
        'SELECT id FROM recall_sample WHERE kind = ? AND source = ? AND top1 < ? ' +
        'ORDER BY created_at ASC, id ASC LIMIT ?)',
    ).run('negative', 'auto', SAMPLE_OBVIOUS_MAX_TOP1, n - this.limits.negObviousMax + 1)
  }

  /**
   * 保留策略：先按天数删（90 天），再按总量删最旧（1 万条）。
   *
   * 两条都跑、不互相顶替：一个久不使用的小库靠天数清干净，一个高频使用的大库靠
   * 行数封顶 —— 只有一条时，另一种使用方式就会让库无限长。
   */
  private prune(): void {
    const db = this.db
    if (db === null) return
    const cutoff = Date.now() - this.limits.retainDays * 24 * 60 * 60 * 1000
    db.prepare('DELETE FROM recall_sample WHERE created_at < ?').run(cutoff)
    const n = Number(
      (db.prepare('SELECT COUNT(*) AS n FROM recall_sample').get() as { n: number | bigint }).n,
    )
    if (n <= this.limits.maxRows) return
    db.prepare(
      'DELETE FROM recall_sample WHERE id IN (' +
        'SELECT id FROM recall_sample ORDER BY created_at ASC, id ASC LIMIT ?)',
    ).run(n - this.limits.maxRows)
  }

  /** 打开连接：建目录、建表。版本不符（或库损坏）时**重建**，不迁移。 */
  private open(): void {
    if (this.db !== null) return
    mkdirSync(this.dir, { recursive: true })
    let db: DatabaseSync | null = null
    try {
      db = this.openFresh()
      if (this.schemaVersionOf(db) !== SAMPLE_SCHEMA_VERSION) {
        db.close()
        db = null
        this.removeAll()
        db = this.openFresh()
      }
      this.db = db
    } catch {
      try {
        db?.close()
      } catch {
        /* 忽略 */
      }
      // 再失败就让异常抛给上层（降级到内存），不在这里无限重试。
      this.removeAll()
      this.db = this.openFresh()
    }
  }

  /** 建库并设 PRAGMA、建表。第一次创建与重建共用。 */
  private openFresh(): DatabaseSync {
    const db = new DatabaseSync(this.file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = ' + deriveResourceParams(0).busyTimeout)
    db.exec('PRAGMA user_version = ' + SAMPLE_SCHEMA_VERSION)
    for (const stmt of SAMPLE_DDL) db.exec(stmt)
    return db
  }

  /** 读 PRAGMA user_version；读不到按 0（新建的库）处理。 */
  private schemaVersionOf(db: DatabaseSync): number {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number | bigint } | undefined
    return Number(row?.user_version ?? 0)
  }

  /** 删本库文件及旁路文件（只在本库路径上调用）。 */
  private removeAll(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      if (!existsSync(this.file + suffix)) continue
      try {
        unlinkSync(this.file + suffix)
      } catch {
        /* 删不掉时交给上层：下一次 append 会以「打不开」的形式报出来 */
      }
    }
  }
}

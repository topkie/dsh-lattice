// 运行时状态：数据库连接与编码器都**懒初始化**，并且每个进程只有一份。
//
// 为什么必须懒：插件激活只做注册。模型加载要几十秒、建库要写文件，
// 放在激活路径上会拖慢宿主启动 —— 而用户可能整场会话都不用记忆功能。
//
// 为什么必须单例：SQLite 的 WAL 允许一写多读，但同一进程开多个连接写会互相
// 争锁；编码器更是不能重复加载模型（显存/内存翻倍）。

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ensureMeta, META_BUILDER, META_ENTRY_RULE, META_SCHEMA_VERSION } from './db/meta.js'
import { openVault } from './db/open.js'
import { SCHEMA_VERSION } from './db/schema.js'
import { CALIB_VERSION, TIER_SCALE_STABLE_ATOMS, readSnapshotState, type CalibParams } from 'lattice-calib'
import { encode, encoderErrorCode, ensureEncoder, type EncoderOptions } from './encoder/index.js'
import { closeLog, configureLog, logEvent } from './log/index.js'
import { ENTRY_RULE_ID } from './pipeline/entries.js'
import type { RecallMeta } from './pipeline/search.js'
import { closeSamples, configureSamples } from './samples/index.js'
import { createWriteCtx, type WriteCtx, type WriteThresholds } from './pipeline/write.js'

/** 插件传给运行时的配置（已解析默认值的形状）。 */
export interface RuntimeConfig {
  dataDir: string
  encoderEnabled: boolean
  encoderModel: string
  encoderMirror: string
  encoderCacheDir: string
  thresholds: WriteThresholds
  viewBudget: number
  topN: number
  /** 校准样本的**自动收集**开关（默认开）。显式 lattice_feedback 不受它影响。 */
  samplesEnabled: boolean
  resources: { mmapSize?: number; cacheSize?: number; busyTimeout?: number }
}

/**
 * 标定状态的两种取值与四种原因（T44 / 裁决 #28）。
 *
 * **为什么不把「未标定」压成一个布尔**：never（从来没标过）、small_db（库太小，标了也不可信）、
 * model_changed（换过编码模型）、snapshot_invalid（快照坏了或版本不符）四者的补救动作不同 ——
 * 前两者是「等条件成熟」，后两者是「需要重标或修快照」。压缩之后这些区别就没了。
 */
export type CalibrationReason = 'never' | 'no_positive' | 'model_changed' | 'snapshot_invalid' | 'small_db'

export interface CalibrationState {
  state: 'calibrated' | 'uncalibrated'
  /** 未标定时说明原因；已标定时不带。 */
  reason?: CalibrationReason
  /**
   * 快照里的参数；未标定时为 **null**（调用方回落到「按库规模插值」的发布方锚点表）。
   *
   * 不在这里塞一个默认值：那样调用方就分不清「读到的是本地标定值」还是「插值值」。
   */
  params: CalibParams | null
}

export interface Runtime {
  db: DatabaseSync
  /** 写入上下文：带编码器绑定与阈值。 */
  write: WriteCtx
  cfg: RuntimeConfig
  /** 库文件路径，健康检查与排障要用。 */
  file: string
  /** 标定状态（T44）：快照可用则给出参数，否则说明为什么不可用。 */
  calibration: CalibrationState
}

let current: Runtime | null = null

/**
 * 解析数据目录。
 *
 * 优先级：显式配置 > DSH_HOME/lattice > ~/.dsh/lattice。
 * 不用 process.cwd()：宿主的工作目录会变，把库放在那里等于每次换目录就换一个库。
 */
export function resolveDataDir(configured: string): string {
  if (configured !== '') return configured
  const home = process.env?.DSH_HOME || (homedir() ? join(homedir(), '.dsh') : '')
  if (home !== '') return join(home, 'lattice')
  // 宿主环境拿不到 home 时退到当前目录 —— 不理想，但比抛错好，且会在 ping 里暴露出来。
  return join(process.cwd(), '.lattice')
}

/** 取（必要时创建）运行时。同一进程内只初始化一次。 */
export function getRuntime(cfg: RuntimeConfig): Runtime {
  if (current !== null) return current
  const dir = resolveDataDir(cfg.dataDir)
  mkdirSync(dir, { recursive: true })
  // 日志库与记忆库同目录、不同文件。这里只登记 dataDir，不碰磁盘 ——
  // 建日志库要等第一条降级事件（见 src/log/index.ts 的 LogStore 懒打开）。
  configureLog(dir)
  // 样本库同目录、不同文件（<dataDir>/samples/recall-sample.db）：同样只登记目录，
  // 建库推迟到第一条样本（见 src/samples/index.ts 的懒打开）。
  configureSamples(dir, { enabled: cfg.samplesEnabled !== false, model: cfg.encoderModel })
  const file = join(dir, 'lattice.db')
  const { db } = openVault(file, { resources: cfg.resources })
  stampVault(db)
  const encoderOpts: EncoderOptions = {
    model: cfg.encoderModel,
    remoteHost: cfg.encoderMirror || undefined,
    cacheDir: cfg.encoderCacheDir || undefined,
  }
  const write = createWriteCtx(db, cfg.thresholds, {
    encode: cfg.encoderEnabled === false ? undefined : (text: string) => encode(text, encoderOpts),
  })
  // 标定状态在打开库之后立刻算一次：召回路径要用它给出的参数，晚算就等于先跑一会儿默认值。
  const calibration = readCalibration(db, cfg)
  noteCalibration(calibration)
  current = { db, write, cfg, file, calibration }
  return current
}

/** 上一次报过的标定状态。按**状态变化**记日志 —— 与编码器失败同一条口径。 */
let lastCalibrationKey: string | null = null

/**
 * 读库里的标定快照，给出「这次运行时到底用哪套参数」（T44）。
 *
 * 顺序是有意的：先判快照在不在，再判版本，最后判模型。反过来会把「快照坏了」
 * 报成「换过模型」—— 那是两个不同的补救动作（修快照 vs 重标）。
 */
function readCalibration(db: DatabaseSync, cfg: RuntimeConfig): CalibrationState {
  const atoms = Number((db.prepare('SELECT COUNT(*) AS n FROM atom').get() as { n: number | bigint }).n)
  const snap = readSnapshotState(db)
  if (snap.state === 'missing') {
    // 库太小的时候「从未标定」不是异常，是条件没到 —— 用户看到的原因应当是这个。
    return {
      state: 'uncalibrated',
      params: null,
      reason: atoms < TIER_SCALE_STABLE_ATOMS ? 'small_db' : 'never',
    }
  }
  if (snap.state !== 'ok') return { state: 'uncalibrated', params: null, reason: 'snapshot_invalid' }
  // 版本不符：参数形状可能已经变了，按「丢弃」处理，不猜。
  if (snap.snapshot.calibVersion !== CALIB_VERSION) {
    return { state: 'uncalibrated', params: null, reason: 'snapshot_invalid' }
  }
  // 换模型：向量空间变了，旧切点不再可比。标「失效」而不是删（样本与快照都留着作对照）。
  if (snap.snapshot.encoderModel !== cfg.encoderModel) {
    return { state: 'uncalibrated', params: null, reason: 'model_changed' }
  }
  return { state: 'calibrated', params: snap.snapshot.params }
}

/**
 * 标定状态变化时留痕（判据 2/4：未标定不许静默）。
 *
 * 已标定不记 —— 正常状态不需要进日志，记了只会把真问题挤出去。
 */
function noteCalibration(cal: CalibrationState): void {
  const key = cal.state + ':' + (cal.reason ?? '')
  if (key === lastCalibrationKey) return
  lastCalibrationKey = key
  if (cal.state === 'calibrated') return
  if (cal.reason === 'snapshot_invalid') {
    logEvent('warn', 'calib.snapshot_invalid', { field: 'calib_version' })
    logEvent('warn', 'calib.unlocalized', { reason: 'snapshot_invalid' })
    return
  }
  if (cal.reason === 'never') logEvent('warn', 'calib.snapshot_missing')
  logEvent('warn', 'calib.unlocalized', { reason: cal.reason ?? 'never' })
}

/** 补上库的自描述，**已存在的一律不动**。
 *
 * 为什么是 ensure 而不是 set：库若是另一套入口规则生成的，覆盖元数据只会把
 * 「不一致」这个事实抹掉 —— 而它恰恰是需要被看见的东西（由 checkEntryRule 报告）。
 */
function stampVault(db: DatabaseSync): void {
  ensureMeta(db, META_SCHEMA_VERSION, String(SCHEMA_VERSION))
  ensureMeta(db, META_ENTRY_RULE, ENTRY_RULE_ID)
  ensureMeta(db, META_BUILDER, 'runtime')
}

/** 上一次报过的编码器失败原因。按**状态变化**记日志，避免同一原因把日志库刷满。 */
let lastEncoderFailure: string | null = null

/** 编码器是否可用（供工具决定是否走纯词面路径）。 */
export async function runtimeEncoderReady(cfg: RuntimeConfig): Promise<boolean> {
  if (cfg.encoderEnabled === false) return false
  const ok = await ensureEncoder({
    model: cfg.encoderModel,
    remoteHost: cfg.encoderMirror || undefined,
    cacheDir: cfg.encoderCacheDir || undefined,
  })
  noteEncoderState(ok)
  return ok
}

/** 编码一段查询文本；不可用时返回 null（由调用方走纯词面）。 */
export async function runtimeEncode(cfg: RuntimeConfig, text: string): Promise<Float32Array | null> {
  if (cfg.encoderEnabled === false) return null
  if (!(await runtimeEncoderReady(cfg))) return null
  const vec = await encode(text, {
    model: cfg.encoderModel,
    remoteHost: cfg.encoderMirror || undefined,
    cacheDir: cfg.encoderCacheDir || undefined,
  })
  // 加载成功、但这一条编码失败（输出形状异常等）同样是降级，照样留痕。
  noteEncoderState(vec !== null)
  return vec
}

/**
 * 编码器状态变化 → 一条 encoder.unavailable。
 *
 * 为什么按变化记而不是逐次记：加载失败后进程会停在 unavailable，而每次召回都会走到
 * 这里。逐次记会让日志库被同一个已知状态刷满（单文件阈值只有 4 MB），
 * 真正的新故障反而被挤掉。恢复可用时清掉游标，下一次故障重新记。
 *
 * 只记错误码/类名（encoderErrorCode），**不记消息原文**：消息里可能有模型缓存路径。
 */
function noteEncoderState(ok: boolean): void {
  if (ok) {
    lastEncoderFailure = null
    return
  }
  const reason = encoderErrorCode() ?? 'unknown'
  if (lastEncoderFailure === reason) return
  lastEncoderFailure = reason
  logEvent('warn', 'encoder.unavailable', { reason })
}

/** 上一次召回的三类降级状态（同样按变化记）。 */
let lastRecallDegraded = { vectorMissing: false, lexicalDegraded: false, shortTermMiss: false }

/**
 * 召回降级埋点：只读 RecallMeta 里的布尔，**不接触查询文本**。
 *
 * 工具召回与界面搜索两条路径各调一次；logEvent 只入队，不在召回路径上加同步 IO。
 * 状态回到正常时不记事件（日志里没有「一切正常」这一档），只把游标复位。
 */
export function noteRecallDegradations(meta: RecallMeta): void {
  if (meta.vectorMissing && !lastRecallDegraded.vectorMissing) logEvent('warn', 'recall.vector_missing')
  if (meta.lexicalDegraded && !lastRecallDegraded.lexicalDegraded) logEvent('warn', 'recall.lexical_degraded')
  if (meta.shortTermMiss && !lastRecallDegraded.shortTermMiss) logEvent('warn', 'recall.short_term_miss')
  lastRecallDegraded = {
    vectorMissing: meta.vectorMissing,
    lexicalDegraded: meta.lexicalDegraded,
    shortTermMiss: meta.shortTermMiss,
  }
}

/** 关闭运行时（测试与热更新用）。日志库一起关：先 flush 再 close。 */
export function closeRuntime(): void {
  try {
    current?.db.close()
  } catch {
    /* 已关闭 */
  }
  current = null
  // 游标随运行时一起复位：换库后「第一次失败」必须能重新留下痕迹。
  lastEncoderFailure = null
  lastRecallDegraded = { vectorMissing: false, lexicalDegraded: false, shortTermMiss: false }
  // 样本库先关：它与会话级「最近一次召回」一起复位，给下一次运行时一个干净的起点。
  closeSamples()
  closeLog()
}

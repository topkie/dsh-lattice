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
import { ensureBuildInfo } from './db/build-info.js'
import { openVault } from './db/open.js'
import { encode, encoderErrorCode, ensureEncoder, sourceList, type EncoderOptions } from './encoder/index.js'
import { closeLog, configureLog, log } from './log/index.js'
import { ENTRY_RULE_ID } from './pipeline/entries.js'
import type { RecallMeta } from './pipeline/search.js'
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

  resources: { mmapSize?: number; cacheSize?: number; busyTimeout?: number }
}

export interface Runtime {
  db: DatabaseSync
  /** 写入上下文：带编码器绑定与阈值。 */
  write: WriteCtx
  cfg: RuntimeConfig
  /** 库文件路径，健康检查与排障要用。 */
  file: string
  /** 打开这份运行时的那套配置的指纹：变了就说明该换连接（见 runtimeKey）。 */
  key: string
  /** 创建这份运行时的插件实例凭据：卸载时只关自己那一代（见 closeRuntimeIfOwner）。 */
  owner: object | null
  /**
   * 本进程内召回了几次。只用来决定「该写记忆了」那条提示什么时候出现。
   *
   * 为什么记在进程里而不是库里：这是「这一次用得怎么样」的计数，与记忆内容无关。
   * 写进库要多一张表、多一次写，还得决定什么时候清零 —— 而进程重启就是最自然的清零。
   */
  recallTicks?: number
  /** 本进程内写入过几次。非零之后不再提示「该写了」—— 明显知道怎么写的人不需要被提醒。 */
  writesSeen?: number
}

let current: Runtime | null = null
/** 最近一次 apply 的凭据。卸载时用它判断「这份运行时是不是我开的」。 */
let activeOwner: object | null = null

/**
 * 登记本次插件实例的凭据。
 *
 * 为什么需要：`current` 是模块级单例，热重载时新旧两个实例共用它。如果宿主先挂新实例、
 * 后卸旧实例，旧实例的清理函数会把**新**连接关掉。带上凭据之后，只关自己开的那一份。
 */
export function ownRuntime(owner: object | null): void {
  activeOwner = owner
}

/**
 * 配置指纹：只收**影响已打开资源**的项。
 *
 * 不能整体序列化 cfg：`viewBudget` / `topN` 是 liveNumber 的 getter（见 src/index.ts），
 * 每次序列化都会求值，值一变就比较不等 —— 结果会是每次工具调用都重开库。
 */
function runtimeKey(cfg: RuntimeConfig, file: string): string {
  return JSON.stringify([
    file,
    cfg.encoderEnabled,
    cfg.encoderModel,
    cfg.encoderMirror,
    cfg.encoderCacheDir,
    cfg.thresholds,
    cfg.resources,
  ])
}

/**
 * 解析数据目录。
 *
 * 优先级：显式配置 > DSH_HOME/lattice > ~/.dsh/lattice。
 * 不用 process.cwd()：宿主的工作目录会变，把库放在那里等于每次换目录就换一个库。
 */
export function resolveDataDir(configured?: string): string {
  if (typeof configured === 'string' && configured !== '') return configured
  const home = process.env?.DSH_HOME || (homedir() ? join(homedir(), '.dsh') : '')
  if (home !== '') return join(home, 'lattice')
  // 宿主环境拿不到 home 时退到当前目录 —— 不理想，但比抛错好，且会在 ping 里暴露出来。
  return join(process.cwd(), '.lattice')
}

/**
 * 从配置算出编码器选项。
 *
 * 三处调用点（建运行时、探测可用、编码文本）原先各自构造同一份对象 ——
 * 于是「候选源怎么排」会有三个说法。收成一处，改顺序只改这里。
 */
function encoderOptionsOf(cfg: RuntimeConfig): EncoderOptions {
  return {
    model: cfg.encoderModel,
    sources: sourceList(cfg.encoderMirror),
    cacheDir: cfg.encoderCacheDir || undefined,
  }
}

/** 取（必要时创建）运行时。同一进程内只初始化一次。 */
export function getRuntime(cfg: RuntimeConfig): Runtime {
  // 空配置表示「拿当前那份」：测试里多处写成 getRuntime({})，热重载期间也可能有人这么问。
  // 不把「没给 dataDir」当成「换回默认目录」—— 否则这种调用会中途把库切到别处。
  const dirGiven = typeof cfg.dataDir === 'string' && cfg.dataDir !== ''
  if (!dirGiven && current !== null) return current
  const dir = resolveDataDir(dirGiven ? cfg.dataDir : undefined)
  const file = join(dir, 'lattice.db')
  // 只按**库文件**判断要不要换连接：换 dataDir 必须重开（不同文件）；换编码器或阈值只是
  // 让新配置生效，连接可以留着 —— 关掉再开既慢，也会让手头还拿着旧连接引用的调用方
  // 撞上 database is not open。
  if (current !== null && current.file === file) {
    refreshRuntime(current, cfg)
    return current
  }
  if (current !== null) closeRuntime()
  mkdirSync(dir, { recursive: true })
  // 日志库与记忆库同目录、不同文件。这里只登记 dataDir，不碰磁盘 ——
  // 建日志库要等第一条降级事件（见 src/log/index.ts 的 LogStore 懒打开）。
  configureLog(dir)

  const { db } = openVault(file, { resources: cfg.resources })
  stampVault(db)
  const encoderOpts: EncoderOptions = encoderOptionsOf(cfg)
  const write = createWriteCtx(db, cfg.thresholds, {
    encode: cfg.encoderEnabled === false ? undefined : (text: string) => encode(text, encoderOpts),
  })
  current = { db, write, cfg, file, key: runtimeKey(cfg, file), owner: activeOwner }
  return current
}

/**
 * 同一个库换了配置：就地换掉配置与写入上下文，不关连接。
 *
 * 热重载只改编码器或阈值时走这里。指纹相同就直接返回 —— 每次调用都重建写入上下文
 * 没有意义，热路径上还白花一次分配。
 */
function refreshRuntime(rt: Runtime, cfg: RuntimeConfig): void {
  const key = runtimeKey(cfg, rt.file)
  if (rt.key === key) return
  const encoderOpts: EncoderOptions = encoderOptionsOf(cfg)
  rt.write = createWriteCtx(rt.db, cfg.thresholds, {
    encode: cfg.encoderEnabled === false ? undefined : (text: string) => encode(text, encoderOpts),
  })
  rt.cfg = cfg
  rt.key = key
}

/** 补上库的自描述，**已存在的一律不动**。
 *
 * 为什么是 ensure 而不是 set：库若是另一套入口规则生成的，覆盖元数据只会把
 * 「不一致」这个事实抹掉 —— 而它恰恰是需要被看见的东西（由 checkEntryRule 报告）。
 *
 * 不再记 schema 版本：版本号的唯一真相源是 PRAGMA user_version。旧实现另存了一份
 * schema_version 键，两份值在真实库里漂成了 4 与 3。
 */
function stampVault(db: DatabaseSync): void {
  ensureBuildInfo(db, { entryRule: ENTRY_RULE_ID, builder: 'runtime' })
}

/** 上一次报过的编码器失败原因。按**状态变化**记日志，避免同一原因把日志库刷满。 */
let lastEncoderFailure: string | null = null

/** 编码器是否可用（供工具决定是否走纯词面路径）。 */
export async function runtimeEncoderReady(cfg: RuntimeConfig): Promise<boolean> {
  if (cfg.encoderEnabled === false) return false
  const ok = await ensureEncoder(encoderOptionsOf(cfg))
  noteEncoderState(ok)
  return ok
}

/** 编码一段查询文本；不可用时返回 null（由调用方走纯词面）。 */
export async function runtimeEncode(cfg: RuntimeConfig, text: string): Promise<Float32Array | null> {
  if (cfg.encoderEnabled === false) return null
  if (!(await runtimeEncoderReady(cfg))) return null
  const vec = await encode(text, encoderOptionsOf(cfg))
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
  log.warn('encoder.unavailable', { reason })
}

/** 上一次召回的三类降级状态（同样按变化记）。 */
let lastRecallDegraded = { vectorMissing: false, lexicalDegraded: false, shortTermMiss: false }

/**
 * 召回降级埋点：只读 RecallMeta 里的布尔，**不接触查询文本**。
 *
 * 工具召回与界面搜索两条路径各调一次；写日志只入队，不在召回路径上加同步 IO。
 * 状态回到正常时不记事件（日志里没有「一切正常」这一档），只把游标复位。
 */
export function noteRecallDegradations(meta: RecallMeta): void {
  if (meta.vectorMissing && !lastRecallDegraded.vectorMissing) log.warn('recall.vector_missing')
  if (meta.lexicalDegraded && !lastRecallDegraded.lexicalDegraded) log.warn('recall.lexical_degraded')
  if (meta.shortTermMiss && !lastRecallDegraded.shortTermMiss) log.warn('recall.short_term_miss')
  lastRecallDegraded = {
    vectorMissing: meta.vectorMissing,
    lexicalDegraded: meta.lexicalDegraded,
    shortTermMiss: meta.shortTermMiss,
  }
}

/**
 * 关闭运行时。日志库一起关：先 flush 再 close（closeLog 幂等，重复调用安全）。
 *
 * 三个调用方：测试、热重载换配置（见 getRuntime）、插件卸载（见 closeRuntimeIfOwner）。
 */
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
  closeLog()
}

/**
 * 只有在「这份运行时确实是这个实例开的」时才关。
 *
 * 卸载路径上的正确性：热重载时新旧实例共用模块级单例，直接 closeRuntime() 会把
 * 另一个实例刚打开的连接关掉（不丢数据，但会多开一次库、清掉进程内计数）。
 */
export function closeRuntimeIfOwner(owner: object): void {
  if (current === null || current.owner !== owner) return
  closeRuntime()
}

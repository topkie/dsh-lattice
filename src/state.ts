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
import { encode, ensureEncoder, type EncoderOptions } from './encoder/index.js'
import { ENTRY_RULE_ID } from './pipeline/entries.js'
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
  current = { db, write, cfg, file }
  return current
}

/**
 * 补上库的自描述，**已存在的一律不动**。
 *
 * 为什么是 ensure 而不是 set：库若是另一套入口规则生成的，覆盖元数据只会把
 * 「不一致」这个事实抹掉 —— 而它恰恰是需要被看见的东西（由 checkEntryRule 报告）。
 */
function stampVault(db: DatabaseSync): void {
  ensureMeta(db, META_SCHEMA_VERSION, String(SCHEMA_VERSION))
  ensureMeta(db, META_ENTRY_RULE, ENTRY_RULE_ID)
  ensureMeta(db, META_BUILDER, 'runtime')
}

/** 编码器是否可用（供工具决定是否走纯词面路径）。 */
export async function runtimeEncoderReady(cfg: RuntimeConfig): Promise<boolean> {
  if (cfg.encoderEnabled === false) return false
  return ensureEncoder({
    model: cfg.encoderModel,
    remoteHost: cfg.encoderMirror || undefined,
    cacheDir: cfg.encoderCacheDir || undefined,
  })
}

/** 编码一段查询文本；不可用时返回 null（由调用方走纯词面）。 */
export async function runtimeEncode(cfg: RuntimeConfig, text: string): Promise<Float32Array | null> {
  if (cfg.encoderEnabled === false) return null
  if (!(await runtimeEncoderReady(cfg))) return null
  return encode(text, {
    model: cfg.encoderModel,
    remoteHost: cfg.encoderMirror || undefined,
    cacheDir: cfg.encoderCacheDir || undefined,
  })
}

/** 关闭运行时（测试与热更新用）。 */
export function closeRuntime(): void {
  try {
    current?.db.close()
  } catch {
    /* 已关闭 */
  }
  current = null
}

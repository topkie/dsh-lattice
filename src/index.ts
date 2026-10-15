// dsh-lattice（记忆晶格）— DSH 记忆插件：无 LLM 依赖，本地向量检索 + Atom 级结构化记忆。
//
// 插件只做两件事：
//   1. 导出符合 Cordis 契约的接口（name / inject / Config / apply）
//   2. 注册四个工具：ping（健康检查）、write、recall、expand
//
// **只有工具，没有 hook**：禁用 LLM 后「轮次结束自动沉淀」必然要调 LLM 做结构化，
// 与本插件的定位冲突。写入与召回都必须是显式动作。

import { readFileSync } from 'node:fs'
import { deriveResourceParams } from './util/memory.js'
import { resolveDataDir, type RuntimeConfig } from './state.js'
import { buildTools } from './tools/index.js'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** 插件名（Cordis 用它在 profile 里定位与管理本插件）。 */
export const name = 'lattice'

/** 依赖的宿主服务：工具注册表。 */
export const inject = ['tools'] as const

/** 插件版本，取自 package.json（构建产物位于 dist/，故上一级即包根）。 */
const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/**
 * 插件配置 schema。
 *
 * 阈值默认值：向量余弦与词面重叠必须**同时**满足，才允许并入已有主题。
 *
 * 为什么需要两票：在技术类文本上，不同主题的余弦相似度可以高达 0.73，而同一主题
 * 最低约 0.75——区间重叠，单靠余弦会把不同主题静默合并。词面重叠的区分度更高，
 * 两者互补。这些值是初值，应随真实语料重新标定。
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 数据目录；留空表示 <数据目录>/lattice */
  dataDir: z.string().default(''),
  /** 关掉即纯词面模式（降级路径） */
  encoderEnabled: z.boolean().default(true),
  encoderModel: z.string().default('Xenova/bge-small-zh-v1.5'),
  /** 模型下载源；留空用官方源，网络受限环境可指向镜像 */
  encoderMirror: z.string().default(''),
  /** 模型缓存目录；留空用运行时默认位置 */
  encoderCacheDir: z.string().default(''),
  /** 并入阈值（余弦） */
  tauJoin: z.number().min(0.6).max(0.95).default(0.78),
  /** 并入所需的词面重叠（bigram-Jaccard；实测标定依据见 pipeline/write.ts） */
  tauLex: z.number().min(0.02).max(0.5).default(0.05),
  /** 无向量（encoder 降级）时并入所需的词面重叠 */
  tauLexOnly: z.number().min(0.02).max(0.6).default(0.1),
  /** 新建主题阈值 */
  tauNew: z.number().min(0.2).max(0.8).default(0.5),
  /** 注入字符预算 */
  viewBudget: z.number().min(1000).max(20000).default(6000),
  /** 交注入层的候选数 */
  topN: z.number().min(5).max(50).default(24),
  /**
   * 下面三项与**机器**相关，留 0 表示按机器内存与库大小自动推导（见 util/memory.ts）。
   * 之所以做成可选覆盖而不是固定默认值：合理取值取决于内存与磁盘，写死必然在别的机器上不合适。
   */
  /** SQLite mmap 窗口字节数；0 = 自动 */
  mmapSize: z.number().min(0).default(0),
  /** SQLite 页缓存字节数；0 = 自动 */
  cacheSize: z.number().min(0).default(0),
  /** 写锁等待上限毫秒；0 = 自动 */
  busyTimeout: z.number().min(0).default(0),
})

/**
 * 插件入口。Cordis 在插件激活时调用一次。
 *
 * 注意：这里只做**注册**，不做重活——模型加载、索引构建等放到首次调用时懒执行，
 * 避免拖慢宿主启动。
 */
export function apply(ctx: any, config: any): void {
  const cfg = config ?? {}
  if (cfg.enabled === false) return

  const tools = ctx?.get?.('tools')
  if (tools === undefined || tools === null) return

  // 三个业务工具。注册只是挂上定义，真正的库连接与模型加载都等到第一次调用
  // （见 state.ts 的 getRuntime / runtimeEncode）—— 注册路径上不做重活。
  const runtimeCfg: RuntimeConfig = {
    dataDir: String(cfg.dataDir ?? ''),
    encoderEnabled: cfg.encoderEnabled !== false,
    encoderModel: String(cfg.encoderModel ?? 'Xenova/bge-small-zh-v1.5'),
    encoderMirror: String(cfg.encoderMirror ?? ''),
    encoderCacheDir: String(cfg.encoderCacheDir ?? ''),
    thresholds: {
      tauJoin: Number(cfg.tauJoin ?? 0.78),
      tauLex: Number(cfg.tauLex ?? 0.05),
      tauLexOnly: Number(cfg.tauLexOnly ?? 0.1),
      tauNew: Number(cfg.tauNew ?? 0.5),
    },
    viewBudget: Number(cfg.viewBudget ?? 6000),
    topN: Number(cfg.topN ?? 24),
    resources: {
      mmapSize: cfg.mmapSize > 0 ? Number(cfg.mmapSize) : undefined,
      cacheSize: cfg.cacheSize > 0 ? Number(cfg.cacheSize) : undefined,
      busyTimeout: cfg.busyTimeout > 0 ? Number(cfg.busyTimeout) : undefined,
    },
  }
  for (const t of buildTools(runtimeCfg)) tools.register(t)

  tools.register(
    defineTool({
      name: 'lattice_ping',
      description: 'dsh-lattice 健康检查：返回插件版本与当前配置摘要。用于确认插件已正确加载。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render(_args: unknown, value: unknown) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      async execute() {
        // 报告**实际会使用的**资源参数，而不是配置里的 0 —— 否则健康检查看不出真实取值。
        const res = deriveResourceParams(0, {
          mmapSize: cfg.mmapSize > 0 ? cfg.mmapSize : undefined,
          cacheSize: cfg.cacheSize > 0 ? cfg.cacheSize : undefined,
          busyTimeout: cfg.busyTimeout > 0 ? cfg.busyTimeout : undefined,
        })
        return JSON.stringify({
          ok: true,
          plugin: name,
          version: VERSION,
          // 报到插件注册时的**解析结果**，而不是配置里的空串 —— 否则看不出库在哪。
          dataDir: resolveDataDir(String(cfg.dataDir ?? '')),
          tools: ['lattice_ping', 'lattice_write', 'lattice_recall', 'lattice_expand', 'lattice_list'],
          encoder: cfg.encoderEnabled === false ? 'off' : cfg.encoderModel,
          thresholds: {
            tauJoin: cfg.tauJoin,
            tauLex: cfg.tauLex,
            tauLexOnly: cfg.tauLexOnly,
            tauNew: cfg.tauNew,
          },
          // 机器相关的资源参数：报出来才能核对「实际用了多少」，否则只能靠读代码猜。
          resources: {
            detectedMemoryMB: Math.round(res.detectedMemory / 1024 / 1024),
            mmapSizeMB: Math.round(res.mmapSize / 1024 / 1024),
            cacheSizeMB: Math.round(res.cacheSize / 1024 / 1024),
            busyTimeoutMs: res.busyTimeout,
          },
        })
      },
    }),
  )
}

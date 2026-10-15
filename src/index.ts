// dsh-lattice（记忆晶格）— DSH 记忆插件：无 LLM 依赖，本地向量检索 + Atom 级结构化记忆。
//
// 当前阶段只做两件事：
//   1. 导出符合 Cordis 契约的插件接口（name / inject / Config / apply）
//   2. 注册一个 lattice_ping 工具，证明工具注册链路可用
// 真正的 lattice_write / lattice_recall / lattice_expand 在 T5/T8 落地。

import { readFileSync } from 'node:fs'
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
  /** 并入阈值（余弦） */
  tauJoin: z.number().min(0.6).max(0.95).default(0.75),
  /** 并入所需的词面重叠（bigram-Jaccard） */
  tauLex: z.number().min(0.05).max(0.5).default(0.12),
  /** 新建主题阈值 */
  tauNew: z.number().min(0.2).max(0.8).default(0.5),
  /** 注入字符预算 */
  viewBudget: z.number().min(1000).max(20000).default(6000),
  /** 交注入层的候选数 */
  topN: z.number().min(5).max(50).default(24),
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
        return JSON.stringify({
          ok: true,
          plugin: name,
          version: VERSION,
          dataDir: cfg.dataDir || '(default)',
          encoder: cfg.encoderEnabled === false ? 'off' : cfg.encoderModel,
          thresholds: { tauJoin: cfg.tauJoin, tauLex: cfg.tauLex, tauNew: cfg.tauNew },
        })
      },
    }),
  )
}
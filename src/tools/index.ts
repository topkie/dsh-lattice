// 暴露给宿主的三个工具。
//
// 只有工具，没有 hook —— 这是设计决定：禁用 LLM 后「轮次结束自动沉淀」那条路必然
// 要调 LLM 做结构化，与本插件的定位冲突。写入与召回都必须是**显式动作**。
//
// 三个工具对应记忆的三个动作：
//   lattice_write   记住一件事
//   lattice_recall  按需取回（返回组装好的三段式文本，不是裸数组）
//   lattice_expand  展开某条记忆的全文或它的兄弟

import { defineTool } from '@deepseek-ai/dsh-tools'
import { recall, type RecallMeta } from '../pipeline/search.js'
import { assembleView } from '../pipeline/view.js'
import { writeAtom } from '../pipeline/write.js'
import { getRuntime, runtimeEncode, type Runtime, type RuntimeConfig } from '../state.js'

/** 库现状一行——放在召回结果前面，让模型知道这个库有多大、值不值得再查。 */
function libraryLine(rt: Runtime): string {
  const one = (sql: string): number => Number((rt.db.prepare(sql).get() as { n: number | bigint }).n)
  const atoms = one('SELECT COUNT(*) AS n FROM atom')
  const topics = one('SELECT COUNT(*) AS n FROM topic')
  const entries = one('SELECT COUNT(*) AS n FROM entry')
  const edges = one('SELECT COUNT(*) AS n FROM edge')
  return '库：atom ' + atoms + ' / topic ' + topics + ' / entry ' + entries + ' / edge ' + edges
}

/** 工具的公共输出形状：一律返回纯文本，由 render 直接透传。 */
function textOutput() {
  return {
    schema: { type: 'string' },
    render(_args: unknown, value: unknown) {
      return [{ type: 'text', text: String(value) }]
    },
  }
}

/**
 * 低于这个余弦就不把结果当「相关记忆」给模型，只说没找到。
 *
 * 取值依据是同义改写样本上的标定分布（见 pipeline/write.ts）：跨主题最高 0.633、
 * 同主题最低 0.811。阈值落在两者之间且贴近跨主题上界 —— 宁可漏报（说没找到）
 * 也不要把噪声当真结论喂给模型，后者会导致基于无关记忆的错误推理。
 */
/** 低于这个值就在结果上标一句「可能不相关」。**只是提示，不拦截** —— 见下。 */
export const LOW_RELEVANCE_HINT = 0.68

/**
 * 这次召回的结果值不值得给模型看。
 *
 * 抽成纯函数是为了能直接测判据本身 —— 否则要构造「库里有一条毫不相关的记忆」
 * 这类场景，而真实模型下那条记忆总会得到一个不算低的相似度，测不出边界。
 */
/** 是否该在结果前提示「可能不相关」。 */
export function isWeakMatch(meta: RecallMeta): boolean {
  if (meta.vectorMissing) return false // 纯词面模式没有余弦可依，不做判断
  return meta.topCosine < LOW_RELEVANCE_HINT
}

/** 入参收敛：类型不对就给默认，不让 undefined 往下游跑。 */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 构造三个工具的定义。cfg 在闭包里，apply 时解析一次。 */
export function buildTools(cfg: RuntimeConfig): unknown[] {
  const writeTool = defineTool({
    name: 'lattice_write',
    description:
      '记住一件事。写入后会自动编码、定位主题并生成检索入口。' +
      '仅在内容值得跨会话复用时调用：结论、坑、步骤、参数；一次对话里临时说过的话不要写。',
    // 注意形状：parameters 是「属性名 → 值 schema」的映射，**不是** {type, properties}。
    // 必填写成属性上的 required: true。写错会在 defineTool 时就抛错，整个插件加载失败。
    parameters: {
      text: {
        type: 'string',
        description: '记忆正文。一句话讲清一个结论，不要塞进多个主题。',
        required: true,
      },
      kind: { type: 'string', description: '结论 / 坑 / 步骤 / 参数，默认 结论' },
      refs: {
        type: 'array',
        items: { type: 'string' },
        description: '显式入口词（别名、关键术语）。写入方知道的说法一律写上。',
      },
      topic_hint: { type: 'number', description: '已知归属主题 id 时直接指定，跳过几何定位' },
      scope: { type: 'string', description: 'global 或项目键，默认 global' },
    },
    output: textOutput(),
    async execute(args: Record<string, unknown>) {
      const rt = getRuntime(cfg)
      const text = str(args?.text).trim()
      if (text === '') return '写入失败：text 不能为空。'
      const refs = Array.isArray(args?.refs) ? (args.refs as unknown[]).map((x) => String(x)) : []
      const hint = typeof args?.topic_hint === 'number' ? args.topic_hint : undefined
      const r = await writeAtom(rt.write, {
        text,
        kind: str(args?.kind, '结论'),
        scope: str(args?.scope, 'global'),
        refs,
        topicHint: hint,
      })
      const action = r.action === 'joined' ? '并入已有主题' : '新建主题'
      const reason = r.created === 'ambiguous' ? '（两个候选接近，已标记待定）' : ''
      const lines = [
        '已写入 atom #' + r.atomId + '：' + action + ' #' + r.topicId + reason,
        '入口 ' +
          r.entries.length +
          ' 条' +
          (refs.length > 0 ? '（其中显式声明 ' + refs.length + ' 条）' : ''),
      ]
      if (r.hintMiss !== undefined) {
        lines.push('注意：指定的主题 #' + r.hintMiss + ' 不存在，已按几何定位处理。')
      }
      return lines.join('\n')
    },
  })

  const recallTool = defineTool({
    name: 'lattice_recall',
    description:
      '按需取回记忆。返回组装好的三段式文本：【锚】是记忆正文，【入口】是相关说法，' +
      '【路】是关联线索。做任何需要历史结论、约定或踩过的坑的任务前，先调用它。',
    parameters: {
      query: {
        type: 'string',
        description: '用你自己的话描述要找什么，不必迁就记忆里的措辞',
        required: true,
      },
      budget: { type: 'number', description: '字符预算，默认取插件配置' },
    },
    output: textOutput(),
    async execute(args: Record<string, unknown>) {
      const rt = getRuntime(cfg)
      const q = str(args?.query).trim()
      if (q === '') return '查询为空。'
      const vq = await runtimeEncode(cfg, q)
      const recalled = recall(rt.db, q, vq, { topN: cfg.topN })
      const view = assembleView(rt.db, recalled, { budget: num(args?.budget, cfg.viewBudget) })
      const notes: string[] = [libraryLine(rt)]
      if (recalled.meta.vectorMissing) notes.push('（编码器不可用，本次为纯词面召回）')
      if (recalled.meta.lexicalDegraded) notes.push('（词面两路均未命中，仅向量路有结果）')
      if (recalled.meta.shortTermMiss) notes.push('（查询含两字词但入口层零命中）')
      // 召回总会返回 topN 条，不管相关性。把最高相似度报出来，调用方才知道该不该信。
      if (!recalled.meta.vectorMissing && recalled.hits.length > 0) {
        const c = recalled.meta.topCosine
        const level = c >= 0.78 ? '高' : c >= 0.6 ? '中' : '低'
        notes.push('（最高相似度 ' + c.toFixed(2) + '，相关度' + level + '）')
      }
      if (recalled.hits.length === 0) return notes.join('\n') + '\n\n没有找到相关记忆。'
      return notes.join('\n') + '\n\n' + view.text
    },
  })

  const expandTool = defineTool({
    name: 'lattice_expand',
    description:
      '展开某条记忆的全文，或列出同主题的兄弟记忆。召回只给了摘要或截断正文时用它。' +
      'mode=related 可以看到该主题下还有哪些相关记忆，用于判断是否有互相矛盾的说法。',
    parameters: {
      atom_id: { type: 'number', description: '要展开的 atom id', required: true },
      mode: { type: 'string', description: 'full（默认）或 related' },
    },
    output: textOutput(),
    async execute(args: Record<string, unknown>) {
      const rt = getRuntime(cfg)
      const id = typeof args?.atom_id === 'number' ? args.atom_id : NaN
      if (!Number.isFinite(id)) return '缺少 atom_id。'
      const row = rt.db.prepare('SELECT id, kind, text, topic_id FROM atom WHERE id = ?').get(id) as
        { id: number | bigint; kind: string; text: string; topic_id: number | bigint } | undefined
      if (row === undefined) return '没有 id 为 ' + id + ' 的记忆。'
      if (str(args?.mode, 'full') === 'related') {
        const rows = rt.db
          .prepare('SELECT id, summary FROM atom WHERE topic_id = ? AND id <> ? ORDER BY id LIMIT 20')
          .all(Number(row.topic_id), id) as Array<{ id: number | bigint; summary: string }>
        const head = '主题 #' + Number(row.topic_id) + ' 下另有 ' + rows.length + ' 条：'
        if (rows.length === 0) return head + '（无）'
        return [head, ...rows.map((r) => '- #' + Number(r.id) + ' ' + String(r.summary))].join('\n')
      }
      return [
        '#' + Number(row.id) + ' [' + String(row.kind) + '] 主题 #' + Number(row.topic_id),
        '',
        String(row.text),
      ].join('\n')
    },
  })

  return [writeTool, recallTool, expandTool]
}

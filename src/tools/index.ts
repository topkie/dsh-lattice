// 暴露给宿主的五个业务工具（`lattice_ping` 在 index.ts 注册，共六个）。
//
// 只有工具，没有 hook —— 这是设计决定：禁用 LLM 后「轮次结束自动沉淀」那条路必然
// 要调 LLM 做结构化，与本插件的定位冲突。写入与召回都必须是**显式动作**。
//
// 五个工具对应记忆行动的五个环节：
//   lattice_write     记住一件事
//   lattice_recall    按需取回（返回组装好的三段式文本，不是裸数组）
//   lattice_expand    展开某条记忆的全文或它的兄弟
//   lattice_list      列目录（「库里有什么」，只读、分页、可过滤）
//   lattice_feedback  对上次召回给出「第几条有用 / 无用」（裁决 #30/#33）
//
// **还有第六个动作，但没有第六个工具**：删除。`lattice_forget` 刻意不在下面这个数组里
// —— 理由见文件尾 `forgetTool` 上方那段注释。
//
// `lattice_feedback` 为什么是独立工具而不是挂在 write 上（裁决 #30）：写入是高频路径
// （现在已经 8 个参数），反馈是低频动作；挂上去等于每次写入都替反馈付一次参数成本。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { feedLearned } from '../pipeline/entries.js'
import { LIST_DEFAULT_LIMIT, listAtoms, type ListRow } from '../pipeline/list.js'
import { recall, recordRecall, type RecallMeta } from '../pipeline/search.js'
import { TIER_BRIEF_MIN, assembleView } from '../pipeline/view.js'
import { collectAutoNegative, noteLastRecall, recordSample, resolveFeedbackRef } from '../samples/index.js'
import { ForgottenError, writeReviewed } from '../pipeline/write.js'
import {
  getRuntime,
  maybeRecalibrate,
  noteRecallDegradations,
  runtimeEncode,
  type Runtime,
  type RuntimeConfig,
} from '../state.js'

/** 库现状一行——放在召回结果前面，让模型知道这个库有多大、值不值得再查。 */
function libraryLine(rt: Runtime): string {
  const one = (sql: string): number => Number((rt.db.prepare(sql).get() as { n: number | bigint }).n)
  const atoms = one('SELECT COUNT(*) AS n FROM atom')
  const topics = one('SELECT COUNT(*) AS n FROM topic')
  const entries = one('SELECT COUNT(*) AS n FROM entry')
  const edges = one('SELECT COUNT(*) AS n FROM edge')
  return '库：atom ' + atoms + ' / topic ' + topics + ' / entry ' + entries + ' / edge ' + edges
}

/**
 * 工具的公共输出形状：一律返回纯文本，由 render 直接透传。
 *
 * 两处 `as const` 不是装饰：宿主用**字面量**判别 schema（type: 'string'）与内容块
 * （type: 'text'）。靠推断时 'string' 会先被推成 string，宿主的返回值推断随之落到
 * never —— 报错落在「返回值不匹配」上，离真正的原因很远。
 * （这是删掉宿主类型替身之后，第一次编译就撞上的两处。）
 */
function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: unknown) {
      return [{ type: 'text' as const, text: String(value) }]
    },
  }
}

/**
 * 「库小到没法标定」时的**兜底**提示线 —— 按库规模重标后的那条线不在这里。
 *
 * 实际生效的线由 `pipeline/calibrate.ts` 的锚点表给出（`briefMinForDb()` 现取），
 * 并随 `assembleView()` 的结果一起返回；调用方要传的是那个值。
 *
 * 原值是 0.68，实测**永不触发**：gold 集的 top1 中位数就有 0.683。一个永不触发的
 * 提示与没有提示是一回事，却看起来还在工作 —— 那比没有更糟。
 *
 * ⚠️ **这里此前分叉过一次**：本常量绑的是 `TIER_BRIEF_MIN`（0.45），而实际生效的线在
 * 1374 库上是 0.525 —— 两者差 0.075，落在这个区间里的召回会被判「相关」并**不提示**。
 * 上面原本写着「分头定两个数，只会让它们慢慢分叉」，而它自己就是这个形态。
 * 2026-10-17 修正：`isWeakMatch()` 改为接受 `briefMin`，调用处传 `view.briefMin`。
 */
export const LOW_RELEVANCE_HINT = TIER_BRIEF_MIN

/**
 * 这次召回的结果值不值得给模型看 —— 是否该在结果前提示「可能不相关」。
 *
 * 抽成纯函数是为了能直接测判据本身 —— 否则要构造「库里有一条毫不相关的记忆」
 * 这类场景，而真实模型下那条记忆总会得到一个不算低的相似度，测不出边界。
 */
export function isWeakMatch(meta: RecallMeta, briefMin: number = LOW_RELEVANCE_HINT): boolean {
  if (meta.vectorMissing) return false // 纯词面模式没有余弦可依，不做判断
  return meta.topCosine < briefMin
}

/** 所有权的可读说法。目录里给的是给人看的词，不是字段值。 */
function originLabel(o: string): string {
  if (o === 'user') return '用户'
  if (o === 'import') return '导入'
  return '模型'
}

/**
 * 目录的一行。
 *
 * 只给摘要不给正文：列目录是为了定位到某几条再展开；把正文一起递出去，分页就白做了。
 */
function formatListRow(r: ListRow): string {
  const marks: string[] = [originLabel(r.origin)]
  if (r.supersededBy !== null) marks.push('已被 #' + r.supersededBy + ' 取代')
  if (r.recallHits > 0) marks.push('取回 ' + r.recallHits + ' 次')
  const scopeMark = r.scope === 'global' ? '' : ' {' + r.scope + '}'
  return [
    '#' + r.id,
    ' [' + r.kind + '·' + marks.join('·') + ']',
    scopeMark,
    ' 主题 #' + (r.topicId === null ? '-' : r.topicId),
    '  ' + r.summary,
  ].join('')
}

/** 入参收敛：类型不对就给默认，不让 undefined 往下游跑。 */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 拒因里回显入参：把 undefined / 字符串 / 数字混成同一句话，调用方就改不对。 */
function describeArg(v: unknown): string {
  if (v === undefined) return '（未提供）'
  if (typeof v === 'string') return '"' + v + '"'
  if (typeof v === 'number') return String(v)
  return typeof v
}

/** 构造三个工具的定义。cfg 在闭包里，apply 时解析一次。 */
export function buildTools(cfg: RuntimeConfig): unknown[] {
  const writeTool = defineTool({
    name: 'lattice_write',
    description:
      '记住一件事。仅在内容值得跨会话复用时调用：结论、坑、命令与参数、环境、步骤、数据；' +
      '一次对话里临时说过的话不要写。太短的碎片会被拒收（请把它并进它解释的那条记忆），' +
      '过长的会按句拆成多条分别写入；与已有内容重复或高度相似时只给一条提示，不阻止写入。',
    // 注意形状：parameters 是「属性名 → 值 schema」的映射，**不是** {type, properties}。
    // 必填写成属性上的 required: true。写错会在 defineTool 时就抛错，整个插件加载失败。
    parameters: {
      text: {
        type: 'string',
        description: '记忆正文。一条讲清一个结论，不要塞进多个主题；至少要是一句完整的话。',
        required: true,
      },
      kind: {
        type: 'string',
        description: '记忆类型：结论 / 坑 / 命令与参数 / 环境 / 步骤 / 数据。默认 结论；认不出的值按结论记。',
      },
      refs: {
        type: 'array',
        items: { type: 'string' },
        description:
          '用户以后可能用哪些说法找它？同义词、俗称、报错原文都写上。' +
          '例：正文讲 nodeLinker=hoisted，refs 写 ["pnpm 依赖装不上", "符号链接失败"]。',
      },
      topic_hint: { type: 'number', description: '已知归属主题 id 时直接指定' },
      scope: { type: 'string', description: 'global 或项目键，默认 global' },
      origin: {
        type: 'string',
        description:
          '这条记忆是谁说的：user（用户明确说过的）/ model（你推断或总结的，默认）/ import。' +
          '用户亲口讲的事实、偏好、决定必须标 user —— 用户要凭这个字段分清「我说的」与「你推断的」。',
      },
      supersedes: {
        type: 'number',
        description: '本条取代哪条旧记忆的 id（改口、修订时用）。旧条只被标记，不会删除。',
      },
    },
    output: textOutput(),
    async execute(args: Record<string, unknown>) {
      const rt = getRuntime(cfg)
      const text = str(args?.text).trim()
      if (text === '') return '写入失败：text 不能为空。'
      const refs = Array.isArray(args?.refs) ? (args.refs as unknown[]).map((x) => String(x)) : []
      const hint = typeof args?.topic_hint === 'number' ? args.topic_hint : undefined
      const sup =
        typeof args?.supersedes === 'number' && Number.isFinite(args.supersedes) ? args.supersedes : undefined
      let out
      try {
        // 写入侧审核层（M3-T22）在 writeReviewed 里：长度类**自动处理**（过短拦下 / 过长切分），
        // 重复与高相似只产生提示。两者的产出都只经这一个返回值出去 —— 不写库、不建队列、
        // 不产生需要人处理的待办（§11.1：插件不做判断，只提供判断所需的信息）。
        out = await writeReviewed(rt.write, {
          text,
          kind: str(args?.kind, '结论'),
          scope: str(args?.scope, 'global'),
          refs,
          topicHint: hint,
          origin: str(args?.origin, 'model'),
        })
      } catch (e) {
        // 防写回拦下（§44）。**不静默丢弃**：把「被拒了、以及为什么」原样交回写入方，
        // 否则它会以为写成功了 —— 那才是这条判据真正的失败形态。
        // 其余错误照旧上抛：输入类问题该显式失败，不该被这里吞成一句文本。
        if (e instanceof ForgottenError) return describeForgetRejection(e)
        throw e
      }

      const lines: string[] = []
      if (out.length.note !== null) lines.push(out.length.note.message)
      // 长度审核拦下：确实一条都没写。此时上面的说明就是全部反馈 —— 调用方据此改写，
      // 而不是以为写成功了（与防写回同一条纪律）。
      if (out.results.length === 0) return lines.join('\n')

      const multi = out.results.length > 1
      out.results.forEach((r, i) => {
        const action = r.action === 'joined' ? '并入已有主题' : '新建主题'
        // 「尚未确认归属」而不是「已标记待定」（M4-D1）：后者会被读成「库里有个待办等人处理」，
        // 而本插件不建待办（§11.1）—— 没有队列、没有需要处理的条目，只是这一次落位没把握。
        // 次近编号给出来，调用方才能自己核对「它说的是哪个主题」；两个 id 的差别见 WriteResult.nearId。
        const secondId = r.created === 'ambiguous' ? (r.evidence?.secondId ?? null) : null
        const reason =
          r.created === 'ambiguous'
            ? secondId !== null
              ? '（尚未确认归属，次近主题 #' + secondId + '）'
              : '（尚未确认归属）'
            : ''
        lines.push(
          (multi ? '第 ' + (i + 1) + '/' + out.results.length + ' 条：' : '') +
            '已写入记忆 #' +
            r.atomId +
            '：' +
            action +
            ' #' +
            r.topicId +
            reason,
        )
        lines.push(
          '入口 ' +
            r.entries.length +
            ' 条' +
            (refs.length > 0 ? '（其中显式声明 ' + refs.length + ' 条）' : ''),
        )
        if (r.hintMiss !== undefined) {
          lines.push('注意：指定的主题 #' + r.hintMiss + ' 不存在，已按内容自动判断归属。')
        }
        // 类型归一可见：纠正不静默，否则调用方会以为库里真有那一类。
        if (r.kindAdjusted !== undefined) {
          lines.push('类型「' + r.kindAdjusted + '」认不出，已按「' + String(r.kind) + '」记。')
        }
        // 位标志摘要（T36 判据 6）：给出**可核对的说法**，不让模型靠读中文猜。
        // 位定义在 write.ts 的 FLAG_*，与 ARCHITECTURE 一一对应。
        if (r.flags !== undefined && r.flags !== 0) {
          const tags: string[] = []
          if ((r.flags & 2) !== 0) tags.push('歧义（两个候选接近）')
          if ((r.flags & 4) !== 0) tags.push('未归类')
          if ((r.flags & 1) !== 0) tags.push('待拆分')
          lines.push('标记：' + tags.join('；') + '（flags=' + r.flags + '）')
        }
        // 重复 / 高相似的提示挂在这里。**写入已经发生**，提示只是让调用方知道
        // 「库里另有一条与它重合」—— 处置权在它手上。
        for (const n of r.review ?? []) lines.push(n.message)
      })
      if (multi) {
        lines.push('（原文被切分，topic_hint 未沿用：各段各自落位，以免把几件事硬塞进同一个主题。）')
      }

      // 写入侧重标尝试（T44 判据 7）：**异步、不 await** —— 写入的返回不该等一次标定。
      // 失败只写日志与 meta，参数一个字都不动（判据 8）。
      void maybeRecalibrate()

      // 取代关系只落在这里：写入侧的事务内固定 O(1) 行数，多一条 UPDATE 就多一份
      // 写锁持有时间，而这不是热路径。
      // 切分后「本条」是多条 atom，取代关系只能落在一条上 —— 落在第一条，并把落在
      // 哪一条写进反馈，免得调用方以为三段都建立了取代关系。
      if (sup !== undefined) {
        const target = out.results[0]!
        const u = rt.db
          .prepare('UPDATE atom SET superseded_by = ?, updated_at = ? WHERE id = ? AND id <> ?')
          .run(target.atomId, Date.now(), sup, target.atomId)
        lines.push(
          Number(u.changes) === 0
            ? '注意：要取代的记忆 #' + sup + ' 不存在，未建立取代关系。'
            : '已把 #' +
                sup +
                ' 标记为被 #' +
                target.atomId +
                (multi ? '（切分后的第一条）' : '本条') +
                ' 取代（旧条不会删除）。',
        )
      }
      return lines.join('\n')
    },
  })

  const recallTool = defineTool({
    name: 'lattice_recall',
    description:
      '按需取回记忆。返回组装好的三段式文本：【锚】是记忆正文（每条带 id，' +
      'id 自增即写入先后；标「我」的是用户说过的、「导入」的是外部来源的、' +
      '「已被 #N 取代」的是后来被修订掉的），【入口】是相关说法，【路】是关联线索。' +
      '凡是答案可能取决于「之前定过什么」的问题，都该先查：用户提过的事实与偏好、项目既有约定、' +
      '踩过的坑、之前讨论过的方案。只有确实与历史无关的常识问答才不必查。' +
      '若【锚】段里某一条明显有用或明显无关，可用 lattice_feedback 反馈「第几条」（ref 是这里的 1-based 序号）。',
    parameters: {
      query: {
        type: 'string',
        description: '用你自己的话描述要找什么，不必迁就记忆里的措辞',
        required: true,
      },
      budget: { type: 'number', description: '返回文本的字符预算' },
    },
    output: textOutput(),
    async execute(args: Record<string, unknown>) {
      const rt = getRuntime(cfg)
      const q = str(args?.query).trim()
      if (q === '') return '查询为空。'
      // 标定参数在**第一处等待点之前**取一次，这次召回整段只用这一代。
      // 重标由写入侧异步触发，会在两次等待之间整体替换 rt.calibration —— 若等到编码返回
      // 之后才读，同一次召回就会「按旧参数召回、按新参数注入」，中间隔了一次换代。
      const calibParams = rt.calibration.params ?? null
      const vq = await runtimeEncode(cfg, q)
      const recalled = recall(rt.db, q, vq, { topN: cfg.topN })
      // 降级留痕：只入队，不阻塞召回（见 src/log/index.ts 的队列与批量窗口）。
      noteRecallDegradations(recalled.meta)
      const view = assembleView(rt.db, recalled, {
        budget: num(args?.budget, cfg.viewBudget),
        // 本地标定值（快照）优先于按规模插值；未标定时为 undefined，pipeline 自己会回落。
        briefMin: calibParams?.briefMin,
      })
      // 会话级「最近一次召回」：只留在内存里（裁决 #34 ⑥），lattice_feedback 的 ref 靠它解析。
      // 记的是 view.anchorIds（真正展示给模型的那批），不是融合后的全部候选。
      noteLastRecall({ ids: view.anchorIds, top1: recalled.meta.topCosine, vec: vq })
      // 负样本自动收集：分类是纯逻辑，落盘由样本模块延后到下一轮事件循环 ——
      // 召回路径上仍然没有同步 IO。开关关掉时这一步整体跳过，召回结果不受影响。
      if (cfg.samplesEnabled !== false) {
        collectAutoNegative({
          query: q,
          meta: recalled.meta,
          vec: vq,
          hitIds: recalled.hits.map((h) => h.id),
        })
      }
      const notes: string[] = [libraryLine(rt)]
      if (recalled.meta.vectorMissing) notes.push('（编码器不可用，本次为纯词面召回）')
      if (recalled.meta.lexicalDegraded) notes.push('（词面两路均未命中，仅向量路有结果）')
      if (recalled.meta.shortTermMiss) notes.push('（查询含两字词但入口层零命中）')
      // 召回总会返回 topN 条，不管相关性。把最高相似度**如实**报出来，调用方才知道该不该信；
      // 低于提示线时再补一句「可能不相关」。这里只标注、不拦截 —— 见 LOW_RELEVANCE_HINT。
      if (!recalled.meta.vectorMissing && recalled.hits.length > 0) {
        const c = recalled.meta.topCosine
        // 传本库当前生效的那条线（`view` 就在上面一行），而不是兜底值 —— 两者在 1374 库上差 0.075。
        const hint = isWeakMatch(recalled.meta, view.briefMin) ? '，可能不相关' : ''
        notes.push('（最高相似度 ' + c.toFixed(2) + hint + '）')
      }
      // 记一次命中。召回本身是只读语义，这一步失败不该让召回失败 —— 但也绝不假装成功：
      // 库里的命中计数会因此偏低，这是刻意选的失败方向。
      try {
        recordRecall(
          rt.db,
          recalled.hits.map((h) => h.id),
        )
      } catch {
        /* 只读连接等场景下记不了，不影响召回结果 */
      }
      // learned 反哺：把这次查询的特征词记到命中的 atom 上（§27）。
      //
      // 为什么是**同步**、就在返回路径上：本插件只有工具、没有 hook，没有「上层」可以托付 ——
      // 异步丢出去既没有等待点，失败也无处记账。写的量很小（≤ 命中数 × 3 对，且大部分会被
      // 冷却与「该 atom 已有同名入口」挡掉）。失败方向与上面 recordRecall 一致：
      // 入口学不到东西，但召回照常返回。
      //
      // 记的是 recalled.hits（进入 topN 的那批），不是最终渲染进文本的那批：后者取决于
      // assembleView 的预算裁剪，而裁剪结果不在它的返回值里 —— 去解析渲染文本等于把
      // 注入层的排版当成接口用。
      try {
        feedLearned(
          rt.db,
          q,
          recalled.hits.map((h) => h.id),
        )
      } catch {
        /* 只读连接等场景下写不了，不影响召回结果 */
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
      atom_id: {
        type: 'number',
        description: '要展开的记忆 id，从召回文本【锚】段的 [id] 取',
        required: true,
      },
      mode: { type: 'string', description: 'full（默认）或 related' },
    },
    output: textOutput(),
    async execute(args: Record<string, unknown>) {
      const rt = getRuntime(cfg)
      const id = typeof args?.atom_id === 'number' ? args.atom_id : NaN
      if (!Number.isFinite(id)) return '缺少 atom_id。'
      const row = rt.db
        .prepare('SELECT id, kind, text, topic_id, origin, superseded_by FROM atom WHERE id = ?')
        .get(id) as
        | {
            id: number | bigint
            kind: string
            text: string
            topic_id: number | bigint
            origin: string
            superseded_by: number | bigint | null
          }
        | undefined
      if (row === undefined) return '没有 id 为 ' + id + ' 的记忆。'
      if (str(args?.mode, 'full') === 'related') {
        const rows = rt.db
          .prepare('SELECT id, summary FROM atom WHERE topic_id = ? AND id <> ? ORDER BY id LIMIT 20')
          .all(Number(row.topic_id), id) as Array<{ id: number | bigint; summary: string }>
        const head = '主题 #' + Number(row.topic_id) + ' 下另有 ' + rows.length + ' 条：'
        if (rows.length === 0) return head + '（无）'
        return [head, ...rows.map((r) => '- #' + Number(r.id) + ' ' + String(r.summary))].join('\n')
      }
      const meta: string[] = []
      if (String(row.origin) === 'user') meta.push('用户说的')
      else if (String(row.origin) === 'import') meta.push('导入的')
      if (row.superseded_by !== null) meta.push('已被 #' + Number(row.superseded_by) + ' 取代')
      return [
        '#' +
          Number(row.id) +
          ' [' +
          String(row.kind) +
          '] 主题 #' +
          Number(row.topic_id) +
          (meta.length > 0 ? '（' + meta.join('，') + '）' : ''),
        '',
        String(row.text),
      ].join('\n')
    },
  })

  const listTool = defineTool({
    name: 'lattice_list',
    description:
      '列出库里有哪些记忆（目录视图，不是搜索）。用户问「你记得哪些关于 X 的事」「库里有什么」时，' +
      '先用它看清楚有什么，再决定要不要 recall 或 expand。分页返回，按写入顺序倒序（最近写的在前）。',
    parameters: {
      kind: { type: 'string', description: '只看某一类：结论 / 坑 / 命令与参数 / 环境 / 步骤 / 数据' },
      origin: {
        type: 'string',
        description: '只看某一来源：user（用户说的）/ model（你推断的）/ import（导入的）',
      },
      scope: { type: 'string', description: '项目键；给定时连同全局记忆一起列出' },
      topic: { type: 'number', description: '只看某个主题下的记忆' },
      flags: {
        type: 'number',
        description:
          '只看需要留意的记忆：2 = 两个主题都像（歧义）、4 = 没有合适的主题（未归类）；' +
          '给 3 表示两类都要',
      },
      limit: { type: 'number', description: '本页条数，默认 20，上限 50' },
      offset: { type: 'number', description: '从第几条开始，用于翻页' },
    },
    output: textOutput(),
    async execute(args: Record<string, unknown>) {
      const rt = getRuntime(cfg)
      const kind = str(args?.kind)
      const origin = str(args?.origin)
      const scope = str(args?.scope)
      const topic = typeof args?.topic === 'number' ? args.topic : undefined
      const flags = typeof args?.flags === 'number' && Number.isFinite(args.flags) ? args.flags : undefined
      const r = listAtoms(rt.db, {
        kind,
        origin,
        scope,
        topicId: topic,
        flags,
        limit: num(args?.limit, LIST_DEFAULT_LIMIT),
        offset: num(args?.offset, 0),
      })
      const lines: string[] = [libraryLine(rt)]
      const filters: string[] = []
      if (kind !== '') filters.push('kind=' + kind)
      if (origin !== '') filters.push('origin=' + origin)
      if (scope !== '') filters.push('scope=' + scope)
      if (topic !== undefined) filters.push('topic=' + topic)
      const head = filters.length > 0 ? '筛选：' + filters.join(' ') + ' ｜ ' : ''
      lines.push(head + '共 ' + r.total + ' 条')
      if (r.rows.length === 0) return lines.join('\n') + '\n\n没有符合条件的记忆。'
      for (const row of r.rows) lines.push(formatListRow(row))
      const shown = r.offset + r.rows.length
      if (shown < r.total) {
        lines.push('（还有 ' + (r.total - shown) + ' 条，下一页用 offset=' + shown + '）')
      }
      return lines.join('\n')
    },
  })

  /**
   * 校准样本的**唯一人工入口**（裁决 #30/#33）。
   *
   * 只写独立样本库，**不写 edge、不写主库、不触发重标**（裁决 #31：正样本是
   * 「查询↔记忆」，edge 是「记忆↔记忆」，不是同一条数据）。`ref` 是上次召回的 1-based
   * 序号，由插件映射回 atom id —— 模型管语义位置，插件管结构。
   */
  const feedbackTool = defineTool({
    name: 'lattice_feedback',
    description:
      '对上一次 lattice_recall 的结果给出反馈：第几条有用（positive）或无关（negative）。' +
      'ref 是上次召回文本【锚】段的 1-based 序号，不是记忆 id。' +
      '它只记录这次判断：不修改记忆、不改变排序。拿不准时不要调用 —— 标错会让后续判断的依据变脏。',
    parameters: {
      kind: {
        type: 'string',
        description: 'positive（这次召回有用）或 negative（与问题无关）',
        required: true,
      },
      ref: {
        type: 'number',
        description:
          '上次召回结果里的 1-based 序号（召回文本【锚】段第几条）；越界会被拒绝，且拒因会写清原因。',
        required: true,
      },
    },
    output: textOutput(),
    async execute(args: Record<string, unknown>) {
      // 先确保运行时与样本库已配置：样本的落盘依赖 configureSamples。这一步不写主库
      // （getRuntime 的写只发生在首次建库与迁移时）。
      getRuntime(cfg)
      const kind = str(args?.kind).trim()
      if (kind !== 'positive' && kind !== 'negative') {
        return '反馈被拒：kind 只能是 positive 或 negative，收到 ' + describeArg(args?.kind) + '。'
      }
      const resolved = resolveFeedbackRef(args?.ref)
      if (!resolved.ok) return '反馈被拒：' + resolved.reason
      const recorded = await recordSample({
        kind,
        source: 'feedback',
        top1: resolved.top1,
        vec: resolved.vec,
        hitIds: [resolved.atomId],
      })
      const head = '第 ' + String(args?.ref) + ' 条（atom #' + resolved.atomId + '）判为 ' + kind + '。'
      if (recorded) return '已记下反馈：' + head
      return '反馈未写入样本库：' + head + '（样本库写失败，这条反馈已丢弃；记忆与召回不受影响。）'
    },
  })

  return [writeTool, recallTool, expandTool, listTool, feedbackTool]
}

/**
 * `lattice_forget` 的**定义**：它存在，但**不进工具表**。
 *
 * §11.1 的边界：物理删除归用户，模型只能**提议**。所以这个定义不放进 `buildTools`
 * 返回的数组 —— 「模型可见的工具表」在本仓库里就是这个数组（`apply` 逐条注册它，
 * 宿主呈现给模型的就是注册表里的可见条目；没有 `buildTools` 的返回，谁也不会注册它）。
 *
 * 那为什么还要写出来？因为**删除这个动作本身需要一个实现落点**。它的调用者是
 * `src/index.ts` 的 `/api/lattice-forget` 写端点（界面上的删除按钮），不是模型。
 * 把它写成一个工具定义而不是一段散在路由里的逻辑，是为了让「模型能做什么」与「用户
 * 能做什么」在**同一个文件里**可以逐条对照 —— 边界被写下来，才有人能发现它被越过。
 *
 * 宿主对未注册的名字回 UNKNOWN_TOOL（`dsh-tools` 的注册表查找），所以模型即使从别处
 * 知道这个名字也调不动。见 `test/tools.test.mjs` 里那条断言。
 *
 * 注意它**没有** `execute`：真正的实现在 `pipeline/forget.ts` 的 `forgetAtom`，由写端点
 * 调用。这里不重复一份逻辑，避免出现第二个真相源。
 */
export const FORGET_TOOL_NAME = 'lattice_forget'

export const FORGET_TOOL_SPEC = {
  name: FORGET_TOOL_NAME,
  description:
    '删除一条记忆（物理删除 + 留痕）。**模型不可调用**：物理删除归用户（§11.1），模型只能提议。界面的删除入口调用 pipeline/forget.ts 的实现，不经过这里。',
  parameters: {
    atom_id: { type: 'number', description: '要删除的 atom id', required: true },
    reason: { type: 'string', description: '删除原因（可选，只进反馈）' },
  },
} as const
/**
 * 被防写回判据拦下时，给写入方的**具体**反馈（§44：拦下之后不静默丢弃）。
 *
 * 为什么反馈里要写出墓碑号与日期：模型需要能对用户说清「这是你删过的那条」，
 * 而一个「被拒绝了」不足以让它不再试。
 */
export function describeForgetRejection(err: ForgottenError): string {
  const e = err.evidence
  const how = e.how === 'both' ? '词面与语义都重合' : '语义高度接近（词面改写较大）'
  const cos = e.cos === null ? '未算（无向量）' : e.cos.toFixed(3)
  const when = new Date(e.deletedAt).toISOString().slice(0, 10)
  const lines = [
    '写入被拒：这条内容与用户删过的一条记忆重合（' + how + '）。',
    '  原记忆 #' + e.atomId + '（' + e.kind + '，' + e.scope + '）：' + e.summary,
    '  删除于 ' + when + '，墓碑 #' + e.tombstoneId + '。',
    '  相似度：词面 ' + e.lex.toFixed(3) + '，余弦 ' + cos + '。',
    '用户删除过的内容不会被重新写入。若这确实是一件新的事，请换一个角度写清楚它与原记忆的区别；不要重复提交同一句话。',
  ]
  if (err.truncated) lines.push('  注意：墓碑较多，本次只比对了最近 ' + err.scanned + ' 条。')
  return lines.join('\n')
}

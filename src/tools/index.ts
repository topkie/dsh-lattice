// 暴露给宿主的四个业务工具（`lattice_ping` 在 index.ts 注册，共五个）。
//
// 只有工具，没有 hook —— 这是设计决定：禁用 LLM 后「轮次结束自动沉淀」那条路必然
// 要调 LLM 做结构化，与本插件的定位冲突。写入与召回都必须是**显式动作**。
//
// 四个工具对应记忆行动的四个环节：
//   lattice_write     记住一件事
//   lattice_recall    按需取回（返回组装好的【入选】清单与未入选说明，不是裸数组）
//   lattice_expand    展开某条记忆的全文或它的兄弟
//   lattice_list      列目录（「库里有什么」，只读、分页、可过滤）
//
// **还有两个动作，但没有对应工具**，两个定义都写在文件尾：
//   - `lattice_forget`：物理删除归用户，模型只能提议 —— 见 `FORGET_TOOL_SPEC` 上方。
//   - `lattice_feedback`：当前未启用（样本库已删）—— 见 `FEEDBACK_TOOL_SPEC` 上方。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { feedLearned } from '../pipeline/entries.js'
import { LIST_DEFAULT_LIMIT, listAtoms, type ListRow } from '../pipeline/list.js'
import { RECALL_TOP_N, recall, recordRecall } from '../pipeline/search.js'
import { assembleView } from '../pipeline/view.js'
import {
  FLAG_ARCHIVED,
  type DeclaredEdgeInput,
  type DeclaredEdgeNote,
  ForgottenError,
  writeReviewed,
} from '../pipeline/write.js'
import { DECLARED_ORIGIN, OUT_DEGREE_CAP } from '../graph/infer.js'
import { findTombstoneOf } from '../pipeline/forget.js'
import { referenceFor } from '../pipeline/refdist.js'
import {
  getRuntime,
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
 * 一条 atom 不在库里时，说清是「被删过」还是「从来没有」。
 *
 * 两者的下一步完全不同：被删过的那条有墓碑，用户可能还记着它，值得提一句「这条你删过」；
 * 从来没有的那条通常是 id 打错或库没同步，说「不存在」就够了。
 * 墓碑可能有很多块（同一条能删多次），这里只取最近的一块。
 */
function absenceOf(rt: Runtime, atomId: number): string {
  const t = findTombstoneOf(rt.db, atomId)
  return t === null ? '不存在' : '已被删除（墓碑 #' + t.tombstoneId + '）'
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
 * 有命中时追加在召回结果末尾的一句：关系可以显式声明（声明边的可发现性）。
 *
 * **只在返回文本里**：不改排序、不写库（判据就是「跑前后 atom / edge 行数与 data_version
 * 不变」）。写在末尾而不是开头，是因为它是一条「还有别的用法」的提示，不该挤在
 * 库现状与锚段之间抢注意力。
 */
export const DECLARED_EDGE_HINT = '关系可显式声明：lattice_write 的 edges。'

/**
 * 声明 duplicate 边时追加的一句。
 *
 * 这类边只写一行 edge 记录：它**不改**去重判定 —— 去重按余弦与词面算，与边无关。
 * 不说这一句，读回执的人会以为「声明了重复」就等于「压制已经生效」。
 *
 * **supersedes 不在其列**（2026-10-21 起）：edges 里的 supersedes 写进去也不生效，
 * 所以改为直接拒边（见 pipeline/write.ts 的拒绝分支）。这里只剩 duplicate 一类。
 */
export const DECLARED_EDGE_ONLY_NOTE = '（只记录关系，不改变去重状态）'

/** 只记录关系、不改变状态的 kind（图路同样不认它）。 */
const ONLY_RECORDED_KINDS: readonly string[] = ['duplicate']

/**
 * 本次声明里有没有**真的落库**的 duplicate 边。
 *
 * 被拒的边不算：它们会在下一行逐条说「关系未建立」，再加一句「只记录关系」，
 * 等于把没发生的事说成发生了。
 */
function hasOnlyRecordedEdge(edges: unknown, rejected: DeclaredEdgeNote[] | undefined): boolean {
  if (!Array.isArray(edges)) return false
  const rejectedKeys = new Set((rejected ?? []).map((n) => n.type + '\u0000' + String(n.target)))
  return edges.some((raw) => {
    const e = raw as { type?: unknown; target?: unknown } | null
    if (e === null || typeof e !== 'object') return false
    if (typeof e.type !== 'string' || typeof e.target !== 'number') return false
    return ONLY_RECORDED_KINDS.includes(e.type) && !rejectedKeys.has(e.type + '\u0000' + String(e.target))
  })
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
  // 归档标记只在显式检索（给了 flags）时才会出现，所以读到这里就说明调用方要的是它们。
  if ((r.flags & FLAG_ARCHIVED) !== 0) marks.push('已归档')
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

/** 构造四个业务工具的定义。cfg 在闭包里，apply 时解析一次。 */
export function buildTools(cfg: RuntimeConfig): unknown[] {
  const writeTool = defineTool({
    name: 'lattice_write',
    description:
      '记住一件事。仅在值得跨会话复用时调用；对话里临时说过的不要写。写之前先 recall 查重 ——' +
      '重复只会提示、不会拦你。太短的碎片会被拒收，过长的会按句拆成多条。' +
      '改口用 supersedes：把它想取代的那条旧记忆标成「已被本条取代」；撤销一次改口用 unsupersede：' +
      '把被取代的那条清回来。两者作用相反 —— supersedes 建立标记、unsupersede 清掉标记，' +
      '一次调用只能给其中一个。',
    // 注意形状：parameters 是「属性名 → 值 schema」的映射，**不是** {type, properties}。
    // 必填写成属性上的 required: true。写错会在 defineTool 时就抛错，整个插件加载失败。
    parameters: {
      text: {
        type: 'string',
        description: '记忆正文。一条讲清一件事，要成句。',
        required: true,
      },
      kind: {
        type: 'string',
        description: '结论 / 坑 / 命令与参数 / 环境 / 步骤 / 数据；默认 结论，未知值按结论记。',
      },
      refs: {
        type: 'array',
        items: { type: 'string' },
        description: '用户以后会怎么找它：同义词、俗称、报错原文。例：["pnpm 装不上", "符号链接失败"]',
      },
      topic_hint: { type: 'number', description: '已知归属主题 id 时直接指定' },
      scope: { type: 'string', description: 'global 或项目键，默认 global' },
      source: {
        type: 'string',
        description:
          '这条记忆来自哪里（同一篇文档、同一次会话、同一个导出文件）。' +
          '只用于判断两条是否同源重复：来源相同且文本高度重叠时，注入段只留一条，并说明压掉了几条。' +
          '不传就不做同源判断 —— 没有来源证明不了同源。',
      },
      origin: {
        type: 'string',
        description:
          '谁说的：user（用户明确说过的，事实/偏好/决定必须标它）/ model（你推断的，默认）/ import',
      },
      supersedes: {
        type: 'number',
        description: '取代哪条旧记忆的 id（改口时用）；旧条只标记，不删。',
      },
      unsupersede: {
        type: 'number',
        description:
          '取消哪条记忆的被取代状态（撤销一次改口时用）：传被取代的那条 id，把它的「已被 #N 取代」清掉。' +
          '只清标记：不删行、不改内容；本来就没有被取代时如实说明，不报错。',
      },
      edges: {
        type: 'array',
        description:
          '关系边：[{type, target}]。type 推荐 related / refines / duplicate / requires，' +
          '自取须小写（字母、数字、下划线，≤32 字符）；target 是已有记忆 id。' +
          '取代不走这里：用顶层参数 supersedes，edges 里的 supersedes 会被拒。' +
          '最多 ' +
          OUT_DEGREE_CAP +
          ' 条；不合法的边被跳过并逐条说明。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', required: true, description: '关系类型，推荐值见上' },
            target: { type: 'number', required: true, description: '已有记忆的 id' },
          },
        },
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
      const unsup =
        typeof args?.unsupersede === 'number' && Number.isFinite(args.unsupersede)
          ? args.unsupersede
          : undefined
      // 两个参数方向相反：同时给出来是调用方搞错了，与其猜一边，不如一次说清并拒绝。
      // 这一步放在写库之前 —— 回执说「没有写库」就必须真的没写。
      if (sup !== undefined && unsup !== undefined) {
        return (
          '写入失败：supersedes 与 unsupersede 不能同时给 —— 一个建立取代关系、一个取消它。' +
          '要改口就只传 supersedes（并写新的那条）；要撤销改口就只传 unsupersede。这次没有写库。'
        )
      }
      // 形状由 write.ts 的 validateDeclaredEdges 校验：工具层**原样搬运**，连「不是数组」
      // 也交给它 —— 否则那种输入会被这里静默丢掉，调用方看不到任何说明。
      const edges = args?.edges === undefined ? undefined : (args.edges as DeclaredEdgeInput[])
      let out
      try {
        // 写入侧审核层在 writeReviewed 里：长度类**自动处理**（过短拦下 / 过长切分），
        // 重复与高相似只产生提示。两者的产出都只经这一个返回值出去 —— 不写库、不建队列、
        // 不产生需要人处理的待办（§11.1：插件不做判断，只提供判断所需的信息）。
        out = await writeReviewed(rt.write, {
          text,
          kind: str(args?.kind, '结论'),
          scope: str(args?.scope, 'global'),
          refs,
          topicHint: hint,
          origin: str(args?.origin, 'model'),
          source:
            typeof args?.source === 'string' && args.source.trim() !== '' ? args.source.trim() : undefined,
          edges,
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
        // 「尚未确认归属」而不是「已标记待定」：后者会被读成「库里有个待办等人处理」，
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
        // 位标志摘要（判据 6）：给出**可核对的说法**，不让模型靠读中文猜。
        // 位定义在 db/flags.ts 的 FLAG_*，与 ARCHITECTURE 一一对应。
        if (r.flags !== undefined && r.flags !== 0) {
          const tags: string[] = []
          if ((r.flags & 2) !== 0) tags.push('歧义（两个候选接近）')
          if ((r.flags & 4) !== 0) tags.push('未归类')
          // 待拆分：只说是**怎么来的**，不说「该拆」—— 切点按长度定，没读内容。
          if ((r.flags & 1) !== 0) tags.push('待拆分（按长度切出）')
          lines.push('标记：' + tags.join('；') + '（flags=' + r.flags + '）')
        }
        // 重复 / 高相似的提示挂在这里。**写入已经发生**，提示只是让调用方知道
        // 「库里另有一条与它重合」—— 处置权在它手上。
        for (const n of r.review ?? []) lines.push(n.message)
        // 声明边：落库的与没落库的分开说。**只拒边、不拒记忆** ——
        // 拒因必须回显，否则调用方会以为关系已经建立（与防写回同一条纪律）。
        if (r.edgesDeclared !== undefined) {
          // duplicate 只记一行关系：不改去重判定。回执里点明，否则读的人会以为
          // 声明了重复就等于压制生效。（supersedes 已被拒边，见 write.ts。）
          lines.push(
            '关系 ' +
              r.edgesDeclared +
              ' 条（声明）' +
              (hasOnlyRecordedEdge(edges, r.edgesRejected) ? DECLARED_EDGE_ONLY_NOTE : ''),
          )
        }
        for (const n of r.edgesRejected ?? []) {
          const label =
            (n.type === '' ? '（无 type）' : n.type) + (n.target === null ? '' : ' → #' + n.target)
          lines.push('关系未建立：' + label + '，' + n.reason)
        }
      })
      if (multi) {
        // 两件事都只说后果：切分是**按长度**做的（判据 7 不允许暗示做过内容判断），
        // topic_hint 不沿用是切分的直接结果，不是「这段一定能独立成主题」。
        lines.push('（原文按长度切分，topic_hint 未沿用：各段各自落位、各自判断主题归属。）')
        // 边只落在第一条。不说的话，调用方会以为每一段都挂上了同一批关系。
        if (out.results.some((r) => r.edgesDeclared !== undefined || r.edgesRejected !== undefined)) {
          lines.push('（关系只落在第一条。）')
        }
      }

      // 只改 superseded_by 与 superseded_at：取代改的是关系，不改内容，所以不碰
      // updated_at —— 词表缓存的失效戳读的就是 MAX(updated_at)，被取代不该让它失效。
      //
      // 取代关系只落在这里：写入侧的事务内固定 O(1) 行数，多一条 UPDATE 就多一份
      // 写锁持有时间，而这不是热路径。
      // 切分后「本条」是多条 atom，取代关系只能落在一条上 —— 落在第一条，并把落在
      // 哪一条写进反馈，免得调用方以为每段都建立了取代关系。
      //
      // **不加「检测到切分就多落几条」的防御**：那会让一次写入的行数随切分段数增长，而写入
      // 事务内固定行数是有意的（多一条 UPDATE 就多一份写锁持有时间）。这条约定靠测试钉住：
      // test/tools.test.mjs 的「切分后取代只落第一条，回执写明落在哪」。
      if (sup !== undefined) {
        const target = out.results[0]!
        const u = rt.db
          .prepare('UPDATE atom SET superseded_by = ?, superseded_at = ? WHERE id = ? AND id <> ?')
          .run(target.atomId, Date.now(), sup, target.atomId)
        lines.push(
          Number(u.changes) === 0
            ? '注意：要取代的记忆 #' + sup + ' ' + absenceOf(rt, sup) + '，未建立取代关系。'
            : '已把 #' +
                sup +
                ' 标记为被 #' +
                target.atomId +
                (multi ? '（切分后的第一条）' : '（本条）') +
                '取代（旧条不会删除）。',
        )
      }
      // 取消取代：与 supersedes 对称，只动 superseded_by 与 superseded_at 两列 ——
      // 不删行、不改内容、不碰 updated_at、不碰 edge 表（库里的关系行原样保留）。
      // 三种结果分开说：「没有改动」有两个不同原因（id 不在库里 / 本来就没被取代），
      // 混成一句，调用方就不知道下一步该做什么。
      if (unsup !== undefined) {
        const row = rt.db.prepare('SELECT superseded_by FROM atom WHERE id = ?').get(unsup) as
          { superseded_by: number | bigint | null } | undefined
        if (row === undefined) {
          lines.push('注意：记忆 #' + unsup + ' ' + absenceOf(rt, unsup) + '，未改动任何东西。')
        } else if (row.superseded_by === null || row.superseded_by === undefined) {
          lines.push('记忆 #' + unsup + ' 本来就没有被取代，未改动。')
        } else {
          const by = Number(row.superseded_by)
          rt.db.prepare('UPDATE atom SET superseded_by = NULL, superseded_at = NULL WHERE id = ?').run(unsup)
          lines.push(
            '已取消 #' +
              unsup +
              ' 的被取代标记：#' +
              by +
              ' 不再取代它，两条记忆都还在；' +
              '再用原文召回，它会重新出现。',
          )
        }
      }
      return lines.join('\n')
    },
  })

  const recallTool = defineTool({
    name: 'lattice_recall',
    description:
      '按需取回记忆。返回一段【入选】：逐条给出记忆正文（每条带 id，标「我」=用户说的、「导入」=外部来源、「已被 #N 取代」=已修订）；末尾最多三句汇总说明压掉的条目（已被取代 / 与同源内容重复 / 预算装不下）。库里没有相关内容的，会直接说没有。答案取决于「之前定过什么」的问题先查；与历史无关的常识不必查。',
    parameters: {
      query: {
        type: 'string',
        description: '用你自己的话描述要找什么，不必迁就记忆里的措辞',
        required: true,
      },
      budget: { type: 'number', description: '返回文本的字符预算' },
      scope: {
        type: 'string',
        description:
          '只召回这个域的记忆（global 或项目键）；给定时连同 global 一起。不传则不限域 —— 写进项目域的记忆也能召回到。',
      },
    },
    output: textOutput(),
    async execute(args: Record<string, unknown>) {
      const rt = getRuntime(cfg)
      const q = str(args?.query).trim()
      if (q === '') return '查询为空。'
      // scope 与写入侧的默认值不同：写入缺省 global，召回缺省「不限」。
      // 两个默认值不同是有意的 —— 写不知道自己在哪个项目域里，读不该替它选一个。
      const scopeArg = str(args?.scope).trim()
      const vq = await runtimeEncode(cfg, q)
      // 参考线：一个与库无关的问题在本库最高能拿到多少余弦。首次要把 48 条内置问句各
      // 编码一次（约 1 秒），之后按 atom 行数缓存，稳态零成本。编码器不可用时它返回
      // usable: false，判定随之为 null —— 那时不判，比按一条不存在的线判成「没内容」好。
      const ref = await referenceFor(rt.db, (text) => runtimeEncode(cfg, text))
      const recalled = recall(rt.db, q, vq, {
        topN: cfg.topN,
        scope: scopeArg === '' ? undefined : scopeArg,
        reference: { line: ref.p90, usable: ref.usable, reason: ref.reason },
      })
      // 降级留痕：只入队，不阻塞召回（见 src/log/index.ts 的队列与批量窗口）。
      noteRecallDegradations(recalled.meta)
      const view = assembleView(rt.db, recalled, {
        budget: num(args?.budget, cfg.viewBudget),
        // 本次查询词，只用于待拆分候选的「使用场景」：设计要的就是「把这条疑似
        // 该拆的记忆连同它被用来解决什么一起给出来」。其他锚行不受影响。
        scene: q,
      })

      const notes: string[] = [libraryLine(rt)]
      if (recalled.meta.vectorMissing) notes.push('（编码器不可用，本次为纯词面召回）')
      if (recalled.meta.lexicalDegraded) notes.push('（词面两路均未命中，仅向量路有结果）')
      if (recalled.meta.shortTermMiss) notes.push('（查询含两字词但入口层零命中）')
      // 不再报「最高相似度 0.47」这类分数：分数是本插件内部的刻度，用户拿不到对照，
      // 报出来只会让人以为它能跨库比较（实测同一句无关问句在三个库上差 0.079）。
      // 判据改成与本库自己的参考分布比，结论只有两态，见 pipeline/refdist.ts。
      const refNote = referenceNote(ref, recalled.hits.length)
      if (refNote !== null) notes.push(refNote)
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
      // 判空在装填之前：库里确实没有针对这个问题的内容时，给出任何一条都是凑数。
      // 那句话只在这一个结论上出现，与「候选耗尽」的措辞不同 —— 两件事看起来像，含义相反：
      // 一个是「库里没有」，一个是「库里有但只找到这么多」。
      if (recalled.meta.hasContent === false) {
        return notes.join('\n') + '\n\n库里没有针对这个问题的内容。'
      }
      if (recalled.hits.length === 0) return notes.join('\n') + '\n\n没有找到相关记忆。'
      // 判空时 assembleView 给的是空串（见 pipeline/view.ts 的短路返回），别拼出一个空行。
      const tail: string[] = view.text.length > 0 ? [view.text] : []
      if (view.anchors === 1) tail.push('只找到一条相关的。')
      else if (recalled.hits.length < (cfg.topN ?? RECALL_TOP_N)) {
        tail.push('候选用完了，只有 ' + recalled.hits.length + ' 条。')
      }
      return notes.join('\n') + '\n\n' + tail.join('\n') + '\n\n（' + DECLARED_EDGE_HINT + '）'
    },
  })

  const expandTool = defineTool({
    name: 'lattice_expand',
    description:
      '展开某条记忆的全文，或列同主题的其它记忆。召回只给摘要或截断正文时用。mode=related 看同主题下是否有矛盾说法。',
    parameters: {
      atom_id: {
        type: 'number',
        description: '召回【入选】段里的 id',
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
        .prepare('SELECT id, kind, text, topic_id, origin, superseded_by, flags FROM atom WHERE id = ?')
        .get(id) as
        | {
            id: number | bigint
            kind: string
            text: string
            topic_id: number | bigint
            origin: string
            superseded_by: number | bigint | null
            flags: number | bigint
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
      // 归档：归档条目仍可按 id 展开（显式检索是设计），但读的人要知道它已归档 ——
      // 否则展开输出与未归档的完全一样。标记只加一句，可见性不变。
      if ((Number(row.flags) & FLAG_ARCHIVED) !== 0) meta.push('已归档')
      // 声明边：展开时把这条记忆**说过的**关系列出来，模型才能核对
      // 「我声明的那条关系在不在」。只列 origin = declared 且方向是「这条 → 别条」的：
      // 推断出来的 near 边是派生物（召回【路】段已经在展示），方向反过来的边去查另一端更自然。
      const declared = rt.db
        .prepare(
          'SELECT e.kind AS kind, e.dst_id AS oid, b.summary AS summary FROM edge e' +
            ' JOIN atom b ON b.id = e.dst_id' +
            " WHERE e.src_type = 'atom' AND e.dst_type = 'atom' AND e.origin = ? AND e.src_id = ?" +
            ' ORDER BY e.id LIMIT ?',
        )
        .all(DECLARED_ORIGIN, Number(row.id), OUT_DEGREE_CAP) as Array<{
        kind: string
        oid: number | bigint
        summary: string
      }>
      const tail: string[] = []
      if (declared.length > 0) {
        tail.push('', '关系（声明）' + declared.length + ' 条：')
        for (const d of declared) {
          const kind = String(d.kind)
          // 与回执同一句话：这两类只记录关系，不改变取代 / 去重状态。
          tail.push(
            '- ' +
              kind +
              ' → #' +
              Number(d.oid) +
              ' ' +
              String(d.summary) +
              (ONLY_RECORDED_KINDS.includes(kind) ? DECLARED_EDGE_ONLY_NOTE : ''),
          )
        }
      }
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
        ...tail,
      ].join('\n')
    },
  })

  const listTool = defineTool({
    name: 'lattice_list',
    description:
      '列出库里有什么（目录视图，不是搜索）。问「你记得哪些关于 X 的事」时先用它。分页，最近写的在前。',
    parameters: {
      kind: { type: 'string', description: '只看某一类：结论 / 坑 / 命令与参数 / 环境 / 步骤 / 数据' },
      origin: {
        type: 'string',
        description: '只看某一来源：user / model / import',
      },
      scope: { type: 'string', description: '项目键；给定时连同全局记忆一起列出' },
      topic: { type: 'number', description: '只看某个主题下的记忆' },
      flags: {
        type: 'number',
        description:
          '只列需要留意的：1 = 待拆分（写入时按长度切出，切点未判内容）、' +
          '2 = 两个主题都像（歧义）、4 = 未归类、16 = 已归档' +
          '（默认不列，显式给 flags 时才列）；3 = 两类都要',
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

  return [writeTool, recallTool, expandTool, listTool]
}

/**
 * `lattice_feedback` 的**定义**：它存在，但**当前未启用**，不进工具表。
 *
 * 它记录的是「模型对上次召回的判断」—— 当初是校准样本的唯一人工入口，用来找判定线的切点。
 * 那条链在 0.5.0 之后整体退役：判定线改成「本库无关问句分数的 p90」（pipeline/refdist.ts），
 * 那是**分布**问题，不需要标签；样本库、四道闸、重标与切点扫描一起删掉了。
 * 判断数据仍可用于离线评估与人工审计，但不参与运行期行为。
 *
 * 那为什么还留着定义？因为「判断信号能改变什么」这个问题问过一次、答过一次，答案固定在
 * 代码里比只留在提交历史里更容易找到。将来要启用，前提是先重新论证这一点（见
 * docs/INTEGRATION.md 的「调用与副作用的三条纪律」）。
 *
 * 与 `FORGET_TOOL_SPEC` 同一个形态：名字与参数在，不进 `buildTools` 的返回数组 ——
 * 「模型可见的工具表」在本仓库里就是那个数组。宿主对未注册的名字回 UNKNOWN_TOOL。
 */
export const FEEDBACK_TOOL_NAME = 'lattice_feedback'

export const FEEDBACK_TOOL_SPEC = {
  name: FEEDBACK_TOOL_NAME,
  description:
    '对上次召回给出反馈：第几条有用（positive）或无关（negative）。ref 是上次召回结果里的 1-based 序号（注入文本里【入选】清单的顺序），不是记忆 id。**当前未启用**：模型侧看不到这个工具，定义留下只为固定参数契约。',
  parameters: {
    kind: { type: 'string', description: 'positive 或 negative', required: true },
    ref: { type: 'number', description: '上次召回第几条（1-based）', required: true },
  },
} as const

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

/**
 * 参考线「判不了」时要补的那句话。返回 null 表示没有要补的。
 *
 * 判不了有两种，原因相反，措辞必须不同：
 *   - 库太小（atom 数不到内置问句数）：参考线估不准，但线本身还成立；
 *   - 库的内容面太宽（p90 越过失效线）：参考线自己失效，判空这一步整体关掉。
 *
 * 为什么一定要说：这两种情形下 `hasContent` 都是 null，渲染层不会写「库里没有」，
 * 但也不会写任何别的 —— 不说话时，读的人分不清「没内容」和「没判」，会把前者当结论。
 * 第二种的两种措辞按有没有命中分开：命中为空时「以下是」指向空气。
 */
export function referenceNote(ref: { reason: string; atoms: number }, hitCount: number): string | null {
  if (ref.reason === 'library-too-small') {
    return hitCount > 0 ? '库里只有 ' + ref.atoms + ' 条，判定还不可靠；以下是按相关度列出的前几条。' : null
  }
  if (ref.reason === 'line-too-high') {
    return hitCount > 0
      ? '这个库的内容面比判定用的参考问句宽，判空这一步关掉了；以下是按相关度列出的前几条。'
      : '这个库的内容面比判定用的参考问句宽，判空这一步关掉了；这次没有相关度靠前的条目。'
  }
  return null
}

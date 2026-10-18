// 体检（audit）：把「库有没有坏」变成可以问出来的结构指标。
//
// 三条边界，写在最前面：
//   1. **只读**：只做 SELECT。不建表、不迁移、不建图、不记召回命中、不写日志。
//      「没有数据」与「没有发现」是两件事（T35 判据 7）：前者要说「先跑一次重建」，
//      后者才是「比过了，没有」。把两者压成同一个 0，空库会看起来一切正常。
//   2. **不下判决**：结构比例只作参考（U2 结案，裁决 #23）。比例随领域混合度变化，
//      同一套代码在不同语料上会给出不同数，不能当红线。行为检查在
//      `scripts/probe-topic-health.mjs` 里，跑临时库，不进本模块。
//   3. **不进模型侧**：本模块只被只读路由 `/api/lattice-audit` 与测试调用，不注册成工具
//      （裁决 #26）。模型侧固定六个工具，其中没有 audit（裁决 #30 的第 6 个是 feedback）。
//
// 口径只写在这一处：T28 面板、维护脚本、测试都从这里取数；面板只做展示，不另算一套。
//
// 指标清单（括号里是它回答的问题）：
//   · atom 总数（含已归档）、其中已归档的条数、topic 数（n_atoms > 0 的那些）
//   · 单成员 topic 占比（topic 层退化的可观测形态之一）
//   · atom / topic 比（另一个形态；1.0 = 每条记忆各自成主题）
//   · 图路状态（inferred 边在不在、各类多少 —— 与 search.ts 的 graphStatus 同一件事）
//   · 入口噪声（每 atom 平均 entry 数、learned 占比）
//   · 高相似却未合并的 atom 对（读 atom_pair；同 topic 的不算）
//   · 孤立 atom（无边且单成员 topic）
//   · 从未被召回过的 atom 数（recall_hits = 0）
//
// 其中「高相似未合并对」依赖 atom_pair，而它由重聚类建立。表是空的时，本模块不能
// 从「0 行」推断出「没有重复」—— 那正是判据 7 要防的误读。建立者会在 meta 里留下
// `recluster_at`（见 cluster/rebuild.ts 的 rebuildAtomPairs），体检据此区分「没建过」与
// 「建过但没有」。这个标记只加在写侧；本模块仍然只读。

import type { DatabaseSync } from 'node:sqlite'
import { getMeta, META_RECLUSTER_AT } from '../db/meta.js'
import { GRAPH_INFER_MAX_ATOMS, INFERRED_ORIGIN } from '../graph/infer.js'
import { DUP_COS, DUP_LEX } from './search.js'
import { FLAG_ARCHIVED } from './write.js'
// 分页上界与页大小**复用目录的两个数**：两者防的是同一件事（一次拉爆上下文），
// 各写一份只会让「界面一屏能放多少行」出现两个口径。
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from './list.js'

/**
 * 孤立 atom 的定义。**写进输出**，不留在注释里：
 * 同一个词在不同文档里可以指不同的东西，而「孤立」在这里是可数的那一种。
 */
export const ORPHAN_DEFINITION =
  '孤立 atom = 在 edge 里作为 src 或 dst 都不出现，且主属 topic 只有它一个成员（topic.n_atoms = 1）'

/** 体检参数。仅分页两项 —— 体检没有筛选开关，口径不随调用方变。 */
export interface AuditOptions {
  limit?: number
  offset?: number
}

/** 一组「发现」的三种状态。no-data 与 no-findings 必须分开（判据 7）。 */
export type FindingState = 'no-data' | 'no-findings' | 'has-findings'

/** 高相似却落在两个 topic 里的一对 atom。 */
export interface DuplicatePairRow {
  aId: number
  bId: number
  cos: number
  lexical: number
  aTopicId: number
  bTopicId: number
  aSummary: string
  bSummary: string
}

/** 孤立 atom 的一行。 */
export interface OrphanRow {
  id: number
  summary: string
  topicId: number
}

/** 体检报告。字段全部可序列化，路由直接返回它。 */
export interface AuditReport {
  /** 库的 schema 版本（只读读出来的实际值，不是插件支持的版本）。 */
  schemaVersion: number
  /** empty = 库里一条 atom 都没有；ready = 有数据可体检。 */
  dataState: 'empty' | 'ready'
  /** 给调用方的一句话：为什么是 empty，或这批数字的边界在哪。 */
  detail: string
  /**
   * 固定为 true。结构比例不是判决：U2 已定「比例随领域混合度变化，只作参考」。
   * 保留成字段而不是只在文档里说，是因为面板与调用方都拿得到这个返回。
   */
  referenceOnly: true
  /** 口径出处与行为检查的位置。不含任何「通过 / 失败」式结论。 */
  note: string
  topics: {
    /**
     * atom 总数（活着的记忆；墓碑在 forgotten 表，不在这个数里）。
     *
     * **含已归档**：归档不是删除，内容仍在库里，也仍参与建边与重聚类。体检是给
     * 维护者看的库形态，把归档从分母里剔除会让「库里有多少条」与「有多少条可能被召回」
     * 变成两个不说明的数。两者都报：总数在这里，归档数在下一项。
     */
    atoms: number
    /**
     * 其中已归档（flags 的 bit4）的条数，archived ≤ atoms。
     *
     * 口径与 atoms 一致：下面所有按 atom 计数的项（单成员 topic、孤立、从未被召回、
     * 入口平均、重复对）**都包含归档条目**。没有一处偷偷排除，也没有一处只算归档。
     */
    archived: number
    /** 有成员的 topic 数（n_atoms > 0；空 topic 不计）。 */
    withAtoms: number
    /** 单成员 topic 数。 */
    singleMember: number
    /** 单成员 topic / 有成员的 topic；没有 topic 时为 null（不是 0）。 */
    singleMemberRatio: number | null
    /** atom / topic 比；没有 topic 时为 null。1.0 表示每条记忆各自成主题。 */
    atomTopicRatio: number | null
    /** 没有主属 topic 的 atom 数（正常应为 0；不为 0 说明写入路径漏了落位）。 */
    withoutTopic: number
  }
  graph: {
    state: 'no-data' | 'ready'
    /**
     * 与 search.ts 的 graphStatus 同一件事，但**不触发建边**：
     * not-built = 库里没有 inferred 边；built = 有；too-large = 规模超过全量推断上限。
     */
    status: 'not-built' | 'built' | 'too-large'
    /** inferred 边总数。 */
    inferredEdges: number
    /** 按 kind 的 inferred 边数（near / duplicate / ...）。 */
    byKind: Record<string, number>
    detail: string
  }
  entries: {
    state: 'no-data' | 'ready'
    /** 入口总数。 */
    total: number
    /** 每 atom 平均入口数；没有 atom 时为 null。 */
    perAtom: number | null
    declared: number
    extracted: number
    learned: number
    /** learned / total；没有入口时为 null。learned 是召回反哺，偏高意味着入口噪声。 */
    learnedRatio: number | null
  }
  duplicates: {
    state: FindingState
    /** 满足重复线、且两个 atom 分属不同 topic 的总对数（不是本页条数）。 */
    total: number
    limit: number
    offset: number
    rows: DuplicatePairRow[]
    /** 上次重聚类时间（meta.recluster_at）；从未重聚类时为 null。 */
    rebuiltAt: number | null
    /** 上次重聚类之后新增的 atom 数 —— 这些 atom 没参与比对，读数要带上这句。 */
    atomsAfterRebuild: number | null
    detail: string
  }
  orphans: {
    state: FindingState
    total: number
    limit: number
    offset: number
    rows: OrphanRow[]
    /** 定义写进输出：孤立在这里是「无边 + 单成员 topic」，不是别的意思。 */
    definition: string
    detail: string
  }
  recall: {
    atoms: number
    /** recall_hits = 0 的 atom 数。 */
    neverRecalled: number
    /** neverRecalled / atoms；没有 atom 时为 null。 */
    neverRecalledRatio: number | null
  }
}

/** 取一个 COUNT(*) 的整数。node:sqlite 可能给 bigint。 */
function count(db: DatabaseSync, sql: string, ...args: Array<string | number>): number {
  const row = db.prepare(sql).get(...args) as { n: number | bigint } | undefined
  return Number(row?.n ?? 0)
}

/** 表在不在。老库（v1）没有 meta 表，直接查会抛 —— 体检要能读老库。 */
function hasTable(db: DatabaseSync, name: string): boolean {
  return count(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", name) > 0
}

/** 分页参数：与目录同一个钳位规则，非法值退回默认而不是猜。 */
function pageOf(opts: AuditOptions): { limit: number; offset: number } {
  const rawLimit = Number(opts.limit ?? LIST_DEFAULT_LIMIT)
  const rawOffset = Number(opts.offset ?? 0)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(LIST_MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : LIST_DEFAULT_LIMIT
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
  return { limit, offset }
}

const NOTE =
  '结构比例只作参考，不构成判决（U2 结案，裁决 #23：比例随领域混合度变化）。' +
  '行为检查见 scripts/probe-topic-health.mjs（跑临时库，不进本模块）。'

/**
 * 空报告：库文件不存在，或库还没有 schema。
 *
 * **不编数**：比例给 null 而不是 0。0 会被读成「一条都没合并」，那是结论；
 * null 才是「这里没有数」。
 */
export function noDataReport(opts: AuditOptions = {}, detail = ''): AuditReport {
  const { limit, offset } = pageOf(opts)
  return {
    schemaVersion: 0,
    dataState: 'empty',
    detail: detail === '' ? '库里没有可体检的数据' : detail,
    referenceOnly: true,
    note: NOTE,
    topics: {
      atoms: 0,
      archived: 0,
      withAtoms: 0,
      singleMember: 0,
      singleMemberRatio: null,
      atomTopicRatio: null,
      withoutTopic: 0,
    },
    graph: {
      state: 'no-data',
      status: 'not-built',
      inferredEdges: 0,
      byKind: {},
      detail: '库里没有任何 atom：图路没有输入。',
    },
    entries: {
      state: 'no-data',
      total: 0,
      perAtom: null,
      declared: 0,
      extracted: 0,
      learned: 0,
      learnedRatio: null,
    },
    duplicates: {
      state: 'no-data',
      total: 0,
      limit,
      offset,
      rows: [],
      rebuiltAt: null,
      atomsAfterRebuild: null,
      detail: '没有数据：atom_pair 由重聚类建立，库里还没有可比较的 atom。',
    },
    orphans: {
      state: 'no-data',
      total: 0,
      limit,
      offset,
      rows: [],
      definition: ORPHAN_DEFINITION,
      detail: '没有数据：库里没有任何 atom。',
    },
    recall: { atoms: 0, neverRecalled: 0, neverRecalledRatio: null },
  }
}

/**
 * 出一次体检。**只读**：整个函数只有 SELECT 与 PRAGMA user_version。
 *
 * 注意它**不调用** recall 的 ensureGraphOnce：那条路会建 inferred 边，是写操作。
 * 体检报「图路还没建」，由调用方决定要不要跑重建 —— 体检不替调用方做决定。
 */
export function audit(db: DatabaseSync, opts: AuditOptions = {}): AuditReport {
  if (!hasTable(db, 'atom')) {
    return noDataReport(
      opts,
      '库文件存在但还没有 atom 表（schema 未初始化）：这是「无数据」，不是「没有发现」。',
    )
  }
  const { limit, offset } = pageOf(opts)
  const schemaVersion = Number(
    (db.prepare('PRAGMA user_version').get() as { user_version?: number | bigint } | undefined)
      ?.user_version ?? 0,
  )

  // 口径（T26 判据 8）：体检按**整库**计数，归档条目照常计入每一项 ——
  // 它们是还活着的记忆（内容、入口、边都在），只是默认不召回。为避免「一个总数、两种口径」，
  // 归档数单独报一项（topics.archived），不把任何一项的分母改成「未归档的子集」。
  const atoms = count(db, 'SELECT COUNT(*) AS n FROM atom')
  const archived = count(db, 'SELECT COUNT(*) AS n FROM atom WHERE (flags & ?) <> 0', FLAG_ARCHIVED)
  const withAtoms = count(db, 'SELECT COUNT(*) AS n FROM topic WHERE n_atoms > 0')
  const singleMember = count(db, 'SELECT COUNT(*) AS n FROM topic WHERE n_atoms = 1')
  const withoutTopic = count(db, 'SELECT COUNT(*) AS n FROM atom WHERE topic_id IS NULL')
  const empty = atoms === 0

  // ── 图路 ──────────────────────────────────────────────────────────────
  const inferredEdges = count(db, 'SELECT COUNT(*) AS n FROM edge WHERE origin = ?', INFERRED_ORIGIN)
  const byKind: Record<string, number> = {}
  const kindRows = db
    .prepare('SELECT kind, COUNT(*) AS n FROM edge WHERE origin = ? GROUP BY kind ORDER BY kind')
    .all(INFERRED_ORIGIN) as Array<{ kind: string; n: number | bigint }>
  for (const r of kindRows) byKind[String(r.kind)] = Number(r.n)
  let graphStatus: AuditReport['graph']['status']
  let graphDetail: string
  if (empty) {
    graphStatus = 'not-built'
    graphDetail = '库里没有任何 atom：图路没有输入。'
  } else if (atoms > GRAPH_INFER_MAX_ATOMS) {
    graphStatus = 'too-large'
    graphDetail =
      'atom 数 ' +
      atoms +
      ' 超过全量推断上限 ' +
      GRAPH_INFER_MAX_ATOMS +
      '：ensureGraphEdges 会拒绝重建，图路保持空。'
  } else if (inferredEdges === 0) {
    graphStatus = 'not-built'
    graphDetail = '库里没有 inferred 边：图路没有输入。召回第一次调用会尝试建一次；体检本身不建（只读）。'
  } else {
    graphStatus = 'built'
    graphDetail = 'inferred 边 ' + inferredEdges + ' 条。'
  }

  // ── 入口噪声 ──────────────────────────────────────────────────────────
  const entryByOrigin: Record<string, number> = {}
  const entryRows = db
    .prepare('SELECT origin, COUNT(*) AS n FROM entry GROUP BY origin ORDER BY origin')
    .all() as Array<{ origin: string; n: number | bigint }>
  for (const r of entryRows) entryByOrigin[String(r.origin)] = Number(r.n)
  const entryTotal = Object.values(entryByOrigin).reduce((a, b) => a + b, 0)
  const declared = entryByOrigin.declared ?? 0
  const extracted = entryByOrigin.extracted ?? 0
  const learned = entryByOrigin.learned ?? 0

  // ── 高相似未合并对（读 atom_pair，同 topic 的不算）───────────────────
  const rebuiltAt = hasTable(db, 'meta') ? metaNumber(db, META_RECLUSTER_AT) : null
  const pairRowsTotal = count(db, 'SELECT COUNT(*) AS n FROM atom_pair')
  const atomsAfterRebuild =
    rebuiltAt === null ? null : count(db, 'SELECT COUNT(*) AS n FROM atom WHERE created_at > ?', rebuiltAt)
  const pairWhere =
    'p.cos >= ? AND p.lexical >= ? AND a.topic_id IS NOT NULL AND b.topic_id IS NOT NULL ' +
    'AND a.topic_id <> b.topic_id'
  const pairFrom =
    ' FROM atom_pair p JOIN atom a ON a.id = p.a_id JOIN atom b ON b.id = p.b_id WHERE ' + pairWhere
  const duplicateTotal = count(db, 'SELECT COUNT(*) AS n' + pairFrom, DUP_COS, DUP_LEX)
  const duplicateRows =
    duplicateTotal === 0
      ? []
      : (db
          .prepare(
            'SELECT p.a_id, p.b_id, p.cos, p.lexical, a.topic_id AS a_topic, b.topic_id AS b_topic, ' +
              'a.summary AS a_summary, b.summary AS b_summary' +
              pairFrom +
              ' ORDER BY p.cos DESC, p.a_id, p.b_id LIMIT ? OFFSET ?',
          )
          .all(DUP_COS, DUP_LEX, limit, offset) as Array<Record<string, unknown>>)

  let duplicateState: FindingState
  let duplicateDetail: string
  if (empty || atoms < 2) {
    duplicateState = 'no-data'
    duplicateDetail = '没有数据：atom 少于 2 条，没有可比的对。'
  } else if (rebuiltAt === null) {
    duplicateState = 'no-data'
    duplicateDetail =
      '没有数据：atom_pair 由重聚类建立，库里没有重聚类记录（meta.recluster_at 缺失）。' +
      '先跑一次重建，再来读这一项 —— 空表不等于没有重复。'
  } else if (duplicateTotal === 0) {
    duplicateState = 'no-findings'
    duplicateDetail =
      pairRowsTotal === 0
        ? '已重聚类（' +
          rebuiltAt +
          '），没有达到重复线（cos ≥ ' +
          DUP_COS +
          ' 且词面 ≥ ' +
          DUP_LEX +
          '）的对。'
        : '已重聚类（' +
          rebuiltAt +
          '），atom_pair 里有 ' +
          pairRowsTotal +
          ' 对，但它们都已在同一 topic 内 —— 不算未合并。'
  } else {
    duplicateState = 'has-findings'
    duplicateDetail = '发现 ' + duplicateTotal + ' 对高相似但分属不同 topic 的 atom。'
  }
  if (atomsAfterRebuild !== null && atomsAfterRebuild > 0) {
    duplicateDetail += ' 另有 ' + atomsAfterRebuild + ' 条 atom 在上次重聚类之后写入，未参与比对。'
  }

  // ── 孤立 atom ────────────────────────────────────────────────────────
  const orphanFrom =
    ' FROM atom a JOIN topic t ON t.id = a.topic_id WHERE t.n_atoms = 1 AND NOT EXISTS (' +
    "SELECT 1 FROM edge e WHERE (e.src_type = 'atom' AND e.src_id = a.id) " +
    "OR (e.dst_type = 'atom' AND e.dst_id = a.id))"
  const orphanTotal = empty ? 0 : count(db, 'SELECT COUNT(*) AS n' + orphanFrom)
  const orphanRows =
    orphanTotal === 0
      ? []
      : (db
          .prepare('SELECT a.id, a.summary, a.topic_id' + orphanFrom + ' ORDER BY a.id LIMIT ? OFFSET ?')
          .all(limit, offset) as Array<Record<string, unknown>>)

  return {
    schemaVersion,
    dataState: empty ? 'empty' : 'ready',
    detail: empty
      ? '库里没有任何 atom：下列各项都是「无数据」，不是「没有发现」。'
      : '结构指标只描述当前库的形态，不构成判决；行为检查请跑 scripts/probe-topic-health.mjs。',
    referenceOnly: true,
    note: NOTE,
    topics: {
      atoms,
      archived,
      withAtoms,
      singleMember,
      singleMemberRatio: withAtoms === 0 ? null : singleMember / withAtoms,
      atomTopicRatio: withAtoms === 0 ? null : atoms / withAtoms,
      withoutTopic,
    },
    graph: {
      state: empty ? 'no-data' : 'ready',
      status: graphStatus,
      inferredEdges,
      byKind,
      detail: graphDetail,
    },
    entries: {
      state: empty ? 'no-data' : 'ready',
      total: entryTotal,
      perAtom: atoms === 0 ? null : entryTotal / atoms,
      declared,
      extracted,
      learned,
      learnedRatio: entryTotal === 0 ? null : learned / entryTotal,
    },
    duplicates: {
      state: duplicateState,
      total: duplicateTotal,
      limit,
      offset,
      rows: duplicateRows.map((r) => ({
        aId: Number(r.a_id),
        bId: Number(r.b_id),
        cos: Number(r.cos),
        lexical: Number(r.lexical),
        aTopicId: Number(r.a_topic),
        bTopicId: Number(r.b_topic),
        aSummary: String(r.a_summary),
        bSummary: String(r.b_summary),
      })),
      rebuiltAt,
      atomsAfterRebuild,
      detail: duplicateDetail,
    },
    orphans: {
      state: empty ? 'no-data' : orphanTotal === 0 ? 'no-findings' : 'has-findings',
      total: orphanTotal,
      limit,
      offset,
      rows: orphanRows.map((r) => ({
        id: Number(r.id),
        summary: String(r.summary),
        topicId: Number(r.topic_id),
      })),
      definition: ORPHAN_DEFINITION,
      detail: empty
        ? '没有数据：库里没有任何 atom。'
        : orphanTotal === 0
          ? '已检查：没有同时满足「无边」与「单成员 topic」的 atom。'
          : '发现 ' + orphanTotal + ' 条孤立 atom（定义见 definition）。',
    },
    recall: {
      atoms,
      neverRecalled: count(db, 'SELECT COUNT(*) AS n FROM atom WHERE recall_hits = 0'),
      neverRecalledRatio:
        atoms === 0 ? null : count(db, 'SELECT COUNT(*) AS n FROM atom WHERE recall_hits = 0') / atoms,
    },
  }
}

/** 读一个数字形态的 meta 值；不存在或不是有限数时返回 null。 */
function metaNumber(db: DatabaseSync, key: string): number | null {
  const raw = getMeta(db, key)
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

// 阈值登记表：把散落在各模块里的**经验取值**集中登记成可核对的条目。
//
// 为什么需要它：M2 的决策审核发现三处阈值（入口泛词 df/N>0.5、单字虚词表、档位阈值
// 0.55/0.45）各自踩了同一个坑 —— 阈值取自某个库的分布，却用在另一个库上，而代码里
// 没有任何地方记着它是在什么语料上标定的。缺的不是某次修正，而是「阈值必须带标定依据」
// 这条流程约束。本模块是那条约束的载体。
//
// **三层边界：每一层只有一个真相源**
//
// 1. **模块默认值 —— 代码里的常量**。分发时自带的那一套值，定义在被引用的模块里
//    （write.ts、view.ts …；锚点表在 calib 包里，插件只转发）。本表只登记它在哪、
//    什么会改变它、还有没有第二个取值点，
//    不复制数字。`scripts/print-thresholds.mjs` 用 TypeScript 编译器 API 遍历
//    `src/**/*.ts` 的模块级变量声明：初始化式能静态求值成数字的，必须在表里或在豁免
//    清单里 —— 表达式型也扫（`12 * 3600 * 1000` 不再隐身）。
// 2. **运行时覆盖值 —— calib 快照的 params**。重标成功后，`lattice-calib` 把一整套参数写进
//    库内 meta 快照（params / sBaseline / calibVersion / at / encoderModel）；启动时读入，
//    版本与编码模型相符才生效。没有可用快照时用第 1 层。生效值只以快照为准，不写回代码
//    （读入与失效见 `src/state.ts` 的 readCalibration）。
// 3. **标定依据 —— calib 报告**。一个数为什么取这个值，唯一依据是产生这组值的重标报告
//    （`lattice-calib` 的发布，或开发笔记里的重标报告）。本表只放指针，不放语料规模与
//    来源分布 —— 那些属于报告。指针只允许三种形状：`无记录`（默认）/
//    `calib@<semver>` / `calib@<semver> <报告名>`；指不到真实报告的写「无记录」，
//    不编版本号。
//
// 三层之间不互相抄写：默认值不在本表复制，快照不写回代码，报告内容不抄进登记表。
// 这条边界与 `docs/ARCHITECTURE.md` 第十节「运行时可变状态」是同一套说法。
//
// **本册只记三件**：定义位置、可变条件、第二个取值点。配置类阈值既有模块默认值
// （write.ts 的 DEFAULT_THRESHOLDS），又有 zod schema 的默认与范围（index.ts 的 Config）；
// 两处已经分叉过（tauJoin 与 tauLex 都和设计文档对不上），所以 `design` 与 `zod`
// 是行的一部分，不是附注。
//
// **值的真相源留在原处**：这里不写数字，只写 `() => CONST` —— 打印时现取。把值搬进来
// 会让「为什么是这个值」的注释与值分家，那正是本次要治的病；用函数而不是直接引用，
// 是为了让值始终是**活的**：模块默认值改了，表里跟着变，不会留下第二份数字。
//
// **漏登记必须能自动检出**：扫描器只看模块级声明，能在初始化式里求值的算术都会收进来；
// 凡是不在本表、也不在豁免清单里的，一律以非零码退出。「记得加一行」不是机制。
// 注册项若把默认值换成 `params.xxx` 这类运行时对象引用，扫描器仍会扫到它并报错 ——
// 默认值不能被藏进第 2 层。
//
// **本模块不改变任何行为**：只被打印脚本与覆盖检查读取，插件运行时不 import 它。
//
// **otherSites 记的是「还有第二个取值点」**：2026-10-19 把配置层的 `?? <字面量>` 兜底
// 改为引用同一常量（`DEFAULT_THRESHOLDS` / `DEFAULT_BUDGET` / `DEFAULT_TOP_N`），
// 原先记在 otherSites 里的六条随之删除 —— 删掉的是「重复」这个事实，而那六处确实曾经重复过。

import {
  ENTRY_WEIGHT,
  DF_FILTER_RATIO,
  IDF_PRIOR,
  DEFAULT_MAX_EXTRACTED,
  DF_FILTER_CONFIDENCE_Z,
  DF_FILTER_HALF_WIDTH,
  MIN_VOCAB_FOR_DF,
  MIN_TERM,
  MAX_TERM,
  MAX_HAN_TERM,
  FRAGMENT_PENALTY,
  MILLIS_PER_DAY,
  LEARNED_FEATURE_TERMS,
  LEARNED_COOLDOWN_HOURS,
  LEARNED_HALF_LIFE_DAYS,
  LEARNED_FORGET_COUNT_EFF,
  LEARNED_MAX_PER_ATOM,
  LEARNED_GLOBAL_FACTOR,
  LEARNED_PROMOTE_COUNT,
  LEARNED_PROMOTE_RECENT_DAYS,
  LEARNED_PROMOTE_MAX_WEIGHT,
} from './pipeline/entries.js'
import { LIST_MAX_LIMIT, LIST_DEFAULT_LIMIT } from './pipeline/list.js'
import { FORGOTTEN_MIN_BIGRAMS, FORGOTTEN_SCAN_LIMIT } from './pipeline/forget.js'
import {
  AFFILIATION,
  CHANNEL_WEIGHT,
  DEFAULT_SEED_COUNT,
  DUP_COS,
  DUP_LEX,
  K_GRAPH,
  K_LEX,
  K_VEC,
  MAX_QUERY_TERMS,
  RECALL_TOP_N,
  RRF_K,
} from './pipeline/search.js'
import {
  ANCHOR_SUMMARY_CHARS,
  DEFAULT_ANCHOR_MAX,
  DEFAULT_BUDGET,
  DEFAULT_ENTRIES_PER_TOPIC,
  DEFAULT_ENTRY_LINE_MAX,
  DEFAULT_PATH_LINES,
  DEMOTED_ANCHOR_CHARS,
  MIN_ANCHORS,
  PATH_SUMMARY_CHARS,
  SEGMENT_RATIO,
  SPLIT_SCENE_CHARS,
  TIER_BRIEF_MIN,
  TIER_FULL_MIN,
  TRIM_ORDER,
  TRIM_PATHS_LIMIT,
} from './pipeline/view.js'
import { TIER_SCALE_ANCHORS, TIER_SCALE_MIN_ATOMS, TIER_SCALE_STABLE_ATOMS } from './pipeline/calibrate.js'
import { FLAG_AMBIGUOUS, FLAG_ARCHIVED, FLAG_SPLIT_PENDING, FLAG_UNCLASSIFIED } from './db/flags.js'
import { SPLIT_CONFIRMED_MAX, SPLIT_SEGMENTS_MAX } from './pipeline/split.js'
import { RECLUSTER_PLAN_DELAY_MS } from './cluster/executor.js'
import {
  BUSY_TIMEOUT_FLOOR_MS,
  BUSY_TIMEOUT_MULTIPLIER,
  CACHE_CEIL_BYTES,
  CACHE_FLOOR_BYTES,
  CACHE_RATIO,
  MMAP_FLOOR_BYTES,
  MMAP_GROWTH,
  MMAP_LIMIT_BYTES,
  MMAP_MEMORY_DIVISOR,
  WRITE_COST_MEASURED_MS,
} from './util/memory.js'
import {
  RECALIBRATE_COOLDOWN_MS,
  RECALIBRATE_DRIFT,
  RECALIBRATE_MIN_ATOMS,
  RECALIBRATE_MIN_POSITIVE,
  RECALIBRATE_OBVIOUS_LIMIT,
  RECALIBRATE_SAMPLE_LIMIT,
} from './calibration/trigger.js'
import {
  DECLARED_EDGE_CONFIDENCE,
  DECLARED_EDGE_TYPE_MAX,
  DEFAULT_THRESHOLDS,
  DEFAULT_TOP_N,
  DELTA_PEAK,
  FINGERPRINT_CHARS,
  FINGERPRINT_MEMBERS,
  NEAR_EDGE_CONFIDENCE,
  SEARCH_BODY_MAX_CHARS,
  TERM_CHARS,
  TOPIC_LABEL_CHARS,
  WORD_ONLY_TOP_N_FACTOR,
} from './pipeline/write.js'
import { MAX_ATOM_CHARS, MIN_ATOM_CHARS } from './migrate/split.js'
import { SUMMARY_CHARS } from './util/text.js'
import {
  REVIEW_MAX_CHARS,
  REVIEW_MAX_SEGMENTS,
  REVIEW_MEMBER_SCAN_MS,
  REVIEW_MIN_CHARS,
  REVIEW_SCAN_BUDGET_MS,
  REVIEW_SCAN_LIMIT,
  REVIEW_SEGMENT_MS,
  REVIEW_WRITE_BUDGET_MS,
} from './pipeline/review.js'
import { VEC_DIM } from './util/vec.js'
import { DEFAULT_ALIGN_COS } from './cluster/align.js'
import { DEFAULT_KNN_K } from './cluster/graph.js'
import { DEFAULT_MIN_CLUSTER_SIZE } from './cluster/hierarchy.js'
import { MST_BRIDGE_FACTOR } from './cluster/mst.js'
import { RECLUSTER_BATCH_ATOMS } from './cluster/rebuild.js'
import { GRAPH_INFER_MAX_ATOMS, NEAR_COS_MIN, NEAR_K, OUT_DEGREE_CAP } from './graph/infer.js'
import { LOG_FLUSH_WINDOW_MS, LOG_QUEUE_MAX, LOG_WRITE_FAILED_MIN_INTERVAL_MS } from './log/index.js'
import { LOG_EXPORT_MAX_BYTES, LOG_EXPORT_MAX_ROWS } from './log/export.js'
import { LOG_FILE_MAX_BYTES, LOG_KEEP_FILES, LOG_TOTAL_MAX_BYTES } from './log/store.js'
import { SAMPLE_QUEUE_MAX } from './samples/index.js'
import {
  SAMPLE_MAX_ROWS,
  SAMPLE_NEG_OBVIOUS_MAX,
  SAMPLE_OBVIOUS_MAX_TOP1,
  SAMPLE_RETAIN_DAYS,
  SAMPLE_UNCERTAIN_MAX_TOP1,
} from './samples/store.js'

/** 阈值影响管线里的哪一段。用于按段检索，不参与判定。 */
export type ThresholdArea =
  | '写入'
  | '落位'
  | '入口'
  | '召回融合'
  | '重排去重'
  | '注入'
  | '目录'
  | '迁移切分'
  | '资源'
  | '显式删除'
  | '重聚类'
  | '图扩展'
  | '降级日志'
  | '校准样本'

/** 登记项的取值：数字、字符串，或对象型阈值组的子键映射。 */
export type ThresholdValue = number | string | Readonly<Record<string, number>>

/**
 * 标定依据：这个值为什么取这个值，指向哪份重标报告。
 *
 * `source` 只允许三种形状：`无记录` / `calib@<semver>` / `calib@<semver> <报告名>`；
 * 省略等价于 `无记录`。`<semver>` 是 `lattice-calib` 包的版本；报告名可以指向开发笔记里的
 * 重标报告 —— **不要求本仓库内可解析**（报告可能含语料信息，不随仓库分发）。
 * `evidence` 只写「为什么取这个值」，不写语料规模与来源分布 —— 那些属于报告。
 */
export interface ThresholdCalibration {
  /** 标定依据指向哪里；省略 = 无记录。 */
  source?: string
  /** 为什么取这个值（解释；不记语料规模与来源分布）。 */
  evidence: string
}

/** 设计文档的对应项。 */
export interface DesignSite {
  /** 设计文档标识。本仓库 docs/ 不含设计正文（不进公开仓库），故指向开发笔记的章节名。 */
  doc: string
  /** 设计文档里的键名；与代码常量名不同名时两处都写。 */
  key: string
  default: number
  /** 文档里的范围；未给范围时省略。 */
  min?: number
  max?: number
  /** 单位不同（例如比例为百分数）时的换算倍数，用于一致性比较。 */
  scale?: number
  /**
   * 设计文档把一组键写成一行（`wVec/wEntry/wBody/wGraph`）时，各子键在代码里的对应名字。
   * 数组下标与 `key` 里用 `/` 分开的那一段一一对应。
   */
  codeKeys?: readonly string[]
}

/** zod schema 里的默认值与取值范围。 */
export interface ZodSite {
  file: string
  name: string
  default: number
  min: number
  max: number
}

/** 一条登记项。 */
export interface ThresholdEntry {
  /** 与源码里的常量名一致（内联量写形如 `X（内联）`，见 inline）。 */
  name: string
  area: ThresholdArea
  /** 值仍在原处：打印时现取，不改行为。 */
  value: () => ThresholdValue
  /** 定义处（文件 + 常量名）；行号由打印脚本自己定位，不手工维护。 */
  definedBy?: { file: string; name: string }
  /**
   * 真值在**外部包**里（T46 拆包后的锚点表就是这种）。
   *
   * 与 definedBy 二选一：写 external 的条目不再参与「源码里找同名常量」的核对 ——
   * 插件里只剩 re-export，找的是那一行的转发，不是定义。路径对外是包名，不写本机路径。
   */
  external?: { pkg: string; file: string }
  /** 受该阈值影响的行为。 */
  affects: string
  /** 标定依据；省略等价于「无记录」。 */
  calibration?: ThresholdCalibration
  /** 什么变了它就该重标。 */
  variesWith: readonly string[]
  /**
   * 内联数值字面量：没有独立常量名，值就地写在表达式里。
   * `source` 是用于定位行号的原样片段（在文件里必须唯一）。
   * 这类条目的 `value` 是**镜像**，仅供打印，不是真相源 —— 真相源是那一行。
   */
  inline?: { file: string; source: string }
  /** 对象型阈值组：每个子键各算一行。 */
  group?: readonly string[]
  /** 设计文档的对应项（能在文档里找到名字的才有）。 */
  design?: DesignSite
  /** zod schema 里的默认值与范围。 */
  zod?: ZodSite
  /** 该名字在别处还有取值点（例如 index.ts 的 `??` 兜底），改动时必须同步。 */
  otherSites?: readonly string[]
  /** 已知的与设计文档的分叉，写明现状以便审核。 */
  diverges?: string
  /** 覆盖检查用的常量名：默认取 definedBy.name；内联量与设计类条目写 null。 */
  constName?: string | null
  /** 打印时展示的值；值不是数字（例如 Set、复合推导值）时用它替代。 */
  display?: string
  /** 设计文档有、代码里已实现但键名不同的项：实现位置。 */
  codeSites?: readonly string[]
}

/**
 * 设计文档 §7 里**有名字、代码里没有对应项**的配置。
 *
 * 与阈值登记表分开：它们没有当前值可登记。列在这里是为了让「文档有、代码无」这个缺口
 * 可见，而不是靠读文档的人自己发现。方向相反的缺口（代码有、文档无）由登记项里
 * `design` 字段的缺席表示。
 */
export interface DesignGap {
  /** 设计文档里的键名。 */
  key: string
  /** 设计文档给的默认值（非数值时记 0 并在 note 里说明原值）。 */
  designDefault: number
  /** 代码里对应什么、或为什么没有。 */
  note: string
  /** 代码里其实实现了、只是键名不同时的实现位置。 */
  codeSites?: readonly string[]
}

/** 设计文档在开发笔记里的位置（本仓库 docs/ 只放工程文档，设计正文不进公开仓库）。 */
const DESIGN_DOC = '开发笔记 设计/技术文档/7.配置项清单.md'

/** T17 的 learned 反哺参数出自设计报告 §27，不是配置项清单，单独指一处。 */
const DESIGN_DOC_T17 = '开发笔记 设计/设计报告/27.Entry三级权重与learned反哺.md'

/** T18 的出度上限出自 §33 与 §40 两条，不在配置项清单里，单独指一处。 */
const DESIGN_DOC_T18_FAIL = '开发笔记 设计/设计报告/33.失败模式与降级.md'

/** 全部登记项。按模块分块，与源码顺序一致，便于对照审查。 */
export const THRESHOLDS: readonly ThresholdEntry[] = [
  // ────────────────────────────── 落位（write.ts）──────────────────────────────
  {
    name: 'DEFAULT_THRESHOLDS.tauJoin',
    area: '落位',
    value: () => DEFAULT_THRESHOLDS.tauJoin,
    definedBy: { file: 'src/pipeline/write.ts', name: 'DEFAULT_THRESHOLDS' },
    affects: 'decidePlacement：与最近 topic 的余弦达到此值、且词面那一票也过，才允许并入',
    calibration: {
      evidence:
        'write.ts:111-131 注释与 scripts/probe-threshold.mjs（可复跑）：真实模型、8 组 x 3 条同义改写；' +
        '同主题余弦 min 0.811 / p50 0.897 / max 0.956，跨主题 0.375 / 0.509 / 0.633，两类完全分离。' +
        '取贴近下界的保守线 0.78（误并是静默的知识损坏，漏并只是多一个主题）。**未记录标定来源**',
    },
    variesWith: ['换编码模型', '标定语料的领域混合度', '误并与漏并的代价评估'],
    constName: null,
    design: { doc: DESIGN_DOC, key: 'tauJoin', default: 0.75, min: 0.6, max: 0.95 },
    zod: { file: 'src/index.ts', name: 'tauJoin', default: 0.78, min: 0.6, max: 0.95 },
    diverges: '设计文档默认 0.75，代码与 zod 都是 0.78（标定后上调，文档未同步）',
  },
  {
    name: 'DEFAULT_THRESHOLDS.tauLex',
    area: '落位',
    value: () => DEFAULT_THRESHOLDS.tauLex,
    definedBy: { file: 'src/pipeline/write.ts', name: 'DEFAULT_THRESHOLDS' },
    affects: 'decidePlacement：并入所需的词面重叠（bigram-Jaccard，第二票）',
    calibration: {
      evidence:
        'write.ts:111-131 注释与 scripts/probe-threshold.mjs：同主题原文 bigram-Jaccard min 0.059 / p50 0.229 /' +
        ' max 0.471，跨主题 max 0.061；取贴住噪声上界的 0.05。**未记录标定来源**',
    },
    variesWith: ['语料语言或书写粒度', '原子化切分的长度', '词面判据换粒度时'],
    constName: null,
    design: { doc: DESIGN_DOC, key: 'tauLex', default: 0.12, min: 0.05, max: 0.5 },
    zod: { file: 'src/index.ts', name: 'tauLex', default: 0.05, min: 0.02, max: 0.5 },
    diverges: '设计文档默认 0.12（其下界恰为 0.05），代码取的正是那个下界；zod 下界 0.02 比文档更宽',
  },
  {
    name: 'DEFAULT_THRESHOLDS.tauNew',
    area: '落位',
    value: () => DEFAULT_THRESHOLDS.tauNew,
    definedBy: { file: 'src/pipeline/write.ts', name: 'DEFAULT_THRESHOLDS' },
    affects: 'decidePlacement：低于此余弦直接新建 topic（落未归类域）',
    calibration: {
      evidence:
        'write.ts:111-131 注释与《设计报告》落位判定表：跨主题余弦 max 0.633，取 0.5 作为「全新」的下界。' +
        '**未记录标定来源**',
    },
    variesWith: ['换编码模型', '标定语料的领域混合度'],
    constName: null,
    design: { doc: DESIGN_DOC, key: 'tauNew', default: 0.5, min: 0.2, max: 0.8 },
    zod: { file: 'src/index.ts', name: 'tauNew', default: 0.5, min: 0.2, max: 0.8 },
  },
  {
    name: 'DEFAULT_THRESHOLDS.tauLexOnly',
    area: '落位',
    value: () => DEFAULT_THRESHOLDS.tauLexOnly,
    definedBy: { file: 'src/pipeline/write.ts', name: 'DEFAULT_THRESHOLDS' },
    affects: 'decidePlacement：无向量（编码器降级）时并入所需的词面重叠，比两票模式高',
    calibration: {
      evidence:
        'write.ts:130 注释（同主题词面 p50 之上、噪声 max 之上）与 devnotes M1《按「跨机器是否一致」分类》' +
        'A 类表（0.78 / 0.05 / 0.10 / 0.50，注明「已实测标定」）。**未记录标定来源**',
    },
    variesWith: ['词面判据本身的变化（tauLex）', '编码器可用率与其降级路径'],
    constName: null,
    zod: { file: 'src/index.ts', name: 'tauLexOnly', default: 0.1, min: 0.02, max: 0.6 },
    diverges: '**设计文档 §7 没有这个键** —— 代码新增（降级路径），文档未同步',
  },
  {
    name: 'DELTA_PEAK',
    area: '落位',
    value: () => DELTA_PEAK,
    definedBy: { file: 'src/pipeline/write.ts', name: 'DELTA_PEAK' },
    affects: 'decidePlacement：sim1 - sim2 小于此差值时判为「双峰」，退回新建（ambiguous）',
    calibration: {
      evidence:
        '《设计报告》落位判定表（sim1 - sim2 < 0.06 且 sim1 >= tauNew 则双峰拒绝）；设计文档 §7 里它有名字' +
        '（deltaPeak，默认 0.06、范围 0.01-0.20）。**未记录标定来源**',
    },
    variesWith: ['换编码模型（余弦尺度的间距会变）', '同域不同子话题的密度'],
    design: { doc: DESIGN_DOC, key: 'deltaPeak', default: 0.06, min: 0.01, max: 0.2 },
    diverges:
      '**仍不进 zod schema**：运行时不可配置。T45 批一只把它从内联字面量提成具名常量' +
      '（取值未变）——「文档有名字、代码里是魔法数」这一半已消除，可配置性是另一件事',
  },
  // ─────────────────────── 落位的候选规模与指纹（write.ts）─────────────────────
  {
    name: 'LEX_CANDIDATES',
    area: '落位',
    value: () => 8,
    definedBy: { file: 'src/pipeline/write.ts', name: 'LEX_CANDIDATES' },
    affects: 'decidePlacement：有向量时，只给余弦最靠前的这么多候选 topic 算词面那一票',
    calibration: {
      evidence:
        'write.ts:284-286 注释：词面是「昂贵的第二票」（每 topic 一次索引查询）——理由是成本不是分布；' +
        '**无实测标定记录**',
    },
    variesWith: ['候选 topic 数与索引查询成本', '库规模（候选变多时该近似会失真）'],
  },
  {
    name: 'WORD_ONLY_CANDIDATES',
    area: '落位',
    value: () => 64,
    definedBy: { file: 'src/pipeline/write.ts', name: 'WORD_ONLY_CANDIDATES' },
    affects: '无向量时先取多少个 topic 参与词面预筛（没有余弦可用，只能靠它缩小候选）',
    calibration: { evidence: 'write.ts:137-141 注释只说「先取多少个」；**无实测标定记录**' },
    variesWith: ['库内 topic 总数', 'topic 表按 rebuilt_at 倒序取候选这一近似的偏差'],
    diverges: '**没有进 zod schema**：降级路径的候选上限运行时不可配置',
  },
  {
    name: 'WORD_ONLY_TOP_N_FACTOR',
    area: '落位',
    value: () => WORD_ONLY_TOP_N_FACTOR,
    definedBy: { file: 'src/pipeline/write.ts', name: 'WORD_ONLY_TOP_N_FACTOR' },
    affects: '无向量时，词面预筛保留的候选数是 topN 的多少倍',
    calibration: {
      evidence:
        '**无记录**。原来是内联的 `* 2`，本次为可登记而提升为常量（取值未变）；' +
        '注释只说「词面筛掉一批之后还要留够 decidePlacement 的输入」',
    },
    variesWith: ['词面预筛的淘汰率', 'topN 改动时'],
  },
  {
    name: 'DEFAULT_TOP_N',
    area: '落位',
    value: () => DEFAULT_TOP_N,
    definedBy: { file: 'src/pipeline/write.ts', name: 'DEFAULT_TOP_N' },
    affects: 'loadCandidates 的默认候选上限（写入侧的 topic 候选数）',
    calibration: {
      evidence:
        '**无记录**。它与召回条数（search.ts 的 RECALL_TOP_N）及配置项 topN 同为 24，但那是' +
        '「召回交注入层多少条」，这是「落位时取多少个 topic 候选」。T45 批一判定为' +
        '**恰好同值、不同义**，不合并 —— 合并会让「调注入条数」顺带改掉落位候选数',
    },
    variesWith: ['库内 topic 总数', '落位准确率对候选规模的敏感度'],
    otherSites: [
      'src/tools/index.ts recall(..., { topN: cfg.topN }) —— 召回条数走的是配置（zod 的 topN），不是这里的 24',
    ],
    diverges:
      '**设计文档 §7 的 topN 指召回条数**（对应 search.ts 的 RECALL_TOP_N），不是这里的落位候选数 ——' +
      '本常量在文档里没有对应键。两件事同为 24 纯属巧合，改配置不会改这里',
  },
  {
    name: 'FINGERPRINT_CHARS',
    area: '落位',
    value: () => FINGERPRINT_CHARS,
    definedBy: { file: 'src/pipeline/write.ts', name: 'FINGERPRINT_CHARS' },
    affects: '每个成员贡献给 topic 词面指纹的正文字符数（指纹用于估重叠度）',
    calibration: {
      evidence:
        'devnotes M1《按「跨机器是否一致」分类》B 类表：400，「中文摘要 + 背景段的典型长度」，跨机器一致、' +
        '跨语料要重标。**未记录标定来源**',
    },
    variesWith: ['语料的段落长度分布', '语言（换成英文/日文语料）'],
  },
  {
    name: 'FINGERPRINT_MEMBERS',
    area: '落位',
    value: () => FINGERPRINT_MEMBERS,
    definedBy: { file: 'src/pipeline/write.ts', name: 'FINGERPRINT_MEMBERS' },
    affects: '单个 topic 最多取多少个成员的指纹（取前 N 个，保证结果确定）',
    calibration: { evidence: 'write.ts:181-182 注释只说「最多取多少个成员的指纹」；**无实测标定记录**' },
    variesWith: ['单个 topic 的成员数分布（大 topic 多时指纹代表性下降）'],
  },
  {
    name: 'TERM_CHARS',
    area: '注入',
    value: () => TERM_CHARS,
    definedBy: { file: 'src/pipeline/write.ts', name: 'TERM_CHARS' },
    affects:
      '注入行按「词」折算时的字符宽度：主题标签 4 词、单条降级摘要 15 词、摘录档锚摘要 16 词、' +
      '路段摘要 20 词，都乘本值得到字符数',
    calibration: {
      evidence:
        '**折算单位，不是阈值**：4 取「一个词最多四个汉字」的口径（与 entries.ts 的 MAX_HAN_TERM 同源，' +
        '但不复用那个常量）。T45 批三把四个截断长度从各自写死的 16/60/64/80 改成「词数 × 本值」，' +
        '取值未变；四个词数本身是显示判断，没有标定记录',
    },
    variesWith: ['注入层一行给几个词（各段角色不同）'],
  },
  {
    name: 'TOPIC_LABEL_CHARS',
    area: '落位',
    value: () => TOPIC_LABEL_CHARS,
    definedBy: { file: 'src/pipeline/write.ts', name: 'TOPIC_LABEL_CHARS' },
    affects:
      '主题标签的宽度：新建 topic 时取摘要的前这么多字符，注入层入口行也按同一宽度裁' +
      '（write.ts 的 slice 与 view.ts 的 clip 是同一个量）',
    calibration: {
      evidence:
        '**无记录**。两处此前各自写死 16（写入侧 slice(0, 16)、显示侧 clip(t.label, 16)）——' +
        'T45 批一判定为**同义**并合并为一个常量：存进去的宽度与显示的宽度必须是同一个量，' +
        '否则改一处就会出现「标签存 16、显示裁 20」这类分叉。' +
        'T45 批三起由 TERM_CHARS × 4 个词派生，取值仍是 16',
    },
    variesWith: ['主题标签在注入层显示多宽', '摘要长度分布'],
    otherSites: ['src/pipeline/view.ts 入口行 `clip(t.label, TOPIC_LABEL_CHARS)`（同源，不再是第二份数字）'],
  },
  {
    name: 'NEAR_EDGE_CONFIDENCE',
    area: '落位',
    value: () => NEAR_EDGE_CONFIDENCE,
    definedBy: { file: 'src/pipeline/write.ts', name: 'NEAR_EDGE_CONFIDENCE' },
    affects: '写 near 边时的默认 confidence（有真实 sim 时用 sim 顶替）',
    calibration: { evidence: '**无记录**。是「没有证据时给中位」的占位值，不是标定结果' },
    variesWith: ['图路排序对 confidence 的依赖方式'],
  },
  {
    name: 'SUMMARY_CHARS',
    area: '写入',
    value: () => SUMMARY_CHARS,
    definedBy: { file: 'src/util/text.ts', name: 'SUMMARY_CHARS' },
    affects: '写入时抽取摘要的字符上限（摘要进 atom.summary，参与注入与去重）',
    calibration: {
      evidence:
        'text.ts:80-85 注释：取第一句、超长截断、按码点计数以免劈开代理对；48 本身**无实测标定记录**。' +
        '此前默认值住在函数签名里（max = 48），两个调用点（write.ts 与 forget.ts）又各写了一遍 48；' +
        'T45 批一判定为**同义**并合并成一个常量（三处同源）',
    },
    variesWith: ['一句话讲一件事这条写入约定的实际长度分布', '语言'],
    otherSites: [
      'src/pipeline/write.ts `extractSummary(text, SUMMARY_CHARS)`（同源）',
      'src/pipeline/forget.ts 墓碑摘要 `extractSummary(..., SUMMARY_CHARS)`（同源）',
    ],
  },
  {
    name: 'SEARCH_BODY_MAX_CHARS',
    area: '写入',
    value: () => SEARCH_BODY_MAX_CHARS,
    definedBy: { file: 'src/pipeline/write.ts', name: 'SEARCH_BODY_MAX_CHARS' },
    affects: 'buildSearchBody 里进 trigram 索引的正文字符上限（超出即截断）',
    calibration: {
      evidence:
        'write.ts:330-341 注释只说明「摘要重复一次」的理由；1600 **无实测标定记录**。' +
        '同一个函数里此前写了两遍（判断与切片），T45 批一合并为一个常量',
    },
    variesWith: ['atom 正文长度分布', '长正文的细节召回是否重要'],
  },
  // ────────────────────────────── 入口（entries.ts）──────────────────────────────
  {
    name: 'DF_FILTER_RATIO',
    area: '入口',
    value: () => DF_FILTER_RATIO,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'DF_FILTER_RATIO' },
    affects: '泛词过滤：df/N 超过此比例的词元直接丢弃（不参与入口竞争）',
    calibration: {
      evidence:
        'entries.ts:181-196 注释（泛词是相对于语料定义的）与 M2 审核 T11：**在基准库上' +
        'df/N > 0.5 根本够不到，净贡献为 0** —— 即这条判据从未在目标语料上被实测触发过。' +
        '「0.5」的出处是「过半数即无区分度」这句直觉，不是某次测量',
    },
    variesWith: ['库内 atom 数与来源分布', '语言（英文词表大，问题不明显）'],
    diverges:
      '**本任务要治的原始病例**：判据取自直觉、在运行语料上不触发、且没有任何地方记着它的标定来源。' +
      '治理（改相对判据）属后续执行点，本次只登记不改值',
  },
  {
    name: 'IDF_PRIOR',
    area: '入口',
    value: () => IDF_PRIOR,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'IDF_PRIOR' },
    affects: '入口打分的 IDF 平滑项：log((N - df + IDF_PRIOR) / (df + IDF_PRIOR) + 1)',
    calibration: {
      evidence:
        '**无记录**。取 0.5 是 IDF 平滑（Robertson-Sparck Jones 形式）的常规写法，属算法惯例而非实测。' +
        '同一个公式里它出现两次（分子与分母），此前是两处各写一个 0.5',
    },
    variesWith: ['仅在换用别的 IDF 变体时'],
  },
  {
    name: 'EXTRACT_WEIGHT_CEIL',
    area: '入口',
    value: () => ENTRY_WEIGHT.extracted,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'ENTRY_WEIGHT' },
    constName: null,
    affects: '抽取入口的权重归一后上界（declared 恒为 1.0，抽取不得越过它）',
    calibration: {
      evidence:
        'entries.ts:315 注释：抽取入口永远不越过 declared 的 1.0。**代码里从来没有第二个 0.6**：' +
        '归一结果直接乘 ENTRY_WEIGHT.extracted（learned 的升档上限同样引用了它）。' +
        'T45 批一核对后判定为**同源**，登记项改为指向那个字段而不是镜像一个数字',
    },
    variesWith: ['ENTRY_WEIGHT.extracted 改动时'],
  },
  {
    name: 'IDF_FREQUENCY_FACTOR（内联）',
    area: '入口',
    value: () => 'log2(1 + tf)',
    display: 'IDF × log2(1+tf)（tf=1 时该因子恰为 1，条目退化成 v3 的纯 IDF）',
    definedBy: { file: 'src/pipeline/entries.ts', name: '内联（无常量名）' },
    affects: '抽取入口的打分：IDF（区分度）乘上词频项（证据强度），决定十六个槽位归谁',
    inline: {
      file: 'src/pipeline/entries.ts',
      source: 'Math.log((N - df + IDF_PRIOR) / (df + IDF_PRIOR) + 1) * Math.log2(1 + tf)',
    },
    calibration: {
      evidence:
        '2026-10-17 实现报告：删掉单字虚词表后，纯 Entry 路 gold 召回在只改门时为 50%、' +
        '只改打分时为 70%、两者都不改（v3 字表 + 纯 IDF）为 65%。取 log2(1+tf) 而非 tf 本身，' +
        '是为了让重复次数的边际收益递减——**形式是判断，幅度未做扫描**。' +
        '端到端（真实模型、20 条 gold）另有取舍，见同一份报告',
    },
    variesWith: ['语料规模（短正文里 tf 的分布）', '每 atom 的入口配额', '上游切词规则'],
  },
  {
    name: 'BOUNDARY_FREEDOM（判据线，非数值常量）',
    area: '入口',
    value: () => '是否「边界自由度为零」，无阈值数字',
    display: '边界自由度为零即出局（判据线在零，没有可调数字）',
    definedBy: { file: 'src/pipeline/entries.ts', name: 'hasBoundaryFreedom' },
    constName: null,
    inline: { file: 'src/pipeline/entries.ts', source: 'function hasBoundaryFreedom(' },
    affects: '二字组与三字以上整段汉字的候选资格：左右邻汉字都只观测到一种取值、且两侧都有过重复观测，即出局',
    calibration: {
      evidence:
        '2026-10-17 实现报告：**判据线是「零」本身，不是扫描出来的**。基准库上本判据' +
        '丢弃纯汉字二字型的一部分候选；被它放回来的高频真词（记忆 57 / 实测 50 / 判据 38 / ' +
        '目录 30 / 合并 30 / 验证 22…）正是 v3 单字虚词表的成片误杀。' +
        '**光换这一层不够**：只删字表不改打分，纯 Entry 路 gold 召回 65% -> 50%；' +
        '配套改打分（见 IDF_FREQUENCY_FACTOR）后为 70%。' +
        '**端到端贡献在 20 条 gold 上不可分辨**：去掉本判据重跑，20 条查询的名次一模一样。' +
        '判为「不可分辨」而不是「零贡献」，理由只在样本量 —— 同一次端到端测量里 @12 的 5% 之差' +
        '（1 条）同样被判为不可判定；用同一个样本对前者谨慎、对后者干脆是双标。' +
        '保留它的依据：实测无误杀（反向差集 216 条全是碎片），且删掉它会让字表留下的两个调用点' +
        '完全失守（候选池变松是一个独立的设计决定，需单独论证）。**待扩库后复测**。' +
        'T45 批三把「证据」从计数改成形态：不再记两侧观测次数再与 2 比较，而是记「有没有第二次' +
        '观测」—— 在本判据生效的路径上两者逐条等价（探针见实现报告）',
    },
    variesWith: ['语料规模（邻居观测的多少）', '上游切词规则', '语料语言'],
    diverges:
      '**已知不等价**：几何量放回了一批 v3 会挡的高频泛词（不是 / 一个 / 什么 / 需要 / 用户 / ' +
      '内容 / 问题…）——它们两侧都多样，几何量分不开。「这个词是不是词」与「这个词有没有主题' +
      '信息」是两个量，本判据只管前者',
  },
  {
    name: 'MIN_VOCAB_FOR_DF',
    area: '入口',
    value: () => MIN_VOCAB_FOR_DF,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'MIN_VOCAB_FOR_DF' },
    affects: '语料规模达到此值，泛词过滤（df/N > 0.5）才生效',
    display: '12（= 使 p=0.5 处 Wilson 95% 半宽 ≤ 0.25 的最小 n）',
    calibration: {
      evidence:
        'D11-9：低于该规模「出现在半数 atom 里」不携带信息（库内 2 条时出现一次就是半数）。' +
        'T45 批三起由区间半宽派生：DF_FILTER_HALF_WIDTH(0.25) 与 DF_FILTER_CONFIDENCE_Z(1.96) 下，' +
        '满足半宽要求的最小 n 是 12（n=11 约 0.254、n=12 约 0.246），与旧值逐位相同。' +
        '**不是显著性判据**：改用「Wilson 下限 > 0.5」会改变每词的触发点（n=12 时 df≥10 才触发，' +
        '旧判据是 df≥7），那是改行为；本次不改。旧口径「在 12 atom 这个规模上定的」由 ' +
        'test/write.test.mjs 守着小库边界',
    },
    variesWith: ['每 atom 的入口配额（配额越小，泛词线越早需要生效）', '语料语言', '上游切词规则'],
  },
  {
    name: 'DF_FILTER_CONFIDENCE_Z',
    area: '入口',
    value: () => DF_FILTER_CONFIDENCE_Z,
    display: '1.96（95% 双侧）',
    definedBy: { file: 'src/pipeline/entries.ts', name: 'DF_FILTER_CONFIDENCE_Z' },
    affects: '推导 MIN_VOCAB_FOR_DF 时的置信水平；不参与运行时的过滤判定',
    calibration: {
      evidence: '**统计惯例，不是标定值**：95% 双侧正态分位。只用于把「规模线」换算成可复算的数',
    },
    variesWith: ['对规模线置信水平的要求'],
  },
  {
    name: 'DF_FILTER_HALF_WIDTH',
    area: '入口',
    value: () => DF_FILTER_HALF_WIDTH,
    display: '0.25（四分之一个比例单位）',
    definedBy: { file: 'src/pipeline/entries.ts', name: 'DF_FILTER_HALF_WIDTH' },
    affects: '推导 MIN_VOCAB_FOR_DF 时的精度要求；不参与运行时的过滤判定',
    calibration: {
      evidence:
        '**精度要求，不是语料标定**：df/N 的估计误差超过四分之一时，「大约一半」与「大约四分之一」分不开。' +
        '取值是判断；它决定规模线落在 12（取 0.20 会落在 21、取 0.30 会落在 8）',
    },
    variesWith: ['对 df/N 估计精度的要求'],
  },
  {
    name: 'MIN_TERM',
    area: '入口',
    value: () => MIN_TERM,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'MIN_TERM' },
    affects: '入口词元的长度下界（按码点）；低于它不参选',
    calibration: {
      evidence:
        'devnotes M1《按「跨机器是否一致」分类》B 类表把 2 / 8 归为「汉语词长分布」，' +
        '**但没有一次实测**。取值来自设计判断：二字词是中文检索的主力',
    },
    variesWith: ['上游切词规则（改成词级切分后长度含义会变）', '换成英文/日文语料'],
  },
  {
    name: 'MAX_TERM',
    area: '入口',
    value: () => MAX_TERM,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'MAX_TERM' },
    affects: '入口词元的长度上界（按码点）；超过它不参选',
    calibration: { evidence: '同 MIN_TERM：B 类表标注为「汉语词长分布」，**无实测记录**' },
    variesWith: ['上游切词规则', '语料语言', '正文的书写粒度'],
  },
  {
    name: 'MAX_HAN_TERM',
    area: '入口',
    value: () => MAX_HAN_TERM,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'MAX_HAN_TERM' },
    affects: '整段连续汉字作为入口时的长度上限（超过四字即出局）；三字以上另需通过边界自由度判据（v4 起）',
    calibration: {
      evidence:
        'D11-6：切词把连续汉字整段当词，于是正文任意片段都成候选（「全程没有建分支」「为什么会这样」），' +
        '它们不会被任何查询命中却占着每 atom 只有十几个的槽位。理由是「真词里超过四字的极少」——' +
        '**定性判断，未做词长统计**',
    },
    variesWith: ['语料语言', '正文的书写粒度（一句话讲一件事的实际长度）'],
  },
  {
    name: 'FRAGMENT_PENALTY',
    area: '入口',
    value: () => FRAGMENT_PENALTY,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'FRAGMENT_PENALTY' },
    affects:
      '边界自由度缺一侧的候选（疑似跨词边界碎片）得分乘以该系数；降权而非剔除（v4 起两侧都恒定的已直接出局）',
    calibration: {
      evidence:
        'D11-4 与 entries.ts:111-121 注释：**人工标注的 60 个样本**上，「两侧邻居都多于一种」把真词与' +
        '碎片分开到 96.7%（AUC 0.973）；但判为碎片的那组里仍约三成是真词，故只降权。系数取到' +
        '「让碎片落到有真词可选的槽位之外，又不至于在候选不足时把槽位空出来」——**幅度是判断，不是扫描出来的**',
    },
    variesWith: ['边界自由度判据本身的变化', '语料里真词与碎片的比例'],
    diverges:
      'M2 审核实测：单靠该降权**不足以把二字碎片挤出展示窗口**（审核报告「二字汉字碎片」一节）。' +
      'v4 因此把它上面的那档（两侧都恒定）改成硬判出局，本条只管「只剩一侧、或观测不足」的候选',
  },
  {
    name: 'ENTRY_WEIGHT',
    area: '入口',
    value: () => ENTRY_WEIGHT,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'ENTRY_WEIGHT' },
    affects: '入口权重的三级：declared 全值 / extracted 归一后按比例 / learned 由召回反哺',
    group: ['declared', 'extracted', 'learned'],
    calibration: {
      evidence:
        'entries.ts:31-36 注释「基础权重——级别越高越可信」，**无实测记录**。' +
        'devnotes M1《按「跨机器是否一致」分类》A 类把它归为「设计决策，与语料无关」',
    },
    variesWith: ['入口来源分级本身变化时（例如新增一级）'],
    diverges:
      '**设计文档 §7 没有这组键**（文档的四路权重是召回的 wVec/wEntry/wBody/wGraph，与本组不是一回事）；' +
      '代码里 learned 一级写入侧不产生，仅由召回反哺',
  },
  {
    name: 'DEFAULT_MAX_EXTRACTED',
    area: '入口',
    value: () => DEFAULT_MAX_EXTRACTED,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'DEFAULT_MAX_EXTRACTED' },
    affects: '每个 atom 抽取的入口数上限（declared 入口不参与这个竞争）',
    calibration: {
      evidence:
        'D11-1 与 entries.ts:38-49 注释：原设计取 8。中文无词边界，25 字能切约 17 个 bigram，' +
        '实测「大文件下载要走代理，但回环地址不能走代理」两次出现的「代理」都被挤出前 8，只剩「走代」，' +
        '查「代理」一无所获；放宽到 16 后同一批查询全部命中。' +
        '**2026-10-17 全库扫描（六点 + 四个补点，配对 bootstrap 4000 次）推翻了「该继续放宽」的推理**：' +
        '8 与 12 的纯 Entry 路 gold 召回比 16 低 25 个百分点、95% 区间不含 0（显著）；16 → 32 只多 10 个百分点、' +
        '区间含 0（不显著）—— **16 是收益曲线的拐点**。端到端在 8~32 全区间不动。' +
        '三种「按长度 / 按候选池」的预算化形态全部不优于固定 16（最好的打平，最差的 EPA 9.69、纯 Entry 召回掉到 55%）。' +
        '所以：**从候选数推「槽位不够」是不成立的** —— 多出来的候选本来就排不进窗口；方向（倾向多给）只在 8→16 这一段成立。' +
        '**复核 D11-1 自己那两条论据**：例文实际 **20 个码点**（注释写 25 字）、切出 17 个 bigram（这一条对上）；' +
        '但「两次出现的『代理』都被挤出前 8」在 v4 下**不成立** —— 实测 max=8 时「代理」就是**第 1 名**，' +
        '那条观察属于 v3（单字虚词表 + 退化打分）时期，v4 换掉打分后它的前提已经消失；' +
        '「真实记忆通常 40~180 字」也对不上本库（实测平均 **250 码点**、中位 210，>180 字的占 **59.5%**）。' +
        '**结论方向仍成立，但依据要换成实测密度**：原始 bigram/码点 = 0.358、过滤后候选池/码点 = 0.284。' +
        '另一条原理性结论：**入口上限不可能是「覆盖」** —— 要把目标卡正文里出现的查询词全收进入口，' +
        '需要上限 ≥ 27~278（中位 130），16 只够 1/20、64 只够 3/20；它只能是**质量闸门**',
    },
    variesWith: ['中文 bigram 的候选密度（切词规则）', '正文长度分布', '语料语言'],
  },
  // ────────────────────── learned 反哺（entries.ts，T17）──────────────────────
  //
  // 这一组全部来自设计报告 §27「防抖六条」，**没有一条在本库上标定过** —— 每条的 evidence
  // 都如实这么写。本机也没有可比的对照：反哺的效果要几十次真实召回才显现，那需要一段
  // 真实使用期，不是一次探针能造出来的。
  {
    name: 'LEARNED_FEATURE_TERMS',
    area: '入口',
    value: () => LEARNED_FEATURE_TERMS,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_FEATURE_TERMS' },
    affects: '一次召回反哺几个查询特征词（取 query 的 TF-IDF 前三，与写入侧同一套抽取规则）',
    calibration: {
      evidence: '**设计文档给的值，未在本库标定**：§27 反哺三步第 1 条「取 query 的 TF-IDF top-3 特征词」',
    },
    variesWith: ['查询长度分布', '一次召回命中多少条 atom（乘数效应）', '冷启动阶段库还小、IDF 不稳'],
    design: { doc: DESIGN_DOC_T17, key: '反哺三步 · 第 1 条', default: 3 },
  },
  {
    name: 'MILLIS_PER_DAY',
    area: '入口',
    value: () => MILLIS_PER_DAY,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'MILLIS_PER_DAY' },
    affects: 'learned 的冷却与半衰期换算（本模块里唯一一处「天」到毫秒的换算）',
    calibration: {
      evidence:
        '**单位换算，不是经验阈值**。登记它是因为门禁要求每个模块级数值常量都有登记行；它与语料无关，不需要标定',
    },
    variesWith: ['不随时间或语料变化'],
  },
  {
    name: 'LEARNED_COOLDOWN_HOURS',
    area: '入口',
    value: () => LEARNED_COOLDOWN_HOURS,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_COOLDOWN_HOURS' },
    affects: '冷却：同一（查询词, atom）在这个窗口内只记 1 次，重复查询不构成重复证据',
    calibration: { evidence: '**设计文档给的值，未在本库标定**：§27 防抖第 1 条「24 h 内只记 1 次」' },
    variesWith: ['一次会话里重复同一问法的频率', '召回频次（低频库里冷却几乎不触发）'],
    design: { doc: DESIGN_DOC_T17, key: '防抖第 1 条（单位与代码一致，都是小时）', default: 24 },
  },
  {
    name: 'LEARNED_HALF_LIFE_DAYS',
    area: '入口',
    value: () => LEARNED_HALF_LIFE_DAYS,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_HALF_LIFE_DAYS' },
    affects: '遗忘与淘汰共用的证据强度 count_eff 的半衰期',
    calibration: { evidence: '**设计文档给的值，未在本库标定**：§27 防抖第 2 条「90 天半衰期」' },
    variesWith: ['记忆的实际复用周期', '召回频次'],
    design: { doc: DESIGN_DOC_T17, key: '防抖第 2 条', default: 90 },
  },
  {
    name: 'LEARNED_FORGET_COUNT_EFF',
    area: '入口',
    value: () => LEARNED_FORGET_COUNT_EFF,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_FORGET_COUNT_EFF' },
    affects: '遗忘线：count_eff 低于它的 learned 行删除',
    calibration: {
      evidence:
        '**与设计文档的 1.5 分叉，两者都没有在本库标定。** 文档的公式是 count += exp(-Δt_days/90)，' +
        '即 count 是实数累加；而 entry.hits 是 INTEGER NOT NULL，没有第二列能存小数累加值。' +
        '整数事件数下 count_eff = hits × 2^(-Δ/90) ≤ hits，1.5 这条线会把 hits=1 的行在写下的' +
        '那一刻就删掉（1 < 1.5）—— 反哺等于没做。改记 0.5 的含义是「残留证据不足半个事件」：' +
        'hits=1 静默 90 天后消失、hits=2 静默 180 天后消失。**0.5 同样没有实测依据**，' +
        '它是「整数计数下这条线唯一说得通的位置」，不是标定结果',
    },
    variesWith: ['hits 的存储口径（若将来改成小数累加，这条线要按文档回到 1.5）', '召回频次'],
    design: { doc: DESIGN_DOC_T17, key: '防抖第 2 条（文档取 1.5，代码取 0.5，见 diverges）', default: 1.5 },
    diverges:
      '**文档 1.5 ｜ 代码 0.5**，理由见 evidence：文档的 count 是实数累加，hits 是整数列。' +
      '这不是调参分歧，是存储口径不一致导致同一个数字无法照抄',
  },
  {
    name: 'LEARNED_MAX_PER_ATOM',
    area: '入口',
    value: () => LEARNED_MAX_PER_ATOM,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_MAX_PER_ATOM' },
    affects: '单 atom 的 learned 入口上限，超出按 count_eff 淘汰最低的',
    calibration: { evidence: '**设计文档给的值，未在本库标定**：§27 防抖第 3 条「learned 入口 ≤ 12 条」' },
    variesWith: [
      'extracted 入口上限（DEFAULT_MAX_EXTRACTED=16）—— 两者是同一批槽位的两半',
      '真实召回里「查询词不属于该 atom 已有入口」的比例（T17 探针实测这个比例很高，上限很少触发）',
    ],
    design: { doc: DESIGN_DOC_T17, key: '防抖第 3 条', default: 12 },
  },
  {
    name: 'LEARNED_GLOBAL_FACTOR',
    area: '入口',
    value: () => LEARNED_GLOBAL_FACTOR,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_GLOBAL_FACTOR' },
    affects: '全局 learned 上限 = 此系数 × 库里的 atom 数，超出按 count_eff 淘汰最低的',
    calibration: {
      evidence: '**设计文档给的值，未在本库标定**：§27 防抖第 4 条「learned 总数 ≤ 5 × n_atoms」',
    },
    variesWith: ['库的 atom 数（这个上限随库增长，因此不是固定额度）'],
    design: { doc: DESIGN_DOC_T17, key: '防抖第 4 条', default: 5 },
  },
  {
    name: 'LEARNED_PROMOTE_COUNT',
    area: '入口',
    value: () => LEARNED_PROMOTE_COUNT,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_PROMOTE_COUNT' },
    affects: '升档线：count_eff 到线且最近有命中时，learned 行的分值升到 extracted 档（0.6）',
    calibration: { evidence: '**设计文档给的值，未在本库标定**：§27 反哺三步第 3 条「count ≥ 5」' },
    variesWith: [
      '冷却窗口（24 h）与整数计数：hits ≥ 5 意味着至少 5 个跨 24 h 的事件，即约 5~7 天的使用',
      '召回频次；低频库里升档几乎不会发生',
    ],
    design: { doc: DESIGN_DOC_T17, key: '反哺三步 · 第 3 条（文档的 count 也是实数累加）', default: 5 },
  },
  {
    name: 'LEARNED_PROMOTE_RECENT_DAYS',
    area: '入口',
    value: () => LEARNED_PROMOTE_RECENT_DAYS,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_PROMOTE_RECENT_DAYS' },
    affects: '升档与**降档**的时间窗：最近一次命中超出这个窗口就不再够格，已升档的降回 0.3',
    calibration: {
      evidence:
        '**设计文档给的值，未在本库标定**：§27 第 3 条「30 天内出现 ≥ 2 次」。' +
        '代码只有 (hits, last_seen) 两列，只能守住「最近一次命中在 30 天内」这半边：' +
        '「30 天内出现 2 次」要事件级时间戳，表里没有第二列可存。另半边由冷却间接兜住 —— ' +
        'hits ≥ 5 意味着至少 5 个跨 24 h 的事件',
    },
    variesWith: ['召回频次', '若将来给 entry 加一列「首次命中时间」，就能按文档实现完整的 30 天窗口'],
    design: { doc: DESIGN_DOC_T17, key: '反哺三步 · 第 3 条的「30 天内」', default: 30 },
    diverges:
      '**只实现了「最近一次命中在 30 天内」，没有实现「30 天内出现 ≥ 2 次」**：后者要事件级时间戳，' +
      '表里只有 hits 与 last_seen。这是收窄，不是放宽',
  },
  {
    name: 'LEARNED_PROMOTE_MAX_WEIGHT',
    area: '入口',
    value: () => LEARNED_PROMOTE_MAX_WEIGHT,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_PROMOTE_MAX_WEIGHT' },
    affects: '升档能升到的分值上限 —— 取 ENTRY_WEIGHT.extracted，永不等于 declared 的 1.0',
    calibration: {
      evidence:
        '**设计文档给的值，未在本库标定**：§27 第 3 条把「→ extracted」标为 0.6。' +
        '代码把这条晋升表达成 **weight 的上限**而不是 **origin 的改写**（见 diverges），' +
        '取值跟着 ENTRY_WEIGHT.extracted 走，不另写一份 0.6',
    },
    variesWith: ['ENTRY_WEIGHT.extracted（同一个数的两个出口，改一个必须看另一个）'],
    design: { doc: DESIGN_DOC_T17, key: '反哺三步 · 第 3 条（→ extracted，0.6）', default: 0.6 },
    diverges:
      '**文档改 origin（learned → extracted → declared），代码只改 weight，origin 恒为 learned。**' +
      '三条理由：① weight 只被注入层的入口展示读（view.ts 的 topicEntries 按 MAX(weight) 排序），' +
      '不参与召回打分（entryPath 用 FTS bm25），改 origin 换不到任何召回收益；' +
      '② schema 那句 declared/learned 是真相源、extracted 可重算，靠 origin 区分能不能重算，' +
      '把 learned 改写成 extracted 会让它在下次重算抽取时静默消失；' +
      '③ 「用得多的词自动获得发言权」这件事上，升到 declared(1.0) 尤其不能做 —— ' +
      '它把「这个词被查得多」写成了「写入方声明过这个词」。代码里没有 → declared 这一级',
  },
  // ──────────────────────────── 召回融合（search.ts）────────────────────────────
  {
    name: 'CHANNEL_WEIGHT',
    area: '召回融合',
    value: () => CHANNEL_WEIGHT,
    definedBy: { file: 'src/pipeline/search.ts', name: 'CHANNEL_WEIGHT' },
    affects: 'RRF 融合时四路的权重（w / (RRF_K + rank)）',
    group: ['vec', 'entry', 'body', 'graph'],
    calibration: {
      evidence:
        'search.ts:20-26 注释：Entry 高于正文，理由是「入口冗余」原理；' +
        'devnotes M1《按「跨机器是否一致」分类》A 类：设计决策，与语料无关。**无实测记录**',
    },
    variesWith: ['各路的精度对比测量（例如图路边多为无类型几何边）'],
    design: {
      doc: DESIGN_DOC,
      key: 'wVec/wEntry/wBody/wGraph',
      default: 1.0,
      codeKeys: ['vec', 'entry', 'body', 'graph'],
    },
    diverges:
      '**同一组键的名字对不上**：设计文档叫 wVec/wEntry/wBody/wGraph，代码叫 vec/entry/body/graph' +
      '（CHANNEL_WEIGHT）。四路权重只有 vec 与设计默认同名同值，其余三项的对应关系要靠语义猜',
  },
  {
    name: 'RRF_K',
    area: '召回融合',
    value: () => RRF_K,
    definedBy: { file: 'src/pipeline/search.ts', name: 'RRF_K' },
    affects: 'RRF 融合常数：分越高越压平头部排名的垄断，让多路共识浮现',
    calibration: {
      evidence:
        'search.ts:28 注释「60 是常用取值」，**无实测记录**；' +
        'devnotes M1《按「跨机器是否一致」分类》A 类归为「算法常数」',
    },
    variesWith: ['换成别的融合方式时'],
    design: { doc: DESIGN_DOC, key: 'rrfK', default: 60, min: 10, max: 100 },
    diverges: '**zod schema 里没有它** —— 文档给了 10-100 的范围，运行时不生效、不可调',
  },
  {
    name: 'AFFILIATION',
    area: '召回融合',
    value: () => AFFILIATION,
    definedBy: { file: 'src/pipeline/search.ts', name: 'AFFILIATION' },
    affects: '归属因子：主属命中的得分乘以这些系数（只由图路引入的最低）',
    group: ['primary', 'secondary', 'graphOnly'],
    calibration: {
      evidence:
        'search.ts:31-32 注释「主属 > 仅次属 > 仅由图路引入」，**无实测记录**；' +
        'devnotes M1《按「跨机器是否一致」分类》A 类归为「设计给定的语义层级」',
    },
    variesWith: ['次属与图路引入的精度测量'],
    diverges:
      '**设计文档 §7 没有这组键**。设计报告里出现过 graph 权重 0.5，代码的 graphOnly 是 0.70 ——' +
      '两者不是同一个量，但不熟悉的人容易当成同一个',
  },
  {
    name: 'DEFAULT_SEED_COUNT',
    area: '召回融合',
    value: () => DEFAULT_SEED_COUNT,
    definedBy: { file: 'src/pipeline/search.ts', name: 'DEFAULT_SEED_COUNT' },
    affects: '图路用向量路的前多少条做种子（A.slice(0, DEFAULT_SEED_COUNT)）',
    calibration: { evidence: '**无记录**（源码无注释，开发笔记里也没有这个数）' },
    variesWith: ['图路的边密度与精度', '库规模'],
    diverges: '**设计文档 §7 没有这个键**，zod schema 里也没有',
  },
  {
    name: 'K_VEC',
    area: '召回融合',
    value: () => K_VEC,
    definedBy: { file: 'src/pipeline/search.ts', name: 'K_VEC' },
    affects: '向量路取多少条进融合（向量粗筛的宽度）',
    calibration: {
      evidence:
        '**无记录**。devnotes M1 待办一已把 `LIMIT 24/48/64` 这类「表面是性能上限、实际约束召回质量」' +
        '的候选数点名为**归类错误**：它随库规模变化，不与机器相关。kVec / kLex / kGraph 属于同一类',
    },
    variesWith: ['库规模（库长大时固定取前 N 会让召回质量悄悄退化）'],
    diverges: '**设计文档 §7 没有这个键**，zod schema 里也没有 —— 固定上限改预算制是 T45 批二（与 T40 合并）',
  },
  {
    name: 'K_LEX',
    area: '召回融合',
    value: () => K_LEX,
    definedBy: { file: 'src/pipeline/search.ts', name: 'K_LEX' },
    affects: '词面两路（Entry 与正文）各取多少条进融合',
    calibration: {
      evidence: '**无记录**。与 K_VEC 同一次盘点、同一类（随库规模漂移，不是性能上限）；**无实测**',
    },
    variesWith: ['库规模', '中文 bigram 的候选密度'],
    diverges: '**设计文档 §7 没有这个键**，zod schema 里也没有',
  },
  {
    name: 'K_GRAPH',
    area: '召回融合',
    value: () => K_GRAPH,
    definedBy: { file: 'src/pipeline/search.ts', name: 'K_GRAPH' },
    affects: '图路一跳扩展取多少条进融合（与 OUT_DEGREE_CAP 分工：那条限每个种子的出度，这条限总量）',
    calibration: {
      evidence: '**无记录**。与 K_VEC 同一次盘点、同一类；**无实测**',
    },
    variesWith: ['图路的边密度', '库规模'],
    diverges: '**设计文档 §7 没有这个键**，zod schema 里也没有',
  },
  {
    name: 'RECALL_TOP_N',
    area: '召回融合',
    value: () => RECALL_TOP_N,
    definedBy: { file: 'src/pipeline/search.ts', name: 'RECALL_TOP_N' },
    affects: '召回交给注入层的默认条数（调用方不传 topN 时用它）',
    calibration: {
      evidence:
        '**无记录**。生产路径上实际生效的是配置项 topN（zod 默认 24，见 tools/index.ts），' +
        '这里的 24 只在调用方不传 topN 时起作用',
    },
    variesWith: ['注入字符预算', '一次注入能容纳的摘要条数'],
    design: { doc: DESIGN_DOC, key: 'topN', default: 24, min: 5, max: 50 },
    zod: { file: 'src/index.ts', name: 'topN', default: 24, min: 5, max: 50 },
    diverges:
      '**与 DEFAULT_TOP_N 同为 24、不同量**（T45 批一判定为恰好同值，不合并）：那个是落位时取多少' +
      '个 topic 候选，这个是召回交注入层的条数。设计文档 §7 的 topN 指后者',
  },
  {
    name: 'MAX_QUERY_TERMS',
    area: '召回融合',
    value: () => MAX_QUERY_TERMS,
    definedBy: { file: 'src/pipeline/search.ts', name: 'MAX_QUERY_TERMS' },
    affects: '单路最多用多少个词进 FTS 查询',
    calibration: {
      evidence:
        'search.ts:305 注释「长查询切出的 bigram 会很多，超出部分区分度也低」；' +
        'devnotes M1《按「跨机器是否一致」分类》B 类归为「中文 bigram 的候选密度」但**无实测**，' +
        '同文在「一个归类错误」一节又指出它约束的是**召回质量**、随**库规模**变化',
    },
    variesWith: ['库规模', '查询长度分布', '中文 bigram 的候选密度'],
    diverges: 'M1 已把它列为「按实际候选数取、用 FTS5 查询复杂度上限兜底」的待办项，未做',
  },
  {
    name: 'DUP_COS',
    area: '重排去重',
    value: () => DUP_COS,
    definedBy: { file: 'src/pipeline/search.ts', name: 'DUP_COS' },
    affects: '重复压制：余弦低于此值即不判重复（两票中的几何票）；仅在同主属 topic 桶内两两比较',
    calibration: {
      evidence:
        'search.ts:339-348 注释：原设计依赖 atom_pair 表（cos >= 0.92 且词面 >= 0.5），改为词面兜底后' +
        '沿用 0.92。devnotes M1《按「跨机器是否一致」分类》A 类称其为「重复的几何判据」。' +
        '**没有一次「不同说法的同一件事」实测**（DUP_LEX 才有）',
    },
    variesWith: ['换编码模型（余弦尺度会变）', '同义改写的相似度分布'],
  },
  {
    name: 'DUP_LEX',
    area: '重排去重',
    value: () => DUP_LEX,
    definedBy: { file: 'src/pipeline/search.ts', name: 'DUP_LEX' },
    affects: '重复压制：词面重叠低于此值即不判重复（两票中的词面票）',
    calibration: {
      evidence:
        'search.ts:350-360 注释：原设计 0.5，**实测中文短文本上太松** —— 「系统代理必须走本地端口……」' +
        '与「系统代理配置本地端口……」的 bigram-Jaccard 是 0.64，它们讲同一件事但各有信息，不该折叠。' +
        '取 0.72：只有几乎逐字重复才被压制（同一段文本实测 Jaccard 为 1.0）。' +
        '**标定语料是构造的对照句对**',
    },
    variesWith: ['语料语言与书写粒度', '摘要长度（词面 Jaccard 对短文本更敏感）'],
  },
  // ────────────────────────────── 注入（view.ts）───────────────────────────────
  {
    name: 'SEGMENT_RATIO',
    area: '注入',
    value: () => SEGMENT_RATIO,
    definedBy: { file: 'src/pipeline/view.ts', name: 'SEGMENT_RATIO' },
    affects: '三段字符配额的占比（锚 / 入口 / 路），三段之和为 1',
    group: ['anchors', 'entries', 'paths'],
    calibration: {
      evidence:
        'view.ts:8-10 注释：「不是审美选择：锚决定回答质量，路只提供线索」—— 理由完整，' +
        '**但没有实测记录**（未做过不同配比下的召回质量对比）',
    },
    variesWith: ['锚段平均长度与主题数的变化', '入口段在回答里的实际贡献'],
    design: {
      doc: DESIGN_DOC,
      key: 'ratioAnchor/Entry/Path',
      default: 55,
      scale: 100,
      codeKeys: ['anchors', 'entries', 'paths'],
    },
    diverges:
      '**名字与单位都不同**：文档按百分数（55 / 20 / 25，和=100）且叫 ratioXxx，代码是小数' +
      '（0.55 / 0.2 / 0.25）且键名是 anchors/entries/paths',
  },
  {
    name: 'MIN_ANCHORS',
    area: '注入',
    value: () => MIN_ANCHORS,
    definedBy: { file: 'src/pipeline/view.ts', name: 'MIN_ANCHORS' },
    affects: '锚段保底条数：预算再紧也先给这么多条；同时是摘录档的锚上限',
    calibration: {
      evidence:
        'devnotes M1 待办四《保底锚与降噪冲突》：保底锚与「低相关只给入口段」直接冲突，' +
        '两条路（保留保底 / 低相关一起去掉）都记录在案，最终选了分档方案（D15-3：摘录档锚上限 = MIN_ANCHORS）。' +
        '**3 这个数本身没有实测标定**',
    },
    variesWith: ['无关查询的容忍度（保底越高，降噪越不彻底）', '一次注入的字符预算'],
  },
  {
    name: 'TRIM_ORDER',
    area: '注入',
    value: () => TRIM_ORDER.join(' -> '),
    display: 'paths->5 -> entries->4 -> anchors->summary -> paths->0 -> anchors->3',
    definedBy: { file: 'src/pipeline/view.ts', name: 'TRIM_ORDER' },
    affects: '超预算时的裁剪顺序（路 -> 入口 -> 锚降级 -> 路清零 -> 锚减量）',
    calibration: {
      evidence:
        'view.ts:21-27 注释：这个数组是**行为契约**，测试直接依赖它的顺序而不是某个具体输出。' +
        '顺序的理由是「锚不为其他段让路」——**设计不变量，不是标定结果**',
    },
    variesWith: ['三段分工本身变化时（例如新增一段）'],
    diverges:
      '**设计文档 §7 没有这个键**，zod schema 里也没有。它按字符串而非数值登记：' +
      '列在此处的目的是让「行为契约级常量」不被漏掉',
  },
  {
    name: 'TIER_FULL_MIN',
    area: '注入',
    value: () => TIER_FULL_MIN,
    definedBy: { file: 'src/pipeline/view.ts', name: 'TIER_FULL_MIN' },
    affects: 'tierOf：最高余弦 >= 此值走完整档（三段全给）',
    calibration: {
      evidence:
        'D15-2 与 view.ts:73-82 注释：20 条 gold 查询 + 4 条无关查询；相关 top1 min 0.524 / p50 0.683，' +
        '无关 top1 max 0.398。「两者之间是空的，所以取值本身不敏感；取空隙中间是为了容错，不是为了拟合」',
    },
    variesWith: ['换编码模型（余弦尺度直接变）', '库规模与来源分布', '语料的领域混合度'],
    diverges:
      '**标定语料与运行库不一致**：标定在基准库上，而插件跑在宿主库上（M2 审核指出的同一类问题）。' +
      '本表不再记语料规模与来源分布 —— 是否仍适用，看对应重标报告；没有报告时按「无记录」处理，不猜',
  },
  {
    name: 'TIER_BRIEF_MIN',
    area: '注入',
    value: () => TIER_BRIEF_MIN,
    definedBy: { file: 'src/pipeline/view.ts', name: 'TIER_BRIEF_MIN' },
    affects:
      '库小于锚点表下端时的**默认**精简档下界；库 >= 12 条时生效值由 calib 的锚点表按规模给出，' +
      '本常量不再等于生效值。它同时仍是弱相关提示线 LOW_RELEVANCE_HINT 的取值来源',
    calibration: {
      source: 'calib@0.1.0 阈值重标定（2026-10-17）',
      evidence:
        '两段来历，必须分开读。**① 原标定**（D15-2，20 gold + 4 无关）：0.45 压在无关上界' +
        ' 0.398 与 gold 下界 0.524 之间，test/tools.test.mjs:210-211 以断言守住这两个界。' +
        '**② 重标定（2026-10-17）**：在扩容后的基准库上复算，无关 top1 上界已升到 0.515、' +
        '相关下界 0.525，0.45 落进无关分布内部（提示线静默失效）—— 故它降级为**默认值**，' +
        '生效值改由 calib 的锚点表按库规模给出。复算口径：8 个规模点各 30 次降采样、' +
        '20 gold + 20 无关、池化后扫「相关通过率 − 无关通过率」最大的切点，读数 0.466 / 0.470 / 0.492 /' +
        ' 0.514 / 0.514 / 0.514 / 0.514 / 0.525。' +
        '**2026-10-18 复核**：这条线若被说成「无关误报 ≤ 5%」，**样本量与可认证上限必须一起报** ——' +
        ' 24 条无关查询、观察到 1 次误通过时，conformal risk control 的可认证上限是' +
        ' (f+1)/(n+1) = 2/25 = **8.0%**，不是 5%；要认证 5% 需 n >= 39，或把线抬到 0.5369 以上' +
        '（代价是相关侧 19/20）。Clopper-Pearson 95% 区间为 [0.11%, 21.12%]。详见一期结论 §二',
    },
    variesWith: ['换编码模型', '库规模（生效值随规模变，本常量不再等于生效值）', '语料的领域混合度'],
    diverges:
      '**标定语料与运行库不一致**（同 TIER_FULL_MIN），且真机语料上相关/无关两组重叠。' +
      '重标定已把生效值改成规模的函数（本次），但**弱相关提示线 LOW_RELEVANCE_HINT 仍是这个常数**' +
      '（src/tools/index.ts:59 直接引用它）—— 工具层不在本次改动边界内，两处暂时分叉，见实现报告的未确定项。' +
      '本表不记语料规模与来源分布；是否仍适用看对应重标报告，没有报告时按「无记录」处理',
  },
  {
    name: 'TIER_SCALE_MIN_ATOMS',
    area: '注入',
    value: () => TIER_SCALE_MIN_ATOMS,
    external: { pkg: 'lattice-calib', file: 'src/anchors.ts' },
    affects: 'briefMinFor：库小于此规模时不做按规模标定，退回 TIER_BRIEF_MIN（= 0.45）',
    calibration: {
      source: 'calib@0.1.0 阈值重标定（2026-10-17）',
      evidence:
        '锚点表最下端就是 12 条 —— 它是本次降采样实验的**最小规模点**，不是标定出来的最优规模。' +
        '比它更小的库没有任何测量，按项目约定「查不到就留空」退回旧值，不编一段外推',
    },
    variesWith: ['锚点表下端的规模点变化时'],
  },
  {
    name: 'TIER_SCALE_STABLE_ATOMS',
    area: '注入',
    value: () => TIER_SCALE_STABLE_ATOMS,
    external: { pkg: 'lattice-calib', file: 'src/anchors.ts' },
    affects: '只用于可观测：低于此规模时，按规模插值出的阈值不可信（调用方据此区分标定值与插值值）',
    calibration: {
      source: 'calib@0.1.0 阈值重标定（2026-10-17）',
      evidence:
        '降采样实验结论 2：「档位与提示阈值稳定所需的最小 atom 数」= **192**。' +
        '判据是相关查询 p10 与无关查询 p95 的距离 >= 0.05，且在按 replicate 聚类的 1000 次重抽样里' +
        '至少 80% 满足。**这是本次那个查询集上的结论，不是语料无关的常数**',
    },
    variesWith: ['查询集（20 相关 + 20 无关是人工挑的）', '语料构成'],
  },
  {
    name: 'TIER_SCALE_ANCHORS',
    area: '注入',
    value: () => TIER_SCALE_ANCHORS.map((a) => a.atoms + '→' + a.briefMin).join(' / '),
    external: { pkg: 'lattice-calib', file: 'src/anchors.ts' },
    affects: 'briefMinFor：按库规模给出精简档下界；点与点在 log2(atom 数) 尺度上线性插值，两端夹紧（不外推）',
    calibration: {
      source: 'calib@0.1.0 阈值重标定（2026-10-17）',
      evidence:
        '重标定（2026-10-17）：查询集是 20 条 gold（各带目标记忆）+ 20 条人工无关查询。' +
        '每个规模点 30 次独立降采样，把 30 次的相关样本' +
        '与无关样本各自合成一个池，在池上扫出使「相关通过率 − 无关通过率」最大的切点。' +
        '**表里的每个数都是该点实测到的那个切点，不是拟合值**；点之间的插值是「规模是连续量」的近似。' +
        '**2026-10-18 复核（标定路线一期验证）**：30 次重复的 95% 区间宽在 12 / 24 / 48 / 96 分别是' +
        ' 0.070 / 0.061 / 0.043 / 0.023 —— **与它们到最大规模点的漂移同量级甚至更大**（比值 0.52–1.13），' +
        'k >= 192 才到 2.2–4.5 倍；最大规模点的零宽区间是伪精度（满库无降采样、100 seed 全同）。' +
        '**表内 7 个点在噪声内彼此不可区分**，它实际承载的信息约等于两级台阶（小库 ≈0.47–0.51 /' +
        ' 大库 ≈0.525）。逐点区间见 calib 锚点表的 `ci` 字段与一期结论 §十一',
    },
    variesWith: ['查询集（人工挑的 20 + 20）', '换编码模型', '语料的领域混合度'],
    diverges:
      '**上端是夹紧，不是外推**：比 1374 条更大的库本次没有测量（T23-b 报告未确定项 5 记的同一件事），' +
      '故 > 1374 条时取 0.525 不再上移。下端同理，< 12 条退回默认值 0.45',
  },
  {
    name: 'LOW_RELEVANCE_HINT',
    area: '注入',
    // 取的是 view.ts 的 TIER_BRIEF_MIN —— tools/index.ts 里的 LOW_RELEVANCE_HINT 就是它的别名。
    // **不 import tools/index.ts**：那个模块要宿主的 peerDependencies（@deepseek-ai/*），
    // 而本表是只描述阈值的元数据，不该因此多出一个「必须先装好宿主依赖」的前提
    // （否则新克隆的仓库在 pnpm install 之前跑门禁，这一步会红在与阈值登记无关的理由上）。
    value: () => TIER_BRIEF_MIN,
    definedBy: { file: 'src/tools/index.ts', name: 'LOW_RELEVANCE_HINT' },
    affects: 'isWeakMatch：低于此值在召回结果前标一句「可能不相关」（只提示不拦截）',
    calibration: {
      evidence:
        'D15-4 / D15-5 与 tools/index.ts:39-48 注释：**原值 0.68 实测永不触发**（gold 集 top1 中位数就有' +
        ' 0.683）——「一个永不触发的提示与没有提示是一回事，却看起来还在工作」。改为与摘录档下界同源' +
        '（= TIER_BRIEF_MIN = 0.45），理由是两者回答同一个问题：「这次的匹配算不算相关」。' +
        '标定约束由 test/tools.test.mjs 守住：必须落在 0.398 与 0.524 之间',
    },
    variesWith: ['TIER_BRIEF_MIN 改动时（它是别名，不是独立取值）', '换编码模型'],
    otherSites: ['src/tools/index.ts:48 `= TIER_BRIEF_MIN` —— 不是自己的数，与摘录档同源'],
  },
  {
    name: 'DEFAULT_BUDGET',
    area: '注入',
    value: () => DEFAULT_BUDGET,
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEFAULT_BUDGET' },
    affects: '注入字符预算的默认值（工具调用可覆盖）',
    calibration: {
      evidence: '**无记录**：只有设计文档 §7 给了默认值 6000 与范围 1000-20000，没有标定依据',
    },
    variesWith: ['模型上下文窗口', '一次注入里锚段的平均长度'],
    design: { doc: DESIGN_DOC, key: 'viewBudget', default: 6000, min: 1000, max: 20000 },
    zod: { file: 'src/index.ts', name: 'viewBudget', default: 6000, min: 1000, max: 20000 },
    diverges:
      '**同一个默认值写了三遍**：view.ts 的 DEFAULT_BUDGET、zod 的 .default(6000)、index.ts 的 `?? 6000`。' +
      '三处目前一致',
  },
  {
    name: 'DEFAULT_ANCHOR_MAX',
    area: '注入',
    value: () => DEFAULT_ANCHOR_MAX,
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEFAULT_ANCHOR_MAX' },
    affects: '单条锚的字符上限（全文很长时截断，避免一条吃掉整段）',
    calibration: { evidence: '**无记录**。源码无注释；设计文档 §7 也没有这个键' },
    variesWith: ['atom 正文长度分布', '字符预算'],
    diverges: '**设计文档 §7 没有这个键**，zod schema 里也没有 —— 运行时不可配置',
  },
  {
    name: 'DEFAULT_ENTRIES_PER_TOPIC',
    area: '注入',
    value: () => DEFAULT_ENTRIES_PER_TOPIC,
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEFAULT_ENTRIES_PER_TOPIC' },
    affects: '每个命中主题给几条入口（摘录档由 TIER_ENTRIES 收窄到 4）',
    calibration: {
      evidence: 'T53 改成公式：DEFAULT_MAX_EXTRACTED（16）÷ 2。此前是字面量 8，注释里也没说明这层关系',
    },
    variesWith: ['DEFAULT_MAX_EXTRACTED 改动时（同一件事的两个端点）', '主题数'],
  },
  {
    name: 'DEFAULT_ENTRY_LINE_MAX',
    area: '注入',
    value: () => DEFAULT_ENTRY_LINE_MAX,
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEFAULT_ENTRY_LINE_MAX' },
    affects: '单个主题的入口行字符上限（防止一行过长挤占锚段）',
    calibration: { evidence: '**无记录**。源码无注释，设计文档与 zod 里都没有这个键' },
    variesWith: ['入口词的长度分布', '每主题入口条数'],
    diverges: '**设计文档 §7 没有这个键**，zod schema 里也没有',
  },
  {
    name: 'DEFAULT_PATH_LINES',
    area: '注入',
    value: () => DEFAULT_PATH_LINES,
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEFAULT_PATH_LINES' },
    affects: '路段整体行数上限（裁剪顺序里会先降到 5、再清零）',
    calibration: { evidence: '**无记录**。源码无注释；TRIM_ORDER 里的 5 与它是什么关系也没有写明' },
    variesWith: ['一跳关联的平均条数', '字符预算'],
  },
  {
    name: 'TIER_ANCHOR_CAP',
    area: '注入',
    value: () => ({ full: Number.POSITIVE_INFINITY, brief: 8, excerpt: MIN_ANCHORS }),
    definedBy: { file: 'src/pipeline/view.ts', name: 'TIER_ANCHOR_CAP' },
    affects: '各档的锚条数上限（完整档不设上限，交给预算管）',
    group: ['full', 'brief', 'excerpt'],
    calibration: {
      evidence:
        'D15-3：full 不限（预算机制已经管住总量）/ brief 8 / excerpt = MIN_ANCHORS(3)。' +
        '**brief=8 与 DEFAULT_ENTRIES_PER_TOPIC 同值但没有说明是巧合还是有意**；无实测记录',
    },
    variesWith: ['各档的字符预算', 'MIN_ANCHORS 改动时（摘录档上限跟着走）'],
  },
  {
    name: 'TIER_ENTRIES',
    area: '注入',
    value: () => ({ full: 8, brief: 8, excerpt: 4 }),
    definedBy: { file: 'src/pipeline/view.ts', name: 'TIER_ENTRIES' },
    affects: '各档每个主题给几条入口（只有摘录档收窄）',
    group: ['full', 'brief', 'excerpt'],
    calibration: {
      evidence: 'D15-3：「低相关时入口段是主角，但也要收窄」——**是判断，无实测记录**',
    },
    variesWith: ['入口段在各档里的实际贡献'],
    diverges:
      '**值在代码里是字面量而不是引用常量**（view.ts:103-107 直接写 8 / 8 / 4），' +
      '与 DEFAULT_ENTRIES_PER_TOPIC 形成第二份同一个数',
  },
  {
    name: 'PATH_SUMMARY_CHARS',
    area: '注入',
    value: () => PATH_SUMMARY_CHARS,
    definedBy: { file: 'src/pipeline/view.ts', name: 'PATH_SUMMARY_CHARS' },
    affects: '路段每行摘要的截断长度：20 个词',
    calibration: {
      evidence:
        '**无记录**（词数是显示判断，不是标定结果）。与 ANCHOR_SUMMARY_CHARS（16 词）/ ' +
        'DEMOTED_ANCHOR_CHARS（15 词）是三个**不同角色**的截断（路只提供线索、锚是正文、' +
        '降级锚是兜底）；T45 批一判定为**不同义**，不合并。T45 批三起按 TERM_CHARS 折算，' +
        '取值仍是 80',
    },
    variesWith: ['路段在注入里的角色（纯线索）'],
  },
  {
    name: 'ANCHOR_SUMMARY_CHARS',
    area: '注入',
    value: () => ANCHOR_SUMMARY_CHARS,
    definedBy: { file: 'src/pipeline/view.ts', name: 'ANCHOR_SUMMARY_CHARS' },
    affects: '锚段降级为摘要时的截断长度：16 个词（st.anchorToSummary 分支）',
    calibration: {
      evidence: '**无记录**（词数是显示判断，不是标定结果）。T45 批三起按 TERM_CHARS 折算，取值仍是 64',
    },
    variesWith: ['摘要长度分布（extractSummary 的 48 是它的上游）'],
  },
  {
    name: 'DEMOTED_ANCHOR_CHARS',
    area: '注入',
    value: () => DEMOTED_ANCHOR_CHARS,
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEMOTED_ANCHOR_CHARS' },
    affects: '空间不足时把锚降级为短摘要所截断的长度：15 个词（与 16 词那条是两条不同分支）',
    calibration: {
      evidence:
        '**无记录**（词数是显示判断，不是标定结果）。与同一段的 16 词只差 1 个词；' +
        '两者值不同，合并即改变注入文本，T45 批一不做（属「恰好近似」，不是同源）。' +
        'T45 批三起按 TERM_CHARS 折算，取值仍是 60',
    },
    variesWith: ['同上；这个值更像历史遗留'],
  },
  // ENTRY_LABEL_CHARS 已并入 TOPIC_LABEL_CHARS（同一个量：主题标签的宽度），
  // 见「落位」一节的 TOPIC_LABEL_CHARS 行。
  {
    name: 'TRIM_PATHS_LIMIT',
    area: '注入',
    value: () => TRIM_PATHS_LIMIT,
    definedBy: { file: 'src/pipeline/view.ts', name: 'TRIM_PATHS_LIMIT' },
    affects: '裁剪第一步把路段行数上限压到的值（TRIM_ORDER 的 paths->5）',
    calibration: {
      evidence:
        '**无记录**。TRIM_ORDER 的名字里带着 5，但 5 从哪来没有出处。' +
        '与 DEFAULT_PATH_LINES(15) 不是同一个量（那是初始上限，这是超预算后先降到多少），' +
        'T45 批一判定为**不同义**，不合并',
    },
    variesWith: ['TRIM_ORDER 改动时（名字与值必须同步）'],
  },
  // ────────────────────────────── 目录（list.ts）───────────────────────────────
  {
    name: 'LIST_MAX_LIMIT',
    area: '目录',
    value: () => LIST_MAX_LIMIT,
    definedBy: { file: 'src/pipeline/list.ts', name: 'LIST_MAX_LIMIT' },
    affects: '一页最多给多少条；请求值被强制钳制到 [1, 50]',
    calibration: {
      evidence:
        'D13-1：「上限不是默认值而是硬边界，防止调用方一次拉空整个库」。' +
        '**50 本身无实测记录** —— 它约束的是注意力稀释，不是某个分布',
    },
    variesWith: ['一次注入能容纳的摘要条数', '库规模'],
    diverges: '**设计文档 §7 没有这个键**，zod schema 里也没有（工具侧有测试守着钳制行为）',
  },
  {
    name: 'LIST_DEFAULT_LIMIT',
    area: '目录',
    value: () => LIST_DEFAULT_LIMIT,
    definedBy: { file: 'src/pipeline/list.ts', name: 'LIST_DEFAULT_LIMIT' },
    affects: '默认页大小',
    calibration: {
      evidence: 'list.ts:15 注释「取值偏小：列目录是为了定位，不是为了读完」——**理由，非标定**',
    },
    variesWith: ['同上'],
    diverges: '**设计文档 §7 没有这个键**',
  },
  // ────────────────────── 迁移切分（migrate/split.ts）─────────────────────────
  {
    name: 'MIN_ATOM_CHARS',
    area: '迁移切分',
    value: () => MIN_ATOM_CHARS,
    definedBy: { file: 'src/migrate/split.ts', name: 'MIN_ATOM_CHARS' },
    affects: '切分时一条 atom 的最小字符数（低于它不再切）',
    calibration: {
      evidence:
        '**无记录**。源码无注释；只影响一次性迁移脚本（本机卡片导入），不参与运行时管线 ——' +
        '登记它是为了覆盖完整性，不代表它需要标定',
    },
    variesWith: ['「一句话讲一件事」这条写入约定的实际长度'],
    diverges: '**设计文档 §7 没有这个键**（文档的 autoSplit 是一期关闭的配置项）',
  },
  {
    name: 'MAX_ATOM_CHARS',
    area: '迁移切分',
    value: () => MAX_ATOM_CHARS,
    definedBy: { file: 'src/migrate/split.ts', name: 'MAX_ATOM_CHARS' },
    affects: '切分时一条 atom 的最大字符数（超过即按句子再切）',
    calibration: { evidence: '**无记录**（同 MIN_ATOM_CHARS）' },
    variesWith: ['同上'],
  },
  // ───────────────── 写入侧审核（pipeline/review.ts，M3-T22）─────────────────
  {
    name: 'REVIEW_MIN_CHARS',
    area: '写入',
    value: () => REVIEW_MIN_CHARS,
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_MIN_CHARS' },
    affects: '写入侧审核「自动处理·过短」：正文短于它的写入被拦下、不落库',
    calibration: {
      evidence:
        '**不是标定值，是一次分布核对**。基准库（1374 atom）正文字符数分布里，低于 20 字的只有 2 条' +
        '（0.15%），且两条都是 `---` 这种不可能被召回的空壳；第 3 短的一条（29 字）已经是一句完整结论。' +
        '真机库 2026-10-17 现取 14 条、最短 81 字，**样本量不足以定下界**。所以这条线的依据是' +
        '「在基准库上只抓空壳」+「一句合法中文结论的下界约 15 字」，**不是运行语料上的标定**。' +
        '刻意**不复用 MIN_ATOM_CHARS（80）**：那是迁移切卡片小节的界，搬到写入侧会拦掉合法的短参数记忆' +
        '（「本机代理端口是 7890。」只有十几个字）—— 那正是本表开头要治的「阈值取自一个场景、用在另一个场景」',
    },
    variesWith: ['「一句话讲一件事」这条写入约定的实际长度分布', '语言', '正文里是否允许单句参数'],
    diverges: '**设计文档 §7 没有这个键**；`lattice_write` 的入参契约里也没有这条下限',
  },
  {
    name: 'REVIEW_MAX_CHARS',
    area: '写入',
    value: () => REVIEW_MAX_CHARS,
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_MAX_CHARS' },
    affects: '写入侧审核「自动处理·过长」：正文长于它的写入按句自动切分后分别写入',
    calibration: {
      evidence:
        '**与 migrate/split.ts 的 MAX_ATOM_CHARS 是同一个数、同一个界**（review.ts 直接引用，不复制值）：' +
        '两条路径上一条 atom 受同一组约束 —— FTS 索引体积 + 落位会被平均掉。该界本身**无标定记录**，' +
        '见 MAX_ATOM_CHARS 那一行',
    },
    variesWith: ['同 MAX_ATOM_CHARS（atom 正文长度分布、FTS 索引体积、落位质量）'],
    constName: null,
    otherSites: ['src/migrate/split.ts 的 MAX_ATOM_CHARS 是它的真相源'],
    diverges: '**设计文档 §7 没有这个键**',
  },
  {
    name: 'REVIEW_MAX_SEGMENTS',
    area: '写入',
    value: () => REVIEW_MAX_SEGMENTS,
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_MAX_SEGMENTS' },
    affects: '一次写入最多自动切成多少条；超过则整条不写入，交回调用方自己拆',
    display: '8（= 写入预算 1000 ms ÷ 单段实测 125 ms）',
    calibration: {
      evidence:
        '**结构性上界**，T45 批三起由「时间预算 ÷ 单段实测耗时」派生：REVIEW_WRITE_BUDGET_MS(1000) / ' +
        'REVIEW_SEGMENT_MS(125) = 8。单段实测值见 REVIEW_SEGMENT_MS 条目（2026-10-18，1374 atom 库副本，' +
        '111–148 ms）。旧口径的「一条记忆里不该装着 8 件以上的事」与时间预算给出同一个整数，两条同时成立',
    },
    variesWith: ['单段写入耗时（编码器与词表重建）', '一次工具调用的时延预算'],
    diverges: '**设计文档 §7 没有这个键**',
  },
  {
    name: 'REVIEW_SCAN_LIMIT',
    area: '写入',
    value: () => REVIEW_SCAN_LIMIT,
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_SCAN_LIMIT' },
    affects: '重复 / 高相似检测一次最多比多少个同主题成员（**只读，不写库**）',
    display: '200（= 扫描预算 10 ms ÷ 单条实测 0.05 ms）',
    calibration: {
      evidence:
        '**结构性上界**，T45 批三起由「扫描预算 ÷ 单条实测耗时」派生：REVIEW_SCAN_BUDGET_MS(10) / ' +
        'REVIEW_MEMBER_SCAN_MS(0.05) = 200。单条实测见 REVIEW_MEMBER_SCAN_MS 条目（2026-10-18，' +
        '0.038–0.045 ms/条）。旧口径的「200 条足以覆盖同一主题下的近期成员」与时间预算给出同一个整数',
    },
    variesWith: ['单个主题的成员数分布', 'atom 正文的平均长度'],
    diverges: '**设计文档 §7 没有这个键**',
  },
  {
    name: 'REVIEW_WRITE_BUDGET_MS',
    area: '写入',
    value: () => REVIEW_WRITE_BUDGET_MS,
    display: '1000 ms',
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_WRITE_BUDGET_MS' },
    affects: '一次写入（切分 + 逐段落库）的时间预算；只用来换算切分段数上限',
    calibration: {
      evidence: '**产品侧时延预算，不是语料标定**：一次工具调用最多花 1 秒。没有实测出处，取值是判断',
    },
    variesWith: ['宿主对一次工具调用的时延预期'],
  },
  {
    name: 'REVIEW_SEGMENT_MS',
    area: '写入',
    value: () => REVIEW_SEGMENT_MS,
    display: '125 ms（本机实测的单段写入耗时）',
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_SEGMENT_MS' },
    affects: '把写入预算换算成段数：1000 / 125 = 8',
    calibration: {
      evidence:
        '**实测**：2026-10-18 在 1374 条 atom 的库副本上，8 次单段写入 111–148 ms（每段含一次编码与' +
        '一次全量词表重建，后者约 113 ms）。取 125 ms。换机器/库规模会变，届时上限自动跟着变',
    },
    variesWith: ['编码器速度', '词表重建耗时（库规模）'],
  },
  {
    name: 'REVIEW_SCAN_BUDGET_MS',
    area: '写入',
    value: () => REVIEW_SCAN_BUDGET_MS,
    display: '10 ms',
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_SCAN_BUDGET_MS' },
    affects: '重复检测的时间预算；只用来换算一次比对多少条成员',
    calibration: {
      evidence: '**产品侧时延预算，不是语料标定**：重复检测加在每次写入上，只给它 10 ms',
    },
    variesWith: ['宿主对一次工具调用的时延预期'],
  },
  {
    name: 'REVIEW_MEMBER_SCAN_MS',
    area: '写入',
    value: () => REVIEW_MEMBER_SCAN_MS,
    display: '0.05 ms（本机实测的单条比对耗时，向上取整）',
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_MEMBER_SCAN_MS' },
    affects: '把扫描预算换算成条数：10 / 0.05 = 200',
    calibration: {
      evidence:
        '**实测**：2026-10-18 在基准库最大主题（37 个成员）上 findDuplicate 单次 1.663 ms，均摊 0.045 ms/条；' +
        '纯比对循环（bigram-Jaccard + 512 维余弦）0.038 ms/条。取 0.05（向上取整，宁可少扫）',
    },
    variesWith: ['成员正文长度', '向量维度'],
  },
  // ──────────────────────── 资源参数（util/memory.ts）─────────────────────────
  {
    name: 'MMAP_LIMIT_BYTES',
    area: '资源',
    value: () => MMAP_LIMIT_BYTES,
    display: '256 MB（上限，与「内存的八分之一」取更小者）',
    definedBy: { file: 'src/util/memory.ts', name: 'MMAP_LIMIT_BYTES' },
    affects: 'mmap 窗口上限',
    calibration: {
      evidence:
        'devnotes M1《按「跨机器是否一致」分类》C 类（真正与机器相关）：256 MB 的 mmap 在 8 GB 机器上' +
        '无所谓、在 2 GB 机器上就是白占。**是本机推导规则的上限，不是标定值**',
    },
    variesWith: ['机器内存', '库文件大小'],
    diverges: '**已从常量改成推导值**（M1 待办一第 2、3 项），但仍是一个写死的上限',
  },
  {
    name: 'MMAP_FLOOR_BYTES',
    area: '资源',
    value: () => MMAP_FLOOR_BYTES,
    display: '64 MB（下限）',
    definedBy: { file: 'src/util/memory.ts', name: 'MMAP_FLOOR_BYTES' },
    affects: 'mmap 窗口下限（库很小时也至少给这么多）',
    calibration: { evidence: '**无记录**。与上限同处，1.5x / 1/8 / 64 MB 三个数都没有出处' },
    variesWith: ['机器内存'],
  },
  {
    name: 'CACHE_RATIO',
    area: '资源',
    value: () => CACHE_RATIO,
    display: '内存的 5%',
    definedBy: { file: 'src/util/memory.ts', name: 'CACHE_RATIO' },
    affects: 'SQLite 页缓存目标大小（内存 × 5%）',
    calibration: {
      evidence:
        'memory.ts:31-42 注释：SQLite 默认只有 2 MB，对万级 atom 偏小；也不能无上限，' +
        '大内存机器上按 5% 会凭空多占几百 MB。**推导规则写明了，但 5% 没有实测依据**',
    },
    variesWith: ['机器内存', '库的访问模式'],
  },
  {
    name: 'CACHE_FLOOR_BYTES',
    area: '资源',
    value: () => CACHE_FLOOR_BYTES,
    display: '16 MB',
    definedBy: { file: 'src/util/memory.ts', name: 'CACHE_FLOOR_BYTES' },
    affects: '页缓存下限',
    calibration: { evidence: '**无记录**（同 CacheRatio）' },
    variesWith: ['机器内存'],
  },
  {
    name: 'CACHE_CEIL_BYTES',
    area: '资源',
    value: () => CACHE_CEIL_BYTES,
    display: '128 MB',
    definedBy: { file: 'src/util/memory.ts', name: 'CACHE_CEIL_BYTES' },
    affects: '页缓存上限',
    calibration: { evidence: '**无记录**（同 CacheRatio）' },
    variesWith: ['机器内存'],
  },
  {
    name: 'BUSY_TIMEOUT_FLOOR_MS',
    area: '资源',
    value: () => BUSY_TIMEOUT_FLOOR_MS,
    display: '5000 ms',
    definedBy: { file: 'src/util/memory.ts', name: 'BUSY_TIMEOUT_FLOOR_MS' },
    affects: '写锁等待下限：max(5000, 单条写入耗时 × 200)',
    calibration: {
      evidence:
        'memory.ts:40-41 注释：**实测单条写入约 3.5 ms**，5 秒已能排下上千次写入；慢盘上按写入耗时' +
        '放大而不是拍一个更大的常数。标定发生在**本机磁盘**上',
    },
    variesWith: ['磁盘延迟', '并发写入压力'],
    diverges: '**这个数同时是「本机实测」的产物**：3.5 ms × 200 里的 200 与 3.5 都没有文档出处',
  },
  {
    name: 'MMAP_MEMORY_DIVISOR',
    area: '资源',
    value: () => MMAP_MEMORY_DIVISOR,
    display: '8（内存的八分之一）',
    definedBy: { file: 'src/util/memory.ts', name: 'MMAP_MEMORY_DIVISOR' },
    affects: 'mmap 上限的第二个约束：与固定 256 MB 取更小者',
    calibration: {
      evidence: '**无记录**：mmap 是虚拟地址占用，但被访问的页会驻留物理内存；给内存的八分之一是经验取法',
    },
    variesWith: ['机器内存', '库的访问局部性'],
  },
  {
    name: 'MMAP_GROWTH',
    area: '资源',
    value: () => MMAP_GROWTH,
    display: '库文件的 1.5 倍',
    definedBy: { file: 'src/util/memory.ts', name: 'MMAP_GROWTH' },
    affects: 'mmap 目标窗口相对库文件大小的倍数：让整个库文件能落进窗口',
    calibration: { evidence: '**无记录**：1.5 只为「留一点余量让整个文件进窗口」，没有实测出处' },
    variesWith: ['库文件大小'],
  },
  {
    name: 'WRITE_COST_MEASURED_MS',
    area: '资源',
    value: () => WRITE_COST_MEASURED_MS,
    display: '3.5 ms（本机实测的单条写入耗时）',
    definedBy: { file: 'src/util/memory.ts', name: 'WRITE_COST_MEASURED_MS' },
    affects: '写锁等待时间的推导基数：慢盘上按它放大，而不是拍一个更大的常数',
    calibration: {
      evidence: 'memory.ts 注释里的实测值（本机磁盘、单条写入）。换机器后这个数会变，届时等待时间自动跟着变',
    },
    variesWith: ['磁盘延迟', '机器负载'],
  },
  {
    name: 'BUSY_TIMEOUT_MULTIPLIER',
    area: '资源',
    value: () => BUSY_TIMEOUT_MULTIPLIER,
    display: '200 倍',
    definedBy: { file: 'src/util/memory.ts', name: 'BUSY_TIMEOUT_MULTIPLIER' },
    affects: '等待时间 = 单条写入耗时 × 200（约能排下几百次写入）',
    calibration: {
      evidence: '**无记录**：按「一次等待里最多排多少次写入」的经验取法，没有实测出处',
    },
    variesWith: ['并发写入压力'],
  },
  {
    name: 'VEC_DIM',
    area: '资源',
    value: () => VEC_DIM,
    definedBy: { file: 'src/util/vec.ts', name: 'VEC_DIM' },
    affects: '向量维度与 BLOB 长度校验；维度不匹配的向量被跳过而不是硬算',
    calibration: {
      evidence:
        'vec.ts:10 注释与 devnotes M1《按「跨机器是否一致」分类》A 类：bge-small-zh-v1.5 的输出维度（模型事实）',
    },
    variesWith: ['换编码模型'],
    diverges: '**结构性常量**，登记它是为了换模型时能被一条命令查出来',
  },
  // ─────────────────── 显式删除（forget.ts，T20 / §44）───────────────────────
  {
    name: 'FORGOTTEN_MIN_BIGRAMS',
    area: '显式删除',
    value: () => FORGOTTEN_MIN_BIGRAMS,
    definedBy: { file: 'src/pipeline/forget.ts', name: 'FORGOTTEN_MIN_BIGRAMS' },
    affects: '防写回判据的**可判下限**：两侧任一不足这么多 bigram 就不做判断（放行）',
    calibration: {
      evidence:
        '**不是标定值，是一条有意义性下限**：Jaccard 是两边一比算出来的，2 个 bigram 对 20 个也能得 0.09。' +
        '取 2 是复用 `entries.ts` 的 `MIN_TERM = 2`（bigram 的最小语义单位就是 2 个字符），' +
        '不是另立一个数。**未做实测**：真正需要标定的是「多短算太短」，那要拿真实短记忆的分布来定',
    },
    variesWith: ['写入约定里一条记忆的最短长度'],
    diverges: '**不是阈值而是下限**，登记它是为了让「防写回在多短的文本上不生效」可被一条命令查出来',
  },
  {
    name: 'FORGOTTEN_SCAN_LIMIT',
    area: '显式删除',
    value: () => FORGOTTEN_SCAN_LIMIT,
    definedBy: { file: 'src/pipeline/forget.ts', name: 'FORGOTTEN_SCAN_LIMIT' },
    affects: '写入时最多比对多少条墓碑；超过时结果带 truncated，写入结果上会标出来',
    calibration: {
      evidence:
        '**无记录**，是资源上限而非质量阈值：墓碑数与「用户删除过的条数」同阶，正常到不了。' +
        '设它是为了让写入是**有界**的 —— 无上限的全表读会让写入随删除次数悄悄变慢',
    },
    variesWith: ['用户删除的累计条数', '写入路径的延迟预算'],
  },
  {
    name: 'FORGET_BODY_MAX_BYTES',
    area: '显式删除',
    value: () => 4096,
    definedBy: { file: 'src/index.ts', name: 'FORGET_BODY_MAX_BYTES' },
    affects: '删除端点（唯一的写路由）接受的请求体上限',
    calibration: {
      evidence:
        '**无记录**，是资源上限：删除请求只有一个整数 id，几百字节足够。' +
        '设它是因为读请求体是累积式的，没有上限就等于允许任何本机进程让宿主堆任意大的字符串' +
        '（回环不是「可信」，只是「本机」—— 宿主对插件路由不做鉴权）',
    },
    variesWith: ['请求体里要不要带更多字段'],
  },
  // ────────────────────────────── 重聚类（T16）──────────────────────────────
  {
    name: 'RECLUSTER_PLAN_DELAY_MS',
    area: '重聚类',
    value: () => RECLUSTER_PLAN_DELAY_MS,
    definedBy: { file: 'src/cluster/executor.ts', name: 'RECLUSTER_PLAN_DELAY_MS' },
    affects:
      '点「开始整理」之后等多久才真的开跑。这段时间里「取消」有效，之后只能等它跑完 —— ' +
      '它决定了误点之后还有多长的反悔窗口',
    calibration: {
      evidence:
        '**未标定，是产品口味**：3 秒是「点错了还能撤」与「点了要立刻有反应」之间的取值。' +
        '没有测量能回答 3 秒比 1 秒或 5 秒更合适 —— 它取决于人点下去之后多久会意识到自己点错了',
    },
    variesWith: ['用户对整理耗时的容忍度', '库规模（跑得越久，越需要更长的反悔窗口）'],
  },
  {
    name: 'DEFAULT_KNN_K',
    area: '重聚类',
    value: () => DEFAULT_KNN_K,
    definedBy: { file: 'src/cluster/graph.ts', name: 'DEFAULT_KNN_K' },
    affects:
      'k 近邻图每点保留的邻居数，同时也是 min_samples（核心距离取第几近邻）—— ' +
      '它决定互可达距离里「核心距离」那一项有多大，也就决定了小簇会被抹平到什么程度',
    calibration: {
      evidence:
        '设计报告 §21 给 min_samples = 2，而 min_samples 与 k 在本实现里是同一个参数。' +
        '标定来自 T16 探针在基准库（1 374 条真实向量、512 维）上的对照：与参照实现' +
        '（clusternova，mpts=2）比，k=2 得 82 簇 / 噪声占 68.9%、参照 75 簇 / 73.4%，' +
        '双向成员重合度 0.77 / 0.85；k>=6 时本实现塌缩到个位数簇。' +
        '**只有一个规模档的实测**',
    },
    variesWith: ['库规模（k 越大越小簇越易被抹平）', '语料密度分布', '换编码模型（余弦尺度会变）'],
  },
  {
    name: 'DEFAULT_MIN_CLUSTER_SIZE',
    area: '重聚类',
    value: () => DEFAULT_MIN_CLUSTER_SIZE,
    definedBy: { file: 'src/cluster/hierarchy.ts', name: 'DEFAULT_MIN_CLUSTER_SIZE' },
    affects:
      '簇的规模门槛：小于此值的碎片在压缩阶段并入父簇，而不是各自成为一个主题。' +
      '它是唯一带语义的聚类参数 —— 直接表达「多小算一个独立主题」',
    calibration: {
      evidence:
        '设计报告 §21 写死 min_cluster_size = 3，**没有给标定实验**。T16 探针沿用了它，' +
        '并在基准库上观察到 k=2 档的中位簇规模 4、最大 24。' +
        '「3 是不是对的」本轮没有测 —— 没有拿「人工判定哪些记忆属于同一主题」做对照',
    },
    variesWith: ['库规模', '一条记忆的平均信息量', '「一个主题至少几条记忆才有用」这个产品判断'],
  },
  {
    name: 'DEFAULT_ALIGN_COS',
    area: '重聚类',
    value: () => DEFAULT_ALIGN_COS,
    definedBy: { file: 'src/cluster/align.ts', name: 'DEFAULT_ALIGN_COS' },
    affects:
      '身份对齐：新簇质心与旧 topic 质心的余弦达到此值才允许配对，配对成功的旧 topic id ' +
      '被继承（挂在其上的主属引用、次属引用与 near 边因此不失效）',
    calibration: {
      evidence:
        '时序文档 4.3 给的 0.80，**该文档没有给标定实验**。T16 探针在基准库上实测了这条线' +
        '的效果（配对成功率与配对余弦的分位），但没有反向标定「0.80 之下哪些其实同属一个' +
        '主题」—— 那需要人工对照，本轮没做。数值上与落位的 tauJoin = 0.78 接近，' +
        '但两者问的是不同的问题，不要合并',
    },
    variesWith: ['换编码模型（余弦尺度会变）', '重聚类的频率（间隔越久，旧质心越不代表现状）'],
  },
  {
    name: 'MST_BRIDGE_FACTOR',
    area: '重聚类',
    value: () => MST_BRIDGE_FACTOR,
    definedBy: { file: 'src/cluster/mst.ts', name: 'MST_BRIDGE_FACTOR' },
    affects:
      'k 近邻图不连通时，缝合分量所用的桥边权重 = 全图最大权重 × 本值。' +
      '它决定那些孤立分量在层次树上「多晚」才被并进全局根',
    calibration: {
      evidence:
        '**无标定实验**。取 2（即桥边比任何真实边都贵）是一个**语义**选择而不是拟合：' +
        '分量之间一条边都没有（不是「边太贵」，是真的没有），任何取法都造不出真实的' +
        '连接，只能保证「它排在 Kruskal 顺序的最后」。T16 探针量化过这个选择的影响：' +
        '基准库 k=2 时有 5 个分量（1360/4/4/3/3），4 条桥边；造桥与不造桥的**簇数、' +
        '噪声数完全相同**（82 簇 / 947 噪声），差别只在「那 14 个孤立点有没有 label」' +
        '—— 不造桥时有 117 个点不属于任何层次树节点，其中 103 个在主分量里',
    },
    variesWith: ['k（k 越大分量越少，需要桥边的场合越少）', '语料的密度分布'],
  },
  {
    name: 'RECLUSTER_BATCH_ATOMS',
    area: '重聚类',
    value: () => RECLUSTER_BATCH_ATOMS,
    definedBy: { file: 'src/cluster/rebuild.ts', name: 'RECLUSTER_BATCH_ATOMS' },
    affects:
      '落库阶段每个事务处理的条数：一批 = 一次事务 = 一次事件循环占用。' +
      '它约束的是「重聚类会不会把宿主卡住」（B2 瓶颈：DatabaseSync 是同步的）',
    calibration: {
      evidence:
        '**没有标定**。1 000 取自「一批在本机约几十毫秒、不至于让事务次数爆炸」的粗估，' +
        '**没有测过宿主在何种批大小下开始出现可感知卡顿** —— 那需要端到端观测宿主的响应' +
        '延迟，本轮没做',
    },
    variesWith: ['机器磁盘与 WAL 配置', '宿主对单次同步阻塞的容忍度', '库规模（批数随 atom 数增长）'],
  },
  // ────────────────────────────── 图扩展（graph/infer.ts）──────────────────────────────
  {
    name: 'NEAR_K',
    area: '图扩展',
    value: () => NEAR_K,
    definedBy: { file: 'src/graph/infer.ts', name: 'NEAR_K' },
    affects:
      'inferEdges：每个 atom 保留多少个向量近邻作为 near 边。它同时是图路的宽度与 ' +
      '§36 第 8 项 MOD 的旋钮 —— 实测 MOD 几乎等于 K',
    calibration: {
      evidence:
        'T18 探针 03（可复跑）在基准库上的参数网格：K = 2/3/4/6/8 × cosMin = 0.70/0.75/0.80。' +
        '实测 96%（1293/1374）的 atom 过线邻居多于 K，所以 MOD 由 K 直接决定：' +
        'K=4 → 3.86，K=6（cosMin 0.75）→ 4.64。§36 给 MOD 的目标区间 2~5，取区间中点 4。' +
        '**只有一个规模档的实测**',
    },
    variesWith: ['库规模（atom 越多近邻越密）', '换编码模型（余弦尺度会变）', '§36 的 MOD 目标区间'],
  },
  {
    name: 'NEAR_COS_MIN',
    area: '图扩展',
    value: () => NEAR_COS_MIN,
    definedBy: { file: 'src/graph/infer.ts', name: 'NEAR_COS_MIN' },
    affects: 'inferEdges：余弦低于此值的 atom 对不建边。它决定边质量的下限，也决定孤立率',
    calibration: {
      evidence:
        'T18 探针 01（余弦分布）与探针 03（参数网格）实测：top-16 邻居的 cos 中位数 0.748、' +
        'p10 0.685 —— 0.70 与 0.86 之间没有自然断点，抬线砍不掉一批「明显更差」的边，' +
        '只会制造孤点：0.70 → 孤立 1.6%，0.75 → 8.1%（越过 §36 的 <8% 目标），' +
        '0.80 → 34%（越过 20% 报警线）。0.70 是三个候选里唯一同时满足 MOD 与孤立率两条区间的。' +
        '**它不是「相似」的语义线**，只是「别把可用的 atom 变成孤点」的底线',
    },
    variesWith: ['换编码模型（余弦尺度会变）', '§36 的孤立率目标', '语料的领域混合度'],
  },
  {
    name: 'OUT_DEGREE_CAP',
    area: '图扩展',
    value: () => OUT_DEGREE_CAP,
    definedBy: { file: 'src/graph/infer.ts', name: 'OUT_DEGREE_CAP' },
    affects:
      '出度硬上限。两个来源各自用一次、**不合并计数**：推断边每 atom ≤ 16（inferEdges ' +
      '把超出的邻居截断），声明边每批 ≤ 16（write.ts 把超出的边拒掉）。所以同一个 atom ' +
      '可以有 16 条推断边 + 16 条声明边，合计不设上限。查询侧（graphPath 的每个种子）' +
      '也用它截断候选，同样不参与前两者的计数',
    calibration: {
      evidence:
        '**设计文档给的值，未在本库标定**：§33 的降级路径写「出度硬上限（建议 16）+ confidence ' +
        '截断」，§40 的反例判据写「必须给每 Atom 出度硬上限 16」，技术文档 4.2 的图路参数也是 16。' +
        '本轮实测中它**从未触发** —— 参数网格里 cappedByHardLimit 恒为 0、最大出度 8，' +
        '真正在起作用的是 NEAR_K；16 是 K 被调大时的兜底',
    },
    variesWith: ['NEAR_K（K 接近或超过 16 时它才开始生效）', '库规模与语料密度'],
    design: { doc: DESIGN_DOC_T18_FAIL, key: '出度硬上限', default: 16 },
  },
  {
    name: 'GRAPH_INFER_MAX_ATOMS',
    area: '图扩展',
    value: () => GRAPH_INFER_MAX_ATOMS,
    definedBy: { file: 'src/graph/infer.ts', name: 'GRAPH_INFER_MAX_ATOMS' },
    affects:
      'inferEdges：超过此规模就不做全量两两比较，直接拒绝推断并如实报告结果，' + '而不是安静地跑上几分钟',
    calibration: {
      evidence:
        '**按实测吞吐外推，未在更大库上实测**：基准库 1374 条 atom 的全量成对（943 251 对、' +
        '512 维）实测 460~510 ms；O(N²) 外推到 4 000 条约 4 s、到 8 000 条约 16 s。' +
        '取 4 000 对应「首次召回最多多等约 4 秒」这个判断，不是实测出来的上限。' +
        '要真正解掉这条外推，得把全量成对换成桶内候选或 SimHash 预筛',
    },
    variesWith: ['机器算力', '单次召回可接受的阻塞时长', '是否改成近邻候选而非全量成对'],
  },
  {
    name: 'DECLARED_EDGE_CONFIDENCE',
    area: '图扩展',
    value: () => DECLARED_EDGE_CONFIDENCE,
    definedBy: { file: 'src/pipeline/write.ts', name: 'DECLARED_EDGE_CONFIDENCE' },
    affects:
      '写入声明边（origin = declared）时的 confidence：它是一个常量，不是相似度。' +
      '**只影响图路内部先后**：每个种子留哪几条邻居（查询侧的出度截断按它排序），' +
      '以及【路】段的行序。它**不进原子分数** —— 但会经图路的名次间接改变候选的 final：' +
      '换掉两条声明边的 confidence，可能改变谁先谁后，也可能换掉被截断留下的那几条',
    calibration: {
      evidence:
        '**设计取值，不是标定**：裁决把 declared 定义为真相源，而「声明」本身就是证据，' +
        '因此给满 1.0，与 near 边「没有证据时给中位」的 0.5 相反。' +
        '1.0 的作用是让声明边在【路】段与邻居截断里排在推断边之前；' +
        '它不是中性常量 —— 交换两条声明边的 confidence，两个候选的 final 会跟着互换',
    },
    variesWith: ['图路每个种子的出度截断（换值会换掉留下的邻居）', '【路】段的行序'],
  },
  {
    name: 'DECLARED_EDGE_TYPE_MAX',
    area: '图扩展',
    value: () => DECLARED_EDGE_TYPE_MAX,
    definedBy: { file: 'src/pipeline/write.ts', name: 'DECLARED_EDGE_TYPE_MAX' },
    affects:
      '写入声明边时 type 的字符数上限：超过即拒这条边（不拒记忆），拒因随回执返回。' +
      '字符集另有判据（小写字母 / 数字 / 下划线，正则见 write.ts 的 DECLARED_EDGE_TYPE_RE）',
    calibration: {
      evidence:
        '**护栏，不是标定**：现有五类 kind 最长 10 个字符（supersedes），32 留两倍余量给' +
        '项目自定义的关系名；再长就会挤占回执与注入文本，且没有任何已知用法需要它',
    },
    variesWith: ['模型自取关系名的实际长度分布（本项目尚无这份实测）'],
  },
  // ────────────────────────────── 降级日志（src/log/）──────────────────────────────
  //
  // 这一组的取值来源是 M4 开工裁决 #35（用户裁决），不是语料标定：日志的容量参数
  // 取决于「降级事件多久发生一次、一条多长」，而本仓库还没有这份实测。
  // 按本表纪律，这里如实写「未标定」，而不是编一个看起来有依据的场景。
  {
    name: 'LOG_FILE_MAX_BYTES',
    area: '降级日志',
    value: () => LOG_FILE_MAX_BYTES,
    definedBy: { file: 'src/log/store.ts', name: 'LOG_FILE_MAX_BYTES' },
    affects: '写前与启动时检查：当前日志库达到此大小就改名为历史文件并新建（4 MB）',
    calibration: {
      evidence:
        '**未标定**（没有日志事件速率的实测）：裁决 #35 定 4 MB，理由「降级事件稀疏，' +
        '4 MB 约能放数万条」；与「保留 5 个」正好拼成 20 MB 的总量上限',
    },
    variesWith: ['降级事件产生速率', '单条 detail 的长度', '愿意给日志的磁盘空间'],
  },
  {
    name: 'LOG_KEEP_FILES',
    area: '降级日志',
    value: () => LOG_KEEP_FILES,
    definedBy: { file: 'src/log/store.ts', name: 'LOG_KEEP_FILES' },
    affects: '清理：历史文件数 + 当前库不超过这个数，超出删最旧的（5 个，含当前库）',
    calibration: {
      evidence: '**未标定**：裁决 #35 定 5 个；5 x 4 MB 与总量 20 MB 对齐',
    },
    variesWith: ['单文件阈值', '总量上限', '需要回溯多久的降级历史'],
  },
  {
    name: 'LOG_TOTAL_MAX_BYTES',
    area: '降级日志',
    value: () => LOG_TOTAL_MAX_BYTES,
    definedBy: { file: 'src/log/store.ts', name: 'LOG_TOTAL_MAX_BYTES' },
    affects: '清理：全部日志文件（含当前库）总大小超过此值就删最旧的历史文件（20 MB）',
    calibration: {
      evidence:
        '**未标定**：裁决 #35 定 20 MB = 5 x 4 MB，与保留文件数对齐；T53 改成公式 LOG_KEEP_FILES × LOG_FILE_MAX_BYTES',
    },
    variesWith: ['单文件阈值', '保留文件数', '磁盘配额'],
  },
  {
    name: 'LOG_QUEUE_MAX',
    area: '降级日志',
    value: () => LOG_QUEUE_MAX,
    definedBy: { file: 'src/log/index.ts', name: 'LOG_QUEUE_MAX' },
    affects: '缓冲：内存队列上限 200 条；满了丢最旧并计数，不阻塞、不抛错',
    calibration: {
      evidence:
        '**未标定**（按速率推算，非实测）：裁决 #35 定 200 条 —— 200 条在 50ms 窗口下约' +
        ' 4000 条/秒的吸收能力，远超降级事件实际速率；同时把单个进程的日志内存钉在几十 KB',
    },
    variesWith: ['降级事件爆发速率', '批量窗口', '单条日志的内存占用'],
  },
  {
    name: 'LOG_FLUSH_WINDOW_MS',
    area: '降级日志',
    value: () => LOG_FLUSH_WINDOW_MS,
    definedBy: { file: 'src/log/index.ts', name: 'LOG_FLUSH_WINDOW_MS' },
    affects:
      '缓冲：批量窗口的**上界**。正常路径由 setImmediate 在下一轮事件循环 flush；' +
      '只有事件循环被占住、队首已等满 50ms 时才当场 flush（不新增定时器）',
    calibration: {
      evidence: '**未标定**：裁决 #35 给「setImmediate 或 50ms」，实现取两者中更保守的上界',
    },
    variesWith: ['事件产生速率', '崩溃时允许丢失的时间窗', '宿主的事件循环忙碌程度'],
  },
  {
    name: 'LOG_WRITE_FAILED_MIN_INTERVAL_MS',
    area: '降级日志',
    value: () => LOG_WRITE_FAILED_MIN_INTERVAL_MS,
    definedBy: { file: 'src/log/index.ts', name: 'LOG_WRITE_FAILED_MIN_INTERVAL_MS' },
    affects: '写失败降级：log.write_failed 的限频间隔（1 次/分钟）',
    calibration: {
      evidence: '**未标定**：设计草案第三节给「限频，1 次/分钟」，取 60 000 ms',
    },
    variesWith: ['故障持续时间', '日志库的可用性', '用户对日志噪声的容忍度'],
  },
  {
    name: 'LOG_EXPORT_MAX_ROWS',
    area: '降级日志',
    value: () => LOG_EXPORT_MAX_ROWS,
    definedBy: { file: 'src/log/export.ts', name: 'LOG_EXPORT_MAX_ROWS' },
    affects: '导出：CSV 最多 10 万行数据，超过截断并在文件尾加 # truncated',
    calibration: {
      evidence:
        '**未标定**：裁决 #35 定 10 万行。按单行约 60~120 字节估算，10 万行约 6~12 MB，' +
        '与 10 MB 的字节上限互为兜底',
    },
    variesWith: ['单行 detail 的长度', '导出可接受的内存与等待时间'],
  },
  {
    name: 'LOG_EXPORT_MAX_BYTES',
    area: '降级日志',
    value: () => LOG_EXPORT_MAX_BYTES,
    definedBy: { file: 'src/log/export.ts', name: 'LOG_EXPORT_MAX_BYTES' },
    affects: '导出：CSV 最多 10 MB（含表头），超过截断并加 # truncated',
    calibration: {
      evidence: '**未标定**：裁决 #35 定 10 MB；与 10 万行上限谁先到谁截断',
    },
    variesWith: ['单行 detail 的长度', '浏览器/编辑器打开大文件的承受度'],
  },
  // ──────────────────────────── 校准样本（src/samples/）────────────────────────────
  //
  // 这一组的取值来源是 M4 开工裁决 #34（用户裁决），不是语料标定：样本库的容量与
  // 负样本分档取决于「一次会话里模型会反馈几次」，本仓库还没有这份实测。
  // 按本表纪律，如实写「未标定」，而不是编一个看起来有依据的场景。
  {
    name: 'SAMPLE_RETAIN_DAYS',
    area: '校准样本',
    value: () => SAMPLE_RETAIN_DAYS,
    definedBy: { file: 'src/samples/store.ts', name: 'SAMPLE_RETAIN_DAYS' },
    affects: '淘汰：写样本时删掉 created_at 早于「现在 - 90 天」的行',
    calibration: {
      evidence:
        '**未标定**：裁决 #34 ③ 定 90 天。理由是「跨一个季度的对照仍有意义，再久语料族' +
        '大概率已经变了」—— 这是判断而非实测，样本的实际衰减速率没有测过',
    },
    variesWith: ['语料族的更新周期', '重标频率'],
  },
  {
    name: 'SAMPLE_MAX_ROWS',
    area: '校准样本',
    value: () => SAMPLE_MAX_ROWS,
    definedBy: { file: 'src/samples/store.ts', name: 'SAMPLE_MAX_ROWS' },
    affects: '总量：超过 1 万条时按 created_at 淘汰最旧的（约 20 MB：512 维 x 4 B x 1 万）',
    calibration: {
      evidence:
        '**未标定**：裁决 #34 ③ 定 1 万条。10 万条向量约 200 MB，已明确不可行；' +
        '1 万条是「够切点估计、又不超过一个普通库的量级」的判断，不是按样本量需求算出来的',
    },
    variesWith: ['切点估计所需的样本量', '愿意给的磁盘空间'],
  },
  {
    name: 'SAMPLE_NEG_OBVIOUS_MAX',
    area: '校准样本',
    value: () => SAMPLE_NEG_OBVIOUS_MAX,
    definedBy: { file: 'src/samples/store.ts', name: 'SAMPLE_NEG_OBVIOUS_MAX' },
    affects:
      '「明显无关」负样本的上限：满了删最旧的、保留最近 2000 条。' +
      '「不确定带」的那一档不设上限（它才是切点信息的来源）',
    calibration: {
      evidence:
        '**未标定**：裁决 #34 ④ 定 2000 条。理由是该档「对切点信息量低」，只需要少量' +
        '代表；具体多少条够，要等 T46 的重标样本量与切点偏移实测',
    },
    variesWith: ['切点扫描对负样本数量的敏感度', '总条数上限'],
  },
  {
    name: 'SAMPLE_OBVIOUS_MAX_TOP1',
    area: '校准样本',
    value: () => SAMPLE_OBVIOUS_MAX_TOP1,
    definedBy: { file: 'src/samples/store.ts', name: 'SAMPLE_OBVIOUS_MAX_TOP1' },
    affects: '负样本分档：top1 低于 0.4 记为「明显无关」（这一档有 2000 条上限）',
    calibration: {
      evidence:
        '**未标定**：裁决 #34 ④ 给出 0.4 / 0.6 两条线，但没有说明依据。' +
        '可对照的实测只有一处，量级相近但口径不同：view.ts 注释里「无关查询 top1 上界 ' +
        '0.398」（279 条库、24 条查询）、「0.515」（1374 条库）—— 说明这条线随库规模上移，' +
        '固定 0.4 在大库上会把「有点关系」的召回记成明显无关',
    },
    variesWith: ['库规模（无关 top1 随库长大上移）', '语料族', '编码模型'],
  },
  {
    name: 'SAMPLE_UNCERTAIN_MAX_TOP1',
    area: '校准样本',
    value: () => SAMPLE_UNCERTAIN_MAX_TOP1,
    definedBy: { file: 'src/samples/store.ts', name: 'SAMPLE_UNCERTAIN_MAX_TOP1' },
    affects: '负样本分档：top1 在 0.4~0.6 记为「不确定带」（优先保留，供切点扫描）',
    calibration: {
      evidence:
        '**未标定**：裁决 #34 ④ 的 0.6。与上一条同源 —— 两条线一起定，分开调没有意义；' +
        '它们的位置应当由 T46 的切点扫描给出，本表只记录当前取值',
    },
    variesWith: ['库规模', '语料族', '编码模型', '切点的目标位置'],
  },
  {
    name: 'SAMPLE_QUEUE_MAX',
    area: '校准样本',
    value: () => SAMPLE_QUEUE_MAX,
    definedBy: { file: 'src/samples/index.ts', name: 'SAMPLE_QUEUE_MAX' },
    affects: '缓冲：内存队列上限 64 条；满了丢最旧并计数，不阻塞召回、不抛错',
    calibration: {
      evidence:
        '**未标定**：按「一次召回最多入队一条」推算。64 条足以吸收事件循环被占住的' +
        '一整轮（对照 LOG_QUEUE_MAX 的 200 条：日志一次召回可能同时产生三条事件）',
    },
    variesWith: ['事件循环被占住的时长', '单条样本的内存占用'],
  },
  {
    name: 'FLAG_SPLIT_PENDING',
    area: '写入',
    value: () => FLAG_SPLIT_PENDING,
    definedBy: { file: 'src/db/flags.ts', name: 'FLAG_SPLIT_PENDING' },
    affects:
      'atom.flags 的 bit0：待拆分（T29）。写入侧**按长度切分**时置上（每段都置），召回时锚行标「疑似应拆分」，由人在界面上确认或忽略（两者都清这一位）',
    calibration: {
      evidence:
        '位定义来自设计报告对 flags 的命名（待拆分 / 歧义 / 未归类）。**位值一旦落库就不能改**。置位判据是长度（review.ts 的 maxChars），不是自洽度评分 —— 候选按长度给出、不判断内容',
    },
    variesWith: ['（不应变：改它等于把历史行解释错）'],
  },
  {
    name: 'SPLIT_CONFIRMED_MAX',
    area: '写入',
    value: () => SPLIT_CONFIRMED_MAX,
    definedBy: { file: 'src/pipeline/split.ts', name: 'SPLIT_CONFIRMED_MAX' },
    affects:
      '「用户已确认应拆分」清单的条数上限（meta 的 split_confirmed，FIFO 淘汰最早的一条）。满了只影响更早的确认还能不能出现在锚行提示里，不改变任何召回与写入行为',
    calibration: {
      evidence:
        '**未标定，是护栏**：一次召回最多展示二十几条锚，清单比锚段还长时多出来的部分对任何一次召回都没有影响，却会让 meta 的值无限增长',
    },
    variesWith: ['锚段条数（topN 与实际预算）', '用户对候选的处理速度'],
  },
  {
    name: 'SPLIT_SEGMENTS_MAX',
    area: '写入',
    value: () => SPLIT_SEGMENTS_MAX,
    definedBy: { file: 'src/pipeline/split.ts', name: 'SPLIT_SEGMENTS_MAX' },
    affects:
      '「切分时共几段」映射的条数上限（meta 的 split_pending_segments，FIFO）。满了只影响更早的候选还能不能显示段数，段数未知时锚行退回不带段数的固定串',
    calibration: {
      evidence:
        '**未标定，是护栏**：一次写入最多切 8 段，这个上限容得下四次切分写入；比锚段还长时多出来的部分对任何一次召回都没有影响，却会让 meta 的值无限增长',
    },
    variesWith: ['一次写入的切分段数上限（REVIEW_MAX_SEGMENTS）', '锚段条数（topN 与实际预算）'],
  },
  {
    name: 'SPLIT_SCENE_CHARS',
    area: '写入',
    value: () => SPLIT_SCENE_CHARS,
    definedBy: { file: 'src/pipeline/view.ts', name: 'SPLIT_SCENE_CHARS' },
    affects:
      '锚行「用于：<查询词>」里查询词最多给几个字符（只对 flags 的 bit0 命中生效）。保证单条锚的文本增量不超过 44 字（候选标记 + 段数 + 使用场景的合计上限）',
    calibration: {
      evidence:
        '**未标定，是预算护栏**：锚段按字符算预算，查询词可以是一整句；不截断会让一条锚多出几十上百字，同一段预算能装下的记忆随之变少',
    },
    variesWith: ['查询词长度分布', '锚段预算', '「单锚增量 ≤ 40 字」这条判据'],
  },
  {
    name: 'FLAG_AMBIGUOUS',
    area: '写入',
    value: () => FLAG_AMBIGUOUS,
    definedBy: { file: 'src/db/flags.ts', name: 'FLAG_AMBIGUOUS' },
    affects: 'atom.flags 的 bit1：落位时两个候选接近、没把握',
    calibration: { evidence: '同 FLAG_SPLIT_PENDING：位值不可变' },
    variesWith: ['（不应变）'],
  },
  {
    name: 'FLAG_UNCLASSIFIED',
    area: '写入',
    value: () => FLAG_UNCLASSIFIED,
    definedBy: { file: 'src/db/flags.ts', name: 'FLAG_UNCLASSIFIED' },
    affects: 'atom.flags 的 bit2：与任何已有主题都不像（未归类）',
    calibration: { evidence: '同 FLAG_SPLIT_PENDING：位值不可变' },
    variesWith: ['（不应变）'],
  },
  {
    name: 'FLAG_ARCHIVED',
    area: '写入',
    value: () => FLAG_ARCHIVED,
    definedBy: { file: 'src/db/flags.ts', name: 'FLAG_ARCHIVED' },
    affects:
      'atom.flags 的 bit4：已归档（T26）。默认不召回、不进注入三段、列表默认不列；' +
      '显式检索（lattice_list 给 flags、界面勾「显示已归档」）仍可见。不是删除：内容与边都还在',
    calibration: {
      evidence: '位值由设计文档对 flags 的命名确定（技术文档 §5），**不可改**；改它会把历史行解释错',
    },
    variesWith: ['（不应变）'],
  },
  // ──────────────────────── 重标触发（calibration/trigger.ts）────────────────────────
  {
    name: 'RECALIBRATE_COOLDOWN_MS',
    area: '校准样本',
    value: () => RECALIBRATE_COOLDOWN_MS,
    display: '12 小时',
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_COOLDOWN_MS' },
    affects: '冷却：距上次判 S 不足 12 小时就不判、也不重标（省一次伪查询抽样）',
    calibration: {
      evidence:
        '**无测量依据，是产品口味**（裁决 #35）：12 小时对应「一次写作会话」量级。没有任何测量能回答「12 小时比 6 小时更合适」',
    },
    variesWith: ['用户的写作节奏', '库的变化速率'],
  },
  {
    name: 'RECALIBRATE_MIN_ATOMS',
    area: '校准样本',
    value: () => RECALIBRATE_MIN_ATOMS,
    display: '192（= TIER_SCALE_STABLE_ATOMS）',
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_MIN_ATOMS' },
    affects: '闸①：库小于 192 条不重标（S 的抽样波动在这个规模下与漂移同量级）',
    calibration: {
      source: 'calib@0.1.0 阈值重标定（2026-10-17）',
      evidence: '降采样实验结论（阈值稳定所需的最小 atom 数 = 192），与锚点表的稳定下限同一个数',
    },
    variesWith: ['查询集', '语料构成'],
  },
  {
    name: 'RECALIBRATE_MIN_POSITIVE',
    area: '校准样本',
    value: () => RECALIBRATE_MIN_POSITIVE,
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_MIN_POSITIVE' },
    affects: '闸④：正样本少于 10 条不重标（切点会被单条样本牵着走）',
    calibration: {
      evidence: '**未标定**（裁决 #35 的取值）：与写入节奏匹配的经验数，没有测量能给出「少于几条算不够」',
    },
    variesWith: ['用户/模型的标注频率'],
  },
  {
    name: 'RECALIBRATE_DRIFT',
    area: '校准样本',
    value: () => RECALIBRATE_DRIFT,
    display: '0.01（约 1.6σ@192 维）',
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_DRIFT' },
    affects: '闸②：S 与快照基准的差 ≤ 0.01 时不重标（噪声内不动）',
    calibration: {
      evidence:
        'U9 噪声实测：192 维下 S 的 sd 约 0.0063，0.01 约 1.6σ —— 小于它的漂移分不清是库变了还是抽样噪声',
    },
    variesWith: ['采样伪查询条数 m', '库规模'],
  },
  {
    name: 'RECALIBRATE_SAMPLE_LIMIT',
    area: '校准样本',
    value: () => RECALIBRATE_SAMPLE_LIMIT,
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_SAMPLE_LIMIT' },
    affects: '一次重标最多取多少条样本（分层取样的上限，不是样本库容量）',
    calibration: {
      evidence:
        '**未标定**：取样本库容量上限的五分之一；T53 改成公式 SAMPLE_MAX_ROWS ÷ 5。切点只由靠近阈值的样本决定，多取无信息',
    },
    variesWith: ['样本库容量', '阈值附近的样本密度'],
  },
  {
    name: 'RECALIBRATE_OBVIOUS_LIMIT',
    area: '校准样本',
    value: () => RECALIBRATE_OBVIOUS_LIMIT,
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_OBVIOUS_LIMIT' },
    affects: '「明显无关」那一档在一次重标里最多取多少条（不确定带全取）',
    calibration: {
      evidence: '**未标定**：该档的信息量在「它们离得很远」，多取只是重复同一件事',
    },
    variesWith: ['库规模', '负样本的 top1 分布'],
  },
]

/** 设计文档有、代码里没有（或键名完全不同）的配置项。本次只登记，不改文档也不改代码。 */
export const DESIGN_GAPS: readonly DesignGap[] = [
  {
    key: 'deltaPeak',
    designDefault: 0.06,
    note:
      '**文档有、代码里没有名字**：实现就是 write.ts 里 `s1 - (sim2 ?? 0) < 0.06` 那个内联字面量，' +
      '既没有常量名也没有进 zod schema —— 文档说它是可配的（0.01-0.20），实际不可配',
  },
  {
    key: 'ratioAnchor/Entry/Path',
    designDefault: 55,
    note: '**文档有、代码里键名不同**：实现在 pipeline/view.ts 的 SEGMENT_RATIO（小数 0.55 / 0.2 / 0.25）',
    codeSites: ['src/pipeline/view.ts:16 SEGMENT_RATIO'],
  },
  {
    key: 'wVec/wEntry/wBody/wGraph',
    designDefault: 1,
    note: '**文档有、代码里键名不同**：实现在 pipeline/search.ts 的 CHANNEL_WEIGHT（vec / entry / body / graph）',
    codeSites: ['src/pipeline/search.ts:21 CHANNEL_WEIGHT'],
  },
  {
    key: 'autoSplit',
    designDefault: 0,
    note:
      '**文档有、代码里没有运行时开关**（文档默认 false）—— 一期就关闭自动切分，代码里只有迁移脚本' +
      ' migrate/split.ts。文档给的是 bool，本表的 designDefault 只收 number，故记 0 并在此说明',
    codeSites: ['src/migrate/split.ts（仅迁移脚本，非运行时）'],
  },
  {
    key: 'reclusterCron',
    designDefault: 0,
    note:
      '**文档有、代码里没有**（文档默认字符串 03:00，不是数值）—— 低峰重聚类尚未实现，' +
      '与本任务同属后续里程碑',
  },
  {
    key: 'enabled / vaultPath / encoderEnabled / encoderModel',
    designDefault: 1,
    note:
      '**文档有、代码里用的是别的名字或名字相同但非数值**：enabled 与 encoderEnabled 在 index.ts 的' +
      ' Config 里同名；vaultPath 在代码里叫 dataDir（state.ts 的 resolveDataDir）；encoderModel 同名同默认。' +
      '列在此处是为了让「文档 §7 的每个键都有人认领」可核对',
    codeSites: ['src/index.ts:42-51（enabled / dataDir / encoderEnabled / encoderModel）'],
  },
]

/** 对象型阈值组的子键在打印时各占一行（整对象一个值不可比对、也无法逐项标定）。 */
export function subKeys(entry: ThresholdEntry): readonly string[] {
  return entry.group ?? []
}

/** 取当前值：值仍在原处，这里只是现取。 */
export function currentValue(entry: ThresholdEntry): ThresholdValue {
  return entry.value()
}

/** 定义位置：内联量用片段定位，其余用常量名定位（行号由脚本补）。 */
export function definitionSite(entry: ThresholdEntry): { file: string; anchor: string } {
  if (entry.inline !== undefined) return { file: entry.inline.file, anchor: entry.inline.source }
  if (entry.external !== undefined) return { file: '', anchor: entry.name }
  return { file: entry.definedBy?.file ?? '', anchor: entry.definedBy?.name ?? entry.name }
}

/** 覆盖检查用的常量名；内联量与设计类条目返回 null。 */
export function constNameOf(entry: ThresholdEntry): string | null {
  if (entry.constName !== undefined) return entry.constName
  if (entry.inline !== undefined) return null
  // 外部包的常量不在本仓库的数值扫描范围里，登记名进 registered 只会被当成「源码里找不到」。
  if (entry.external !== undefined) return null
  return entry.definedBy?.name ?? null
}

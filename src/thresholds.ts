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

/** 一处源码引用：文件 + 符号名。行号会漂（引的那一段可能已经换成了别的函数），符号不会。 */
export interface ThresholdRef {
  /** 相对仓库根的正斜杠路径，例如 `src/pipeline/write.ts`。 */
  file: string
  /** 文件里必须出现的符号名；打印脚本按整词搜它。 */
  symbol: string
}

/**
 * 来历：这个值是怎么来的。只有两态（见 T52 的判据）。
 *
 * - `recheckable`：测过，而且测量与该值之间有可复算的关系 —— 测量结果变了，这个值要跟着改。
 * - `chosen`：没有任何测量能给出它（设计判断、算法惯例、容量取舍、接口约束）。
 *
 * 判成 `chosen` 的条件是「测量推不出这个值」，不是「现在没有记录」：
 * 曾有测量而记录丢失的，判 `recheckable` 并留空条件字段，让它出现在 `--needs-review` 里。
 */
export type Origin =
  | {
      kind: 'recheckable'
      /** 怎么复算：脚本路径，或「无脚本」加依据哪份记录。 */
      tool: string
      /** 测量或复算得出的事实（区间、对照结果、算式依赖）。 */
      finding: string
      /** 测量用的编码模型。原记录没有就留空，不猜。 */
      encoderModel?: string
      /** 语料规模（条数）。原记录没有就留空，不猜。 */
      scale?: string
      /** 测量时间（YYYY-MM-DD）。 */
      at?: string
      /**
       * 值由代码里的算式算出，不需要语料条件。
       * 唯一用途：让 `--needs-review` 跳过公式条目 —— 公式的依赖关系由代码本身承担。
       */
      formula?: true
    }
  | {
      kind: 'chosen'
      /** 为什么取这个值。**这里不许出现测量数字**：写了数字就说明该判 `recheckable`。 */
      why: string
    }

/**
 * 标定依据：这个值的来历与守卫。
 *
 * 136 条在 T54 全部写成了 `origin`；旧字段 `evidence`（解释）与 `source`（来源指针）
 * 由它取代 —— 两者不保留第二份。原来的来源指针（`calib@<semver>`）搬进了对应条目的
 * `tool` / `finding` / `at`。
 */
export interface ThresholdCalibration {
  /** 来历：可复算，或没有测量能给出它。 */
  origin?: Origin
  /** 按常量名断言默认值的测试文件（T52 的「guardedBy」列）。 */
  guardedBy?: readonly string[]
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

/**
 * zod schema 里的对应项。**只记指针，不抄值** —— 默认值与范围去 `index.ts` 现读。
 *
 * 抄一份的代价是：schema 改了而表里没改，对照表（设计默认 vs 代码默认）拿旧值去比，
 * 结论是「一致」，改动本身看不见。写成指针之后，改 schema 表里跟着变。
 */
export interface ZodSite {
  file: string
  name: string
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
  /** 登记里引用的源码位置；打印脚本核对文件存在、符号在文件里出现。 */
  refs?: readonly ThresholdRef[]
  /**
   * 分叉：设计文档给了数字，代码取的是另一个数字。
   *
   * 只用于「文档有值、代码不同」。文档没有这个键、或分叉讲的是别的事（缺 zod、实现位置或单位
   * 不同、文档未同步），仍写在 `diverges` 里。声明了就必须与 `value()` 不同 —— 相等说明分叉
   * 已经不存在，这句话该删。条目同时有 `design` 时，`docValue` 还必须等于 `design.default`：
   * 那是同一事实的两份记录，改一处不改另一处就是漂移。两条断言都由 `divergenceProblems` 检查，
   * 打印时非零退出。
   */
  divergence?: { docValue: number; note: string }
  /**
   * 已知的与设计文档的分叉，写明现状以便审核。
   *
   * 值分叉（文档一个数、代码另一个数）用 `divergence`，让「分叉还在不在」可断言；这里写
   * 没法用一个数字表达的那些：文档缺这个键、实现位置或单位不同、文档未同步。
   */
  diverges?: string
  /** 覆盖检查用的常量名：默认取 definedBy.name；内联量与设计类条目写 null。 */
  constName?: string | null
  /**
   * 打印时展示的值；值不是数字（例如 Set、复合推导值）时用它替代。
   *
   * 含数字的显示必须写成函数，数字从常量插值（单位换算走 `displayNumber`）：打印时现取，
   * 常量改了它跟着变。写成字符串的数字迟早与常量脱钩，而这一列正是用来核对值的。
   * 只有不含数字的纯文字说明可以保留字符串；字面量里出现 `=` 同样会被打印脚本判红。
   */
  display?: string | (() => string)
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
  /** codeSites 的结构化版本：文件 + 符号名，由打印脚本核对符号确实在文件里。 */
  refs?: readonly ThresholdRef[]
}

/**
 * `recheckable` 的第二参数：来历字段，加上守卫清单。
 *
 * `guardedBy` 不放进 `Origin`：它是「哪条测试按常量名钉住默认值」，与「值怎么来的」是两件事。
 */
export type RecheckableMeta = Omit<Extract<Origin, { kind: 'recheckable' }>, 'kind'> & {
  guardedBy?: readonly string[]
}

/**
 * 登记一条「测过、可复算」的阈值。
 *
 * 返回的是一个片段，用展开式并进条目：`...recheckable(() => X, { tool, finding })`。
 * 值仍以函数给出，不复制数字 —— 模块默认值改了，登记表里的值跟着变。
 */
export function recheckable(
  value: () => ThresholdValue,
  meta: RecheckableMeta,
): Pick<ThresholdEntry, 'value' | 'calibration'> {
  const { guardedBy, ...fields } = meta
  const calibration: ThresholdCalibration = { origin: { kind: 'recheckable', ...fields } }
  if (guardedBy !== undefined) calibration.guardedBy = [...guardedBy]
  return { value, calibration }
}

/**
 * 登记一条「没有测量能给出它」的阈值。
 *
 * 第二个参数的类型是 `string`：传对象（例如 `{ tool }`）在编译期就报错，
 * 不需要额外的运行时检查 —— 「说不出为什么」不能靠随手补一个字段糊过去。
 */
export function chosen(
  value: () => ThresholdValue,
  why: string,
  extra?: { guardedBy?: readonly string[] },
): Pick<ThresholdEntry, 'value' | 'calibration'> {
  const calibration: ThresholdCalibration = { origin: { kind: 'chosen', why } }
  if (extra?.guardedBy !== undefined) calibration.guardedBy = [...extra.guardedBy]
  return { value, calibration }
}

/** 设计文档在开发笔记里的位置（本仓库 docs/ 只放工程文档，设计正文不进公开仓库）。 */
const DESIGN_DOC = '开发笔记 设计/技术文档/7.配置项清单.md'

/** T17 的 learned 反哺参数出自设计报告 §27，不是配置项清单，单独指一处。 */
const DESIGN_DOC_T17 = '开发笔记 设计/设计报告/27.Entry三级权重与learned反哺.md'

/** T18 的出度上限出自 §33 与 §40 两条，不在配置项清单里，单独指一处。 */
const DESIGN_DOC_T18_FAIL = '开发笔记 设计/设计报告/33.失败模式与降级.md'

/**
 * 换算后的显示数字：字节→MB、毫秒→小时、比例→百分数会带二进制浮点尾巴
 * （例如 0.04 × 100 = 4.000000000000001），显示时收掉。只收尾巴，不取整 ——
 * 常量改了，显示仍跟着变。
 */
function displayNumber(value: number): string {
  return String(Number(value.toPrecision(12)))
}

/** 全部登记项。按模块分块，与源码顺序一致，便于对照审查。 */
export const THRESHOLDS: readonly ThresholdEntry[] = [
  // ────────────────────────────── 落位（write.ts）──────────────────────────────
  {
    name: 'DEFAULT_THRESHOLDS.tauJoin',
    area: '落位',
    ...recheckable(() => DEFAULT_THRESHOLDS.tauJoin, {
      tool: 'scripts/probe-threshold.mjs（真实编码模型）',
      scale: '8 组 × 3 条同义改写',
      finding:
        '同主题余弦 min 0.811 / p50 0.897 / max 0.956，跨主题 0.375 / 0.509 / 0.633，两类完全分离；' +
        '0.78 取在同类下界 0.811 之下（误并是静默的知识损坏，漏并只是多一个主题）',
      guardedBy: ['test/write.test.mjs', 'test/forget.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/write.ts', name: 'DEFAULT_THRESHOLDS' },
    affects: 'decidePlacement：与最近 topic 的余弦达到此值、且词面那一票也过，才允许并入',
    variesWith: ['换编码模型', '标定语料的领域混合度', '误并与漏并的代价评估'],
    constName: null,
    design: { doc: DESIGN_DOC, key: 'tauJoin', default: 0.75, min: 0.6, max: 0.95 },
    zod: { file: 'src/index.ts', name: 'tauJoin' },
    divergence: { docValue: 0.75, note: '标定后上调，文档未同步（代码与 zod 都是 0.78）' },
  },
  {
    name: 'DEFAULT_THRESHOLDS.tauLex',
    area: '落位',
    ...recheckable(() => DEFAULT_THRESHOLDS.tauLex, {
      tool: 'scripts/probe-threshold.mjs',
      finding:
        '同主题原文 bigram-Jaccard min 0.059 / p50 0.229 / max 0.471，跨主题 max 0.061；' +
        '0.05 贴住噪声上界取',
      guardedBy: ['test/write.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/write.ts', name: 'DEFAULT_THRESHOLDS' },
    affects: 'decidePlacement：并入所需的词面重叠（bigram-Jaccard，第二票）',
    variesWith: ['语料语言或书写粒度', '原子化切分的长度', '词面判据换粒度时'],
    constName: null,
    design: { doc: DESIGN_DOC, key: 'tauLex', default: 0.12, min: 0.05, max: 0.5 },
    zod: { file: 'src/index.ts', name: 'tauLex' },
    divergence: {
      docValue: 0.12,
      note: '其下界恰为 0.05，代码取的正是那个下界；zod 下界 0.02 比文档的范围更宽',
    },
  },
  {
    name: 'DEFAULT_THRESHOLDS.tauNew',
    area: '落位',
    ...recheckable(() => DEFAULT_THRESHOLDS.tauNew, {
      tool: 'scripts/probe-threshold.mjs（推断：原条目只引设计报告判定表，脚本路径是从 tauJoin 那一条推来的）',
      finding: '跨主题余弦 max 0.633，0.5 取在该上界之下作「全新」的下界',
      guardedBy: ['test/write.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/write.ts', name: 'DEFAULT_THRESHOLDS' },
    affects: 'decidePlacement：低于此余弦直接新建 topic（落未归类域）',
    variesWith: ['换编码模型', '标定语料的领域混合度'],
    constName: null,
    design: { doc: DESIGN_DOC, key: 'tauNew', default: 0.5, min: 0.2, max: 0.8 },
    zod: { file: 'src/index.ts', name: 'tauNew' },
  },
  {
    name: 'DEFAULT_THRESHOLDS.tauLexOnly',
    area: '落位',
    ...recheckable(() => DEFAULT_THRESHOLDS.tauLexOnly, {
      tool: '无脚本（原记录只写「已实测标定」，数值与脚本都没留下）',
      finding: '无向量时没有余弦这一票，词面单票要落在两票模式那条线之上；曾有测量过程，条件与数值都未记录',
      guardedBy: ['test/write.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/write.ts', name: 'DEFAULT_THRESHOLDS' },
    affects: 'decidePlacement：无向量（编码器降级）时并入所需的词面重叠，比两票模式高',
    variesWith: ['词面判据本身的变化（tauLex）', '编码器可用率与其降级路径'],
    constName: null,
    zod: { file: 'src/index.ts', name: 'tauLexOnly' },
    diverges: '**代码新增（降级路径）**，文档未同步',
  },
  {
    name: 'DELTA_PEAK',
    area: '落位',
    ...chosen(
      () => DELTA_PEAK,
      '双峰拒绝线：前两名余弦差小于多少算「分不开」。0.06 来自《设计报告》落位判定表与设计文档 §7 的' +
        ' deltaPeak 默认值，没有测量给出它；它是对「两个候选要多近才拒绝并入」的取舍',
      { guardedBy: ['test/write.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'DELTA_PEAK' },
    affects: 'decidePlacement：sim1 - sim2 小于此差值时判为「双峰」，退回新建（ambiguous）',
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
    ...chosen(
      () => 8,
      '词面第二票的成本上限：每算一个候选 topic 就多一次索引查询，取 8 是为控制查询数 ——' +
        ' 依据是成本不是分布，没有实测标定记录',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'LEX_CANDIDATES' },
    affects: 'decidePlacement：有向量时，只给余弦最靠前的这么多候选 topic 算词面那一票',
    variesWith: ['候选 topic 数与索引查询成本', '库规模（候选变多时该近似会失真）'],
  },
  {
    name: 'WORD_ONLY_CANDIDATES',
    area: '落位',
    ...chosen(
      () => 64,
      '无余弦可用时先取多少个 topic 参与词面预筛，是候选规模上的接口约束：取多少由查询成本与' +
        '库内 topic 总数决定，注释只说「先取多少个」，没有测量给出 64',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'WORD_ONLY_CANDIDATES' },
    affects: '无向量时先取多少个 topic 参与词面预筛（没有余弦可用，只能靠它缩小候选）',
    variesWith: ['库内 topic 总数', 'topic 表按 rebuilt_at 倒序取候选这一近似的偏差'],
    diverges: '**没有进 zod schema**：降级路径的候选上限运行时不可配置',
  },
  {
    name: 'WORD_ONLY_TOP_N_FACTOR',
    area: '落位',
    ...chosen(
      () => WORD_ONLY_TOP_N_FACTOR,
      '词面预筛会淘汰一批候选，保留数取 topN 的倍数：取 2 倍是为「筛掉一批之后还留够' +
        ' decidePlacement 的输入」，属余量取舍，没有测量',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'WORD_ONLY_TOP_N_FACTOR' },
    affects: '无向量时，词面预筛保留的候选数是 topN 的多少倍',
    variesWith: ['词面预筛的淘汰率', 'topN 改动时'],
  },
  {
    name: 'DEFAULT_TOP_N',
    area: '落位',
    ...chosen(
      () => DEFAULT_TOP_N,
      '落位时取多少个 topic 候选：固定上限，由库规模与每次落位的代价决定，无记录；' +
        '它与召回条数同为 24 是同值不同义，不合并 —— 合并会让「调注入条数」顺带改掉落位候选数',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'DEFAULT_TOP_N' },
    affects: 'loadCandidates 的默认候选上限（写入侧的 topic 候选数）',
    variesWith: ['库内 topic 总数', '落位准确率对候选规模的敏感度'],
    otherSites: [
      'src/tools/index.ts recall(..., { topN: cfg.topN }) —— 召回条数走的是配置（zod 的 topN），不是这里的 24',
    ],
    diverges:
      '**设计文档 §7 的 topN 指召回条数**（对应 search.ts 的 RECALL_TOP_N），不是这里的落位候选数 ——' +
      '两件事同为 24 纯属巧合，改配置不会改这里',
  },
  {
    name: 'FINGERPRINT_CHARS',
    area: '落位',
    ...chosen(
      () => FINGERPRINT_CHARS,
      '指纹宽度取「中文摘要 + 背景段」的典型长度：写死一个字符数，取多少由语料段落长度与' +
        '跨机器一致性决定，未记录任何测量；换成别的语料要重标',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'FINGERPRINT_CHARS' },
    affects: '每个成员贡献给 topic 词面指纹的正文字符数（指纹用于估重叠度）',
    variesWith: ['语料的段落长度分布', '语言（换成英文/日文语料）'],
  },
  {
    name: 'FINGERPRINT_MEMBERS',
    area: '落位',
    ...chosen(
      () => FINGERPRINT_MEMBERS,
      '单个 topic 取多少个成员的指纹：上限值，取前 N 个保证结果确定，注释只说「最多取多少个」，' +
        '无实测标定记录',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'FINGERPRINT_MEMBERS' },
    affects: '单个 topic 最多取多少个成员的指纹（取前 N 个，保证结果确定）',
    variesWith: ['单个 topic 的成员数分布（大 topic 多时指纹代表性下降）'],
  },
  {
    name: 'TERM_CHARS',
    area: '注入',
    ...chosen(
      () => TERM_CHARS,
      '折算单位不是阈值：一个词按四个汉字折算，是把「一行给几个词」换算成字符数的口径，属显示口径的约定；没有测量给出这个折算值。' +
        '它与 entries.ts 的 MAX_HAN_TERM(4) 同源，但证据明说不复用那个常量',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'TERM_CHARS' },
    affects:
      '注入行按「词」折算时的字符宽度：主题标签 4 词、单条降级摘要 15 词、摘录档锚摘要 16 词、' +
      '路段摘要 20 词，都乘本值得到字符数',
    variesWith: ['注入层一行给几个词（各段角色不同）'],
  },
  {
    name: 'TOPIC_LABEL_CHARS',
    area: '落位',
    ...recheckable(() => TOPIC_LABEL_CHARS, {
      tool: '源码表达式（src/pipeline/write.ts 的 `4 * TERM_CHARS`）',
      finding:
        '由 TERM_CHARS(4) 与「4 个词」算出 16；改词数或 TERM_CHARS 后重新构建，派生值跟着变，不需要测量',
      formula: true,
    }),
    definedBy: { file: 'src/pipeline/write.ts', name: 'TOPIC_LABEL_CHARS' },
    affects:
      '主题标签的宽度：新建 topic 时取摘要的前这么多字符，注入层入口行也按同一宽度裁' +
      '（write.ts 的 slice 与 view.ts 的 clip 是同一个量）',
    variesWith: ['主题标签在注入层显示多宽', '摘要长度分布'],
    otherSites: ['src/pipeline/view.ts 入口行 `clip(t.label, TOPIC_LABEL_CHARS)`（同源，不再是第二份数字）'],
  },
  {
    name: 'NEAR_EDGE_CONFIDENCE',
    area: '落位',
    ...chosen(
      () => NEAR_EDGE_CONFIDENCE,
      '「没有证据时给中位」的占位值：写 near 边时若没有真实相似度可填，就填一个中位常数；' +
        '是占位不是标定结果',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'NEAR_EDGE_CONFIDENCE' },
    affects: '写 near 边时的默认 confidence（有真实 sim 时用 sim 顶替）',
    variesWith: ['图路排序对 confidence 的依赖方式'],
  },
  {
    name: 'SUMMARY_CHARS',
    area: '写入',
    ...chosen(
      () => SUMMARY_CHARS,
      '摘要按字符截断的上限由「一句话讲一件事」这条写入约定的实际长度决定，无实测标定记录；' +
        '此前函数签名默认值与两个调用点各写一遍，T45 批一合并成一个常量',
      { guardedBy: ['test/util.test.mjs', 'test/write.test.mjs'] },
    ),
    definedBy: { file: 'src/util/text.ts', name: 'SUMMARY_CHARS' },
    affects: '写入时抽取摘要的字符上限（摘要进 atom.summary，参与注入与去重）',
    variesWith: ['一句话讲一件事这条写入约定的实际长度分布', '语言'],
    otherSites: [
      'src/pipeline/write.ts `extractSummary(text, SUMMARY_CHARS)`（同源）',
      'src/pipeline/forget.ts 墓碑摘要 `extractSummary(..., SUMMARY_CHARS)`（同源）',
    ],
  },
  {
    name: 'SEARCH_BODY_MAX_CHARS',
    area: '写入',
    ...chosen(
      () => SEARCH_BODY_MAX_CHARS,
      '进 trigram 索引的正文字符上限是索引代价与长正文细节召回之间的取舍：注释只说明「摘要重复一次」的理由，无实测标定记录；' +
        '同一函数内此前写了两遍（判断与切片），T45 批一合并为一个常量',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'SEARCH_BODY_MAX_CHARS' },
    affects: 'buildSearchBody 里进 trigram 索引的正文字符上限（超出即截断）',
    variesWith: ['atom 正文长度分布', '长正文的细节召回是否重要'],
  },
  // ────────────────────────────── 入口（entries.ts）──────────────────────────────
  {
    name: 'DF_FILTER_RATIO',
    area: '入口',
    ...chosen(
      () => DF_FILTER_RATIO,
      '「过半数即无区分度」这句直觉定下的线：df/N 超过一半的词元直接丢弃。M2 审核 T11 记录该判据' +
        '在基准库上够不到、从未在目标语料上触发，即没有任何测量给出 0.5',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'DF_FILTER_RATIO' },
    affects: '泛词过滤：df/N 超过此比例的词元直接丢弃（不参与入口竞争）',
    variesWith: ['库内 atom 数与来源分布', '语言（英文词表大，问题不明显）'],
    diverges:
      '**本任务要治的原始病例**：判据取自直觉、在运行语料上不触发、且没有任何地方记着它的标定来源。' +
      '治理（改相对判据）属后续执行点，本次只登记不改值',
  },
  {
    name: 'IDF_PRIOR',
    area: '入口',
    ...chosen(
      () => IDF_PRIOR,
      'IDF 平滑项的常规写法（Robertson-Sparck Jones 形式）：0.5 属算法惯例，不是在本库上测出来的',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'IDF_PRIOR' },
    affects: '入口打分的 IDF 平滑项：log((N - df + IDF_PRIOR) / (df + IDF_PRIOR) + 1)',
    variesWith: ['仅在换用别的 IDF 变体时'],
  },
  {
    name: 'EXTRACT_WEIGHT_CEIL',
    area: '入口',
    ...recheckable(() => ENTRY_WEIGHT.extracted, {
      tool: '无脚本，按字段读出',
      finding:
        '本身没有独立数字，值就是 ENTRY_WEIGHT.extracted（0.6），登记项指向该字段而不是镜像一个数字；' +
        '不存在「测量给出它」这件事',
      formula: true,
    }),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'ENTRY_WEIGHT' },
    constName: null,
    affects: '抽取入口的权重归一后上界（declared 恒为 1.0，抽取不得越过它）',
    variesWith: ['ENTRY_WEIGHT.extracted 改动时'],
  },
  {
    name: 'IDF_FREQUENCY_FACTOR（内联）',
    area: '入口',
    ...recheckable(() => 'log2(1 + tf)', {
      tool: '无脚本（2026-10-17 实现报告里的对比测量，未点名脚本路径）',
      finding:
        '基准库 gold 上，删字表只改门为 65%→50%，配套加 log2(1+tf) 打分后为 70%；' +
        '形式取 log2(1+tf) 是为让重复次数边际收益递减，幅度未做扫描',
      scale: '20 条 gold 查询',
      at: '2026-10-17',
    }),
    display: 'IDF × log2(1+tf)（tf 为 1 时该因子恰为 1，条目退化成 v3 的纯 IDF）',
    definedBy: { file: 'src/pipeline/entries.ts', name: '内联（无常量名）' },
    affects: '抽取入口的打分：IDF（区分度）乘上词频项（证据强度），决定十六个槽位归谁',
    inline: {
      file: 'src/pipeline/entries.ts',
      source: 'Math.log((N - df + IDF_PRIOR) / (df + IDF_PRIOR) + 1) * Math.log2(1 + tf)',
    },
    variesWith: ['语料规模（短正文里 tf 的分布）', '每 atom 的入口配额', '上游切词规则'],
  },
  {
    name: 'BOUNDARY_FREEDOM（判据线，非数值常量）',
    area: '入口',
    ...recheckable(() => '是否「边界自由度为零」，无阈值数字', {
      tool: '无脚本（2026-10-17 实现报告与 T45 批三的等价探针，均未点名脚本路径）',
      finding:
        'gold 端到端去掉本判据重跑，20 条查询名次一模一样（判为不可分辨而非零贡献）；' +
        '反向差集核对无一例真词被误杀；「观测次数与 2 比较」改成「有没有第二次观测」' +
        '在本判据生效路径上逐条等价',
      scale: '20 条 gold 查询',
      at: '2026-10-17',
    }),
    display: '边界自由度为零即出局（判据线在零，没有可调数字）',
    definedBy: { file: 'src/pipeline/entries.ts', name: 'hasBoundaryFreedom' },
    constName: null,
    inline: { file: 'src/pipeline/entries.ts', source: 'function hasBoundaryFreedom(' },
    affects: '二字组与三字以上整段汉字的候选资格：左右邻汉字都只观测到一种取值、且两侧都有过重复观测，即出局',
    variesWith: ['语料规模（邻居观测的多少）', '上游切词规则', '语料语言'],
    diverges:
      '**已知不等价**：几何量放回了一批 v3 会挡的高频泛词（不是 / 一个 / 什么 / 需要 / 用户 / ' +
      '内容 / 问题…）——它们两侧都多样，几何量分不开。「这个词是不是词」与「这个词有没有主题' +
      '信息」是两个量，本判据只管前者',
  },
  {
    name: 'MIN_VOCAB_FOR_DF',
    area: '入口',
    ...recheckable(() => MIN_VOCAB_FOR_DF, {
      tool: '无脚本，按公式复算',
      finding:
        '可由 DF_FILTER_HALF_WIDTH(0.25) 与 DF_FILTER_CONFIDENCE_Z(1.96) 推出 —— 12 是使 p=0.5 处' +
        ' Wilson 95% 半宽 ≤ 0.25 的最小 n（n=11 约 0.254、n=12 约 0.246），与旧值逐位相同',
      formula: true,
      guardedBy: ['test/write.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'MIN_VOCAB_FOR_DF' },
    affects: '语料规模达到此值，泛词过滤（df/N > 0.5）才生效',
    display: () => `${MIN_VOCAB_FOR_DF}（= 使 p=0.5 处 Wilson 95% 半宽 ≤ ${DF_FILTER_HALF_WIDTH} 的最小 n）`,
    variesWith: ['每 atom 的入口配额（配额越小，泛词线越早需要生效）', '语料语言', '上游切词规则'],
  },
  {
    name: 'DF_FILTER_CONFIDENCE_Z',
    area: '入口',
    ...chosen(
      () => DF_FILTER_CONFIDENCE_Z,
      '95% 双侧正态分位是统计惯例，不是在本库上标定的值；它只用于把规模线换算成可复算的数，' +
        '不参与运行时判定',
    ),
    display: () => `${DF_FILTER_CONFIDENCE_Z}（95% 双侧）`,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'DF_FILTER_CONFIDENCE_Z' },
    affects: '推导 MIN_VOCAB_FOR_DF 时的置信水平；不参与运行时的过滤判定',
    variesWith: ['对规模线置信水平的要求'],
  },
  {
    name: 'DF_FILTER_HALF_WIDTH',
    area: '入口',
    ...chosen(
      () => DF_FILTER_HALF_WIDTH,
      '对 df/N 估计精度的要求：误差超过四分之一时「大约一半」与「大约四分之一」分不开。' +
        '取值是判断而不是语料标定',
    ),
    display: () => `${DF_FILTER_HALF_WIDTH}（四分之一个比例单位）`,
    definedBy: { file: 'src/pipeline/entries.ts', name: 'DF_FILTER_HALF_WIDTH' },
    affects: '推导 MIN_VOCAB_FOR_DF 时的精度要求；不参与运行时的过滤判定',
    variesWith: ['对 df/N 估计精度的要求'],
  },
  {
    name: 'MIN_TERM',
    area: '入口',
    ...chosen(
      () => MIN_TERM,
      '「二字词是中文检索的主力」这条设计判断；M1 B 类表只把它归为「汉语词长分布」，没有一次实测',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'MIN_TERM' },
    affects: '入口词元的长度下界（按码点）；低于它不参选',
    variesWith: ['上游切词规则（改成词级切分后长度含义会变）', '换成英文/日文语料'],
  },
  {
    name: 'MAX_TERM',
    area: '入口',
    ...chosen(
      () => MAX_TERM,
      '同 MIN_TERM：上界取汉语词长分布的常见上端，B 类表归为「汉语词长分布」，无实测记录',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'MAX_TERM' },
    affects: '入口词元的长度上界（按码点）；超过它不参选',
    variesWith: ['上游切词规则', '语料语言', '正文的书写粒度'],
  },
  {
    name: 'MAX_HAN_TERM',
    area: '入口',
    ...chosen(
      () => MAX_HAN_TERM,
      'D11-6 的理由是「真词里超过四字的极少」—— 定性判断，未做词长统计；整段连续汉字超过四字即出局',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'MAX_HAN_TERM' },
    affects: '整段连续汉字作为入口时的长度上限（超过四字即出局）；三字以上另需通过边界自由度判据（v4 起）',
    variesWith: ['语料语言', '正文的书写粒度（一句话讲一件事的实际长度）'],
  },
  {
    name: 'FRAGMENT_PENALTY',
    area: '入口',
    ...chosen(
      () => FRAGMENT_PENALTY,
      '系数幅度按「让碎片落到有真词可选的槽位之外、又不至于候选不足时把槽位空出来」这条要求取；' +
        '证据明写幅度是判断、不是扫描出来的。它引的标注测量测的是边界自由度判据的分开度，不是本系数',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'FRAGMENT_PENALTY' },
    affects:
      '边界自由度缺一侧的候选（疑似跨词边界碎片）得分乘以该系数；降权而非剔除（v4 起两侧都恒定的已直接出局）',
    variesWith: ['边界自由度判据本身的变化', '语料里真词与碎片的比例'],
    diverges:
      'M2 审核实测：单靠该降权**不足以把二字碎片挤出展示窗口**（审核报告「二字汉字碎片」一节）。' +
      'v4 因此把它上面的那档（两侧都恒定）改成硬判出局，本条只管「只剩一侧、或观测不足」的候选',
  },
  {
    name: 'ENTRY_WEIGHT',
    area: '入口',
    ...chosen(
      () => ENTRY_WEIGHT,
      '入口三级权重的相对高低（declared 全值、extracted 归一后按比例、learned 由召回反哺）：' +
        '三档怎么排是「级别越高越可信」这条设计决策，与语料无关，无实测记录',
      { guardedBy: ['test/entries-learned.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'ENTRY_WEIGHT' },
    affects: '入口权重的三级：declared 全值 / extracted 归一后按比例 / learned 由召回反哺',
    group: ['declared', 'extracted', 'learned'],
    variesWith: ['入口来源分级本身变化时（例如新增一级）'],
    diverges:
      '文档的四路权重是召回的 wVec/wEntry/wBody/wGraph，与本组不是一回事；' +
      '代码里 learned 一级写入侧不产生，仅由召回反哺',
  },
  {
    name: 'DEFAULT_MAX_EXTRACTED',
    area: '入口',
    ...recheckable(() => DEFAULT_MAX_EXTRACTED, {
      tool: '无脚本（2026-10-17 全库扫描与配对 bootstrap，未点名脚本路径）',
      finding:
        '纯 Entry 路 gold 召回 8 与 12 比 16 低 25 个百分点（95% 区间不含 0），16→32 只多 10 个百分点' +
        '（区间含 0），16 是收益拐点；端到端在 8~32 全区间不动；三种预算化形态都不优于固定 16',
      scale: '六点 + 四个补点的全库扫描（配对 bootstrap 4000 次）',
      at: '2026-10-17',
    }),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'DEFAULT_MAX_EXTRACTED' },
    affects: '每个 atom 抽取的入口数上限（declared 入口不参与这个竞争）',
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
    ...chosen(
      () => LEARNED_FEATURE_TERMS,
      '设计报告 §27「取 query 的 TF-IDF top-3 特征词」给定的个数，未在本库标定；' +
        '取几个特征词是反哺强度与噪声之间的取舍',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_FEATURE_TERMS' },
    affects: '一次召回反哺几个查询特征词（取 query 的 TF-IDF 前三，与写入侧同一套抽取规则）',
    variesWith: ['查询长度分布', '一次召回命中多少条 atom（乘数效应）', '冷启动阶段库还小、IDF 不稳'],
    design: { doc: DESIGN_DOC_T17, key: '反哺三步 · 第 1 条', default: 3 },
  },
  {
    name: 'MILLIS_PER_DAY',
    area: '入口',
    ...chosen(() => MILLIS_PER_DAY, '一天有多少毫秒是单位定义，不是取值选择；它不是测出来的，也不是选出来的'),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'MILLIS_PER_DAY' },
    affects: 'learned 的冷却与半衰期换算（本模块里唯一一处「天」到毫秒的换算）',
    variesWith: ['不随时间或语料变化'],
  },
  {
    name: 'LEARNED_COOLDOWN_HOURS',
    area: '入口',
    ...chosen(
      () => LEARNED_COOLDOWN_HOURS,
      '§27 防抖第 1 条「24 h 内只记 1 次」给的值，未在本库标定；' +
        '窗口多长是「重复同一问法算不算新证据」的取舍',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_COOLDOWN_HOURS' },
    affects: '冷却：同一（查询词, atom）在这个窗口内只记 1 次，重复查询不构成重复证据',
    variesWith: ['一次会话里重复同一问法的频率', '召回频次（低频库里冷却几乎不触发）'],
    design: { doc: DESIGN_DOC_T17, key: '防抖第 1 条（单位与代码一致，都是小时）', default: 24 },
  },
  {
    name: 'LEARNED_HALF_LIFE_DAYS',
    area: '入口',
    ...chosen(
      () => LEARNED_HALF_LIFE_DAYS,
      '§27 防抖第 2 条「90 天半衰期」给的值，未在本库标定；' +
        '半衰期取决于记忆的实际复用周期，要真实使用期才能测出',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_HALF_LIFE_DAYS' },
    affects: '遗忘与淘汰共用的证据强度 count_eff 的半衰期',
    variesWith: ['记忆的实际复用周期', '召回频次'],
    design: { doc: DESIGN_DOC_T17, key: '防抖第 2 条', default: 90 },
  },
  {
    name: 'LEARNED_FORGET_COUNT_EFF',
    area: '入口',
    ...chosen(
      () => LEARNED_FORGET_COUNT_EFF,
      '文档取 1.5、代码取 0.5：文档的 count 是实数累加，而 entry.hits 是 INTEGER NOT NULL，' +
        '没有第二列存小数；整数事件数下 1.5 会把 hits=1 的行写下即删，' +
        '0.5 是「整数计数下这条线唯一说得通的位置」，不是标定结果',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_FORGET_COUNT_EFF' },
    affects: '遗忘线：count_eff 低于它的 learned 行删除',
    variesWith: ['hits 的存储口径（若将来改成小数累加，这条线要按文档回到 1.5）', '召回频次'],
    design: {
      doc: DESIGN_DOC_T17,
      key: '防抖第 2 条（文档取 1.5，代码取 0.5，见 divergence）',
      default: 1.5,
    },
    divergence: {
      docValue: 1.5,
      note:
        '文档的 count 是实数累加，hits 是整数列 —— 这不是调参分歧，' +
        '是存储口径不一致导致同一个数字无法照抄',
    },
  },
  {
    name: 'LEARNED_MAX_PER_ATOM',
    area: '入口',
    ...chosen(
      () => LEARNED_MAX_PER_ATOM,
      '§27 防抖第 3 条「learned 入口 ≤ 12 条」给的值，未在本库标定；上限值本身是槽位额度的取舍',
      { guardedBy: ['test/entries-learned.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_MAX_PER_ATOM' },
    affects: '单 atom 的 learned 入口上限，超出按 count_eff 淘汰最低的',
    variesWith: [
      'extracted 入口上限（DEFAULT_MAX_EXTRACTED=16）—— 两者是同一批槽位的两半',
      '真实召回里「查询词不属于该 atom 已有入口」的比例（T17 探针实测这个比例很高，上限很少触发）',
    ],
    design: { doc: DESIGN_DOC_T17, key: '防抖第 3 条', default: 12 },
  },
  {
    name: 'LEARNED_GLOBAL_FACTOR',
    area: '入口',
    ...chosen(
      () => LEARNED_GLOBAL_FACTOR,
      '§27 防抖第 4 条「learned 总数 ≤ 5 × n_atoms」给的值，未在本库标定；随库增长的额度是反哺总量的取舍',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_GLOBAL_FACTOR' },
    affects: '全局 learned 上限 = 此系数 × 库里的 atom 数，超出按 count_eff 淘汰最低的',
    variesWith: ['库的 atom 数（这个上限随库增长，因此不是固定额度）'],
    design: { doc: DESIGN_DOC_T17, key: '防抖第 4 条', default: 5 },
  },
  {
    name: 'LEARNED_PROMOTE_COUNT',
    area: '入口',
    ...chosen(
      () => LEARNED_PROMOTE_COUNT,
      '§27 反哺三步第 3 条「count ≥ 5」给的值，未在本库标定；' +
        '升档线定在几次命中是「够了」的判断，低频库里几乎不会发生',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_PROMOTE_COUNT' },
    affects: '升档线：count_eff 到线且最近有命中时，learned 行的分值升到 extracted 档（0.6）',
    variesWith: [
      '冷却窗口（24 h）与整数计数：hits ≥ 5 意味着至少 5 个跨 24 h 的事件，即约 5~7 天的使用',
      '召回频次；低频库里升档几乎不会发生',
    ],
    design: { doc: DESIGN_DOC_T17, key: '反哺三步 · 第 3 条（文档的 count 也是实数累加）', default: 5 },
  },
  {
    name: 'LEARNED_PROMOTE_RECENT_DAYS',
    area: '入口',
    ...chosen(
      () => LEARNED_PROMOTE_RECENT_DAYS,
      '§27 第 3 条「30 天内出现 ≥ 2 次」的时间窗，未在本库标定；表里只有 hits 与 last_seen 两列，' +
        '只能守住「最近一次命中在窗口内」这半边，另半边要事件级时间戳',
    ),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_PROMOTE_RECENT_DAYS' },
    affects: '升档与**降档**的时间窗：最近一次命中超出这个窗口就不再够格，已升档的降回 0.3',
    variesWith: ['召回频次', '若将来给 entry 加一列「首次命中时间」，就能按文档实现完整的 30 天窗口'],
    design: { doc: DESIGN_DOC_T17, key: '反哺三步 · 第 3 条的「30 天内」', default: 30 },
    diverges:
      '**只实现了「最近一次命中在 30 天内」，没有实现「30 天内出现 ≥ 2 次」**：后者要事件级时间戳，' +
      '表里只有 hits 与 last_seen。这是收窄，不是放宽',
  },
  {
    name: 'LEARNED_PROMOTE_MAX_WEIGHT',
    area: '入口',
    ...recheckable(() => LEARNED_PROMOTE_MAX_WEIGHT, {
      tool: '无脚本，按字段读出',
      finding:
        '没有独立数字，值是 ENTRY_WEIGHT.extracted（0.6）—— `src/pipeline/entries.ts` 里' +
        ' `LEARNED_PROMOTE_MAX_WEIGHT` 的定义就是 `ENTRY_WEIGHT.extracted`，不另写一份 0.6',
      formula: true,
      guardedBy: ['test/entries-learned.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/entries.ts', name: 'LEARNED_PROMOTE_MAX_WEIGHT' },
    refs: [{ file: 'src/pipeline/entries.ts', symbol: 'LEARNED_PROMOTE_MAX_WEIGHT' }],
    affects: '升档能升到的分值上限 —— 取 ENTRY_WEIGHT.extracted，永不等于 declared 的 1.0',
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
    ...chosen(
      () => CHANNEL_WEIGHT,
      '四路 RRF 权重的相对高低（Entry 高于正文，理由是「入口冗余」原理）：' +
        'M1《按「跨机器是否一致」分类》A 类归为设计决策、与语料无关，无实测记录',
      { guardedBy: ['test/search.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/search.ts', name: 'CHANNEL_WEIGHT' },
    affects: 'RRF 融合时四路的权重（w / (RRF_K + rank)）',
    group: ['vec', 'entry', 'body', 'graph'],
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
    ...chosen(
      () => RRF_K,
      '60 是 RRF 的常用取值（算法惯例），无实测记录；' + '它压平头部排名垄断的程度由融合方式决定',
    ),
    definedBy: { file: 'src/pipeline/search.ts', name: 'RRF_K' },
    affects: 'RRF 融合常数：分越高越压平头部排名的垄断，让多路共识浮现',
    variesWith: ['换成别的融合方式时'],
    design: { doc: DESIGN_DOC, key: 'rrfK', default: 60, min: 10, max: 100 },
    diverges: '**zod schema 里没有它** —— 文档给了 10-100 的范围，运行时不生效、不可调',
  },
  {
    name: 'AFFILIATION',
    area: '召回融合',
    ...chosen(
      () => AFFILIATION,
      '主属高于仅次属、仅次属高于仅由图路引入，这组语义层级是设计给定的相对高低，无实测记录',
      { guardedBy: ['test/search.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/search.ts', name: 'AFFILIATION' },
    affects: '归属因子：主属命中的得分乘以这些系数（只由图路引入的最低）',
    group: ['primary', 'secondary', 'graphOnly'],
    variesWith: ['次属与图路引入的精度测量'],
    diverges:
      '设计报告里出现过 graph 权重 0.5，代码的 graphOnly 是 0.70 ——' +
      '两者不是同一个量，但不熟悉的人容易当成同一个',
  },
  {
    name: 'DEFAULT_SEED_COUNT',
    area: '召回融合',
    ...chosen(
      () => DEFAULT_SEED_COUNT,
      '图路用向量路的前多少条做种子：源码无注释、开发笔记里也没有这个数，是固定条数上的取舍，无测量',
    ),
    definedBy: { file: 'src/pipeline/search.ts', name: 'DEFAULT_SEED_COUNT' },
    affects: '图路用向量路的前多少条做种子（A.slice(0, DEFAULT_SEED_COUNT)）',
    variesWith: ['图路的边密度与精度', '库规模'],
  },
  {
    name: 'K_VEC',
    area: '召回融合',
    ...chosen(
      () => K_VEC,
      '向量路进融合的固定条数上限：随库规模变化、实际约束的是召回质量而不是性能，无记录、无实测；' +
        '取多少是固定上限的取舍',
    ),
    definedBy: { file: 'src/pipeline/search.ts', name: 'K_VEC' },
    affects: '向量路取多少条进融合（向量粗筛的宽度）',
    variesWith: ['库规模（库长大时固定取前 N 会让召回质量悄悄退化）'],
    diverges: '**zod schema 里也没有** —— 固定上限改预算制是 T45 批二（与 T40 合并）',
  },
  {
    name: 'K_LEX',
    area: '召回融合',
    ...chosen(
      () => K_LEX,
      '与 K_VEC 同一次盘点、同一类：词面两路各取多少条进融合，无记录、无实测；固定上限随库规模漂移',
    ),
    definedBy: { file: 'src/pipeline/search.ts', name: 'K_LEX' },
    affects: '词面两路（Entry 与正文）各取多少条进融合',
    variesWith: ['库规模', '中文 bigram 的候选密度'],
    diverges: '**zod schema 里也没有**',
  },
  {
    name: 'K_GRAPH',
    area: '召回融合',
    ...chosen(
      () => K_GRAPH,
      '图路一跳取多少条进融合是容量分配，没有测量过程能给出这个数；与 K_VEC 同一次盘点、同一类，无实测',
    ),
    definedBy: { file: 'src/pipeline/search.ts', name: 'K_GRAPH' },
    affects: '图路一跳扩展取多少条进融合（与 OUT_DEGREE_CAP 分工：那条限每个种子的出度，这条限总量）',
    variesWith: ['图路的边密度', '库规模'],
    diverges: '**zod schema 里也没有**',
  },
  {
    name: 'RECALL_TOP_N',
    area: '召回融合',
    ...chosen(
      () => RECALL_TOP_N,
      '24 只在调用方不传 topN 时起作用，生产路径实际生效的是配置项 topN（zod 默认 24）；' +
        '默认条数是容量选择，没有测量给出它',
    ),
    definedBy: { file: 'src/pipeline/search.ts', name: 'RECALL_TOP_N' },
    affects: '召回交给注入层的默认条数（调用方不传 topN 时用它）',
    variesWith: ['注入字符预算', '一次注入能容纳的摘要条数'],
    design: { doc: DESIGN_DOC, key: 'topN', default: 24, min: 5, max: 50 },
    zod: { file: 'src/index.ts', name: 'topN' },
    diverges:
      '**与 DEFAULT_TOP_N 同为 24、不同量**（T45 批一判定为恰好同值，不合并）：那个是落位时取多少' +
      '个 topic 候选，这个是召回交注入层的条数。设计文档 §7 的 topN 指后者',
  },
  {
    name: 'MAX_QUERY_TERMS',
    area: '召回融合',
    ...chosen(
      () => MAX_QUERY_TERMS,
      '单路最多用多少词进 FTS 查询是判断：长查询切出的 bigram 会很多，超出部分区分度也低；' +
        'M1 把它归为「中文 bigram 的候选密度」，但无实测',
    ),
    definedBy: { file: 'src/pipeline/search.ts', name: 'MAX_QUERY_TERMS' },
    affects: '单路最多用多少个词进 FTS 查询',
    variesWith: ['库规模', '查询长度分布', '中文 bigram 的候选密度'],
    diverges: 'M1 已把它列为「按实际候选数取、用 FTS5 查询复杂度上限兜底」的待办项，未做',
  },
  {
    name: 'DUP_COS',
    area: '重排去重',
    ...chosen(
      () => DUP_COS,
      '0.92 沿用原设计 atom_pair 表的既有取值，改成词面判定后没有重测；' +
        '没有一次「不同说法的同一件事」实测（DUP_LEX 才有）。几何票的门槛是旧接口留下的数',
      { guardedBy: ['test/archive.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/search.ts', name: 'DUP_COS' },
    affects: '重复压制：余弦低于此值即不判重复（两票中的几何票）；仅在同主属 topic 桶内两两比较',
    variesWith: ['换编码模型（余弦尺度会变）', '同义改写的相似度分布'],
  },
  {
    name: 'DUP_LEX',
    area: '重排去重',
    ...recheckable(() => DUP_LEX, {
      tool: '无脚本（构造的对照句对，直接算 bigram-Jaccard）',
      finding:
        '0.5 时「系统代理必须走本地端口……」与「系统代理配置本地端口……」的 bigram-Jaccard 为 0.64，' +
        '两者讲同一件事但各有信息、不该折叠；取 0.72 后只有几乎逐字重复才被压制（同一段文本 Jaccard 为 1.0）',
      guardedBy: ['test/archive.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/search.ts', name: 'DUP_LEX' },
    affects: '重复压制：词面重叠低于此值即不判重复（两票中的词面票）',
    variesWith: ['语料语言与书写粒度', '摘要长度（词面 Jaccard 对短文本更敏感）'],
  },
  // ────────────────────────────── 注入（view.ts）───────────────────────────────
  {
    name: 'SEGMENT_RATIO',
    area: '注入',
    ...chosen(
      () => SEGMENT_RATIO,
      '锚决定回答质量，路只提供线索 —— 理由完整，但没有实测记录（未做过不同配比下的召回质量对比）；' +
        '0.55 / 0.2 / 0.25 是配比选择',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'SEGMENT_RATIO' },
    affects: '三段字符配额的占比（锚 / 入口 / 路），三段之和为 1',
    group: ['anchors', 'entries', 'paths'],
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
    ...chosen(
      () => MIN_ANCHORS,
      '保底锚条数是「低相关只给入口段」与降噪彻底程度之间的取舍，最后选了分档方案；3 这个数本身没有实测标定',
      { guardedBy: ['test/view.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'MIN_ANCHORS' },
    affects: '锚段保底条数：预算再紧也先给这么多条；同时是摘录档的锚上限',
    variesWith: ['无关查询的容忍度（保底越高，降噪越不彻底）', '一次注入的字符预算'],
  },
  {
    name: 'TRIM_ORDER',
    area: '注入',
    ...chosen(
      () => TRIM_ORDER.join(' -> '),
      '这个数组是行为契约，顺序的理由是设计不变量「锚不为其他段让路」，不是标定结果；没有测量能给出裁剪顺序',
      { guardedBy: ['test/view.test.mjs'] },
    ),
    display: 'paths->5 -> entries->4 -> anchors->summary -> paths->0 -> anchors->3',
    definedBy: { file: 'src/pipeline/view.ts', name: 'TRIM_ORDER' },
    affects: '超预算时的裁剪顺序（路 -> 入口 -> 锚降级 -> 路清零 -> 锚减量）',
    variesWith: ['三段分工本身变化时（例如新增一段）'],
    diverges:
      '**zod schema 里也没有**。它按字符串而非数值登记：' + '列在此处的目的是让「行为契约级常量」不被漏掉',
  },
  {
    name: 'TIER_FULL_MIN',
    area: '注入',
    ...recheckable(() => TIER_FULL_MIN, {
      tool: '无脚本（D15-2 标定，未点名脚本路径）',
      finding:
        '相关 top1 min 0.524 / p50 0.683，无关 top1 max 0.398，两类之间是空的；取空隙中间只为容错，不是为了拟合',
      scale: '20 条 gold 查询 + 4 条无关查询',
      guardedBy: ['test/calibrate.test.mjs', 'test/view.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/view.ts', name: 'TIER_FULL_MIN' },
    affects: 'tierOf：最高余弦 >= 此值走完整档（三段全给）',
    variesWith: ['换编码模型（余弦尺度直接变）', '库规模与来源分布', '语料的领域混合度'],
    diverges:
      '**标定语料与运行库不一致**：标定在基准库上，而插件跑在宿主库上（M2 审核指出的同一类问题）。' +
      '本表不再记语料规模与来源分布 —— 是否仍适用，看对应重标报告；没有报告时按「无记录」处理，不猜',
  },
  {
    name: 'TIER_BRIEF_MIN',
    area: '注入',
    ...recheckable(() => TIER_BRIEF_MIN, {
      tool: '无脚本（D15-2 与 2026-10-17 重标定，均未点名脚本路径）',
      finding:
        '两段来历：① 原标定无关上界 0.398、相关下界 0.524，0.45 夹在中间；' +
        '② 2026-10-17 重标定在扩容后的基准库上，无关 top1 上界升到 0.515、相关下界 0.525，0.45 落进无关分布内部，故降级为默认值（生效值改由 calib 锚点表按规模给出），扫描读数 0.466 / 0.470 / 0.492 / 0.514 / 0.514 / 0.514 / 0.514 / 0.525；' +
        '2026-10-18 复核：24 条无关查询、1 次误通过时 conformal 可认证上限 (1+1)/(24+1)=8.0%，Clopper-Pearson 95% 区间 [0.11%, 21.12%]',
      scale: '原标定 20 gold + 4 无关；重标定 8 个规模点各 30 次降采样、20 gold + 20 无关',
      at: '2026-10-17',
      guardedBy: ['test/calibrate.test.mjs', 'test/view.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/view.ts', name: 'TIER_BRIEF_MIN' },
    refs: [{ file: 'src/tools/index.ts', symbol: 'LOW_RELEVANCE_HINT' }],
    affects:
      '库小于锚点表下端时的**默认**精简档下界；库 >= 12 条时生效值由 calib 的锚点表按规模给出，' +
      '本常量不再等于生效值。它同时仍是弱相关提示线 LOW_RELEVANCE_HINT 的取值来源',
    variesWith: ['换编码模型', '库规模（生效值随规模变，本常量不再等于生效值）', '语料的领域混合度'],
    diverges:
      '**标定语料与运行库不一致**（同 TIER_FULL_MIN），且真机语料上相关/无关两组重叠。' +
      '重标定已把生效值改成规模的函数（本次），但**弱相关提示线 LOW_RELEVANCE_HINT 仍是这个常数**' +
      '（`src/tools/index.ts` 的 `LOW_RELEVANCE_HINT` 直接引用它）—— 工具层不在本次改动边界内，两处暂时分叉，见实现报告的未确定项。' +
      '本表不记语料规模与来源分布；是否仍适用看对应重标报告，没有报告时按「无记录」处理',
  },
  {
    name: 'TIER_SCALE_MIN_ATOMS',
    area: '注入',
    ...chosen(
      () => TIER_SCALE_MIN_ATOMS,
      '锚点表最下端取 12 条：它是降采样实验的最小规模点，不是标定出来的最优规模；比它更小的库没有任何测量，按项目约定退回旧值 —— 这个数来自实验设计与样本下限，不是测量结果',
      { guardedBy: ['test/calibrate.test.mjs'] },
    ),
    external: { pkg: 'lattice-calib', file: 'src/anchors.ts' },
    affects: 'briefMinFor：库小于此规模时不做按规模标定，退回 TIER_BRIEF_MIN（= 0.45）',
    variesWith: ['锚点表下端的规模点变化时'],
  },
  {
    name: 'TIER_SCALE_STABLE_ATOMS',
    area: '注入',
    ...recheckable(() => TIER_SCALE_STABLE_ATOMS, {
      tool: '无脚本（calib@0.1.0 重标定，未点名脚本路径）',
      finding:
        '判据是相关查询 p10 与无关查询 p95 的距离 ≥ 0.05，且在按 replicate 聚类的 1000 次重抽样里至少 80% 满足，得 192；这是本次那个查询集上的结论，不是语料无关的常数',
      scale: '20 条相关 + 20 条无关查询',
      at: '2026-10-17',
    }),
    external: { pkg: 'lattice-calib', file: 'src/anchors.ts' },
    affects: '只用于可观测：低于此规模时，按规模插值出的阈值不可信（调用方据此区分标定值与插值值）',
    variesWith: ['查询集（20 相关 + 20 无关是人工挑的）', '语料构成'],
  },
  {
    name: 'TIER_SCALE_ANCHORS',
    area: '注入',
    ...recheckable(() => TIER_SCALE_ANCHORS.map((a) => a.atoms + '→' + a.briefMin).join(' / '), {
      tool: '无脚本（calib@0.1.0 重标定，未点名脚本路径）',
      finding:
        '每个规模点 30 次独立降采样，相关与无关样本各自合成池后扫「相关通过率 − 无关通过率」最大的切点，表里每个数都是该点实测到的切点、不是拟合值；' +
        '2026-10-18 复核：30 次重复的 95% 区间宽在 12 / 24 / 48 / 96 为 0.070 / 0.061 / 0.043 / 0.023，表内 7 个点在噪声内彼此不可区分',
      scale: '20 条 gold + 20 条人工无关查询；7 个规模点各 30 次独立降采样',
      at: '2026-10-17',
      guardedBy: ['test/calibrate.test.mjs'],
    }),
    external: { pkg: 'lattice-calib', file: 'src/anchors.ts' },
    affects: 'briefMinFor：按库规模给出精简档下界；点与点在 log2(atom 数) 尺度上线性插值，两端夹紧（不外推）',
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
    ...recheckable(() => TIER_BRIEF_MIN, {
      tool: '无脚本（D15-4 / D15-5 的实测，未点名脚本路径）',
      finding:
        '原值 0.68 永不触发：gold 集 top1 中位数就有 0.683 ——「一个永不触发的提示与没有提示是一回事，却看起来还在工作」；' +
        '改为与摘录档下界同源（= TIER_BRIEF_MIN），理由是两者回答同一个问题：「这次的匹配算不算相关」。标定约束落在 0.398 与 0.524 之间',
      scale: '同 D15-2：20 条 gold + 4 条无关查询',
      guardedBy: ['test/tools.test.mjs'],
    }),
    definedBy: { file: 'src/tools/index.ts', name: 'LOW_RELEVANCE_HINT' },
    refs: [{ file: 'src/tools/index.ts', symbol: 'LOW_RELEVANCE_HINT' }],
    affects: 'isWeakMatch：低于此值在召回结果前标一句「可能不相关」（只提示不拦截）',
    variesWith: ['TIER_BRIEF_MIN 改动时（它是别名，不是独立取值）', '换编码模型'],
    otherSites: [
      '`src/tools/index.ts` 的 `LOW_RELEVANCE_HINT` = TIER_BRIEF_MIN —— 不是自己的数，与摘录档同源',
    ],
  },
  {
    name: 'DEFAULT_BUDGET',
    area: '注入',
    ...chosen(
      () => DEFAULT_BUDGET,
      '注入字符预算是容量选择：只有设计文档 §7 给了默认值 6000 与范围 1000–20000，没有标定依据',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEFAULT_BUDGET' },
    affects: '注入字符预算的默认值（工具调用可覆盖）',
    variesWith: ['模型上下文窗口', '一次注入里锚段的平均长度'],
    design: { doc: DESIGN_DOC, key: 'viewBudget', default: 6000, min: 1000, max: 20000 },
    zod: { file: 'src/index.ts', name: 'viewBudget' },
    diverges:
      '**同一个默认值写了三遍**：view.ts 的 DEFAULT_BUDGET、zod 的 .default(6000)、index.ts 的 `?? 6000`。' +
      '三处目前一致',
  },
  {
    name: 'DEFAULT_ANCHOR_MAX',
    area: '注入',
    ...chosen(
      () => DEFAULT_ANCHOR_MAX,
      '单条锚的字符上限是显示容量选择：源码无注释，设计文档 §7 也没有这个键',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEFAULT_ANCHOR_MAX' },
    affects: '单条锚的字符上限（全文很长时截断，避免一条吃掉整段）',
    variesWith: ['atom 正文长度分布', '字符预算'],
    diverges: '**zod schema 里也没有** —— 运行时不可配置',
  },
  {
    name: 'DEFAULT_ENTRIES_PER_TOPIC',
    area: '注入',
    ...recheckable(() => DEFAULT_ENTRIES_PER_TOPIC, {
      tool: '源码表达式（src/pipeline/view.ts 的 `DEFAULT_MAX_EXTRACTED / 2`）',
      finding: '由 DEFAULT_MAX_EXTRACTED(16) ÷ 2 算出 8；改输入后重新构建，派生值跟着变，不需要测量',
      formula: true,
    }),
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEFAULT_ENTRIES_PER_TOPIC' },
    affects: '每个命中主题给几条入口（摘录档由 TIER_ENTRIES 收窄到 4）',
    variesWith: ['DEFAULT_MAX_EXTRACTED 改动时（同一件事的两个端点）', '主题数'],
  },
  {
    name: 'DEFAULT_ENTRY_LINE_MAX',
    area: '注入',
    ...chosen(
      () => DEFAULT_ENTRY_LINE_MAX,
      '单行入口的字符上限是显示判断：源码无注释，设计文档与 zod 里都没有这个键',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEFAULT_ENTRY_LINE_MAX' },
    affects: '单个主题的入口行字符上限（防止一行过长挤占锚段）',
    variesWith: ['入口词的长度分布', '每主题入口条数'],
    diverges: '**zod schema 里也没有**',
  },
  {
    name: 'DEFAULT_PATH_LINES',
    area: '注入',
    ...chosen(
      () => DEFAULT_PATH_LINES,
      '路段整体行数上限是容量选择：源码无注释，TRIM_ORDER 里的 5 与它是什么关系也没有写明',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEFAULT_PATH_LINES' },
    affects: '路段整体行数上限（裁剪顺序里会先降到 5、再清零）',
    variesWith: ['一跳关联的平均条数', '字符预算'],
  },
  {
    name: 'TIER_ANCHOR_CAP',
    area: '注入',
    ...chosen(
      () => ({ full: Number.POSITIVE_INFINITY, brief: 8, excerpt: MIN_ANCHORS }),
      '分档设计决定：完整档不限（预算机制已管住总量）、精简档 8、摘录档取 MIN_ANCHORS；无实测记录，' +
        'brief=8 与 DEFAULT_ENTRIES_PER_TOPIC 同值也未说明是巧合还是有意',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'TIER_ANCHOR_CAP' },
    affects: '各档的锚条数上限（完整档不设上限，交给预算管）',
    group: ['full', 'brief', 'excerpt'],
    variesWith: ['各档的字符预算', 'MIN_ANCHORS 改动时（摘录档上限跟着走）'],
  },
  {
    name: 'TIER_ENTRIES',
    area: '注入',
    ...chosen(
      () => ({ full: 8, brief: 8, excerpt: 4 }),
      'D15-3「低相关时入口段是主角，但也要收窄」—— 各档每个主题给几条入口是设计判断，无实测记录',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'TIER_ENTRIES' },
    refs: [{ file: 'src/pipeline/view.ts', symbol: 'TIER_ENTRIES' }],
    affects: '各档每个主题给几条入口（只有摘录档收窄）',
    group: ['full', 'brief', 'excerpt'],
    variesWith: ['入口段在各档里的实际贡献'],
    diverges:
      '**值在代码里是字面量而不是引用常量**（`src/pipeline/view.ts` 的 `TIER_ENTRIES` 直接写 8 / 8 / 4），' +
      '与 DEFAULT_ENTRIES_PER_TOPIC 形成第二份同一个数',
  },
  {
    name: 'PATH_SUMMARY_CHARS',
    area: '注入',
    ...chosen(
      () => PATH_SUMMARY_CHARS,
      '路段每行摘要截断 20 个词是显示判断，不是标定结果：路只提供线索，锚是正文、降级锚是空间不足时的短摘要，' +
        '三个截断分属不同角色，不合并',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'PATH_SUMMARY_CHARS' },
    affects: '路段每行摘要的截断长度：20 个词',
    variesWith: ['路段在注入里的角色（纯线索）'],
  },
  {
    name: 'ANCHOR_SUMMARY_CHARS',
    area: '注入',
    ...chosen(
      () => ANCHOR_SUMMARY_CHARS,
      '锚段降级为摘要时的截断 16 个词是显示判断，不是标定结果；上游是 extractSummary 的 48',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'ANCHOR_SUMMARY_CHARS' },
    affects: '锚段降级为摘要时的截断长度：16 个词（st.anchorToSummary 分支）',
    variesWith: ['摘要长度分布（extractSummary 的 48 是它的上游）'],
  },
  {
    name: 'DEMOTED_ANCHOR_CHARS',
    area: '注入',
    ...chosen(
      () => DEMOTED_ANCHOR_CHARS,
      '空间不足时把锚降级为短摘要的截断 15 个词是显示判断，不是标定结果；与 16 词那条只差 1 个词、分属不同分支，' +
        '属「恰好近似」不是同源',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'DEMOTED_ANCHOR_CHARS' },
    affects: '空间不足时把锚降级为短摘要所截断的长度：15 个词（与 16 词那条是两条不同分支）',
    variesWith: ['同上；这个值更像历史遗留'],
  },
  // ENTRY_LABEL_CHARS 已并入 TOPIC_LABEL_CHARS（同一个量：主题标签的宽度），
  // 见「落位」一节的 TOPIC_LABEL_CHARS 行。
  {
    name: 'TRIM_PATHS_LIMIT',
    area: '注入',
    ...chosen(
      () => TRIM_PATHS_LIMIT,
      '超预算后路段先降到多少是裁剪策略选择：TRIM_ORDER 的名字里带着 5、但 5 从哪来没有出处；' +
        '它与 DEFAULT_PATH_LINES(15) 不是同一个量',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'TRIM_PATHS_LIMIT' },
    affects: '裁剪第一步把路段行数上限压到的值（TRIM_ORDER 的 paths->5）',
    variesWith: ['TRIM_ORDER 改动时（名字与值必须同步）'],
  },
  // ────────────────────────────── 目录（list.ts）───────────────────────────────
  {
    name: 'LIST_MAX_LIMIT',
    area: '目录',
    ...chosen(
      () => LIST_MAX_LIMIT,
      '上限是硬边界、防止调用方一次拉空整个库（D13-1）：50 本身无实测记录，' +
        '它约束的是注意力稀释，不是某个分布',
      { guardedBy: ['test/list.test.mjs', 'test/audit.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/list.ts', name: 'LIST_MAX_LIMIT' },
    affects: '一页最多给多少条；请求值被强制钳制到 [1, 50]',
    variesWith: ['一次注入能容纳的摘要条数', '库规模'],
    diverges: '**zod schema 里也没有**（工具侧有测试守着钳制行为）',
  },
  {
    name: 'LIST_DEFAULT_LIMIT',
    area: '目录',
    ...chosen(
      () => LIST_DEFAULT_LIMIT,
      '`src/pipeline/list.ts` 的 `LIST_DEFAULT_LIMIT` 注释「取值偏小：列目录是为了定位，不是为了读完」：默认页大小是使用偏好选择，' +
        '不是标定结果',
      { guardedBy: ['test/list.test.mjs', 'test/audit.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/list.ts', name: 'LIST_DEFAULT_LIMIT' },
    refs: [{ file: 'src/pipeline/list.ts', symbol: 'LIST_DEFAULT_LIMIT' }],
    affects: '默认页大小',
    variesWith: ['同上'],
  },
  // ────────────────────── 迁移切分（migrate/split.ts）─────────────────────────
  {
    name: 'MIN_ATOM_CHARS',
    area: '迁移切分',
    ...chosen(
      () => MIN_ATOM_CHARS,
      '无记录，源码也无注释：切分时一条 atom 的最小字符数是脚本取舍；它只影响一次性迁移脚本' +
        '（本机卡片导入），不参与运行时管线',
      { guardedBy: ['test/migrate.test.mjs'] },
    ),
    definedBy: { file: 'src/migrate/split.ts', name: 'MIN_ATOM_CHARS' },
    affects: '切分时一条 atom 的最小字符数（低于它不再切）',
    variesWith: ['「一句话讲一件事」这条写入约定的实际长度'],
    diverges: '文档的 autoSplit 是一期关闭的配置项',
  },
  {
    name: 'MAX_ATOM_CHARS',
    area: '迁移切分',
    ...chosen(
      () => MAX_ATOM_CHARS,
      '无记录（同 MIN_ATOM_CHARS）：切分时一条 atom 的最大字符数是 FTS 索引体积与落位质量' +
        '之间的取舍，没有测量给出它',
      { guardedBy: ['test/migrate.test.mjs'] },
    ),
    definedBy: { file: 'src/migrate/split.ts', name: 'MAX_ATOM_CHARS' },
    affects: '切分时一条 atom 的最大字符数（超过即按句子再切）',
    variesWith: ['同上'],
  },
  // ───────────────── 写入侧审核（pipeline/review.ts，M3-T22）─────────────────
  {
    name: 'REVIEW_MIN_CHARS',
    area: '写入',
    ...recheckable(() => REVIEW_MIN_CHARS, {
      tool: '无脚本（一次分布核对，未点名脚本路径）',
      finding:
        '**不是标定值，是一次分布核对**：基准库正文字符数分布里低于 20 字的只有 2 条（0.15%），且两条都是 `---` 这种不可能被召回的空壳；第 3 短的一条（29 字）已是一句完整结论。' +
        '真机库 2026-10-17 现取 14 条、最短 81 字，样本量不足以定下界。依据是「在基准库上只抓空壳」+「一句合法中文结论的下界约 15 字」，不是运行语料上的标定；刻意不复用 MIN_ATOM_CHARS(80)',
      scale: '基准库 1374 条 atom（真机库 14 条）',
      at: '2026-10-17',
      guardedBy: ['test/review.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_MIN_CHARS' },
    affects: '写入侧审核「自动处理·过短」：正文短于它的写入被拦下、不落库',
    variesWith: ['「一句话讲一件事」这条写入约定的实际长度分布', '语言', '正文里是否允许单句参数'],
    diverges: '`lattice_write` 的入参契约里也没有这条下限',
  },
  {
    name: 'REVIEW_MAX_CHARS',
    area: '写入',
    ...chosen(
      () => REVIEW_MAX_CHARS,
      '它直接引用 migrate/split.ts 的 MAX_ATOM_CHARS，是同一个数、同一个界；该界本身无标定记录（两条路径受同一组约束：FTS 索引体积、落位会被平均掉），没有测量给出它',
      { guardedBy: ['test/migrate.test.mjs', 'test/review.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_MAX_CHARS' },
    affects: '写入侧审核「自动处理·过长」：正文长于它的写入按句自动切分后分别写入',
    variesWith: ['同 MAX_ATOM_CHARS（atom 正文长度分布、FTS 索引体积、落位质量）'],
    constName: null,
    otherSites: ['src/migrate/split.ts 的 MAX_ATOM_CHARS 是它的真相源'],
  },
  {
    name: 'REVIEW_MAX_SEGMENTS',
    area: '写入',
    ...recheckable(() => REVIEW_MAX_SEGMENTS, {
      tool: '源码表达式（src/pipeline/review.ts 的 `REVIEW_WRITE_BUDGET_MS / REVIEW_SEGMENT_MS`）',
      finding:
        '由 REVIEW_WRITE_BUDGET_MS ÷ REVIEW_SEGMENT_MS 算出 8；改输入后重新构建，派生值跟着变。旧口径「一条记忆里不该装着 8 件以上的事」与时间预算给出同一个整数',
      formula: true,
      guardedBy: ['test/review.test.mjs'],
    }),
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_MAX_SEGMENTS' },
    affects: '一次写入最多自动切成多少条；超过则整条不写入，交回调用方自己拆',
    display: () =>
      `${REVIEW_MAX_SEGMENTS}（= 写入预算 ${REVIEW_WRITE_BUDGET_MS} ms ÷ 单段实测 ${REVIEW_SEGMENT_MS} ms）`,
    variesWith: ['单段写入耗时（编码器与词表重建）', '一次工具调用的时延预算'],
  },
  {
    name: 'REVIEW_SCAN_LIMIT',
    area: '写入',
    ...recheckable(() => REVIEW_SCAN_LIMIT, {
      tool: '源码表达式（src/pipeline/review.ts 的 `REVIEW_SCAN_BUDGET_MS / REVIEW_MEMBER_SCAN_MS`）',
      finding:
        '由 REVIEW_SCAN_BUDGET_MS ÷ REVIEW_MEMBER_SCAN_MS 算出 200；改输入后重新构建，派生值跟着变。旧口径「200 条足以覆盖同一主题下的近期成员」与时间预算给出同一个整数',
      formula: true,
    }),
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_SCAN_LIMIT' },
    affects: '重复 / 高相似检测一次最多比多少个同主题成员（**只读，不写库**）',
    display: () =>
      `${REVIEW_SCAN_LIMIT}（= 扫描预算 ${REVIEW_SCAN_BUDGET_MS} ms ÷ 单条实测 ${REVIEW_MEMBER_SCAN_MS} ms）`,
    variesWith: ['单个主题的成员数分布', 'atom 正文的平均长度'],
  },
  {
    name: 'REVIEW_WRITE_BUDGET_MS',
    area: '写入',
    ...chosen(
      () => REVIEW_WRITE_BUDGET_MS,
      '产品侧时延预算，不是语料标定：一次工具调用最多花 1 秒，没有实测出处，取值是判断；只用来换算切分段数上限',
    ),
    display: () => `${REVIEW_WRITE_BUDGET_MS} ms`,
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_WRITE_BUDGET_MS' },
    affects: '一次写入（切分 + 逐段落库）的时间预算；只用来换算切分段数上限',
    variesWith: ['宿主对一次工具调用的时延预期'],
  },
  {
    name: 'REVIEW_SEGMENT_MS',
    area: '写入',
    ...recheckable(() => REVIEW_SEGMENT_MS, {
      tool: '无脚本（本机实测，未点名脚本路径）',
      finding:
        '8 次单段写入耗时 111–148 ms（每段含一次编码与一次全量词表重建，后者约 113 ms），取 125 ms；换机器或库规模会变，届时上限自动跟着变',
      scale: '1374 条 atom 的库副本，8 次单段写入',
      at: '2026-10-18',
    }),
    display: () => `${REVIEW_SEGMENT_MS} ms（本机实测的单段写入耗时）`,
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_SEGMENT_MS' },
    affects: '把写入预算换算成段数：1000 / 125 = 8',
    variesWith: ['编码器速度', '词表重建耗时（库规模）'],
  },
  {
    name: 'REVIEW_SCAN_BUDGET_MS',
    area: '写入',
    ...chosen(
      () => REVIEW_SCAN_BUDGET_MS,
      '产品侧时延预算，不是语料标定：重复检测加在每次写入上，只给它 10 ms，是判断；只用来换算一次比对多少条成员',
    ),
    display: () => `${REVIEW_SCAN_BUDGET_MS} ms`,
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_SCAN_BUDGET_MS' },
    affects: '重复检测的时间预算；只用来换算一次比对多少条成员',
    variesWith: ['宿主对一次工具调用的时延预期'],
  },
  {
    name: 'REVIEW_MEMBER_SCAN_MS',
    area: '写入',
    ...recheckable(() => REVIEW_MEMBER_SCAN_MS, {
      tool: '无脚本（本机实测，未点名脚本路径）',
      finding:
        '在基准库最大主题上 findDuplicate 单次 1.663 ms、均摊 0.045 ms/条；纯比对循环（bigram-Jaccard + 512 维余弦）0.038 ms/条；取 0.05（向上取整，宁可少扫）',
      scale: '基准库最大主题 37 个成员',
      at: '2026-10-18',
    }),
    display: () => `${REVIEW_MEMBER_SCAN_MS} ms（本机实测的单条比对耗时，向上取整）`,
    definedBy: { file: 'src/pipeline/review.ts', name: 'REVIEW_MEMBER_SCAN_MS' },
    affects: '把扫描预算换算成条数：10 / 0.05 = 200',
    variesWith: ['成员正文长度', '向量维度'],
  },
  // ──────────────────────── 资源参数（util/memory.ts）─────────────────────────
  {
    name: 'MMAP_LIMIT_BYTES',
    area: '资源',
    ...chosen(
      () => MMAP_LIMIT_BYTES,
      '本机推导规则的上限、不是标定值：256 MB 是写死的上限，与「内存的八分之一」取更小者；' +
        '上限本身是容量选择',
      { guardedBy: ['test/memory.test.mjs'] },
    ),
    display: () =>
      `${displayNumber(MMAP_LIMIT_BYTES / 1024 / 1024)} MB（上限，与「内存的八分之一」取更小者）`,
    definedBy: { file: 'src/util/memory.ts', name: 'MMAP_LIMIT_BYTES' },
    affects: 'mmap 窗口上限',
    variesWith: ['机器内存', '库文件大小'],
    diverges: '**已从常量改成推导值**（M1 待办一第 2、3 项），但仍是一个写死的上限',
  },
  {
    name: 'MMAP_FLOOR_BYTES',
    area: '资源',
    ...chosen(
      () => MMAP_FLOOR_BYTES,
      '库很小时也至少给这么多的下限是容量选择；与上限同处的 1.5 倍 / 八分之一 / 64 MB 三个数都没有出处',
      { guardedBy: ['test/memory.test.mjs'] },
    ),
    display: () => `${displayNumber(MMAP_FLOOR_BYTES / 1024 / 1024)} MB（下限）`,
    definedBy: { file: 'src/util/memory.ts', name: 'MMAP_FLOOR_BYTES' },
    affects: 'mmap 窗口下限（库很小时也至少给这么多）',
    variesWith: ['机器内存'],
  },
  {
    name: 'CACHE_RATIO',
    area: '资源',
    ...chosen(
      () => CACHE_RATIO,
      '页缓存占内存多少是取舍：SQLite 默认只有 2 MB，对万级 atom 偏小，也不能无上限；5% 没有实测依据',
    ),
    display: () => `内存的 ${displayNumber(CACHE_RATIO * 100)}%`,
    definedBy: { file: 'src/util/memory.ts', name: 'CACHE_RATIO' },
    affects: 'SQLite 页缓存目标大小（内存 × 5%）',
    variesWith: ['机器内存', '库的访问模式'],
  },
  {
    name: 'CACHE_FLOOR_BYTES',
    area: '资源',
    ...chosen(() => CACHE_FLOOR_BYTES, '页缓存下限是容量选择，无记录（同 CACHE_RATIO）', {
      guardedBy: ['test/memory.test.mjs'],
    }),
    display: () => `${displayNumber(CACHE_FLOOR_BYTES / 1024 / 1024)} MB`,
    definedBy: { file: 'src/util/memory.ts', name: 'CACHE_FLOOR_BYTES' },
    affects: '页缓存下限',
    variesWith: ['机器内存'],
  },
  {
    name: 'CACHE_CEIL_BYTES',
    area: '资源',
    ...chosen(() => CACHE_CEIL_BYTES, '页缓存上限是容量选择，无记录（同 CACHE_RATIO）', {
      guardedBy: ['test/memory.test.mjs'],
    }),
    display: () => `${displayNumber(CACHE_CEIL_BYTES / 1024 / 1024)} MB`,
    definedBy: { file: 'src/util/memory.ts', name: 'CACHE_CEIL_BYTES' },
    affects: '页缓存上限',
    variesWith: ['机器内存'],
  },
  {
    name: 'BUSY_TIMEOUT_FLOOR_MS',
    area: '资源',
    ...chosen(
      () => BUSY_TIMEOUT_FLOOR_MS,
      '写锁等待的下限本身是选择：实测的单条写入耗时只能说明「等这么久够排下很多次写入」，' +
        '与该值之间没有算式（乘 200 也没有出处）',
      { guardedBy: ['test/memory.test.mjs'] },
    ),
    display: () => `${BUSY_TIMEOUT_FLOOR_MS} ms`,
    definedBy: { file: 'src/util/memory.ts', name: 'BUSY_TIMEOUT_FLOOR_MS' },
    affects: '写锁等待下限：max(5000, 单条写入耗时 × 200)',
    variesWith: ['磁盘延迟', '并发写入压力'],
    diverges: '**这个数同时是「本机实测」的产物**：3.5 ms × 200 里的 200 与 3.5 都没有文档出处',
  },
  {
    name: 'MMAP_MEMORY_DIVISOR',
    area: '资源',
    ...chosen(
      () => MMAP_MEMORY_DIVISOR,
      '八分之一是经验取法（mmap 是虚拟地址占用，但被访问的页会驻留物理内存）；比例取值是选择，无记录',
    ),
    display: () => `${MMAP_MEMORY_DIVISOR}（内存的八分之一）`,
    definedBy: { file: 'src/util/memory.ts', name: 'MMAP_MEMORY_DIVISOR' },
    affects: 'mmap 上限的第二个约束：与固定 256 MB 取更小者',
    variesWith: ['机器内存', '库的访问局部性'],
  },
  {
    name: 'MMAP_GROWTH',
    area: '资源',
    ...chosen(() => MMAP_GROWTH, '1.5 只为留一点余量让整个库文件进窗口，没有实测出处'),
    display: () => `库文件的 ${MMAP_GROWTH} 倍`,
    definedBy: { file: 'src/util/memory.ts', name: 'MMAP_GROWTH' },
    affects: 'mmap 目标窗口相对库文件大小的倍数：让整个库文件能落进窗口',
    variesWith: ['库文件大小'],
  },
  {
    name: 'WRITE_COST_MEASURED_MS',
    area: '资源',
    ...recheckable(() => WRITE_COST_MEASURED_MS, {
      tool: '无脚本（本机磁盘上写一条记录并计时）',
      finding: '本机磁盘单条写入 3.5 ms，写锁等待时间以它为基数；换机器后这个数会变，届时等待时间自动跟着变',
    }),
    display: () => `${WRITE_COST_MEASURED_MS} ms（本机实测的单条写入耗时）`,
    definedBy: { file: 'src/util/memory.ts', name: 'WRITE_COST_MEASURED_MS' },
    affects: '写锁等待时间的推导基数：慢盘上按它放大，而不是拍一个更大的常数',
    variesWith: ['磁盘延迟', '机器负载'],
  },
  {
    name: 'BUSY_TIMEOUT_MULTIPLIER',
    area: '资源',
    ...chosen(() => BUSY_TIMEOUT_MULTIPLIER, '200 由「一次等待里最多排几次写入」这个取舍决定，没有实测出处'),
    display: () => `${BUSY_TIMEOUT_MULTIPLIER} 倍`,
    definedBy: { file: 'src/util/memory.ts', name: 'BUSY_TIMEOUT_MULTIPLIER' },
    affects: '等待时间 = 单条写入耗时 × 200（约能排下几百次写入）',
    variesWith: ['并发写入压力'],
  },
  {
    name: 'VEC_DIM',
    area: '资源',
    ...chosen(
      () => VEC_DIM,
      '向量长度必须等于编码模型的输出维度（bge-small-zh-v1.5 的输出维度，模型事实）：' +
        '这是接口约束，不是测出来或调出来的数',
      {
        guardedBy: [
          'test/encoder.test.mjs',
          'test/graph.test.mjs',
          'test/declared-edges.test.mjs',
          'test/util.test.mjs',
          'test/search.test.mjs',
          'test/write.test.mjs',
          'test/flags.test.mjs',
          'test/forget.test.mjs',
          'test/audit.test.mjs',
          'test/archive.test.mjs',
          'test/review.test.mjs',
          'test/split-pending.test.mjs',
          'test/cache-usage.test.mjs',
        ],
      },
    ),
    definedBy: { file: 'src/util/vec.ts', name: 'VEC_DIM' },
    affects: '向量维度与 BLOB 长度校验；维度不匹配的向量被跳过而不是硬算',
    variesWith: ['换编码模型'],
    diverges: '**结构性常量**，登记它是为了换模型时能被一条命令查出来',
  },
  // ─────────────────── 显式删除（forget.ts，T20 / §44）───────────────────────
  {
    name: 'FORGOTTEN_MIN_BIGRAMS',
    area: '显式删除',
    ...chosen(
      () => FORGOTTEN_MIN_BIGRAMS,
      '不是标定值，是一条有意义性下限：Jaccard 是两边一比算出来的，2 个 bigram 对 20 个也能得 0.09。' +
        '取 2 是复用 entries.ts 的 MIN_TERM = 2（bigram 的最小语义单位就是 2 个字符），不是另立一个数。' +
        '真正需要标定的是「多短算太短」，那要拿真实短记忆的分布来定，本轮没有这份分布',
      { guardedBy: ['test/forget.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/forget.ts', name: 'FORGOTTEN_MIN_BIGRAMS' },
    affects: '防写回判据的**可判下限**：两侧任一不足这么多 bigram 就不做判断（放行）',
    variesWith: ['写入约定里一条记忆的最短长度'],
    diverges: '**不是阈值而是下限**，登记它是为了让「防写回在多短的文本上不生效」可被一条命令查出来',
  },
  {
    name: 'FORGOTTEN_SCAN_LIMIT',
    area: '显式删除',
    ...chosen(
      () => FORGOTTEN_SCAN_LIMIT,
      '无记录，是资源上限而非质量阈值：墓碑数与用户删除过的条数同阶，正常到不了；' +
        '取 2000 是为了让写入有界 —— 无上限的全表读会让写入随删除次数悄悄变慢',
    ),
    definedBy: { file: 'src/pipeline/forget.ts', name: 'FORGOTTEN_SCAN_LIMIT' },
    affects: '写入时最多比对多少条墓碑；超过时结果带 truncated，写入结果上会标出来',
    variesWith: ['用户删除的累计条数', '写入路径的延迟预算'],
  },
  {
    name: 'FORGET_BODY_MAX_BYTES',
    area: '显式删除',
    ...chosen(
      () => 4096,
      '无记录，是资源上限：删除请求只有一个整数 id，几百字节足够；读请求体是累积式的，' +
        '没有上限就等于允许任何本机进程让宿主堆任意大的字符串（回环不是「可信」，只是「本机」—— ' +
        '宿主对插件路由不做鉴权）',
      { guardedBy: ['test/plugin.test.mjs'] },
    ),
    definedBy: { file: 'src/index.ts', name: 'FORGET_BODY_MAX_BYTES' },
    affects: '删除端点（唯一的写路由）接受的请求体上限',
    variesWith: ['请求体里要不要带更多字段'],
  },
  // ────────────────────────────── 重聚类（T16）──────────────────────────────
  {
    name: 'RECLUSTER_PLAN_DELAY_MS',
    area: '重聚类',
    ...chosen(
      () => RECLUSTER_PLAN_DELAY_MS,
      '未标定，是产品口味：3 秒是「点错了还能撤」与「点了要立刻有反应」之间的取值；' +
        '没有测量能回答 3 秒比 1 秒或 5 秒更合适 —— 它取决于人点下去之后多久会意识到自己点错了',
    ),
    definedBy: { file: 'src/cluster/executor.ts', name: 'RECLUSTER_PLAN_DELAY_MS' },
    affects:
      '点「开始整理」之后等多久才真的开跑。这段时间里「取消」有效，之后只能等它跑完 —— ' +
      '它决定了误点之后还有多长的反悔窗口',
    variesWith: ['用户对整理耗时的容忍度', '库规模（跑得越久，越需要更长的反悔窗口）'],
  },
  {
    name: 'DEFAULT_KNN_K',
    area: '重聚类',
    ...recheckable(() => DEFAULT_KNN_K, {
      tool: 'T16 探针（无脚本）',
      finding:
        '基准库上与参照实现（clusternova，mpts=2）对照：k=2 得 82 簇 / 噪声占 68.9%，参照 75 簇 / 73.4%，' +
        '双向成员重合度 0.77 / 0.85；k≥6 时本实现塌缩到个位数簇。设计报告 §21 给 min_samples = 2，' +
        '而 min_samples 与 k 在本实现里是同一个参数',
      scale: '基准库 1374 条真实向量、512 维（只有一个规模档）',
    }),
    definedBy: { file: 'src/cluster/graph.ts', name: 'DEFAULT_KNN_K' },
    affects:
      'k 近邻图每点保留的邻居数，同时也是 min_samples（核心距离取第几近邻）—— ' +
      '它决定互可达距离里「核心距离」那一项有多大，也就决定了小簇会被抹平到什么程度',
    variesWith: ['库规模（k 越大越小簇越易被抹平）', '语料密度分布', '换编码模型（余弦尺度会变）'],
  },
  {
    name: 'DEFAULT_MIN_CLUSTER_SIZE',
    area: '重聚类',
    ...chosen(
      () => DEFAULT_MIN_CLUSTER_SIZE,
      '设计报告 §21 写死 min_cluster_size = 3，没有给标定实验；「3 是不是对的」本轮没有测 —— ' +
        '没有拿「人工判定哪些记忆属于同一主题」做对照，所以 3 的来历是设计报告',
    ),
    definedBy: { file: 'src/cluster/hierarchy.ts', name: 'DEFAULT_MIN_CLUSTER_SIZE' },
    affects:
      '簇的规模门槛：小于此值的碎片在压缩阶段并入父簇，而不是各自成为一个主题。' +
      '它是唯一带语义的聚类参数 —— 直接表达「多小算一个独立主题」',
    variesWith: ['库规模', '一条记忆的平均信息量', '「一个主题至少几条记忆才有用」这个产品判断'],
  },
  {
    name: 'DEFAULT_ALIGN_COS',
    area: '重聚类',
    ...chosen(
      () => DEFAULT_ALIGN_COS,
      '时序文档 4.3 给的 0.80，该文档没有给标定实验；探针实测了这条线的效果（配对成功率与' +
        '配对余弦的分位），但没有反向标定「0.80 之下哪些其实同属一个主题」—— 那需要人工对照，' +
        '本轮没做。数值上与落位的 tauJoin = 0.78 接近，但两者问的是不同的问题，不要合并',
    ),
    definedBy: { file: 'src/cluster/align.ts', name: 'DEFAULT_ALIGN_COS' },
    affects:
      '身份对齐：新簇质心与旧 topic 质心的余弦达到此值才允许配对，配对成功的旧 topic id ' +
      '被继承（挂在其上的主属引用、次属引用与 near 边因此不失效）',
    variesWith: ['换编码模型（余弦尺度会变）', '重聚类的频率（间隔越久，旧质心越不代表现状）'],
  },
  {
    name: 'MST_BRIDGE_FACTOR',
    area: '重聚类',
    ...chosen(
      () => MST_BRIDGE_FACTOR,
      '无标定实验。取 2（即桥边比任何真实边都贵）是一个语义选择而不是拟合：分量之间一条边' +
        '都没有（不是「边太贵」，是真的没有），任何取法都造不出真实的连接，只能保证桥边排在 ' +
        'Kruskal 顺序的最后',
    ),
    definedBy: { file: 'src/cluster/mst.ts', name: 'MST_BRIDGE_FACTOR' },
    affects:
      'k 近邻图不连通时，缝合分量所用的桥边权重 = 全图最大权重 × 本值。' +
      '它决定那些孤立分量在层次树上「多晚」才被并进全局根',
    variesWith: ['k（k 越大分量越少，需要桥边的场合越少）', '语料的密度分布'],
  },
  {
    name: 'RECLUSTER_BATCH_ATOMS',
    area: '重聚类',
    ...chosen(
      () => RECLUSTER_BATCH_ATOMS,
      '没有标定：1000 取自「一批在本机约几十毫秒、不至于让事务次数爆炸」的粗估；' +
        '没有测过宿主在何种批大小下开始出现可感知卡顿 —— 那需要端到端观测宿主的响应延迟，本轮没做',
    ),
    definedBy: { file: 'src/cluster/rebuild.ts', name: 'RECLUSTER_BATCH_ATOMS' },
    affects:
      '落库阶段每个事务处理的条数：一批 = 一次事务 = 一次事件循环占用。' +
      '它约束的是「重聚类会不会把宿主卡住」（B2 瓶颈：DatabaseSync 是同步的）',
    variesWith: ['机器磁盘与 WAL 配置', '宿主对单次同步阻塞的容忍度', '库规模（批数随 atom 数增长）'],
  },
  // ────────────────────────────── 图扩展（graph/infer.ts）──────────────────────────────
  {
    name: 'NEAR_K',
    area: '图扩展',
    ...recheckable(() => NEAR_K, {
      tool: 'T18 探针 03（无脚本）',
      finding:
        '参数网格（K = 2/3/4/6/8 × cosMin = 0.70/0.75/0.80）：96%（1293/1374）的 atom 过线邻居多于 K，' +
        '所以 MOD 由 K 直接决定 —— K=4 → 3.86、K=6（cosMin 0.75）→ 4.64；按 §36 的 MOD 目标区间 2~5 ' +
        '取中点 4',
      scale: '基准库 1374 条 atom（只有一个规模档）',
    }),
    definedBy: { file: 'src/graph/infer.ts', name: 'NEAR_K' },
    affects:
      'inferEdges：每个 atom 保留多少个向量近邻作为 near 边。它同时是图路的宽度与 ' +
      '§36 第 8 项 MOD 的旋钮 —— 实测 MOD 几乎等于 K',
    variesWith: ['库规模（atom 越多近邻越密）', '换编码模型（余弦尺度会变）', '§36 的 MOD 目标区间'],
  },
  {
    name: 'NEAR_COS_MIN',
    area: '图扩展',
    ...recheckable(() => NEAR_COS_MIN, {
      tool: 'T18 探针 01（余弦分布）与探针 03（参数网格）',
      finding:
        'top-16 邻居的 cos 中位数 0.748、p10 0.685 —— 0.70 与 0.86 之间没有自然断点，抬线砍不掉一批' +
        '「明显更差」的边，只会制造孤点：0.70 → 孤立 1.6%，0.75 → 8.1%（越过 §36 的 <8% 目标），' +
        '0.80 → 34%（越过 20% 报警线）。0.70 是三个候选里唯一同时满足 MOD 与孤立率两条区间的。' +
        '它不是「相似」的语义线，只是「别把可用的 atom 变成孤点」的底线',
      scale: '基准库 1374 条 atom',
    }),
    definedBy: { file: 'src/graph/infer.ts', name: 'NEAR_COS_MIN' },
    affects: 'inferEdges：余弦低于此值的 atom 对不建边。它决定边质量的下限，也决定孤立率',
    variesWith: ['换编码模型（余弦尺度会变）', '§36 的孤立率目标', '语料的领域混合度'],
  },
  {
    name: 'OUT_DEGREE_CAP',
    area: '图扩展',
    ...chosen(
      () => OUT_DEGREE_CAP,
      '设计文档给的值，未在本库标定：§33 的降级路径、§40 的反例判据、技术文档 4.2 的图路参数都写 16，' +
        '值来自设计文档；它是 K 被调大时的兜底，不是标定出来的上限',
    ),
    definedBy: { file: 'src/graph/infer.ts', name: 'OUT_DEGREE_CAP' },
    affects:
      '出度硬上限。两个来源各自用一次、**不合并计数**：推断边每 atom ≤ 16（inferEdges ' +
      '把超出的邻居截断），声明边每批 ≤ 16（write.ts 把超出的边拒掉）。所以同一个 atom ' +
      '可以有 16 条推断边 + 16 条声明边，合计不设上限。查询侧（graphPath 的每个种子）' +
      '也用它截断候选，同样不参与前两者的计数',
    variesWith: ['NEAR_K（K 接近或超过 16 时它才开始生效）', '库规模与语料密度'],
    design: { doc: DESIGN_DOC_T18_FAIL, key: '出度硬上限', default: 16 },
  },
  {
    name: 'GRAPH_INFER_MAX_ATOMS',
    area: '图扩展',
    ...recheckable(() => GRAPH_INFER_MAX_ATOMS, {
      tool: '无脚本（按实测吞吐外推）',
      finding:
        '基准库全量成对（943 251 对、512 维）实测 460~510 ms；按 O(N²) 外推到 4 000 条约 4 s、' +
        '到 8 000 条约 16 s。取 4 000 对应「首次召回最多多等约 4 秒」这个判断，不是实测出来的上限；' +
        '要真正解掉这条外推，得把全量成对换成桶内候选或 SimHash 预筛',
      scale: '基准库 1374 条 atom，943 251 对、512 维',
      guardedBy: ['test/audit.test.mjs'],
    }),
    definedBy: { file: 'src/graph/infer.ts', name: 'GRAPH_INFER_MAX_ATOMS' },
    affects:
      'inferEdges：超过此规模就不做全量两两比较，直接拒绝推断并如实报告结果，' + '而不是安静地跑上几分钟',
    variesWith: ['机器算力', '单次召回可接受的阻塞时长', '是否改成近邻候选而非全量成对'],
  },
  {
    name: 'DECLARED_EDGE_CONFIDENCE',
    area: '图扩展',
    ...chosen(
      () => DECLARED_EDGE_CONFIDENCE,
      '设计取值，不是标定：裁决把 declared 定义为真相源，而「声明」本身就是证据，因此给满 1.0，' +
        '与 near 边「没有证据时给中位」的 0.5 相反；1.0 的作用是让声明边在【路】段与邻居截断里' +
        '排在推断边之前',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'DECLARED_EDGE_CONFIDENCE' },
    affects:
      '写入声明边（origin = declared）时的 confidence：它是一个常量，不是相似度。' +
      '**只影响图路内部先后**：每个种子留哪几条邻居（查询侧的出度截断按它排序），' +
      '以及【路】段的行序。它**不进原子分数** —— 但会经图路的名次间接改变候选的 final：' +
      '换掉两条声明边的 confidence，可能改变谁先谁后，也可能换掉被截断留下的那几条',
    variesWith: ['图路每个种子的出度截断（换值会换掉留下的邻居）', '【路】段的行序'],
  },
  {
    name: 'DECLARED_EDGE_TYPE_MAX',
    area: '图扩展',
    ...chosen(
      () => DECLARED_EDGE_TYPE_MAX,
      '护栏，不是标定：现有五类 kind 最长 10 个字符（supersedes），32 留两倍余量给项目自定义的' +
        '关系名；再长就会挤占回执与注入文本，且没有任何已知用法需要它',
    ),
    definedBy: { file: 'src/pipeline/write.ts', name: 'DECLARED_EDGE_TYPE_MAX' },
    affects:
      '写入声明边时 type 的字符数上限：超过即拒这条边（不拒记忆），拒因随回执返回。' +
      '字符集另有判据（小写字母 / 数字 / 下划线，正则见 write.ts 的 DECLARED_EDGE_TYPE_RE）',
    variesWith: ['模型自取关系名的实际长度分布（本项目尚无这份实测）'],
  },
  // ────────────────────────────── 降级日志（src/log/）──────────────────────────────
  //
  // 这一组的取值由用户决定，不是语料标定：日志的容量参数
  // 取决于「降级事件多久发生一次、一条多长」，而本仓库还没有这份实测。
  // 按本表纪律，这里如实写「未标定」，而不是编一个看起来有依据的场景。
  {
    name: 'LOG_FILE_MAX_BYTES',
    area: '降级日志',
    ...chosen(
      () => LOG_FILE_MAX_BYTES,
      '没有日志事件速率的实测：4 MB 是产品决定的值，「降级事件稀疏、约能放数万条」是判断；' +
        '本仓库没有事件速率与单条 detail 长度的实测',
    ),
    definedBy: { file: 'src/log/store.ts', name: 'LOG_FILE_MAX_BYTES' },
    affects: '写前与启动时检查：当前日志库达到此大小就改名为历史文件并新建（4 MB）',
    variesWith: ['降级事件产生速率', '单条 detail 的长度', '愿意给日志的磁盘空间'],
  },
  {
    name: 'LOG_KEEP_FILES',
    area: '降级日志',
    ...chosen(
      () => LOG_KEEP_FILES,
      '取 5 个；5 个 × 4 MB 与总量 20 MB 相等，是产品决定的磁盘空间预算，没有测量出处',
    ),
    definedBy: { file: 'src/log/store.ts', name: 'LOG_KEEP_FILES' },
    affects: '清理：历史文件数 + 当前库不超过这个数，超出删最旧的（5 个，含当前库）',
    variesWith: ['单文件阈值', '总量上限', '需要回溯多久的降级历史'],
  },
  {
    name: 'LOG_TOTAL_MAX_BYTES',
    area: '降级日志',
    ...recheckable(() => LOG_TOTAL_MAX_BYTES, {
      tool: '源码表达式（src/log/store.ts 的 `LOG_KEEP_FILES * LOG_FILE_MAX_BYTES`）',
      finding:
        '由 LOG_KEEP_FILES × LOG_FILE_MAX_BYTES 算出 20 MB；改两个因子后重新构建，派生值跟着变，不需要测量',
      formula: true,
    }),
    definedBy: { file: 'src/log/store.ts', name: 'LOG_TOTAL_MAX_BYTES' },
    affects: '清理：全部日志文件（含当前库）总大小超过此值就删最旧的历史文件（20 MB）',
    variesWith: ['单文件阈值', '保留文件数', '磁盘配额'],
  },
  {
    name: 'LOG_QUEUE_MAX',
    area: '降级日志',
    ...chosen(
      () => LOG_QUEUE_MAX,
      '200 条在 50 ms 窗口下的吸收能力是按速率推算，本仓库没有降级事件速率的实测；取 200 条',
    ),
    definedBy: { file: 'src/log/index.ts', name: 'LOG_QUEUE_MAX' },
    affects: '缓冲：内存队列上限 200 条；满了丢最旧并计数，不阻塞、不抛错',
    variesWith: ['降级事件爆发速率', '批量窗口', '单条日志的内存占用'],
  },
  {
    name: 'LOG_FLUSH_WINDOW_MS',
    area: '降级日志',
    ...chosen(
      () => LOG_FLUSH_WINDOW_MS,
      '取值「setImmediate 或 50 ms」，实现取两者中更保守的上界；50 ms 是产品决定的窗口，没有测量出处',
    ),
    definedBy: { file: 'src/log/index.ts', name: 'LOG_FLUSH_WINDOW_MS' },
    affects:
      '缓冲：批量窗口的**上界**。正常路径由 setImmediate 在下一轮事件循环 flush；' +
      '只有事件循环被占住、队首已等满 50ms 时才当场 flush（不新增定时器）',
    variesWith: ['事件产生速率', '崩溃时允许丢失的时间窗', '宿主的事件循环忙碌程度'],
  },
  {
    name: 'LOG_WRITE_FAILED_MIN_INTERVAL_MS',
    area: '降级日志',
    ...chosen(
      () => LOG_WRITE_FAILED_MIN_INTERVAL_MS,
      '限频间隔来自设计草案第三节的规定（1 次/分钟），没有测量出处',
    ),
    definedBy: { file: 'src/log/index.ts', name: 'LOG_WRITE_FAILED_MIN_INTERVAL_MS' },
    affects: '写失败降级：log.write_failed 的限频间隔（1 次/分钟）',
    variesWith: ['故障持续时间', '日志库的可用性', '用户对日志噪声的容忍度'],
  },
  {
    name: 'LOG_EXPORT_MAX_ROWS',
    area: '降级日志',
    ...chosen(
      () => LOG_EXPORT_MAX_ROWS,
      '取 10 万行；按单行约 60~120 字节估算 10 万行约 6~12 MB，与 10 MB 字节上限互为上界，' +
        '没有导出规模的实测',
    ),
    definedBy: { file: 'src/log/export.ts', name: 'LOG_EXPORT_MAX_ROWS' },
    affects: '导出：CSV 最多 10 万行数据，超过截断并在文件尾加 # truncated',
    variesWith: ['单行 detail 的长度', '导出可接受的内存与等待时间'],
  },
  {
    name: 'LOG_EXPORT_MAX_BYTES',
    area: '降级日志',
    ...chosen(() => LOG_EXPORT_MAX_BYTES, '取 10 MB；与 10 万行上限谁先到谁截断，两个都是产品决定的值'),
    definedBy: { file: 'src/log/export.ts', name: 'LOG_EXPORT_MAX_BYTES' },
    affects: '导出：CSV 最多 10 MB（含表头），超过截断并加 # truncated',
    variesWith: ['单行 detail 的长度', '浏览器/编辑器打开大文件的承受度'],
  },
  // ──────────────────────────── 校准样本（src/samples/）────────────────────────────
  //
  // 这一组的取值由用户决定，不是语料标定：样本库的容量与
  // 负样本分档取决于「一次会话里模型会反馈几次」，本仓库还没有这份实测。
  // 按本表纪律，如实写「未标定」，而不是编一个看起来有依据的场景。
  {
    name: 'SAMPLE_RETAIN_DAYS',
    area: '校准样本',
    ...chosen(
      () => SAMPLE_RETAIN_DAYS,
      '未标定：取 90 天，理由是「跨一个季度的对照仍有意义，再久语料族大概率已经变了」；' +
        '这是判断而非实测，样本的实际衰减速率没有测过',
    ),
    definedBy: { file: 'src/samples/store.ts', name: 'SAMPLE_RETAIN_DAYS' },
    affects: '淘汰：写样本时删掉 created_at 早于「现在 - 90 天」的行',
    variesWith: ['语料族的更新周期', '重标频率'],
  },
  {
    name: 'SAMPLE_MAX_ROWS',
    area: '校准样本',
    ...chosen(
      () => SAMPLE_MAX_ROWS,
      '未标定：取 1 万条。10 万条向量约 200 MB 已明确不可行；1 万条是' +
        '「够切点估计、又不超过一个普通库的量级」的判断，不是按样本量需求算出来的',
    ),
    definedBy: { file: 'src/samples/store.ts', name: 'SAMPLE_MAX_ROWS' },
    affects: '总量：超过 1 万条时按 created_at 淘汰最旧的（约 20 MB：512 维 x 4 B x 1 万）',
    variesWith: ['切点估计所需的样本量', '愿意给的磁盘空间'],
  },
  {
    name: 'SAMPLE_NEG_OBVIOUS_MAX',
    area: '校准样本',
    ...chosen(
      () => SAMPLE_NEG_OBVIOUS_MAX,
      '未标定：取 2000 条，理由是该档「对切点信息量低」，只需要少量代表；' +
        '具体多少条够，要等 T46 的重标样本量与切点偏移实测',
    ),
    definedBy: { file: 'src/samples/store.ts', name: 'SAMPLE_NEG_OBVIOUS_MAX' },
    affects:
      '「明显无关」负样本的上限：满了删最旧的、保留最近 2000 条。' +
      '「不确定带」的那一档不设上限（它才是切点信息的来源）',
    variesWith: ['切点扫描对负样本数量的敏感度', '总条数上限'],
  },
  {
    name: 'SAMPLE_OBVIOUS_MAX_TOP1',
    area: '校准样本',
    ...chosen(
      () => SAMPLE_OBVIOUS_MAX_TOP1,
      '未标定：取 0.4 / 0.6 两条线，但没有说明依据；可对照的实测（view.ts 注释里的' +
        '「无关查询 top1 上界」）量级相近但口径不同，不能当这条线的标定 —— 固定 0.4 在大库上' +
        '会把「有点关系」的召回记成明显无关',
      { guardedBy: ['test/samples.test.mjs'] },
    ),
    definedBy: { file: 'src/samples/store.ts', name: 'SAMPLE_OBVIOUS_MAX_TOP1' },
    affects: '负样本分档：top1 低于 0.4 记为「明显无关」（这一档有 2000 条上限）',
    variesWith: ['库规模（无关 top1 随库长大上移）', '语料族', '编码模型'],
  },
  {
    name: 'SAMPLE_UNCERTAIN_MAX_TOP1',
    area: '校准样本',
    ...chosen(
      () => SAMPLE_UNCERTAIN_MAX_TOP1,
      '未标定：取 0.6，与上一条同源 —— 两条线一起定，分开调没有意义；' +
        '它们的位置应当由 T46 的切点扫描给出，本表只记录当前取值',
      { guardedBy: ['test/samples.test.mjs'] },
    ),
    definedBy: { file: 'src/samples/store.ts', name: 'SAMPLE_UNCERTAIN_MAX_TOP1' },
    affects: '负样本分档：top1 在 0.4~0.6 记为「不确定带」（优先保留，供切点扫描）',
    variesWith: ['库规模', '语料族', '编码模型', '切点的目标位置'],
  },
  {
    name: 'SAMPLE_QUEUE_MAX',
    area: '校准样本',
    ...chosen(
      () => SAMPLE_QUEUE_MAX,
      '未标定：按「一次召回最多入队一条」推算，64 条足以吸收事件循环被占住的一整轮' +
        '（对照 LOG_QUEUE_MAX 的 200 条：日志一次召回可能同时产生三条事件）；不是测出来的队列深度',
    ),
    definedBy: { file: 'src/samples/index.ts', name: 'SAMPLE_QUEUE_MAX' },
    affects: '缓冲：内存队列上限 64 条；满了丢最旧并计数，不阻塞召回、不抛错',
    variesWith: ['事件循环被占住的时长', '单条样本的内存占用'],
  },
  {
    name: 'FLAG_SPLIT_PENDING',
    area: '写入',
    ...chosen(
      () => FLAG_SPLIT_PENDING,
      '位定义来自设计报告对 flags 的命名（待拆分 / 歧义 / 未归类），位值一旦落库就不能改；置位判据是长度（review.ts 的 maxChars），不是自洽度评分 —— 候选按长度给出、不判断内容。任何测量都给不出位值',
      { guardedBy: ['test/flags.test.mjs', 'test/split-pending.test.mjs', 'test/client-source.test.mjs'] },
    ),
    definedBy: { file: 'src/db/flags.ts', name: 'FLAG_SPLIT_PENDING' },
    affects:
      'atom.flags 的 bit0：待拆分（T29）。写入侧**按长度切分**时置上（每段都置），召回时锚行标「疑似应拆分」，由人在界面上确认或忽略（两者都清这一位）',
    variesWith: ['（不应变：改它等于把历史行解释错）'],
  },
  {
    name: 'SPLIT_CONFIRMED_MAX',
    area: '写入',
    ...chosen(
      () => SPLIT_CONFIRMED_MAX,
      '未标定，是护栏：一次召回最多展示二十几条锚，清单比锚段还长时多出来的部分对任何一次召回都没有影响，却会让 meta 的值无限增长',
      { guardedBy: ['test/split-pending.test.mjs'] },
    ),
    definedBy: { file: 'src/pipeline/split.ts', name: 'SPLIT_CONFIRMED_MAX' },
    affects:
      '「用户已确认应拆分」清单的条数上限（meta 的 split_confirmed，FIFO 淘汰最早的一条）。满了只影响更早的确认还能不能出现在锚行提示里，不改变任何召回与写入行为',
    variesWith: ['锚段条数（topN 与实际预算）', '用户对候选的处理速度'],
  },
  {
    name: 'SPLIT_SEGMENTS_MAX',
    area: '写入',
    ...chosen(
      () => SPLIT_SEGMENTS_MAX,
      '未标定，是护栏：一次写入最多切 8 段，这个上限容得下四次切分写入；比锚段还长时多出来的部分对召回没有影响，设它是为了让 meta 的值不无限增长',
    ),
    definedBy: { file: 'src/pipeline/split.ts', name: 'SPLIT_SEGMENTS_MAX' },
    affects:
      '「切分时共几段」映射的条数上限（meta 的 split_pending_segments，FIFO）。满了只影响更早的候选还能不能显示段数，段数未知时锚行退回不带段数的固定串',
    variesWith: ['一次写入的切分段数上限（REVIEW_MAX_SEGMENTS）', '锚段条数（topN 与实际预算）'],
  },
  {
    name: 'SPLIT_SCENE_CHARS',
    area: '写入',
    ...chosen(
      () => SPLIT_SCENE_CHARS,
      '未标定，是预算护栏：锚段按字符算预算，查询词可以是一整句，不截断会让一条锚多出几十上百字，同一段预算能装下的记忆随之变少；' +
        '16 是保证单条锚文本增量不超过 44 字（候选标记 + 段数 + 使用场景的合计上限）的取值',
    ),
    definedBy: { file: 'src/pipeline/view.ts', name: 'SPLIT_SCENE_CHARS' },
    affects:
      '锚行「用于：<查询词>」里查询词最多给几个字符（只对 flags 的 bit0 命中生效）。保证单条锚的文本增量不超过 44 字（候选标记 + 段数 + 使用场景的合计上限）',
    variesWith: ['查询词长度分布', '锚段预算', '「单锚增量 ≤ 40 字」这条判据'],
  },
  {
    name: 'FLAG_AMBIGUOUS',
    area: '写入',
    ...chosen(
      () => FLAG_AMBIGUOUS,
      '同 FLAG_SPLIT_PENDING：位值不可变 —— bit1 是 flags 的位定义，换掉会把历史行解释错。语义是「落位时两个候选接近、没把握」',
      { guardedBy: ['test/flags.test.mjs', 'test/archive.test.mjs'] },
    ),
    definedBy: { file: 'src/db/flags.ts', name: 'FLAG_AMBIGUOUS' },
    affects: 'atom.flags 的 bit1：落位时两个候选接近、没把握',
    variesWith: ['（不应变）'],
  },
  {
    name: 'FLAG_UNCLASSIFIED',
    area: '写入',
    ...chosen(
      () => FLAG_UNCLASSIFIED,
      '同 FLAG_SPLIT_PENDING：位值不可变 —— bit2 是 flags 的位定义，换掉会把历史行解释错。语义是「与任何已有主题都不像」',
      { guardedBy: ['test/flags.test.mjs'] },
    ),
    definedBy: { file: 'src/db/flags.ts', name: 'FLAG_UNCLASSIFIED' },
    affects: 'atom.flags 的 bit2：与任何已有主题都不像（未归类）',
    variesWith: ['（不应变）'],
  },
  {
    name: 'FLAG_ARCHIVED',
    area: '写入',
    ...chosen(
      () => FLAG_ARCHIVED,
      '位值由设计文档对 flags 的命名确定（技术文档 §5），不可改；bit4 是 flags 的位定义，改它会把历史行解释错。归档不是删除：内容与边都还在，显式检索仍可见',
      { guardedBy: ['test/archive.test.mjs', 'test/client-source.test.mjs'] },
    ),
    definedBy: { file: 'src/db/flags.ts', name: 'FLAG_ARCHIVED' },
    affects:
      'atom.flags 的 bit4：已归档（T26）。默认不召回、不进注入三段、列表默认不列；' +
      '显式检索（lattice_list 给 flags、界面勾「显示已归档」）仍可见。不是删除：内容与边都还在',
    variesWith: ['（不应变）'],
  },
  // ──────────────────────── 重标触发（calibration/trigger.ts）────────────────────────
  {
    name: 'RECALIBRATE_COOLDOWN_MS',
    area: '校准样本',
    ...chosen(
      () => RECALIBRATE_COOLDOWN_MS,
      '无测量依据，是产品口味：12 小时对应「一次写作会话」量级；没有任何测量' +
        '能回答「12 小时比 6 小时更合适」',
    ),
    display: () => `${displayNumber(RECALIBRATE_COOLDOWN_MS / 3600000)} 小时`,
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_COOLDOWN_MS' },
    affects: '冷却：距上次判 S 不足 12 小时就不判、也不重标（省一次伪查询抽样）',
    variesWith: ['用户的写作节奏', '库的变化速率'],
  },
  {
    name: 'RECALIBRATE_MIN_ATOMS',
    area: '校准样本',
    // 值直接取 TIER_SCALE_STABLE_ATOMS（`src/calibration/trigger.ts` 的 `RECALIBRATE_MIN_ATOMS` 就是引用），不是自己的数。
    ...recheckable(() => RECALIBRATE_MIN_ATOMS, {
      tool: '源码表达式（src/calibration/trigger.ts 直接引用 TIER_SCALE_STABLE_ATOMS）',
      finding:
        '值就是 TIER_SCALE_STABLE_ATOMS（192）：来自 calib@0.1.0 阈值重标定（2026-10-17）的' +
        '降采样实验结论 —— 阈值稳定所需的最小 atom 数；改 TIER_SCALE_STABLE_ATOMS 后重新构建，' +
        '派生值跟着变',
      at: '2026-10-17',
      formula: true,
    }),
    display: () => `${RECALIBRATE_MIN_ATOMS}（= TIER_SCALE_STABLE_ATOMS）`,
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_MIN_ATOMS' },
    refs: [{ file: 'src/calibration/trigger.ts', symbol: 'RECALIBRATE_MIN_ATOMS' }],
    affects: '闸①：库小于 192 条不重标（S 的抽样波动在这个规模下与漂移同量级）',
    variesWith: ['查询集', '语料构成'],
  },
  {
    name: 'RECALIBRATE_MIN_POSITIVE',
    area: '校准样本',
    ...chosen(
      () => RECALIBRATE_MIN_POSITIVE,
      '未标定：与写入节奏匹配的经验数，没有测量能给出「少于几条算不够」',
    ),
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_MIN_POSITIVE' },
    affects: '闸④：正样本少于 10 条不重标（切点会被单条样本牵着走）',
    variesWith: ['用户/模型的标注频率'],
  },
  {
    name: 'RECALIBRATE_DRIFT',
    area: '校准样本',
    ...recheckable(() => RECALIBRATE_DRIFT, {
      tool: '无脚本（U9 噪声实测）',
      finding:
        '192 维下 S 的 sd 约 0.0063，0.01 约 1.6σ —— 小于它的漂移分不清是库变了还是抽样噪声；' +
        '「1.6σ」这个系数是取舍，不是测量',
    }),
    display: () => `${RECALIBRATE_DRIFT}（约 1.6σ@192 维）`,
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_DRIFT' },
    affects: '闸②：S 与快照基准的差 ≤ 0.01 时不重标（噪声内不动）',
    variesWith: ['采样伪查询条数 m', '库规模'],
  },
  {
    name: 'RECALIBRATE_SAMPLE_LIMIT',
    area: '校准样本',
    ...recheckable(() => RECALIBRATE_SAMPLE_LIMIT, {
      tool: '源码表达式（src/calibration/trigger.ts 的 `SAMPLE_MAX_ROWS / 5`）',
      finding:
        '由 SAMPLE_MAX_ROWS ÷ 5 算出 2000；改 SAMPLE_MAX_ROWS 后重新构建，派生值跟着变，不需要测量。' +
        '「五分之一」这个比例是选择：切点只由靠近阈值的样本决定，多取无信息',
      formula: true,
    }),
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_SAMPLE_LIMIT' },
    affects: '一次重标最多取多少条样本（分层取样的上限，不是样本库容量）',
    variesWith: ['样本库容量', '阈值附近的样本密度'],
  },
  {
    name: 'RECALIBRATE_OBVIOUS_LIMIT',
    area: '校准样本',
    ...chosen(
      () => RECALIBRATE_OBVIOUS_LIMIT,
      '未标定：该档的信息量在「它们离得很远」，多取只是重复同一件事；500 是按这一档信息量低' +
        '给出的取舍，不确定带全取',
    ),
    definedBy: { file: 'src/calibration/trigger.ts', name: 'RECALIBRATE_OBVIOUS_LIMIT' },
    affects: '「明显无关」那一档在一次重标里最多取多少条（不确定带全取）',
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
    refs: [{ file: 'src/pipeline/view.ts', symbol: 'SEGMENT_RATIO' }],
  },
  {
    key: 'wVec/wEntry/wBody/wGraph',
    designDefault: 1,
    note: '**文档有、代码里键名不同**：实现在 pipeline/search.ts 的 CHANNEL_WEIGHT（vec / entry / body / graph）',
    refs: [{ file: 'src/pipeline/search.ts', symbol: 'CHANNEL_WEIGHT' }],
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
    refs: [{ file: 'src/index.ts', symbol: 'Config' }],
  },
]

/**
 * 三个来历查询（T54）。判据只读登记表，不写库、不改源码。
 *
 * 只处理带 `origin` 的条目：未迁移的条目仍带旧的 `evidence`，不参与 —— 把未迁移的当已迁移、
 * 或给它编一个来历，都会让缺口消失。判定放在这里而不是打印脚本里，是为了让测试能直接调用，
 * 不必去启动一个会 `process.exit` 的命令行进程。
 */

/** 声明可复算、却缺编码模型或语料规模的条目。公式条目跳过：公式的条件由代码本身承担。 */
export function needsReviewEntries(): ThresholdEntry[] {
  return THRESHOLDS.filter((e) => {
    const o = e.calibration?.origin
    return (
      o?.kind === 'recheckable' && o.formula !== true && o.encoderModel === undefined && o.scale === undefined
    )
  })
}

/** 没有测试按常量名断言默认值的条目。 */
export function unguardedEntries(): ThresholdEntry[] {
  return THRESHOLDS.filter((e) => {
    if (e.calibration?.origin === undefined) return false
    const g = e.calibration.guardedBy
    return g === undefined || g.length === 0
  })
}

/**
 * 可复算、但没有记录测量时间的条目。只作信息：不要求动作。
 *
 * 公式条目跳过：它们没有测量，也就没有「测量时间」可补 —— 列出来只会让清单里
 * 混进一批永远补不上的名字。
 */
export function undatedEntries(): ThresholdEntry[] {
  return THRESHOLDS.filter((e) => {
    const o = e.calibration?.origin
    return o?.kind === 'recheckable' && o.formula !== true && o.at === undefined
  })
}

/**
 * 字面量 `display` 里出现 `=` 即报（T55）。
 *
 * 等式写死在字符串里，常量一改它就与代码脱钩 —— 打印出来最像「已经核对过」的那一行，
 * 恰恰是唯一没人核对的。判据只认字面量：函数形式的 display 是打印时现算的，等号随值变。
 */
export function displayProblems(entries: readonly ThresholdEntry[] = THRESHOLDS): string[] {
  return entries
    .filter((e) => typeof e.display === 'string' && e.display.includes('='))
    .map((e) => e.name + '：display 是字面量且含「=」，等式会与常量脱钩 —— 改成函数，用模板字符串从常量插值')
}

/**
 * 声明了分叉，就必须真的还在分叉（T55）：`docValue` 与当前值相等 = 分叉已经不存在。
 *
 * 这是唯一能把「代码改回去了、记录没跟着改」变成可见的办法。只认数值条目 —— 对象型阈值组
 * 没法用一个数表达分叉，写在它们上面会是一条永远成立的断言（等于没写），所以也报。
 *
 * 条目同时有 `design` 时，`docValue` 还必须等于 `design.default` —— 两者记的是同一件事实
 * （设计文档给的默认值）。只比 `docValue` 与代码值的话，改设计记录时漏改分叉记录，门禁不会红，
 * 表里会同时存在两个「文档默认值」。
 */
export function divergenceProblems(entries: readonly ThresholdEntry[] = THRESHOLDS): string[] {
  const problems: string[] = []
  for (const e of entries) {
    const d = e.divergence
    if (d === undefined) continue
    const v = currentValue(e)
    if (typeof v !== 'number') {
      problems.push(e.name + '：divergence 只用于数值条目，当前值不是数字')
      continue
    }
    if (e.design !== undefined && d.docValue !== e.design.default) {
      problems.push(
        e.name +
          '：divergence.docValue（' +
          d.docValue +
          '）与 design.default（' +
          e.design.default +
          '）不同 —— 两份记录已经漂移，改一处必须改两处',
      )
    }
    if (d.docValue === v) {
      problems.push(
        e.name + '：divergence.docValue（' + d.docValue + '）与代码值相同 —— 分叉已不存在，删掉这条',
      )
    }
  }
  return problems
}

/** 评审基线的形状：两个集合各自是「条目名 → 为什么现在补不了」。 */
export interface ReviewBaseline {
  needsReview: Record<string, string>
  unguarded: Record<string, string>
}

/**
 * 冻结的存量名册（`thresholds-inventory.json`）：基线里允许出现的名字只能来自这里。
 *
 * 「只收存量」如果拿登记表当判据，新增条目也在登记表里，等于没判 —— 加一条新条目、
 * 写进基线，红就消了。名册是一份不再自动增长的名单：新条目要进基线，得先把名字加进名册，
 * 那一步在代码评审里看得见。
 */
export interface ReviewInventory {
  names: readonly string[]
}

/**
 * 检查评审基线，返回问题清单（空数组 = 通过）。四条规则：
 *
 * 1. 基线里的名字必须在**冻结名册**（`thresholds-inventory.json`）里 —— 「凭空加一个名字」
 *    与「新增条目靠写进基线消红」都在这里报；名册里的名字也必须仍在登记表里，条目改名或
 *    删除时两处一起改（后者就是「删除时留转到哪去了」的机器检查面）；
 * 2. 每条必须写理由，空字符串不算；
 * 3. 当前查询结果 ⊆ 基线 —— 代码里新出现一个待评审条目，不能靠把它塞进基线消掉；
 * 4. 基线里当前已不在结果中的项不报错，只算「已解决」，允许删 —— 基线只允许变短。
 */
export function reviewBaselineProblems(baseline: ReviewBaseline, inventory: ReviewInventory): string[] {
  const registered = new Set(THRESHOLDS.map((e) => e.name))
  const frozen = new Set(inventory.names)
  const problems: string[] = []
  for (const name of inventory.names) {
    if (!registered.has(name)) {
      problems.push('冻结名册里的 ' + name + ' 不在登记表里 —— 条目改了名或删了，名册要一起改')
    }
  }
  const queries: readonly (readonly [keyof ReviewBaseline, ThresholdEntry[]])[] = [
    ['needsReview', needsReviewEntries()],
    ['unguarded', unguardedEntries()],
  ]
  for (const [key, entries] of queries) {
    const list = baseline[key]
    if (list === null || typeof list !== 'object' || Array.isArray(list)) {
      problems.push(key + '：基线里必须是「条目名 → 理由」的对象')
      continue
    }
    for (const [name, why] of Object.entries(list)) {
      if (!frozen.has(name)) {
        problems.push(
          key +
            '：基线里的 ' +
            name +
            ' 不在冻结名册里 —— 新增条目不能靠写进基线消掉；确属历史债务的，先把名字加进 thresholds-inventory.json',
        )
      }
      if (typeof why !== 'string' || why.trim() === '') {
        problems.push(key + '：' + name + ' 没有写理由 —— 基线的每一项都要说明为什么现在补不了')
      }
    }
    for (const e of entries) {
      if (!Object.prototype.hasOwnProperty.call(list, e.name)) {
        problems.push(
          key +
            '：' +
            e.name +
            ' 是新增的待评审条目，不能靠加基线消掉 —— 先补条件（编码模型 / 语料规模）或改判来历',
        )
      }
    }
  }
  return problems
}

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

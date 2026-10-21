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
// **本册只剩搬不动的条目**（T65）：能挂 `satisfies ThresholdValue<…>` 的都在常量定义处，
// 值与来历在同一处，改值的人一定看得到。这里收的是「一个条目对应不到一个模块级常量 + 一个
// 数字」的那些 —— 值在函数调用里、在外部包里，或一个条目代表对象组的多个子键。
// 每条都要写 `unmovable` 说明理由：往表里加一条，先得回答它为什么搬不动。
//
// 留下的是什么：定义位置与可变条件；`design` / `zod` 对照（能挂到定义处的用类型参数里的
// `doc*` 与 `zod` 字段，搬不走时留在这里）；第二个取值点（`otherSites`）。
// 两处已经分叉过（tauJoin 与 tauLex 都和设计文档对不上），所以设计对照是行的一部分，不是附注。
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
  DF_FILTER_HALF_WIDTH,
  MIN_VOCAB_FOR_DF,
  LEARNED_PROMOTE_MAX_WEIGHT,
} from './pipeline/entries.js'
import { AFFILIATION, CHANNEL_WEIGHT } from './pipeline/search.js'
import { MIN_ANCHORS, SEGMENT_RATIO, TRIM_ORDER } from './pipeline/view.js'
import { TIER_SCALE_ANCHORS, TIER_SCALE_MIN_ATOMS, TIER_SCALE_STABLE_ATOMS } from './pipeline/calibrate.js'
import { RECALIBRATE_MIN_ATOMS } from './calibration/trigger.js'
import { DEFAULT_THRESHOLDS } from './pipeline/write.js'

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

/**
 * 登记项的取值：数字、字符串，或对象型阈值组的子键映射。
 *
 * 叫 `EntryValue` 而不是 `ThresholdValue`：后者已经是 `threshold-types.ts` 里带来历参数的
 * 泛型（`ThresholdValue<'recheckable', {...}>`，117 处常量用它）。两个同名类型并存时，
 * 读的人无法从名字判断手上的那个要不要带类型参数。
 */
export type EntryValue = number | string | Readonly<Record<string, number>>

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

/** 留在表里的理由（见 ThresholdEntry 的 unmovable）。 */
export type ThresholdUnmovable = '内联' | '非数值' | '静态读不出' | '外部包' | '派生自外部包' | '对象组'

/** 一条登记项。 */
export interface ThresholdEntry {
  /** 与源码里的常量名一致（内联量写形如 `X（内联）`，见 inline）。 */
  name: string
  area: ThresholdArea
  /** 值仍在原处：打印时现取，不改行为。 */
  value: () => EntryValue
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
  /**
   * 为什么这条**没搬到常量定义处**（T65 阶段 4）。
   *
   * 能搬到定义处的前提是「有一个模块级常量、值是数字」—— 下面的五类都不满足。这个字段
   * 与其说是分类，不如说是一个必须回答的问题：往表里加一条，就得说清它为什么搬不动；
   * 说得清就该写在那里，而不是写在这里。
   */
  unmovable?: ThresholdUnmovable
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
   * 不同、文档未同步），仍写在 `diverges` 里。声明了就必须与当前值不同 —— 相等说明分叉
   * 已经不存在，这句话该删。断言由 `divergenceProblems` 检查，打印时非零退出。
   *
   * 只存原因，不存文档值（T65 阶段 3 批 2）：文档值就是 `design.default`，再抄一份
   * 就是同一事实两处记录。因此写了 `divergence` 就必须同时写 `design`。
   */
  divergence?: string
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
  value: () => EntryValue,
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
  value: () => EntryValue,
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
 * 短名 → 全名：搬到定义处之后，条目的类型参数里只写短名（`doc: 't17'`）。
 *
 * 长路径照抄十九遍的后果不是难看，是改文档名时漏掉其中一条 —— 而漏掉的那条照样打印得出来。
 * 短名在这里维护一处，打印脚本与将来的 `--doc-keys` 都从这里查全名。
 */
export const DESIGN_DOCS: Readonly<Record<'t7' | 't17' | 't18fail', string>> = {
  t7: DESIGN_DOC,
  t17: DESIGN_DOC_T17,
  t18fail: DESIGN_DOC_T18_FAIL,
}

/** 全部登记项。按模块分块，与源码顺序一致，便于对照审查。 */
export const THRESHOLDS: readonly ThresholdEntry[] = [
  // ────────────────────────────── 落位（write.ts）──────────────────────────────
  {
    name: 'DEFAULT_THRESHOLDS.tauJoin',
    unmovable: '对象组',
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
    divergence: '标定后上调，文档未同步（代码与 zod 都是 0.78）',
  },
  {
    name: 'DEFAULT_THRESHOLDS.tauLex',
    unmovable: '对象组',
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
    divergence: '其下界恰为 0.05，代码取的正是那个下界；zod 下界 0.02 比文档的范围更宽',
  },
  {
    name: 'DEFAULT_THRESHOLDS.tauNew',
    unmovable: '对象组',
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
    unmovable: '对象组',
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
  // ─────────────────────── 落位的候选规模与指纹（write.ts）─────────────────────
  // ────────────────────────────── 入口（entries.ts）──────────────────────────────
  {
    name: 'EXTRACT_WEIGHT_CEIL',
    unmovable: '对象组',
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
    unmovable: '内联',
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
    unmovable: '非数值',
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
    name: 'ENTRY_WEIGHT',
    unmovable: '对象组',
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
  // ────────────────────── learned 反哺（entries.ts，T17）──────────────────────
  //
  // 这一组全部来自设计报告 §27「防抖六条」，**没有一条在本库上标定过** —— 每条的 evidence
  // 都如实这么写。本机也没有可比的对照：反哺的效果要几十次真实召回才显现，那需要一段
  // 真实使用期，不是一次探针能造出来的。
  // ──────────────────────────── 召回融合（search.ts）────────────────────────────
  {
    name: 'CHANNEL_WEIGHT',
    unmovable: '对象组',
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
    name: 'AFFILIATION',
    unmovable: '对象组',
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
  // ────────────────────────────── 注入（view.ts）───────────────────────────────
  {
    name: 'SEGMENT_RATIO',
    unmovable: '对象组',
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
    name: 'TRIM_ORDER',
    unmovable: '非数值',
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
    name: 'TIER_SCALE_MIN_ATOMS',
    unmovable: '外部包',
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
    unmovable: '外部包',
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
    unmovable: '外部包',
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
    name: 'TIER_ANCHOR_CAP',
    unmovable: '对象组',
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
    unmovable: '对象组',
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
  // ENTRY_LABEL_CHARS 已并入 TOPIC_LABEL_CHARS（同一个量：主题标签的宽度），
  // 见「落位」一节的 TOPIC_LABEL_CHARS 行。
  // ────────────────────────────── 目录（list.ts）───────────────────────────────
  // ────────────────────── 迁移切分（migrate/split.ts）─────────────────────────
  // ───────────────── 写入侧审核（pipeline/review.ts，M3-T22）─────────────────
  // ──────────────────────── 资源参数（util/memory.ts）─────────────────────────
  // ─────────────────── 显式删除（forget.ts，T20 / §44）───────────────────────
  // ────────────────────────────── 重聚类（T16）──────────────────────────────
  // ────────────────────────────── 图扩展（graph/infer.ts）──────────────────────────────
  // ────────────────────────────── 降级日志（src/log/）──────────────────────────────
  //
  // 这一组的取值由用户决定，不是语料标定：日志的容量参数
  // 取决于「降级事件多久发生一次、一条多长」，而本仓库还没有这份实测。
  // 按本表纪律，这里如实写「未标定」，而不是编一个看起来有依据的场景。
  // ──────────────────────────── 校准样本（src/samples/）────────────────────────────
  //
  // 这一组的取值由用户决定，不是语料标定：样本库的容量与
  // 负样本分档取决于「一次会话里模型会反馈几次」，本仓库还没有这份实测。
  // 按本表纪律，如实写「未标定」，而不是编一个看起来有依据的场景。
  // ──────────────────────── 重标触发（calibration/trigger.ts）────────────────────────
  {
    name: 'RECALIBRATE_MIN_ATOMS',
    unmovable: '派生自外部包',
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
    name: 'MIN_VOCAB_FOR_DF',
    unmovable: '静态读不出',
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
    name: 'LEARNED_PROMOTE_MAX_WEIGHT',
    unmovable: '静态读不出',
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

/**
 * 声明可复算、却缺编码模型或语料规模的条目。公式条目跳过：公式的条件由代码本身承担。
 *
 * 三个查询都不给默认值，必须显式传 `entries`：T65 之后 `THRESHOLDS` 只剩 20 条例外条目，
 * 默认成它会让调用方静默漏掉搬到常量定义处的那 117 条。漏掉的结果是清单变短，看起来像
 * 「缺口都补完了」—— 测试曾因此全绿，而命令行在同一份代码上三条全部报错（0.4.1 修复）。
 */
export function needsReviewEntries(entries: readonly ThresholdEntry[]): ThresholdEntry[] {
  return entries.filter((e) => {
    const o = e.calibration?.origin
    return (
      o?.kind === 'recheckable' && o.formula !== true && o.encoderModel === undefined && o.scale === undefined
    )
  })
}

/** 没有测试按常量名断言默认值的条目。 */
export function unguardedEntries(entries: readonly ThresholdEntry[]): ThresholdEntry[] {
  return entries.filter((e) => {
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
export function undatedEntries(entries: readonly ThresholdEntry[]): ThresholdEntry[] {
  return entries.filter((e) => {
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
/**
 * 留在表里的条目必须说明为什么没搬走（T65 阶段 4）。
 *
 * 表里只剩搬不动的条目：能挂 `satisfies ThresholdValue<…>` 的都在常量定义处。这条断言把
 * 「往表里加一条」变成一个要回答问题的动作 —— 而绝大多数时候，答得出来就意味着该搬到定义处。
 */
export function unmovableProblems(entries: readonly ThresholdEntry[] = THRESHOLDS): string[] {
  const allowed = new Set<ThresholdUnmovable>([
    '内联',
    '非数值',
    '静态读不出',
    '外部包',
    '派生自外部包',
    '对象组',
  ])
  const problems: string[] = []
  for (const e of entries) {
    if (e.unmovable === undefined) {
      problems.push(
        e.name +
          '：留在表里，但没写 unmovable —— 说明它为什么搬不到常量定义处（' +
          [...allowed].join(' / ') +
          '）',
      )
      continue
    }
    if (!allowed.has(e.unmovable)) {
      problems.push(e.name + '：unmovable 的值不认识 ' + e.unmovable)
    }
  }
  return problems
}

export function displayProblems(entries: readonly ThresholdEntry[] = THRESHOLDS): string[] {
  return entries
    .filter((e) => typeof e.display === 'string' && e.display.includes('='))
    .map((e) => e.name + '：display 是字面量且含「=」，等式会与常量脱钩 —— 改成函数，用模板字符串从常量插值')
}

/**
 * 声明了分叉，就必须真的还在分叉（T55）：`design.default` 与当前值相等 = 分叉已经不存在。
 *
 * 这是唯一能把「代码改回去了、记录没跟着改」变成可见的办法。只认数值条目 —— 对象型阈值组
 * 没法用一个数表达分叉，写在它们上面会是一条永远成立的断言（等于没写），所以也报。
 *
 * 文档值只从 `design.default` 读（T65 阶段 3 批 2 删掉了 `divergence.docValue`）：同一件事实
 * 记两处，改一处漏一处就是漂移，而当时那条「两处必须相等」的断言只在有人改了其中一处时才红。
 * 所以现在缺 `design` 也报 —— 没有文档值可比，这条分叉等于没有判据。
 */
export function divergenceProblems(entries: readonly ThresholdEntry[] = THRESHOLDS): string[] {
  const problems: string[] = []
  for (const e of entries) {
    if (e.divergence === undefined) continue
    const v = currentValue(e)
    if (typeof v !== 'number') {
      problems.push(e.name + '：divergence 只用于数值条目，当前值不是数字')
      continue
    }
    if (e.design === undefined) {
      problems.push(e.name + '：写了 divergence 但没有 design —— 文档值从 design.default 读，缺了无从比对')
      continue
    }
    if (e.design.default === v) {
      problems.push(
        e.name + '：design.default（' + e.design.default + '）与代码值相同 —— 分叉已不存在，删掉这条',
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
export function reviewBaselineProblems(
  baseline: ReviewBaseline,
  inventory: ReviewInventory,
  entries: readonly ThresholdEntry[] = THRESHOLDS,
): string[] {
  const frozen = new Set(inventory.names)
  const problems: string[] = []
  const queries: readonly (readonly [keyof ReviewBaseline, ThresholdEntry[]])[] = [
    ['needsReview', needsReviewEntries(entries)],
    ['unguarded', unguardedEntries(entries)],
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

/**
 * 冻结名册与「已知名字」的一致性：名册里的每个名字都必须真实存在。
 *
 * 为什么单独一个函数：`knownNames` 来自「登记表 + 常量定义处的 satisfies」（T65 的双来源），
 * 这一层由打印脚本提供；基线自身的四条规则不依赖它。分成两个函数之后，基线规则可以纯函数单测，
 * 名册检查跟着数据来源走。
 */
export function inventoryProblems(inventory: ReviewInventory, knownNames: ReadonlySet<string>): string[] {
  const problems: string[] = []
  for (const name of inventory.names) {
    if (!knownNames.has(name)) {
      problems.push('冻结名册里的 ' + name + ' 不在登记表里 —— 条目改了名或删了，名册要一起改')
    }
  }
  return problems
}

/** 对象型阈值组的子键在打印时各占一行（整对象一个值不可比对、也无法逐项标定）。 */
export function subKeys(entry: ThresholdEntry): readonly string[] {
  return entry.group ?? []
}

/** 取当前值：值仍在原处，这里只是现取。 */
export function currentValue(entry: ThresholdEntry): EntryValue {
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

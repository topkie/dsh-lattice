// dsh-lattice（记忆晶格）— DSH 记忆插件：无 LLM 依赖，本地向量检索 + Atom 级结构化记忆。
//
// 插件只做两件事：
//   1. 导出符合 Cordis 契约的接口（name / inject / Config / apply）
//   2. 注册五个工具：ping（健康检查）、write、recall、expand、list
//      （`lattice_feedback` 的工具定义仍在 src/tools/index.ts 里，但未注册给模型）
//
// 外加十二条路由给浏览器半用（见 apply 里的注释与文件尾的 handler）：
//   /api/lattice-ping-mini      库的规模（最小实跑留下的座位验证，实测通过的那条基线）
//   /api/lattice-atoms          目录：分页 + 过滤，与 lattice_list 同一条数据路径（**不含正文**）
//   /api/lattice-atom           详情：按 id 取一条的全文（点开才取；只读，与工具无关）
//   /api/lattice-search         搜索：与 lattice_recall 同一条数据路径，但**不记命中**
//   /api/lattice-audit          体检：只读结构指标，供面板与维护者（不进模型侧）
//   /api/lattice-log-export     降级日志导出：只读，返回 CSV 附件
//   /api/lattice-forget         **删除**：物理删除 + 留痕（§44）。写端点
//   /api/lattice-log-clear      清空降级日志：写端点，要求 { confirm: true }
//   /api/lattice-archive        **归档**：置 flags 的 bit4，内容不删。写端点
//   /api/lattice-unarchive      取消归档：清 bit4，恢复默认可见。写端点
//   /api/lattice-split-confirm  确认某条待拆分：清 bit0 + 记一条状态。写端点
//   /api/lattice-split-ignore   忽略某条待拆分：清 bit0 + 写日志。写端点
//
// 六条只读路由的栅栏只留「本机回环」一道；六条写端点三道（回环 + POST +
// application/json）。差别与依据见 guardReadOnly / guardWrite 的注释。
//
// `lattice_forget` **不在模型可见的工具表**里（§11.1：物理删除归用户，模型只能提议）。
// 这个动作只有一个入口：用户在界面上点删除。
//
// **只有工具，没有 hook**：禁用 LLM 后「轮次结束自动沉淀」必然要调 LLM 做结构化，
// 与本插件的定位冲突。写入与召回都必须是显式动作。

import { existsSync, readFileSync } from 'node:fs'
import type { ThresholdValue } from './threshold-types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { deriveResourceParams } from './util/memory.js'
import { cacheUsage } from './cache-usage.js'
import { clearLog, closeLog, configureLog, exportLogCsv } from './log/index.js'
import {
  getRuntime,
  noteRecallDegradations,
  resolveDataDir,
  runtimeEncode,
  type RuntimeConfig,
} from './state.js'
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, listAtoms, listAtomsByIds } from './pipeline/list.js'
import { atomDetail } from './pipeline/detail.js'
import { audit, noDataReport } from './pipeline/audit.js'
import { recall } from './pipeline/search.js'
import { DEFAULT_BUDGET } from './pipeline/view.js'
import { DEFAULT_THRESHOLDS } from './pipeline/write.js'
import { openVault } from './db/open.js'
import { forgetAtom } from './pipeline/forget.js'
import { setArchived } from './pipeline/archive.js'
import { confirmSplit, ignoreSplit } from './pipeline/split.js'
import { clearLearned } from './pipeline/entries.js'
import {
  cancelRecluster,
  clearPlanTimer,
  executePlannedRecluster,
  hasPendingPlan,
  planRecluster,
  readReclusterState,
  resumeIfPending,
} from './cluster/executor.js'
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
 * 浏览器半 fetch 的只读路径。
 *
 * 与浏览器半 `lib/client.js` 里的 `PING_URL` 必须同值 —— 两侧各写一遍是有意的：
 * 浏览器半是发布产物（不参与 tsc 构建、不能 import 本文件），共享一个常量需要一个
 * 构建步骤，而那正是本次要避免的东西。改这里就要改那里。
 */
const MINI_ROUTE_PATH = '/api/lattice-ping-mini'

/**
 * 目录路由：分页 + 过滤，界面上的「列表」。
 *
 * 与搜索分成两条而不是一条带开关的路由：两者回答的是不同的问题 ——
 * 「库里有什么」不需要查询词、要能翻页；「定位到某一条」需要查询词、按相关性排。
 * 合成一条会让参数表变成两种语义的并集，比两条路由更难读。
 */
const ATOMS_ROUTE_PATH = '/api/lattice-atoms'

/**
 * 详情路由：按 id 取一条记忆的**全文**。
 *
 * 为什么另开一条路由，而不是给目录路由加一个 text 字段：
 *   1. 列表不带正文本身是一条判据（目录行按上下文预算设计，界面复用它不等于人对正文
 *      也有那个预算）。加了字段就没有「列表不带正文」这件事了。
 *   2. 预取更贵：一页 20 条、库里有几百条时，打开列表就是几百 KB 的正文，而人通常
 *      只看两条。点开才取是流量与上下文两笔预算的同一个答案。
 *
 * 栅栏与其余只读路由一致（guardReadOnly：回环 + GET），**没有任何写能力**：
 * 参数只有一个 id，没有动作参数、没有请求体。
 */
const ATOM_ROUTE_PATH = '/api/lattice-atom'

/** 搜索路由：一条查询进去，若干条命中出来。 */
const SEARCH_ROUTE_PATH = '/api/lattice-search'

/**
 * 体检路由：只读结构指标。
 *
 * 为什么是路由而不是工具：体检是维护/诊断动作，不在模型的工作流里；
 * 结构指标又只作参考，工具化等于把参考值直接递给模型、容易被读成结论。
 * 面板只做展示，口径与数据都在 pipeline/audit.ts 这一处。
 */
const AUDIT_ROUTE_PATH = '/api/lattice-audit'

/**
 * 删除路由：界面上唯一的删除入口（§11.1：物理删除归用户）。
 *
 * 为什么必须是一个写端点而不是工具：模型只能**提议**删除。`lattice_forget` 因此不进
 * 模型可见的工具表（表达方式见 tools/index.ts 里那段注释），删除这个动作只能由用户
 * 在界面上点出来。
 */
const FORGET_ROUTE_PATH = '/api/lattice-forget'

/**
 * 归档 / 恢复路由：只改 `atom.flags` 的 bit4。
 *
 * 为什么不是工具、也不加模型侧参数：设计说明 §11.1 把三权分开 —— 「是否仍然有效」
 * 归模型（写入时声明 supersedes），「失效后是否还要被检索到」归插件（这一位），
 * 「物理删除」归用户。归档是可见性动作，模型侧多一个动作就等于让模型替用户决定
 * 什么该消失；工具表因此仍是六个。
 *
 * 为什么两条路由而不是一条 `{ archived: true/false }`：动作方向写进路径，日志与
 * 界面调用都不必再解释一个布尔值的含义；两条路由共用一个 handler，不存在第二套实现。
 */
const ARCHIVE_ROUTE_PATH = '/api/lattice-archive'
const UNARCHIVE_ROUTE_PATH = '/api/lattice-unarchive'

/**
 * 拆分候选的两个决定：确认 / 忽略。
 *
 * 为什么不是工具、也不加模型侧参数：这两个动作是**人的判断**。写入时的切分是自动的，
 * 但「这条到底该不该拆」要读内容，而读内容作判断正是模型侧不该被要求做的事（§11.1：
 * 插件不做判断，只提供判断所需的信息）。模型侧因此仍是五个工具（`lattice_feedback` 的工具定义仍在 src/tools/index.ts 里，但未注册给模型）。
 *
 * 为什么两条路由而不是一条 `{ confirmed: true/false }`：与归档 / 恢复同一条理由 ——
 * 动作方向写进路径，日志与界面调用都不必再解释一个布尔值的含义；两条共用一个 handler。
 *
 * **两者都不执行拆分**：只清 bit0（确认另记一条状态），正文、条数、入口与边
 * 一律不动。执行拆分要动 topic 归属与入口迁移，设计里没有定义，留给后续任务。
 */
const SPLIT_CONFIRM_ROUTE_PATH = '/api/lattice-split-confirm'
const SPLIT_IGNORE_ROUTE_PATH = '/api/lattice-split-ignore'

/**
 * 整理入口的两条写路由：规划与取消。
 *
 * 为什么是两条而不是一条带动作参数：与归档 / 恢复同一条理由 —— 动作方向写进路径。
 * 但这里共用同一个 handler 而不是两份：两者的差别只是调哪个函数，而栅栏、读体、回执形状
 * 完全一样，拆成两份会让「两边行为应当对称」变成要靠比对两份代码来验证的话。
 *
 * **状态不在这两条里报**：它并入体检路由（`/api/lattice-audit` 的 `recluster` 字段），
 * 因为界面在打开面板时本来就要拉一次体检，多一条只读路由只会多一次请求。
 */
const RECLUSTER_PLAN_ROUTE_PATH = '/api/lattice-recluster-plan'
const RECLUSTER_CANCEL_ROUTE_PATH = '/api/lattice-recluster-cancel'

/**
 * 清空「学到的入口」。
 *
 * 它删的是**数据**（召回反哺学到的入口词），不可撤销，但可以重新长出来 —— 再走几次召回
 * 就有了，只是长回来的是新词。所以它比删除记忆轻、比归档重：要给，但要有两道确认，
 * 而且按钮上要写清将删掉多少条。
 */
const LEARNED_CLEAR_ROUTE_PATH = '/api/lattice-learned-clear'

/**
 * 降级日志的导出路由：只读。
 *
 * 为什么放在界面上而不是工具里：导出是给人看的动作；模型侧多一个「读日志」的工具
 * 会扩大工具面（六工具已定案），也会把日志内容塞进上下文 —— 两者都不是设计要的。
 */
const LOG_EXPORT_ROUTE_PATH = '/api/lattice-log-export'

/** 清空日志：写端点。破坏性动作只能由用户从界面发起（与删除同一条纪律）。 */
const LOG_CLEAR_ROUTE_PATH = '/api/lattice-log-clear'

/**
 * 请求体上限。删除请求只有一个整数 id，几百字节足够。
 *
 * 为什么要有：`readJson` 是**累积**式的，没有上限就意味着任何能连上回环的人都能让宿主
 * 为一个请求堆任意大的字符串。回环不是「可信」，只是「本机」（宿主对插件路由不做鉴权）。
 */
const FORGET_BODY_MAX_BYTES = 4096 satisfies ThresholdValue<
  'chosen',
  {
    area: '显式删除'
    why: '无记录，是资源上限：删除请求只有一个整数 id，几百字节足够；读请求体是累积式的，没有上限就等于允许任何本机进程让宿主堆任意大的字符串（回环不是「可信」，只是「本机」—— 宿主对插件路由不做鉴权）'
    failsWhen: ['请求体里要不要带更多字段']
    guardedBy: ['test/plugin.test.mjs']
    affects: '删除端点（唯一的写路由）接受的请求体上限'
  }
>

/**
 * 插件配置 schema。
 *
 * 阈值默认值：向量余弦与词面重叠必须**同时**满足，才允许并入已有主题。
 *
 * 为什么需要两票：在技术类文本上，不同主题的余弦相似度可以高达 0.73，而同一主题
 * 最低约 0.75——区间重叠，单靠余弦会把不同主题静默合并。词面重叠的区分度更高，
 * 两者互补。这些值是初值，应随真实语料重新标定。
 */
/**
 * 默认编码模型。
 *
 * 这个字符串原先写了两遍（zod 的 `default` 与运行时兜底各一份）—— 同一份默认值两处定义，
 * 改一处就会让「配置里没写」与「运行时兜底」给出不同模型。现在只有这一份。
 */
const DEFAULT_ENCODER_MODEL = 'Xenova/bge-small-zh-v1.5'

/**
 * 交注入层的默认候选数。
 *
 * 与 `pipeline/search.ts` 的 `RECALL_TOP_N`、写入侧的 `DEFAULT_TOP_N` 同为 24，但**不是同一个量**：
 * 那个是 `recall()` 自己的兜底，这个是**配置项 topN 的默认值**（运行时真正生效的是后者），
 * 第三个是落位时取多少个 topic 候选。三者同值纯属巧合 —— 合并会把「改注入条数」变成
 * 「改 recall 的默认参数」或「改落位候选数」。
 *
 * 名字带上了配置项前缀（阶段 3 批 2 改）：它与写入侧的常量同名不同量，搬到定义处后
 * 打印表里会出现两行同名条目，读的人分不清哪一行是哪一个。
 */
const CONFIG_TOP_N_DEFAULT = 24 satisfies ThresholdValue<
  'chosen',
  {
    area: '召回融合'
    why: '配置项 topN 的默认条数：容量选择，没有测量给出它；与设计说明 §7 的 topN 默认值一致，但这条记录的是「配置入口的默认值」，文档对照那一条在 RECALL_TOP_N 上'
    failsWhen: ['注入字符预算', '一次注入能容纳的摘要条数']
    affects: 'Config.topN 的默认值；调用方不传 topN 时，召回交注入层的条数'
    diverges: '**与 RECALL_TOP_N、写入侧 DEFAULT_TOP_N 同为 24、不同量**：这条是配置项的默认值，改它等于改「默认注入多少条」；另两条分别是 recall 的兜底参数与落位候选数'
  }
>

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 数据目录；留空表示 <数据目录>/lattice */
  dataDir: z.string().default(''),
  /** 关掉即纯词面模式（降级路径） */
  encoderEnabled: z.boolean().default(true),
  encoderModel: z.string().default(DEFAULT_ENCODER_MODEL),
  /** 模型下载源；留空用官方源，网络受限环境可指向镜像 */
  encoderMirror: z.string().default(''),
  /** 模型缓存目录；留空用运行时默认位置 */
  encoderCacheDir: z.string().default(''),
  /** 并入阈值（余弦） */
  tauJoin: z.number().min(0.6).max(0.95).default(DEFAULT_THRESHOLDS.tauJoin),
  /** 并入所需的词面重叠（bigram-Jaccard；实测标定依据见 pipeline/write.ts） */
  tauLex: z.number().min(0.02).max(0.5).default(DEFAULT_THRESHOLDS.tauLex),
  /** 无向量（encoder 降级）时并入所需的词面重叠 */
  tauLexOnly: z.number().min(0.02).max(0.6).default(DEFAULT_THRESHOLDS.tauLexOnly),
  /** 新建主题阈值 */
  tauNew: z.number().min(0.2).max(0.8).default(DEFAULT_THRESHOLDS.tauNew),
  /** 注入字符预算 */
  viewBudget: z.number().min(1000).max(20000).default(DEFAULT_BUDGET),
  /** 交注入层的候选数 */
  topN: z.number().min(5).max(50).default(CONFIG_TOP_N_DEFAULT),
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
 * 本插件用到的宿主服务切片。
 *
 * 为什么手写窄接口：这两个服务由宿主插件提供（`tools` 来自 dsh-tools，`webServer` 来自
 * dsh-host-webserver），它们的服务类型不在本仓库的编译范围内 —— 与本插件同装的只有
 * cordis 本身。写成接口而不是 `any`，是为了让「插件依赖宿主的哪一部分」可读、可查；
 * 真正的契约由**运行期**保证：拿不到服务时下面的守卫会直接返回（见 apply 里那两处）。
 *
 * 与 `Context.get()` 的关系：_getImpl 的返回就是 `any`（reflect.d.ts），所以这两个断言
 * 不是在推翻宿主的类型，而是在给一个本来就没有类型的位置补上本插件自己的口径。
 */
interface HostServices {
  /** 工具注册表；register 的入参形状由模块声明（src/modules.d.ts）给出。 */
  tools: { register(definition: unknown): unknown }
  /** 宿主 Web 服务；本插件只用 exact 路由这一小块。 */
  webServer: { register(route: { kind: string; path: string; handler: RouteHandler }): () => void }
}

/**
 * 读一个宿主服务：拿不到就返回 undefined（由调用方决定是跳过还是等注入）。
 *
 * 唯一的 `as` 在这里，而不是散在每个消费点上：`ctx.get()` 的返回本来就是 `any`
 * （reflect.d.ts），能给的类型只有本插件自己声明的 HostServices —— 把转换收在一处，
 * 读的人一眼能看到「哪些名字属于宿主、名字写错时哪个函数负责兜底」。
 */
function hostService<K extends keyof HostServices>(ctx: Context, name: K): HostServices[K] | undefined {
  return ctx.get(name) as HostServices[K] | undefined
}

/** 插件路由的处理器签名。宿主按 (req, res) 调用，用的是 node:http 的对象。 */
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * 插件入口。Cordis 在插件激活时调用一次。
 *
 * 注意：这里只做**注册**，不做重活——模型加载、索引构建等放到首次调用时懒执行，
 * 避免拖慢宿主启动。
 *
 * `config` 的类型仍是 `unknown`：它的形状由本文件的 Config schema 定义，而 z 的表在编译期
 * 是宽口径（见 src/modules.d.ts）—— 所以下面读 cfg.xxx 时每个取值都自己给了默认值。
 */
export function apply(ctx: Context, config: unknown): void {
  const cfg = (config ?? {}) as Record<string, unknown>
  if (cfg.enabled === false) return

  const tools = hostService(ctx, 'tools')
  if (tools === undefined) return

  // 三个业务工具。注册只是挂上定义，真正的库连接与模型加载都等到第一次调用
  // （见 state.ts 的 getRuntime / runtimeEncode）—— 注册路径上不做重活。
  const runtimeCfg: RuntimeConfig = {
    dataDir: String(cfg.dataDir ?? ''),
    encoderEnabled: cfg.encoderEnabled !== false,
    encoderModel: String(cfg.encoderModel ?? DEFAULT_ENCODER_MODEL),
    encoderMirror: String(cfg.encoderMirror ?? ''),
    encoderCacheDir: String(cfg.encoderCacheDir ?? ''),
    thresholds: {
      tauJoin: Number(cfg.tauJoin ?? DEFAULT_THRESHOLDS.tauJoin),
      tauLex: Number(cfg.tauLex ?? DEFAULT_THRESHOLDS.tauLex),
      tauLexOnly: Number(cfg.tauLexOnly ?? DEFAULT_THRESHOLDS.tauLexOnly),
      tauNew: Number(cfg.tauNew ?? DEFAULT_THRESHOLDS.tauNew),
    },
    viewBudget: Number(cfg.viewBudget ?? DEFAULT_BUDGET),
    topN: Number(cfg.topN ?? CONFIG_TOP_N_DEFAULT),
    resources: {
      mmapSize: Number(cfg.mmapSize ?? 0) > 0 ? Number(cfg.mmapSize) : undefined,
      cacheSize: Number(cfg.cacheSize ?? 0) > 0 ? Number(cfg.cacheSize) : undefined,
      busyTimeout: Number(cfg.busyTimeout ?? 0) > 0 ? Number(cfg.busyTimeout) : undefined,
    },
  }
  for (const t of buildTools(runtimeCfg)) tools.register(t)

  // 日志库随插件卸载一起收走：先 flush 队列再关连接（见 src/log/index.ts 的 closeLog）。
  // 放在这里而不是 webServer 的子 fiber 里：没有界面的 profile 也要正常关闭日志库。
  ctx.effect(() => () => closeLog(), 'dsh-lattice: log flush')

  // ── 浏览器半的座位（最小验证） ─────────────────────────────────────────
  //
  // 这段代码本身不是功能，是**验证**：宿主的设置页里能不能出现一个属于本插件的区块、
  // 区块里的 fetch 能不能打到本插件后端的路由。路由只读、无请求体，返回库的规模。
  //
  // 为什么**不**把 'webServer' 写进本文件的 inject：本文件的 inject 是整个插件的
  // **激活条件** —— 加进去之后，没有 Web 载体的 profile 里插件根本不激活，连工具一起没。
  //
  // 为什么**也**不是「ctx.get('webServer') 拿一次，拿不到就算了」：cordis 的 ctx.get
  // 读的是一次快照，且只认**已激活**的提供者（reflect.ts 的 _getImpl 在 strict 下要求
  // impl.fiber.state === ACTIVE），而 loader 是**并发**启动所有顶层条目的
  // （plugin-loader 的 config/group.ts：Promise.all 一把 create）。webServer 的 fiber 要等
  // [Service.init] 里 server.listen 落地才转 ACTIVE，于是 apply 走到那里时常常拿到
  // undefined —— 静默跳过、路由永不注册。重启实测的 404 就是这个形态；
  // 复现见路由注册探针（真 cordis 4.0.4，场景 1）。
  //
  // ctx.inject(deps, callback) 起的是一个**子 fiber**（registry.ts：inject 就是
  // plugin({ inject, apply })），激活条件只挂在子 fiber 上：webServer 缺席时它停在 PENDING、
  // 零副作用，父插件照常激活；webServer 一出现它才执行回调把路由挂上；它是父 fiber 的一个
  // effect，父插件卸载时随之一并收走 —— 所以不必把 'webServer' 写进模块级 inject。
  // 回调拿到的子上下文与父上下文同型；webServer 在这里**必然存在**（它就是激活条件），
  // 所以用 hostService 取一次并断言非空 —— 与 apply 开头那处「拿不到就跳过」不同，
  // 这里拿不到只可能是宿主契约变了，那时早失败比挂一条路由到 undefined 上好。
  ctx.inject(['webServer'], (ctx: Context) => {
    const webServer = hostService(ctx, 'webServer')!
    // 这些路由同生同灭，所以共用**一个** effect、返回一个合并的 disposer：
    // 分开写会长出三段一模一样的样板。ping 那条仍然是实测通过的基线，只是
    // 外形跟着一起规整，函数体（miniPing）不动。
    ctx.effect(() => {
      const disposers = [
        webServer.register({
          kind: 'exact',
          path: MINI_ROUTE_PATH,
          handler: (req, res) => miniPing(runtimeCfg, req, res),
        }),
        webServer.register({
          kind: 'exact',
          path: ATOMS_ROUTE_PATH,
          handler: (req, res) => atomsRoute(runtimeCfg, req, res),
        }),
        // 详情与目录是两条路由而不是一条带开关的：目录要分页、详情要整段正文，
        // 合成一条会让「带不带正文」变成一个参数，而「列表不带正文」是要能一眼看出的。
        webServer.register({
          kind: 'exact',
          path: ATOM_ROUTE_PATH,
          handler: (req, res) => atomRoute(runtimeCfg, req, res),
        }),
        webServer.register({
          kind: 'exact',
          path: SEARCH_ROUTE_PATH,
          handler: (req, res) => searchRoute(runtimeCfg, req, res),
        }),
        webServer.register({
          kind: 'exact',
          path: AUDIT_ROUTE_PATH,
          handler: (req, res) => auditRoute(runtimeCfg, req, res),
        }),
        webServer.register({
          kind: 'exact',
          path: LOG_EXPORT_ROUTE_PATH,
          handler: (req, res) => logExportRoute(runtimeCfg, req, res),
        }),
        webServer.register({
          kind: 'exact',
          path: FORGET_ROUTE_PATH,
          handler: (req, res) => forgetRoute(runtimeCfg, req, res),
        }),
        webServer.register({
          kind: 'exact',
          path: LOG_CLEAR_ROUTE_PATH,
          handler: (req, res) => logClearRoute(runtimeCfg, req, res),
        }),
        // 归档与恢复共用同一个 handler：差别只有一个布尔值，分成两份实现只会让
        // 「两边行为应当对称」变成一句要靠比对两份代码来验证的话。
        webServer.register({
          kind: 'exact',
          path: ARCHIVE_ROUTE_PATH,
          handler: (req, res) => archiveRoute(runtimeCfg, req, res, true),
        }),
        webServer.register({
          kind: 'exact',
          path: UNARCHIVE_ROUTE_PATH,
          handler: (req, res) => archiveRoute(runtimeCfg, req, res, false),
        }),
        // 拆分候选的两个决定共用同一个 handler，理由同归档 / 恢复。
        webServer.register({
          kind: 'exact',
          path: SPLIT_CONFIRM_ROUTE_PATH,
          handler: (req, res) => splitRoute(runtimeCfg, req, res, true),
        }),
        webServer.register({
          kind: 'exact',
          path: SPLIT_IGNORE_ROUTE_PATH,
          handler: (req, res) => splitRoute(runtimeCfg, req, res, false),
        }),
        // 整理入口：规划 / 取消共用同一个 handler，理由见 RECLUSTER_* 常量的注释。
        webServer.register({
          kind: 'exact',
          path: RECLUSTER_PLAN_ROUTE_PATH,
          handler: (req, res) => reclusterRoute(runtimeCfg, req, res, 'plan'),
        }),
        webServer.register({
          kind: 'exact',
          path: RECLUSTER_CANCEL_ROUTE_PATH,
          handler: (req, res) => reclusterRoute(runtimeCfg, req, res, 'cancel'),
        }),
        webServer.register({
          kind: 'exact',
          path: LEARNED_CLEAR_ROUTE_PATH,
          handler: (req, res) => learnedClearRoute(runtimeCfg, req, res),
        }),
      ]
      bootResume(runtimeCfg)
      return () => {
        // 挂着的延迟必须清掉：它闭包里有 db 句柄，插件卸载后还会到点开火。
        clearPlanTimer()
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-lattice: web routes')
  })

  tools.register(
    defineTool({
      name: 'lattice_ping',
      description: '健康检查：插件版本与配置摘要。',
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
          mmapSize: Number(cfg.mmapSize ?? 0) > 0 ? Number(cfg.mmapSize) : undefined,
          cacheSize: Number(cfg.cacheSize ?? 0) > 0 ? Number(cfg.cacheSize) : undefined,
          busyTimeout: Number(cfg.busyTimeout ?? 0) > 0 ? Number(cfg.busyTimeout) : undefined,
        })
        // 健康检查会**初始化运行时**（与其它工具同一条路径）：缓存占用与阈值都要从运行时的
        // 连接上现读。代价是首次 ping 可能触发建库 —— 那与第一次写入是同一件事。
        const rt = getRuntime(runtimeCfg)
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
          // 五处模块级缓存的实时占用：只报数，且**每次现读**。口径与「为什么
          // 不触发重建」写在 cache-usage.ts 的文件头 —— 这里只负责把读数摆出来。
          caches: cacheUsage(rt.db),
        })
      },
    }),
  )
}

/** 写一个 JSON 响应。插件自己的路由拿不到宿主任何免费保护，头也自己写。 */
function jsonOut(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * 浏览器半唯一的取数口：库现在有多少条 atom。
 *
 * **只读**：不碰编码器、不写库、不改状态；走的是与 lattice_list 同一条读取路径
 * （state.ts 的 getRuntime + pipeline/list.ts 的 listAtoms），没有另造一套。
 *
 * 栅栏只保留「本机回环」一条。为什么少了另外两条（对照本机同类的双面插件）：
 * 那两条是给**写**路由防 CSRF 用的 —— 要求 POST 与 application/json，是为了挡掉
 * 跨站的「简单请求」。本路由无请求体、且只读：跨站页面即使发得出去，也读不到响应
 * （插件路由不带任何 CORS 头）。回环这条仍然要留：宿主对插件路由不做鉴权
 * （见 dsh-host-webserver 的说明），而这条路由会把记忆库的规模报给任何能连上的人。
 */
function miniPing(cfg: RuntimeConfig, req: IncomingMessage, res: ServerResponse): void {
  const remote = req?.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) {
    jsonOut(res, 403, { ok: false, error: 'forbidden', message: '仅允许本机回环请求' })
    return
  }
  if (req.method !== 'GET') {
    jsonOut(res, 405, { ok: false, error: 'method', message: '仅支持 GET' })
    return
  }
  try {
    const rt = getRuntime(cfg)
    jsonOut(res, 200, {
      ok: true,
      plugin: name,
      version: VERSION,
      // 规模含已归档：这一项回答的是「库有多大」，不是「默认列表有多少条」。
      // 用默认口径会让归档悄悄改变库的规模读数 —— 而归档什么都没删。
      atoms: listAtoms(rt.db, { limit: 1, includeArchived: true }).total,
    })
  } catch (e) {
    // 读库失败要说出来 —— 页面上一句「取数失败」比空白更能定位问题。
    jsonOut(res, 500, { ok: false, error: 'read-failed', message: String((e as Error)?.message ?? e) })
  }
}

/** 异常的短说法。三条路由共用一句「把失败说出来」，不共用格式。 */
function reasonOf(e: unknown): string {
  return String((e as Error)?.message ?? e)
}

/**
 * 只读路由的栅栏：非回环 403、非 GET 405。顺序是先回环后方法 —— 外来的请求连
 * 「你用什么方法」都不该问。
 *
 * 为什么只有这两道（对照 §44 给写端点准备的那套）：另两道（要求 POST + application/json）
 * 是给**写**路由防 CSRF 的，本组路由无请求体、只读，跨站页面即使发得出去也读不到响应
 * （插件路由不带任何 CORS 头）。回环这道仍然必须留：宿主对插件路由不做鉴权
 * （见 dsh-host-webserver 的说明），而这些路由会把整个记忆库报给任何能连上的人。
 *
 * 与 miniPing 里那段是有意的重复：那条路由是早先实测通过的基线，本轮不动它的函数体。
 */
function guardLoopback(req: IncomingMessage, res: ServerResponse): boolean {
  const remote = req?.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) {
    jsonOut(res, 403, { ok: false, error: 'forbidden', message: '仅允许本机回环请求' })
    return false
  }
  return true
}

/**
 * 只读路由的栅栏：回环 + 只认 GET。
 *
 * 为什么回环那道要单独抽出来：写路由要的是「回环 + 只认 POST」，两者共用回环、
 * 方法那一道方向相反。写成「写栅栏调用只读栅栏」是一次真实的口径错位 —— 那会让写
 * 端点对**每一个** POST 都回 405，也就是写完的写端点根本用不了，而单元测试之外没有
 * 任何东西会喊出来。（本文件里踩过：`guardWrite` 一开始就是那么写的。）
 */
function guardReadOnly(req: IncomingMessage, res: ServerResponse): boolean {
  if (!guardLoopback(req, res)) return false
  if (req.method !== 'GET') {
    jsonOut(res, 405, { ok: false, error: 'method', message: '仅支持 GET' })
    return false
  }
  return true
}

/**
 * 取查询串。
 *
 * 宿主只用 **pathname** 匹配路由（dsh-host-webserver 的 handle：先按 pathname 查表，
 * 查询串不参与匹配），所以 exact 路由天然带着自己的查询串进来，不必自己切分。
 */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(String(req?.url ?? '/'), 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * 整数参数：没给就用默认值，给了但不像整数也退回默认值（不猜），最后钳进 [lo, hi]。
 *
 * 钳位不是礼貌：分页参数直接进 SQL 的 LIMIT/OFFSET，而 URL 是任何能连上的人都能拼的。
 */
function intParam(params: URLSearchParams, key: string, fallback: number, lo: number, hi: number): number {
  const raw = params.get(key)
  const n = raw === null || raw.trim() === '' ? fallback : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.floor(n)))
}

/**
 * 目录：库里有什么。分页 + 过滤，数据全部来自 listAtoms（与 lattice_list 同一条路径，
 * 连页大小上限都是同一个 LIST_MAX_LIMIT）—— 这里是**转发**，不是另一套查询。
 */
function atomsRoute(cfg: RuntimeConfig, req: IncomingMessage, res: ServerResponse): void {
  if (!guardReadOnly(req, res)) return
  const params = queryOf(req)
  try {
    const rt = getRuntime(cfg)
    // includeArchived 是界面上的「显示已归档」勾选：默认不传 = 只看未归档。
    // 它只影响这一条只读路由；`lattice_list` 的显式检索走 flags 位过滤，两者不共用一个参数。
    const r = listAtoms(rt.db, {
      kind: params.get('kind') ?? '',
      origin: params.get('origin') ?? '',
      scope: params.get('scope') ?? '',
      includeArchived: params.get('includeArchived') === '1',
      limit: intParam(params, 'limit', LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT),
      offset: intParam(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
    })
    // limit / offset 原样回给前端：翻页要按**服务端实际用的**页大小算，不能由前端猜。
    jsonOut(res, 200, { ok: true, total: r.total, offset: r.offset, limit: r.limit, rows: r.rows })
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'read-failed', message: reasonOf(e) })
  }
}

/**
 * 详情：按 id 取一条记忆的全文。**只读**，与目录同一套栅栏。
 *
 * 三种失败分开报，因为补救动作不同：id 不合法（400，请求写错了）、库里没有这一条
 * （404，可能刚被删）、读库失败（500，环境问题）。合成一个「失败」会让界面无法解释
 * 「为什么点开是空的」。
 *
 * 为什么没有 limit 参数：详情就是全文。截断是目录的取舍，不是详情的 —— 判据要求
 * 「界面显示的字数与 `length(text)` 差 0」，任何形式的截断都会在这里破掉它。
 */
function atomRoute(cfg: RuntimeConfig, req: IncomingMessage, res: ServerResponse): void {
  if (!guardReadOnly(req, res)) return
  const params = queryOf(req)
  const id = intParam(params, 'id', 0, 0, Number.MAX_SAFE_INTEGER)
  if (id <= 0) {
    jsonOut(res, 400, { ok: false, error: 'id', message: '缺少合法的 id' })
    return
  }
  try {
    const rt = getRuntime(cfg)
    const atom = atomDetail(rt.db, id)
    if (atom === null) {
      jsonOut(res, 404, { ok: false, error: 'not-found', message: '没有这条记忆' })
      return
    }
    jsonOut(res, 200, { ok: true, atom })
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'read-failed', message: reasonOf(e) })
  }
}

/**
 * 体检：只读结构指标。
 *
 * 与其他只读路由的**一处有意的不同**：这里不用 getRuntime，而是自己只读打开库。
 * 三个理由：
 *   - getRuntime 会补库自描述（stampVault）、会写日志库；而体检的契约是
 *     「不改库、不写日志」；
 *   - getRuntime 在库不存在时会建库；体检面对「还没有库」应当报「无数据」，而不是顺手造一个；
 *   - 只读连接不迁移旧库：体检要能读改动前的快照或旧版本库，那正是诊断的用法。
 * 代价是只读连接不能建 inferred 边 —— 那正是要的：体检不触发任何重建。
 *
 * 分页参数在这里只用一次（limit / offset），页大小与上界复用目录的两个数：
 * 体检看的是分布，不允许「一次拉全库」。
 */
function auditRoute(cfg: RuntimeConfig, req: IncomingMessage, res: ServerResponse): void {
  if (!guardReadOnly(req, res)) return
  const params = queryOf(req)
  const opts = {
    limit: intParam(params, 'limit', LIST_DEFAULT_LIMIT, 1, LIST_MAX_LIMIT),
    offset: intParam(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
  }
  const file = join(resolveDataDir(cfg.dataDir), 'lattice.db')
  if (!existsSync(file)) {
    // 没有库不是错误：它表示「还没有写过任何记忆」。必须与「有库、没发现」分开报。
    jsonOut(res, 200, {
      ok: true,
      ...noDataReport(opts, '数据库文件不存在：还没有写入过任何记忆，这是「无数据」，不是「没有发现」。'),
      // 没有库不等于「整理跑过」：四态里报 idle，与有库但没跑过是同一个说法。
      recluster: { phase: 'idle', plannedAt: null, startedAt: null, lastAt: null },
    })
    return
  }
  let db: DatabaseSync | null = null
  try {
    db = openVault(file, { readOnly: true }).db
    // 整理入口的状态并入体检：界面打开面板时本来就要拉一次体检，多一条只读路由只会
    // 多一次请求。`recluster` 由执行器判定（四态，见 cluster/executor.ts）。
    jsonOut(res, 200, { ok: true, ...audit(db, opts), recluster: readReclusterState(db) })
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'read-failed', message: reasonOf(e) })
  } finally {
    try {
      db?.close()
    } catch {
      /* 已经关闭 */
    }
  }
}

/**
 * 搜索：一条查询，若干条命中。走 recall —— 与 lattice_recall 同一条路径，同一套融合与归属加权。
 *
 * **不调 recordRecall**（这是与工具侧唯一的、有意的差别）：那个计数器记的是「被召回并
 * **进入了注入**」，不是「有人在界面上搜了一下」。界面搜索要是也计数，用户自己翻几次
 * 就会把这个数顶上去，而它正是「该管哪条」要看的信号之一 —— 数一旦被自己污染，
 * 归属显示就退回到「一堆等权文本」。
 *
 * 命中条数上限复用 LIST_MAX_LIMIT：搜索结果与目录共用一个上限，界面一屏也放不下更多。
 */
async function searchRoute(cfg: RuntimeConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guardReadOnly(req, res)) return
  const params = queryOf(req)
  const q = String(params.get('q') ?? '').trim()
  if (q === '') {
    jsonOut(res, 400, { ok: false, error: 'query', message: '缺少查询词 q' })
    return
  }
  try {
    const rt = getRuntime(cfg)
    const topN = intParam(params, 'limit', cfg.topN, 1, LIST_MAX_LIMIT)
    // 编码失败不该让整条搜索失败：退到纯词面召回，并把降级原因如实报出去
    // （与工具侧同一条原则：失败不留白，不能让人以为「搜不到」就是「库里没有」）。
    let queryVec: Float32Array | null = null
    let encodeError: string | null = null
    try {
      queryVec = await runtimeEncode(cfg, q)
    } catch (e) {
      encodeError = reasonOf(e)
    }
    const recalled = recall(rt.db, q, queryVec, {
      topN,
      scope: params.get('scope') || undefined,
    })
    // 界面搜索也是一条召回路径，降级同样留痕（只入队，不加 IO）。
    noteRecallDegradations(recalled.meta)
    // recall 的命中只带 origin / supersededBy；「被取回几次、最后什么时候」要向目录模块要。
    const facts = new Map(
      listAtomsByIds(
        rt.db,
        recalled.hits.map((h) => h.id),
      ).map((row) => [row.id, row]),
    )
    jsonOut(res, 200, {
      ok: true,
      query: q,
      hits: recalled.hits.map((h) => {
        const fact = facts.get(h.id)
        return {
          id: h.id,
          summary: h.summary,
          origin: h.origin,
          supersededBy: h.supersededBy,
          topicId: h.topicId,
          score: h.score,
          final: h.final,
          affiliation: h.affiliation,
          kind: fact?.kind ?? '',
          scope: fact?.scope ?? '',
          // 归档位要一起给：界面每行要按它决定画「归档」还是「恢复」。
          flags: fact?.flags ?? 0,
          recallHits: fact?.recallHits ?? 0,
          lastRecalledAt: fact?.lastRecalledAt ?? null,
        }
      }),
      meta: { ...recalled.meta, encodeError },
    })
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'search-failed', message: reasonOf(e) })
  }
}

/**
 * 写端点的栅栏：回环 + 只认 POST + 要求 application/json。
 *
 * 为什么比只读那组多两道（依据见前置调研与修复报告）：只读路由无请求体，
 * 跨站页面即使发得出去也**读不到响应**（插件路由不带任何 CORS 头），所以只留回环即可。
 * 写路由不一样 —— 它不需要读到响应就已经造成了后果。
 *
 * 后两道挡的是**跨站简单请求**：HTML 表单只能发 `application/x-www-form-urlencoded`
 * 或 `text/plain`，`fetch` 想发 `application/json` 就会触发预检，而预检需要 CORS 头，
 * 本插件一个都不给。于是这两道合起来把「跨站页面借用户的浏览器删掉一条记忆」堵死。
 *
 * 顺序仍然是先回环后方法：外来的请求连「你用什么方法」都不该问。
 */
function guardWrite(req: IncomingMessage, res: ServerResponse): boolean {
  if (!guardLoopback(req, res)) return false
  if (req.method !== 'POST') {
    jsonOut(res, 405, { ok: false, error: 'method', message: '仅支持 POST' })
    return false
  }
  const type = String(req.headers?.['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (type !== 'application/json') {
    jsonOut(res, 415, {
      ok: false,
      error: 'content-type',
      message: '仅接受 application/json（跨站表单发不出这个类型）',
    })
    return false
  }
  return true
}

/**
 * 读一个 JSON 请求体。
 *
 * 上限见 `FORGET_BODY_MAX_BYTES`：累积式读取没有上限就等于让任何本机进程为所欲为。
 * 超限**不静默截断** —— 截断的 JSON 解析失败会得到一句「格式不对」，把「你发太大了」
 * 这个真实原因藏起来。
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > FORGET_BODY_MAX_BYTES) {
        reject(new Error('请求体超过 ' + FORGET_BODY_MAX_BYTES + ' 字节'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        // 空体是调用方写错了，不是「删除全部」—— 显式拒绝，不给任何默认动作。
        reject(new Error('请求体为空'))
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error('请求体不是合法 JSON：' + reasonOf(e)))
      }
    })
    req.on('error', (e) => reject(e))
  })
}

/**
 * 删除：物理删除 + 留痕（§44）。
 *
 * 这是本插件唯一的写入口。它不做二次确认（§43：用户点删除 = 完整授权，过闸的对象是
 * **模型的操作**），也没有回收站与恢复（§44：那会把「删除」降级成「暂时挪开」）。
 */
async function forgetRoute(cfg: RuntimeConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guardWrite(req, res)) return
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (e) {
    jsonOut(res, 400, { ok: false, error: 'bad-body', message: reasonOf(e) })
    return
  }
  const raw = (body ?? {}) as Record<string, unknown>
  const atomId = Number(raw.atom_id)
  if (!Number.isInteger(atomId) || atomId <= 0) {
    jsonOut(res, 400, { ok: false, error: 'bad-id', message: 'atom_id 必须是正整数' })
    return
  }
  try {
    const rt = getRuntime(cfg)
    const r = forgetAtom(rt.db, {
      atomId,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    })
    if (r === null) {
      // 404 而不是 200：界面要能区分「删掉了」与「这条本来就不在」。
      jsonOut(res, 404, { ok: false, error: 'not-found', message: '记忆 #' + atomId + ' 不在库里' })
      return
    }
    jsonOut(res, 200, {
      ok: true,
      atomId: r.atomId,
      tombstoneId: r.tombstoneId,
      deletedAt: r.deletedAt,
      kind: r.kind,
      scope: r.scope,
      summary: r.summary,
      alreadyForgotten: r.alreadyForgotten,
    })
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'forget-failed', message: reasonOf(e) })
  }
}

/**
 * 归档 / 恢复：改 flags 的 bit4。
 *
 * 与删除的区别写在 pipeline/archive.ts 的文件头：归档不删内容、不留墓碑、不做防写回。
 * 这里因此没有二次确认（比删除轻），也没有「回收站」这种中间态 —— 归档本身就是那个中间态。
 */
async function archiveRoute(
  cfg: RuntimeConfig,
  req: IncomingMessage,
  res: ServerResponse,
  archived: boolean,
): Promise<void> {
  // 与删除同三道栅栏：归档同样是「不需要读到响应就已经造成后果」的写动作。
  if (!guardWrite(req, res)) return
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (e) {
    jsonOut(res, 400, { ok: false, error: 'bad-body', message: reasonOf(e) })
    return
  }
  const raw = (body ?? {}) as Record<string, unknown>
  // 字段名与删除路由一致（atom_id）；`id` 一并接受，因为这两条路由的请求体只有一个整数，
  // 为名字不同而让调用方猜字段是没必要的失败模式。
  const atomId = Number(raw.atom_id ?? raw.id)
  if (!Number.isInteger(atomId) || atomId <= 0) {
    jsonOut(res, 400, { ok: false, error: 'bad-id', message: 'atom_id 必须是正整数' })
    return
  }
  try {
    const rt = getRuntime(cfg)
    const r = setArchived(rt.db, { atomId, archived })
    if (r === null) {
      // 与删除一致：404 而不是 200 —— 界面要能区分「改了」与「这条本来就不在」。
      jsonOut(res, 404, { ok: false, error: 'not-found', message: '记忆 #' + atomId + ' 不在库里' })
      return
    }
    // changed=false 不是错误：重复归档 / 重复恢复都落在这一支，界面据此说「之前就是」。
    jsonOut(res, 200, {
      ok: true,
      atomId: r.atomId,
      flags: r.flags,
      archived: r.archived,
      changed: r.changed,
    })
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'archive-failed', message: reasonOf(e) })
  }
}

/**
 * 拆分候选的决定：确认或忽略。
 *
 * 两者的共同点：都清 `atom.flags` 的 bit0，所以界面上的候选提示消失。差别只有一处 ——
 * 确认另记一行状态（split_queue 的 confirmed），下次召回会在锚行提示「用户已确认应拆分」；
 * 忽略只写一条日志，没有状态、没有待办。
 *
 * 三道写栅栏与删除 / 归档相同：这个动作同样「不需要读到响应就已经造成了后果」。
 * 请求体的上限也共用 FORGET_BODY_MAX_BYTES —— 它只有一个整数 id。
 *
 * `changed=false` 不是错误：重复确认 / 重复忽略都落在这一支，界面据此说「之前就是」。
 */
async function splitRoute(
  cfg: RuntimeConfig,
  req: IncomingMessage,
  res: ServerResponse,
  confirm: boolean,
): Promise<void> {
  if (!guardWrite(req, res)) return
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (e) {
    jsonOut(res, 400, { ok: false, error: 'bad-body', message: reasonOf(e) })
    return
  }
  const raw = (body ?? {}) as Record<string, unknown>
  // 字段名与删除 / 归档一致（atom_id）；`id` 一并接受，理由同归档路由。
  const atomId = Number(raw.atom_id ?? raw.id)
  if (!Number.isInteger(atomId) || atomId <= 0) {
    jsonOut(res, 400, { ok: false, error: 'bad-id', message: 'atom_id 必须是正整数' })
    return
  }
  try {
    const rt = getRuntime(cfg)
    const r = confirm ? confirmSplit(rt.db, atomId) : ignoreSplit(rt.db, atomId)
    if (r === null) {
      // 与删除 / 归档一致：404 而不是 200 —— 界面要能区分「改了」与「这条本来就不在」。
      jsonOut(res, 404, { ok: false, error: 'not-found', message: '记忆 #' + atomId + ' 不在库里' })
      return
    }
    // 确认之后的有效确认条数：界面与验收都能据此看出「这份清单有没有被写进去」，
    // 而不必再去读 split_queue（那是实现细节）。
    const payload: Record<string, unknown> = {
      ok: true,
      atomId: r.atomId,
      flags: r.flags,
      changed: r.changed,
    }
    if (confirm) payload.confirmedCount = r.confirmed?.length ?? 0
    jsonOut(res, 200, payload)
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'split-failed', message: reasonOf(e) })
  }
}

/**
 * 整理入口：规划与取消。
 *
 * 三条边界：
 *   1. 规划要 `confirm: true` —— 一次误触会重排全库主题，而它不可撤销；
 *   2. 执行中取消返回 **409**，状态一个字不动；没有待执行的计划也是 200
 *      （幂等，不是错误 —— 判据要求「再取消一次不报错」）；
 *   3. 回执里报的是**规划 / 取消之后的状态**，不是执行结果。执行在几秒后由定时器触发，
 *      结果落到体检查询的 `recluster` 字段里 —— 请求不等它。
 */
async function reclusterRoute(
  cfg: RuntimeConfig,
  req: IncomingMessage,
  res: ServerResponse,
  action: 'plan' | 'cancel',
): Promise<void> {
  if (!guardWrite(req, res)) return
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (e) {
    jsonOut(res, 400, { ok: false, error: 'bad-body', message: reasonOf(e) })
    return
  }
  const raw = (body ?? {}) as Record<string, unknown>
  try {
    const rt = getRuntime(cfg)
    if (action === 'plan') {
      if (raw.confirm !== true) {
        jsonOut(res, 400, {
          ok: false,
          error: 'need-confirm',
          message: '整理会重排全库的主题，请求体里必须带 confirm: true',
        })
        return
      }
      // 规划只写 recluster_state 并挂一个一次性延迟；真正的执行在这里之外发生，不等它。
      const state = planRecluster(rt.db, () => {
        void executePlannedRecluster(rt.db)
      })
      jsonOut(res, 200, { ok: true, ...state })
      return
    }
    const r = cancelRecluster(rt.db)
    if (!r.ok && r.reason === 'running') {
      jsonOut(res, 409, {
        ok: false,
        error: 'running',
        message: '正在整理，不能取消',
        ...readReclusterState(rt.db),
      })
      return
    }
    jsonOut(res, 200, { ok: true, cancelled: r.ok, ...(r.ok ? r.state : readReclusterState(rt.db)) })
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'recluster-failed', message: reasonOf(e) })
  }
}

/**
 * 启动补跑：上次规划过却没跑完的整理，这里补一次。
 *
 * 判据是「`planned` 有值」，不看时间 —— 进程崩溃、断电、关窗口留下的是同一个痕迹。
 * 没有计划时它什么也不做。
 *
 * **两个约束**：
 *   1. 库不存在时不补跑、也不建库。否则「插件加载」会变成「建库」，破坏原来的懒加载
 *      （体检的「无数据」形态就靠它）；
 *   2. 用临时连接，不借 `getRuntime`。否则一个长期句柄挂在插件上，库文件被它按住。
 *      启动时没有别的请求在跑，临时连接不会与谁抢写锁；跑完就关。
 */
function bootResume(cfg: RuntimeConfig): void {
  const file = join(resolveDataDir(cfg.dataDir), 'lattice.db')
  if (!existsSync(file)) return
  try {
    const db = openVault(file).db
    // 没有待执行的计划就当场关掉：把一个打开的句柄留到微任务之后再关，会让「插件加载」
    // 期间库文件被按住（测试删临时目录时会 EPERM，那是同一个形态）。
    if (!hasPendingPlan(db)) {
      db.close()
      return
    }
    void resumeIfPending(db).finally(() => {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    })
  } catch {
    /* 打不开就下次启动再说：补跑不是加载插件的前提 */
  }
}
/**
 * 清空「学到的入口」。
 *
 * 三件事：删的只有 `origin='learned'` 那一类；回执给出实际删掉的条数（0 也是有效结果）；
 * 内核函数里另写一条日志（回答「发生过」）。
 *
 * 为什么要 `confirm: true`：这是删数据、不可撤销的动作。界面用两步确认，这里用同一个
 * 字段兜住「绕过界面直接打接口」的情形。
 */
async function learnedClearRoute(
  cfg: RuntimeConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!guardWrite(req, res)) return
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (e) {
    jsonOut(res, 400, { ok: false, error: 'bad-body', message: reasonOf(e) })
    return
  }
  const raw = (body ?? {}) as Record<string, unknown>
  if (raw.confirm !== true) {
    jsonOut(res, 400, {
      ok: false,
      error: 'need-confirm',
      message: '清空学到的入口不可撤销，请求体里必须带 confirm: true',
    })
    return
  }
  try {
    const rt = getRuntime(cfg)
    const cleared = clearLearned(rt.db)
    jsonOut(res, 200, { ok: true, cleared })
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'learned-clear-failed', message: reasonOf(e) })
  }
}
/** 本地日期 YYYYMMDD，用于导出文件名（不带时间：同一天多次导出靠浏览器去重）。 */
function dayStamp(now = new Date()): string {
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
  return String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
}

/**
 * 导出降级日志：CSV 附件。
 *
 * **只读**：不 flush、不建库、不写任何一行（见 src/log/export.ts 的三条约束）。
 * 因此导出前后主库 data_version 不变；代价是最近几十毫秒内还没落盘的行不在文件里，
 * 这是刻意选的：用户点导出时看到的应当是磁盘上已经有的东西。
 *
 * 表头固定四列（ts / level / event / detail）。detail 是已经白名单化的 JSON，
 * 导出侧不再增删字段 —— 用户拿到的与库里存的一致。
 */
function logExportRoute(cfg: RuntimeConfig, req: IncomingMessage, res: ServerResponse): void {
  if (!guardReadOnly(req, res)) return
  try {
    const dir = resolveDataDir(cfg.dataDir)
    configureLog(dir)
    const out = exportLogCsv(dir)
    const name = 'lattice-log-' + dayStamp() + '.csv'
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-length': Buffer.byteLength(out.csv),
      'content-disposition': 'attachment; filename="' + name + '"',
    })
    res.end(out.csv)
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'log-export-failed', message: reasonOf(e) })
  }
}

/**
 * 清空降级日志。
 *
 * 三道写栅栏之外还要求请求体带 `{"confirm": true}`：界面上有二次确认，这里再要一个
 * 显式字段 —— 误调一个删日志的端点不该只靠「路径写对了吗」来防。
 *
 * 只删日志目录下本模块管理的文件；主库与记忆数据不受影响。失败时返回可读错误，
 * 日志库保持可用（下一次写会自动重建或沿用原文件），不出现「删了一半还报成功」。
 */
async function logClearRoute(cfg: RuntimeConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!guardWrite(req, res)) return
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (e) {
    jsonOut(res, 400, { ok: false, error: 'bad-body', message: reasonOf(e) })
    return
  }
  const raw = (body ?? {}) as Record<string, unknown>
  if (raw.confirm !== true) {
    jsonOut(res, 400, {
      ok: false,
      error: 'confirm-required',
      message: '清空日志需要请求体带 {"confirm": true}',
    })
    return
  }
  try {
    const dir = resolveDataDir(cfg.dataDir)
    configureLog(dir)
    const r = clearLog(dir)
    jsonOut(res, 200, { ok: true, removed: r.removed })
  } catch (e) {
    jsonOut(res, 500, { ok: false, error: 'log-clear-failed', message: reasonOf(e) })
  }
}

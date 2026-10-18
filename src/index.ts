// dsh-lattice（记忆晶格）— DSH 记忆插件：无 LLM 依赖，本地向量检索 + Atom 级结构化记忆。
//
// 插件只做两件事：
//   1. 导出符合 Cordis 契约的接口（name / inject / Config / apply）
//   2. 注册四个工具：ping（健康检查）、write、recall、expand
//
// 外加七条路由给浏览器半用（见 apply 里的注释与文件尾的 handler）：
//   /api/lattice-ping-mini    库的规模（T19 最小实跑留下的座位验证，实测通过的那条基线）
//   /api/lattice-atoms        目录：分页 + 过滤，与 lattice_list 同一条数据路径
//   /api/lattice-search       搜索：与 lattice_recall 同一条数据路径，但**不记命中**
//   /api/lattice-audit        体检：只读结构指标，供面板与维护者（M4-T35；不进模型侧）
//   /api/lattice-log-export   降级日志导出：只读，返回 CSV 附件（M4-T44）
//   /api/lattice-forget       **删除**：物理删除 + 留痕（§44）。写端点
//   /api/lattice-log-clear    清空降级日志：写端点，要求 { confirm: true }（M4-T44）
//
// 五条只读路由的栅栏只留「本机回环」一道；两条写端点三道（回环 + POST +
// application/json）。差别与依据见 guardReadOnly / guardWrite 的注释。
//
// `lattice_forget` **不在模型可见的工具表**里（§11.1：物理删除归用户，模型只能提议）。
// 这个动作只有一个入口：用户在界面上点删除。
//
// **只有工具，没有 hook**：禁用 LLM 后「轮次结束自动沉淀」必然要调 LLM 做结构化，
// 与本插件的定位冲突。写入与召回都必须是显式动作。

import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { deriveResourceParams } from './util/memory.js'
import { clearLog, closeLog, configureLog, exportLogCsv } from './log/index.js'
import {
  getRuntime,
  noteRecallDegradations,
  resolveDataDir,
  runtimeEncode,
  type RuntimeConfig,
} from './state.js'
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, listAtoms, listAtomsByIds } from './pipeline/list.js'
import { audit, noDataReport } from './pipeline/audit.js'
import { recall } from './pipeline/search.js'
import { openVault } from './db/open.js'
import { forgetAtom } from './pipeline/forget.js'
import { configureSamples, sampleStats } from './samples/index.js'
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

/** 搜索路由：一条查询进去，若干条命中出来。 */
const SEARCH_ROUTE_PATH = '/api/lattice-search'

/**
 * 体检路由：只读结构指标（M4-T35）。
 *
 * 为什么是路由而不是工具（裁决 #26）：体检是维护/诊断动作，不在模型的工作流里；
 * 结构指标又只作参考，工具化等于把参考值直接递给模型、容易被读成结论。
 * 面板（M4-T28）只做展示，口径与数据都在 pipeline/audit.ts 这一处。
 */
const AUDIT_ROUTE_PATH = '/api/lattice-audit'

/**
 * 删除路由：本插件**唯一**的写端点，也是界面上唯一的删除入口（§11.1：物理删除归用户）。
 *
 * 为什么必须是一个写端点而不是工具：模型只能**提议**删除。`lattice_forget` 因此不进
 * 模型可见的工具表（表达方式见 tools/index.ts 里那段注释），删除这个动作只能由用户
 * 在界面上点出来。
 */
const FORGET_ROUTE_PATH = '/api/lattice-forget'

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
const FORGET_BODY_MAX_BYTES = 4096

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
  /**
   * 校准样本的自动收集（默认开）。
   *
   * 关掉的是**自动收集**（负样本按纯度规则收集）；显式 `lattice_feedback` 照常记录 ——
   * 那是模型对本次召回的显式判断，不是抽样。
   */
  samplesEnabled: z.boolean().default(true),
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
    samplesEnabled: cfg.samplesEnabled !== false,
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

  // ── 浏览器半的座位（M3-T19 最小验证） ─────────────────────────────────────────
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
  // undefined —— 静默跳过、路由永不注册。M3-T19 重启实测的 404 就是这个形态；
  // 复现见开发笔记的探针 t19-route-registration.mjs（真 cordis 4.0.4，场景 1）。
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
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-lattice: web routes')
  })

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
          mmapSize: Number(cfg.mmapSize ?? 0) > 0 ? Number(cfg.mmapSize) : undefined,
          cacheSize: Number(cfg.cacheSize ?? 0) > 0 ? Number(cfg.cacheSize) : undefined,
          busyTimeout: Number(cfg.busyTimeout ?? 0) > 0 ? Number(cfg.busyTimeout) : undefined,
        })
        // 健康检查会**初始化运行时**（与其它工具同一条路径）：标定状态在库上，
        // 不打开库就报不出来。代价是首次 ping 可能触发建库 —— 那与第一次写入是同一件事。
        const rt = getRuntime(runtimeCfg)
        return JSON.stringify({
          ok: true,
          plugin: name,
          version: VERSION,
          // 标定状态（T44 判据 1/2/4）：未标定**只进这里与日志**，不进召回返回。
          calibration: { state: rt.calibration.state, reason: rt.calibration.reason ?? null },
          // 报到插件注册时的**解析结果**，而不是配置里的空串 —— 否则看不出库在哪。
          dataDir: resolveDataDir(String(cfg.dataDir ?? '')),
          tools: [
            'lattice_ping',
            'lattice_write',
            'lattice_recall',
            'lattice_expand',
            'lattice_list',
            'lattice_feedback',
          ],
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
          // 样本库只报条数：原文（哪怕一条摘录）都不该出现在健康检查里。
          //
          // 先按与运行时相同的口径登记一次目录：ping 可能先于任何业务工具被调用，
          // 不登记就会静默报 0 —— 而「库里有样本、健康检查说 0」正是最难查的那类假象。
          // 这里**不调用 getRuntime**：健康检查不该顺手建记忆库。
          samples: (() => {
            configureSamples(resolveDataDir(runtimeCfg.dataDir), {
              enabled: runtimeCfg.samplesEnabled,
              model: runtimeCfg.encoderModel,
            })
            return sampleStats()
          })(),
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
      atoms: listAtoms(rt.db, { limit: 1 }).total,
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
 * 与 miniPing 里那段是有意的重复：那条路由是 T19 实测通过的基线，本轮不动它的函数体。
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
    const r = listAtoms(rt.db, {
      kind: params.get('kind') ?? '',
      origin: params.get('origin') ?? '',
      scope: params.get('scope') ?? '',
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
 * 体检：只读结构指标（M4-T35）。
 *
 * 与其他只读路由的**一处有意的不同**：这里不用 getRuntime，而是自己只读打开库。
 * 三个理由：
 *   - getRuntime 会补 meta（stampVault）、会按标定状态写独立日志库；而体检的契约是
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
    })
    return
  }
  let db: DatabaseSync | null = null
  try {
    db = openVault(file, { readOnly: true }).db
    jsonOut(res, 200, { ok: true, ...audit(db, opts) })
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
 * 为什么比只读那组多两道（依据见 M3 的 T19 前置调研与修复报告）：只读路由无请求体，
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

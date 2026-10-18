// 工具集成测试：从 apply() 注册出来的工具，真的能用。
//
// 这里走的是完整链路：插件入口 → 工具定义 → 库连接 → 写入/召回/展开。
// 编码器由 loader 替身强制失败，所以全程走纯词面路径 —— 这正是要覆盖的降级现实：
// 模型没装、下载失败、离线环境，工具都必须照常工作。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { apply } from '../dist/index.js'
import { closeRuntime } from '../dist/state.js'
import { FORGET_TOOL_NAME, FORGET_TOOL_SPEC, isWeakMatch, LOW_RELEVANCE_HINT } from '../dist/tools/index.js'
import { briefMinFor } from '../dist/pipeline/calibrate.js'
import { resetEncoder } from '../dist/encoder/index.js'

let dir = ''
let tools = []

/**
 * 最小假 ctx：只实现插件用到的那一个服务。
 *
 * 还要给一个 `inject`：插件用它把「有 Web 载体就挂一条只读路由」写成**条件**注入
 * （见 src/index.ts）。真 cordis 的每个 ctx 都有这个方法；这里给个不执行回调的替身，
 * 等价于「本用例的宿主没有 webServer 服务」。
 */
function fakeCtx() {
  const registered = []
  return {
    registered,
    get: (k) => (k === 'tools' ? { register: (t) => registered.push(t) } : undefined),
    effect: (fn) => fn(),
    inject: () => {},
  }
}

function cfg() {
  return {
    enabled: true,
    dataDir: dir,
    encoderEnabled: true,
    encoderModel: 'Xenova/bge-small-zh-v1.5',
    encoderMirror: '',
    encoderCacheDir: '',
    tauJoin: 0.78,
    tauLex: 0.05,
    tauLexOnly: 0.1,
    tauNew: 0.5,
    viewBudget: 6000,
    topN: 24,
    mmapSize: 0,
    cacheSize: 0,
    busyTimeout: 0,
  }
}

function tool(name) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error('工具未注册: ' + name)
  return t
}

beforeEach(() => {
  // 编码器状态是模块级单例：别的测试文件可能已把它置为 ready，
  // 不复位的话这里会**静默沿用上一个模型**，降级路径就测不到了。
  resetEncoder()
  closeRuntime()
  dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-tools-'))
  const ctx = fakeCtx()
  apply(ctx, cfg())
  tools = ctx.registered
})

afterEach(() => {
  closeRuntime()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不阻断 */
  }
})

describe('工具注册', () => {
  // 模型侧工具数 = 6（ping + write / recall / expand / list / feedback）。
  // 2026-10-18 按裁决 #30 增加 `lattice_feedback`：它只写独立样本库（裁决 #31），
  // 所以「多一个工具」不等于「多一个写主库的入口」—— 见 test/samples.test.mjs。
  it('注册了 ping 与五个业务工具（共六个）', () => {
    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'lattice_expand',
      'lattice_feedback',
      'lattice_list',
      'lattice_ping',
      'lattice_recall',
      'lattice_write',
    ])
    assert.equal(names.length, 6)
  })

  /**
   * §11.1 的边界：物理删除归用户，模型只能提议。
   *
   * 「不进模型可见的工具表」在本仓库里的表达就是**不放进 buildTools 的返回数组**
   * （宿主呈现给模型的就是注册表里的可见条目）。这两条断言把它钉住：规格存在，
   * 而注册表里没有它。少了任何一条，边界都可能在一次重构里被悄悄越过。
   */
  it('模型可见的工具表不含 lattice_forget（删除归用户）', () => {
    assert.equal(FORGET_TOOL_SPEC.name, FORGET_TOOL_NAME)
    assert.equal(FORGET_TOOL_NAME, 'lattice_forget')
    assert.ok(!tools.some((t) => t.name === FORGET_TOOL_NAME), 'lattice_forget 不得出现在注册表里')
    // 反过来确认这个名字真的没被注册 —— 模型发出它只会拿到 UNKNOWN_TOOL。
    assert.equal(
      tools.find((t) => t.name === FORGET_TOOL_NAME),
      undefined,
    )
  })

  it('每个业务工具都有 description / parameters / execute', () => {
    for (const n of [
      'lattice_write',
      'lattice_recall',
      'lattice_expand',
      'lattice_list',
      'lattice_feedback',
    ]) {
      const t = tool(n)
      assert.equal(typeof t.execute, 'function', n + ' 缺少 execute')
      assert.ok(String(t.description).length > 20, n + ' 的 description 太短，模型无法判断何时用')
      // 替身会把「属性映射」转成 JSON Schema（与真实宿主一致），这里验的是转换后的契约
      assert.equal(t.parameters.type, 'object')
      assert.ok(t.parameters.properties, n + ' 缺少 parameters.properties')
    }
  })

  it('写入工具声明了必填 text', () => {
    assert.deepEqual(tool('lattice_write').parameters.required, ['text'])
    assert.deepEqual(tool('lattice_recall').parameters.required, ['query'])
    assert.deepEqual(tool('lattice_expand').parameters.required, ['atom_id'])
    assert.deepEqual(tool('lattice_feedback').parameters.required, ['kind', 'ref'])
  })
})

describe('lattice_write', () => {
  it('写入成功并返回 atom / topic / 入口数', async () => {
    const out = await tool('lattice_write').execute({
      text: '系统代理必须走本地端口，否则访问境外源会超时。',
    })
    assert.ok(out.includes('已写入 atom #'), '输出: ' + out)
    assert.ok(out.includes('新建主题'), '首个 atom 应当新建主题，输出: ' + out)
    assert.ok(out.includes('入口'), '输出: ' + out)
  })

  it('空 text 给出可读的失败信息，不抛错', async () => {
    const out = await tool('lattice_write').execute({ text: '   ' })
    assert.ok(out.includes('不能为空'), '输出: ' + out)
  })

  it('refs 会被当作显式入口写入', async () => {
    const out = await tool('lattice_write').execute({
      text: 'SQLite 的 WAL 模式允许一写多读。',
      refs: ['WAL', '并发'],
      kind: '坑',
    })
    assert.ok(out.includes('显式声明 2 条'), '输出: ' + out)
  })

  it('指向不存在的主题时回退并提示，不阻塞写入', async () => {
    const out = await tool('lattice_write').execute({
      text: '一条普通记忆，用来验证指向不存在的主题时会回退。',
      topic_hint: 999,
    })
    assert.ok(out.includes('已写入'), '输出: ' + out)
    assert.ok(out.includes('#999'), '应当提示 hint 不存在，输出: ' + out)
  })

  it('写入的内容真的落库了（再过一遍召回）', async () => {
    await tool('lattice_write').execute({ text: '缓存击穿是热点 key 失效导致的。' })
    const out = await tool('lattice_recall').execute({ query: '缓存击穿' })
    assert.ok(out.includes('缓存击穿'), '召回应当能找到刚写入的内容，输出: ' + out)
  })
})

describe('写入侧审核：工具返回值（M3-T22）', () => {
  // 这一组走的是**真实入口**：apply() 注册出来的 lattice_write → writeReviewed → 返回值组装。
  // 判据是「反馈只走工具返回值」，所以断言点全在那段文本上，外加「库里确实没有多出东西」。

  it('过短：返回值里说清未写入与为什么，且库里一条都没多', async () => {
    const out = await tool('lattice_write').execute({ text: '好' })
    assert.ok(out.includes('未写入'), '输出: ' + out)
    assert.ok(out.includes('合并'), '要给出出路，输出: ' + out)
    assert.equal(out.includes('已写入 atom'), false, '不能既说未写入又说已写入')
    const listed = await tool('lattice_list').execute({})
    assert.ok(listed.includes('atom 0') || listed.includes('没有'), '库里不该有任何 atom，输出: ' + listed)
  })

  it('过长：返回值逐条报出切分结果，条数与库里的 atom 数一致', async () => {
    const text = '甲'.repeat(300) + '。' + '乙'.repeat(300) + '。' + '丙'.repeat(300) + '。'
    const out = await tool('lattice_write').execute({ text })
    assert.ok(out.includes('自动切成 3 条'), '输出: ' + out)
    assert.ok(out.includes('第 1/3 条'), '输出: ' + out)
    assert.ok(out.includes('第 3/3 条'), '输出: ' + out)
    assert.equal((out.match(/已写入 atom #/g) ?? []).length, 3, '输出: ' + out)
    assert.ok(out.includes('topic_hint 未沿用'), '切分后不沿用 hint 这件事要说出来，输出: ' + out)
  })
})
describe('lattice_recall', () => {
  it('空库时明确说没找到，而不是返回空串', async () => {
    const out = await tool('lattice_recall').execute({ query: '任意查询' })
    assert.ok(out.includes('没有找到'), '输出: ' + out)
    assert.ok(out.includes('库：'), '应当附带库现状，输出: ' + out)
  })

  it('结果带库现状一行，便于判断库有多大', async () => {
    await tool('lattice_write').execute({ text: '一条用于测试的记忆，正文是完整的一句话。' })
    const out = await tool('lattice_recall').execute({ query: '记忆' })
    assert.ok(/库：atom \d+ \/ topic \d+/.test(out), '输出: ' + out)
  })

  it('返回的是组装好的三段式文本，不是裸数组', async () => {
    await tool('lattice_write').execute({ text: '系统代理必须走本地端口。' })
    const out = await tool('lattice_recall').execute({ query: '代理' })
    assert.ok(out.includes('【锚】'), '输出: ' + out)
    assert.equal(out.trim().startsWith('['), false, '不应返回 JSON 数组')
  })

  it('显式关闭编码器时，召回标注纯词面模式', async () => {
    // 用 encoderEnabled:false 而不是「让替身失败」来构造降级：
    // 后者依赖编码器的模块级状态（别的测试可能已把它置为 ready），测试会随
    // 执行顺序飘。显式关闭是确定性的，也对应真实的配置场景。
    const ctx = fakeCtx()
    apply(ctx, { ...cfg(), encoderEnabled: false })
    const w = ctx.registered.find((x) => x.name === 'lattice_write')
    const r = ctx.registered.find((x) => x.name === 'lattice_recall')
    await w.execute({ text: '系统代理必须走本地端口。' })
    const out = await r.execute({ query: '代理' })
    assert.ok(out.includes('（编码器不可用，本次为纯词面召回）'), '降级必须可见，输出: ' + out)
  })

  it('budget 参数生效', async () => {
    for (let i = 1; i <= 6; i++) {
      await tool('lattice_write').execute({ text: '记忆第 ' + i + ' 条，包含可检索的关键词' + i + '。' })
    }
    const out = await tool('lattice_recall').execute({ query: '关键词', budget: 900 })
    const body = out.slice(out.indexOf('【锚】'))
    assert.ok(body.length <= 900 + 60, '正文应当受预算约束，实际 ' + body.length)
  })
})

describe('低相关提示', () => {
  // 判据抽成了纯函数（meetsRelevance），这里直接测它 —— 不构造库，也不依赖编码器。
  // 早先想用「写一条毫不相关的记忆再查」来测，被真实模型否掉了：
  // 库里只有一条时它总能拿到 0.57 的相似度，那是用例问题而非判据问题。
  const meta = (topCosine, vectorMissing = false) => ({
    counts: { vec: 1, entry: 1, body: 0, graph: 0 },
    lexicalDegraded: false,
    shortTermMiss: false,
    vectorMissing,
    suppressed: 0,
    topCosine,
    primaryHits: 1,
    secondaryHits: 0,
    elapsedMs: 0,
  })

  it('低于阈值判为弱相关（会提示）', () => {
    // 0.4 是实测的「无关查询」上界（4 条无关问法 max 0.398）。
    assert.equal(isWeakMatch(meta(0.4)), true)
    assert.equal(isWeakMatch(meta(LOW_RELEVANCE_HINT - 0.01)), true)
  })

  it('兜底阈值必须落在实测的两端之间', () => {
    // 实测（279 条基准库）：相关 gold 20 条 top1 最低 0.524；无关 4 条最高 0.398。
    // 这条断言守的是**兜底值**（库小到没法标定时用的那个）；
    // **实际生效的线按库规模重标**，它在 1374 库上是 0.525 —— 已经超出这个区间，
    // 而那不算违反：那两端的实测取自 279 条库，不是 1374 条库。
    assert.ok(LOW_RELEVANCE_HINT > 0.398, '必须高于无关查询的上界')
    assert.ok(LOW_RELEVANCE_HINT < 0.524, '必须低于相关查询的下界')
  })

  it('判据用的是传进来的那条线，不是那个兜底常量', () => {
    // 这条是 2026-10-17 处置清单 A1 的回归：此前 isWeakMatch 只读 LOW_RELEVANCE_HINT，
    // 而 lattice_recall 实际应当用 assembleView() 返回的 briefMin（按库规模重标）。
    // 取本库（1374 条）实际生效的线，构造一个落在两条线之间的余弦 ——
    // 按兜底值判「相关」（不提示），按本库的线判「弱相关」（提示）。
    const actual = briefMinFor(1374, LOW_RELEVANCE_HINT)
    assert.ok(actual > LOW_RELEVANCE_HINT, '本库的线应当高于兜底值（否则这条用例就没意义）')
    const between = (LOW_RELEVANCE_HINT + actual) / 2
    assert.equal(isWeakMatch(meta(between)), false, '按兜底值：不提示')
    assert.equal(isWeakMatch(meta(between), actual), true, '按本库的线：提示')
  })

  it('达到阈值不提示', () => {
    assert.equal(isWeakMatch(meta(LOW_RELEVANCE_HINT)), false)
    assert.equal(isWeakMatch(meta(0.9)), false)
  })

  it('纯词面模式不判断（没有余弦可依）', () => {
    assert.equal(isWeakMatch(meta(0, true)), false)
  })

  it('阈值与实测分布的关系（记录现状，不是断言正确）', () => {
    // 真实模型上实测：相关查询 0.45~0.70，「完全不相关」0.50 —— 两者重叠，
    // 所以这里**不能**断言阈值能分开它们，只记录当前取值。
    // 标定前不应把它当硬门槛用（见 tools/index.ts 里的说明）。
    assert.ok(LOW_RELEVANCE_HINT > 0.4 && LOW_RELEVANCE_HINT < 0.8)
  })
})

describe('lattice_expand', () => {
  it('按 id 展开全文', async () => {
    const w = await tool('lattice_write').execute({ text: '完整的记忆正文，含足够多的细节。' })
    const id = Number(/#(\d+)/.exec(w)[1])
    const out = await tool('lattice_expand').execute({ atom_id: id })
    assert.ok(out.includes('完整的记忆正文'), '输出: ' + out)
    assert.ok(out.includes('主题 #'), '输出: ' + out)
  })

  it('mode=related 列出同主题的兄弟', async () => {
    const a = await tool('lattice_write').execute({ text: '系统代理必须走本地端口，否则会超时。' })
    const idA = Number(/#(\d+)/.exec(a)[1])
    await tool('lattice_write').execute({
      text: '系统代理配置本地端口，否则会超时。',
      topic_hint: Number(/主题 #(\d+)/.exec(a) ? /#(\d+)/g.exec(a)[0].slice(1) : 0),
    })
    const out = await tool('lattice_expand').execute({ atom_id: idA, mode: 'related' })
    assert.ok(out.includes('下另有'), '输出: ' + out)
  })

  it('id 不存在时给出可读提示', async () => {
    const out = await tool('lattice_expand').execute({ atom_id: 987654 })
    assert.ok(out.includes('没有 id 为'), '输出: ' + out)
  })

  it('lattice_expand 把 atom_id 声明为必填 —— 调用前的校验归宿主', () => {
    // 我们只声明 schema；调用前的参数校验由宿主负责（见 docs/PRINCIPLES.md 边界三）。
    // 这里断言的是「声明经契约转换后的结果」，而不是「宿主会不会按它拦下」——
    // 后者是对方的契约，断言它会让红灯指向我们没坏的地方。
    const t = tool('lattice_expand')
    assert.equal(t.parameters?.properties?.atom_id?.type, 'number')
    assert.ok(
      t.parameters?.required?.includes('atom_id'),
      'atom_id 应当出现在 required 里：' + JSON.stringify(t.parameters?.required),
    )
  })
})

describe('lattice_ping', () => {
  it('报出解析后的数据目录与工具清单', async () => {
    const out = await tool('lattice_ping').execute({})
    const j = JSON.parse(out)
    assert.equal(j.ok, true)
    assert.equal(j.dataDir, dir, '应当报出真实数据目录')
    assert.deepEqual(j.tools, [
      'lattice_ping',
      'lattice_write',
      'lattice_recall',
      'lattice_expand',
      'lattice_list',
      'lattice_feedback',
    ])
    // 样本库只报条数，且没写过样本时不建库：三个数都是 0。
    assert.deepEqual(j.samples, { total: 0, positive: 0, negative: 0 })
  })
})

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
import { isWeakMatch, LOW_RELEVANCE_HINT } from '../dist/tools/index.js'
import { resetEncoder } from '../dist/encoder/index.js'

let dir = ''
let tools = []

/** 最小假 ctx：只实现插件用到的那一个服务。 */
function fakeCtx() {
  const registered = []
  return {
    registered,
    get: (k) => (k === 'tools' ? { register: (t) => registered.push(t) } : undefined),
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
  it('注册了 ping 与三个业务工具', () => {
    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['lattice_expand', 'lattice_ping', 'lattice_recall', 'lattice_write'])
  })

  it('每个业务工具都有 description / parameters / execute', () => {
    for (const n of ['lattice_write', 'lattice_recall', 'lattice_expand']) {
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
    const out = await tool('lattice_write').execute({ text: '一条普通记忆。', topic_hint: 999 })
    assert.ok(out.includes('已写入'), '输出: ' + out)
    assert.ok(out.includes('#999'), '应当提示 hint 不存在，输出: ' + out)
  })

  it('写入的内容真的落库了（再过一遍召回）', async () => {
    await tool('lattice_write').execute({ text: '缓存击穿是热点 key 失效导致的。' })
    const out = await tool('lattice_recall').execute({ query: '缓存击穿' })
    assert.ok(out.includes('缓存击穿'), '召回应当能找到刚写入的内容，输出: ' + out)
  })
})

describe('lattice_recall', () => {
  it('空库时明确说没找到，而不是返回空串', async () => {
    const out = await tool('lattice_recall').execute({ query: '任意查询' })
    assert.ok(out.includes('没有找到'), '输出: ' + out)
    assert.ok(out.includes('库：'), '应当附带库现状，输出: ' + out)
  })

  it('结果带库现状一行，便于判断库有多大', async () => {
    await tool('lattice_write').execute({ text: '一条记忆。' })
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
    assert.equal(isWeakMatch(meta(0.5)), true)
    assert.equal(isWeakMatch(meta(LOW_RELEVANCE_HINT - 0.01)), true)
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

  it('缺 atom_id 时由上游参数校验拦下，错误信息可读', async () => {
    // 必填参数由宿主的 defineTool 校验（parameters 里标了 required: true），不会走到 execute。
    await assert.rejects(
      () => tool('lattice_expand').execute({}),
      (err) => {
        assert.equal(err.code, 'INVALID_ARGS')
        assert.ok(String(err.message).includes('atom_id'), '错误信息应指出缺哪个参数: ' + err.message)
        return true
      },
    )
  })
})

describe('lattice_ping', () => {
  it('报出解析后的数据目录与工具清单', async () => {
    const out = await tool('lattice_ping').execute({})
    const j = JSON.parse(out)
    assert.equal(j.ok, true)
    assert.equal(j.dataDir, dir, '应当报出真实数据目录')
    assert.deepEqual(j.tools, ['lattice_ping', 'lattice_write', 'lattice_recall', 'lattice_expand'])
  })
})

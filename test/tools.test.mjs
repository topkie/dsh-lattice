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
import { closeRuntime, getRuntime } from '../dist/state.js'
import { setArchived } from '../dist/pipeline/archive.js'
import { forgetAtom } from '../dist/pipeline/forget.js'
import {
  FEEDBACK_TOOL_NAME,
  FEEDBACK_TOOL_SPEC,
  FORGET_TOOL_NAME,
  FORGET_TOOL_SPEC,
  referenceNote,
} from '../dist/tools/index.js'
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

describe('工具注册与执行', () => {
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
    // 模型侧工具数 = 5（ping + write / recall / expand / list）。
    // 2026-10-18 曾增加 `lattice_feedback`；2026-10-22 它随样本库退役，
    // 定义留在 tools/index.ts 的 FEEDBACK_TOOL_SPEC 里，不进工具表。
    it('注册了 ping 与四个业务工具（共五个）', () => {
      const names = tools.map((t) => t.name).sort()
      assert.deepEqual(names, [
        'lattice_expand',
        'lattice_list',
        'lattice_ping',
        'lattice_recall',
        'lattice_write',
      ])
      assert.equal(names.length, 5)
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

    /**
     * 反馈同理，但原因不同：它不是「归用户」，而是**当前未启用**。
     *
     * 定义留着的用处是把「判断信号能改变什么」这个问题的答案固定在代码里；
     * 模型侧看不到它，也就不会拿它当可用能力去试。
     */
    it('模型可见的工具表不含 lattice_feedback（当前未启用）', () => {
      assert.equal(FEEDBACK_TOOL_SPEC.name, FEEDBACK_TOOL_NAME)
      assert.equal(FEEDBACK_TOOL_NAME, 'lattice_feedback')
      assert.ok(!tools.some((t) => t.name === FEEDBACK_TOOL_NAME))
    })

    it('每个业务工具都有 description / parameters / execute', () => {
      for (const n of ['lattice_write', 'lattice_recall', 'lattice_expand', 'lattice_list']) {
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
      // 定稿但未启用的规格：参数契约照样钉住，否则将来加回工具表时没人知道它该收什么。
      assert.deepEqual(Object.keys(FEEDBACK_TOOL_SPEC.parameters).sort(), ['kind', 'ref'])
    })
  })

  describe('lattice_write', () => {
    it('写入成功并返回 atom / topic / 入口数', async () => {
      const out = await tool('lattice_write').execute({
        text: '系统代理必须走本地端口，否则访问境外源会超时。',
      })
      assert.ok(out.includes('已写入记忆 #'), '输出: ' + out)
      assert.ok(out.includes('新建主题'), '首个 atom 应当新建主题，输出: ' + out)
      assert.ok(out.includes('入口'), '输出: ' + out)
    })

    it('取代回执把「本条」括起来：编号与说明之间要有分隔', async () => {
      const first = await tool('lattice_write').execute({
        text: '系统代理必须走本地端口，否则访问境外源会超时。',
      })
      const oldId = Number(/已写入记忆 #(\d+)/.exec(first)[1])
      const out = await tool('lattice_write').execute({
        text: '系统代理改成走本地端口 7890，旧的写法不再适用。',
        supersedes: oldId,
      })
      // 这一行曾经把编号与「本条」黏在一起，读起来像编号的一部分。
      // 单条写入时用括号包住「本条」；切分时另有一句「（切分后的第一条）」。
      assert.ok(out.includes('（本条）取代'), '单条写入的取代回执要带括号：' + out)
      assert.equal(out.includes('#本条'), false, '编号与说明之间不能黏在一起：' + out)
    })

    it('切分后取代只落第一条，回执写明落在哪', async () => {
      const old = await tool('lattice_write').execute({
        text: '长文切分时被取代的那条旧记忆，正文是一句完整的话。',
      })
      const oldId = Number(/已写入记忆 #(\d+)/.exec(old)[1])
      // 40 句、每句 20 余字，合计超过 MAX_ATOM_CHARS=600，写入时按句子边界切成多段。
      const long = Array.from(
        { length: 40 },
        (_, i) => '这是用于触发切分的第' + (i + 1) + '句正文，长度足够跨过单条上限。',
      ).join('')
      const out = await tool('lattice_write').execute({ text: long, supersedes: oldId })
      assert.ok(out.includes('（切分后的第一条）取代'), '输出: ' + out)
      // superseded_by 写在旧条上，值是接替它的新条 id。切分后只能由第一条接替，
      // 否则一次写入的行数会随切分段数增长（写入事务内固定行数是有意的）。
      const firstNew = Number(/第 1\/\d+ 条：已写入记忆 #(\d+)/.exec(out)[1])
      const row = getRuntime(cfg()).db.prepare('SELECT superseded_by FROM atom WHERE id = ?').get(oldId)
      assert.equal(row.superseded_by, firstNew, '取代只能落在切分后的第一条：' + out)
    })

    it('取代目标被删过时说「已被删除」，与「不存在」分开', async () => {
      const first = await tool('lattice_write').execute({
        text: '这条稍后会被删除，用来测取代回执的措辞。',
      })
      const goneId = Number(/已写入记忆 #(\d+)/.exec(first)[1])
      forgetAtom(getRuntime(cfg()).db, { atomId: goneId })
      const out = await tool('lattice_write').execute({
        text: '另一条不相干的记忆，正文是完整的一句话。',
        supersedes: goneId,
      })
      assert.ok(out.includes('已被删除（墓碑 #'), '输出: ' + out)
      assert.equal(out.includes('不存在'), false, '被删过的不该说「不存在」：' + out)
    })

    it('取消一个从来没有的取代关系时说「不存在」', async () => {
      const out = await tool('lattice_write').execute({
        text: '再一条不相干的记忆，用来测取消取代的回执。',
        unsupersede: 987654,
      })
      assert.ok(out.includes('不存在，未改动任何东西。'), '输出: ' + out)
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

    it('source 落库，同源高度重叠的两条在注入里只留一条', async () => {
      // 来源是「同源重复」唯一能证明的东西：同一篇文档的两条才可能逐字重复。
      // 不传 source 的条目 source 列为空，压制时不进任何桶。
      const a = await tool('lattice_write').execute({
        text: '系统代理必须走本地端口，否则访问境外源会超时。',
        source: '网络约定.md',
      })
      const id1 = Number(/已写入记忆 #(\d+)/.exec(a)[1])
      const b = await tool('lattice_write').execute({
        text: '系统代理必须走本地端口，否则访问境外源就会超时。',
        source: '网络约定.md',
      })
      const id2 = Number(/已写入记忆 #(\d+)/.exec(b)[1])
      assert.notEqual(id1, id2, '两条应当各自写入：' + a + ' / ' + b)
      const db = getRuntime({}).db
      const row = db.prepare('SELECT source FROM atom WHERE id = ?').get(id1)
      assert.equal(row.source, '网络约定.md', 'source 要落进 atom.source 列')
      const out = await tool('lattice_recall').execute({ query: '系统代理 本地端口 境外源' })
      assert.ok(out.includes('另有 1 条与同源内容重复'), '注入段应当说明压掉一条：' + out)
    })

    it('不传 source 时库里的来源列为空，压制不生效', async () => {
      const a = await tool('lattice_write').execute({ text: '同源压制的反例：这条没有来源甲。' })
      const id1 = Number(/已写入记忆 #(\d+)/.exec(a)[1])
      const row = getRuntime({}).db.prepare('SELECT source FROM atom WHERE id = ?').get(id1)
      assert.equal(row.source, null, '不传 source 就该是 NULL，不能自己编一个')
    })

    it('写入的内容真的落库了（再过一遍召回）', async () => {
      await tool('lattice_write').execute({ text: '缓存击穿是热点 key 失效导致的。' })
      const out = await tool('lattice_recall').execute({ query: '缓存击穿' })
      assert.ok(out.includes('缓存击穿'), '召回应当能找到刚写入的内容，输出: ' + out)
    })
  })

  describe('写入侧审核：工具返回值', () => {
    // 这一组走的是**真实入口**：apply() 注册出来的 lattice_write → writeReviewed → 返回值组装。
    // 判据是「反馈只走工具返回值」，所以断言点全在那段文本上，外加「库里确实没有多出东西」。

    it('过短：返回值里说清未写入与为什么，且库里一条都没多', async () => {
      const out = await tool('lattice_write').execute({ text: '好' })
      assert.ok(out.includes('未写入'), '输出: ' + out)
      assert.ok(out.includes('合并'), '要给出出路，输出: ' + out)
      assert.equal(out.includes('已写入记忆'), false, '不能既说未写入又说已写入')
      const listed = await tool('lattice_list').execute({})
      assert.ok(listed.includes('atom 0') || listed.includes('没有'), '库里不该有任何 atom，输出: ' + listed)
    })

    it('过长：返回值逐条报出切分结果，条数与库里的 atom 数一致', async () => {
      const text = '甲'.repeat(300) + '。' + '乙'.repeat(300) + '。' + '丙'.repeat(300) + '。'
      const out = await tool('lattice_write').execute({ text })
      assert.ok(out.includes('按长度切成 3 条'), '输出: ' + out)
      assert.ok(out.includes('第 1/3 条'), '输出: ' + out)
      assert.ok(out.includes('第 3/3 条'), '输出: ' + out)
      assert.equal((out.match(/已写入记忆 #/g) ?? []).length, 3, '输出: ' + out)
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

    it('返回的是组装好的【入选】清单，不是裸数组', async () => {
      await tool('lattice_write').execute({ text: '系统代理必须走本地端口。' })
      const out = await tool('lattice_recall').execute({ query: '代理' })
      assert.ok(out.includes('【入选】'), '输出: ' + out)
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
      const body = out.slice(out.indexOf('【入选】'))
      assert.ok(body.length <= 900 + 60, '正文应当受预算约束，实际 ' + body.length)
    })

    /**
     * scope 的两个默认值不同：写入缺省 global，召回缺省「不限」。
     *
     * 「不传时两个项目域都出现」是对照组，不能省：少了它，第二条用例里
     * 「乙标记不出现」可能只是因为两条类似记忆被压掉了一条，而不是 scope 起了作用。
     * 三条正文刻意写得不像，避免被重复压制先一步拿掉。
     */
    it('scope 只召回该域与 global，不传则不限域', async () => {
      await tool('lattice_write').execute({
        text: '项目甲：部署流程先跑构建再发布，甲标记。',
        scope: 'proj-a',
      })
      await tool('lattice_write').execute({
        text: '项目乙那边怎么走部署流程，写的是先备份再切流量，乙标记。',
        scope: 'proj-b',
      })
      await tool('lattice_write').execute({ text: '部署流程的通用说明，共用标记。' })
      const q = '部署流程'
      const all = await tool('lattice_recall').execute({ query: q })
      assert.ok(all.includes('甲标记'), '不传 scope 时项目甲该出现: ' + all)
      assert.ok(all.includes('乙标记'), '不传 scope 时项目乙该出现: ' + all)
      const onlyA = await tool('lattice_recall').execute({ query: q, scope: 'proj-a' })
      assert.ok(onlyA.includes('甲标记'), '本域该出现: ' + onlyA)
      assert.ok(onlyA.includes('共用标记'), 'global 在任何域下都该出现: ' + onlyA)
      assert.ok(!onlyA.includes('乙标记'), '域外的记忆不该出现: ' + onlyA)
    })
  })

  describe('召回回执的固定措辞', () => {
    // 回执措辞是行为清单 C1/C9 的落点：两段结构、不暴露内部分数、说清为什么少。
    // 编码器由替身强制失败，所以「判空」与「库还小」两种措辞在这里出现不了
    // （参考分布建不出来，hasContent 为 null 是诚实的不判定）；这里测得到的是
    // 两段结构与「候选用完了」两种。

    it('回执是两段结构，不暴露内部分数，也不打「可能不相关」', async () => {
      await tool('lattice_write').execute({ text: '系统代理必须走本地端口。' })
      const out = await tool('lattice_recall').execute({ query: '代理' })
      assert.ok(out.includes('【入选】'), '输出: ' + out)
      assert.ok(!out.includes('【入口】'), '三段形态已经取消')
      assert.ok(!out.includes('【路】'), '三段形态已经取消')
      assert.ok(!out.includes('可能不相关'), '绝对阈值那句已经删掉')
      assert.ok(!/最高相似度/.test(out), '不向用户报分数')
    })

    it('候选用完了要说出来', async () => {
      await tool('lattice_write').execute({ text: '系统代理必须走本地端口。' })
      await tool('lattice_write').execute({ text: '代理配置写在环境变量里，端口默认 7890。' })
      const out = await tool('lattice_recall').execute({ query: '代理' })
      assert.ok(out.includes('候选用完了，只有'), '输出: ' + out)
    })

    it('只找到一条时说的是那一条，不说候选耗尽', async () => {
      await tool('lattice_write').execute({ text: '系统代理必须走本地端口。' })
      const out = await tool('lattice_recall').execute({ query: '代理' })
      assert.ok(out.includes('只找到一条相关的。'), '输出: ' + out)
    })

    it('一条都没有时直说没找到', async () => {
      const out = await tool('lattice_recall').execute({ query: '完全不存在的词' })
      assert.ok(out.includes('没有找到相关记忆'), '输出: ' + out)
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

    it('归档条目仍能按 id 展开，且输出里标「已归档」', async () => {
      const w = await tool('lattice_write').execute({ text: '归档之后仍然可以按 id 展开的记忆。' })
      const id = Number(/#(\d+)/.exec(w)[1])
      // 工具执行时已经建好运行时；这里复用同一个连接改这一位（归档路由走的就是 setArchived）。
      setArchived(getRuntime({}).db, { atomId: id, archived: true })
      const out = await tool('lattice_expand').execute({ atom_id: id })
      assert.ok(out.includes('已归档'), '输出: ' + out)
      assert.ok(out.includes('归档之后仍然可以按 id 展开'), '正文照常展开: ' + out)
    })

    it('未归档条目的展开输出里没有「已归档」', async () => {
      const w = await tool('lattice_write').execute({
        text: '这条记忆没有归档过，展开输出里不该出现归档标记。',
      })
      const id = Number(/#(\d+)/.exec(w)[1])
      const out = await tool('lattice_expand').execute({ atom_id: id })
      assert.ok(!out.includes('已归档'), '输出: ' + out)
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
      ])
      // 样本库退役后健康检查不再报 samples 字段：一个永远是 0 的字段
      // 会让人以为样本还在收集、只是碰巧没有。
      assert.equal('samples' in j, false)
    })
  })

  describe('参考线判不了时的回执', () => {
    // 这两种情形下 hasContent 都是 null：渲染层不会写「库里没有」，也不会写别的。
    // 不说这句话，读的人会把「没判」当成「没有」。
    it('库太小：有命中才说「判定还不可靠」', () => {
      assert.equal(
        referenceNote({ reason: 'library-too-small', atoms: 12 }, 3),
        '库里只有 12 条，判定还不可靠；以下是按相关度列出的前几条。',
      )
      assert.equal(referenceNote({ reason: 'library-too-small', atoms: 12 }, 0), null)
    })

    it('线高过失效线：命中与否都说「判空关掉了」，措辞分开', () => {
      assert.equal(
        referenceNote({ reason: 'line-too-high', atoms: 5000 }, 4),
        '这个库的内容面比判定用的参考问句宽，判空这一步关掉了；以下是按相关度列出的前几条。',
      )
      assert.equal(
        referenceNote({ reason: 'line-too-high', atoms: 5000 }, 0),
        '这个库的内容面比判定用的参考问句宽，判空这一步关掉了；这次没有相关度靠前的条目。',
      )
    })

    it('线可用或编码器不可用时不补话', () => {
      assert.equal(referenceNote({ reason: 'ok', atoms: 5000 }, 3), null)
      assert.equal(referenceNote({ reason: 'no-encoder', atoms: 5000 }, 3), null)
    })
  })
})

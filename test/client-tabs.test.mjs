// 界面选项卡：读与改（管理）和诊断（配置）分成两页。
//
// 这些判据只能钉在渲染树上：浏览器半是手写发布产物、不参与 tsc，没有类型系统替它报错。
// 样式好不好看、真宿主里切换顺不顺，不进 CI（要人看）。
//
// 这里不 delete globalThis.document：同一个进程里还会跑别的界面用例，删掉会让它们的
// factory 调用失败。bundle 用带查询串的 URL 重新求值，避免命中 ESM 模块缓存。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

let bundleRegistrations = []
let styleTags = []
let bundleSeq = 0

function ensureDocument() {
  globalThis.document = {
    querySelector: () => null,
    createElement: (tag) => ({ dataset: {}, tagName: String(tag).toUpperCase() }),
    // 导出用例要挂一个 <a> 再点它；别的用例不会用到 body。
    body: { appendChild: () => {} },
    head: { appendChild: (tag) => styleTags.push(tag) },
  }
}

/**
 * 取一份新的浏览器半：先装替身，再用带查询串的 URL 重新求值。
 *
 * 同一个进程里还有别的界面用例 import 同一份 client.js，只要有一个先求值，
 * 后面的就命中 ESM 模块缓存 —— factory 与样式都取不到。查询串让它每次重新执行。
 */
async function loadBundle() {
  bundleRegistrations = []
  styleTags = []
  globalThis.window = { __ModuleLoader__: { load: (reg) => bundleRegistrations.push(reg) } }
  ensureDocument()
  await import(new URL('../lib/client.js?tabs=' + ++bundleSeq, import.meta.url).href)
  assert.equal(bundleRegistrations.length, 1, '浏览器半应当注册一个 bundle')
}

function createReactStub() {
  const hooks = []
  let cursor = 0
  let rerender = () => {}
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity),
    }),
    useState: (init) => {
      const i = cursor++
      if (hooks[i] === undefined) hooks[i] = { value: init, deps: null }
      const slot = hooks[i]
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
          rerender()
        },
      ]
    },
    useEffect: (fn, deps) => {
      const i = cursor++
      if (hooks[i] === undefined) hooks[i] = { value: undefined, deps: null }
      const slot = hooks[i]
      const same =
        Array.isArray(slot.deps) &&
        Array.isArray(deps) &&
        deps.length === slot.deps.length &&
        deps.every((d, k) => d === slot.deps[k])
      if (same) return
      slot.deps = deps
      fn()
    },
  }
  return {
    React,
    begin: () => {
      cursor = 0
    },
    onRerender: (fn) => {
      rerender = fn
    },
  }
}

const ROWS = [
  {
    id: 7,
    kind: '结论',
    summary: '注入预算是一个上限，不是每次都装满',
    origin: 'user',
    scope: 'global',
    flags: 0,
    supersededBy: null,
    recallHits: 0,
    lastRecalledAt: null,
  },
]

function fetchStub(url) {
  const pathname = new URL(String(url), 'http://127.0.0.1').pathname
  const payload = {
    '/api/lattice-ping-mini': {
      ok: true,
      version: '0.0.0-test',
      atoms: ROWS.length,
      dataDir: 'D:\\vault\\lattice',
      encoder: {
        enabled: true,
        model: 'Xenova/bge-small-zh-v1.5',
        mirror: '',
        state: 'ready',
        attempts: [{ host: 'https://huggingface.co/', ok: true, ms: 9857, error: null }],
      },
      tauJoin: 0.78,
      tauLex: 0.05,
      tauLexOnly: 0.1,
      tauNew: 0.5,
      viewBudget: 5000,
    },
    '/api/lattice-atoms': { ok: true, total: ROWS.length, offset: 0, limit: 20, rows: ROWS },
    // 配置表单读这条。形状按宿主实测的来：字段名在根节点的 dict 里、映射到 refs 的 uid，
    // 不是常见的 properties —— 用例照抄真实形状，写成一个更顺眼的形状就测不出解析错。
    '/api/lattice-config': {
      ok: true,
      ns: 'lattice',
      entry: {
        ns: 'lattice',
        autoGenerate: true,
        revision: 3,
        applies: 'live',
        value: { viewBudget: 5000, topN: 24 },
        base: { viewBudget: 5000, topN: 24 },
        user: {},
        schema: {
          uid: 7895,
          refs: {
            7893: {
              type: 'number',
              meta: { min: 1000, max: 20000, default: 5000, description: '单次召回注入的字符上限' },
            },
            7894: {
              type: 'number',
              meta: { min: 5, max: 50, default: 24, description: '交注入层的候选条数' },
            },
            7895: { type: 'object', meta: { default: {} }, dict: { viewBudget: 7893, topN: 7894 } },
          },
        },
      },
    },
    // 配置页的两个面板都读这条：给一份空库响应，它们走「没有可查的东西」分支。
    '/api/lattice-audit': {
      ok: true,
      dataState: 'empty',
      detail: '',
      recluster: { phase: 'idle' },
      entries: { learned: 0 },
    },
  }[pathname]
  if (payload === undefined) throw new Error('用例没给这条路由准备响应：' + pathname)
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function descendantsOf(node, out = []) {
  for (const child of node.children ?? []) {
    if (child === null || typeof child !== 'object') continue
    if (child.type !== undefined) out.push(child)
    descendantsOf(child, out)
  }
  return out
}

function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join(' ')
}

/** 挂一次界面：返回取当前渲染树与点某个选项卡的函数。 */
async function mount() {
  await loadBundle()
  const ui = createReactStub()
  const clientExports = bundleRegistrations[0].factory((spec) => {
    if (spec === 'react') return ui.React
    throw new Error('浏览器半 require 了未预期的模块：' + spec)
  })
  let component = null
  let sectionOptions = null
  clientExports.apply({
    effect: (fn) => fn(),
    slots: {
      inject: (key, factory) => factory(),
      register: (options, registered) => {
        sectionOptions = options
        component = registered
        return () => {}
      },
    },
  })
  let root = null
  const render = () => {
    ui.begin()
    root = component({})
  }
  ui.onRerender(render)
  render()
  return {
    getRoot: () => root,
    getSectionLabel: () => sectionOptions.label(),
    click: (text) => {
      const button = descendantsOf(root).find((n) => n.type === 'button' && textOf(n) === text)
      assert.ok(button, '找不到选项卡按钮：' + text)
      button.props.onClick()
    },
  }
}

describe('界面选项卡：管理与配置分开', () => {
  it('设置页入口自报「lattice 记忆库」，不是泛称', async () => {
    const view = await mount()
    assert.equal(
      view.getSectionLabel(),
      'lattice 记忆库',
      '入口名要能看出是哪个插件的库；泛称在多插件环境里分不清是谁',
    )
  })

  it('默认停在管理页，两个选项卡按钮的顺序是「管理」「配置」', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => fetchStub(url)
    try {
      const view = await mount()
      await settle()
      const root = view.getRoot()
      const tabs = descendantsOf(root).filter((n) =>
        String(n.props.className ?? '')
          .split(' ')
          .includes('lattice-tab'),
      )
      assert.equal(tabs.length, 2, '选项卡按钮应当正好两个')
      assert.deepEqual(
        tabs.map((n) => textOf(n)),
        ['管理', '配置'],
        '选项卡按钮的文本或顺序变了',
      )
      assert.match(String(tabs[0].props.className), /\bis-on\b/, '默认选中项应当是「管理」')
      assert.doesNotMatch(String(tabs[1].props.className), /\bis-on\b/, '「配置」不应当是默认选中项')

      const text = textOf(root)
      assert.ok(text.includes('注入预算是一个上限'), '管理页里没有列表行')
      assert.ok(
        descendantsOf(root).some(
          (n) => n.type === 'input' && String(n.props.placeholder ?? '').includes('搜索记忆'),
        ),
        '管理页里没有搜索框',
      )
      assert.equal(text.includes('导出日志'), false, '维护动作（导出日志）不该出现在管理页')
      assert.equal(text.includes('数据目录'), false, '读数卡片不该出现在管理页')
      assert.equal(
        root.children.filter((n) => n !== null && typeof n === 'object' && typeof n.type === 'function')
          .length,
        0,
        '管理页里不该有健康面板或维护面板',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('切到配置页：出现诊断块，搜索与列表消失；切回来列表数据还在', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => fetchStub(url)
    try {
      const view = await mount()
      await settle()

      view.click('配置')
      await settle()
      const configText = textOf(view.getRoot())
      assert.ok(configText.includes('导出日志'), '配置页里没有状态条上的维护入口')
      // 三个面板是函数组件，替身不执行它们（只创建元素节点），所以按「直接子元素里有几个
      // 函数组件」判断它们有没有被放进配置页 —— 没有就数不到这三个。
      const panels = view
        .getRoot()
        .children.filter((n) => n !== null && typeof n === 'object' && typeof n.type === 'function')
      assert.equal(panels.length, 3, '配置页里应当有配置表单、健康面板、维护面板三个组件')
      assert.deepEqual(
        panels.map((n) => n.props.key),
        ['config', 'health', 'maintenance'],
        '配置页里三个组件的顺序或身份变了',
      )
      // 导出那块是静态节点（两个按钮 + 一句说明），不进函数组件，所以按按钮文本找。
      assert.ok(
        descendantsOf(view.getRoot()).some((n) => n.type === 'button' && textOf(n) === '导出 JSON'),
        '配置页里没有导出按钮',
      )
      // 读数卡片：配置页要回答「现在按什么在跑」，值来自 /api/lattice-ping-mini。
      const cards = descendantsOf(view.getRoot()).filter((n) =>
        String(n.props.className ?? '')
          .split(' ')
          .includes('lattice-card'),
      )
      assert.equal(cards.length, 7, '配置页应当有七张读数卡片（含编码器状态那张）')
      assert.ok(configText.includes('数据目录'), '配置页里没有数据目录读数')
      assert.ok(configText.includes('D:\\vault\\lattice'), '数据目录的值没有上屏')
      assert.ok(configText.includes('Xenova/bge-small-zh-v1.5'), '编码器没有上屏')
      assert.ok(configText.includes('tauJoin'), '四个写入阈值没有上屏')
      assert.ok(configText.includes('这些读数是只读的'), '配置页没有写明读数只读、能改的项在下面的表单里')
      assert.equal(
        descendantsOf(view.getRoot()).some(
          (n) => n.type === 'input' && String(n.props.placeholder ?? '').includes('搜索记忆'),
        ),
        false,
        '搜索框仍留在配置页上',
      )
      assert.equal(configText.includes('注入预算是一个上限'), false, '列表行仍留在配置页上')

      view.click('管理')
      await settle()
      const backText = textOf(view.getRoot())
      assert.ok(
        backText.includes('注入预算是一个上限'),
        '切回管理页后列表数据没了：切换不该重新取数或清空已有数据',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('样式里有选项卡与卡片规则，选中态与未选中态底色不同', async () => {
    // 样式是在 factory 执行时注入的，所以要先走一次装配（不用渲染、不用取数）。
    await mount()
    assert.equal(styleTags.length, 1, '浏览器半应当注入一份样式')
    const css = styleTags[0].textContent
    const ruleOf = (selector) => {
      const start = css.indexOf(selector + ' {')
      assert.ok(start >= 0, '样式里没有 ' + selector + ' 规则')
      return css.slice(start, css.indexOf('}', start))
    }
    const tabsRule = ruleOf('.lattice-tabs')
    assert.match(tabsRule, /display:\s*flex/, '选项卡行不是横向排列')
    const tabRule = ruleOf('.lattice-tab')
    assert.match(tabRule, /border:/, '选项卡按钮没有边框')
    assert.match(tabRule, /padding:/, '选项卡按钮没有内边距')
    const onRule = ruleOf('.lattice-tab.is-on')
    const bgOf = (rule) => (rule.match(/background:\s*([^;]+);/) || [])[1]
    assert.ok(bgOf(onRule), '选中态没有背景色')
    assert.notEqual(bgOf(onRule), bgOf(tabRule), '选中态与未选中态的背景色一样，看不出选了哪一个')
    assert.match(ruleOf('.lattice-card'), /border-radius:/, '读数卡片没有圆角')
  })

  /**
   * 导出：点按钮必须**真的请求导出路由并落盘**，不是打开一个新窗口。
   *
   * 这条踩过一次（2026-10-24 用户实测「两个按钮点击无反应」）：原实现用 `window.open`，
   * 宿主渲染进程不放行新窗口 —— 既不下载也不报错，界面上就是「按钮坏了」。
   * 所以判据不能只钉「按钮存在」，要钉「点下去 fetch 到了路由、创建了带 download 的 <a> 并点过它」。
   */
  it('导出按钮：点下去请求导出路由，并把内容交给一个带 download 的 <a>', async () => {
    const originalFetch = globalThis.fetch
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    const originalDoc = globalThis.document
    const clicked = []
    const appended = []
    const created = []
    let requested = ''
    URL.createObjectURL = () => 'blob:download'
    URL.revokeObjectURL = () => {}
    globalThis.fetch = async (url) => {
      const href = String(url)
      // 只拦导出这一条；管理页自己的列表与搜索请求照旧走替身数据。
      if (!href.includes('/api/lattice-export')) return fetchStub(url)
      requested = href
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'attachment; filename="lattice-memory-20261024.json"' },
        blob: async () => new Blob(['{"ok":true}'], { type: 'application/json' }),
        text: async () => '{"ok":true}',
      }
    }
    try {
      const view = await mount()
      await settle()
      // mount 会重装 document，所以替身要在装配之后再换。
      globalThis.document = {
        querySelector: () => null,
        createElement: (tag) => {
          const node = {
            tagName: String(tag).toUpperCase(),
            click: () => clicked.push(node),
            remove: () => {},
          }
          created.push(node)
          return node
        },
        body: { appendChild: (node) => appended.push(node) },
        head: { appendChild: () => {} },
      }
      view.click('配置')
      await settle()
      view.click('导出 JSON')
      await settle()

      assert.match(requested, /\/api\/lattice-export\?format=json$/, '导出按钮没走导出路由')
      const anchor = created.find((node) => node.tagName === 'A')
      assert.ok(anchor, '点导出没有创建 <a>：内容不会落盘，用户只会看到按钮没反应')
      assert.equal(
        anchor.download,
        'lattice-memory-20261024.json',
        '文件名应当取自 content-disposition：客户端自己编的名字和服务端的日期可能差一天',
      )
      assert.equal(anchor.href, 'blob:download', '下载地址不是刚取回的内容')
      assert.equal(clicked.length, 1, '<a> 没有被点过，浏览器不会开始下载')
      assert.ok(appended.includes(anchor), '<a> 要挂进文档，否则有的浏览器不认这次点击')
    } finally {
      globalThis.fetch = originalFetch
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
      globalThis.document = originalDoc
    }
  })

  /**
   * 下载源报告：两个源都失败时，配置页要**逐源**说出「试了哪、错在哪」。
   * 只留最后一句时，用户分不清是官方源被墙还是镜像也挂了 —— 而这决定了他该换
   * 镜像还是查本机网络。
   */
  it('两个下载源都失败时，配置页逐源报出原因', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url), 'http://127.0.0.1').pathname
      if (pathname !== '/api/lattice-ping-mini') return fetchStub(url)
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            version: '0.0.0-test',
            atoms: ROWS.length,
            dataDir: 'D:\\vault\\lattice',
            encoder: {
              enabled: true,
              model: 'Xenova/bge-small-zh-v1.5',
              mirror: '',
              state: 'unavailable',
              attempts: [
                { host: 'https://huggingface.co/', ok: false, ms: 21045, error: 'fetch failed' },
                { host: 'https://modelscope.cn/', ok: false, ms: 1599, error: 'fetch failed' },
              ],
            },
            tauJoin: 0.78,
            tauLex: 0.05,
            tauLexOnly: 0.1,
            tauNew: 0.5,
            viewBudget: 5000,
          }),
      }
    }
    try {
      const view = await mount()
      await settle()
      view.click('配置')
      await settle()
      const box = descendantsOf(view.getRoot()).find((n) => n.props.className === 'lattice-fail')
      assert.ok(box, '两个源都失败，界面却没有报出原因')
      const text = textOf(box)
      assert.match(text, /https:\/\/huggingface\.co\//, '没说是哪个源')
      assert.match(text, /https:\/\/modelscope\.cn\//, '只报了第一个源，第二个源的失败原因丢了')
      assert.match(text, /fetch failed/, '只写了失败，没写原因')
      assert.match(text, /词面/, '没说清后果：召回会退回词面')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

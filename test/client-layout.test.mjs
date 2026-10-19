// 界面布局：搜索框固定在列表之外。
//
// 这个文件补的是「结构上成立」的那一半判据 —— 人在真宿主里滚动验收不进 CI。
// 它不测样式好不好看，只钉三件会让搜索框重新变得不可用的事：
//   1. 搜索条在列表**之前**渲染（排在列表之后 = 条目一多就被挤出视口，这正是原始故障）；
//   2. 列表有自己的滚动区（纵向滚动 + 高度上限），搜索条因此不在它的滚动内容里；
//   3. 固定用 sticky 而不是 fixed —— fixed 脱离文档流叠在内容上，只能靠一个补偿 padding 补回来，
//      而那个数从哪来说不清。
//
// 浏览器半是手写的发布产物、不参与 tsc：渲染顺序与 CSS 都只能在「渲染出来的树」与
// 「注入的样式」上钉，没有类型系统会替这道判据报错。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const bundleRegistrations = []
const styleTags = []

// 浏览器半在模块求值时注册 bundle 并注入样式，所以替身必须在 import 之前就位。
globalThis.window = { __ModuleLoader__: { load: (reg) => bundleRegistrations.push(reg) } }
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {} }),
  head: { appendChild: (tag) => styleTags.push(tag) },
}
await import(new URL('../lib/client.js', import.meta.url).href)

/** 带状态的 React 替身：组件的两次挂载取数要真的走完，树里才会有列表。 */
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

const LIST_ROWS = [
  {
    id: 1,
    kind: '结论',
    summary: '系统代理必须走本机端口',
    origin: 'user',
    scope: 'global',
    flags: 0,
    supersededBy: null,
    recallHits: 0,
    lastRecalledAt: null,
  },
  {
    id: 2,
    kind: '坑',
    summary: '符号链接失败时改 nodeLinker',
    origin: 'import',
    scope: 'proj-a',
    flags: 0,
    supersededBy: null,
    recallHits: 0,
    lastRecalledAt: null,
  },
  {
    id: 3,
    kind: '步骤',
    summary: '门禁要带着分支名跑',
    origin: 'model',
    scope: 'global',
    flags: 0,
    supersededBy: null,
    recallHits: 0,
    lastRecalledAt: null,
  },
]

/** 列表里取数的两条路由给一份固定响应；其余路径让用例直接红。 */
function fetchStub(url) {
  const pathname = new URL(String(url), 'http://127.0.0.1').pathname
  const payload = {
    '/api/lattice-ping-mini': { ok: true, version: '0.0.0-test', atoms: LIST_ROWS.length },
    '/api/lattice-atoms': { ok: true, total: LIST_ROWS.length, offset: 0, limit: 20, rows: LIST_ROWS },
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

describe('界面布局：搜索框固定在列表之外', () => {
  it('搜索条渲染在列表之前，列表自己滚，固定用 sticky 而不是 fixed', async () => {
    assert.equal(bundleRegistrations.length, 1, '浏览器半应当注册一个 bundle')

    const ui = createReactStub()
    // 样式是在 factory 执行时注入的（CSS 与注入代码都在 factory 里），所以替身 document
    // 必须留到这一步之后。
    const clientExports = bundleRegistrations[0].factory((spec) => {
      if (spec === 'react') return ui.React
      throw new Error('浏览器半 require 了未预期的模块：' + spec)
    })
    delete globalThis.document
    assert.equal(styleTags.length, 1, '浏览器半应当注入一份样式')
    let component = null
    clientExports.apply({
      effect: (fn) => fn(),
      slots: {
        inject: (key, factory) => factory(),
        register: (options, registered) => {
          component = registered
          return () => {}
        },
      },
    })
    assert.equal(typeof component, 'function', '浏览器半没有注册可渲染的区块')

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => fetchStub(url)
    let root = null
    try {
      const render = () => {
        ui.begin()
        root = component({})
      }
      ui.onRerender(render)
      render()
      await settle()
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.equal(root.type, 'div')
    assert.equal(root.props.className, 'lattice-panel')
    const blocks = root.children.filter((n) => n !== null && typeof n === 'object' && n.type !== undefined)
    const indexOfClass = (cls) =>
      blocks.findIndex((n) =>
        String(n.props.className ?? '')
          .split(' ')
          .includes(cls),
      )
    const searchIndex = indexOfClass('lattice-search')
    const rowsIndex = indexOfClass('lattice-rows')

    assert.ok(rowsIndex >= 0, '面板里找不到列表容器（.lattice-rows）：列表没渲染出来，这条用例会空过')
    assert.ok(searchIndex >= 0, '面板里找不到搜索条（.lattice-search）')
    assert.ok(searchIndex < rowsIndex, '搜索条排在了列表之后：条目一多就会像用户报告的那样被挤出视口')
    assert.ok(
      textOf(blocks[rowsIndex]).includes('系统代理必须走本机端口'),
      '列表容器里没有行：布局断言会在空列表上空过',
    )

    // 搜索输入框必须在列表滚动区之外 —— 只把搜索条排到前面但塞进同一个滚动容器，等于没修。
    const insideRows = descendantsOf(blocks[rowsIndex]).some(
      (n) => n.type === 'input' && String(n.props.placeholder ?? '').includes('搜索'),
    )
    assert.equal(insideRows, false, '搜索输入框仍嵌在列表滚动区里')

    const css = styleTags[0].textContent
    const ruleOf = (selector) => {
      const start = css.indexOf(selector + ' {')
      assert.ok(start >= 0, '样式里没有 ' + selector + ' 规则')
      return css.slice(start, css.indexOf('}', start))
    }
    const rowsRule = ruleOf('.lattice-rows')
    assert.match(rowsRule, /overflow-y:\s*auto/, '列表没有自己的纵向滚动区（overflow-y: auto）')
    assert.match(rowsRule, /max-height:/, '列表滚动区没有高度上限：长列表会把整页撑开，搜索条照样滚走')
    const searchRule = ruleOf('.lattice-search')
    assert.match(searchRule, /position:\s*sticky/, '搜索条不是 sticky：整页滚动时它会跟着滚出视口')
    assert.match(searchRule, /top:\s*0/, 'sticky 的搜索条没有贴住顶部')
    assert.doesNotMatch(
      css,
      /position:\s*fixed/,
      '不要用 fixed：它脱离文档流叠在内容上，只能靠补偿 padding 补回来，而那个数无从验证',
    )
  })
})

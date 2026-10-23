// 健康面板（lib/client.js）与只读体检路由（GET /api/lattice-audit）的两侧对照。
//
// 浏览器半是手写的发布产物：不参与 tsc，也没有浏览器可跑。所以这里分三层：
//   1. 源码层 —— 从 lib/client.js 抽出面板那一块的源码（文件里有起止标记），断言它只发
//      只读请求、面板自己不含数字；
//   2. 执行层 —— 把面板里的**纯函数**（healthModel 与它的依赖）从源码里抽出来执行，喂给
//      它的就是同一次路由响应：逐格断言「面板值 === 响应里那条路径的值」；再把响应里的
//      数字整体加一，断言每一格显示的数跟着变 —— 常量渲染过不了这一条；
//   3. 观测层 —— 请求该路由前后，另一条只读连接上的 data_version 与 atom / edge 行数不变。
//
// 三层缺一不可：只有源码断言，测不出字段名写错；只有执行层，测不出面板偷偷发写请求。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { apply } from '../dist/index.js'
import { openVault } from '../dist/db/open.js'
import { closeRuntime } from '../dist/state.js'
import { openRuler } from './ro-ruler.mjs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/** 面板源码块两端的标记（写进 lib/client.js 里，用例只读）。 */
const PANEL_START = '// ── 健康面板起点 ──'
const PANEL_END = '// ── 健康面板终点 ──'

function between(src, start, end) {
  const a = src.indexOf(start)
  assert.ok(a >= 0, '源码里找不到起点标记：' + start)
  const b = src.indexOf(end, a)
  assert.ok(b >= 0, '源码里找不到终点标记：' + end)
  return src.slice(a, b)
}

/** 跳过字符串与注释，从开括号 start 找到配对的闭括号，返回整段源码。 */
function balancedAt(src, start) {
  const closerOf = { '{': '}', '[': ']', '(': ')' }
  const stack = []
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i)
      if (i < 0) break
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i)
      if (i < 0) break
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === ch) break
        j++
      }
      i = j
      continue
    }
    if (closerOf[ch] !== undefined) stack.push(closerOf[ch])
    else if (ch === '}' || ch === ']' || ch === ')') {
      const want = stack.pop()
      assert.equal(ch, want, '括号不配对：' + src.slice(Math.max(0, i - 40), i + 5))
      if (stack.length === 0) return src.slice(start, i + 1)
    }
  }
  assert.fail('从偏移 ' + start + ' 起的括号没有闭合')
}

/** 取 `const 名字 = [...]` 的数组字面量源码。 */
function arrayLiteralSource(name) {
  const m = new RegExp('const ' + name + ' = ').exec(client)
  assert.ok(m !== null, '源码里找不到 ' + name)
  return balancedAt(client, m.index + m[0].length)
}

/** 取 `function 名字(...) { ... }` 的整段源码（本文件的函数都是声明式）。 */
function functionSource(name) {
  const m = new RegExp('function ' + name + '\\s*\\(').exec(client)
  assert.ok(m !== null, '源码里找不到函数 ' + name)
  const open = client.indexOf('{', m.index)
  // 从声明开头切到函数体末尾：只切花括号会丢掉函数名与形参（pad 的 n 就是这么丢的）。
  return client.slice(m.index, open + balancedAt(client, open).length)
}

/**
 * 抽出面板的纯函数并在测试里执行。**不是重新实现**：取的就是发布产物里那段源码，
 * 少了「用例自己另写一份模型、测的是那份模型」的风险。
 */
function makeHealthModel() {
  const groups = new Function('return ' + arrayLiteralSource('HEALTH_GROUPS'))()
  const body = ['healthValue', 'healthText', 'graphStatusText', 'rebuildText', 'healthModel']
    .map(functionSource)
    .join('\n')
  const build = new Function('HEALTH_GROUPS', body + '\nreturn healthModel')
  return { groups, model: build(groups) }
}

/** 测试自己的取值实现：不借面板的 healthValue，否则两侧同源就成了自己跟自己比。 */
function byPath(root, path) {
  let node = root
  for (const key of path.split('.')) {
    if (node === null || node === undefined) return undefined
    node = node[key]
  }
  return node
}

/** 最小 res 替身：记状态码与 JSON body（与 plugin.test.mjs 同形，必须是真 EventEmitter）。 */
function fakeRes() {
  const res = new EventEmitter()
  res.out = { status: 0, body: null }
  res.writeHead = (status) => {
    res.out.status = status
    return res
  }
  res.end = (text) => {
    res.out.body = typeof text === 'string' ? JSON.parse(text) : text
    return res
  }
  return res
}

/** 挂上插件，返回体检路由的 handler。 */
function auditRoute(config) {
  const routes = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    get: (key) => (key === 'tools' ? { register: () => {} } : key === 'webServer' ? webServer : undefined),
    effect: (fn) => fn(),
    inject: (deps, callback) => callback(ctx),
  }
  apply(ctx, config)
  const route = routes.find((r) => r.path === '/api/lattice-audit')
  assert.ok(route !== undefined, '没有挂上体检只读路由')
  return route
}

/** 调一次体检路由，返回它的 JSON。 */
function callAudit(route, url = '/api/lattice-audit') {
  const req = new EventEmitter()
  req.socket = { remoteAddress: '127.0.0.1' }
  req.method = 'GET'
  req.headers = {}
  req.url = url
  req.destroy = () => {}
  const res = fakeRes()
  route.handler(req, res)
  assert.equal(res.out.status, 200, '体检路由应回 200')
  return res.out.body
}

/**
 * 造一个「有数据、但图路没建、也没重聚类过」的库：这是最容易把 0 读成「一切正常」的形态。
 *
 * 数字刻意都不同（3 条 / 1 条归档 / 2 个有成员主题 / 1 个单成员主题 / 2 条入口 / 1 条 learned），
 * 这样「字段名写错」不会碰巧也相等。
 */
function seedVault(dir, opts = {}) {
  const { db } = openVault(join(dir, 'lattice.db'))
  const topic = db.prepare(
    'INSERT INTO topic(id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at) ' +
      'VALUES (?, ?, zeroblob(2048), ?, 0, 1, 1)',
  )
  topic.run(1, '主题一', 2)
  topic.run(2, '主题二', 1)
  const atom = db.prepare(
    'INSERT INTO atom(id, kind, text, summary, embedding, topic_id, fit, scope, origin, recall_hits, flags, created_at, updated_at) ' +
      "VALUES (?, '结论', ?, ?, zeroblob(2048), ?, 1.0, 'global', 'model', 0, ?, ?, ?)",
  )
  atom.run(1, '正文一', '摘要一', 1, 0, 1, 1)
  atom.run(2, '正文二', '摘要二', 1, 0, 2, 2)
  atom.run(3, '正文三', '摘要三', 2, 16, 3, 3)
  const entry = db.prepare(
    'INSERT INTO entry(atom_id, term, bigram, weight, origin, hits, created_at) VALUES (?, ?, ?, ?, ?, 0, 1)',
  )
  entry.run(1, '入口甲', '入口甲', 0.5, 'declared')
  entry.run(2, '入口乙', '入口乙', 0.3, 'learned')
  if (opts.edge === true) {
    db.prepare(
      'INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) ' +
        "VALUES ('atom', 1, 'atom', 2, 'related', 1, 'declared', 1)",
    ).run()
  }
  db.close()
}

describe('健康面板（只读体检路由的展示端）', () => {
  let baseConfig = null
  const tempDirs = []

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-health-panel-'))
    tempDirs.push(dir)
    // 每个用例一个临时库：dataDir 留空会回落到用户的真实库（与 plugin.test.mjs 同一条理由）。
    baseConfig = {
      enabled: true,
      dataDir: dir,
      encoderEnabled: true,
      encoderModel: 'Xenova/bge-small-zh-v1.5',
      tauJoin: 0.75,
      tauLex: 0.05,
      tauNew: 0.38,
      viewBudget: 6000,
      topN: 24,
    }
  })

  afterEach(() => {
    closeRuntime()
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('面板用的 URL 与宿主半的只读路由同值（源码级）', () => {
    const panelUrl = /const AUDIT_URL = '([^']+)'/.exec(client)
    const hostPath = /const AUDIT_ROUTE_PATH = '([^']+)'/.exec(host)
    assert.ok(panelUrl !== null, 'lib/client.js 里找不到 AUDIT_URL')
    assert.ok(hostPath !== null, 'src/index.ts 里找不到 AUDIT_ROUTE_PATH')
    assert.equal(panelUrl[1], hostPath[1], '面板与宿主半的体检路径不同值')
  })

  it('面板上屏的每个数字都等于同一次响应里的同名值（字段名写错就红）', () => {
    seedVault(baseConfig.dataDir)
    const json = callAudit(auditRoute(baseConfig))
    const { groups, model } = makeHealthModel()
    const m = model(json)

    assert.equal(m.ok, true)
    assert.equal(m.empty, false, '有数据时不应走空库分支')
    const expected = groups.flatMap((g) => g.fields)
    const cells = m.groups.flatMap((g) => g.rows)
    assert.equal(cells.length, expected.length, '上屏格数与字段清单不一致')

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      assert.equal(cell.path, expected[i].path, '面板格的顺序与字段清单不一致')
      const fromJson = byPath(json, cell.path)
      assert.notEqual(fromJson, undefined, cell.path + ' 在响应里取不到：字段名写错了？')
      assert.equal(cell.value, fromJson, cell.path + ' 的值与响应不一致')
      assert.equal(cell.text, String(fromJson), cell.path + ' 的显示值与响应不一致')
      assert.notEqual(cell.text, '—', cell.path + ' 显示成「—」：路径没解析出来')
    }
    // 抽一个数钉住夹具：全是 0 的话，「相等」是恒真的。
    assert.equal(byPath(json, 'topics.atoms'), 3)
    assert.notEqual(byPath(json, 'duplicates.total'), undefined)
  })

  it('面板的数来自响应而不是常量：响应里每个数加一，每一格都跟着变', () => {
    seedVault(baseConfig.dataDir)
    const json = callAudit(auditRoute(baseConfig))
    const { groups, model } = makeHealthModel()
    const before = model(json).groups.flatMap((g) => g.rows)

    const bumped = JSON.parse(JSON.stringify(json))
    for (const group of groups) {
      for (const field of group.fields) {
        const keys = field.path.split('.')
        let node = bumped
        for (const key of keys.slice(0, -1)) node = node[key]
        node[keys[keys.length - 1]] = node[keys[keys.length - 1]] + 1
      }
    }
    const after = model(bumped).groups.flatMap((g) => g.rows)
    assert.equal(after.length, before.length)
    for (let i = 0; i < before.length; i++) {
      assert.notEqual(before[i].text, after[i].text, before[i].path + ' 没跟着响应变：面板渲染的是常量')
    }
  })

  it('退化看得见：图路未建、从未重聚类（建过之后同一份代码给出别的词）', () => {
    seedVault(baseConfig.dataDir)
    const json = callAudit(auditRoute(baseConfig))
    const { model } = makeHealthModel()
    const m = model(json)

    assert.match(m.graph, /未建/, 'graph.status=not-built 时面板要说「未建」')
    assert.equal(m.rebuild, '从未重聚类', 'rebuiltAt=null 时面板要说「从未重聚类」')

    // 负向对照：把两个状态改掉，同一份面板代码必须给出别的词 —— 否则上一句可能是写死的。
    const built = JSON.parse(JSON.stringify(json))
    built.graph.status = 'built'
    built.duplicates.rebuiltAt = 1700000000000
    const m2 = model(built)
    assert.ok(!/未建/.test(m2.graph), '图路状态没有被响应驱动')
    assert.notEqual(m2.rebuild, '从未重聚类', '重聚类状态没有被响应驱动')
  })

  it('空库不报错：只说「库里还没有记忆」，不给一排 0', () => {
    // 不建库：路由返回 noDataReport（dataState=empty）。
    const json = callAudit(auditRoute(baseConfig))
    assert.equal(json.dataState, 'empty')
    const { model } = makeHealthModel()
    const m = model(json)

    assert.equal(m.ok, true, '空库不是错误')
    assert.equal(m.empty, true)
    assert.match(m.message, /库里还没有记忆/)
    assert.deepEqual(m.groups, [], '空库不显示数字格（一排 0 会被读成「检查过、没有问题」）')
    assert.equal(m.graph, '', '空库不显示图路状态词')
    assert.equal(m.rebuild, '', '空库不显示重聚类状态词')
  })

  it('面板只用只读请求：源码里没有 postJson / 第二条路径 / 数字常量', () => {
    const src = between(client, PANEL_START, PANEL_END)
    assert.ok(src.includes('getJson(AUDIT_URL)'), '面板要从只读路由取数')
    assert.ok(!src.includes('postJson'), '面板不得出现写请求')
    assert.ok(!src.includes('fetch('), '面板不自己 fetch，只走 getJson')
    assert.ok(!src.includes('method:'), '面板不构造请求方法')
    assert.ok(!/['"]\/api\//.test(src), '面板不直接写路由路径：路径只在 AUDIT_URL 一处')
    // 面板函数体里没有一个数字：屏幕上的数字只能来自 model（进而来自响应）。
    const panelFn = functionSource('HealthPanel')
    assert.ok(!/\d/.test(panelFn), 'HealthPanel 里出现了数字常量：面板数字必须从 model 来')
  })

  it('请求体检路由前后，另一条只读连接上的 data_version 与 atom / edge 行数不变', () => {
    seedVault(baseConfig.dataDir, { edge: true })
    const route = auditRoute(baseConfig)
    const file = join(baseConfig.dataDir, 'lattice.db')
    // 观测走另一条只读连接，且全程同一个实例（见 ro-ruler.mjs 的说明）。
    const ruler = openRuler(file)
    try {
      const before = ruler.read()
      assert.equal(before.rows.atom, 3, '夹具应有 3 条 atom —— 行数为 0 的基线测不出写')
      assert.equal(before.rows.edge, 1, '夹具应有 1 条 edge —— 行数为 0 的基线测不出写')

      const json = callAudit(route)
      assert.equal(json.dataState, 'ready')
      callAudit(route, '/api/lattice-audit?limit=1&offset=0')
      const after = ruler.read()

      assert.equal(after.dataVersion, before.dataVersion, '请求体检路由后 data_version 变了：写库了')
      assert.equal(after.rows.atom, before.rows.atom, 'atom 行数变了')
      assert.equal(after.rows.edge, before.rows.edge, 'edge 行数变了')
      assert.deepEqual(after, before, '体检路由前后库状态不一致')
    } finally {
      ruler.close()
    }
  })

  it('不进模型侧：工具仍是五个，面板不注册路由', () => {
    const tools = []
    const routes = []
    const webServer = {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
    const ctx = {
      get: (key) =>
        key === 'tools' ? { register: (t) => tools.push(t) } : key === 'webServer' ? webServer : undefined,
      effect: (fn) => fn(),
      inject: (deps, callback) => callback(ctx),
    }
    apply(ctx, baseConfig)

    const names = tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'lattice_expand',
      'lattice_list',
      'lattice_ping',
      'lattice_recall',
      'lattice_write',
    ])
    assert.ok(!names.includes('lattice_audit'), '体检不得注册成工具')
    // 面板不新增路由：体检路径只有一条，下面两条源码断言钉住面板自己既不碰 webServer、
    // 也不调 register。
    //
    // **这里不断言路由总数**：那是插件契约用例的职责（它维护一份显式的路径清单），
    // 在这里再数一遍就会在别的任务加路由时误报 —— 合并时实际发生过一次（另一条任务加了
    // 一条只读详情路由，这条用例报「面板不该新增路由」，而面板并不知情）。
    assert.equal(routes.filter((r) => r.path === '/api/lattice-audit').length, 1)
    const src = between(client, PANEL_START, PANEL_END)
    assert.ok(!src.includes('webServer'), '面板不碰路由注册')
    assert.ok(!src.includes('register('), '面板不注册路由')
  })
})

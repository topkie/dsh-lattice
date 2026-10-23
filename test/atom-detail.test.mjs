// 条目详情（点开看全文）的判据用例。
//
// 为什么这些用例不点浏览器：浏览器半（lib/client.js）是手写的发布产物，不在 Node 里执行
// （它调 window.__ModuleLoader__），所以「页面上搜得到标记」「点开后页面高度不变」只能由
// 真人在浏览器里看。这里钉住的是另外两半：
//   ① 后端行为 —— 列表不带正文、详情不截断、点开不写库、被取代的条目带得出取代者；
//   ② 浏览器半的**源码形状** —— 有没有展开态、有没有详情请求、正文容器有没有容器内滚动。
// 形状写死的东西只能在源码层面钉住（与 client-source.test.mjs 同一条理由）。
//
// 数据用**临时库**：这里只读，直接 INSERT 构造输入，比跑一遍写入管线快，也不会因为
// 落位阈值或切词规则微调而跟着摇。

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { apply } from '../dist/index.js'
import { openVault } from '../dist/db/open.js'
import { closeRuntime } from '../dist/state.js'
import { openRuler } from './ro-ruler.mjs'

/** 正文末尾的独特标记：判据 2 要求「点开前搜不到、点开后搜得到」，靠它认。 */
const TAIL_MARK = 'TAIL-9F3A'

let dir = ''
let dbFile = ''

describe('atom-detail', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-detail-'))
    dbFile = join(dir, 'lattice.db')
  })

  afterEach(() => {
    // 先复位全局运行时单例，再删目录：库连接还开着时删文件在 Windows 上会失败。
    closeRuntime()
    rmSync(dir, { recursive: true, force: true })
  })

  /** 用例配置。dataDir 指到临时目录 —— 留空会回落到用户的真实库。 */
  function config() {
    return {
      enabled: true,
      dataDir: dir,
      // 关掉编码器：详情与目录都不需要向量，开着只会触发模型加载（本机离线）。
      encoderEnabled: false,
      encoderModel: 'Xenova/bge-small-zh-v1.5',
      tauJoin: 0.75,
      tauLex: 0.05,
      tauNew: 0.38,
      topN: 24,
    }
  }

  /** 塞一条 atom。只写本组用例要看的列：详情是只读取数，不经过写入管线。 */
  function seed(id, o = {}) {
    const { db } = openVault(dbFile)
    db.prepare(
      'INSERT INTO atom(id, kind, text, summary, embedding, scope, origin, created_at, updated_at, superseded_by) ' +
        'VALUES (?, ?, ?, ?, zeroblob(2048), ?, ?, ?, ?, ?)',
    ).run(
      id,
      o.kind ?? '结论',
      o.text ?? '正文' + id,
      o.summary ?? '摘要' + id,
      o.scope ?? 'global',
      o.origin ?? 'model',
      id,
      id,
      o.supersededBy ?? null,
    )
    db.close()
  }

  /** 挂上路由：假 ctx 只实现插件用到的那两个服务（与 plugin.test.mjs 同一口径）。 */
  function routeSet() {
    const routes = []
    const webServer = {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
    const ctx = {
      get: (k) => {
        if (k === 'tools') return { register: () => {} }
        if (k === 'webServer') return webServer
        return undefined
      },
      effect: (fn) => fn(),
      // webServer 只经 inject 的回调上下文出现（注册是条件注入的）。
      inject: (deps, callback) => callback(Object.assign({}, ctx, { webServer })),
    }
    apply(ctx, config())
    return routes
  }

  /** 最小 res 替身：必须是真 EventEmitter（真 ServerResponse 的 end() 会挂 finish）。 */
  function fakeRes() {
    const res = new EventEmitter()
    res.out = { status: 0, body: null }
    res.writeHead = (status) => {
      res.out.status = status
      return res
    }
    res.end = (text) => {
      try {
        res.out.body = JSON.parse(text)
      } catch {
        res.out.body = text
      }
      return res
    }
    return res
  }

  /** 最小 req 替身。GET 路由不读 body，所以不必像写端点那样发流。 */
  function fakeReq(url, { method = 'GET', remote = '127.0.0.1' } = {}) {
    const req = new EventEmitter()
    req.socket = { remoteAddress: remote }
    req.method = method
    req.headers = {}
    req.url = url
    req.destroy = () => {}
    return req
  }

  /** 调一次 handler，拿到状态码与已解析的 body。 */
  function call(handler, url, opts) {
    const res = fakeRes()
    handler(fakeReq(url, opts), res)
    return res.out
  }

  function handlerOf(routes, path) {
    const route = routes.find((r) => r.path === path)
    assert.ok(route !== undefined, '没有挂上路由 ' + path)
    return route.handler
  }

  /**
   * 预热：先请求一次目录。
   *
   * 真人点开之前一定已经看过列表 —— 那一次请求早已把运行时建起来（打开库、补库自描述）。
   * 「点开不改库」要量的是**点开这一步**，所以预热必须落在测量之外；否则量到的是首次打开
   * 库时的那几条写入，与被测行为无关。这一步不是为了让用例好看，**顺序错了判据就假红**。
   */
  function warmUp(routes) {
    const out = call(handlerOf(routes, '/api/lattice-atoms'), '/api/lattice-atoms')
    assert.equal(out.status, 200)
    return out
  }

  /** 用 SQL 数一条的字符数 —— 判据 3 的对照基线。 */
  function sqlTextLength(id) {
    const ro = new DatabaseSync(dbFile, { readOnly: true })
    try {
      return Number(ro.prepare('SELECT length(text) AS n FROM atom WHERE id = ?').get(id).n)
    } finally {
      ro.close()
    }
  }

  describe('条目详情：点开才取全文', () => {
    it('① 列表不带正文：目录响应里没有 text 字段，目录的 SELECT 也不含这一列', () => {
      seed(1, { text: '第一条正文' })
      seed(2, { text: '第二条正文' })
      const routes = routeSet()
      const out = warmUp(routes)

      assert.equal(out.body.ok, true)
      assert.equal(out.body.rows.length, 2)
      for (const row of out.body.rows) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(row, 'text'),
          false,
          '目录行带了 text：列表就又变成「把给模型的预算套到人身上」',
        )
      }
      assert.doesNotMatch(JSON.stringify(out.body.rows), /"text"/, '目录响应里出现了 text 键')

      // 判据 1 的构造失败点：把 text 加进 listAtoms 的 SELECT。运行时断言看不见这一处
      // （投影里不加映射，键集合就不会变），所以投影本身也要钉住。
      const src = readFileSync(new URL('../src/pipeline/list.ts', import.meta.url), 'utf8')
      const at = src.indexOf('const LIST_COLUMNS')
      assert.ok(at >= 0, '源码里找不到 LIST_COLUMNS —— 这条断言要跟着改名走')
      const tail = src.slice(at)
      const end = tail.indexOf('\n\n')
      const block = end >= 0 ? tail.slice(0, end) : tail
      const columns = [...block.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('')
      assert.ok(columns.length > 0, '没解析出列名，断言会变成恒真')
      assert.doesNotMatch(columns, /\btext\b/, '目录的 SELECT 里出现了 text 列：列表不该带正文')
    })

    it('② 详情给的是全文：末尾标记在，字数与 SELECT length(text) 差 0', () => {
      // ≥600 字、末尾带独特标记：判据 2 的样本形状。
      const long = '这'.repeat(600) + TAIL_MARK
      seed(1, { text: long, summary: '长条目' })
      const routes = routeSet()
      warmUp(routes)

      const out = call(handlerOf(routes, '/api/lattice-atom'), '/api/lattice-atom?id=1')
      assert.equal(out.status, 200)
      assert.equal(out.body.ok, true)
      const atom = out.body.atom
      assert.equal(atom.text.endsWith(TAIL_MARK), true, '正文尾部标记不在：详情被截断了')
      assert.equal(atom.text.includes(TAIL_MARK), true)
      assert.equal(atom.text.length, long.length, '正文长度与写入的不一致')

      // 判据 3：界面显示的字数来自 atom.textLength，它是 SQL 数出来的 —— 对照基线同一条 SQL。
      assert.equal(atom.textLength, sqlTextLength(1))
    })

    it('③ 失效条目要说清：详情带 supersededBy，界面有「已被 #N 取代」的渲染分支', () => {
      seed(1, { text: '旧条文' })
      seed(2, { text: '新条文', supersededBy: 1 })
      const routes = routeSet()
      warmUp(routes)

      const out = call(handlerOf(routes, '/api/lattice-atom'), '/api/lattice-atom?id=2')
      assert.equal(out.status, 200)
      assert.equal(out.body.atom.supersededBy, 1, '详情没带出取代者：界面无从提示')

      // 浏览器半的渲染分支：形状写死，只能在源码层面钉住（判据 6 的后半）。
      const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
      assert.match(client, /已被 #' \+ atom\.supersededBy \+ ' 取代/, '详情里没有「已被 #N 取代」的渲染分支')
    })

    it('④ 点开不改库：第二只读连接的 data_version、行数、MAX(updated_at) 全不变', () => {
      seed(1, { text: 'a'.repeat(700) })
      seed(2, { text: 'b'.repeat(50) })
      const routes = routeSet()
      const detailHandler = handlerOf(routes, '/api/lattice-atom')
      warmUp(routes)

      // 观测尺从**另一个连接**上量（test/ro-ruler.mjs）：同连接内读 data_version 恒真。
      const ruler = openRuler(dbFile)
      const ro = new DatabaseSync(dbFile, { readOnly: true })
      const snapshot = () => ({
        ruler: ruler.read(),
        maxUpdatedAt: Number(ro.prepare('SELECT COALESCE(MAX(updated_at), 0) AS n FROM atom').get().n),
        atomCount: Number(ro.prepare('SELECT COUNT(*) AS n FROM atom').get().n),
      })
      try {
        const before = snapshot()
        const first = call(detailHandler, '/api/lattice-atom?id=1')
        const second = call(detailHandler, '/api/lattice-atom?id=2')
        const again = call(detailHandler, '/api/lattice-atom?id=1')
        const after = snapshot()

        assert.equal(first.status, 200)
        assert.equal(second.status, 200)
        assert.equal(again.status, 200)
        assert.equal(after.ruler.dataVersion, before.ruler.dataVersion, '点开改动了库（data_version 变了）')
        assert.deepEqual(after.ruler.rows, before.ruler.rows, '点开改了表行数')
        assert.equal(after.atomCount, before.atomCount)
        assert.equal(after.maxUpdatedAt, before.maxUpdatedAt, '点开更新了某条 atom')
      } finally {
        ruler.close()
        ro.close()
      }
    })

    it('⑤ 详情路由只有一道读栅栏：非回环 403、非 GET 405、缺 id 400、查无此条 404', () => {
      seed(1, {})
      const routes = routeSet()
      warmUp(routes)
      const detail = handlerOf(routes, '/api/lattice-atom')

      assert.equal(call(detail, '/api/lattice-atom?id=1', { remote: '10.0.0.7' }).status, 403)
      assert.equal(call(detail, '/api/lattice-atom?id=1', { method: 'POST' }).status, 405)
      assert.equal(call(detail, '/api/lattice-atom').status, 400)
      assert.equal(call(detail, '/api/lattice-atom?id=0').status, 400)
      assert.equal(call(detail, '/api/lattice-atom?id=abc').status, 400)
      assert.equal(call(detail, '/api/lattice-atom?id=999').status, 404)
      // 不合法 id 与查无此条分开报：前者是请求写错了，后者是「这条已经没了」。
      assert.equal(call(detail, '/api/lattice-atom?id=999').body.error, 'not-found')
    })
  })

  describe('浏览器半：展开态的形状（判据 2 / 5 的可机械部分）', () => {
    const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

    it('有详情请求、有展开 / 收起入口，且详情请求只在点开时发出', () => {
      assert.match(client, /const ATOM_DETAIL_URL = '\/api\/lattice-atom'/, '没有详情路由常量')
      assert.match(client, /getJson\(ATOM_DETAIL_URL \+ '\?id=' \+ row\.id\)/, '点开时没有发起详情请求')
      assert.match(client, /'展开全文'/, '没有展开入口')
      assert.match(client, /'收起'/, '展开之后没有收起入口')
      // 摘要本身就带 onClick：只给按钮的话，人点那行字会「没反应」。
      assert.match(client, /lattice-summary-open/, '摘要没有做成可点开')
    })

    it('正文装在容器内滚动的盒子里（判据 5：5000 字不撑开页面、按钮不被遮）', () => {
      const rule = /lattice-detail-body \{([^}]*)\}/.exec(client)
      assert.ok(rule !== null, '没有正文容器 .lattice-detail-body')
      assert.match(rule[1], /max-height:\s*\d+px/, '正文容器没有 max-height：长正文会把页面撑开')
      assert.match(rule[1], /overflow:\s*auto/, '正文容器没有滚动：长正文会把页面撑开')
      // 展开区不得浮起来：覆盖层会把删除按钮挡住。
      assert.doesNotMatch(rule[1], /position:\s*(absolute|fixed)/, '正文容器用了定位：会盖住其它按钮')
    })
  })
})

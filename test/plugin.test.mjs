import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import { Config, apply, inject, name } from '../dist/index.js'

/**
 * 最小假 ctx：只实现插件用到的那两个服务，外加 `inject`。
 *
 * `inject(deps, callback)` 在真 cordis 里起的是一个**子 fiber**：deps 全部就绪才执行
 * callback，父插件不受影响（registry.ts：inject 就是 plugin({ inject, apply })）。
 * 替身按契约照做：给了 `webServer` 就跑回调，没给就只记下依赖、不跑。
 *
 * 为什么这两条要分开测：M3-T19 实测的那次失败**没有报错**，只是路由没注册 ——
 * 「静默跳过」正是缺陷的直接形态，所以要同时钉住「给了就注册」与「没给不抛也不注册」。
 */
function fakeCtx({ webServer } = {}) {
  const registered = []
  const routes = []
  const injected = []
  const ctx = {
    registered,
    routes,
    injected,
    get: (k) => {
      if (k === 'tools') return { register: (t) => registered.push(t) }
      if (k === 'webServer') return webServer
      return undefined
    },
    effect: (fn) => fn(),
    inject: (deps, callback) => {
      injected.push(deps)
      if (webServer === undefined) return
      callback(Object.assign({}, ctx, { webServer }))
    },
  }
  return ctx
}

const baseConfig = {
  enabled: true,
  dataDir: '',
  encoderEnabled: true,
  encoderModel: 'Xenova/bge-small-zh-v1.5',
  tauJoin: 0.75,
  tauLex: 0.05,
  tauNew: 0.38,
  viewBudget: 6000,
  topN: 24,
}

describe('插件契约', () => {
  it('导出宿主所需的四个入口', () => {
    assert.equal(name, 'lattice')
    assert.ok(inject.includes('tools'))
    // schemastery 把字段表放在 `dict`（早期版本里叫 shape），两种都认。
    const fields = Config.dict ?? Config.shape
    assert.ok(Object.keys(fields).includes('enabled'))
    assert.equal(typeof apply, 'function')
  })

  /**
   * 模型侧的工具表是**闭集**，改它要先有裁决。
   *
   * 2026-10-18：按裁决 #30 新增第 6 个工具 `lattice_feedback`（样本反馈），
   * 本条断言因此从「四个业务工具 + ping」改为「五个业务工具 + ping = 6」。
   * 改这条的理由只该是「裁决表里多了一条」，不该是「代码里顺手多加了一个」。
   */
  it('激活时注册五个业务工具与一个健康检查（共六个，含 feedback）', () => {
    const ctx = fakeCtx()
    apply(ctx, baseConfig)
    const names = ctx.registered.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'lattice_expand',
      'lattice_feedback',
      'lattice_list',
      'lattice_ping',
      'lattice_recall',
      'lattice_write',
    ])
    assert.equal(names.length, 6)
    for (const t of ctx.registered) assert.equal(typeof t.output.render, 'function')
  })

  it('健康检查返回版本与配置摘要', async () => {
    const ctx = fakeCtx()
    apply(ctx, baseConfig)
    // 按名字取 ping，不依赖注册顺序 —— 顺序是实现细节，不该被测试绑住。
    const ping = ctx.registered.find((t) => t.name === 'lattice_ping')
    const out = JSON.parse(await ping.execute({}, {}))
    assert.equal(out.ok, true)
    assert.equal(out.plugin, 'lattice')
    assert.equal(out.thresholds.tauJoin, baseConfig.tauJoin)
  })

  it('enabled=false 时不注册任何工具', () => {
    const ctx = fakeCtx()
    apply(ctx, { ...baseConfig, enabled: false })
    assert.equal(ctx.registered.length, 0)
  })

  it('宿主未提供 tools 服务时安全退出', () => {
    assert.doesNotThrow(() => apply({ get: () => undefined }, baseConfig))
  })

  it('宿主提供 webServer 时把六条路由挂上去（四条只读 + 两条写）', () => {
    const routes = []
    const webServer = {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
    const ctx = fakeCtx({ webServer })
    apply(ctx, baseConfig)

    // 硬约束：这条路由只能是**条件**注入，不能进模块级 inject —— 进去就等于
    // 「没有 Web 载体的 profile 里整个插件都不激活」，连四个工具一起没。
    assert.deepEqual([...inject], ['tools'], '模块级 inject 不得包含 webServer')
    assert.deepEqual(ctx.injected, [['webServer']], '只对 webServer 做条件注入')

    // M3-T19 加了目录与搜索（共三条只读），M3-T20 加了删除（写端点），
    // M4-T44 加了日志导出（只读）与日志清空（写端点）。
    // 断言路径**集合**而不是顺序：注册顺序是实现细节，不该被测试绑住。
    assert.equal(routes.length, 6, '四条只读路由 + 两条写路由都应挂上')
    assert.deepEqual(routes.map((r) => r.path).sort(), [
      '/api/lattice-atoms',
      '/api/lattice-forget',
      '/api/lattice-log-clear',
      '/api/lattice-log-export',
      '/api/lattice-ping-mini',
      '/api/lattice-search',
    ])
    for (const route of routes) {
      assert.equal(route.kind, 'exact')
      assert.equal(typeof route.handler, 'function')
    }
  })

  /**
   * 写端点的三道栅栏。替身 req/res，按 node:http 的形状给最小字段。
   *
   * 只断言**本插件的行为**（AGENTS.md 第七节）：这里不验宿主会不会做某事，
   * 只验这条 handler 在给定输入下拒了什么、放行了什么。
   */
  function forgetHandler() {
    const routes = []
    const webServer = {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
    apply(fakeCtx({ webServer }), baseConfig)
    return routes.find((r) => r.path === '/api/lattice-forget').handler
  }

  /**
   * 最小 res 替身：记状态码与 body。
   *
   * **必须是真 EventEmitter**：node:http 的 ServerResponse.end() 会走写路径并挂 `finish`，
   * 普通对象上少一个 `on`，异常就会被 handler 的 catch 吞成 500 —— 断言因此拿到 500，
   * 于是看起来像「栅栏没生效」，其实是替身没造全。
   */
  function fakeRes() {
    const res = new EventEmitter()
    res.out = { status: 0, body: null }
    res.writeHead = (status) => {
      res.out.status = status
      return res
    }
    res.end = (text) => {
      if (typeof text === 'string') {
        try {
          res.out.body = JSON.parse(text)
        } catch {
          res.out.body = text
        }
      }
      return res
    }
    return res
  }

  /**
   * 最小 req 替身：**必须是真 EventEmitter**。
   *
   * 一开始写成「调用 on('data') 时立刻回调」的普通对象，结果 handler 挂监听之前 body 就发完了，
   * `readJsonBody` 的 Promise 永远不结算，express 层超时成了 500 —— 栅栏断言因此拿到 500 而不是
   * 415。替身不按被替代物的时序来，测出来的就不是真实行为。
   */
  function fakeReq({
    remote = '127.0.0.1',
    method = 'POST',
    type = 'application/json',
    body = '{"atom_id":1}',
  } = {}) {
    const req = new EventEmitter()
    req.socket = { remoteAddress: remote }
    req.method = method
    req.headers = type === null ? {} : { 'content-type': type }
    req.url = '/api/lattice-forget'
    req.destroy = () => {}
    // 无论什么方法都发完 body：真实请求的流一定会结束，替身不发的话，handler 里
    // `await readJsonBody` 的 Promise 永不结算 —— 那不是被测代码的行为，是替身的缺陷。
    setImmediate(() => {
      req.emit('data', Buffer.from(body, 'utf8'))
      req.emit('end')
    })
    return req
  }

  it('写端点第一道栅栏：非回环来源 403，且不问它用什么方法', async () => {
    const handler = forgetHandler()
    const res = fakeRes()
    await handler(fakeReq({ remote: '10.0.0.7' }), res)
    assert.equal(res.out.status, 403)
    assert.equal(res.out.body.error, 'forbidden')
  })

  it('写端点第二道栅栏：非 POST 405（GET 也拒，与只读端点方向相反）', async () => {
    const handler = forgetHandler()
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    assert.equal(res.out.status, 405)
    assert.equal(res.out.body.error, 'method')
  })

  it('写端点第三道栅栏：content-type 不是 application/json 时 415', async () => {
    const handler = forgetHandler()
    // 这正是跨站表单能发出的那一种 —— 挡的就是它。
    const res = fakeRes()
    await handler(fakeReq({ type: 'application/x-www-form-urlencoded' }), res)
    assert.equal(res.out.status, 415)
    assert.equal(res.out.body.error, 'content-type')

    // 缺头同样拒：默认值不算通过。
    const res2 = fakeRes()
    await handler(fakeReq({ type: null }), res2)
    assert.equal(res2.out.status, 415)
  })

  it('改写体不是合法 JSON 时 400，而不是当成空删除', async () => {
    const handler = forgetHandler()
    const res = fakeRes()
    await handler(fakeReq({ body: 'not json' }), res)
    assert.equal(res.out.status, 400)
    assert.equal(res.out.body.error, 'bad-body')
  })

  it('宿主没有 webServer 时不注册路由、不抛，六个工具照常在', () => {
    const ctx = fakeCtx()
    assert.doesNotThrow(() => apply(ctx, baseConfig))
    assert.deepEqual(ctx.injected, [['webServer']], '依赖照样声明，只是不会执行')
    assert.equal(ctx.routes.length, 0, '没有服务就不该有路由')
    // 与上一条合起来钉死「静默跳过」：不报错，但也不能什么都不做。
    assert.deepEqual(ctx.registered.map((t) => t.name).sort(), [
      'lattice_expand',
      'lattice_feedback',
      'lattice_list',
      'lattice_ping',
      'lattice_recall',
      'lattice_write',
    ])
  })
})

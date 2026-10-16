import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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

  it('激活时注册四个业务工具与一个健康检查', () => {
    const ctx = fakeCtx()
    apply(ctx, baseConfig)
    const names = ctx.registered.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'lattice_expand',
      'lattice_list',
      'lattice_ping',
      'lattice_recall',
      'lattice_write',
    ])
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

  it('宿主提供 webServer 时把只读路由挂上去', () => {
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

    // M3-T19 的真界面加了目录与搜索两条，所以这里是三条而不是一条。
    // 断言路径**集合**而不是顺序：注册顺序是实现细节，不该被测试绑住。
    assert.equal(routes.length, 3, '三条只读路由都应挂上')
    assert.deepEqual(routes.map((r) => r.path).sort(), [
      '/api/lattice-atoms',
      '/api/lattice-ping-mini',
      '/api/lattice-search',
    ])
    for (const route of routes) {
      assert.equal(route.kind, 'exact')
      assert.equal(typeof route.handler, 'function')
    }
  })

  it('宿主没有 webServer 时不注册路由、不抛，四个工具照常在', () => {
    const ctx = fakeCtx()
    assert.doesNotThrow(() => apply(ctx, baseConfig))
    assert.deepEqual(ctx.injected, [['webServer']], '依赖照样声明，只是不会执行')
    assert.equal(ctx.routes.length, 0, '没有服务就不该有路由')
    // 与上一条合起来钉死「静默跳过」：不报错，但也不能什么都不做。
    assert.deepEqual(ctx.registered.map((t) => t.name).sort(), [
      'lattice_expand',
      'lattice_list',
      'lattice_ping',
      'lattice_recall',
      'lattice_write',
    ])
  })
})

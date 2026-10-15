import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Config, apply, inject, name } from '../dist/index.js'

/** 最小假 ctx：只实现插件用到的那一个服务。 */
function fakeCtx() {
  const registered = []
  return {
    registered,
    get: (k) => (k === 'tools' ? { register: (t) => registered.push(t) } : undefined),
  }
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

  it('激活时注册健康检查工具', () => {
    const ctx = fakeCtx()
    apply(ctx, baseConfig)
    assert.equal(ctx.registered.length, 1)
    assert.equal(ctx.registered[0].name, 'lattice_ping')
    assert.equal(typeof ctx.registered[0].output.render, 'function')
  })

  it('健康检查返回版本与配置摘要', async () => {
    const ctx = fakeCtx()
    apply(ctx, baseConfig)
    const out = JSON.parse(await ctx.registered[0].execute({}, {}))
    assert.equal(out.ok, true)
    assert.equal(out.plugin, 'lattice')
    assert.equal(out.thresholds.tauJoin, 0.75)
  })

  it('enabled=false 时不注册任何工具', () => {
    const ctx = fakeCtx()
    apply(ctx, { ...baseConfig, enabled: false })
    assert.equal(ctx.registered.length, 0)
  })

  it('宿主未提供 tools 服务时安全退出', () => {
    assert.doesNotThrow(() => apply({ get: () => undefined }, baseConfig))
  })
})

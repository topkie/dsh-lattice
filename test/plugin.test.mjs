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
})

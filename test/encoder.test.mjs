import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  centroidOf,
  encode,
  encodeBatch,
  encoderError,
  encoderState,
  ensureEncoder,
  resetEncoder,
} from '../dist/encoder/index.js'
import { VEC_DIM, l2norm } from '../dist/util/vec.js'

const opts = { model: 'test/not-a-real-model' }

describe('编码器降级', () => {
  it('初始状态为 idle', () => {
    resetEncoder()
    assert.equal(encoderState(), 'idle')
    assert.equal(encoderError(), null)
  })

  it('加载失败时进入 unavailable 并记录原因，而不是抛错', async () => {
    resetEncoder()
    const ok = await ensureEncoder(opts)
    assert.equal(ok, false)
    assert.equal(encoderState(), 'unavailable')
    assert.ok(typeof encoderError() === 'string' && encoderError().length > 0)
  })

  it('降级态下 encode 返回 null', async () => {
    resetEncoder()
    assert.equal(await encode('任意文本', opts), null)
  })

  it('降级态下批量编码返回等长的 null 数组', async () => {
    resetEncoder()
    const out = await encodeBatch(['一', '二', '三'], opts)
    assert.equal(out.length, 3)
    assert.ok(out.every((v) => v === null))
  })

  it('空输入不触发加载', async () => {
    resetEncoder()
    assert.deepEqual(await encodeBatch([], opts), [])
    assert.equal(encoderState(), 'idle')
  })

  it('复位后可重新尝试加载', async () => {
    resetEncoder()
    await ensureEncoder(opts)
    resetEncoder()
    assert.equal(encoderState(), 'idle')
    assert.equal(encoderError(), null)
  })
})

describe('中心向量', () => {
  it('成员均值后归一化', () => {
    const a = new Float32Array(VEC_DIM).fill(1)
    const b = new Float32Array(VEC_DIM).fill(1)
    const c = centroidOf([a, b])
    assert.equal(c.length, VEC_DIM)
    assert.ok(Math.abs(l2norm(c) - 1) < 1e-6)
  })

  it('单成员结果与原向量同向', () => {
    const v = new Float32Array(VEC_DIM)
    v[0] = 3
    const c = centroidOf([v])
    assert.ok(Math.abs(c[0] - 1) < 1e-6)
  })
})
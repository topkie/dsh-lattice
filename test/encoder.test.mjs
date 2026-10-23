import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_MIRROR_HOST,
  OFFICIAL_HOST,
  centroidOf,
  encode,
  encodeBatch,
  encoderAttempts,
  encoderError,
  encoderState,
  ensureEncoder,
  hostList,
  resetEncoder,
} from '../dist/encoder/index.js'
import { VEC_DIM, l2norm } from '../dist/util/vec.js'

const opts = { model: 'test/not-a-real-model' }

// 用例一律注入加载器，不走真网络：真网络会让「失败」这条判据依赖当天能不能连上
// huggingface.co，机器一变结论就变。
const noNetwork = async () => {
  throw new Error('用例不联网：注入的加载器直接失败')
}
const offline = { ...opts, load: noNetwork }
// 「试几个源」是配置层的决定（state.ts 调 hostList），ensureEncoder 只按给到的顺序试。
const twoSources = { ...opts, hosts: hostList('') }

describe('编码器降级', () => {
  it('初始状态为 idle', () => {
    resetEncoder()
    assert.equal(encoderState(), 'idle')
    assert.equal(encoderError(), null)
  })

  it('加载失败时进入 unavailable 并记录原因，而不是抛错', async () => {
    resetEncoder()
    const ok = await ensureEncoder(offline)
    assert.equal(ok, false)
    assert.equal(encoderState(), 'unavailable')
    assert.ok(typeof encoderError() === 'string' && encoderError().length > 0)
  })

  it('降级态下 encode 返回 null', async () => {
    resetEncoder()
    assert.equal(await encode('任意文本', offline), null)
  })

  it('降级态下批量编码返回等长的 null 数组', async () => {
    resetEncoder()
    const out = await encodeBatch(['一', '二', '三'], offline)
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
    await ensureEncoder(offline)
    resetEncoder()
    assert.equal(encoderState(), 'idle')
    assert.equal(encoderError(), null)
  })
})

describe('编码器下载源', () => {
  it('默认两个源，官方在前', () => {
    assert.deepEqual(hostList(''), [OFFICIAL_HOST, DEFAULT_MIRROR_HOST])
    assert.deepEqual(hostList('  '), [OFFICIAL_HOST, DEFAULT_MIRROR_HOST])
    assert.deepEqual(hostList('https://example.com'), [OFFICIAL_HOST, 'https://example.com'])
  })

  it('镜像填成官方地址时只试一次，同一个源不试两遍', () => {
    assert.deepEqual(hostList(OFFICIAL_HOST), [OFFICIAL_HOST])
    assert.deepEqual(hostList('https://huggingface.co/'), [OFFICIAL_HOST])
  })

  it('第一个源失败后试第二个，成功即停', async () => {
    resetEncoder()
    const seen = []
    const load = async (host) => {
      seen.push(host)
      if (host === OFFICIAL_HOST) throw new Error('官方源连不上')
      return async () => ({ data: new Float32Array(0) })
    }
    const ok = await ensureEncoder({ ...twoSources, load })
    assert.equal(ok, true)
    assert.equal(encoderState(), 'ready')
    assert.deepEqual(seen, [OFFICIAL_HOST, DEFAULT_MIRROR_HOST])
    const tries = encoderAttempts()
    assert.equal(tries.length, 2)
    assert.equal(tries[0].ok, false)
    assert.equal(tries[0].error, '官方源连不上')
    assert.ok(tries[0].ms >= 0)
    assert.equal(tries[1].ok, true)
    assert.equal(tries[1].error, null)
  })

  it('两个源都失败时逐源留原因，状态停在 unavailable', async () => {
    resetEncoder()
    const load = async (host) => {
      throw new Error('连不上 ' + host)
    }
    const ok = await ensureEncoder({ ...twoSources, load })
    assert.equal(ok, false)
    assert.equal(encoderState(), 'unavailable')
    const tries = encoderAttempts()
    assert.deepEqual(
      tries.map((t) => t.host),
      [OFFICIAL_HOST, DEFAULT_MIRROR_HOST],
    )
    assert.deepEqual(
      tries.map((t) => t.ok),
      [false, false],
    )
    assert.match(tries[0].error, /连不上/)
    assert.match(tries[1].error, /连不上/)
    // encoderError() 仍只留最后一个源的原因（上层只判有没有）；要看全部读 attempts。
    assert.equal(encoderError(), tries[1].error)
  })

  it('没给候选源时只试官方，不凭空加镜像', async () => {
    resetEncoder()
    const seen = []
    const load = async (host) => {
      seen.push(host)
      throw new Error('连不上')
    }
    assert.equal(await ensureEncoder({ ...opts, load }), false)
    assert.deepEqual(seen, [OFFICIAL_HOST])
  })

  it('复位后不保留上一次的尝试记录', async () => {
    resetEncoder()
    await ensureEncoder(offline)
    assert.ok(encoderAttempts().length > 0)
    resetEncoder()
    assert.deepEqual(encoderAttempts(), [])
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

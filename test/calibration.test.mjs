// 标定状态与快照读入（M4-T44 判据 1/2/4/6）。
//
// 这里验的是**运行时怎么判快照**，不是标定算法本身（那在 lattice-calib 的测试里）。
// 每条用例都构造出一个「本该不同的状态」，否则这些断言在实现写错时也会绿 ——
// 判据 1/2 的反例正是「换模型/换族语料之后仍然显示已标定」。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { CALIB_VERSION, writeSnapshot } from 'lattice-calib'
import { closeLog } from '../dist/log/index.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView } from '../dist/pipeline/view.js'
import { closeRuntime, getRuntime } from '../dist/state.js'

let dir = ''
const MODEL = 'Xenova/bge-small-zh-v1.5'

function cfgOf(over) {
  return {
    dataDir: dir,
    encoderEnabled: false,
    encoderModel: over?.encoderModel ?? MODEL,
    encoderMirror: '',
    encoderCacheDir: '',
    thresholds: { tauJoin: 0.78, tauLex: 0.05, tauLexOnly: 0.1, tauNew: 0.5 },
    viewBudget: 6000,
    topN: 24,
    resources: {},
  }
}

// 钩子放在 describe **内部**：node:test 的顶层 beforeEach/afterEach 是**全局**的
// （同一进程里后注册文件的顶层钩子会作用到先注册文件的用例上）。
// 本文件会关运行时与日志库，放顶层会把别的测试文件的日志配置一起关掉。
describe('标定状态：快照读入与失效（T44 判据 6）', () => {
  beforeEach(() => {
    closeRuntime()
    dir = join(
      tmpdir(),
      'dsh-lattice-calib-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    )
  })

  afterEach(() => {
    // 顺序要紧：先关运行时与日志库，再删目录。
    // 日志单例指向本用例的 dataDir；不关就删目录，后面的用例写日志时会去那个已消失的路径 mkdir。
    closeRuntime()
    try {
      closeLog()
    } catch {
      /* 已关或目录已不在 */
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  })
  it('没有快照时是未标定；库小于稳定下限时原因是 small_db', () => {
    const rt = getRuntime(cfgOf())
    assert.equal(rt.calibration.state, 'uncalibrated')
    assert.equal(rt.calibration.reason, 'small_db', '空库/小库应报 small_db，而不是 never')
    assert.equal(rt.calibration.params, null, '未标定时不许编一个参数出来')
  })

  it('写入相符快照后：状态 calibrated，且 briefMin 真的换成标定值', () => {
    const rt0 = getRuntime(cfgOf())
    writeSnapshot(rt0.db, {
      params: { briefMin: 0.99 },
      sBaseline: 0.7,
      calibVersion: CALIB_VERSION,
      at: Date.now(),
      encoderModel: MODEL,
    })
    closeRuntime()

    const rt = getRuntime(cfgOf())
    assert.equal(rt.calibration.state, 'calibrated')
    assert.equal(rt.calibration.reason, undefined)
    assert.equal(rt.calibration.params?.briefMin, 0.99)

    // 生效值可观测：注入组装用的 briefMin 就是快照里的那个数，而不是按规模插值出来的。
    const recalled = recall(rt.db, '某个查询', null, { topN: 5 })
    const view = assembleView(rt.db, recalled, { briefMin: rt.calibration.params?.briefMin })
    assert.equal(view.briefMin, 0.99)
  })

  it('calibVersion 不符 → 丢弃快照（snapshot_invalid），不静默沿用', () => {
    const rt0 = getRuntime(cfgOf())
    writeSnapshot(rt0.db, {
      params: { briefMin: 0.99 },
      sBaseline: 0.7,
      calibVersion: '0.0.0-unrelated',
      at: Date.now(),
      encoderModel: MODEL,
    })
    closeRuntime()

    const rt = getRuntime(cfgOf())
    assert.equal(rt.calibration.state, 'uncalibrated')
    assert.equal(rt.calibration.reason, 'snapshot_invalid')
    assert.equal(rt.calibration.params, null, '版本不符必须丢弃参数，而不是照用')
  })

  it('换编码模型 → model_changed（判据 1：换模型必须被发现）', () => {
    const rt0 = getRuntime(cfgOf())
    writeSnapshot(rt0.db, {
      params: { briefMin: 0.99 },
      sBaseline: 0.7,
      calibVersion: CALIB_VERSION,
      at: Date.now(),
      encoderModel: 'another/encoder',
    })
    closeRuntime()

    const rt = getRuntime(cfgOf())
    assert.equal(rt.calibration.state, 'uncalibrated')
    assert.equal(rt.calibration.reason, 'model_changed')
    assert.equal(rt.calibration.params, null)
  })

  it('删掉快照 → 回到默认（不再沿用旧参数）', () => {
    const rt0 = getRuntime(cfgOf())
    writeSnapshot(rt0.db, {
      params: { briefMin: 0.99 },
      sBaseline: 0.7,
      calibVersion: CALIB_VERSION,
      at: Date.now(),
      encoderModel: MODEL,
    })
    rt0.db.prepare("DELETE FROM meta WHERE key LIKE 'calib_%'").run()
    closeRuntime()

    const rt = getRuntime(cfgOf())
    assert.equal(rt.calibration.state, 'uncalibrated')
    assert.equal(rt.calibration.params, null)
  })
})

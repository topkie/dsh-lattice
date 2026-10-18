// 运行时可变状态的纪律（docs/PRINCIPLES.md 第四节末、docs/ARCHITECTURE.md 第十节）。
//
// 三条被测事实：
//   1. 标定参数是**整体替换**的 —— 旧引用保持原值，新读取拿到新值。这保证了一次操作
//      里「取一次引用」拿到的那一代不会中途变成别的值。
//   2. 召回工具在**第一个 await 之前**取标定参数。重标由写入侧异步触发，会在某个 await
//      之间整体替换 rt.calibration；若等到 await 之后才读，同一次召回会「按旧参数召回、
//      按新参数注入」。第 2 条是**源码顺序断言**，改回去就会红 —— 行为上无法构造差异
//      （重标的触发时机不由调用方掌握），所以钉顺序。
//   3. closeRuntime 之后旧连接会失败，且错误不是静默空结果。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { recall } from '../dist/pipeline/search.js'
import { closeRuntime, getRuntime } from '../dist/state.js'

describe('运行时可变状态', () => {
  let dir = ''

  /** 每个用例一个新数据目录：运行时会缓存单例，共用目录会让「首次打开」这件事失真。 */
  function cfg() {
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-runtime-'))
    return {
      dataDir: dir,
      encoderEnabled: false,
      encoderModel: 'stub',
      encoderMirror: '',
      encoderCacheDir: '',
      thresholds: { tauJoin: 0.78, tauLex: 0.05, tauLexOnly: 0.1, tauNew: 0.5 },
      viewBudget: 6000,
      topN: 24,
      samplesEnabled: true,
      resources: {},
    }
  }

  afterEach(() => {
    closeRuntime()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上仍被占用的临时目录留给系统清理 */
    }
  })

  it('标定参数是整体替换：旧引用保持原值，新读取拿到新值', () => {
    const rt = getRuntime(cfg())
    const before = rt.calibration
    assert.equal(before.params ?? null, null, '新库应处于未标定状态')

    rt.calibration = { state: 'calibrated', params: { briefMin: 0.55 } }

    assert.equal(before.params ?? null, null, '取过的那一代不该跟着变')
    assert.equal(rt.calibration.params.briefMin, 0.55)
    assert.notEqual(rt.calibration, before, '替换的是对象，不是字段')
  })

  it('召回在第一个 await 之前取标定参数（源码顺序）', () => {
    const src = readFileSync(new URL('../src/tools/index.ts', import.meta.url), 'utf8')
    const start = src.indexOf("name: 'lattice_recall'")
    const end = src.indexOf("name: 'lattice_expand'")
    assert.ok(start > 0 && end > start, '应能在源码里定位到 lattice_recall 段')

    const block = src.slice(start, end)
    // 从 execute 的函数体算起：这段的 schema 定义里也可能出现同名文本，从函数体起更准。
    const body = block.slice(block.indexOf('async execute'))
    assert.ok(body.length > 0, '应能定位到 execute 函数体')
    const iSnap = body.indexOf('const calibParams = rt.calibration')
    assert.ok(iSnap >= 0, '应存在标定参数的快照读取')
    const iAwait = body.indexOf('await ')
    assert.ok(iAwait >= 0, '这段应至少有一步 await')
    assert.ok(iSnap < iAwait, '快照必须在第一个 await 之前取，否则一次召回会跨一次换代')
    assert.ok(!/briefMin:\s*rt\.calibration/.test(body), '不要在使用处现读容器')
  })

  it('closeRuntime 之后旧连接不可用，且错误不是静默空结果', () => {
    const rt = getRuntime(cfg())
    closeRuntime()
    assert.throws(
      () => recall(rt.db, '任意查询', null, { topN: 5 }),
      (e) => e.code === 'ERR_INVALID_STATE',
      '应抛 ERR_INVALID_STATE（database is not open），而不是返回空结果',
    )
  })
})

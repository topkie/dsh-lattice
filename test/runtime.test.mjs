// 运行时可变状态的纪律（docs/PRINCIPLES.md 第四节末、docs/ARCHITECTURE.md 第十一节）。
//
// 被测事实：closeRuntime 之后旧连接会失败，且错误不是静默空结果。
//
// 原先还有两条关于「标定参数整体替换」的用例（旧引用保持原值；召回在第一个 await 之前
// 取标定参数）。标定包退役后库内不再有第二套参数可以覆盖常量，这两条随之删除 ——
// 它们守的是那个已被删掉的机制。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
      topN: 24,
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

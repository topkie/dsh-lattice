// 单进程测试入口。
//
// 为什么不用 `node --test`：其 runner 会为每个测试文件 spawn 子进程，
// 在无法创建子进程/管道受限的环境下会直接失败。这里改为顺次 import，
// node:test 在非 runner 模式下同样会执行并报告结果。
//
// ── 清单自检 ────────────────────────────────────────────────
//
// 下面是一份手写的 import 清单，而 node:test 只在文件被 import 时才执行它。
// 新增一个 `*.test.mjs` 却忘了加 import，那个文件就永远不会跑，门禁照样全绿 ——
// 一个看起来在工作、实际什么都没测的空洞。所以让入口自己核对目录。
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SELF_DIR = fileURLToPath(new URL('.', import.meta.url))
const LISTED = [
  ...readFileSync(fileURLToPath(import.meta.url), 'utf8').matchAll(/^import '\.\/(.+?\.test\.mjs)'/gm),
].map((m) => m[1])
const ON_DISK = readdirSync(SELF_DIR)
  .filter((n) => n.endsWith('.test.mjs'))
  .sort()
const NOT_IMPORTED = ON_DISK.filter((n) => !LISTED.includes(n))
const GONE = LISTED.filter((n) => !ON_DISK.includes(n))
if (NOT_IMPORTED.length > 0 || GONE.length > 0) {
  console.error(
    '测试清单与目录不一致：目录里有但没 import [' +
      NOT_IMPORTED.join(', ') +
      ']；import 了但文件不存在 [' +
      GONE.join(', ') +
      ']',
  )
  process.exit(1)
}

import './plugin.test.mjs'
import './db.test.mjs'
import './util.test.mjs'
import './encoder.test.mjs'
import './write.test.mjs'
import './review.test.mjs'
import './search.test.mjs'
import './memory.test.mjs'
import './view.test.mjs'
import './calibrate.test.mjs'
import './tools.test.mjs'
import './migrate.test.mjs'
import './list.test.mjs'
import './atom-detail.test.mjs'
import './forget.test.mjs'
import './archive.test.mjs'
import './entries-learned.test.mjs'
import './recluster.test.mjs'
import './graph.test.mjs'
import './declared-edges.test.mjs'
import './calibration.test.mjs'
import './recalibrate.test.mjs'
import './log.test.mjs'
import './samples.test.mjs'
import './flags.test.mjs'
import './audit.test.mjs'
import './runtime.test.mjs'
import './isolation.test.mjs'
import './split-pending.test.mjs'
import './client-source.test.mjs'
import './client-layout.test.mjs'
import './audit-panel.test.mjs'
import './recluster-plan.test.mjs'
import './maintenance.test.mjs'
import './cache-usage.test.mjs'
import './thresholds.test.mjs'
import './supersede.test.mjs'
import './unsupersede.test.mjs'

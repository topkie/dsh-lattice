// 单进程测试入口。
//
// 为什么不用 `node --test`：其 runner 会为每个测试文件 spawn 子进程，
// 在无法创建子进程/管道受限的环境下会直接失败。这里改为顺次 import，
// node:test 在非 runner 模式下同样会执行并报告结果。
import './plugin.test.mjs'
import './db.test.mjs'
import './util.test.mjs'
import './encoder.test.mjs'
import './write.test.mjs'
import './review.test.mjs'
import './search.test.mjs'
import './memory.test.mjs'
import './view.test.mjs'
import './tools.test.mjs'
import './migrate.test.mjs'
import './list.test.mjs'
import './forget.test.mjs'
import './entries-learned.test.mjs'

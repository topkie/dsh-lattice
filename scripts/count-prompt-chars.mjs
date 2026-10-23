// 数一遍模型侧提示词的字数：每个 `description` 字段累加，含嵌套 `items`。
//
// 为什么要脚本：docs/DEVELOPMENT.md 用「处数 + 总字数」做提示词治理的度量，
// 而这个数字此前是手算增量加起来得到的 —— 手算会漏，且漏了没有任何检查会发现。
// 本脚本把口径固定成一句话：注册的工具（五个）+ 未注册的 `lattice_forget` 规格，
// 递归找所有 description 字段，处数 = 字段个数，字数 = 字符串长度之和（JS length，按 UTF-16 码元）。
//
// 用法：node scripts/count-prompt-chars.mjs
// 输出末尾两行是 totals：处数与字数；上面的逐工具一行一眼能看出是哪一处变了。

import { apply } from '../dist/index.js'
import { FORGET_TOOL_SPEC } from '../dist/tools/index.js'

/** 注册的工具（apply 会把四个业务工具与 lattice_ping 一起注册进来，共五个）。 */
const specs = []
const ctx = {
  get: (k) => (k === 'tools' ? { register: (t) => specs.push(t) } : undefined),
  // apply 会挂两处清理钩子；这里只取工具规格，不给 webServer，路由那段不会执行。
  effect: (fn) => fn(),
  inject: () => {},
}
apply(ctx, {})

/** 未注册但同样出现在提示词预算里的规格。 */
specs.push(FORGET_TOOL_SPEC)

/** 递归累加所有 description 字段。 */
function countDescriptions(node) {
  let fields = 0
  let chars = 0
  const walk = (o) => {
    if (o === null || typeof o !== 'object') return
    for (const [k, v] of Object.entries(o)) {
      if (k === 'description' && typeof v === 'string') {
        fields++
        chars += v.length
      } else {
        walk(v)
      }
    }
  }
  walk(node)
  return { fields, chars }
}

let fields = 0
let chars = 0
for (const spec of specs) {
  const one = countDescriptions(spec)
  fields += one.fields
  chars += one.chars
  console.log(String(spec.name).padEnd(16) + one.fields + ' 处 / ' + one.chars + ' 字')
}
console.log('totals           ' + fields + ' 处 / ' + chars + ' 字')

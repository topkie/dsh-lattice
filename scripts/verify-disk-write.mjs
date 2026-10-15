// 落盘写法对照实验：证明「用模板字符串承载待写入代码」会失败，「单引号数组 + join」不会。
//
// 这个脚本本身就是用后者写出来的 —— 它自己就是一条证据。
// 用法：node scripts/verify-disk-write.mjs
//
// 为什么不调 `node --check`：本环境下 process.execPath 指向宿主程序而非 node，
// 且沙箱禁止 spawn（EPERM），判据会恒为失败。改用 vm.Script 在进程内解析，等价且零依赖。

import vm from 'node:vm'

const BT = '\u0060' // 反引号，写成转义以免阅读时与代码块的定界符混淆
const DL = '\u0024' // 美元符号

/** 待落盘正文的样本：都是真实项目里出现过的类型。 */
const PAYLOADS = [
  ['SQL 模板串（反引号）', 'const sql = ' + BT + 'SELECT id FROM atom' + BT],
  ['单个反引号', 'const q = ' + BT + 'atom_fts' + BT],
  ['模板插值', 'const label = ' + BT + 'topic-' + DL + '{id}' + BT],
  ['插值 + 属性访问', 'const s = ' + BT + DL + '{row.summary.slice(0, 8)}' + BT],
  ['Markdown 行内代码', '提交 | ' + BT + '37ca5df' + BT + ' | 见上'],
  ['无特殊字符（对照）', 'const x = 1'],
]

/** 旧写法：把正文直接塞进模板字符串。 */
const genTemplate = (body) => 'const part = ' + BT + body + BT

/**
 * 新写法：正文放进单引号串，用数组拼装。
 *
 * 转义用**回调**而不是字符串：String.replace 的替换串里 DL 有特殊含义（DL&、DL1…），
 * 用字符串做替换会引入一类很隐蔽的 bug。
 */
const quote = (c) => (c === '\\' ? '\\\\' : "\\'")
const genJoined = (body) => "const part = '" + body.replace(/[\\']/g, quote) + "'"

const parses = (code) => {
  try {
    new vm.Script(code)
    return true
  } catch {
    return false
  }
}

let templateFail = 0
let joinedFail = 0
const rows = ['', '  正文类型'.padEnd(24) + '| 模板字符串 | 单引号 + join', '  ' + '-'.repeat(56)]
for (const [name, body] of PAYLOADS) {
  const a = parses(genTemplate(body))
  const b = parses(genJoined(body))
  if (!a) templateFail++
  if (!b) joinedFail++
  rows.push('  ' + name.padEnd(22) + '| ' + (a ? '通过' : '失败') + '       | ' + (b ? '通过' : '失败'))
}
console.log('落盘写法对照（同一份正文，两种承载方式各生成一段代码，用 vm.Script 解析）')
for (const r of rows) console.log(r)
console.log('')
console.log(
  '  失败数：模板字符串 ' +
    templateFail +
    '/' +
    PAYLOADS.length +
    '　单引号 + join ' +
    joinedFail +
    '/' +
    PAYLOADS.length,
)
if (joinedFail > 0) {
  console.error('单引号 + join 出现失败：拼接逻辑本身有 bug，必须修')
  process.exit(1)
}
if (templateFail === 0) {
  console.error('模板字符串竟然没有失败：样本失去区分度，实验无效')
  process.exit(1)
}
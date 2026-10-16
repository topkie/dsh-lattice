// 合并门禁：一条命令跑完所有静态检查与测试。
//
// 为什么不用 `pnpm run check`：某些环境下 `pnpm run` 会因为 pnpm 自身的依赖预检查而失败。
// 这里直接用当前 node 执行具体 CLI 入口，绕开包管理器 —— 与 CI 用的是**同一套脚本入口**
// （CI 另有依赖安装一步，步骤集合并不完全相同，别把这句读成「门禁就是 CI 那条命令」）。
//
// 用法：node scripts/check-all.mjs
//
// 注意：真实模型验证脚本（verify-*.mjs）**不在**这里 —— 它们要下载模型、耗时数十秒，
// 属于「合并前人工跑一次」的范畴。

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const NODE = process.execPath

/**
 * 参与格式检查的文件范围（与 CI 保持一致）。
 *
 * 这里**没有 Markdown**：`.prettierignore` 排除了 `*.md`，把 md 通配符写进来只会得到空集 ——
 * 命令照样打印「All matched files use Prettier code style!」，但它一个文档都没看。
 * 判据恒真比没有判据更糟（它看起来在工作），所以宁可如实收窄范围。
 */
const FORMAT_GLOBS = ['src/**/*.ts', 'test/**/*.mjs', 'scripts/*.mjs', '.github/**/*.yml']

/**
 * 步骤定义：名称 + 命令 + 参数。顺序按「先静态后动态」—— 便宜的失败先暴露。
 *
 * `build` 是唯一的例外：它排第一不是为了快，而是因为**测试与 verify 脚本 import 的是 `dist/`**。
 * 少了这一步，「改了 src 却忘了编译」会让门禁在旧产物上全绿 —— 测的就不是这份源码了。
 */
const STEPS = [
  ['build', 'node_modules/typescript/bin/tsc', ['-p', 'tsconfig.json']],
  ['typecheck', 'node_modules/typescript/bin/tsc', ['--noEmit']],
  ['lint', 'node_modules/eslint/bin/eslint.js', ['.']],
  // 只检查源码与文档：`--check .` 会把 dist/ 的构建产物也扫进来，那些不该受格式约束。
  ['format', 'node_modules/prettier/bin/prettier.cjs', ['--check', ...FORMAT_GLOBS]],
  // 阈值登记覆盖：源码里新增了数值常量、却既没登记也没进豁免清单时，以非零码退出。
  // 排在这里是因为它只读 src/ 与 dist/（build 已产出），不需要模型与网络 —— 与其余静态检查同类。
  // **为什么必须进门禁**：不进门禁的检查，与一句写在文档里的话，区别只是多一个文件（§1.3 防呆第 11 条）。
  ['thresholds', 'scripts/print-thresholds.mjs', []],
  // 文档一致性：文档里提到的「仓库内路径」与「表名」，能不能在仓库里找到。
  // **为什么要有它**：截至 2026-10-17，「指向不存在的结构」已经出现五处（一份平行的 DDL、
  // 三个不存在的模块、一个从未实现的位掩码、一条没有输入的图路、一个不存在的 config.ts）。
  // 它们都能活很久，因为没有任何检查会做「文档里的标识符能不能在代码里找到」这件事。
  // 这一类是机械可判的（路径与表名都能直接查），与「表述是否准确」不同（后者要人判断）。
  ['docs', 'scripts/check-docs.mjs', []],
  // test 也要挂替身：它只替换**可选依赖**（编码器），让降级用例确定地走降级路径。
  // 不挂的话，有网络的机器上编码器会真的加载成功，那组用例的语义就变了。
  ['test', 'test/run.mjs', [], ['--import', './test/stubs/register.mjs']],
]

/**
 * 在 main 上跑门禁时提醒一句。
 *
 * 为什么需要它：分支流程的规矩写在文档与记忆卡里，但那些都在**行动路径之外** ——
 * 做任务时按「写码 → 测 → 提交」的惯性走，没有任何一步会提醒「还没建分支」。
 * 实测结果就是：刚写下规矩，下一个任务就直接提交到了 main。
 *
 * 只提示不阻断：合并后回 main 复验是合法操作，强行失败会让脚本变成阻力然后被绕过。
 */
function checkBranch() {
  // 分支由调用方通过环境变量传入（GIT_BRANCH）。
  //
  // 为什么不在脚本里自己调 git：受限沙箱下 spawnSync 无法创建子进程（EPERM），
  // 而且那会把「读分支」变成一个可能失败的动作 —— 检查本身不该有失败模式。
  // 传空值时如实报「未知」，不猜。
  const branch = (process.env.GIT_BRANCH ?? '').trim()
  if (branch === '') return '分支：未知（未通过 GIT_BRANCH 传入）'
  if (branch !== 'main') return '分支：' + branch
  if (process.env.CI === 'true' || process.env.CI === '1') return '分支：main（CI）'
  return (
    '分支：main —— 提醒：门禁本应在任务分支上跑（feat/xxx），合并后再回 main 复验一次。' +
    ' 现在这条线是直接在 main 上做吗？'
  )
}

async function main() {
  console.log(checkBranch())
  let failed = 0
  const t0 = Date.now()
  for (const [name, entry, args, pre = []] of STEPS) {
    if (!existsSync(entry)) {
      console.error('SKIP ' + name + '：找不到 ' + entry + '（先装依赖）')
      failed++
      continue
    }
    const t = Date.now()
    const r = spawnSync(NODE, [...pre, entry, ...args], { stdio: 'inherit' })
    const ms = Date.now() - t
    if (r.status === 0) {
      console.log('OK   ' + name.padEnd(10) + ms + ' ms')
    } else {
      console.error('FAIL ' + name.padEnd(10) + ms + ' ms (exit ' + r.status + ')')
      failed++
    }
  }
  console.log('')
  if (failed > 0) {
    console.error('门禁未通过：' + failed + ' 项失败，禁止合并。')
    process.exit(1)
  }
  console.log('门禁通过：' + STEPS.length + ' 项全绿，用时 ' + (Date.now() - t0) + ' ms')
  console.log('别忘了再手动跑一次 scripts/verify-*.mjs（真实模型），它们不在门禁里。')
}

await main()

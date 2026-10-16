// 合并门禁：一条命令跑完所有静态检查与测试。
//
// 为什么不用 `pnpm run check`：某些环境下 `pnpm run` 会因为 pnpm 自身的依赖预检查而失败。
// 这里直接用当前 node 执行具体 CLI 入口，绕开包管理器，与 CI 用的是同一条命令。
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

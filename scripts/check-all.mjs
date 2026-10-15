// 合并门禁：一条命令跑完所有静态检查与测试。
//
// 为什么不用 `pnpm run check`：本环境下 `pnpm run` 会因为 pnpm 自身的依赖预检查而失败
//（报 pnpm 不是命令）。这里直接用当前 node 执行具体的 CLI 入口，绕开包管理器，
// 于是同一条命令在当前环境与 CI 上行为一致。
//
// 用法：node scripts/check-all.mjs
//
// 注意：真实模型验证脚本（verify-encoder / verify-write / verify-recall）**不在**这里。
// 它们要下载模型、耗时数十秒，且依赖网络，属于「合并前人工跑一次」的范畴。

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const NODE = process.execPath

/** 参与格式检查的文件范围（与 CI 保持一致）。 */
const FORMAT_GLOBS = [
  'src/**/*.ts',
  'test/**/*.mjs',
  'scripts/*.mjs',
  'docs/*.md',
  '*.md',
  '.github/**/*.yml',
]

/** 步骤定义：名称 + 命令 + 参数。顺序按「先静态后动态」——便宜的失败先暴露。 */
const STEPS = [
  ['typecheck', 'node_modules/typescript/bin/tsc', ['--noEmit']],
  ['lint', 'node_modules/eslint/bin/eslint.js', ['.']],
  // 只检查源码与文档：`--check .` 会把 dist/ 的构建产物也扫进来，那些不该受格式约束。
  ['format', 'node_modules/prettier/bin/prettier.cjs', ['--check', ...FORMAT_GLOBS]],
  ['test', 'test/run.mjs', []],
]

let failed = 0
const t0 = Date.now()
for (const [name, entry, args] of STEPS) {
  if (!existsSync(entry)) {
    console.error('SKIP ' + name + '：找不到 ' + entry + '（先装依赖）')
    failed++
    continue
  }
  const t = Date.now()
  const r = spawnSync(NODE, [entry, ...args], { stdio: 'inherit' })
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
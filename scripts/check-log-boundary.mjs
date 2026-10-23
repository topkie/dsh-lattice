#!/usr/bin/env node
// 日志写入口的边界检查：除 src/log/ 外，源码里不得出现日志库文件名或 INSERT INTO log。
//
// 为什么进门禁，而不是只写在文档里：「写日志只能通过日志模块」。
// 这条约束的失效形态是**静默的** —— 有人图省事在召回路径里 new 一个 DatabaseSync 直接写，
// 代码照样跑、测试照样绿，只有「日志可以整个删掉、不影响召回」这条性质悄悄没了。
// 静态检查是唯一能零成本盯住它的手段（§1.3：不进门禁的检查等于一句话）。
//
// 判据（能红）：
//   - src/log/ 之外出现日志库文件名（lattice-log.db 或轮换后的 lattice-log-<数字>.db）；
//   - src/log/ 之外出现 INSERT INTO log（直接写日志表）。
//
// 只认「.db 文件名」而不是裸的 lattice-log 前缀：路由路径 /api/lattice-log-export 与
// 导出文件名 lattice-log-<日期>.csv 是**接口**，不是写入口；把它们算成违规会让门禁
// 在正常改动上变红，然后被绕过（判据恒假与判据恒真是同一类病）。
//
// 用法：node scripts/check-log-boundary.mjs
// 退出码：0 = 通过；1 = 有违规。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 规则：正则 + 为什么算违规。新增一条要写清它防的是什么。 */
const RULES = [
  { re: /lattice-log(?:-\d+)?\.db/, why: '日志库文件名（含轮换后的命名）只能出现在 src/log/' },
  { re: /INSERT\s+INTO\s+log\b/i, why: '日志表只能由 src/log/ 写' },
]

/** 递归列出 src 下的 .ts 文件（相对仓库根，正斜杠）。 */
function listSources(dir = 'src') {
  const out = []
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = dir + '/' + name
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...listSources(rel))
    else if (name.endsWith('.ts')) out.push(rel)
  }
  return out.sort()
}

let violations = 0
for (const rel of listSources()) {
  if (rel.startsWith('src/log/')) continue
  const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (!rule.re.test(lines[i])) continue
      console.error('违规 ' + rel + ':' + (i + 1) + '（' + rule.why + '）：' + lines[i].trim())
      violations++
    }
  }
}

if (violations > 0) {
  console.error('')
  console.error('日志写入口被绕过：' + violations + ' 处。日志只能经 src/log/ 写入。')
  process.exit(1)
}
console.log('日志写入口检查通过：除 src/log/ 外没有直接引用日志库或写日志表。')

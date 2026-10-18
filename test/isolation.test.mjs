// 测试隔离：用例只碰自己建的库。
//
// 为什么单独立一条：`dataDir` 是空串时 `resolveDataDir` 会回落到用户的**真实库**
// （`~/.dsh/lattice`）。任何会打开库的用例都会读写它 —— 宿主进程正持有时还会直接失败
// （SQLITE_CANTOPEN），2026-10-19 就让整套门禁挂在一件与被测行为无关的事情上。
//
// 这条检查是**源码级**的（读 test/*.test.mjs 的字面量），因为「运行时会落到哪里」由配置决定，
// 而配置的写法在源码里只有几种固定形状。它挡不住所有写法，但挡住最可能的那几种，
// 并且失败信息会直接指出文件。

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { describe, it } from 'node:test'

/** 会回落到用户真实库（或用户主目录）的写法。 */
const FORBIDDEN = [
  { re: /dataDir:\s*''/, why: '空字符串会回落到 ~/.dsh/lattice' },
  { re: /dataDir:\s*""/, why: '空字符串会回落到 ~/.dsh/lattice' },
  { re: /dataDir:\s*homedir\(\)/, why: '直接用主目录就是用户的真实库' },
  { re: /dataDir:\s*process\.env\.DSH_HOME/, why: 'DSH_HOME 指向的是用户的真实数据目录' },
]

describe('测试隔离：用例只碰自己建的库', () => {
  it('测试源码里没有会回落到用户真实库的 dataDir 写法', () => {
    const dir = new URL('./', import.meta.url)
    const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs'))
    assert.ok(files.length > 10, '应扫到全部测试文件，实际 ' + files.length + ' 个')

    const bad = []
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8')
      for (const { re, why } of FORBIDDEN) {
        const m = src.match(re)
        if (m !== null) bad.push(f + ' 里的 ' + JSON.stringify(m[0]) + '：' + why)
      }
    }
    assert.deepEqual(bad, [], '以下写法会读写用户的真实记忆库：\n' + bad.join('\n'))
  })
})

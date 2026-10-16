#!/usr/bin/env node
// 文档一致性检查：文档里提到的「仓库内路径」与「表名」，能不能在仓库里找到。
//
// 为什么要有它：截至 2026-10-17，「指向不存在的结构」已经出现五处 ——
// §27 的 CREATE TABLE entries、技术文档 §3 的三个模块、§5 的 FLAG 位掩码、
// 搜索路径里的 atom↔atom 图路、模块划分里的 config.ts。它们都能活很久，
// 因为没有任何检查会做「文档里的标识符能不能在代码里找到」这件事。
//
// 这一类是机械可判的（路径与表名都能直接查），与「表述是否准确」不同（后者要人判断）。
//
// 用法：node scripts/check-docs.mjs
// 退出码：0 = 全部能找到；1 = 有找不到的。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 要检查的文档：仓库根的几份 + docs/ 下全部。 */
function docFiles() {
  const out = []
  for (const f of ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'AGENTS.md']) {
    const p = join(ROOT, f)
    if (existsSync(p)) out.push(p)
  }
  const docs = join(ROOT, 'docs')
  if (existsSync(docs)) {
    for (const name of readdirSync(docs)) {
      if (name.endsWith('.md')) out.push(join(docs, name))
    }
  }
  return out
}

/** 源码里真实存在的表名。 */
function realTables() {
  const src = readFileSync(join(ROOT, 'src/db/schema.ts'), 'utf8')
  const names = new Set()
  for (const m of src.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)) names.add(m[1])
  return names
}

/** 文档里出现的候选：反引号包起来的一小段、以及围栏代码块里的整行路径。 */
function candidates(text) {
  const out = []
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) out.push(m[1])
  return out
}

/** 像「仓库内的文件路径」吗：有 / 或有已知后缀，且不含空格与通配。 */
const FILE_EXT = /\.(ts|mjs|cjs|js|md|json|jsonl|yaml|yml|db|sql)$/
function looksLikePath(s) {
  if (/\s/.test(s)) return false
  if (s.includes('<') || s.includes('>')) return false
  if (s.startsWith('http') || s.startsWith('#')) return false
  if (s.startsWith('-') || s.startsWith('--')) return false
  if (s.includes('*')) return false
  const hasSlash = s.includes('/')
  if (!hasSlash && !FILE_EXT.test(s)) return false
  if (hasSlash && !FILE_EXT.test(s) && !s.startsWith('src/')) return false
  return true
}

/** 表名候选：形如 CREATE TABLE x 里的 x，或单独一个已知表名的词。 */
function missingTables(text, tables) {
  const miss = []
  for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)) {
    if (!tables.has(m[1])) miss.push(m[1])
  }
  return miss
}

/**
 * 文档里会提到一些「本来就不该在仓库里」的文件：运行产物、宿主侧文件、示例路径。
 *
 * **加一条要写清理由** —— 白名单是这类检查最容易退化的地方：一旦可以随手加，
 * 它就会变成「什么都不查」。所以每条都注明「它是什么、落在哪、为什么不在仓库里」。
 */
const NON_REPO = new Map([
  ['snapshot.json', '`snapshot-baseline.mjs` 的产物，落在 `.probe/snap/<名字>/` 下（`.probe/` 被忽略）'],
  ['AGENTS.local.md', '本机私有的开发约定补充，**不进版本控制**（`AGENTS.md` 第五节规定的载体）'],
])

/** 全仓库收集文件名（不含目录），用于「文档只写了文件名」的情形。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', 'dist', '.probe'])
function allBasenames() {
  const set = new Set()
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name))
      } else {
        set.add(e.name)
      }
    }
  }
  walk(ROOT)
  return set
}

const tables = realTables()
const basenames = allBasenames()
const problems = []
for (const file of docFiles()) {
  const text = readFileSync(file, 'utf8')
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
  const seen = new Set()
  for (const c of candidates(text)) {
    if (!looksLikePath(c)) continue
    if (NON_REPO.has(c)) continue
    // 规则式跳过：`.probe/` 整个目录都是运行产物（快照、副本、一次性问句），
    // 它被 `.gitignore` 覆盖，**不该要求文档提到的每个路径都真实存在**。
    // —— 逐条加白名单会退化成「什么都不查」，所以这里用规则而不是再列两条。
    if (c.includes('.probe/')) continue
    const key = rel + '|' + c
    if (seen.has(key)) continue
    seen.add(key)
    // 带路径的按路径查；只写文件名的按名字查（文档常常只说文件名，那是合法的）。
    const ok = c.includes('/') ? existsSync(join(ROOT, c)) : basenames.has(c)
    if (!ok) problems.push({ file: rel, what: c, kind: c.includes('/') ? '路径' : '文件名' })
  }
  for (const t of missingTables(text, tables)) {
    problems.push({ file: rel, what: 'CREATE TABLE ' + t, kind: '表名' })
  }
}

if (problems.length === 0) {
  console.log('文档一致性：文档里提到的路径与表名都能在仓库里找到。')
  process.exit(0)
}
console.log('文档里提到了找不到的东西：')
for (const p of problems) console.log('  ' + p.kind + '  ' + p.file + ' → ' + p.what)
console.log('')
console.log('共 ' + problems.length + ' 处。要么改文档，要么补上那个东西。')
process.exit(1)

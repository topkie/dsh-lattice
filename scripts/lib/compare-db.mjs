// 对照库参数的公共取法 + 常见错误的统一说法。
//
// 为什么值得单独一个文件：`verify-*` 里凡是「改动前 vs 改动后」的脚本，都需要一个**改动前**
// 的副本。此前它们各自写死一个默认路径（.probe/baseline/lattice.db），于是当基准库本身
// 就是按新规则重建的时候，脚本会**静默地拿新库跟新库比** —— 差值恒为 0，
// 而 0 正是最像「没问题」的假象（见 verify-entry-quality.mjs 头部的原话）。
//
// 这里把口径固定成一条：**对照库必须由参数显式给出**；没给就停，并说清怎么补。
// 默认值不是「方便」，是把「我忘了指定对照库」翻译成「一切正常」。

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 默认的基准库位置（build-baseline.mjs 的产出）。只用于**生成快照**，不用来当对照库。 */
export const DEFAULT_BASELINE = join('.probe', 'baseline', 'lattice.db')
/** 快照的存放根目录。 */
export const SNAPSHOT_ROOT = join('.probe', 'snap')

export function argOf(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

export function hasFlag(name) {
  return process.argv.includes('--' + name)
}

/**
 * 取对照库路径；`--before` 缺失或指向的文件不存在时**直接退出**。
 *
 * 这里刻意不做任何回落：目标就是在源头堵住「静默拿当前库跟自己比」。
 */
export function requireBeforeDb(scriptName, extraHint) {
  const raw = argOf('before', '')
  if (raw === '') {
    console.error('缺少对照库：' + scriptName + ' 需要 --before <库>（**改动前**的副本）。')
    console.error('')
    console.error('为什么必须显式给：这个脚本测的是「改动前后」的差值。拿改动后的库当对照，')
    console.error('差值恒为 0 —— 看起来像「没有退化」，其实是没有对照组。')
    console.error('')
    console.error('正确做法（顺序不能反）：')
    console.error('  1. 改规则**之前**：node scripts/snapshot-baseline.mjs --label <名字>')
    console.error(
      '  2. 再跑：node ' + scriptName + ' --before ' + join(SNAPSHOT_ROOT, '<名字>', 'lattice.db'),
    )
    if (extraHint !== undefined) console.error('  ' + extraHint)
    process.exit(2)
  }
  const path = resolve(raw)
  if (!existsSync(path)) {
    console.error('对照库不存在：' + path)
    console.error('若那是快照，先用 node scripts/snapshot-baseline.mjs 生成；若路径写错了，改正后重跑。')
    process.exit(2)
  }
  return path
}

/**
 * 取金标集路径；默认 .probe/eval-gold.json（它不是「对照物」，只是查询集，缺了直接报错）。
 */
export function requireGold(scriptName) {
  const path = resolve(argOf('gold', join('.probe', 'eval-gold.json')))
  if (!existsSync(path)) {
    console.error('缺少 gold 集：' + path)
    console.error('它是 20 条带 target 的查询（格式见 ' + scriptName + ' 头部）；没有它算不出 Recall。')
    console.error('可用 --gold <文件> 指到别处。')
    process.exit(2)
  }
  return path
}

/**
 * 把一份库复制成工作副本（脚本要往它里面改，绝不能碰来源）。
 *   · 来源不存在 → 报错退出（不静默造一个空库）
 *   · 目的已存在 → 先删（连同 -wal / -shm：残留的 WAL 会让新副本带上旧事务）
 */
export function copyToWork(src, dest) {
  if (!existsSync(src)) {
    console.error('要复制的库不存在：' + src)
    process.exit(2)
  }
  mkdirSync(dirname(dest), { recursive: true })
  for (const s of ['', '-wal', '-shm']) rmSync(dest + s, { force: true })
  copyFileSync(src, dest)
  return dest
}

/** 一行式说明「这个库是哪套规则建的」——对照可不可比，看的就是它。 */
export function ruleOf(db) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('entry_rule')
    return row === undefined ? '（未记录）' : String(row.value)
  } catch {
    return '（无 meta 表）'
  }
}

/** 给输出用：库路径 + 字节数，便于人核对用的是哪一份。 */
export function describeDb(path) {
  try {
    return path + '（' + statSync(path).size + ' 字节）'
  } catch {
    return path
  }
}

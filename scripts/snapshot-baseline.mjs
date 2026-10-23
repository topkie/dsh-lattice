// 把库另存一份快照到 .probe/snap/<标签>/。
//
// 为什么需要它：**「改动前」必须是一个真的副本，不能拿改动后的库当替身。**
// 入口规则改过之后，基准库会按新规则重建（scripts/build-baseline.mjs），此后任何
// 「前后对比」脚本都会拿新库跟新库比 —— 差值恒为 0，而 0 正是最像「没问题」的假象。
// 所以顺序只能是：**先另存快照，再改规则**；对比时用 --before 指到那份快照。
//
// 用法：
//   node scripts/snapshot-baseline.mjs [--db .probe/baseline/lattice.db] [--label <名字>] [--force]
//
// 标签默认取「库自己记录的入口规则 + 当天日期」，例如 bigram-idf-v4-20261017 —— 它回答的
// 正是对比时要问的那个问题：这份快照是哪套规则建的。标签已在则报错（不静默覆盖）。
//
// 快照用 `VACUUM INTO` 而不是复制文件：库在 WAL 模式下主文件可能不含尚未 checkpoint 的事务，
// 只复制主文件会得到**没有报错的**残缺副本。VACUUM INTO 由 SQLite 自己写出一份自洽的单文件
// 副本（顺带压实），且能在只读连接上发起。
//（不用 node:sqlite 的 backup()：本机 Node 24.21.0 的 DatabaseSync 上没有这个方法。）
// 备完再跑 integrity_check，并记下哈希与规模 —— 「这份快照可不可比」要能被查，而不是要靠记。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openVault } from '../dist/db/open.js'
import { readBuildInfo } from '../dist/db/build-info.js'

const SNAP_ROOT = join('.probe', 'snap')
const BUILDER = 'scripts/snapshot-baseline.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const SRC = resolve(arg('db', join('.probe', 'baseline', 'lattice.db')))
const FORCE = process.argv.includes('--force')

if (!existsSync(SRC)) {
  console.error('找不到要另存的库：' + SRC)
  console.error('先建基准库（node scripts/build-baseline.mjs --source <cards.json>），或用 --db 指定。')
  process.exit(2)
}

// ── ① 先只读打开，把「这份快照是什么」读出来 ──────────────────────────────
const { db: src } = openVault(SRC, { readOnly: true })
/** 读一个 meta 键；表不存在（很老的库）时返回空串，而不是抛错。 */
const metaOf = (db, key) => {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row === undefined ? '' : String(row.value)
  } catch {
    return ''
  }
}
/** 数一张表；表不存在时返回 null（与「表存在但是空」区分开）。 */
const countOf = (db, table) => {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n)
  } catch {
    return null
  }
}
/** v5 起自描述进了 build_info 表；更老的库（v4 及以前）仍在 meta 里。 */
const infoOf = (db) => {
  try {
    return readBuildInfo(db)
  } catch {
    return null
  }
}
const info = infoOf(src)
const rule = info?.entryRule || metaOf(src, 'entry_rule') || 'no-entry-rule'
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const LABEL = arg('label', rule + '-' + stamp)
const DEST_DIR = join(SNAP_ROOT, LABEL)
const DEST = join(DEST_DIR, 'lattice.db')

if (existsSync(DEST) && !FORCE) {
  console.error('快照已存在：' + DEST)
  console.error('换一个 --label，或加 --force 覆盖（覆盖会丢掉旧的那份对照库，想清楚再用）。')
  process.exit(2)
}

const facts = {
  label: LABEL,
  source: SRC,
  sourceBytes:
    Number(src.prepare('PRAGMA page_count').get().page_count) *
    Number(src.prepare('PRAGMA page_size').get().page_size),
  entryRule: rule,
  schemaVersion: Number(src.prepare('PRAGMA user_version').get().user_version),
  builtAt: info?.builtAt ?? metaOf(src, 'built_at'),
  builtBy: info?.builder ?? metaOf(src, 'builder'),
  sourceLabel: info?.source ?? metaOf(src, 'source'),
  atoms: countOf(src, 'atom'),
  topics: countOf(src, 'topic'),
  entries: countOf(src, 'entry'),
  edges: countOf(src, 'edge'),
}
src.close()

// ── ② 备份（SQLite 自己的 API，WAL 也安全） ───────────────────────────────
mkdirSync(DEST_DIR, { recursive: true })
for (const s of ['', '-wal', '-shm']) rmSync(DEST + s, { force: true })
const from = new DatabaseSync(SRC, { readOnly: true })
try {
  from.exec("VACUUM INTO '" + DEST.replace(/'/g, "''") + "'")
} finally {
  from.close()
}

// ── ③ 校验：副本必须自洽、且与来源同规模 ──────────────────────────────────
const { db: copy } = openVault(DEST)
const integrity = String(copy.prepare('PRAGMA integrity_check').get().integrity_check)
const copied = {
  atoms: countOf(copy, 'atom'),
  topics: countOf(copy, 'topic'),
  entries: countOf(copy, 'entry'),
  entryRule: infoOf(copy)?.entryRule ?? metaOf(copy, 'entry_rule'),
}
copy.close()

const bytes = readFileSync(DEST)
const sha256 = createHash('sha256').update(bytes).digest('hex')

const failures = []
if (integrity !== 'ok') failures.push('integrity_check = ' + integrity)
if (copied.atoms !== facts.atoms) failures.push('atom 数不一致：' + copied.atoms + ' != ' + facts.atoms)
if (copied.entries !== facts.entries)
  failures.push('entry 数不一致：' + copied.entries + ' != ' + facts.entries)
if (copied.entryRule !== rule) failures.push('副本记的入口规则不一致：' + copied.entryRule + ' != ' + rule)

const record = {
  ...facts,
  snapshot: DEST,
  snapshotBytes: bytes.length,
  sha256,
  integrity,
  createdAt: new Date().toISOString(),
  createdBy: BUILDER,
  comparableAs: '这份快照的「改动前」身份由此处的 entryRule 决定；与当前代码规则不同时才可比',
}
writeFileSync(join(DEST_DIR, 'snapshot.json'), JSON.stringify(record, null, 2), 'utf8')

console.log('另存快照 → ' + DEST)
console.log('  入口规则   ' + rule + '（来自库里的记录：v5 起是 build_info，旧库才是 meta 表；不是当前代码）')
console.log('  规模       atom ' + facts.atoms + ' / topic ' + facts.topics + ' / entry ' + facts.entries)
console.log('  自检       integrity ' + integrity + '，规模与来源一致')
console.log('  sha256     ' + sha256.slice(0, 16) + '…')
console.log('  记录       ' + join(DEST_DIR, 'snapshot.json'))
console.log('')
console.log('对比时这样用它：node scripts/verify-entry-quality.mjs --before ' + DEST)

if (failures.length > 0) {
  console.error('')
  console.error('快照自检未通过：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

// 阈值表打印 + 覆盖核对 + 规模告警。
//
// 为什么需要它：阈值必须带标定依据存在，而「有没有带」不能靠人记得检查。这条命令一次做三件事：
//   1. 打印全部已登记阈值（名称 / 当前值 / 标定场景 / 可变条件 / 定义位置），可直接贴进文档；
//   2. 解析 src 下每一个模块级数值常量，列出既没登记、也不在豁免清单里的（应当为空）；
//   3. 把当前库的规模与来源分布和每行阈值的标定场景对照，越出的显式报出来。
//
// 用法：node scripts/print-thresholds.mjs [--db <库>] [--md] [--quiet]
//   默认库路径与其余脚本一致（.probe/baseline/lattice.db，见 docs/DEVELOPMENT.md）。
//
// 退出码：0 = 覆盖核对通过（规模告警不影响退出码，它是观察不是门禁）；
//         1 = 有未登记常量；2 = 用法或环境错误。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  DESIGN_GAPS,
  THRESHOLDS,
  constNameOf,
  currentValue,
  definitionSite,
  subKeys,
} from '../dist/thresholds.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes('--' + name)

const MD = has('md')
const QUIET = has('quiet')
const DB = arg('db', join('.probe', 'baseline', 'lattice.db'))

// ─────────────────────────── ① 源码扫描：行号与常量清单 ───────────────────────────

/** 模块级数值常量的声明（只认顶层，缩进为 0 或 2）。 */
const NUMERIC_CONST =
  /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(-?\d[\d_]*(?:\.\d+)?)\s*$/

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

const fileLines = new Map()
function linesOf(rel) {
  if (!fileLines.has(rel)) fileLines.set(rel, readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/))
  return fileLines.get(rel)
}

/** 定位行号：内联量用原样片段，其余用常量名。找不到返回 null（不猜）。 */
function locate(entry) {
  const { file, anchor } = definitionSite(entry)
  const lines = linesOf(file)
  const needle = entry.inline !== undefined ? anchor : 'const ' + anchor
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1
  return null
}

/**
 * 豁免清单：结构性或协议性常量 —— 改它不改变「同一输入得出什么」的判断，或它根本不是阈值。
 * **逐条给理由**，没有理由的一律不豁免（理由不足时应当补登记，而不是补豁免）。
 */
/** 在 src 里任意位置找这个名字（用于核对非数值豁免清单是否过期）。 */
function findAnywhere(name) {
  const re = new RegExp('(?:const|let)\\s+' + name + '\\b')
  for (const rel of listSources()) {
    const lines = linesOf(rel)
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return { file: rel, line: i + 1 }
  }
  return null
}

/**
 * 数值扫描命中、但判为不作为阈值登记的常量（原因逐条给）。
 */
const EXEMPT = {
  SCHEMA_VERSION: '协议性：库的 schema 版本，改动要走迁移（MIGRATIONS），不是调参',
  NOISE_LABEL:
    '协议性：聚类标签里「未归类」的哨兵值（-1）。它不是一条线而是一个约定，改它只是把' +
    '同一个语义换个写法（同时要改读取侧对 -1 的判读），没有「取多少合适」可言',
  MIN_K: '结构性上界：k 近邻图的 k 至少要取最近的那个邻居，不是可调区间',
}

/**
 * 数值扫描**捕不到**的例外：它们不是数字，所以不在 src 数值常量清单里。
 *
 * 单列出来的理由：**「不是数字」不等于「不是阈值」** —— 判据表也是阈值（v3 的单字虚词表
 * 就是这样一张表，v4 已换成几何判据，见 src/pipeline/entries.ts 的 hasBoundaryFreedom）。
 * 这里只收「结构性或协议性」的那些；真正的非数字判据已经登记进阈值表。
 * 每一条都要给理由，理由不足的应当补登记，而不是补豁免。
 */
const EXEMPT_NON_NUMERIC = {
  VEC_BYTES: '由 VEC_DIM 派生（VEC_DIM x 4）；数值扫描本就不收它，改它等于改 VEC_DIM',
  DDL: 'SQL 文本',
  DDL_V1: 'SQL 文本',
  DDL_V2: 'SQL 文本',
  DDL_V3: 'SQL 文本',
  MIGRATIONS: '迁移语句列表',
  META_SCHEMA_VERSION: 'meta 表的键名（协议字面量）',
  META_ENTRY_RULE: 'meta 表的键名',
  META_BUILT_AT: 'meta 表的键名',
  META_SOURCE: 'meta 表的键名',
  META_BUILDER: 'meta 表的键名',
  ATOM_ORIGINS: '类型枚举的取值表',
  ENTRY_RULE_ID: '规则标识：不是取值阈值，但**改入口规则必须改它**（见 docs/DEVELOPMENT.md）',
  EMPTY_VOCAB: '空词表实现，不是阈值',
  SEPARATOR: '正则',
  HAN: '正则',
  VERSION: '插件版本（读自 package.json）',
  Config: 'zod schema 定义体，不是数值常量（其默认值在阈值表里逐项登记）',
}

function scanConstants() {
  const found = new Map()
  for (const rel of listSources()) {
    const lines = linesOf(rel)
    for (let i = 0; i < lines.length; i++) {
      const m = NUMERIC_CONST.exec(lines[i])
      if (m !== null) found.set(m[1], { file: rel, line: i + 1, value: Number(m[2]) })
    }
  }
  return found
}

// ─────────────────────────── ② 库规模 ───────────────────────────

function distribution(db, col) {
  return Object.fromEntries(
    db
      .prepare('SELECT ' + col + ' AS k, COUNT(*) AS c FROM atom GROUP BY ' + col)
      .all()
      .map((r) => [String(r.k), Number(r.c)]),
  )
}

function readScale(file) {
  if (!existsSync(file)) return { missing: file }
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch (e) {
    return { error: e.message + '（' + file + '）' }
  }
  try {
    return {
      file,
      atoms: Number(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n),
      topics: Number(db.prepare('SELECT COUNT(*) AS n FROM topic').get().n),
      origins: distribution(db, 'origin'),
      scopes: distribution(db, 'scope'),
    }
  } finally {
    db.close()
  }
}

// ─────────────────────────── ③ 规模告警 ───────────────────────────

const fmtDist = (d) =>
  Object.entries(d)
    .map(([k, v]) => k + '=' + v)
    .join(' ') || '（空）'

/**
 * 分布是否"不同"：比的是**类别集合**，不是每类的条数。
 * 条数差异已经由规模那一条覆盖；这里再比一次只会把「同一类别的库大小不同」重复报两遍。
 */
const sameCategories = (a, b) =>
  JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort())

/**
 * 一行阈值的标定场景 vs 当前库。返回告警数组（空即「在标定场景内」或「无法比较」）。
 *
 * 判据（可复核）：
 *   1. 标定记录的来源分布与当前库不同 → 分布不一致；
 *   2. 标定记录的 scope 分布与当前库不同 → 分布不一致；
 *   3. 当前 atom 数是标定规模的 2 倍以上、或不足一半 → 规模越出。
 * 未记录标定场景的**不报**（不能拿未知当已知）—— 它们由「无标定依据」一节单独列出。
 */
function scaleAlerts(entry, scale) {
  const cal = entry.calibration
  if (cal === undefined || scale === null || scale.error !== undefined || scale.missing !== undefined) {
    return []
  }
  if (cal.atoms === undefined && cal.origins === undefined && cal.scopes === undefined) return []
  const out = []
  if (cal.origins !== undefined && !sameCategories(cal.origins, scale.origins)) {
    out.push('来源类别不一致：标定 ' + fmtDist(cal.origins) + ' ｜ 当前 ' + fmtDist(scale.origins))
  }
  if (cal.scopes !== undefined && !sameCategories(cal.scopes, scale.scopes)) {
    out.push('作用域类别不一致：标定 ' + fmtDist(cal.scopes) + ' ｜ 当前 ' + fmtDist(scale.scopes))
  }
  if (cal.atoms !== undefined && cal.atoms > 0) {
    const ratio = scale.atoms / cal.atoms
    if (ratio >= 2) {
      out.push(
        '规模越出：标定 ' + cal.atoms + ' atom，当前 ' + scale.atoms + '（' + ratio.toFixed(1) + ' 倍）',
      )
    } else if (ratio <= 0.5) {
      out.push(
        '规模越出：标定 ' + cal.atoms + ' atom，当前 ' + scale.atoms + '（' + ratio.toFixed(2) + ' 倍）',
      )
    }
  }
  return out
}
// ─────────────────────────── ④ 渲染 ───────────────────────────

const scale = readScale(DB)
const registered = new Map()
for (const e of THRESHOLDS) {
  const cn = constNameOf(e)
  if (cn !== null) registered.set(cn, e)
}

const missingAnchors = []
const rows = []
const alerts = []

for (const entry of THRESHOLDS) {
  const line = locate(entry)
  const { file } = definitionSite(entry)
  if (line === null) missingAnchors.push(entry.name + ' @ ' + file)
  const where = file + (line === null ? ':?' : ':' + line)
  const keys = subKeys(entry)
  const val = currentValue(entry)
  const shown =
    entry.display !== undefined
      ? entry.display
      : keys.length > 0
        ? keys.map((k) => k + '=' + (val[k] ?? '?')).join(' / ')
        : String(val)
  const cal = entry.calibration
  // 缺什么就写什么缺 —— 「无记录」这三个字同时覆盖语料规模、来源分布与作用域，
  // 分开写才能看出是「没记规模」还是「根本没记」.
  const calText =
    cal === undefined
      ? '无记录'
      : [
          cal.atoms === undefined ? '语料规模未记录' : cal.atoms + ' atom',
          cal.origins === undefined ? '来源分布未记录' : '来源 ' + fmtDist(cal.origins),
          cal.scopes === undefined ? '作用域分布未记录' : '作用域 ' + fmtDist(cal.scopes),
          cal.at === undefined ? '日期未记录' : cal.at,
        ].join('；')
  const row = {
    name: entry.name,
    value: shown,
    area: entry.area,
    cal: calText,
    evidence: cal === undefined ? '无记录' : cal.evidence,
    varies: entry.variesWith.join('；'),
    where,
    design: entry.design,
    zod: entry.zod,
    otherSites: entry.otherSites ?? [],
    diverges: entry.diverges,
    /** 有没有标定记录（calibration 对象本身）。 */
    hasCal: cal !== undefined,
    /** 有记录、但记录里缺语料规模或分布 —— 比「完全无记录」轻的一种缺口。 */
    calIncomplete:
      cal !== undefined && (cal.atoms === undefined || cal.origins === undefined || cal.scopes === undefined),
  }
  rows.push(row)
  const a = scaleAlerts(entry, scale)
  if (a.length > 0) alerts.push({ name: entry.name, where, msgs: a })
}

const noCal = rows.filter((r) => !r.hasCal)
const partialCal = rows.filter((r) => r.hasCal && r.calIncomplete)

// 覆盖核对
const found = scanConstants()
const unregistered = []
const exempted = []
for (const [name, info] of found) {
  if (registered.has(name)) continue
  if (Object.prototype.hasOwnProperty.call(EXEMPT, name)) {
    exempted.push({ name, ...info, reason: EXEMPT[name] })
    continue
  }
  unregistered.push({ name, ...info })
}
// 「登记了但不在数值扫描结果里」：只有**源码里根本找不到这个名字**才算问题。
// 非数值常量（判据表这类）与对象型阈值组本来就捕不到，它们由 findAnywhere 确认存在。
const nonNumericRegistered = []
const staleRegistrations = []
for (const [name, entry] of registered) {
  if (found.has(name)) continue
  const hit = findAnywhere(name)
  if (hit === null) staleRegistrations.push(name + '（' + constNameOf(entry) + '）')
  else nonNumericRegistered.push(name + '（' + hit.file + ':' + hit.line + '，非数值或对象型）')
}

// ─────────────────────────── ⑤ 输出 ───────────────────────────

const out = []
const say = (...xs) => out.push(...xs)

say('# dsh-lattice 阈值登记表')

say('')
say('## 当前库')
if (scale.error !== undefined) say('- 读取失败：' + scale.error)
else if (scale.missing !== undefined) say('- 不存在：' + scale.missing)
else {
  say('- 路径：' + scale.file)
  say('- atom ' + scale.atoms + ' / topic ' + scale.topics)
  say('- 来源分布：' + fmtDist(scale.origins))
  say('- 作用域分布：' + fmtDist(scale.scopes))
}
say(
  '- 登记项 ' +
    rows.length +
    ' 行：标定记录完整 ' +
    (rows.length - noCal.length - partialCal.length) +
    ' 行，记录不完整 ' +
    partialCal.length +
    ' 行，无记录 ' +
    noCal.length +
    ' 行',
)

const esc = (s) => String(s).replace(/\|/g, '\\|')
say('')
say('## 已登记阈值')
say('')
if (MD) {
  say('| 名称 | 当前值 | 段 | 标定场景 | 可变条件 | 定义位置 |')
  say('|---|---|---|---|---|---|')
  for (const r of rows) {
    say('| ' + [r.name, r.value, r.area, r.cal, r.varies, r.where].map(esc).join(' | ') + ' |')
  }
} else {
  // 每行五个字段，行内用 ' | ' 分隔 —— 一行一条，可直接贴进文档。
  say(['名称', '当前值', '段', '标定场景', '可变条件', '定义位置'].join(' | '))
  for (const r of rows) say([r.name, r.value, r.area, r.cal, r.varies, r.where].join(' | '))
}

// 设计文档对照
say('## 与设计文档 §7 的对照（只列有对应项的行）')
say('')
say('设计文档 = 开发笔记《设计/技术文档/7.配置项清单.md》（设计正文不进本仓库）。')
say('')
if (MD) {
  say('| 名称 | 设计默认 | 设计范围 | 代码默认 | zod 默认 | zod 范围 | 一致？ |')
  say('|---|---|---|---|---|---|---|')
}
const designRows = []
for (const entry of THRESHOLDS) {
  if (entry.design === undefined) continue
  const d = entry.design
  const scaleK = d.scale ?? 1
  const designInCodeUnits = d.default / scaleK
  // 「代码默认」取的是模块默认值：zod 有就用 zod 的（它是配置入口的默认值），
  // 对象型阈值组取**与设计同名的那个子键**（docs 叫 wVec，代码叫 vec）。
  // 对象型阈值组：设计文档把一组键写成一行，用 codeKeys 映射到代码里的子键名，
  // 取第一个子键的值作为「这一行的代码默认」；其余子键的值另见主表。
  const raw = currentValue(entry)
  const primary = d.codeKeys?.[0]
  const codeDefault =
    entry.group !== undefined && primary !== undefined && typeof raw === 'object'
      ? raw[primary]
      : entry.zod !== undefined
        ? entry.zod.default
        : typeof raw === 'number'
          ? raw
          : undefined
  const sameDefault = codeDefault !== undefined && Math.abs(codeDefault - designInCodeUnits) < 1e-9
  const zodRange =
    entry.zod === undefined
      ? '无'
      : '[' +
        entry.zod.min +
        ', ' +
        entry.zod.max +
        ']' +
        (d.min !== undefined && (entry.zod.min !== d.min || entry.zod.max !== d.max)
          ? ' ⚠ 与文档范围不同'
          : '')
  const verdict =
    entry.zod === undefined && codeDefault === undefined
      ? '无代码默认可对'
      : sameDefault
        ? '一致'
        : '**不一致**：文档 ' + designInCodeUnits + ' ｜ 代码 ' + codeDefault
  designRows.push({ name: entry.name, verdict })
  const cells = [
    entry.name,
    String(d.default) + (d.scale === undefined ? '' : '（百分数）'),
    d.min === undefined ? '—' : '[' + d.min + ', ' + d.max + ']',
    codeDefault === undefined ? '—' : String(codeDefault),
    entry.zod === undefined ? '无此项' : String(entry.zod.default),
    zodRange,
    verdict,
  ]
  if (MD) say('| ' + cells.join(' | ') + ' |')
  else say('- ' + cells.join(' ｜ '))
}
const inconsistent = designRows.filter((r) => r.verdict.startsWith('**不一致**'))
if (!MD) {
  say('')
  say('不一致 ' + inconsistent.length + ' 行：' + inconsistent.map((r) => r.name).join('、'))
}

say('')
say('## 设计文档有、代码里没有的配置')
say('')
for (const g of DESIGN_GAPS) {
  say('- ' + g.key + '（文档默认 ' + g.designDefault + '）：' + g.note)
  for (const s of g.codeSites ?? []) say('    代码位置：' + s)
}

say('')
say('## 规模告警（标定场景 vs 当前库）')
say('')
if (scale.missing !== undefined || scale.error !== undefined) {
  say('- 无法比较：读不到库（' + DB + '）')
} else if (alerts.length === 0) {
  say('- 无：所有记录了标定场景的阈值都落在当前库的标定场景内')
} else {
  for (const a of alerts) {
    say('- **超出标定场景** ' + a.name + '（' + a.where + '）')
    for (const m of a.msgs) say('    ' + m)
  }
}
say('')
say('说明：**未记录标定场景的阈值不参与比较** —— 拿未知当已知只会制造假告警。它们列在下一节。')

say('')
say('## 有证据、但标定场景不完整的阈值（缺口，不是错误）')
say('')
say(
  '共 ' +
    partialCal.length +
    ' 行。它们**有证据出处**（代码注释或开发笔记），但记录里没有' +
    '「在哪个库、多少条 atom、什么来源分布」—— 于是无法判断它现在还适不适用。',
)
say('')
say('这正是 M2 审核点出的那个坑：**阈值取自某个库的分布，却用在另一个库上，而代码里没有任何')
say('地方记着它是在什么语料上标定的。** 本次把缺口逐行列出来，标定属后续执行点。')
say('')
for (const r of partialCal) {
  say('- ' + r.name + ' = ' + r.value + '（' + r.where + '）：' + r.cal)
}
say('')
say('## 完全无标定记录的阈值')
say('')
say('共 ' + noCal.length + ' 行：连证据出处都没有（源码无注释，开发笔记里也查不到）。')
say('')
for (const r of noCal) say('- ' + r.name + ' = ' + r.value + '（' + r.where + '）')

say('')
say('## 覆盖核对（源码数值常量）')
say('')
say('- 扫描范围：src/**/*.ts（' + listSources().length + ' 个文件）')
say('- 扫到的模块级数值常量：' + found.size + ' 个')
say('- 已登记或已豁免覆盖：' + (found.size - unregistered.length) + ' 个（豁免 ' + exempted.length + ' 个）')
if (unregistered.length === 0) {
  say('- **属于阈值但未登记：0 个**（空）')
} else {
  say('- **属于阈值但未登记：' + unregistered.length + ' 个**：')
  for (const u of unregistered) say('    ' + u.name + ' = ' + u.value + '（' + u.file + ':' + u.line + '）')
}
say(
  '- 数值扫描捕不到、但源码里确认存在（非数值或对象型）：' +
    (nonNumericRegistered.length === 0 ? '（空）' : nonNumericRegistered.join('、')),
)
if (staleRegistrations.length > 0) {
  say('- **登记了但源码里找不到同名常量**：' + staleRegistrations.join('、'))
}
if (missingAnchors.length > 0) {
  say('- **定位不到定义处**（登记项里的文件名或片段与源码对不上）：' + missingAnchors.join('、'))
}

say('')
say('## 豁免清单（结构性 / 协议性常量，逐条理由）')
say('')
say('### 数值扫描命中、但判为不作为阈值登记')
say('')
if (exempted.length === 0) say('- （空）')
for (const e of exempted)
  say('- ' + e.name + ' = ' + e.value + '（' + e.file + ':' + e.line + '）：' + e.reason)
say('')
say('### 不是数字，所以数值扫描本就捕不到（列出以保证清单完整）')
say('')
say('**「不是数字」不等于「不是阈值」** —— 判据表同样是阈值，它们已经登记在阈值表里。')
say('下面这些是确认过的结构性 / 协议性常量；若某个名字在源码里已找不到，说明源码改了名，需要同步这一节。')
say('')
for (const [name, reason] of Object.entries(EXEMPT_NON_NUMERIC)) {
  const hit = findAnywhere(name)
  say(
    '- ' +
      name +
      (hit === null ? '（源码里已找不到这个名字 ⚠ 需同步）' : '（' + hit.file + ':' + hit.line + '）') +
      '：' +
      reason,
  )
}
if (QUIET) {
  // --quiet：只留结论，供脚本消费
  const keep = out.filter((l) => l.startsWith('- **属于阈值但未登记') || l.startsWith('- **超出标定场景'))
  console.log(keep.join('\n'))
} else {
  console.log(out.join('\n'))
}

if (unregistered.length > 0 || missingAnchors.length > 0) {
  console.error('')
  console.error('覆盖核对未通过：有未登记常量或定位失败的登记项。')
  process.exit(1)
}

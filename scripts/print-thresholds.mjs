// 阈值表打印 + 覆盖核对 + 标定来源格式校验。
//
// 为什么需要它：阈值必须带标定依据存在，而「有没有带」不能靠人记得检查。这条命令一次做三件事：
//   1. 打印全部已登记阈值（名称 / 当前值 / 标定来源 / 可变条件 / 定义位置），可直接贴进文档；
//   2. 用 TypeScript 编译器 API 遍历 src 下每一个模块级变量声明，初始化式能静态求值成数字的
//      （字面量、四则运算、括号、位运算），列出既没登记、也不在豁免清单里的（应当为空）；
//   3. 校验「标定来源」只取三种形状：无记录 / calib@<semver> / calib@<semver> <报告名>。
//
// 用法：node scripts/print-thresholds.mjs [--md] [--quiet]
//
// 退出码：0 = 覆盖核对与来源格式都通过；
//         1 = 有未登记常量 / 默认值被藏进运行时对象 / 来源格式不合法 / 分叉未解释。
//
// 为什么用 AST 而不是一行正则：正则只认「整行恰好是 const X = 裸数字」，表达式型常量
// （12 * 3600 * 1000、5 * 1024）完全隐身 —— 2026-10-20 实测过：追加一行表达式常量，脚本
// 退出码 0、日志里一个字都没有；追加一行裸数字则退出码 1。扫描器对最该防的那类新阈值空转。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  DESIGN_GAPS,
  THRESHOLDS,
  constNameOf,
  currentValue,
  definitionSite,
  subKeys,
} from '../dist/thresholds.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const has = (name) => process.argv.includes('--' + name)

const MD = has('md')
const QUIET = has('quiet')

// ─────────────────────────── ① 源码扫描：AST ───────────────────────────

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
  // 真值在外部包里的条目（external）：本仓库只剩转发，没有可定位的定义行。
  if (entry.external !== undefined) return null
  const { file, anchor } = definitionSite(entry)
  const lines = linesOf(file)
  const needle = entry.inline !== undefined ? anchor : 'const ' + anchor
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1
  return null
}

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
 * 豁免清单：结构性或协议性常量 —— 改它不改变「同一输入得出什么」的判断，或它根本不是阈值。
 * 逐条给理由，没有理由的一律不豁免（理由不足时应当补登记，而不是补豁免）。
 */
const EXEMPT = {
  SCHEMA_VERSION: '协议性：库的 schema 版本，改动要走迁移（MIGRATIONS），不是调参',
  NOISE_LABEL:
    '协议性：聚类标签里「未归类」的哨兵值（-1）。它不是一条线而是一个约定，改它只是把' +
    '同一个语义换个写法（同时要改读取侧对 -1 的判读），没有「取多少合适」可言',
  MIN_K: '结构性上界：k 近邻图的 k 至少要取最近的那个邻居，不是可调区间',
  LOG_SCHEMA_VERSION:
    '协议性：日志库的 PRAGMA user_version，改它等于换日志库格式（实现上是**重建**，不迁移），不是调参',
  DETAIL_MAX_CHARS:
    '结构性上限：detail 序列化后的字符数护栏。白名单字段本就短，改它不改变任何判断，只影响「异常大的 detail 被整条丢弃」',
  SAMPLE_SCHEMA_VERSION:
    '协议性：样本库的 PRAGMA user_version，改它等于换样本库格式（实现上是**重建**，不迁移），不是调参',
}

/**
 * 数值扫描捕不到的例外：它们不是数字，所以不在 src 数值常量清单里。
 *
 * 单列出来的理由：「不是数字」不等于「不是阈值」 —— 判据表也是阈值（v3 的单字虚词表
 * 就是这样一张表，v4 已换成几何判据，见 src/pipeline/entries.ts 的 hasBoundaryFreedom）。
 * 这里只收「结构性或协议性」的那些；真正的非数字判据已经登记进阈值表。
 * 每一条都要给理由，理由不足的应当补登记，而不是补豁免。
 */
const EXEMPT_NON_NUMERIC = {
  VEC_BYTES: '由 VEC_DIM 派生（VEC_DIM x 4）；AST 扫描不解析同名引用，改它等于改 VEC_DIM',
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
  META_SPLIT_CONFIRMED: 'meta 表的键名',
  ATOM_ORIGINS: '类型枚举的取值表',
  ENTRY_RULE_ID: '规则标识：不是取值阈值，但**改入口规则必须改它**（见 docs/DEVELOPMENT.md）',
  EMPTY_VOCAB: '空词表实现，不是阈值',
  SEPARATOR: '正则',
  HAN: '正则',
  DECLARED_EDGE_TYPE_RE:
    '正则：声明边 type 的字符集（小写字母 / 数字 / 下划线）。长度上限另有变量 —— ' +
    'DECLARED_EDGE_TYPE_MAX 已登记进阈值表',
  VERSION: '插件版本（读自 package.json）',
  SAMPLE_DDL: 'SQL 文本（样本库的建表语句，只此一份）',
  Config: 'zod schema 定义体，不是数值常量（其默认值在阈值表里逐项登记）',
}

/**
 * 静态求值：只解析字面量与算术/位运算，不解析同名引用（那是符号解析，不是本检查的范围）。
 * 返回 null 表示「不是可静态求值的数字」。
 */
function numericValue(node) {
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''))
  if (ts.isParenthesizedExpression(node)) return numericValue(node.expression)
  if (ts.isPrefixUnaryExpression(node)) {
    const v = numericValue(node.operand)
    if (v === null) return null
    if (node.operator === ts.SyntaxKind.MinusToken) return -v
    if (node.operator === ts.SyntaxKind.PlusToken) return v
    if (node.operator === ts.SyntaxKind.TildeToken) return ~v
    return null
  }
  if (ts.isBinaryExpression(node)) {
    const l = numericValue(node.left)
    const r = numericValue(node.right)
    if (l === null || r === null) return null
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return l + r
      case ts.SyntaxKind.MinusToken:
        return l - r
      case ts.SyntaxKind.AsteriskToken:
        return l * r
      case ts.SyntaxKind.SlashToken:
        return l / r
      case ts.SyntaxKind.PercentToken:
        return l % r
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return l ** r
      case ts.SyntaxKind.LessThanLessThanToken:
        return l << r
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
        return l >> r
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
        return l >>> r
      case ts.SyntaxKind.AmpersandToken:
        return l & r
      case ts.SyntaxKind.BarToken:
        return l | r
      case ts.SyntaxKind.CaretToken:
        return l ^ r
      default:
        return null
    }
  }
  return null
}

/**
 * 已登记的默认值若被换成运行时对象引用（例如 params.briefMin），数值扫描会看不到它。
 * 这里把「非字面量、但可以解释为派生」的形态放行：引用另一个已声明的常量、字段访问
 * （根是已声明/已登记的常量）、函数调用；其余形态一律视为「默认值可能被藏起来了」。
 */
function isDerived(node, known) {
  if (node === undefined) return false
  if (ts.isNumericLiteral(node)) return true
  if (ts.isParenthesizedExpression(node)) return isDerived(node.expression, known)
  if (ts.isPrefixUnaryExpression(node)) return isDerived(node.operand, known)
  if (ts.isIdentifier(node)) return known.has(node.text)
  if (ts.isPropertyAccessExpression(node)) return isDerived(node.expression, known)
  if (ts.isBinaryExpression(node)) return isDerived(node.left, known) && isDerived(node.right, known)
  if (ts.isCallExpression(node)) return true
  return false
}

/**
 * 模块级变量声明（只认 sourceFile.statements，不进函数与块）。
 * 每个名字记下：位置、是否可静态求值成数字、初始化式节点。
 */
function scanDeclarations() {
  // **不按名字去重**：同名常量可以在两个模块里各写一份（DEFAULT_TOP_N 就是），
  // 去重会让「扫到几个」少算，也会漏掉第二处可能被改坏的值。
  const list = []
  const byName = new Map()
  for (const rel of listSources()) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue
        const value = d.initializer === undefined ? null : numericValue(d.initializer)
        const rec = {
          name: d.name.text,
          file: rel,
          line: sf.getLineAndCharacterOfPosition(d.getStart(sf)).line + 1,
          value,
          form:
            d.initializer !== undefined && ts.isNumericLiteral(d.initializer)
              ? 'literal'
              : value !== null
                ? 'expression'
                : 'other',
          initializer: d.initializer,
        }
        list.push(rec)
        if (!byName.has(rec.name)) byName.set(rec.name, rec)
      }
    }
  }
  return { list, byName }
}

// ─────────────────────────── ② 登记表索引 ───────────────────────────

const registered = new Map()
const registeredNumeric = new Map()
for (const e of THRESHOLDS) {
  const cn = constNameOf(e)
  if (cn === null) continue
  registered.set(cn, e)
  if (typeof currentValue(e) === 'number') registeredNumeric.set(cn, e)
}

const { list: decls, byName: declByName } = scanDeclarations()
const knownNames = new Set([...declByName.keys(), ...registered.keys()])
for (const e of THRESHOLDS) if (e.external !== undefined) knownNames.add(e.name)
for (const k of Object.keys(EXEMPT)) knownNames.add(k)
for (const k of Object.keys(EXEMPT_NON_NUMERIC)) knownNames.add(k)

// ─────────────────────────── ③ 覆盖核对 ───────────────────────────

const unregistered = []
const exempted = []
const bypassed = []
for (const info of decls) {
  if (info.value === null) {
    if (registeredNumeric.has(info.name) && !isDerived(info.initializer, knownNames)) {
      bypassed.push({
        name: info.name,
        file: info.file,
        line: info.line,
        reason: '已登记的默认值不是静态数字，也不是可解释的派生 —— 可能被藏进了运行时对象',
      })
    }
    continue
  }
  if (registered.has(info.name)) continue
  if (Object.prototype.hasOwnProperty.call(EXEMPT, info.name)) {
    exempted.push({
      name: info.name,
      file: info.file,
      line: info.line,
      value: info.value,
      reason: EXEMPT[info.name],
    })
    continue
  }
  unregistered.push({ name: info.name, file: info.file, line: info.line, value: info.value })
}

// 「登记了但不在数值扫描结果里」：只有源码里根本找不到这个名字才算问题。
// 非数值常量（判据表这类）与对象型阈值组本来就捕不到，它们由 findAnywhere 确认存在。
const nonNumericRegistered = []
const staleRegistrations = []
for (const [name, entry] of registered) {
  const d = declByName.get(name)
  if (d !== undefined && d.value !== null) continue
  if (entry.external !== undefined) continue
  const hit = findAnywhere(name)
  if (hit === null) staleRegistrations.push(name + '（' + constNameOf(entry) + '）')
  else nonNumericRegistered.push(name + '（' + hit.file + ':' + hit.line + '，非数值或派生）')
}

const scanned = decls.filter((d) => d.value !== null)
const bareCount = scanned.filter((d) => d.form === 'literal').length
const exprCount = scanned.filter((d) => d.form === 'expression').length

// ─────────────────────────── ④ 标定来源格式 ───────────────────────────

/**
 * 只允许三种形状：
 *   无记录
 *   calib@<semver>
 *   calib@<semver> <报告名>
 * semver 按 major.minor.patch（可带 prerelease）；报告名至少一个非空白字符，不含换行。
 * 不检查报告在仓库里能不能解析 —— 标定报告不随仓库分发是常态（它可能含语料信息）。
 */
const SOURCE_RE = /^(?:无记录|calib@\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?: \S(?:.*\S)?)?)$/

const badSources = []
for (const entry of THRESHOLDS) {
  const source = entry.calibration?.source ?? '无记录'
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) {
    badSources.push({ name: entry.name, source: String(source) })
  }
}

// ─────────────────────────── ⑤ 渲染 ───────────────────────────

const missingAnchors = []
const rows = []

for (const entry of THRESHOLDS) {
  const line = locate(entry)
  const { file } = definitionSite(entry)
  if (line === null && entry.external === undefined) missingAnchors.push(entry.name + ' @ ' + file)
  const where =
    entry.external !== undefined
      ? entry.external.pkg + ':' + entry.external.file + '（外部包）'
      : file + (line === null ? ':?' : ':' + line)
  const keys = subKeys(entry)
  const val = currentValue(entry)
  const shown =
    entry.display !== undefined
      ? entry.display
      : keys.length > 0
        ? keys.map((k) => k + '=' + (val[k] ?? '?')).join(' / ')
        : String(val)
  rows.push({
    name: entry.name,
    value: shown,
    area: entry.area,
    source: entry.calibration?.source ?? '无记录',
    varies: entry.variesWith.join('；'),
    where,
    design: entry.design,
    zod: entry.zod,
    otherSites: entry.otherSites ?? [],
    diverges: entry.diverges,
  })
}

const withSource = rows.filter((r) => r.source !== '无记录')
const withoutSource = rows.length - withSource.length

const out = []
const say = (...xs) => out.push(...xs)

say('# dsh-lattice 阈值登记表')

say('')
say('## 已登记阈值')
say(
  '- 共 ' +
    rows.length +
    ' 行：有标定来源 ' +
    withSource.length +
    ' 行，无记录 ' +
    withoutSource +
    ' 行（来源形状：无记录 / calib@<semver> / calib@<semver> <报告名>）',
)
say('')
if (MD) {
  say('| 名称 | 当前值 | 段 | 标定来源 | 可变条件 | 定义位置 |')
  say('|---|---|---|---|---|---|')
  for (const r of rows) {
    say(
      '| ' +
        [r.name, r.value, r.area, r.source, r.varies, r.where]
          .map((x) => String(x).replace(/\|/g, '\\|'))
          .join(' | ') +
        ' |',
    )
  }
} else {
  // 每行六个字段，行内用 ' | ' 分隔 —— 一行一条，可直接贴进文档。
  say(['名称', '当前值', '段', '标定来源', '可变条件', '定义位置'].join(' | '))
  for (const r of rows) say([r.name, r.value, r.area, r.source, r.varies, r.where].join(' | '))
}

say('')
say('## 标定来源')
say('')
if (withSource.length === 0) {
  say('- 有指针 0 行 —— 全部写的是「无记录」')
} else {
  say('- 有指针 ' + withSource.length + ' 行：')
  for (const r of withSource) say('    ' + r.name + ' = ' + r.source + '（' + r.where + '）')
}
say(
  '- 「无记录」' +
    withoutSource +
    ' 行。查不到就留空：把缺口暴露出来是本表的产出之一，编一个看起来合理的来源比留空更糟。',
)

// 设计文档对照
say('')
say('## 与设计文档 §7 的对照（只列有对应项的行）')
say('')
say('设计文档 = 开发笔记《设计/技术文档/7.配置项清单.md》（设计正文不进本仓库）。')
say('')
if (MD) {
  say('| 名称 | 设计默认 | 设计范围 | 代码默认 | zod 默认 | zod 范围 | 一致？ |')
  say('|---|---|---|---|---|---|---|')
}
const designRows = []
// D3：分叉必须有解释。zod 默认值与设计文档不同时，登记项里必须有 diverges 说明原因 ——
// 「存在分叉」本身不是问题（文档可能没同步），「分叉没人解释」才是：读表的人会在这里停下来，
// 然后自己去猜。判据不是「不一致就红」，那会永久红。
const unexplainedDiverges = []
for (const entry of THRESHOLDS) {
  if (entry.design === undefined) continue
  const d = entry.design
  const scaleK = d.scale ?? 1
  const designInCodeUnits = d.default / scaleK
  // 「代码默认」取的是模块默认值：zod 有就用 zod 的（它是配置入口的默认值），
  // 对象型阈值组取与设计同名的那个子键（docs 叫 wVec，代码叫 vec）。
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
  if (
    entry.zod !== undefined &&
    Math.abs(entry.zod.default - designInCodeUnits) > 1e-9 &&
    entry.diverges === undefined
  ) {
    unexplainedDiverges.push(
      entry.name + '（设计 ' + designInCodeUnits + ' ｜ zod ' + entry.zod.default + '）',
    )
  }
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
say('## 分叉未解释（非零退出的条件之一）')
say('')
if (unexplainedDiverges.length === 0) {
  say('- 无：所有与设计文档不同的 zod 默认值都写了 diverges')
} else {
  say('**以下阈值的 zod 默认值与设计文档不同，而登记项没有 diverges** —— 读表的人会停在这里：')
  for (const x of unexplainedDiverges) say('- 分叉未解释 ' + x)
}
say('')
say('## 设计文档有、代码里没有的配置')
say('')
for (const g of DESIGN_GAPS) {
  say('- ' + g.key + '（文档默认 ' + g.designDefault + '）：' + g.note)
  for (const s of g.codeSites ?? []) say('    代码位置：' + s)
}

say('')
say('## 标定来源格式（非零退出的条件之一）')
say('')
if (badSources.length === 0) {
  say('- 全部合法：来源只取 无记录 / calib@<semver> / calib@<semver> <报告名> 三种形状')
} else {
  say('**以下来源不符合形状**（不要求报告在仓库内可解析，但必须是这三种形状之一）：')
  for (const b of badSources) say('- 格式不合法 ' + b.name + ' = ' + b.source)
}

say('')
say('## 覆盖核对（源码模块级数值常量，AST 扫描）')
say('')
say('- 扫描范围：src/**/*.ts（' + listSources().length + ' 个文件）')
say(
  '- 扫到的模块级数值常量：' +
    scanned.length +
    ' 个（裸字面量 ' +
    bareCount +
    ' / 表达式 ' +
    exprCount +
    '）',
)
say(
  '- 已登记或已豁免覆盖：' +
    (scanned.length - unregistered.length) +
    ' 个（豁免 ' +
    exempted.length +
    ' 个）',
)
if (unregistered.length === 0) {
  say('- **属于阈值但未登记：0 个**（空）')
} else {
  say('- **属于阈值但未登记：' + unregistered.length + ' 个**：')
  for (const u of unregistered) say('    ' + u.name + ' = ' + u.value + '（' + u.file + ':' + u.line + '）')
}
if (bypassed.length === 0) {
  say('- **默认值被运行时对象引用：0 个**')
} else {
  say('- **默认值被运行时对象引用：' + bypassed.length + ' 个**：')
  for (const b of bypassed) say('    ' + b.name + '（' + b.file + ':' + b.line + '）：' + b.reason)
}
say(
  '- 数值扫描捕不到、但源码里确认存在（非数值或派生）：' +
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
  // --quiet：只留结论与失败项，供脚本消费。
  const keep = []
  if (unregistered.length === 0) {
    keep.push('- **属于阈值但未登记：0 个**（空）')
  } else {
    keep.push('- **属于阈值但未登记：' + unregistered.length + ' 个**：')
    for (const u of unregistered)
      keep.push('    ' + u.name + ' = ' + u.value + '（' + u.file + ':' + u.line + '）')
  }
  if (bypassed.length === 0) {
    keep.push('- **默认值被运行时对象引用：0 个**')
  } else {
    keep.push('- **默认值被运行时对象引用：' + bypassed.length + ' 个**：')
    for (const b of bypassed) keep.push('    ' + b.name + '（' + b.file + ':' + b.line + '）：' + b.reason)
  }
  for (const x of unexplainedDiverges) keep.push('- 分叉未解释 ' + x)
  for (const b of badSources) keep.push('- 格式不合法 ' + b.name + ' = ' + b.source)
  console.log(keep.join('\n'))
} else {
  console.log(out.join('\n'))
}

if (unregistered.length > 0 || missingAnchors.length > 0 || bypassed.length > 0) {
  console.error('')
  console.error('覆盖核对未通过：有未登记常量、默认值被藏进运行时对象，或定位失败的登记项。')
  process.exit(1)
}

if (badSources.length > 0) {
  console.error('')
  console.error('标定来源格式不合法：只允许「无记录 / calib@<semver> / calib@<semver> <报告名>」。')
  for (const b of badSources) console.error('  ' + b.name + ' = ' + b.source)
  process.exit(1)
}

if (unexplainedDiverges.length > 0) {
  console.error('')
  console.error('分叉未解释：以下阈值的 zod 默认值与设计文档不同，但登记项里没有 diverges。')
  console.error("写法：在该项的登记里加 diverges: '…为什么不同…'（读者要的是原因，不是差值）。")
  for (const x of unexplainedDiverges) console.error('  ' + x)
  process.exit(1)
}

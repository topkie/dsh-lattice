// 阈值表打印 + 覆盖核对。
//
// 为什么需要它：阈值必须带标定依据存在，而「有没有带」不能靠人记得检查。这条命令一次做两件事：
//   1. 打印全部已登记阈值（名称 / 当前值 / 来历 / 可变条件 / 定义位置），可直接贴进文档；
//   2. 用 TypeScript 编译器 API 遍历 src 下每一个模块级变量声明，初始化式能静态求值成数字的
//      （字面量、四则运算、括号、位运算），列出既没登记、也不在豁免清单里的（应当为空）。
//
// 该表的另一部分是**来历**（T54）：每个条目要么是 recheckable（测过、可复算），
// 要么是 chosen（没有测量能给出它）。来历的三种查询与评审基线检查在这里：
//
//   node scripts/print-thresholds.mjs --needs-review   声明可复算、但缺编码模型与语料规模的条目
//   node scripts/print-thresholds.mjs --unguarded      没有测试按常量名断言默认值的条目
//   node scripts/print-thresholds.mjs --undated        可复算、非公式、但没有记录测量时间的条目（只是信息）
//   node scripts/print-thresholds.mjs --check-review   评审基线检查（门禁调用；失败即非零退出）
//
// 三个查询只读登记表，不写库、不改源码；T54 迁移完成后每条都有 origin。
//
// 用法：node scripts/print-thresholds.mjs [--md] [--quiet]
//
// 退出码：0 = 覆盖核对与评审基线都通过；
//         1 = 有未登记常量 / 默认值被藏进运行时对象 / 分叉未解释 /
//             评审基线不满足（--check-review）。
//
// 为什么用 AST 而不是一行正则：正则只认「整行恰好是 const X = 裸数字」，表达式型常量
// （12 * 3600 * 1000、5 * 1024）完全隐身 —— 2026-10-20 实测过：追加一行表达式常量，脚本
// 退出码 0、日志里一个字都没有；追加一行裸数字则退出码 1。扫描器对最该防的那类新阈值空转。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  DESIGN_GAPS,
  THRESHOLDS,
  constNameOf,
  currentValue,
  definitionSite,
  displayProblems,
  divergenceProblems,
  needsReviewEntries,
  reviewBaselineProblems,
  subKeys,
  undatedEntries,
  unguardedEntries,
} from '../dist/thresholds.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const has = (name) => process.argv.includes('--' + name)

const MD = has('md')
const QUIET = has('quiet')

// ─────────────────── ⓪ 来历：三个查询与评审基线（T54）───────────────────
//
// 三个查询都只读登记表，不写库、不改源码。

/** needs-review 的「缺什么」：判据在 dist/thresholds.js 的 needsReviewEntries。 */
function missingOf(entry) {
  const o = entry.calibration.origin
  const missing = []
  if (o.encoderModel === undefined) missing.push('编码模型')
  if (o.scale === undefined) missing.push('语料规模')
  return '缺 ' + missing.join('、')
}

const QUERIES = {
  'needs-review': () =>
    needsReviewEntries().map((e) => ({ name: e.name, area: e.area, detail: missingOf(e) })),
  unguarded: () => unguardedEntries().map((e) => ({ name: e.name, area: e.area, detail: '' })),
  undated: () => undatedEntries().map((e) => ({ name: e.name, area: e.area, detail: '' })),
}

function renderQuery(mode) {
  const rows = QUERIES[mode]()
  console.log('# --' + mode + '：' + rows.length + ' 条')
  if (rows.length === 0) console.log('（空）')
  for (const r of rows) {
    console.log('- ' + r.name + ' ｜ ' + r.area + (r.detail === '' ? '' : ' ｜ ' + r.detail))
  }
}

/**
 * 评审基线：把当前还没条件补的条目记成一份存量清单，只允许变短。
 *
 * 四条规则（任何一条不满足都非零退出）：
 * 1. 每条必须带理由 —— 空字符串不算理由；
 * 2. 基线里的名字必须是登记表里真实存在的条目 —— 「新增一个名字」与「条目删了、基线还在」
 *    都会在这里红（后者就是「删除时留转到哪去了」的机器检查面：条目真删了，基线要一起删）；
 * 3. 当前查询结果 ⊆ 基线 —— 代码里新出现一个待评审条目，不能靠把它塞进基线消掉；
 * 4. 基线里当前已不在结果中的项不报错，只计数 —— 基线只允许变短。
 */
function checkReviewBaseline() {
  const BASELINE = join(ROOT, 'thresholds-review-baseline.json')
  if (!existsSync(BASELINE)) {
    console.error('评审基线不存在：' + 'thresholds-review-baseline.json')
    console.error('修法：新建该文件，写 { "_note": "…", "needsReview": {}, "unguarded": {} }；')
    console.error('去哪看：docs/DEVELOPMENT.md「阈值登记」一节。')
    process.exit(1)
  }
  let baseline
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  } catch (err) {
    console.error('评审基线不是合法 JSON：' + err.message)
    console.error('修法：修好 JSON 语法；去哪看：docs/DEVELOPMENT.md「阈值登记」。')
    process.exit(1)
  }
  const INVENTORY = join(ROOT, 'thresholds-inventory.json')
  if (!existsSync(INVENTORY)) {
    console.error('冻结名册不存在：thresholds-inventory.json')
    console.error('修法：它是存量的名字列表，不要凭空生成；从上一个版本恢复。')
    console.error('去哪看：docs/DEVELOPMENT.md「阈值登记」一节。')
    process.exit(1)
  }
  let inventory
  try {
    inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'))
  } catch (err) {
    console.error('冻结名册不是合法 JSON：' + err.message)
    process.exit(1)
  }
  const current = { needsReview: QUERIES['needs-review'](), unguarded: QUERIES.unguarded() }
  const problems = reviewBaselineProblems(baseline, inventory)
  // 「已解决」= 基线里当前不再出现的项：不报错，只提示可以删（基线只允许变短）。
  let resolved = 0
  for (const [key, rows] of [
    ['needsReview', current.needsReview],
    ['unguarded', current.unguarded],
  ]) {
    const list = baseline[key]
    if (list === null || typeof list !== 'object' || Array.isArray(list)) continue
    const names = new Set(rows.map((r) => r.name))
    for (const name of Object.keys(list)) if (!names.has(name)) resolved++
  }
  if (problems.length > 0) {
    console.error('评审基线不通过（' + problems.length + ' 项）：')
    for (const p of problems) console.error('  - ' + p)
    console.error('')
    console.error('修法：能补条件的补条件；确实补不了的才进基线，并写清为什么。')
    console.error('去哪看：docs/DEVELOPMENT.md「阈值登记」一节。')
    process.exit(1)
  }
  console.log(
    '评审基线：通过（needsReview ' +
      current.needsReview.length +
      ' 条 / unguarded ' +
      current.unguarded.length +
      ' 条；基线里已不在结果中的 ' +
      resolved +
      ' 条，可删）',
  )
  if (current.needsReview.length === 0 && current.unguarded.length === 0) {
    console.log('两个集合都空了：这份临时清单已经没用，删掉 thresholds-review-baseline.json。')
  }
}

const QUERY_MODE = ['needs-review', 'unguarded', 'undated'].find((m) => has(m))
if (QUERY_MODE !== undefined) {
  renderQuery(QUERY_MODE)
  process.exit(0)
}
if (has('check-review')) {
  checkReviewBaseline()
  process.exit(0)
}

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

// ─────────────────────── ③′ 断言：登记里的关系必须成立（T55）───────────────────────
//
// 三种关系原先靠手写的文字维持，现在由这里核对：
//   1. display 里不写字面等式 —— 等式随常量变，写成字符串就跟不上；
//   2. 声明了 divergence.docValue 的，分叉必须真的存在（相等 = 这条该删）；
//   3. refs 指向的文件存在、符号在文件里出现 —— 行号会漂，符号不会。
const assertionProblems = [...displayProblems(), ...divergenceProblems()]
const refSites = [
  ...THRESHOLDS.map((e) => [e.name, e.refs ?? []]),
  ...DESIGN_GAPS.map((g) => ['设计文档缺口 ' + g.key, g.refs ?? []]),
]
for (const [where, refs] of refSites) {
  for (const ref of refs) {
    const path = join(ROOT, ref.file)
    if (!existsSync(path)) {
      assertionProblems.push(where + '：refs 指向的文件不存在 ' + ref.file)
      continue
    }
    const symbol = ref.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp('\\b' + symbol + '\\b').test(readFileSync(path, 'utf8'))) {
      assertionProblems.push(where + '：refs 里的符号 ' + ref.symbol + ' 在 ' + ref.file + ' 里找不到')
    }
  }
}

// ─────────────────────────── ④ 渲染 ───────────────────────────

/** 来历的短标签：表格里一列能看懂「这个值是怎么来的」。 */
function originLabel(entry) {
  const o = entry.calibration?.origin
  if (o === undefined) return '无来历'
  if (o.kind === 'chosen') return '选择'
  return o.formula === true ? '可复算（公式）' : '可复算'
}

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
      ? typeof entry.display === 'function'
        ? entry.display()
        : entry.display
      : keys.length > 0
        ? keys.map((k) => k + '=' + (val[k] ?? '?')).join(' / ')
        : String(val)
  rows.push({
    name: entry.name,
    value: shown,
    area: entry.area,
    origin: originLabel(entry),
    varies: entry.variesWith.join('；'),
    where,
    design: entry.design,
    zod: entry.zod,
    otherSites: entry.otherSites ?? [],
    diverges: entry.diverges,
  })
}

const formulaCount = rows.filter((r) => r.origin === '可复算（公式）').length
const recheckableCount = rows.filter((r) => r.origin === '可复算').length
const chosenCount = rows.filter((r) => r.origin === '选择').length

const out = []
const say = (...xs) => out.push(...xs)

say('# dsh-lattice 阈值登记表')

say('')
say('## 已登记阈值')
say(
  '- 共 ' +
    rows.length +
    ' 行：可复算 ' +
    recheckableCount +
    ' 行（其中公式 ' +
    formulaCount +
    ' 行）、选择 ' +
    chosenCount +
    ' 行',
)
say('')
if (MD) {
  say('| 名称 | 当前值 | 段 | 来历 | 可变条件 | 定义位置 |')
  say('|---|---|---|---|---|---|')
  for (const r of rows) {
    say(
      '| ' +
        [r.name, r.value, r.area, r.origin, r.varies, r.where]
          .map((x) => String(x).replace(/\|/g, '\\|'))
          .join(' | ') +
        ' |',
    )
  }
} else {
  // 每行六个字段，行内用 ' | ' 分隔 —— 一行一条，可直接贴进文档。
  say(['名称', '当前值', '段', '来历', '可变条件', '定义位置'].join(' | '))
  for (const r of rows) say([r.name, r.value, r.area, r.origin, r.varies, r.where].join(' | '))
}

say('')
say('## 来历')
say('')
say('- 可复算 ' + recheckableCount + ' 行、公式 ' + formulaCount + ' 行、选择 ' + chosenCount + ' 行。')
say(
  '- 缺编码模型或语料规模的见 --needs-review；没有按常量名断言的测试见 --unguarded；' +
    '没有测量时间的见 --undated。补不上的条件记在 thresholds-review-baseline.json。',
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
// D3：分叉必须有解释。zod 默认值与设计文档不同时，登记项里必须有 diverges 或 divergence 说明原因 ——
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
    entry.diverges === undefined &&
    entry.divergence === undefined
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

// 「设计文档没有这个键」不再手写（T55 第 3 项）：句子由字段倒推，缺 design 也缺 external
// 的条目自动出现在这里。手写的同一句话会与字段脱钩 —— 补上 design 之后它还在，而字段已经变了。
const notInDesignDoc = THRESHOLDS.filter((e) => e.design === undefined && e.external === undefined)
say('')
say('## 设计文档 §7 没有对应键的条目（自动生成）')
say('')
say('这一节不是手写的：条目缺 design 也缺 external 时，打印脚本补一句；给某条补上 design，它就从这里消失。')
for (const e of notInDesignDoc) say('- ' + e.name + '（' + e.area + '）：设计文档 §7 没有这个键')

say('')
say('## 分叉未解释（非零退出的条件之一）')
say('')
if (unexplainedDiverges.length === 0) {
  say('- 无：所有与设计文档不同的 zod 默认值都写了 diverges 或 divergence')
} else {
  say('**以下阈值的 zod 默认值与设计文档不同，而登记项没有 diverges** —— 读表的人会停在这里：')
  for (const x of unexplainedDiverges) say('- 分叉未解释 ' + x)
}
say('')
say('## 断言（关系必须成立）')
say('')
if (assertionProblems.length === 0) {
  say('- 无：display 里没有字面等式、divergence 都成立、refs 都指得到')
} else {
  say('**以下关系不成立** —— 登记里的说法与代码对不上：')
  for (const p of assertionProblems) say('- ' + p)
}
say('')
say('## 设计文档有、代码里没有的配置')
say('')
for (const g of DESIGN_GAPS) {
  say('- ' + g.key + '（文档默认 ' + g.designDefault + '）：' + g.note)
  for (const s of g.codeSites ?? []) say('    代码位置：' + s)
  for (const r of g.refs ?? []) say('    代码位置：' + r.file + ' 的 ' + r.symbol)
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
  for (const p of assertionProblems) keep.push('- 断言不成立 ' + p)
  console.log(keep.join('\n'))
} else {
  console.log(out.join('\n'))
}

if (unregistered.length > 0 || missingAnchors.length > 0 || bypassed.length > 0) {
  console.error('')
  console.error('覆盖核对未通过：有未登记常量、默认值被藏进运行时对象，或定位失败的登记项。')
  process.exit(1)
}

if (assertionProblems.length > 0) {
  console.error('')
  console.error('断言不成立：登记里的 display 等式、divergence 或 refs 与代码对不上。')
  console.error('修法：display 改成函数；分叉消失就删掉 divergence；refs 里的符号改名了要同步。')
  for (const p of assertionProblems) console.error('  ' + p)
  process.exit(1)
}

if (unexplainedDiverges.length > 0) {
  console.error('')
  console.error('分叉未解释：以下阈值的 zod 默认值与设计文档不同，但登记项里没有 diverges。')
  console.error(
    "写法：值不同写 divergence: { docValue, note }，别的分叉写 diverges: '…'（读者要的是原因，不是差值）。",
  )
  for (const x of unexplainedDiverges) console.error('  ' + x)
  process.exit(1)
}

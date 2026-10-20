// 阈值来历（T54）的单元测试。
//
// 三部分：
//   ① 构造器的类型约束：chosen 的第二参数传对象必须编译报错（用 TypeScript 编译器 API
//      检查一个带 @ts-expect-error 的用例文件；删掉那行注释，本测试就会红）；
//   ② 三个查询按判据列条目，且只处理迁移过的（有 origin 的）条目；
//   ③ 评审基线的四条规则各构造一次：凭空加名、删理由、改名、删一条已解决的项。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  THRESHOLDS,
  needsReviewEntries,
  reviewBaselineProblems,
  undatedEntries,
  unguardedEntries,
} from '../dist/thresholds.js'

const TYPES_FILE = fileURLToPath(new URL('./thresholds-origin.types.ts', import.meta.url))
const BASELINE_FILE = fileURLToPath(new URL('../thresholds-review-baseline.json', import.meta.url))

describe('阈值来历：构造器的类型', () => {
  it('chosen 的第二参数传对象时编译报错（@ts-expect-error 用例，诊断数必须为 0）', () => {
    const source = readFileSync(TYPES_FILE, 'utf8')
    assert.match(source, /@ts-expect-error/, '用例文件里必须有 @ts-expect-error')
    const program = ts.createProgram([TYPES_FILE], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
    })
    const diags = ts.getPreEmitDiagnostics(program)
    const shown = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join(' / ')
    assert.equal(diags.length, 0, '期望 0 条诊断（错误被 @ts-expect-error 吞掉）；实际：' + shown)
  })
})

describe('阈值来历：三个查询', () => {
  it('needs-review 只收 recheckable、非公式、缺编码模型与语料规模的条目', () => {
    const rows = needsReviewEntries()
    for (const e of rows) {
      const o = e.calibration.origin
      assert.equal(o.kind, 'recheckable', e.name + ' 的来历不是 recheckable')
      assert.notEqual(o.formula, true, e.name + ' 是公式条目，不该进 needs-review')
      assert.equal(o.encoderModel, undefined, e.name + ' 已有编码模型')
      assert.equal(o.scale, undefined, e.name + ' 已有语料规模')
    }
    assert.ok(rows.length > 0, '当前应至少列出一条（迁移完两个 area 后）')
  })

  it('迁移完成：每条都有 origin，没有只剩旧 evidence 的条目', () => {
    const legacy = THRESHOLDS.filter((e) => e.calibration?.origin === undefined)
    assert.deepEqual(
      legacy.map((e) => e.name),
      [],
      '仍有条目只有旧的 evidence（未迁移）',
    )
  })

  it('unguarded 只收有 origin、且 guardedBy 为空或没写的条目', () => {
    const rows = unguardedEntries()
    assert.ok(rows.length > 0, '当前应至少列出一条（迁移完两个 area 后）')
    for (const e of rows) {
      assert.notEqual(e.calibration?.origin, undefined, e.name + ' 没有 origin')
      const g = e.calibration.guardedBy
      assert.ok(g === undefined || g.length === 0, e.name + ' 有 guardedBy')
    }
  })

  it('undated 只收 recheckable、非公式、且没有记录测量时间的条目', () => {
    const rows = undatedEntries()
    assert.ok(rows.length > 0, '当前应至少列出一条（迁移完两个 area 后）')
    for (const e of rows) {
      const o = e.calibration.origin
      assert.equal(o.kind, 'recheckable', e.name + ' 的来历不是 recheckable')
      assert.notEqual(o.formula, true, e.name + ' 是公式条目，不该进 undated')
      assert.equal(o.at, undefined, e.name + ' 已记录测量时间')
    }
    // 公式条目一条都不许出现在结果里：它们的「测量时间」不是可补的东西。
    const formulas = THRESHOLDS.filter((e) => e.calibration?.origin?.formula === true)
    assert.ok(formulas.length > 0, '当前应有公式条目；若已全部消失，删掉这条断言')
    for (const e of formulas) {
      assert.equal(
        undatedEntries().some((x) => x.name === e.name),
        false,
        e.name + ' 是公式条目，不该进 undated',
      )
    }
  })
})

describe('阈值来历：评审基线的四条规则', () => {
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))

  it('规则 1：基线里凭空加一个名字 → 红', () => {
    const bad = { ...baseline, unguarded: { ...baseline.unguarded, NOT_A_THRESHOLD: '凑数' } }
    const problems = reviewBaselineProblems(bad)
    assert.ok(
      problems.some((p) => p.includes('NOT_A_THRESHOLD') && p.includes('不在登记表里')),
      '应报「不在登记表里」：' + problems.join(' / '),
    )
  })

  it('规则 2：删掉某条理由 → 红', () => {
    const name = Object.keys(baseline.needsReview)[0]
    const bad = { ...baseline, needsReview: { ...baseline.needsReview, [name]: '' } }
    const problems = reviewBaselineProblems(bad)
    assert.ok(
      problems.some((p) => p.includes(name) && p.includes('没有写理由')),
      '应报「没有写理由」：' + problems.join(' / '),
    )
  })

  it('规则 3：把基线条目改成集合外的名字 → 红', () => {
    const name = Object.keys(baseline.unguarded)[0]
    const list = { ...baseline.unguarded }
    delete list[name]
    list.NOT_A_THRESHOLD = baseline.unguarded[name]
    const problems = reviewBaselineProblems({ ...baseline, unguarded: list })
    assert.ok(
      problems.some((p) => p.includes(name) && p.includes('新增的待评审条目')),
      '应报「新增的待评审条目」：' + problems.join(' / '),
    )
    assert.ok(
      problems.some((p) => p.includes('NOT_A_THRESHOLD') && p.includes('不在登记表里')),
      '应报「不在登记表里」：' + problems.join(' / '),
    )
  })

  it('规则 4：删掉一条当前不在结果中的基线项 → 绿（只允许变短）', () => {
    // 构造一条「已解决」项：名字是登记表里真实存在的条目，且不在当前 unguarded 结果里。
    const current = new Set(unguardedEntries().map((e) => e.name))
    const resolved = THRESHOLDS.find((e) => e.calibration?.origin !== undefined && !current.has(e.name))
    if (resolved === undefined) return
    const withExtra = {
      ...baseline,
      unguarded: { ...baseline.unguarded, [resolved.name]: '已解决，待删' },
    }
    assert.deepEqual(reviewBaselineProblems(withExtra), [], '多余项不该让它变红')
    const removed = { ...withExtra, unguarded: { ...withExtra.unguarded } }
    delete removed.unguarded[resolved.name]
    assert.deepEqual(reviewBaselineProblems(removed), [], '删掉「已解决」项后应仍通过')
  })
})

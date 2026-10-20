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
  DESIGN_GAPS,
  THRESHOLDS,
  displayProblems,
  divergenceProblems,
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

describe('阈值来历：display 的等式必须是活值（T55）', () => {
  it('字面量 display 里出现「=」→ 报一条，点名是哪条', () => {
    const entry = { ...THRESHOLDS[0], name: 'FAKE_EQUATION', display: '8（= 1000 ÷ 125）' }
    const problems = displayProblems([entry])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /FAKE_EQUATION/)
  })

  it('函数形式的 display 不报 —— 等号是打印时现算的', () => {
    const entry = { ...THRESHOLDS[0], name: 'FAKE_EQUATION', display: () => '8（= 1000 ÷ 125）' }
    assert.deepEqual(displayProblems([entry]), [])
  })

  it('登记表里没有字面等式', () => {
    assert.deepEqual(displayProblems(), [])
  })
})

describe('阈值来历：refs 指得到符号（T55）', () => {
  const ROOT = fileURLToPath(new URL('..', import.meta.url))
  const refSites = [
    ...THRESHOLDS.map((e) => [e.name, e.refs ?? []]),
    ...DESIGN_GAPS.map((g) => ['设计文档缺口 ' + g.key, g.refs ?? []]),
  ]

  it('登记的 refs 都看得到：文件存在，符号在文件里出现', () => {
    for (const [name, refs] of refSites) {
      for (const ref of refs) {
        const text = readFileSync(ROOT + ref.file, 'utf8')
        assert.ok(text.includes(ref.symbol), name + '：' + ref.file + ' 里找不到符号 ' + ref.symbol)
      }
    }
  })

  it('登记表里不再出现「文件:行号」的引用', () => {
    const text = readFileSync(ROOT + 'src/thresholds.ts', 'utf8')
    const hits = text.match(/[A-Za-z0-9_./-]+\.(?:ts|mjs|js):\d/g) ?? []
    assert.deepEqual(hits, [], '行号会漂：改成 refs: [{ file, symbol }] 或「文件 + 符号名」的叙述')
  })

  it('当前应有至少一条 refs（否则这条检查在空转）', () => {
    assert.ok(
      refSites.some(([, refs]) => refs.length > 0),
      '登记表里一条 refs 都没有',
    )
  })
})

describe('阈值来历：缺键由打印脚本生成（T55）', () => {
  it('diverges 里不再手写「设计文档 §7 没有这个键」', () => {
    const handwritten = THRESHOLDS.filter((e) => (e.diverges ?? '').includes('设计文档 §7 没有'))
    assert.deepEqual(
      handwritten.map((e) => e.name),
      [],
      '这句话由 print-thresholds.mjs 按「缺 design 且缺 external」自动补，手写会与字段脱钩',
    )
  })

  it('缺 design 也缺 external 的条目，正是该自动列出的一批', () => {
    const rows = THRESHOLDS.filter((e) => e.design === undefined && e.external === undefined)
    assert.ok(rows.length > 0, '当前应有这样的条目；若都补上了 design，删掉这条断言')
    assert.ok(
      rows.every((e) => e.design === undefined),
      '列出的条目不应有 design',
    )
  })
})

describe('阈值来历：分叉声明必须成立（T55）', () => {
  const numeric = THRESHOLDS.find((e) => typeof e.value() === 'number')

  it('docValue 与代码值相等 → 报「分叉已不存在」', () => {
    const entry = {
      ...numeric,
      name: 'FAKE_DIVERGENCE',
      divergence: { docValue: numeric.value(), note: '假的' },
    }
    const problems = divergenceProblems([entry])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /FAKE_DIVERGENCE/)
    assert.match(problems[0], /分叉已不存在/)
  })

  it('docValue 与代码值不同 → 不报', () => {
    const entry = {
      ...numeric,
      name: 'FAKE_DIVERGENCE',
      divergence: { docValue: numeric.value() + 1, note: '真的' },
    }
    assert.deepEqual(divergenceProblems([entry]), [])
  })

  it('对象型条目上声明 divergence → 报（那种断言永远成立）', () => {
    const group = THRESHOLDS.find((e) => typeof e.value() === 'object')
    const entry = { ...group, name: 'FAKE_GROUP', divergence: { docValue: 1, note: '假的' } }
    const problems = divergenceProblems([entry])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /只用于数值条目/)
  })

  it('登记表里声明的分叉都成立', () => {
    assert.deepEqual(divergenceProblems(), [])
    assert.ok(
      THRESHOLDS.some((e) => e.divergence !== undefined),
      '当前应有至少一条 divergence；若都删了，删掉这条断言',
    )
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

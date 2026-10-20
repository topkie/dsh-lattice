// 按库规模重标定：锚点表、插值、夹紧、降级，以及它改变档位的具体情形。
//
// 这里断言的是**判据本身**，不是某个库上的观测量 —— 观测量（各规模点的 top1 分布）
// 记在开发笔记的《T23-b-重标定-实现报告》里，带留档脚本，不进 CI：
// 它们要真实编码器与 1374 条基准库，进了 CI 之后「绿」就不等于「这条线切对了地方」。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TIER_SCALE_ANCHORS, TIER_SCALE_MIN_ATOMS, briefMinFor } from '../dist/pipeline/calibrate.js'
import { TIER_BRIEF_MIN, TIER_FULL_MIN, tierOf } from '../dist/pipeline/view.js'

const FALLBACK = TIER_BRIEF_MIN
const TOP = TIER_SCALE_ANCHORS[TIER_SCALE_ANCHORS.length - 1]
const BOTTOM = TIER_SCALE_ANCHORS[0]

describe('按库规模重标定精简档下界', () => {
  it('锚点表上的每个规模点都原样取到实测值', () => {
    for (const a of TIER_SCALE_ANCHORS) assert.equal(briefMinFor(a.atoms, FALLBACK), a.briefMin)
  })

  it('每个锚点带 95% 区间，且区间包含该点的实测值', () => {
    // 只守**形态**：区间有序、且把 briefMin 包在里面。数值来源（这个 ci 是不是抄对了）
    // 由探针脚本复核 —— 它要重抽 400 次，
    // 不适合进 CI；但若有人改了 briefMin 却忘了同步 ci，这条会红。
    for (const a of TIER_SCALE_ANCHORS) {
      const [lo, hi] = a.ci
      assert.ok(lo <= hi, a.atoms + '：ci 的下界不得大于上界')
      assert.ok(lo <= a.briefMin && a.briefMin <= hi, a.atoms + '：ci 必须包含该点的 briefMin')
    }
  })

  it('锚点表自身有序、且起点就是最小可标定规模', () => {
    assert.equal(BOTTOM.atoms, TIER_SCALE_MIN_ATOMS)
    for (let i = 1; i < TIER_SCALE_ANCHORS.length; i++) {
      assert.ok(TIER_SCALE_ANCHORS[i].atoms > TIER_SCALE_ANCHORS[i - 1].atoms, '规模点必须严格递增')
      assert.ok(TIER_SCALE_ANCHORS[i].briefMin >= TIER_SCALE_ANCHORS[i - 1].briefMin, '锚点值必须单调不减')
    }
  })

  it('库小到没法标定时退回默认值，而不是外推', () => {
    for (const n of [0, 1, 5, 11]) assert.equal(briefMinFor(n, FALLBACK), FALLBACK)
  })

  it('库大于锚点表上端时取上端值夹紧，而不是外推', () => {
    for (const n of [TOP.atoms, TOP.atoms + 1, 5000, 1000000]) {
      assert.equal(briefMinFor(n, FALLBACK), TOP.briefMin)
    }
  })

  it('锚点区间内单调不减（规模变大不会把线调低）', () => {
    let prev = briefMinFor(BOTTOM.atoms, FALLBACK)
    for (let n = BOTTOM.atoms + 1; n <= TOP.atoms; n++) {
      const v = briefMinFor(n, FALLBACK)
      assert.ok(v >= prev, 'n=' + n + ' 处掉头：' + prev + ' → ' + v)
      prev = v
    }
  })

  it('插值值落在两个相邻锚点之间', () => {
    for (let i = 1; i < TIER_SCALE_ANCHORS.length; i++) {
      const lo = TIER_SCALE_ANCHORS[i - 1]
      const hi = TIER_SCALE_ANCHORS[i]
      for (const n of [lo.atoms + 1, Math.round((lo.atoms + hi.atoms) / 2), hi.atoms - 1]) {
        if (n <= lo.atoms || n >= hi.atoms) continue
        const v = briefMinFor(n, FALLBACK)
        assert.ok(v >= lo.briefMin && v <= hi.briefMin, 'n=' + n + ' 插值越界：' + v)
      }
    }
  })

  it('任何规模下都落在旧默认值与完整档的线之间（重标不会越过两条线）', () => {
    for (let n = 1; n <= 20000; n = Math.ceil(n * 1.17)) {
      const v = briefMinFor(n, FALLBACK)
      assert.ok(v >= FALLBACK, 'n=' + n + ' 低于默认值：' + v)
      assert.ok(v < TIER_FULL_MIN, 'n=' + n + ' 越过完整档的线：' + v)
    }
    assert.ok(briefMinFor(1e9, FALLBACK) < TIER_FULL_MIN)
  })

  it('规模不是有效条数时退回默认值', () => {
    for (const n of [NaN, Infinity, -1]) assert.equal(briefMinFor(n, FALLBACK), FALLBACK)
  })

  it('下界是闭区间：等于线本身走精简档，低一点点走摘录档', () => {
    const b = briefMinFor(TOP.atoms, FALLBACK)
    assert.equal(tierOf(b, b), 'brief')
    assert.equal(tierOf(b - 0.001, b), 'excerpt')
  })
})

describe('重标定改变档位的具体情形', () => {
  const b1374 = briefMinFor(1374, FALLBACK)
  const b48 = briefMinFor(48, FALLBACK)

  // 1374 条基准库、生产 recall 口径的实测 top1（见实现报告的对照表）。
  it('无关查询「马拉松训练计划怎么安排」（top1 0.5137）从精简档落到摘录档', () => {
    assert.equal(tierOf(0.5137, FALLBACK), 'brief')
    assert.equal(tierOf(0.5137, b1374), 'excerpt')
  })

  it('同一句在 48 条的小库上仍是精简档 —— 线随规模走，不是一刀切降低', () => {
    assert.equal(tierOf(0.5137, b48), 'brief')
  })

  it('该库最低的那条相关查询（top1 0.5253）没有被新线伤到', () => {
    assert.notEqual(tierOf(0.5253, b1374), 'excerpt')
  })

  it('技术外衣、库中无对应记忆的查询，新旧都拦不住 —— 这是本次方案的边界，不是退化', () => {
    // 「怎么用 C++ 实现一个红黑树」top1 实测 0.5754
    assert.equal(tierOf(0.5754, FALLBACK), 'full')
    assert.equal(tierOf(0.5754, b1374), 'full')
  })

  it('完整档的线不参与重标（本次只动一条线）', () => {
    assert.equal(TIER_FULL_MIN, 0.55)
    assert.equal(tierOf(0.55, b1374), 'full')
    assert.equal(tierOf(0.5499, b1374), 'brief')
  })
})

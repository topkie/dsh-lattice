// 档位阈值的按库规模重标定（M3-T23-b）。
//
// **要治的病**：`view.ts` 的两条档位线（0.55 / 0.45）是绝对余弦阈值，标定在一份 279 条
// 基准库上 —— 那里相关 top1 的下界是 0.524、无关 top1 的上界是 0.398，空隙 [0.398, 0.524]，
// 0.45 落在空隙中部，所以「低于它就提示可能不相关」这条提示按设计会触发。
// 库长大后这个前提没了：无关查询的 top1 上界随库单调上移（本次实测 0.460 @12 条 →
// 0.515 @1374 条），0.45 于是落进**无关分布内部** —— 提示线再也分不开两类，
// 而且它是静默失效：输出照旧，只是那句话永远不出现。
//
// **形式**：绝对阈值的形式保持不变（仍是一条余弦线），只把「精简档下界」从常数改成
// 库规模的函数。取值来自下面那张**实测锚点表**，按库规模在 log2 尺度上线性插值，两端夹紧。
// 完整档下界（0.55）不参与重标，理由见本文件末「为什么只动一条线」。
//
// **为什么不是「运行时扫一遍库、算出分位数再定线」**（这条路的实测依据）：
//   ① 可算的量与要定的线之间没有稳定关系。库内几何量 S（＝采样若干条 atom 当伪查询、
//      各自在库内的 top1 余弦，取中位数）在本次 8 个规模点上从 0.708 单调涨到 0.819，
//      而同步实测的最优分界线只从 0.466 涨到 0.525；两段斜率差 5 倍（小库段 0.92、
//      大库段 0.19），线性映射的残差最大 0.028 —— 与「直接按规模插值」的误差同量级。
//   ② S 在基准库上几乎就是规模的单调代理（8 个点无反转），扫描买不到额外信息。
//   ③ 代价是实打实的：全对余弦在 1374 条上 923 ms（朴素三层循环；分块实现 422 ms）、
//      采样 256 条伪查询 × 全库 140 ms，且 O(m·k) 时间与 O(k·d) 内存随库线性增长；
//      查表是 O(log n)、零 I/O、零状态。
//   结论：不扫描。库内几何量这条路在 T23-b 的前置实验里已经全线失败（R1~R4 四个候选
//   的相关率都是 0%），本次又量到它与目标线的关系不稳定，两条证据指向同一个处置。
//
// **降级**：库小于锚点表下端（12 条）时退回旧值；大于上端（1374 条）时取上端值夹紧，
// 不外推 —— 比基准库更大的库本次没有测量，按项目约定「查不到就留空」，不编一条外推曲线。
//
// **本模块的可标定性**：T23-b 降采样实验的结论是「档位与提示阈值稳定所需的最小 atom 数
// ＝192」。比它更小的库上，插值仍然给得出一个数，但那个数不可信 —— 调用方若要区分
// 「标定值」与「插值值」，用 TIER_SCALE_STABLE_ATOMS 比对即可。

import type { DatabaseSync } from 'node:sqlite'

/** 锚点表下端：比它更小的库本次没有测量，退回旧值。 */
export const TIER_SCALE_MIN_ATOMS = 12

/** 阈值稳定所需的最小 atom 数（T23-b 降采样实验的结论）。低于它时插值值不可信。 */
export const TIER_SCALE_STABLE_ATOMS = 192

/**
 * 实测锚点：库规模 → 「相关 vs 无关」的二分类最优分界线。
 *
 * 标定库：基准库 1374 条 atom。查询集：20 条 gold（各带目标记忆）+ 20 条人工无关查询。
 * 口径：每个规模点 30 次独立降采样重复，把 30 次的相关样本与无关样本各自合成一个池，
 * 在池上扫出使「相关通过率 − 无关通过率」最大的切点（通过条件为 `top1 >= 切点`）。
 * 逐点读数与判据见开发笔记《T23-b-重标定-实现报告》。
 *
 * 这张表**不是**对 8 个点的曲线拟合，而是把每个点上实测到的那个切点原样登记；
 * 点与点之间的插值是「规模是连续量」这一事实的近似，不是一条被拟合出来的规律。
 */
export const TIER_SCALE_ANCHORS: readonly { atoms: number; briefMin: number }[] = [
  { atoms: 12, briefMin: 0.466 },
  { atoms: 24, briefMin: 0.47 },
  { atoms: 48, briefMin: 0.492 },
  { atoms: 96, briefMin: 0.514 },
  { atoms: 192, briefMin: 0.514 },
  { atoms: 384, briefMin: 0.514 },
  { atoms: 768, briefMin: 0.514 },
  { atoms: 1374, briefMin: 0.525 },
]

/**
 * 按库规模给出「精简档下界」。
 *
 * @param atoms 库内 atom 条数。
 * @param fallback 库小于锚点表下端、无法标定时的取值（调用方传旧值 0.45）。
 */
export function briefMinFor(atoms: number, fallback: number): number {
  const n = Number.isFinite(atoms) ? Math.floor(atoms) : 0
  if (n < TIER_SCALE_MIN_ATOMS) return fallback
  const last = TIER_SCALE_ANCHORS[TIER_SCALE_ANCHORS.length - 1]
  if (n >= last.atoms) return last.briefMin
  for (let i = 1; i < TIER_SCALE_ANCHORS.length; i++) {
    const hi = TIER_SCALE_ANCHORS[i]
    if (n > hi.atoms) continue
    const lo = TIER_SCALE_ANCHORS[i - 1]
    const x0 = Math.log2(lo.atoms)
    const x1 = Math.log2(hi.atoms)
    const t = (Math.log2(n) - x0) / (x1 - x0)
    return lo.briefMin + (hi.briefMin - lo.briefMin) * t
  }
  return last.briefMin
}

/**
 * 按库现状给出「精简档下界」。
 *
 * 规模用 atom 总条数，不区分有没有向量：阈值是余弦尺度上的量，但「库有多大」这件事
 * 由全部条目决定；缺向量的条目在召回时本来就不产生余弦，把两者混在一起估规模只会更糊。
 */
export function briefMinForDb(db: DatabaseSync, fallback: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM atom').get() as { n: number | bigint }
  return briefMinFor(Number(row.n), fallback)
}

// ── 为什么只动一条线 ─────────────────────────────────────────
//
// 完整档下界（0.55）保持不动，不是漏改：
//   ① 它在本次实测的 1374 库上**仍然有效** —— 无关查询的 top1 最大值是 0.537，压在 0.55
//      之下；20 条相关查询里只有 1 条（0.525）低于它。两件事同时成立，说明这条线不用动。
//   ② 它在数据上**不可辨识**。以「相关进完整档的比例 − 无关进完整档的比例」为目标扫这条线，
//      在 1374 库上 [0.525, 0.581] 这一整段是平的（都等于 0.95）—— 段内任何取值都同样好，
//      段外任一侧都更差。没有哪一种取法能被数据支持，也就没有「重标」可言。
//   ③ 另一个候选是「跟着精简档一起平移」，但那会把两条线的间距压到 0.025（12 条库上），
//      三档退化成两档 —— 间距是设计选择，不该被一条没有依据的平移顺手改掉。
//   综上：只重标有实测支撑的那一条线，另一条保持旧值并如实记下「不可辨识」。

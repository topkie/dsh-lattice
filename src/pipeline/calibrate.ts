// 档位阈值按库规模重标定 —— 锚点表已归独立包 lattice-calib（T46）。
//
// 本文件只做转发：数据（8 个实测锚点、下限 12 条、稳定下限 192 条）只有一份，在
// `lattice-calib` 的 `src/anchors.ts`。插件侧保留这一层是为了两件事：
//   ① 依赖方向仍然 `tools → pipeline`，本项目自研的子包只出现在 pipeline 这一层；
//   ② 既有 import 点（view.ts、thresholds.ts、测试）不必因为拆包而改路径。
//
// 为什么是「查表插值」而不是「运行时扫库算分位」、以及「为什么只动一条线」
// （完整档 0.55 在 1374 库上不可辨识），理由随数据一起搬到了 `lattice-calib` 的 README
// 与开发笔记《T23-b-重标定-实现报告》。这里不再复述 —— 复制一份注释就是复制一个真相源，
// 而这次拆包要治的正是「同一份东西两处登记」。

export {
  TIER_SCALE_ANCHORS,
  TIER_SCALE_MIN_ATOMS,
  TIER_SCALE_STABLE_ATOMS,
  briefMinFor,
  briefMinForDb,
} from 'lattice-calib'
export type { TierScaleAnchor } from 'lattice-calib'

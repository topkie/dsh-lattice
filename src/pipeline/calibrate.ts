// 档位阈值按库规模重标定 —— 锚点表已归独立包 lattice-calib。
//
// 本文件只做转发：数据（8 个实测锚点、下限 12 条、稳定下限 192 条）只有一份，在
// `lattice-calib` 的 `src/anchors.ts`。插件侧保留这一层是为了三件事：
//   ① 依赖方向仍然 `tools → pipeline`，本项目自研的子包只出现在 pipeline 这一层；
//   ② 既有 import 点（view.ts、thresholds.ts、测试）不必因为拆包而改路径；
//   ③ **它是 calib 进入插件的唯一出口**：运行时层（state.ts 的快照读取与重标触发）与
//      标定层（calibration/trigger.ts 的稳定下限）原先各自直接 `import from 'lattice-calib'`，
//      与 ① 说的口径不符 —— 那时 calib 一改导出形状，要改的地方散在三层。现在都从这里取；
//      测试仍直连（它们验的是「插件能不能读懂 calib 写的快照」，直连是被测对象的一部分）。
//
// 为什么是「查表插值」而不是「运行时扫库算分位」、以及「为什么只动一条线」
// （完整档 0.55 在 1374 库上不可辨识），理由随数据一起搬到了 `lattice-calib` 的 README
// 与重标定实现记录。这里不再复述 —— 复制一份注释就是复制一个真相源，
// 而这次拆包要治的正是「同一份东西两处登记」。

export {
  CALIB_VERSION,
  TIER_SCALE_ANCHORS,
  TIER_SCALE_MIN_ATOMS,
  TIER_SCALE_STABLE_ATOMS,
  briefMinFor,
  briefMinForDb,
  calibrate,
  readSnapshotState,
  recalibrateAndWrite,
} from 'lattice-calib'
export type { CalibParams, TierScaleAnchor } from 'lattice-calib'

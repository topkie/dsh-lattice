// 写入侧的重标触发（判据 3/5/7/8）。
//
// 这里只放**纯判定**：四道闸怎么判、样本怎么分层取。副作用（算 S、写快照、替换参数、记日志）
// 放在 state.ts 里 —— 判定要能单测，副作用要能一处看全。
//
// 四道闸的取值：写入侧触发、S 漂移或样本集变化、冷却期过；参数整体替换、
// 不新增监听；冷却 12h、计数阈值 10、漂移 0.01。

import { TIER_SCALE_STABLE_ATOMS } from '../pipeline/calibrate.js'
import type { ThresholdValue } from '../threshold-types.js'
import { SAMPLE_MAX_ROWS } from '../samples/store.js'

/** 冷却期：12 小时。按「一次写作会话」量级取的，不是标定值。 */
export const RECALIBRATE_COOLDOWN_MS = (12 * 3600 * 1000) satisfies ThresholdValue<
  'chosen',
  {
    area: '校准样本'
    why: '无测量依据，是产品口味：12 小时对应「一次写作会话」量级；没有任何测量能回答「12 小时比 6 小时更合适」'
    failsWhen: ['用户的写作节奏', '库的变化速率']
    affects: '冷却：距上次判 S 不足 12 小时就不判、也不重标（省一次伪查询抽样）'
    display: '{v} 小时'
    unit: 'h'
  }
>

/** 重标所需的最小库规模：沿用锚点表的稳定下限 192（实测）。 */
export const RECALIBRATE_MIN_ATOMS = TIER_SCALE_STABLE_ATOMS

/** 正样本条数阈值。低于它切点会被单条样本牵着走。 */
export const RECALIBRATE_MIN_POSITIVE = 10 satisfies ThresholdValue<
  'chosen',
  {
    area: '校准样本'
    why: '未标定：与写入节奏匹配的经验数，没有测量能给出「少于几条算不够」'
    failsWhen: ['用户/模型的标注频率']
    affects: '闸④：正样本少于 10 条不重标（切点会被单条样本牵着走）'
  }
>

/** S 漂移阈值：192 维下噪声 sd 约 0.0063，0.01 约 1.6σ。 */
export const RECALIBRATE_DRIFT = 0.01 satisfies ThresholdValue<
  'recheckable',
  {
    area: '校准样本'
    tool: '无脚本（U9 噪声实测）'
    finding: '192 维下 S 的 sd 约 0.0063，0.01 约 1.6σ —— 小于它的漂移分不清是库变了还是抽样噪声；「1.6σ」这个系数是取舍，不是测量'
    failsWhen: ['采样伪查询条数 m', '库规模']
    affects: '闸②：S 与快照基准的差 ≤ 0.01 时不重标（噪声内不动）'
    display: '{v}（约 1.6σ@192 维）'
  }
>

/** 一次重标最多取多少条样本：样本库容量上限的五分之一（分层取样的上限，不是容量本身）。 */
export const RECALIBRATE_SAMPLE_LIMIT = (SAMPLE_MAX_ROWS / 5) satisfies ThresholdValue<
  'recheckable',
  {
    area: '校准样本'
    tool: '源码表达式（src/calibration/trigger.ts 的 `SAMPLE_MAX_ROWS / 5`）'
    finding: '由 SAMPLE_MAX_ROWS ÷ 5 算出 2000；改 SAMPLE_MAX_ROWS 后重新构建，派生值跟着变，不需要测量。「五分之一」这个比例是选择：切点只由靠近阈值的样本决定，多取无信息'
    formula: true
    failsWhen: ['样本库容量', '阈值附近的样本密度']
    affects: '一次重标最多取多少条样本（分层取样的上限，不是样本库容量）'
  }
>

/** 明显无关样本在一次重标里最多取多少条（不确定带全取，这一档只取最近 N 条）。 */
export const RECALIBRATE_OBVIOUS_LIMIT = 500 satisfies ThresholdValue<
  'chosen',
  {
    area: '校准样本'
    why: '未标定：该档的信息量在「它们离得很远」，多取只是重复同一件事；500 是按这一档信息量低给出的取舍，不确定带全取'
    failsWhen: ['库规模', '负样本的 top1 分布']
    affects: '「明显无关」那一档在一次重标里最多取多少条（不确定带全取）'
  }
>

export type GateReason = 'small_db' | 'no_positive' | 'no_negative' | 'cooldown' | 'no_drift'

export interface GateInput {
  /** 库内 atom 条数。 */
  atoms: number
  /** 样本库里的正样本条数。 */
  positives: number
  /**
   * 样本库里的负样本条数。
   *
   * **必须有这一道**：切点扫描要「相关通过率 − 无关通过率」，只有正侧算不出切点 ——
   * lattice-calib 会抛 E_NO_NEGATIVE_SAMPLES。那不是「重标失败」，是条件没到，
   * 所以在这里拦下（跳过），而不是让它抛出来记一条失败日志。
   */
  negatives: number
  /** 现在（epoch 毫秒）。 */
  now: number
  /** 上次判 S 的时间；从未判过为 null。 */
  lastCheckAt: number | null
  /** 快照记的基准 S；没有快照为 null。 */
  sBaseline: number | null
  /** 本次算出来的 S。 */
  currentS: number
}

export interface GateResult {
  ok: boolean
  /** 不通过时说明是哪道闸 —— 只进日志与调试，不打扰用户。 */
  reason?: GateReason
}

/**
 * 四道闸。**顺序是有代价的**：库小与无样本放在最前，因为它们不需要算 S；
 * 冷却放在算 S 之前（否则每次写入都要花一次抽样）；漂移最后判。
 */
export function evaluateGates(input: GateInput): GateResult {
  if (input.atoms < RECALIBRATE_MIN_ATOMS) return { ok: false, reason: 'small_db' }
  if (input.positives < RECALIBRATE_MIN_POSITIVE) return { ok: false, reason: 'no_positive' }
  if (input.negatives <= 0) return { ok: false, reason: 'no_negative' }
  if (input.lastCheckAt !== null && input.now - input.lastCheckAt < RECALIBRATE_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown' }
  }
  // 没有基准 S（从未标定过）时，第一次算出来的 S 就是基准 —— 不算漂移。
  // 否则「刚装上」的库会在第一条写入后立刻重标，而那正是没有样本可用的时刻。
  if (input.sBaseline !== null && Math.abs(input.currentS - input.sBaseline) <= RECALIBRATE_DRIFT) {
    return { ok: false, reason: 'no_drift' }
  }
  return { ok: true }
}

export interface SampleLike {
  kind: 'positive' | 'negative'
  source: string
  top1: number
  vec: Float32Array | null
  encoderModel: string
}

/**
 * 分层取样：滑点只由阈值附近的样本决定。
 *
 * - 正样本**全取**：它们是切点唯一的分母，取少了下界不稳；
 * - 负样本分两档：0.4~0.6 的「不确定带」全取；明显无关（<0.4）只取最近 N 条 ——
 *   这一档的信息量在「它们离得很远」，多取一条只是重复同一件事。
 */
export function pickCalibrationSamples(rows: readonly SampleLike[]): SampleLike[] {
  const positives: SampleLike[] = []
  const uncertain: SampleLike[] = []
  const obvious: SampleLike[] = []
  for (const r of rows) {
    if (r.kind === 'positive') positives.push(r)
    else if (r.top1 >= 0.4 && r.top1 <= 0.6) uncertain.push(r)
    else if (r.top1 < 0.4) obvious.push(r)
    // top1 > 0.6 的负样本不进样本库（纯度规则已在收集侧挡掉），这里不重复判。
  }
  return positives.concat(uncertain, obvious.slice(0, RECALIBRATE_OBVIOUS_LIMIT))
}

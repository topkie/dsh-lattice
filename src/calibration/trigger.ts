// 写入侧的重标触发（M4-T44 判据 3/5/7/8）。
//
// 这里只放**纯判定**：四道闸怎么判、样本怎么分层取。副作用（算 S、写快照、替换参数、记日志）
// 放在 state.ts 里 —— 判定要能单测，副作用要能一处看全。
//
// 四道闸的出处：裁决 #16（写入侧触发、S 漂移或样本集变化、冷却期过）、
// #17（参数整体替换、不新增监听）、#35（冷却 12h、计数阈值 10、漂移 0.01）。

import { TIER_SCALE_STABLE_ATOMS } from 'lattice-calib'

/** 冷却期：12 小时（裁决 #35）。按「一次写作会话」量级取的，不是标定值。 */
export const RECALIBRATE_COOLDOWN_MS = 12 * 3600 * 1000

/** 重标所需的最小库规模：沿用锚点表的稳定下限 192（T23-b 实测）。 */
export const RECALIBRATE_MIN_ATOMS = TIER_SCALE_STABLE_ATOMS

/** 正样本条数阈值（裁决 #35）。低于它切点会被单条样本牵着走。 */
export const RECALIBRATE_MIN_POSITIVE = 10

/** S 漂移阈值（裁决 #35）：192 维下噪声 sd 约 0.0063，0.01 约 1.6σ。 */
export const RECALIBRATE_DRIFT = 0.01

/** 一次重标最多取多少条样本（分层取样的上限，不是样本库容量）。 */
export const RECALIBRATE_SAMPLE_LIMIT = 2000

/** 明显无关样本在一次重标里最多取多少条（不确定带全取，这一档只取最近 N 条）。 */
export const RECALIBRATE_OBVIOUS_LIMIT = 500

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
 * 分层取样（裁决 #34 ⑧）：滑点只由阈值附近的样本决定。
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

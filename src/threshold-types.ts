// 阈值来历的类型载体。
//
// 为什么放在类型层：值是 number，运行时挂不住元数据；写成 `0.78 satisfies ThresholdValue<…>`
// 之后，来历与值在同一处，扫描器用语法树就能读出来，运行时零成本、也不改变使用点。
//
// 字段白名单由 scripts/print-thresholds.mjs 的 thresholdOriginProblems() 断言 ——
// 第二个类型参数 T 不受约束，写错字段名不会编译报错，只能在那里抓。
//
// 这个文件只有类型，编译后不产生任何 JavaScript。

/** 显示单位：打印时怎么把值换算成可读形式。没有单位则按 note 原样显示。 */
export type ThresholdUnit = 'ms' | 'MB' | 'h' | 'x' | '%'

/**
 * 阈值值的类型标记。
 *
 * 第一个参数是来历的种类（`recheckable` 有测量可复算 / `chosen` 没有测量能给出它），
 * 第二个参数是来历的字段（measured / decided / failsWhen / guardedBy / affects / diverges / unit / note）。
 *
 * 写法：
 *
 *   export const TAU_JOIN = 0.78 satisfies ThresholdValue<'recheckable', {
 *     measured: '同主题余弦 min 0.811 / 跨主题 max 0.633，两类完全分离'
 *     decided: '取 0.78，落在下界之下'
 *   }>
 */
export type ThresholdValue<K extends 'recheckable' | 'chosen', T> = number & {
  /** 只在类型层存在，值为 number。它让 K 与 T 被真正引用 —— 否则类型参数会被 lint 判成未使用。 */
  readonly __origin?: readonly [K, T]
}

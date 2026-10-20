// 判据 1 的类型用例（T54）：chosen 的第二参数是 string，传对象必须在编译期报错。
//
// 这个文件不在 tsconfig.json 的 include 里（那里只收 src/**），由
// test/thresholds.test.mjs 用 TypeScript 编译器 API 检查：诊断数为 0 才通过。
// 删掉下面那行 @ts-expect-error，诊断数变成 1，测试就红 —— 这就是判据本身。

import { chosen, recheckable } from '../src/thresholds.js'
import type { ThresholdCalibration } from '../src/thresholds.js'

// @ts-expect-error chosen 的签名里没有 tool：第二参数必须是 string
export const notAString = chosen(() => 42, { tool: 'x' })

// 正例：写法正确时编译通过（这里没有 @ts-expect-error，也不该有错误）
export const ok = recheckable(() => 42, { tool: '不算脚本', finding: '只是类型用例' })

// T54 迁移完成后删掉的两个过渡字段：再写回去必须编译报错，不能悄悄复活。
// @ts-expect-error evidence 已删除，来历写在 origin 里
export const withEvidence: ThresholdCalibration = { evidence: '旧的解释字段' }

// @ts-expect-error source 已删除，来源指针搬进了 origin 的 tool / finding / at
export const withSource: ThresholdCalibration = { source: 'calib@0.1.0' }

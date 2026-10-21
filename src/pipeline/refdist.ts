// 参考分布：判「这次召回有没有内容」的那条线从哪来。
//
// 为什么不在发布时给一个绝对值：同一批技术笔记、社会新闻、Vue 文档三个语料上，
// 「相关查询的 top1 余弦最低值」分别是 0.609 / 0.690 / 0.683，而「无关查询的
// top1 余弦最高值」是 0.508 / 0.539 / 0.491 —— 每个库都有自己的刻度，一个跨库的绝
// 对值在其中一个库上必然错。所以线在每个用户的库上现算一次。
//
// 用什么算：一组与用户内容无关的中文日常问句。拿它们在本库各取一次 top1 余弦，
// 它们的分布就是「一个与库无关的问题最高能拿到多少分」的零假设分布，取 p90 当线。
// 三种「造一个与库无关的东西」的路子都实测过并否掉了：随机向量落不到中文语料的共现
// 结构里（p90 只有 0.13，压在相关查询下面，判据永远说「有内容」）；库内拼接反而更高
// （拼出来的两段都在库语义空间中心附近，p90 到 0.88）；跨库借句子只在语料族不同时才
// 成立，三个中文技术语料互为近亲。见 devnotes 的 `最小实验-D.md`。
//
// 为什么 48 条：24 条时换一批问句，同一条线的越线率在 0%–25% 之间摆（设计意图 10%）；
// 两批合并到 48 条后越线率 5/48 = 10.4%，bootstrap 区间宽 0.031–0.049。加条数收益很快耗
// 尽 —— p90 由尾部两三个值决定。见 `最小实验-E.md`。
import type { DatabaseSync } from 'node:sqlite'
import type { ThresholdValue } from '../threshold-types.js'
import { top1Cosine } from './search.js'

/**
 * 内置问句集：与用户库的内容无关，随代码发布，是资源不是用户数据。
 *
 * 选句标准只有一条：一个人会真的这么问，且答案不在任何技术库里。所以它们是日常
 * 生活问题，不是技术问题。两批同风格不同内容（S1 / S2），合起来 48 条。
 */
export const REFERENCE_QUESTIONS: readonly string[] = [
  '今天中午吃什么',
  '明天天气怎么样',
  '推荐一部好看的电影',
  '这首曲子是谁写的',
  '明天北京的天气怎么样',
  '怎么做红烧肉才不腻',
  '推荐几部科幻电影',
  '这个字怎么读',
  '帮我写一首诗',
  '马拉松训练计划怎么安排',
  '冰箱冷藏室结冰了怎么办',
  '如何挑选一把吉他',
  '植物叶子发黄是什么原因',
  '怎样快速学会游泳',
  '世界杯什么时候开始',
  '哪种咖啡豆适合手冲',
  '怎么给孩子选绘本',
  '旧手机怎么处理',
  '空调不制冷了',
  '怎样养好多肉植物',
  '机票什么时候买便宜',
  '怎么练引体向上',
  '洗衣机有异味怎么清理',
  '旅行箱选多大尺寸',
  '今天晚上吃什么菜',
  '楼下超市有卖鸡蛋吗',
  '这个月的燃气费怎么交',
  '周末带孩子去哪里',
  '身份证丢了怎么补办',
  '高铁票能改签吗',
  '空调不制冷是怎么回事',
  '附近有修鞋的吗',
  '明天要下雨吗',
  '早饭吃什么比较快',
  '医院挂号怎么预约',
  '打车到火车站多少钱',
  '电视遥控器没反应',
  '小区物业电话多少',
  '洗衣机多久清洗一次',
  '冰箱保鲜室结冰怎么办',
  '驾照到期怎么换',
  '附近有药店吗',
  '牛奶过期两天还能喝吗',
  '周末商场几点关门',
  '水龙头滴水怎么修',
  '快递柜取件码没收到',
  '冬天被子买几斤的',
  '旅行要带什么东西',
]

/** 取哪个分位当线。p95 不能用：某语料上 S2 的 max 到 0.802，高于它自己的相关 p10（0.690），用 max 会误杀全部真内容。 */
export const REFERENCE_QUANTILE = 0.9 satisfies ThresholdValue<
  'recheckable',
  {
    area: '召回判定'
    tool: 'probes/b3-rewrite/scripts/exp-g.mjs（分位敏感性扫描）'
    finding: 'p85 / p90 / p95 三档对照：p90 在三库上 gold 漏判都是 0%、无关查询判空 83%–100%；p95 在技术笔记上漏判 5%；p85 在 Vue 上判空降到 79%'
    failsWhen: ['语料的内容分布（判空率随之变）', '内置问句集的主题（用户库本身讲日常生活时线被抬高）']
    scale: '三个语料各 1374 / 1346 / 1496 atom，20 条 gold + 24 条无关查询；线由 48 条内置问句算出'
    guardedBy: ['test/refdist.test.mjs']
    affects: '召回判定：top1 余弦高于本库参考分布的此分位即判「有内容」'
  }
>

/** 库比问句集还小时，参考分布本身估不准 —— 上限就是库里的 atom 数。 */
export const REFERENCE_MIN_ATOMS = REFERENCE_QUESTIONS.length

/** 线超过这个值时判据失效（与语料无关的上界，三库实测 0.484–0.571，宽库合并后仍 0.540–0.585）。 */
export const REFERENCE_MAX_LINE = 0.65 satisfies ThresholdValue<
  'chosen',
  {
    area: '召回判定'
    why: '0.65 是外推的失效线，没有一次实测触发：三库 p90 只有 0.484–0.571，三库合并 4216 atom 后仍只有 0.540–0.585。取它的理由是语义：一个与库无关的问题能拿到 0.65 以上，说明库里到处是通用中文，这时分位线分不开「有内容」与「没内容」'
    failsWhen: ['引入比现有更宽的语料（百科、全网新闻）', '用户库本身就是通用中文语料']
    guardedBy: ['test/refdist.test.mjs']
    affects: '召回判定：参考线超过此值时判据失效，回执改说「判定不稳」，不再按线判有没有内容'
  }
>

export interface ReferenceDistribution {
  /** 问句条数（实际参与计算的那批）。 */
  n: number
  /** 建这条线时的 atom 数。 */
  atoms: number
  p50: number
  p90: number
  max: number
  /** 这条线能不能用来判断。不能时调用方必须给出「判定不稳」的回执，而不是静默按线判。 */
  usable: boolean
  reason: 'ok' | 'no-encoder' | 'library-too-small' | 'line-too-high'
}

/** 线性插值分位。数组短，排序比算权重便宜，直接排。 */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN
  const a = values.slice().sort((x, y) => x - y)
  if (a.length === 1) return a[0]!
  const i = (a.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.min(a.length - 1, lo + 1)
  return a[lo]! + (a[hi]! - a[lo]!) * (i - lo)
}

// 一条连接算一次就够。库变了的判据与向量缓存同源：atom 行数变了就重算。
// 不在 meta 里落库：它是派生量，落库就又造了一个会漂的副本（见 T68 的教训）。
const CACHE = new WeakMap<DatabaseSync, { atoms: number; dist: ReferenceDistribution }>()

/** 编码一条文本成向量；编码器不可用时返回 null。 */
export type EncodeOne = (text: string) => Promise<Float32Array | null>

/**
 * 算或取本库的参考分布。
 *
 * 首次调用要编码 48 条问句（三库实测单条 20 ms，合计约 1 秒），之后按 atom 行数缓存。
 * 编码器不可用时返回 usable: false —— 纯词面召回没有余弦，判据无从谈起，调用方
 * 该退回「按相关度列出前几条」的措辞。
 */
export async function referenceFor(db: DatabaseSync, encode: EncodeOne): Promise<ReferenceDistribution> {
  const atoms = Number((db.prepare('SELECT COUNT(*) AS n FROM atom').get() as { n: number | bigint }).n)
  const hit = CACHE.get(db)
  if (hit !== undefined && hit.atoms === atoms) return hit.dist
  const scores: number[] = []
  for (const q of REFERENCE_QUESTIONS) {
    const v = await encode(q)
    if (v === null) {
      const dist: ReferenceDistribution = {
        n: 0,
        atoms,
        p50: 0,
        p90: 0,
        max: 0,
        usable: false,
        reason: 'no-encoder',
      }
      CACHE.set(db, { atoms, dist })
      return dist
    }
    scores.push(top1Cosine(db, v))
  }
  const p90 = quantile(scores, REFERENCE_QUANTILE)
  let usable = true
  let reason: ReferenceDistribution['reason'] = 'ok'
  if (atoms < REFERENCE_MIN_ATOMS) {
    usable = false
    reason = 'library-too-small'
  } else if (p90 > REFERENCE_MAX_LINE) {
    usable = false
    reason = 'line-too-high'
  }
  const dist: ReferenceDistribution = {
    n: scores.length,
    atoms,
    p50: quantile(scores, 0.5),
    p90,
    max: Math.max(...scores),
    usable,
    reason,
  }
  CACHE.set(db, { atoms, dist })
  return dist
}

export function invalidateReference(db: DatabaseSync): void {
  CACHE.delete(db)
}

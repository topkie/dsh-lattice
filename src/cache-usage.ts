// 五处模块级缓存的**实时占用**（M5-T60），只读，供 `lattice_ping` 报出。
//
// 本轮的边界是「让占用可见」，**不是**给缓存加容量上限或淘汰策略：要先有实测的
// 「现在占多少、在什么规模下变大」，才谈得上「多大算大」。没有读数就调容量，调的
// 是猜出来的阈值。
//
// 三条实现约束，都是判据的一部分：
//   1. **实时读**：每次调用现读缓存本体，不做「启动时算一次」的快照 —— 快照会报
//      第一次调用时的数，之后写多少条都不变，属于「看起来在工作」的那类失效。
//   2. **不触发重建**：这里只读各缓存的容器与已算好的字段，不调用任何 build / load /
//      snapshot 函数。ping 是健康检查，不能因为看一眼占用而付一次全表扫描的代价。
//   3. **不碰库**：没有任何 SQL。缓存里有什么就报什么；「缓存与库是否一致」由下一次
//      真正使用缓存的那条路径回答（各缓存自己的失效探测），不在这里顺手校验。
//
// 为什么读数函数放在各缓存**自己所在的模块**里、这里只做汇总：缓存是模块私有的，
// 整个导出会让人能改它；导出一个「算一算多大」的函数，写权限留在原地。

import type { DatabaseSync } from 'node:sqlite'
import { oldTopicCacheUsage } from './cluster/rebuild.js'
import { encoderCacheUsage, type EncoderState } from './encoder/index.js'
import { readVocabCacheUsage } from './pipeline/entries.js'
import { vecCacheUsage } from './pipeline/search.js'
import { topicLexCacheUsage } from './pipeline/write.js'

/**
 * 一处缓存的占用读数。各字段的口径见 CacheUsage 里对应那一项。
 */
export interface CacheUsage {
  /** 向量缓存（pipeline/search.ts）：每个 atom 一份归一化向量。 */
  vec: { unit: 'atom'; cached: boolean; entries: number }
  /** topic 词面指纹缓存（pipeline/write.ts）：每个 topic 一份 bigram 集合。 */
  topicLex: { unit: 'topic'; cached: boolean; entries: number; terms: number }
  /** 查询侧词表缓存（pipeline/entries.ts）：每个连接一份 bigram → 统计的索引。 */
  readVocab: { unit: 'term'; cached: boolean; entries: number }
  /** 重聚类前的归属快照（cluster/rebuild.ts）：模块级，不按连接分。 */
  oldTopic: { unit: 'atom'; entries: number }
  /** 编码器本体（encoder/index.ts）：没有条目数，只报加载状态。 */
  encoder: { loaded: boolean; state: EncoderState; model: string | null }
}

/**
 * 读当前进程里五处缓存的占用。
 *
 * `db` 是运行时的主库连接：前三处缓存按连接分（WeakMap），要读的正是这次 ping
 * 会用到的那一条连接上的那几份，换一条连接读到的会是另一份。
 */
export function cacheUsage(db: DatabaseSync): CacheUsage {
  return {
    vec: { unit: 'atom', ...vecCacheUsage(db) },
    topicLex: { unit: 'topic', ...topicLexCacheUsage(db) },
    readVocab: { unit: 'term', ...readVocabCacheUsage(db) },
    oldTopic: { unit: 'atom', ...oldTopicCacheUsage() },
    encoder: encoderCacheUsage(),
  }
}

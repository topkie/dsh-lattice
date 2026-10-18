#!/usr/bin/env node
// 行为检查：topic 层的合并判据还有没有效（U2 结案，裁决 #23）。
//
// 为什么必须有这条检查：结构比例（单成员 topic 占比、atom/topic 比）随领域混合度变化，
// 三个历史值（0.912 / 0.59 / 0.695）互相矛盾，不能拿来当判据（见 pipeline/audit.ts）。
// 能判的是**行为**：同领域、语义相近的几条写入，有没有被合并到同一个 topic。这里的做法是
// 在**临时库**里构造七条、分属四个领域，同领域 ≥2 条并入同一 topic 为健康，七条各自成
// topic 为失效。
//
// 三条硬约束（T35 判据 6）：
//   1. **只跑临时库**：临时目录由 mkdtemp 现造，跑完删掉；不读也不写用户库。
//   2. **不进 audit**：体检只读，不构造写入；两者是不同性质的动作。
//   3. **不进门禁常规路径**：它要造库、写七条，属于「手动跑一次」的验证脚本；
//      与 verify-*.mjs 同一类（不进 check-all）。
//
// 编码器用构造向量，不加载模型：这条检查测的是**落位判据**（余弦 + 词面两票），
// 不是编码质量。构造向量让「同领域余弦高、跨领域余弦低」成为已知量，失败时能直接
// 指向 tauJoin / tauLex，而不是先怀疑模型。
//
// 用法：
//   node scripts/probe-topic-health.mjs
//   node scripts/probe-topic-health.mjs --tau-join 0.99   # 构造失败：强制不合并 → 判失效
//   node scripts/probe-topic-health.mjs --tau-join 0.5    # 构造失败：强制误并 → 判失效
//   node scripts/probe-topic-health.mjs --json
// 退出码：0 = 健康；1 = 失效（含构造失败）；2 = 参数错误。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { DEFAULT_THRESHOLDS, createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { VEC_DIM } from '../dist/util/vec.js'

/** 七条写入：四个领域，同领域两条（D 只有一条）。 */
const ITEMS = [
  {
    domain: 'A',
    key: '写入锁',
    text: '本地记忆库写入时要在事务之外完成落位判断，避免长时间持有写锁。',
  },
  {
    domain: 'A',
    key: '写入锁',
    text: '本地记忆库的写入路径应把落位判断放在事务之外，不要长时间持有写锁。',
  },
  {
    domain: 'B',
    key: '图路状态',
    text: '本地记忆库召回时要报告图路状态，图路为空不能静默当成没有命中。',
  },
  {
    domain: 'B',
    key: '图路状态',
    text: '本地记忆库的召回路径要记录图路状态，图路为空时不要静默当成零命中。',
  },
  {
    domain: 'C',
    key: '入口索引',
    text: '本地记忆库的入口索引要给两字中文留 bigram 兜底，否则查询命中不了。',
  },
  {
    domain: 'C',
    key: '入口索引',
    text: '本地记忆库的词面索引要用 bigram 兜底两字中文查询，不然命中不到。',
  },
  {
    domain: 'D',
    key: '删除入口',
    text: '本地记忆库的删除动作只能由用户在界面上发起，模型只能提议。',
  },
]

/**
 * 跨领域余弦的目标值。
 *
 * 取 0.62 是为了让两个构造失败都能被抓住：
 *   · 默认 tauJoin = 0.78 时它低于并入线 → 不该合并的不会合并；
 *   · 把 tauJoin 调到 0.5 时它高于并入线 → 跨领域会误并（词面也共享「本地记忆库」）；
 *   · 同领域余弦约 0.978：默认线下去并，0.99 时拒并 → 分裂。
 */
const CROSS_COS = 0.62
const AXIS_OF = { A: 1, B: 2, C: 3, D: 4 }

/** 确定性伪随机：同一份脚本每次跑出同样的向量，失败可复现。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = mulberry32(20261018)

/** 领域基向量：与公共轴 0 的余弦为 CROSS_COS。 */
function baseOf(domain) {
  const v = new Float32Array(VEC_DIM)
  v[0] = Math.sqrt(CROSS_COS)
  v[AXIS_OF[domain]] = Math.sqrt(1 - CROSS_COS)
  return v
}

/**
 * 同领域两条：基向量加一点确定性扰动，余弦约 0.978（低于 0.99、高于 0.78）。
 *
 * 扰动按分量取 ±1 时必须除以 sqrt(DIM/3)：那个随机向量的模长约 sqrt(DIM/3)，
 * 不除的话 512 维下噪声比基向量大一个量级，同领域余弦会掉到 0.21 —— 第一版就是
 * 这么写的，探针当场把「同领域没合并」判成了失效。
 */
function itemVector(domain) {
  const v = baseOf(domain)
  const eps = 0.15 / Math.sqrt(VEC_DIM / 3)
  for (let i = 0; i < VEC_DIM; i++) v[i] += eps * (rng() * 2 - 1)
  return v
}

/** 参数：--tau-join <n> / --tau-lex <n> / --json。 */
function readNum(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i < 0) return fallback
  const v = Number(process.argv[i + 1])
  if (!Number.isFinite(v)) {
    console.error('参数 ' + name + ' 需要一个数字')
    process.exit(2)
  }
  return v
}

const tauJoin = readNum('--tau-join', DEFAULT_THRESHOLDS.tauJoin)
const tauLex = readNum('--tau-lex', DEFAULT_THRESHOLDS.tauLex)
const asJson = process.argv.includes('--json')

const dir = mkdtempSync(join(tmpdir(), 'lattice-topic-health-'))
const file = join(dir, 'lattice.db')
const { db } = openVault(file)

try {
  // 写入顺序固定：先 A 的两条，让「同领域合并」先发生，跨领域误并才有对象。
  const vectors = new Map(ITEMS.map((it) => [it.text, itemVector(it.domain)]))
  const ctx = createWriteCtx(db, { tauJoin, tauLex }, { encode: async (text) => vectors.get(text) ?? null })

  const placed = []
  for (const it of ITEMS) {
    const r = await writeAtom(ctx, { text: it.text, kind: '结论', scope: 'global' })
    placed.push({
      domain: it.domain,
      key: it.key,
      text: it.text,
      atomId: r.atomId,
      topicId: r.topicId,
      action: r.action,
      sim1: r.evidence?.sim1 ?? null,
      lex1: r.evidence?.lex1 ?? null,
    })
  }

  // 逐领域合并情况。
  const domains = [...new Set(ITEMS.map((it) => it.domain))]
  const domainReport = domains.map((d) => {
    const rows = placed.filter((p) => p.domain === d)
    const topics = [...new Set(rows.map((p) => p.topicId))]
    return {
      domain: d,
      count: rows.length,
      topics,
      merged: rows.length < 2 ? null : topics.length === 1,
      rows,
    }
  })

  // 跨领域同 topic：误并的证据。
  const topicDomains = new Map()
  for (const p of placed) {
    if (!topicDomains.has(p.topicId)) topicDomains.set(p.topicId, new Set())
    topicDomains.get(p.topicId).add(p.domain)
  }
  const mixedTopics = [...topicDomains.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([topicId, set]) => ({ topicId, domains: [...set].sort() }))

  const splits = domainReport.filter((d) => d.merged === false)
  const healthy = splits.length === 0 && mixedTopics.length === 0
  const reasons = []
  for (const d of splits) {
    reasons.push('领域 ' + d.domain + ' 的 ' + d.count + ' 条分散在 ' + d.topics.length + ' 个 topic')
  }
  for (const m of mixedTopics) {
    reasons.push('topic ' + m.topicId + ' 同时包含 ' + m.domains.join(' / ') + ' 领域（误并）')
  }

  const result = {
    verdict: healthy ? '健康' : '失效',
    tauJoin,
    tauLex,
    items: placed,
    domains: domainReport,
    mixedTopics,
    reasons,
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log('临时库：' + file)
    console.log('阈值：tauJoin=' + tauJoin + ' tauLex=' + tauLex)
    console.log('写入 ' + placed.length + ' 条（' + domains.length + ' 个领域）')
    console.log('')
    console.log('逐条落位：')
    for (const p of placed) {
      const sim = p.sim1 === null ? '-' : p.sim1.toFixed(3)
      const lex = p.lex1 === null ? '-' : p.lex1.toFixed(3)
      console.log(
        '  [' +
          p.domain +
          '] #' +
          p.atomId +
          ' → topic ' +
          p.topicId +
          ' (' +
          p.action +
          ')' +
          ' sim1=' +
          sim +
          ' lex1=' +
          lex +
          '  ' +
          p.text,
      )
    }
    console.log('')
    console.log('领域合并：')
    for (const d of domainReport) {
      const outcome =
        d.merged === null ? '单条，不要求合并' : d.merged ? '已合并（同一 topic）' : '未合并（分散）'
      console.log('  ' + d.domain + '（' + d.count + ' 条）: topic ' + d.topics.join(',') + ' —— ' + outcome)
    }
    console.log('')
    console.log('判决：' + result.verdict + (healthy ? '' : '（' + reasons.join('；') + '）'))
  }

  process.exitCode = healthy ? 0 : 1
} finally {
  try {
    db.close()
  } catch {
    /* 已关闭 */
  }
  rmSync(dir, { recursive: true, force: true })
}

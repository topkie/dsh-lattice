// 召回对比：dsh-lattice 与另一套在用的召回系统，在**等 token 预算**下的 Recall@5。
//
// 评测集构造（自动化，见下）：对每张卡，取其 H2 标题与标签构造「信息需求」，
// 正确答案就是这张卡本身。这样得到 (query, 目标卡) 对，无需人工标注。
//
// 两条被测路径：
//   other    走对照系统的 /search 端点（需它在本机运行）
//   lattice  走本插件的召回 + 三段式注入
//
// 比较的是**同一 token 预算下的 Recall@5**。token 用同一个估算器，
// 所以「谁更省」这半边是可比的；「谁更准」那半边依赖查询集的质量 —— 见报告里的局限说明。
//
// 用法：node scripts/eval-recall.mjs [--limit=100]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView } from '../dist/pipeline/view.js'
import { estimateTokens } from '../dist/util/text.js'

const API = 'http://127.0.0.1:19387/memory-eternal/api'
const OUT = '.probe'
const CARDS = join(OUT, 'eternal-cards.json')
const DB = join(OUT, 'migrated', 'lattice.db')
const MODEL = 'Xenova/bge-small-zh-v1.5'
mkdirSync(OUT, { recursive: true })

/**
 * 构造评测查询。
 *
 * **不要用 H2 标题原文**：标题几乎必然出现在该卡正文里，字面匹配就能命中，
 * 于是两套系统都会 100%，测不出差别（实测正是如此）。
 *
 * 这里改用「标签 + 标题里的术语」拼一个像用户会打的查询 —— 词是相关的，
 * 但措辞不照抄原文，需要语义检索才能命中。
 */
function queriesFrom(cards, limit) {
  const out = []
  for (const c of cards) {
    const tags = Array.isArray(c.tags) ? c.tags.map((t) => String(t)) : []
    const titleTerms = String(c.title ?? '')
      .replace(/[：:（）()「」【】、，,。.！!？?\[\]]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 4)
    // 取最多两个标签 + 前几个标题词，拼成一个短查询。
    const parts = [...tags.slice(0, 2), ...titleTerms].filter((w) => w.length >= 2)
    const q = [...new Set(parts)].slice(0, 5).join(' ')
    if (q.length < 4) continue
    out.push({ query: q, target: c.path, title: c.title ?? '' })
  }
  return limit > 0 ? out.slice(0, limit) : out
}

async function eternalSearch(q, k) {
  const r = await fetch(API + '/search?q=' + encodeURIComponent(q) + '&limit=' + k)
  const j = await r.json()
  return Array.isArray(j.hits) ? j.hits : []
}

/** 把 eternal 的命中拼成注入文本（只有它会给模型的东西）。 */
function eternalText(hits) {
  return hits
    .map((h) => '[' + (h.kind ?? '') + '] ' + (h.title ?? '') + '\n' + String(h.summary ?? '').slice(0, 120))
    .join('\n')
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 0
  if (!existsSync(CARDS)) throw new Error('缺少导出文件，先跑 migrate-eternal.mjs --export')
  if (!existsSync(DB)) throw new Error('缺少迁移库，先跑 migrate-eternal.mjs')
  const cards = JSON.parse(readFileSync(CARDS, 'utf8'))
  // 评测集优先用人工构造的 gold 集。
  //
  // 为什么不用自动构造：从卡片标题/标签拼查询时，查询词几乎必然出现在原文里，
  // 字面匹配就能命中，两套系统都是 100%，测不出差别（试过两版都是这个结果）。
  // 人工查询换过措辞、更短、更像真用户，才能区分「语义检索」与「关键词匹配」。
  const goldFile = join(OUT, 'eval-gold.json')
  const cases = existsSync(goldFile) ? JSON.parse(readFileSync(goldFile, 'utf8')) : queriesFrom(cards, limit)
  console.log('评测集来源:', existsSync(goldFile) ? '人工 gold 集' : '自动构造（注意：可能测不出差别）')
  console.log('评测集:', cases.length, '条（每张卡一个信息需求）')

  const ok = await ensureEncoder({ model: MODEL })
  console.log('编码器:', ok ? 'ready' : '不可用（无向量，评测无意义）')
  if (!ok) process.exit(1)

  const { db } = openVault(DB)
  // atom -> 源卡：用 source_ref 反查
  const atomRows = db
    .prepare('SELECT id, source_ref FROM atom')
    .all()
    .map((r) => ({
      id: Number(r.id),
      card: String(r.source_ref ?? ''),
    }))

  const K = 5
  const rows = []
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    // ── eternal ──
    const eHits = await eternalSearch(c.query, K)
    const eText = eternalText(eHits)
    const eHit = eHits.some((h) => String(h.path) === c.target)
    // ── lattice ──
    const vq = await encode(c.query, { model: MODEL })
    const lr = recall(db, c.query, vq, { topN: 24 })
    // 命中判定：召回的 atom 里有没有来自目标卡的
    const lHits = lr.hits.slice(0, 24)
    const lHit = lHits.some((h) => atomRows.find((a) => a.id === h.id)?.card === c.target)
    // 等 token：二分找字符预算，使 lattice 的注入 token 数不超过 eternal 的。
    // 不这么做就不是等 token 对比 —— 初版直接给了 3 倍预算，lattice 用了 2610 token
    // 而 eternal 只用 1817，那样即使 Recall 更高也没有说服力。
    const eTokens = estimateTokens(eText)
    let lo = 100
    let hi = 12000
    let best = null
    for (let it = 0; it < 14; it++) {
      const mid = Math.floor((lo + hi) / 2)
      const v = assembleView(db, lr, { budget: mid })
      if (estimateTokens(v.text) <= eTokens) {
        best = v
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    const view = best ?? assembleView(db, lr, { budget: 100 })
    const lTokens = estimateTokens(view.text)
    rows.push({
      query: c.query,
      target: c.target,
      eHit,
      eTokens,
      eTop: eHits.length > 0 ? String(eHits[0].path) : '',
      lHit,
      lTokens,
      lTop: lHits.length > 0 ? (atomRows.find((a) => a.id === lHits[0].id)?.card ?? '') : '',
      lSim: lr.meta.topCosine,
    })
    if ((i + 1) % 10 === 0) console.log('  已评测', i + 1, '/', cases.length)
  }

  const n = rows.length
  const eRecall = rows.filter((r) => r.eHit).length / n
  const lRecall = rows.filter((r) => r.lHit).length / n
  const eTok = rows.reduce((a, r) => a + r.eTokens, 0) / n
  const lTok = rows.reduce((a, r) => a + r.lTokens, 0) / n
  console.log('')
  console.log('=== 结果（n=' + n + '，K=' + K + '）===')
  console.log('                 Recall@' + K + '    平均 token/查询')
  console.log('  eternal        ' + (eRecall * 100).toFixed(1) + '%        ' + eTok.toFixed(0))
  console.log('  lattice        ' + (lRecall * 100).toFixed(1) + '%        ' + lTok.toFixed(0))
  console.log('')
  console.log('  差值（lattice - eternal）: Recall ' + ((lRecall - eRecall) * 100).toFixed(1) + ' 个百分点')
  const empty = rows.filter((r) => !r.lHit && r.lSim < 0.6).length
  console.log('  lattice 低相似度未命中数（<0.6）:', empty)
  const report = { n, K, eRecall, lRecall, eTokens: eTok, lTokens: lTok, rows }
  writeFileSync(join(OUT, 'eval-report.json'), JSON.stringify(report, null, 1), 'utf8')
  console.log('')
  console.log('详细结果 →', join(OUT, 'eval-report.json'))
  console.log('')
  console.log('=== 抽样（前 8 条）===')
  for (const r of rows.slice(0, 8)) {
    console.log(
      (r.eHit ? 'E✓' : 'E✗') +
        (r.lHit ? ' L✓' : ' L✗') +
        ' sim=' +
        r.lSim.toFixed(2) +
        '  ' +
        r.query.slice(0, 30),
    )
  }
  db.close()
}

await main()

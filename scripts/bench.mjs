// 公共基准子集与复跑装置。
//
// 为什么需要它：任何「这次改动没让召回变差」的说法，都需要一个**改动前就存在**的对照。
// 在此之前唯一的对照是 20 条内部 gold 集，而 thresholds.ts 里多处写着「端到端在 20 条 gold
// 上不可分辨」—— 一个分辨不出的装置比没有装置更危险。本脚本把「测什么、怎么算、噪声多大」
// 固定成一条可复跑的命令，并把区间与最小可分辨差**与指标一起输出**，让读者无法把噪声当改进。
//
// 三条硬边界：
//   1. **只接受本地路径**，脚本自身不联网：没有下载器、没有语料、没有 http/fetch ——
//      语料的获取与版本锁定是评测者的事，仓库里不出现语料（不 vendored）。
//   2. **只读打开库**：评测不改库。图路建边在只读连接上必然失败，那是允许的用法，
//      不让它变成一个安静的空结果（recall 的 meta 里会如实报状态，本脚本不转述，因为
//      那段状态文本可能带上库文件路径，而结果文件要进公开仓库）。
//   3. **输出里没有时间戳**：除耗时（p50/p95）与调用方传入的 sha，全部可逐字节比对。
//      两次跑的 JSON 去掉这两个字段后应当完全相同 —— 这是「装置在测同一个东西」的证据。
//
// 用法：
//   node scripts/bench.mjs --db <lattice.db> --queries <queries.json> [--out <结果.json>]
//   node scripts/bench.mjs --data <目录>        # 目录内含 lattice.db 与 queries.json
//   可选：--bootstrap <次数>（默认 10000）、--seed <整数>（默认 20261018）、--sha <提交号>
//
// 查询集格式见 bench/fixtures/queries.example.json。**真实查询集不入库**：bench/results/ 里
// 只记录它的 sha256 与条数，查询文本留在评测者本地（内部查询还会带内部路径，不能公开）。
//
// 指标口径见 docs/BENCHMARK.md。这里只重复最容易读错的一条：
// **n 是「有 target 的查询条数」，recall 的分母就是它**；没有 target 的查询只参与耗时统计，
// 不参与 recall —— 把它们算成「未命中」会把 recall 拉低到没有意义的数，那是另一种假的准确。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openVault } from '../dist/db/open.js'
import { encode, ensureEncoder } from '../dist/encoder/index.js'
import { recall } from '../dist/pipeline/search.js'
import { argOf } from './lib/compare-db.mjs'

const SCRIPT = 'scripts/bench.mjs'

/**
 * 与 scripts/verify-recall-baseline.mjs 同一个模型。
 * 换模型等于换装置：向量变了，任何历史数字都不再可比，所以它写死在脚本里而不是参数。
 */
const MODEL = 'Xenova/bge-small-zh-v1.5'

/**
 * 召回条数，与生产默认一致（配置项 topN 的默认 24）；Recall@12 从这个列表的前 12 名里取。
 * 为什么不直接召回 12 条：24 条是运行时真实交给注入层的规模，测它才测得住生产路径。
 */
const TOP_N = 24

/** 被报告的 k。12 是实测的等价点（24 与 12 在 gold 集上同分，见 docs/DEVELOPMENT.md）。 */
const TOP_KS = [5, 12]

const DEFAULT_BOOTSTRAP = 10000
/** bootstrap 的种子写死：区间要能复现，否则「区间重叠」这种判断每次都不一样。 */
const DEFAULT_SEED = 20261018

/** 参数错误一律退出码 2，并说清缺什么、为什么不能给默认值 —— 与 scripts/lib/compare-db.mjs 同一套说法。 */
function die(lines) {
  for (const l of lines) console.error(l)
  process.exit(2)
}

function pathArg(name) {
  const raw = String(argOf(name, '')).trim()
  return raw === '' ? null : resolve(raw)
}

const dataDir = pathArg('data')
const dbArg = pathArg('db')
const queriesArg = pathArg('queries')

// 负对照用的旋钮（审核 P0-2）：`--k-vec N` 把向量粗筛宽度改掉。
//
// 为什么用 kVec 而不是 RRF_K：kVec 决定候选集宽度，对「召回退化」更直接，而且**不需要给
// recall 加新参数**（opts 里本来就有）。它只用于负对照 —— 不改变默认行为。
const kVecRaw = String(argOf('k-vec', '')).trim()
const K_VEC_OVERRIDE = kVecRaw === '' ? null : Number(kVecRaw)
if (K_VEC_OVERRIDE !== null && (!Number.isFinite(K_VEC_OVERRIDE) || K_VEC_OVERRIDE < 1)) {
  die(['--k-vec 必须是 >= 1 的整数（这是负对照旋钮，不是调参入口）。'])
}

if (dataDir !== null && (dbArg !== null || queriesArg !== null)) {
  die([
    '--data 与 --db / --queries 只能二选一。',
    '',
    '混用时「到底读的是哪一份」要靠猜，猜错的结果与跑错一模一样。',
  ])
}

const dbPath = dataDir !== null ? join(dataDir, 'lattice.db') : dbArg
const queriesPath = dataDir !== null ? join(dataDir, 'queries.json') : queriesArg

if (dbPath === null || queriesPath === null) {
  console.error('缺少被测数据：' + SCRIPT + ' 需要 --db <库> 与 --queries <查询集>，或 --data <目录>。')
  console.error('')
  console.error('两条路：')
  console.error('  · 分开给：node ' + SCRIPT + ' --db <lattice.db> --queries <queries.json>')
  console.error('  · 给目录：node ' + SCRIPT + ' --data <目录>（内含 lattice.db 与 queries.json）')
  console.error('')
  console.error('为什么不给默认值：本项目的基准库不是固定路径，而是「这次要跟哪一份比」的问题；')
  console.error('默认值会把「我忘了指定」翻译成「一切正常」（同一理由见 scripts/lib/compare-db.mjs）。')
  process.exit(2)
}

for (const p of [dbPath, queriesPath]) {
  if (!existsSync(p)) {
    die([
      '文件不存在：' + p,
      '路径写错了就改正；数据还没准备就按 docs/BENCHMARK.md 的「来源与版本锁定」自备。',
    ])
  }
}

const bootstrapRaw = argOf('bootstrap', String(DEFAULT_BOOTSTRAP))
const bootstrapB = Number(bootstrapRaw)
if (!Number.isInteger(bootstrapB) || bootstrapB < 100) {
  die(['--bootstrap 需要 ≥ 100 的整数，收到的是 ' + bootstrapRaw + '。', '次数太少时区间本身就成了噪声。'])
}
const seedRaw = argOf('seed', String(DEFAULT_SEED))
const seed = Number(seedRaw)
if (!Number.isInteger(seed)) die(['--seed 需要整数，收到的是 ' + seedRaw + '。'])

const sha = String(argOf('sha', '')).trim()
const outPath = pathArg('out')

// ── 查询集：两种形态都认 ─────────────────────────────────
// 数组形态 = 只有查询本身（历史 gold 集就是这种）；对象形态额外带 name / source，
// 便于在结果里写清「这是哪一版查询集」。字段含义见 bench/fixtures/queries.example.json。
const queryBytes = readFileSync(queriesPath)
let parsed
try {
  parsed = JSON.parse(queryBytes.toString('utf8'))
} catch (err) {
  die(['查询集不是合法 JSON：' + queriesPath, String(err instanceof Error ? err.message : err)])
}
const items = Array.isArray(parsed) ? parsed : parsed.queries
if (!Array.isArray(items) || items.length === 0) {
  die(['查询集里没有查询：' + queriesPath, '数组形态要求顶层是非空数组；对象形态要求 queries 是非空数组。'])
}
const setName =
  Array.isArray(parsed) || typeof parsed.name !== 'string' || parsed.name.trim() === ''
    ? basename(queriesPath, '.json')
    : parsed.name.trim()

const queries = items.map((it, i) => {
  const q = typeof it.query === 'string' ? it.query.trim() : ''
  if (q === '') die(['第 ' + (i + 1) + ' 条查询没有 query 文本（或不是字符串）。'])
  const t = it.target === undefined || it.target === null ? '' : String(it.target).trim()
  return { id: String(it.id ?? i + 1), query: q, target: t === '' ? null : t }
})

const scored = queries.filter((c) => c.target !== null)
if (scored.length === 0) {
  die([
    '查询集里没有一条带 target，算不出 recall。',
    '只有「无关查询」的集合能测耗时与误召，但测不了召回率；请补上带 target 的查询。',
  ])
}

// ── 库：只读打开，先把「哪条 atom 来自哪个来源」读进内存 ──────
const { db } = openVault(dbPath, { readOnly: true })
const sourceOf = new Map()
for (const r of db.prepare('SELECT id, source_ref FROM atom').all()) {
  sourceOf.set(Number(r.id), String(r.source_ref ?? ''))
}
const atoms = Number(db.prepare('SELECT count(*) AS c FROM atom').get().c)
const superseded = Number(
  db.prepare('SELECT count(*) AS c FROM atom WHERE superseded_by IS NOT NULL').get().c,
)

// ── 编码器：必须可用 ────────────────────────────────────
// 不可用时 recall 会退回纯词面，指标会静默掉一大截 —— 那是装置坏了，不是被测对象坏了，
// 所以这里**直接失败**而不是降级跑下去（降级跑出来的数字最像「改动变差了」）。
const ok = await ensureEncoder({ model: MODEL })
if (!ok) {
  die([
    '编码器不可用：' + SCRIPT + ' 必须在真实模型 ' + MODEL + ' 下跑。',
    '模型文件需已在本地缓存（本脚本不联网，也不会替你下载）。',
    '缓存位置与准备方式见 docs/BENCHMARK.md 的「环境准备」。',
  ])
}

// ── 逐条召回 ────────────────────────────────────────────
// 计时只包住 recall()：编码是一次性/可缓存的成本，混进来会把「检索变慢」与「模型变慢」
// 搅成一个数。口径写在 docs/BENCHMARK.md。
const rows = []
for (const c of queries) {
  const vq = await encode(c.query, { model: MODEL })
  if (vq === null) die(['查询编码失败：' + c.id + '（' + c.query + '）', '编码器状态异常，先修环境再跑。'])
  const t0 = performance.now()
  const r = recall(
    db,
    c.query,
    vq,
    K_VEC_OVERRIDE === null ? { topN: TOP_N } : { topN: TOP_N, kVec: K_VEC_OVERRIDE },
  )
  const ms = performance.now() - t0
  const rankAt = (k) => {
    if (c.target === null) return -1
    return r.hits.slice(0, k).findIndex((h) => sourceOf.get(h.id) === c.target)
  }
  const hit = {}
  for (const k of TOP_KS) hit[k] = rankAt(k) >= 0
  rows.push({ id: c.id, query: c.query, target: c.target, hit, ms })
}
db.close()

/** 取整：输出要能逐字节比对，浮点尾数只会制造假差异。 */
const round = (x, digits) => {
  const f = Math.pow(10, digits)
  return Math.round(x * f) / f
}

/** 最近秩分位数：不插值，读起来就是「第几条」。 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[i]
}

/** 固定种子的 mulberry32：同一种子同一条重采样序列，区间才可复现。 */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * bootstrap 95% 区间（百分位法）。
 *
 * 重采样的单位是**查询**，不是命中：一次重采样里同一条查询可能被抽中两次、另一条一次不中，
 * 这样才把「换一批同样大小的查询，recall 会飘多少」表达出来。
 */
function bootstrapCI(scoredRows) {
  const n = scoredRows.length
  const rand = mulberry32(seed)
  const samples = {}
  for (const k of TOP_KS) samples[k] = []
  for (let b = 0; b < bootstrapB; b++) {
    for (const k of TOP_KS) {
      let hit = 0
      for (let i = 0; i < n; i++) {
        const j = Math.floor(rand() * n)
        if (scoredRows[j].hit[k]) hit++
      }
      samples[k].push(hit / n)
    }
  }
  const out = {}
  for (const k of TOP_KS) {
    const s = samples[k].sort((a, b) => a - b)
    out['recall' + k] = [round(percentile(s, 0.025), 4), round(percentile(s, 0.975), 4)]
  }
  return out
}

// 有 target 的那批才是 recall 的分母；没 target 的只贡献耗时（口径见 docs/BENCHMARK.md）。
const scoredRows = rows.filter((r) => r.target !== null)
const n = scoredRows.length
const hitsOf = (k) => scoredRows.filter((r) => r.hit[k]).length
const latencies = rows.map((r) => r.ms).sort((a, b) => a - b)
const ci95 = bootstrapCI(scoredRows)

const result = {
  sha: sha === '' ? null : sha,
  set: setName,
  n,
  'recall@5': round(hitsOf(5) / n, 4),
  'recall@12': round(hitsOf(12) / n, 4),
  p50_ms: round(percentile(latencies, 0.5), 2),
  p95_ms: round(percentile(latencies, 0.95), 2),
  atoms,
  superseded,
  ci95,
  minResolvable: round(1 / n, 4),
  hits5: hitsOf(5),
  hits12: hitsOf(12),
  nTotal: rows.length,
  topN: TOP_N,
  // 负对照旋钮：null 表示默认行为。写进结果，两次跑的差异才可解释。
  kVec: K_VEC_OVERRIDE,
  model: MODEL,
  querySet: {
    sha256: createHash('sha256').update(queryBytes).digest('hex'),
    queries: rows.length,
    scored: n,
  },
  bootstrap: { B: bootstrapB, seed },
}

const pctText = (x) => (x * 100).toFixed(1) + '%'
console.log('集合 ' + setName + '：' + rows.length + ' 条查询，其中 ' + n + ' 条有 target（recall 的分母）')
console.log(
  '  Recall@5 ' +
    pctText(result['recall@5']) +
    '（' +
    result.hits5 +
    '/' +
    n +
    '）   Recall@12 ' +
    pctText(result['recall@12']) +
    '（' +
    result.hits12 +
    '/' +
    n +
    '）',
)
console.log(
  '  p50 ' +
    result.p50_ms +
    ' ms   p95 ' +
    result.p95_ms +
    ' ms（' +
    rows.length +
    ' 次 recall 调用，不含编码）',
)
console.log(
  '  95% 区间：Recall@5 [' +
    pctText(ci95.recall5[0]) +
    ', ' +
    pctText(ci95.recall5[1]) +
    ']   Recall@12 [' +
    pctText(ci95.recall12[0]) +
    ', ' +
    pctText(ci95.recall12[1]) +
    ']',
)
console.log('  最小可分辨差 ' + pctText(result.minResolvable) + '（1 条命中 / ' + n + '）')
console.log('  库 ' + atoms + ' 条 atom，其中 ' + superseded + ' 条已被取代')

const text = JSON.stringify(result, null, 2) + '\n'
if (outPath !== null) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, text)
  console.log('结果已写入 ' + outPath)
} else {
  console.log('')
  console.log(text.trimEnd())
}

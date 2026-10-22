#!/usr/bin/env node
// 参考线复核工具：把「召回判定用的本库参考线」原样复算一遍，并给出三种口径的分布。
//
// 判定机制（本工具复算的就是它）：
//   48 条与库内容无关的中文日常问句，逐条在本库取「全库最高余弦」（下称 top1）；
//   这 48 个 top1 的 p90 就是本库的参考线。一条查询的 top1 高于它，才判「这次召回有内容」。
//   线超过上界 REFERENCE_MAX_LINE 说明判据失效；库比 48 条还小时判据不启用。
//
// 本工具回答三个问题：
//   1. 每个库的 p90 落在哪、离上界多远（全量 48 / S1 前 24 / S2 后 24 三档都算）；
//   2. 只用一半问句时 p90 漂多少 —— p90 由尾部两三个值决定，条数够不够只能实测；
//   3. 多个库合起来时线升到哪（--merged）。
//
// 只读：所有库以 readOnly 打开，只执行 SELECT。产物写到 --out 目录。
//
// 为什么在仓库里：参考线是本插件判空机制的核心参数，改动它之前必须能拿一条命令把它复算出来。
// 复算命令与三个语料库上的实测值见 docs/THRESHOLDS.md 的「参考线怎么复算」一节。
//
// 用法：
//   node verdict-line.mjs <库1> [库2 ...] [--merged] [--out <目录>] [--repo <仓库根>]
//                         [--cache-dir <目录>] [--json <文件名>] [--model <模型名>] [--quiet]
//
//   库路径本身不带任何默认值：不传就报错，不接受猜测。
//
//   --merged    额外输出合并口径。两个口径一并给出，因为它们不等价：
//                 pooled   —— 所有库 x 48 条 top1 汇总成一个池子再取分位。回答「把各库
//                             的零假设分布放在一起时，尾部落在哪」。
//                 crossmax —— 逐条问句先取各库 top1 的最大值，再对 48 个数取分位。
//                             这条更接近「把多个库并成一个库」的语义：合并后的库对同一条
//                             问句的 top1，就是各库 top1 的最大值。主口径用 pooled（见交付
//                             说明），crossmax 作为对照。
//   --out       产物目录，默认写到系统临时目录下的 verdict-line/
//   --repo      插件仓库根，默认取脚本所在仓库（脚本目录的上一级）
//   --cache-dir 编码模型缓存目录，默认 <仓库根>/node_modules/@huggingface/transformers/.cache
//   --json      JSON 文件名，默认 verdict-line.json
//   --model     编码模型，默认取插件发布时的同一个（Xenova/bge-small-zh-v1.5）
//   --boot N    额外做 N 次「从 48 条里抽 24 条」的 p90 抽样，看换一批问句线会漂多少
//               （默认 0 不做）
//   --seed N    抽样种子，默认 20261023 —— 固定种子，同一条命令结果可复现
//   --quiet     只写 JSON，不打印表格
//
// 退出码：0 成功；2 参数或产物缺失；3 编码器不可用；4 复算与插件自身计算结果不一致。

import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5'

function usage() {
  const lines = [
    '参考线复核工具',
    '',
    '用法：',
    '  node verdict-line.mjs <库1> [库2 ...] [--merged] [--out <目录>] [--repo <仓库根>]',
    '                        [--cache-dir <目录>] [--json <文件名>] [--model <模型名>] [--quiet]',
    '',
    '  --merged    输出合并口径（pooled 主口径 / crossmax 对照口径）',
    '  --out       产物目录，默认 <系统临时目录>/verdict-line',
    '  --repo      插件仓库根，默认脚本所在仓库的上一级',
    '  --cache-dir 模型缓存目录，默认 <仓库根>/node_modules/@huggingface/transformers/.cache',
    '  --json      JSON 文件名，默认 verdict-line.json',
    '  --model     编码模型，默认 ' + DEFAULT_MODEL,
    '  --boot N    额外做 N 次「从 48 条里抽 24 条」的 p90 抽样，看换一批问句线会漂多少（默认 0，不做）',
    '  --seed N    抽样种子，默认 20261023（固定种子，同一命令结果可复现）',
    '  --quiet     只写 JSON，不打印表格',
  ]
  console.log(lines.join('\n'))
}

function die(msg, code) {
  console.error('错误：' + msg)
  process.exit(code === undefined ? 2 : code)
}

// 只保留路径末两段做标签：产物里不出现调用方的目录结构。
function labelOf(p) {
  const seg = p.split(/[\\/]+/).filter(function (s) {
    return s !== ''
  })
  return seg.slice(-2).join('/')
}

// 等宽显示：CJK 字符按两列算，表格才不会歪。
function vwidth(s) {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    w += wide ? 2 : 1
  }
  return w
}

function pad(s, n) {
  const t = String(s)
  return t + ' '.repeat(Math.max(0, n - vwidth(t)))
}

function num(x, digits) {
  return Number.isFinite(x) ? x.toFixed(digits === undefined ? 4 : digits) : 'NaN'
}

function signed(x, digits) {
  if (!Number.isFinite(x)) return 'NaN'
  return (x >= 0 ? '+' : '') + x.toFixed(digits === undefined ? 4 : digits)
}

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const libPaths = []
const opt = {
  merged: false,
  quiet: false,
  outDir: null,
  repo: null,
  cacheDir: null,
  jsonName: 'verdict-line.json',
  model: DEFAULT_MODEL,
  boot: 0,
  seed: 20261023,
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--merged') opt.merged = true
  else if (a === '--quiet') opt.quiet = true
  else if (a === '--out') opt.outDir = argv[++i]
  else if (a === '--repo') opt.repo = argv[++i]
  else if (a === '--cache-dir') opt.cacheDir = argv[++i]
  else if (a === '--json') opt.jsonName = argv[++i]
  else if (a === '--model') opt.model = argv[++i]
  else if (a === '--boot') {
    opt.boot = Number(argv[++i])
    if (!Number.isInteger(opt.boot) || opt.boot <= 0) die('--boot 需要一个正整数')
  } else if (a === '--seed') {
    opt.seed = Number(argv[++i])
    if (!Number.isInteger(opt.seed)) die('--seed 需要一个整数')
  } else if (a === '--help' || a === '-h') {
    usage()
    process.exit(0)
  } else if (a.startsWith('--')) die('未知选项 ' + a)
  else libPaths.push(a)
}
if (libPaths.length === 0) {
  usage()
  die('至少要给一个库路径')
}
for (const p of libPaths) {
  if (!existsSync(p)) die('库不存在：' + p)
}

// ---------- 定位构建产物 ----------
const repo = resolve(opt.repo === null || opt.repo === undefined ? join(HERE, '..') : opt.repo)
const distEnc = join(repo, 'dist', 'encoder', 'index.js')
const distRef = join(repo, 'dist', 'pipeline', 'refdist.js')
const distSearch = join(repo, 'dist', 'pipeline', 'search.js')
for (const f of [distEnc, distRef, distSearch]) {
  if (!existsSync(f)) die('找不到构建产物：' + f)
}

const enc = await import(pathToFileURL(distEnc).href)
const rd = await import(pathToFileURL(distRef).href)
const sr = await import(pathToFileURL(distSearch).href)

const QUESTIONS = rd.REFERENCE_QUESTIONS
const QUANT = rd.REFERENCE_QUANTILE
const MAX_LINE = rd.REFERENCE_MAX_LINE
const MIN_ATOMS = rd.REFERENCE_MIN_ATOMS
const HALF = QUESTIONS.length / 2
if (!Number.isInteger(HALF)) die('内置问句条数不是偶数，无法对半分：' + QUESTIONS.length)

// ---------- 编码器 ----------
const cacheDir =
  opt.cacheDir === null || opt.cacheDir === undefined
    ? join(repo, 'node_modules', '@huggingface', 'transformers', '.cache')
    : opt.cacheDir
const encOpts = { model: opt.model, cacheDir: cacheDir }
const tLoad = Date.now()
const ready = await enc.ensureEncoder(encOpts)
const loadMs = Date.now() - tLoad
if (!ready) {
  die('编码器不可用（' + String(enc.encoderErrorCode()) + '）：' + String(enc.encoderError()), 3)
}

// 每条问句只编码一次，三个库共用同一批向量 —— 编码结果与库无关。
const tEnc = Date.now()
const vectors = []
for (const q of QUESTIONS) {
  const v = await enc.encode(q, encOpts)
  if (v === null) die('第 ' + (vectors.length + 1) + ' 条问句编码失败')
  vectors.push(v)
}
const encMs = Date.now() - tEnc

function summarize(values) {
  if (values.length === 0) return { n: 0, p50: NaN, p90: NaN, max: NaN }
  return {
    n: values.length,
    p50: rd.quantile(values, 0.5),
    p90: rd.quantile(values, QUANT),
    max: Math.max.apply(null, values),
  }
}

// ---------- 逐库计算 ----------
const libs = []
for (let li = 0; li < libPaths.length; li++) {
  const p = libPaths[li]
  const tLib = Date.now()
  const db = new DatabaseSync(p, { readOnly: true })
  let atoms = 0
  let scores = []
  let viaRef = null
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM atom').get()
    atoms = Number(row.n)
    // 48 条问句在本库的最高余弦。top1Cosine 内部会缓存全库向量（按 atom 行数失效）。
    scores = vectors.map(function (v) {
      return sr.top1Cosine(db, v)
    })
    // 插件自身的算法再跑一遍，作为交叉核对（它内部会重新编码这 48 条）。
    viaRef = await rd.referenceFor(db, function (t) {
      return enc.encode(t, encOpts)
    })
  } finally {
    db.close()
  }
  const full = summarize(scores)
  const s1 = summarize(scores.slice(0, HALF))
  const s2 = summarize(scores.slice(HALF))
  const top = scores
    .map(function (s, i) {
      return { q: QUESTIONS[i], score: s }
    })
    .sort(function (a, b) {
      return b.score - a.score
    })
    .slice(0, 3)
  const dP90 = Math.abs(full.p90 - viaRef.p90)
  const dP50 = Math.abs(full.p50 - viaRef.p50)
  const dMax = Math.abs(full.max - viaRef.max)
  libs.push({
    id: 'lib' + (li + 1),
    label: labelOf(p),
    atoms: atoms,
    full: full,
    s1: s1,
    s2: s2,
    deltaS1: s1.p90 - full.p90,
    deltaS2: s2.p90 - full.p90,
    top: top,
    usable: viaRef.usable,
    reason: viaRef.reason,
    production: { n: viaRef.n, p50: viaRef.p50, p90: viaRef.p90, max: viaRef.max },
    crossCheck: {
      nMatches: viaRef.n === scores.length,
      atomsMatches: viaRef.atoms === atoms,
      dP50: dP50,
      dP90: dP90,
      dMax: dMax,
      ok: viaRef.n === scores.length && viaRef.atoms === atoms && dP90 < 1e-9 && dP50 < 1e-9 && dMax < 1e-9,
    },
    scores: scores,
    elapsedMs: Date.now() - tLib,
  })
}

// ---------- 合并口径 ----------
let merged = null
if (opt.merged) {
  const pooled = []
  for (const l of libs) for (const s of l.scores) pooled.push(s)
  const pooledFull = summarize(pooled)
  const pooledS1 = summarize(
    [].concat.apply(
      [],
      libs.map(function (l) {
        return l.scores.slice(0, HALF)
      }),
    ),
  )
  const pooledS2 = summarize(
    [].concat.apply(
      [],
      libs.map(function (l) {
        return l.scores.slice(HALF)
      }),
    ),
  )
  // 逐条问句取各库最大值：等价于「把同一条问句拿到并成一个库之后」的 top1（上界意义上）。
  const crossVals = QUESTIONS.map(function (_, i) {
    let m = -Infinity
    for (const l of libs) if (l.scores[i] > m) m = l.scores[i]
    return m
  })
  const crossFull = summarize(crossVals)
  const crossTop = crossVals
    .map(function (s, i) {
      return { q: QUESTIONS[i], score: s }
    })
    .sort(function (a, b) {
      return b.score - a.score
    })
    .slice(0, 3)
  merged = {
    libCount: libs.length,
    pooled: {
      full: pooledFull,
      s1: pooledS1,
      s2: pooledS2,
      deltaS1: pooledS1.p90 - pooledFull.p90,
      deltaS2: pooledS2.p90 - pooledFull.p90,
    },
    crossmax: { full: crossFull, top: crossTop },
  }
}

// ---------- 24 条子样本的 p90 抽样 ----------
// 回答「当初只选 24 条会怎样」：从现有 48 条里等概率、不重复地抽 24 条，重算 p90。
// 注意这是**从现有 48 条里抽**，带有限总体校正，波动比「另选一批全新的 24 条」小约
// ×sqrt((48-24)/(48-1)) ≈ 0.71 —— 所以这里的跨度是**下界**，不是换批问句的真实波动。
function mulberry32(a) {
  let s = a >>> 0
  return function () {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function drawIndices(n, k, rnd) {
  const idx = []
  for (let i = 0; i < n; i++) idx.push(i)
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (n - i))
    const tmp = idx[i]
    idx[i] = idx[j]
    idx[j] = tmp
  }
  return idx.slice(0, k)
}

function bootStats(actual, draws) {
  const ps = draws.slice().sort(function (a, b) {
    return a - b
  })
  const p05 = rd.quantile(ps, 0.05)
  const p95 = rd.quantile(ps, 0.95)
  const p50 = rd.quantile(ps, 0.5)
  return {
    actual: actual,
    p05: p05,
    p50: p50,
    p95: p95,
    min: ps[0],
    max: ps[ps.length - 1],
    span: p95 - p05,
    bias: p50 - actual,
  }
}

let boot = null
if (opt.boot > 0) {
  const rnd = mulberry32(opt.seed)
  const perLib = []
  for (const l of libs) {
    const draws = []
    for (let r = 0; r < opt.boot; r++) {
      const pick = drawIndices(l.scores.length, HALF, rnd)
      const sub = pick.map(function (i) {
        return l.scores[i]
      })
      draws.push(rd.quantile(sub, QUANT))
    }
    perLib.push({ id: l.id, label: l.label, stats: bootStats(l.full.p90, draws) })
  }
  let pooled = null
  if (merged !== null) {
    const draws = []
    for (let r = 0; r < opt.boot; r++) {
      // 所有库抽同一批问句下标：模拟「换一批问句」，两个库的差才可比。
      const pick = drawIndices(QUESTIONS.length, HALF, rnd)
      const vals = []
      for (const l of libs) for (const i of pick) vals.push(l.scores[i])
      draws.push(rd.quantile(vals, QUANT))
    }
    pooled = { stats: bootStats(merged.pooled.full.p90, draws) }
  }
  boot = {
    times: opt.boot,
    seed: opt.seed,
    halfSize: HALF,
    finitePopulation: 0.71,
    perLib: perLib,
    pooled: pooled,
  }
}

// ---------- 判断：上界是否触发 ----------
// 生产语义（refdist.ts）：线是 p90，触发条件是 p90 > REFERENCE_MAX_LINE。
// max 不参与判断 —— 它高于上界并不说明判据失效（单个问句偶然撞上库里的高频内容很正常），
// 只作为「尾部有多高」的观测量随表输出。
const p90Probes = []
const maxProbes = []
for (const l of libs) {
  p90Probes.push({ who: l.id, kind: 'p90', v: l.full.p90 })
  maxProbes.push({ who: l.id, kind: 'max', v: l.full.max })
}
if (merged !== null) {
  p90Probes.push({ who: 'merged-pooled', kind: 'p90', v: merged.pooled.full.p90 })
  p90Probes.push({ who: 'merged-crossmax', kind: 'p90', v: merged.crossmax.full.p90 })
  maxProbes.push({ who: 'merged-pooled', kind: 'max', v: merged.pooled.full.max })
  maxProbes.push({ who: 'merged-crossmax', kind: 'max', v: merged.crossmax.full.max })
}
const triggered = p90Probes.filter(function (x) {
  return x.v > MAX_LINE
})
const nearest = p90Probes.slice().sort(function (a, b) {
  return b.v - a.v
})[0]
let verdictLine
if (triggered.length > 0) {
  verdictLine =
    '上界 ' +
    num(MAX_LINE, 2) +
    ' 触发于 ' +
    triggered
      .map(function (x) {
        return x.who + ' 的 ' + x.kind + ' = ' + num(x.v)
      })
      .join('、')
} else {
  verdictLine =
    '上界 ' +
    num(MAX_LINE, 2) +
    ' 未触发，最近值 ' +
    nearest.who +
    ' 的 p90 = ' +
    num(nearest.v) +
    '（距上界 ' +
    num(MAX_LINE - nearest.v) +
    '，为线的 ' +
    (((MAX_LINE - nearest.v) / MAX_LINE) * 100).toFixed(1) +
    '%）'
}
const maxOver = maxProbes.filter(function (x) {
  return x.v > MAX_LINE
})
const maxNote =
  maxOver.length === 0
    ? '单条问句的最高 top1（max）在各口径也都低于上界'
    : '不参与判断的观测量：单条问句最高 top1（max）在 ' +
      maxOver
        .map(function (x) {
          return x.who + ' 上到 ' + num(x.v)
        })
        .join('、') +
      '，高于上界。线取的是 p90 不是 max —— max 会高于真相关内容的分位（见 REFERENCE_QUANTILE 的说明），不作为线'

// ---------- 打印 ----------
if (!opt.quiet) {
  const out = []
  out.push('参考线复核')
  out.push('  编码模型 ' + encOpts.model + '（加载 ' + loadMs + ' ms，48 条问句编码 ' + encMs + ' ms）')
  out.push(
    '  内置问句 ' +
      QUESTIONS.length +
      ' 条：S1 = 第 1-' +
      HALF +
      ' 条，S2 = 第 ' +
      (HALF + 1) +
      '-' +
      QUESTIONS.length +
      ' 条',
  )
  out.push('  分位 ' + QUANT + '；上界 ' + MAX_LINE + '；少于 ' + MIN_ATOMS + ' 条 atom 时判据不启用')
  out.push('')
  out.push('  库')
  for (const l of libs) {
    out.push(
      '    ' +
        l.id +
        ' = ' +
        l.label +
        '（' +
        l.atoms +
        ' atom）' +
        (l.usable ? '' : '  [判据不可用：' + l.reason + ']'),
    )
  }
  out.push('')

  const head = pad('库', 8) + pad('atom', 8) + pad('问句', 6) + pad('p50', 9) + pad('p90', 9) + 'max'
  out.push('表 1  每库三档分位（每条问句在本库的 top1 余弦）')
  out.push('  ' + head)
  for (const l of libs) {
    out.push(
      '  ' +
        pad(l.id, 8) +
        pad(l.atoms, 8) +
        pad(l.full.n, 6) +
        pad(num(l.full.p50), 9) +
        pad(num(l.full.p90), 9) +
        num(l.full.max),
    )
    out.push(
      '  ' +
        pad('  S1', 8) +
        pad('', 8) +
        pad(l.s1.n, 6) +
        pad(num(l.s1.p50), 9) +
        pad(num(l.s1.p90), 9) +
        num(l.s1.max),
    )
    out.push(
      '  ' +
        pad('  S2', 8) +
        pad('', 8) +
        pad(l.s2.n, 6) +
        pad(num(l.s2.p50), 9) +
        pad(num(l.s2.p90), 9) +
        num(l.s2.max),
    )
  }
  out.push('')
  out.push('  半量相对全量的 p90 漂移（Δp90 = 半量 p90 - 全量 p90）')
  for (const l of libs) {
    out.push(
      '    ' + pad(l.id, 8) + 'Δp90(S1) = ' + pad(signed(l.deltaS1), 9) + '  Δp90(S2) = ' + signed(l.deltaS2),
    )
  }
  out.push('')

  out.push('表 2  上界 ' + num(MAX_LINE, 2) + ' 检查')
  out.push(
    '  ' +
      pad('口径', 16) +
      pad('问句', 6) +
      pad('p90', 9) +
      pad('p90 距上界', 12) +
      pad('max', 9) +
      pad('max 距上界', 12) +
      'p90 > 上界',
  )
  for (const l of libs) {
    out.push(
      '  ' +
        pad(l.id, 16) +
        pad(l.full.n, 6) +
        pad(num(l.full.p90), 9) +
        pad(signed(MAX_LINE - l.full.p90), 12) +
        pad(num(l.full.max), 9) +
        pad(signed(MAX_LINE - l.full.max), 12) +
        (l.full.p90 > MAX_LINE ? '是' : '否'),
    )
  }
  if (merged !== null) {
    const m = merged.pooled.full
    out.push(
      '  ' +
        pad('merged-pooled', 16) +
        pad(m.n, 6) +
        pad(num(m.p90), 9) +
        pad(signed(MAX_LINE - m.p90), 12) +
        pad(num(m.max), 9) +
        pad(signed(MAX_LINE - m.max), 12) +
        (m.p90 > MAX_LINE ? '是' : '否'),
    )
    const c = merged.crossmax.full
    out.push(
      '  ' +
        pad('merged-crossmax', 16) +
        pad(c.n, 6) +
        pad(num(c.p90), 9) +
        pad(signed(MAX_LINE - c.p90), 12) +
        pad(num(c.max), 9) +
        pad(signed(MAX_LINE - c.max), 12) +
        (c.p90 > MAX_LINE ? '是' : '否'),
    )
  }
  out.push('')
  out.push('  判定：' + verdictLine)
  out.push('        ' + maxNote)
  out.push('')

  out.push('表 3  尾部最高的三条（p90 由尾部决定，S1 / S2 的差异都从这几条来）')
  for (const l of libs) {
    out.push('  ' + l.id + ' = ' + l.label)
    for (let k = 0; k < l.top.length; k++) {
      out.push('    ' + num(l.top[k].score) + '  ' + l.top[k].q)
    }
  }
  if (merged !== null) {
    out.push('  merged-crossmax')
    for (let k = 0; k < merged.crossmax.top.length; k++) {
      out.push('    ' + num(merged.crossmax.top[k].score) + '  ' + merged.crossmax.top[k].q)
    }
    out.push('')
    out.push('  合并口径的 S1 / S2 漂移（pooled）')
    out.push(
      '    ' +
        pad('merged', 10) +
        'Δp90(S1) = ' +
        pad(signed(merged.pooled.deltaS1), 9) +
        '  Δp90(S2) = ' +
        signed(merged.pooled.deltaS2),
    )
  } else if (libs.length > 1) {
    out.push('')
    out.push('  （给了 ' + libs.length + ' 个库；要合并口径请加 --merged）')
  }
  if (boot !== null) {
    out.push('')
    out.push('表 4  换成 24 条问句时线的抽样分布（每行 ' + boot.times + ' 次抽样）')
    out.push(
      '  ' +
        pad('库', 16) +
        pad('实际 p90', 10) +
        pad('p05', 9) +
        pad('p50', 9) +
        pad('p95', 9) +
        pad('95%-5% 跨度', 12) +
        '中位偏差',
    )
    const rows = []
    for (const b of boot.perLib) rows.push({ who: b.id, s: b.stats })
    if (boot.pooled !== null) rows.push({ who: 'merged-pooled', s: boot.pooled.stats })
    for (const r of rows) {
      out.push(
        '  ' +
          pad(r.who, 16) +
          pad(num(r.s.actual), 10) +
          pad(num(r.s.p05), 9) +
          pad(num(r.s.p50), 9) +
          pad(num(r.s.p95), 9) +
          pad(num(r.s.span), 12) +
          signed(r.s.bias),
      )
    }
    out.push(
      '  抽 ' +
        boot.times +
        ' 次，种子 ' +
        boot.seed +
        '；从现有 48 条里不重复抽 24 条 —— 有限总体校正使波动比另选一批新问句小约 x' +
        boot.finitePopulation,
    )
  }
  out.push('')
  const bad = libs.filter(function (l) {
    return !l.crossCheck.ok
  })
  if (bad.length === 0) {
    out.push(
      '  交叉核对：本工具复算的 48 条 top1 与插件 referenceFor 的结果一致（p50 / p90 / max 差 < 1e-9）',
    )
  } else {
    out.push(
      '  交叉核对失败：' +
        bad
          .map(function (l) {
            return l.id
          })
          .join('、') +
        ' 与插件自身结果不一致',
    )
  }
  console.log(out.join('\n'))
}

// ---------- 写 JSON ----------
const outDir = resolve(
  opt.outDir === null || opt.outDir === undefined ? join(tmpdir(), 'verdict-line') : opt.outDir,
)
mkdirSync(outDir, { recursive: true })
const jsonPath = join(outDir, opt.jsonName)
const payload = {
  generatedAt: new Date().toISOString(),
  model: encOpts.model,
  quantile: QUANT,
  maxLine: MAX_LINE,
  minAtoms: MIN_ATOMS,
  questionCount: QUESTIONS.length,
  s1: { from: 1, to: HALF },
  s2: { from: HALF + 1, to: QUESTIONS.length },
  questions: QUESTIONS,
  libs: libs.map(function (l) {
    return {
      id: l.id,
      label: l.label,
      atoms: l.atoms,
      full: l.full,
      s1: l.s1,
      s2: l.s2,
      deltaS1: l.deltaS1,
      deltaS2: l.deltaS2,
      top: l.top,
      usable: l.usable,
      reason: l.reason,
      production: l.production,
      crossCheck: l.crossCheck,
      scores: l.scores,
      elapsedMs: l.elapsedMs,
    }
  }),
  merged: merged,
  boot: boot,
  verdict: verdictLine,
  maxNote: maxNote,
}
writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
if (!opt.quiet) console.log('JSON: ' + jsonPath)

const failed = libs.filter(function (l) {
  return !l.crossCheck.ok
})
if (failed.length > 0) process.exit(4)

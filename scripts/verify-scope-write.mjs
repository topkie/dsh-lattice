// scope 写入路径的端到端验证：同一条查询，在不同 scope 下写入、再按 scope 召回，隔离是否成立。
//
// 为什么需要这个脚本：scope 的语义只写在代码里（search.ts："a.scope = ? OR a.scope = 'global'"），
// 而它此前**没有端到端判据** —— 单元测试注入向量、验的是分支；真实编码器 + 真实写入路径
// 合起来才会暴露「写进去的 scope 与读出来的过滤对不对得上」。
//
// 用法（一条命令，可被第三方复现）：
//   node scripts/verify-scope-write.mjs
//
// 需要真实编码器（用本地缓存；加载失败直接退出，不吃降级路径 —— 本脚本验的是
// **几何定位 + scope 过滤**这条链，退化到纯词面就换了被测对象）。
// 不碰任何既有库：临时库建在 --dir（默认 .probe/t24-scope），跑完删除；--keep 可留档。
//
// 判据（任一不成立即非零退出）：
//   1. 不给 scope 时四条都能召回 —— 前提成立，否则「隔离」无从谈起（可能压根没召回到）
//   2. scope=global 的召回里不含任何项目域 atom
//   3. scope=<项目> 的召回里含该项目域的 atom，且含 global 的 atom（项目域要能看见全局）
//   4. scope=<项目> 的召回里不含另一个项目域的 atom
//   5. 向量路与入口/正文路都受 scope 约束（逐路计数核对）
//
// 只看「该看到的在不在、不该看到的在不在」，不看名次 —— 名次受 RRF 分数并列影响，
// 把它写进判据会让脚本在无关改动上闪断。
//
// 两处**已知的、本脚本如实报出**的事实（都不计成败 —— 它们是设计现状，不是本次收口范围）：
//   ① 图路（graphPath，search.ts）不做 scope 过滤 —— 它从种子沿边一跳，种子是过滤过的。
//   ② 搜索的图路只走 atom↔atom 边（kind IN near/co_occur/refines/requires），而写入路径
//      （write.ts 的 INSERT INTO edge）只产 atom→**topic** 的 near 边。也就是说：当前代码里
//      不存在 atom↔atom 边，图路在本脚本的所有 scope 下都为 0 —— 判据 6 里 graph=0 不是
//      「过滤掉了」，是「这条路本来就没有输入」。脚本会把两类边各数一遍，让这一点可自查。

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { recall } from '../dist/pipeline/search.js'

const MODEL = 'Xenova/bge-small-zh-v1.5'
const PROJ_X = 'proj-x'
const PROJ_Y = 'proj-y'

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const DIR = arg('dir', join('.probe', 't24-scope'))
const KEEP = process.argv.includes('--keep')

/**
 * 库里要写的四条。**关键性质**：文本两两的 bigram-Jaccard 都在 0.21 以下，
 * 远低于重复压制阈值（DUP_LEX = 0.72，见 search.ts）—— 否则两条相近内容会被压成一条，
 * 「隔离」就测不出来了。这组文本是设计时先量过的量，不是随手挑的。
 *
 * 不写 topicHint：本脚本要顺带走一遍真实的落位路径；四条分到的主题在下面打印出来，
 * 谁和谁并入同一主题不影响判据（判据只看 scope）。
 */
const CARDS = [
  { tag: 'G1', scope: 'global', text: 'npm 依赖解析要开 hoisted，否则装不上。' },
  { tag: 'P1', scope: PROJ_X, text: 'pnpm 的依赖解析策略需要 hoisted，不然包链接会失败。' },
  { tag: 'P2', scope: PROJ_Y, text: '包管理器符号链接创建失败时，先检查依赖解析策略。' },
  { tag: 'G2', scope: 'global', text: 'TypeScript 只在构建期生效，运行期看到的是 dist 里的 JS。' },
]

/** 查询：与 G1/P1/P2 同域，用来把它们拉出来；G2 是异域对照。 */
const QUERY = '依赖解析策略要用 hoisted 吗'

const say = (s) => console.log(s)

const enc = (t) => encode(t, { model: MODEL })
if (!(await ensureEncoder({ model: MODEL }))) {
  console.error('编码器不可用：本脚本必须在真实模型下跑（几何定位与向量路都是它的产物）。')
  process.exit(2)
}

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
const DB = join(DIR, 'lattice.db')
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true })

const { db } = openVault(DB)
const ctx = createWriteCtx(db, {}, { encode: enc })
const info = []
for (const c of CARDS) {
  const r = await writeAtom(ctx, {
    text: c.text,
    kind: '结论',
    scope: c.scope,
    projectKey: c.scope === 'global' ? undefined : c.scope,
    sourceRef: 'scope-check/' + c.tag,
  })
  info.push({ ...c, id: r.atomId, topicId: r.topicId, action: r.action })
}

say('写入（真实编码器）：' + CARDS.length + ' 条 —— 落库后的 scope 由库自己回答，不问写入方')
const stored = new Map(
  db
    .prepare('SELECT id, scope, topic_id FROM atom ORDER BY id')
    .all()
    .map((r) => [Number(r.id), { scope: String(r.scope), topic: Number(r.topic_id) }]),
)
const tagOf = new Map(info.map((v) => [v.id, v.tag]))
for (const v of info) {
  const row = stored.get(v.id)
  say(
    '  ' +
      v.tag.padEnd(4) +
      ' 写入 scope=' +
      v.scope.padEnd(7) +
      ' 落库 scope=' +
      row.scope.padEnd(7) +
      ' atom=' +
      v.id +
      ' topic=' +
      row.topic,
  )
}

const qv = await enc(QUERY)
const hitsOf = (scope) =>
  recall(db, QUERY, qv, { topN: 24, scope }).hits.map((h) => ({
    tag: tagOf.get(h.id) ?? 'atom' + h.id,
    scope: stored.get(h.id)?.scope ?? '?',
  }))
const tags = (list) => (list.length === 0 ? '（空）' : list.map((h) => h.tag + '(' + h.scope + ')').join(' '))

const unscoped = hitsOf(undefined)
const asGlobal = hitsOf('global')
const asX = hitsOf(PROJ_X)
const asY = hitsOf(PROJ_Y)
say('')
say('查询：' + QUERY)
say('  不给 scope       ' + tags(unscoped))
say('  scope=global     ' + tags(asGlobal))
say('  scope=' + PROJ_X + '      ' + tags(asX))
say('  scope=' + PROJ_Y + '      ' + tags(asY))
say('')

const has = (list, tag) => list.some((h) => h.tag === tag)
const hasScope = (list, s) => list.some((h) => h.scope === s)
const checks = []
const check = (name, pass, detail) => {
  checks.push([name, pass])
  say('  ' + (pass ? '通过  ' : '未通过') + '  ' + name + (detail === undefined ? '' : '   —— ' + detail))
}

check(
  '1 前提：不给 scope 时四条都能召回',
  has(unscoped, 'G1') && has(unscoped, 'P1') && has(unscoped, 'P2'),
  tags(unscoped),
)
check(
  '2 scope=global 不含项目域 atom',
  !hasScope(asGlobal, PROJ_X) && !hasScope(asGlobal, PROJ_Y),
  tags(asGlobal),
)
check('3 scope=' + PROJ_X + ' 含自己的与 global 的', has(asX, 'P1') && hasScope(asX, 'global'), tags(asX))
check('4 scope=' + PROJ_X + ' 不含 ' + PROJ_Y + ' 的', !hasScope(asX, PROJ_Y), tags(asX))
check(
  '5 scope=' + PROJ_Y + ' 只含自己的与 global 的',
  has(asY, 'P2') && hasScope(asY, 'global') && !hasScope(asY, PROJ_X),
  tags(asY),
)

const counts = (scope) => recall(db, QUERY, qv, { topN: 24, scope }).meta.counts
const cAll = counts(undefined)
const cGlobal = counts('global')
const cX = counts(PROJ_X)
const fmt = (c) => 'vec ' + c.vec + ' / entry ' + c.entry + ' / body ' + c.body + ' / graph ' + c.graph
check(
  '6 向量路与入口/正文路都受 scope 约束',
  cGlobal.vec < cAll.vec && cGlobal.entry <= cAll.entry && cGlobal.body <= cAll.body,
  '不给 scope: ' + fmt(cAll) + '  |  global: ' + fmt(cGlobal) + '  |  ' + PROJ_X + ': ' + fmt(cX),
)

// 图路的两处现状：先看有没有输入（atom↔atom 边），再看它有没有把域外 atom 带进来。
const edgeCount = (where) => Number(db.prepare('SELECT COUNT(*) AS n FROM edge WHERE ' + where).get().n)
const atomAtom = edgeCount("src_type = 'atom' AND dst_type = 'atom'")
const atomTopic = edgeCount("src_type = 'atom' AND dst_type = 'topic'")
const leak = asGlobal.filter((h) => h.scope !== 'global')
say('')
say('  图路的输入：atom↔atom 边 ' + atomAtom + ' 条 / atom→topic 边 ' + atomTopic + ' 条')
say(
  '  图路域外命中：' +
    (atomAtom === 0
      ? '不适用（本库没有 atom↔atom 边，图路无输入 —— 见文件头 ②）'
      : leak.length +
        (leak.length === 0 ? '（图路有输入，且未越界）' : '  ← ' + tags(leak) + '（见文件头 ①）')),
)

db.close()
if (KEEP) say('留档：' + DB + '（' + statSync(DB).size + ' 字节）')
else for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true })

const failed = checks.filter(([, p]) => !p)
say('')
say(
  failed.length === 0
    ? '结论：scope 隔离成立（' + checks.length + ' 项全通过）。'
    : '结论：' + failed.length + ' 项未通过。',
)
process.exit(failed.length === 0 ? 0 : 1)

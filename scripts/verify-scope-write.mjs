// scope 写入路径的端到端验证：同一条查询，在不同 scope 下写入、再按 scope 召回，隔离是否成立。
//
// 为什么需要这个脚本：scope 的语义只写在代码里（search.ts 的 \"a.scope = ? OR a.scope = 'global'\"），
// 而它此前**没有端到端判据** —— 单元测试注入向量、验的是分支；真实编码器 + 真实写入路径
// 合起来才会暴露「写进去的 scope 与读出来的过滤对不对得上」。
//
// 用法（一条命令，可被第三方复现）：
//   node scripts/verify-scope-write.mjs
//   node scripts/verify-scope-write.mjs --dir .probe/t27-scope --keep   # 换个目录并留档
//
// 需要真实编码器（用本地缓存；加载失败直接退出，不吃降级路径 —— 本脚本验的是
// **几何定位 + scope 过滤**这条链，退化到纯词面就换了被测对象）。
// 不碰任何既有库：临时库建在 --dir（默认 .probe/t24-scope），跑完删除；--keep 可留档。
// 因此它不需要用户的真实库 —— 判据全部在本脚本自己写的库上成立。
//
// 判据（任一不成立即非零退出）。每条后面写的是「怎么改会让它变红」——
// 没有构造失败方式的判据，等于没有判据：
//   1. 不给 scope 时五条都能召回 —— 前提成立，否则「隔离」无从谈起（可能压根没召回到）。
//      改红：把 search.ts 的 RECALL_TOP_N 改到 2。
//   2. scope=global 的召回里不含任何项目域 atom。
//      改红：把 search.ts 四路的 scopeSql 一律改成空串（等于取消过滤）。
//   3. scope=<项目> 的召回里含该项目域的 atom，且含 global 的 atom（项目域要能看见全局）。
//      改红：把 scope SQL 改成 \"a.scope = ?\"（丢掉 OR global 那一半）。
//   4. scope=<项目> 的召回里不含另一个项目域的 atom。
//      改红：把 scope SQL 改成 \"(a.scope = ? OR 1 = 1)\"。
//   5. 另一侧的 scope=<项目> 同样只含自己的与 global 的（两侧各查一次，不只查一边）。
//      改红：同 4。
//   6. 逐路计数都受 scope 约束（global 的向量路严格更少）。
//      改红：把 search.ts 的 vecPath 里 scopeSql 改成空串（只去掉向量路的过滤）。
//   7. 图路有输入，且一跳邻居不越界 —— 「有输入」是前提：没有输入时这条路没被测到，
//      不能算通过（否则「把图路关掉」也会让脚本变绿）。
//      改红：把 search.ts 的 graphPath 里 scopeSql 改成空串（跨域邻居会进 hits）；
//      或把 graph/infer.ts 的 NEAR_COS_MIN 抬到 1.0（一条推断边都建不出来）。
//   8. 列表路径的 scope 过滤：listAtoms 给 scope 时「同项目 + global」可见、别的项目不可见。
//      改红：把 list.ts 的 \"(scope = ? OR scope = 'global')\" 改成 \"scope = ?\"（global 条目消失）；
//      或删掉整个 if (opts.scope …) 分支（global 列表里出现项目域条目）。
//   9. project_key 维度：写入侧如实落库，读取侧**不参与过滤**（同 scope 两个不同键都可见）。
//      这是按现状如实断言，不是钉愿望 —— 现在 search.ts / list.ts 都只看 scope。
//      改红：把 write.ts 的 project_key 一律写成 NULL（落库断言红）；
//      或给 search.ts 的 scope SQL 追加 \"AND a.project_key = a.scope\"（P3 从项目域视图里消失）。
//  10. 三处输出路径口径一致：锚段 / 入口段 / 路段与 recall 的 hits 在同一 scope 语义下过滤。
//      锚段逐条对 hits，入口段不引入 atom，路段只出现同域邻居（路段**有意**展示 hits 之外的
//      一跳邻居，所以「一致」的口径是「同一条 scope 规则」，不是「集合相等」）。
//      改红：把 view.ts 的 pathLinesFor 调用里 opts.scope 改成 undefined（跨域邻居写进注入文本）。
//
// 只看「该看到的在不在、不该看到的在不在」，不看名次 —— 名次受 RRF 分数并列影响，
// 把它写进判据会让脚本在无关改动上闪断。
//
// 两点与本脚本有关的来龙去脉，读输出时要先知道：
//   ① 一跳邻居曾经不过 scope。图路的「种子」是向量路的结果（已过滤），但沿边出去的那一跳
//      没有过滤 —— 一条跨域的边就能把别的域的 atom 带进来。判据 7 与判据 10 专门盯这件事：
//      域外命中必须是 0，而那要求图路/路段**确实有输入**（没有输入时不算通过，见它们的 detail）。
//      召回侧（search.ts 的 graphPath）与注入文本的【路】段（view.ts 的 pathLinesFor）两处
//      都要过滤，只改一处会在另一处留下同样的泄漏。
//   ② 这条路曾经长期为空。搜索的图路只认 atom↔atom 边（kind IN near/co_occur/refines/
//      requires/related），而写入路径（write.ts 的 INSERT INTO edge）只产 atom→**topic** 的 near 边；
//      atom↔atom 边是召回时由 graph/infer.ts 按余弦近邻现建的，本脚本的卡片之间曾长期
//      达不到建边线，于是「路是空的」反而让 ① 一直没暴露。本脚本现在自己插两条**声明边**
//      （origin = declared，见下面插入处）：一条同域、一条跨域。「路有输入」因此不再依赖
//      推断边的运气；同时那条跨域边若被过滤漏掉，判据 10 立刻红。

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { recall } from '../dist/pipeline/search.js'
import { listAtoms } from '../dist/pipeline/list.js'
import { assembleView } from '../dist/pipeline/view.js'

const MODEL = 'Xenova/bge-small-zh-v1.5'
const PROJ_X = 'proj-x'
const PROJ_Y = 'proj-y'
// 刻意与 PROJ_X 不同：用来测「读取侧看不看 project_key」。
const OTHER_KEY = 'other-key'

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const DIR = arg('dir', join('.probe', 't24-scope'))
const KEEP = process.argv.includes('--keep')

/**
 * 库里要写的五条。**关键性质**：文本两两的 bigram-Jaccard 都在 0.21 以下，
 * 远低于重复压制阈值（DUP_LEX = 0.72，见 search.ts）—— 否则两条相近内容会被压成一条，
 * 「隔离」就测不出来了。这组文本是设计时先量过的量，不是随手挑的：
 * P3 与其余四条的 Jaccard 实测为 0.000（见本任务交付记录），下面四条的既有取值不变。
 *
 * P3 是判据 9 的装置：与 P1 **同 scope、不同 project_key**。现实里调用方一般让
 * projectKey 等于 scope，这里刻意错开 —— 只有错开才能看出读取侧到底看不看这一列。
 *
 * 不写 topicHint：本脚本要顺带走一遍真实的落位路径；五条分到的主题在下面打印出来，
 * 谁和谁并入同一主题不影响判据（判据只看 scope）。
 */
const CARDS = [
  { tag: 'G1', scope: 'global', text: 'npm 依赖解析要开 hoisted，否则装不上。' },
  { tag: 'P1', scope: PROJ_X, text: 'pnpm 的依赖解析策略需要 hoisted，不然包链接会失败。' },
  { tag: 'P2', scope: PROJ_Y, topicHintTag: 'P1', text: '包管理器符号链接创建失败时，先检查依赖解析策略。' },
  { tag: 'G2', scope: 'global', text: 'TypeScript 只在构建期生效，运行期看到的是 dist 里的 JS。' },
  { tag: 'P3', scope: PROJ_X, projectKey: OTHER_KEY, text: '锁文件与清单不一致时，先跑一次安装再看差异。' },
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
    // 不给 projectKey 的卡按「项目键 = scope」的惯例写；P3 例外（见 CARDS 注释）。
    projectKey: c.projectKey ?? (c.scope === 'global' ? undefined : c.scope),
    // P2 强行并入 P1 的主题（topicHint 跳过几何定位）：判据 10 要测「入口段的词条」，
    // 而 topicEntries 按主题全域取词、不看 scope。不把两个域放进同一个主题，那一处
    // 就构造不出来（见判据 10 的注释：这是如实断言现状，不是期望）。
    topicHint: c.topicHintTag === undefined ? undefined : info.find((v) => v.tag === c.topicHintTag)?.topicId,
    sourceRef: 'scope-check/' + c.tag,
  })
  info.push({ ...c, id: r.atomId, topicId: r.topicId, action: r.action })
}

say('写入（真实编码器）：' + CARDS.length + ' 条 —— 落库后的 scope 与 project_key 由库自己回答，不问写入方')
const stored = new Map(
  db
    .prepare('SELECT id, scope, project_key, topic_id, summary FROM atom ORDER BY id')
    .all()
    .map((r) => [
      Number(r.id),
      {
        scope: String(r.scope),
        projectKey: r.project_key === null || r.project_key === undefined ? null : String(r.project_key),
        topic: Number(r.topic_id),
        summary: String(r.summary),
      },
    ]),
)
const tagOf = new Map(info.map((v) => [v.id, v.tag]))
const idOfTag = (t) => info.find((v) => v.tag === t).id
for (const v of info) {
  const row = stored.get(v.id)
  say(
    '  ' +
      v.tag.padEnd(4) +
      ' 写入 scope=' +
      v.scope.padEnd(7) +
      ' 落库 scope=' +
      row.scope.padEnd(7) +
      ' 落库 project_key=' +
      String(row.projectKey).padEnd(9) +
      ' atom=' +
      v.id +
      ' topic=' +
      row.topic,
  )
}

// 声明边（判据 7 与判据 10 的输入装置，见文件头 ②）：
//   G1 → G2 同域（global → global）：过滤生效时应当出现，用来证明「路有内容」。
//   G1 → P2 跨域（global → proj-y）：过滤生效时**不该**出现；不过滤就会泄漏。
// 用 kind = 'related'（GRAPH_KINDS 的成员，且 infer.ts 只建 near，不会撞 UNIQUE）。
// origin = 'declared' 是真相源：graph/infer.ts 重建只删自己的 inferred，不会覆盖它。
const insertEdge = db.prepare(
  'INSERT OR IGNORE INTO edge (src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at)' +
    " VALUES ('atom', ?, 'atom', ?, 'related', 1.0, 'declared', ?)",
)
const edgeNow = Date.now()
insertEdge.run(idOfTag('G1'), idOfTag('G2'), edgeNow)
insertEdge.run(idOfTag('G1'), idOfTag('P2'), edgeNow)

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
  '1 前提：不给 scope 时五条都能召回',
  CARDS.every((c) => has(unscoped, c.tag)),
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
  '6 向量路与入口/正文路都受 scope 约束（图路见判据 7）',
  cGlobal.vec < cAll.vec && cGlobal.entry <= cAll.entry && cGlobal.body <= cAll.body,
  '不给 scope: ' + fmt(cAll) + '  |  global: ' + fmt(cGlobal) + '  |  ' + PROJ_X + ': ' + fmt(cX),
)

// 判据 7：图路有输入，且一跳邻居没有越界。
// 声明边是本脚本自己插的，所以「有输入」这一半不能靠它 —— 这里只数推断边（infer.ts 的产出），
// 保持原判据的含义：小库上建不出推断边时，图路这条链就没被测到，应当红。
const edgeCount = (where) => Number(db.prepare('SELECT COUNT(*) AS n FROM edge WHERE ' + where).get().n)
const inferredAtomAtom = edgeCount("src_type = 'atom' AND dst_type = 'atom' AND origin = 'inferred'")
const declaredAtomAtom = edgeCount("src_type = 'atom' AND dst_type = 'atom' AND origin = 'declared'")
const atomTopic = edgeCount("src_type = 'atom' AND dst_type = 'topic'")
const leak = asGlobal.filter((h) => h.scope !== 'global')
check(
  '7 图路有输入，且邻居不越界（inferred atom↔atom ' +
    inferredAtomAtom +
    ' 条 / declared ' +
    declaredAtomAtom +
    ' 条，域外命中 ' +
    leak.length +
    ' 条）',
  inferredAtomAtom > 0 && leak.length === 0,
  declaredAtomAtom === 0 || leak.length > 0
    ? '越界：' + tags(leak) + ' —— 见文件头 ①'
    : inferredAtomAtom === 0
      ? '本库没建出 inferred atom↔atom 边，这条路没被测到 —— 见文件头 ②'
      : '输入 atom→topic 边 ' + atomTopic + ' 条（不参与图路）',
)

// ── 判据 8：列表路径的 scope 过滤（listAtoms） ──
// 这是三条输出路径里唯一此前没被覆盖的一条（召回侧有判据 1-7，注入侧在判据 10）。
const listTags = (r) => r.rows.map((row) => tagOf.get(row.id) ?? 'atom' + row.id).sort()
const eqList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const L = {
  all: listAtoms(db, { limit: 50 }),
  g: listAtoms(db, { limit: 50, scope: 'global' }),
  x: listAtoms(db, { limit: 50, scope: PROJ_X }),
  y: listAtoms(db, { limit: 50, scope: PROJ_Y }),
}
const listFmt = (r) => listTags(r).join(' ') + '（total ' + r.total + '）'
check(
  '8 列表路径的 scope 过滤：同项目 + global 可见，其他项目不可见',
  L.all.total === CARDS.length &&
    // total 是 COUNT，不是本页条数：本判据在条数超过一页时同样成立。
    eqList(listTags(L.g), ['G1', 'G2']) &&
    L.g.total === 2 &&
    eqList(listTags(L.x), ['G1', 'G2', 'P1', 'P3']) &&
    L.x.total === 4 &&
    eqList(listTags(L.y), ['G1', 'G2', 'P2']) &&
    L.y.total === 3,
  '不给 scope: ' +
    listFmt(L.all) +
    '  |  global: ' +
    listFmt(L.g) +
    '  |  ' +
    PROJ_X +
    ': ' +
    listFmt(L.x) +
    '  |  ' +
    PROJ_Y +
    ': ' +
    listFmt(L.y),
)

// ── 判据 9：project_key 维度 ──
// 如实断言现状，不是断言愿望：写入侧把 project_key 落库了，读取侧（search.ts 四路与 list.ts）
// 都**不看**这一列。所以「同 scope、不同 project_key」的两条在项目域视图里都可见。
// 哪天真按 project_key 过滤了，这条会红 —— 那时应当改的是判据（换成「按 project_key 分组」），
// 而不是把新行为绕过去：判据的价值在于钉住真实行为。
const keyOf = new Map([...stored].map(([id, v]) => [id, v.projectKey]))
const byKey = db
  .prepare('SELECT id FROM atom WHERE project_key = ?')
  .all(OTHER_KEY)
  .map((r) => Number(r.id))
const p3Row = L.x.rows.find((row) => row.id === idOfTag('P3'))
check(
  '9 project_key 维度：写入侧如实落库，读取侧不参与过滤（同 scope 两个不同键都可见）',
  keyOf.get(idOfTag('P1')) === PROJ_X &&
    keyOf.get(idOfTag('P3')) === OTHER_KEY &&
    keyOf.get(idOfTag('G1')) === null &&
    keyOf.get(idOfTag('G2')) === null &&
    // 直接按列查得到：数据确实在库里，缺的是管线里的过滤，不是写入。
    byKey.length === 1 &&
    byKey[0] === idOfTag('P3') &&
    // 召回侧不区分：同 scope 的两个不同 project_key 都在项目域视图里。
    has(asX, 'P1') &&
    has(asX, 'P3') &&
    // 列表行如实映射这一列（界面要显示它）。
    p3Row !== undefined &&
    p3Row.projectKey === OTHER_KEY,
  'P1.project_key=' +
    keyOf.get(idOfTag('P1')) +
    '  P3.project_key=' +
    keyOf.get(idOfTag('P3')) +
    '  G1.project_key=' +
    keyOf.get(idOfTag('G1')) +
    '  |  scope=' +
    PROJ_X +
    ' 下命中：' +
    tags(asX) +
    '  |  按列直查 other-key：' +
    byKey.length +
    ' 条',
)

// ── 判据 10：三处输出路径口径一致 ──
// 锚段：逐条对 hits（且与 assembleView 返回的 anchorIds 一致，不让实现自述等于证据）。
// 入口段：主题标签是写入时从某条 atom 摘要前 16 字派生的（write.ts 的 TOPIC_LABEL_CHARS），
//   所以入口段必然带 atom 的痕迹 —— 要判的不是「带不带」，而是「只来自命中的主题」。
//   入口段的**词条**是按主题全域取的（view.ts 的 topicEntries 只按 topic_id 查，不看 scope）：
//   这是代码上真实存在的口径差异，本判据不覆盖它（构造时需要跨域词条挤进每主题前 N 条，
//   当前五条卡的规模下挤不进去；见交付记录「未确定项」）。
// 路段：**有意**展示 hits 之外的一跳邻居，所以「一致」只能是「同一条 scope 规则」，
//   不是「集合等于 hits」。断言的是：路段里出现的每一条都在允许的 scope 内。
// 显式传 tier = 'full'：本判据测过滤口径，不测预算降级 —— 档位一旦落到 brief/excerpt，
// 路段会被 pathsOff 关掉，判据就变成「没测到却通过」。
const HEADS = ['【锚】', '【入口】', '【路】']
function sections(text) {
  const out = { anchor: [], entry: [], path: [] }
  let cur = null
  for (const line of String(text).split('\n')) {
    if (HEADS.includes(line)) {
      cur = line === '【锚】' ? 'anchor' : line === '【入口】' ? 'entry' : 'path'
      continue
    }
    if (cur !== null) out[cur].push(line)
  }
  return out
}
const anchorIdsIn = (lines) =>
  lines
    .filter((l) => l.startsWith('- ['))
    .map((l) => {
      const m = /^- \[(\d+)/.exec(l)
      return m === null ? -1 : Number(m[1])
    })
    .filter((n) => n >= 0)
// 指纹 = 摘要前 8 个码点。摘要是正文的第一句（首句即全文时就是去掉句末标点），
// 因此它既是锚段正文的前缀，也是路段摘要的前缀。五条卡的指纹互不相同。
const fpOf = (id) =>
  Array.from(stored.get(id)?.summary ?? '')
    .slice(0, 8)
    .join('')
const tagsIn = (lines) => info.filter((c) => lines.join('\n').includes(fpOf(c.id))).map((c) => c.tag)
const scopeAllowed = (tag) => {
  const s = stored.get(idOfTag(tag)).scope
  return s === PROJ_X || s === 'global'
}
const recalledX = recall(db, QUERY, qv, { topN: 24, scope: PROJ_X })
const viewX = assembleView(db, recalledX, { scope: PROJ_X, tier: 'full' })
// 对照：同一份召回结果，注入侧**不传** scope。这是 tools/index.ts 今天的形态
// （assembleView 的调用只给 budget 与 briefMin），用来证明本判据确实能测到「不过滤会泄漏」。
const viewNoScope = assembleView(db, recalledX, { tier: 'full' })
const SX = sections(viewX.text)
const SN = sections(viewNoScope.text)
const anchorIn = anchorIdsIn(SX.anchor)
const hitsX = new Set(recalledX.hits.map((h) => h.id))
// 入口段：只允许展示「命中主题」的标签（主题 label 只来自 recalled.topics）。
const entryLabels = SX.entry
  .filter((l) => l.startsWith('['))
  .map((l) => {
    const m = /^\[([^\]]*)\]/.exec(l)
    return m === null ? '' : m[1]
  })
const labelOfHits = recalledX.topics.map((t) => Array.from(t.label).slice(0, 16).join(''))
const entryLabelsOk =
  entryLabels.length > 0 && entryLabels.every((lbl) => labelOfHits.some((full) => full.startsWith(lbl)))
const pathTags = tagsIn(SX.path)
const wholeTags = tagsIn(String(viewX.text).split('\n'))
const leakTags = wholeTags.filter((t) => !scopeAllowed(t))
// 路段的前提：**对照**里（同一份召回、注入侧不传 scope）跨域邻居出现了 —— 那才证明
// 这条链被测到。过滤生效时路段本身可以为空，那不是「没测到」。
const noScopePathTags = tagsIn(SN.path)
check(
  '10 三处输出路径口径一致（锚对 hits、入口只来自命中主题、路段只出现同域邻居）',
  // 锚段：文本里的 id 与返回值一致，且每一条都来自 hits。
  eqList(anchorIn, [...viewX.anchorIds]) &&
    anchorIn.every((id) => hitsX.has(id)) &&
    // 入口段：只展示命中主题的标签。
    entryLabelsOk &&
    // 路段：对照里有内容（输入证据），且本视图里出现的每一条都同域。
    noScopePathTags.length > 0 &&
    leakTags.length === 0 &&
    pathTags.every((t) => scopeAllowed(t)),
  '锚段 id [' +
    anchorIn.join(',') +
    '] / hits ' +
    recalledX.hits.length +
    ' 条；入口段主题标签 ' +
    entryLabels.length +
    ' 个（都来自命中主题）；路段 ' +
    SX.path.filter((l) => l !== '').length +
    ' 行（' +
    (pathTags.join(' ') || '空') +
    '）；域外 ' +
    leakTags.length +
    ' 条；对照（注入侧不传 scope）路段：' +
    (noScopePathTags.join(' ') || '（空）') +
    ' —— 对照非空才说明路段这条链被测到',
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

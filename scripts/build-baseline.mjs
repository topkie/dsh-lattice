// 标准验证库的构建器。
//
// 为什么需要它：验证与对比都建立在「基准库与待测代码同规则」这个前提上。库文件一旦
// 由旧规则生成、又拿它当基准，测出来的差值可能全部来自规则差异，而不是被验证的那次改动。
// 本脚本把生成方式固定下来 —— 来源、命令、产出路径，以及**记进库里的规则版本**，
// 让「这个库是哪套规则建的」从需要记忆的判断，降为可以查到的事实。
//
// **重建 ≠ 对照物**：这个库会被按当前规则重建，所以它不能充当「改动前」。
// 要做改动前后的对比，先跑 scripts/snapshot-baseline.mjs 另存一份快照。
//
// 用法：
//   node scripts/build-baseline.mjs --source <cards.json> [--out <dir>] [--label <名字>] [--mock]
//
// 输入：一份 JSON 数组，字段宽松（缺的按默认值补）：
//   [{
//     "path": "唯一标识", "title": "标题", "kind": "结论", "text": "正文（Markdown）",
//     "origin": "import", "scope": "global",
//   }]
//
// origin / scope **原样透传**：卡上写了就用卡上的，卡上没写才回落到 import / global。
// 为什么不让构建器自己判定：它不是推断来源的地方。一份构造出来的语料，它的来源与
// 作用域是造语料的人定下的**约定**，构建器只负责把这个约定记进库 —— 一旦在这里
// 改成「按文本猜」，库里的 origin 就从「谁写的」变成了「看起来像谁写的」，
// 而依赖这个字段的审核与统计都无从察觉。
// 回落值 import / global 的含义是「既不是用户说的、也不是模型推断的，且无项目域」，
// 不是「已经查过作者」。
//
// 产出（默认 .probe/baseline/）：
//   lattice.db        基准库
//   build-report.json 本次构建的自检结果
//
// 自检三条（任一不过即非零退出）：
//   1. 库记录的入口规则 == 当前代码的 ENTRY_RULE_ID
//   2. schema 对象齐全
//   3. 来源文档的每个小节能被定位到某条 atom 正文里（不丢知识的机械判据）
//
// --mock 用构造向量跑通链路（快，只验流程）；不带则用真实编码器（慢，验质量）。
// **mock 建的库不能当基准**：它的向量是假的，召回数字没有意义。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { checkEntryRule, setBuildInfo } from '../dist/db/build-info.js'
import { listObjects, openVault } from '../dist/db/open.js'
import { SCHEMA_VERSION } from '../dist/db/schema.js'
import { draftAtoms, stripFrontmatter } from '../dist/migrate/split.js'
import { ENTRY_RULE_ID } from '../dist/pipeline/entries.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { VEC_DIM } from '../dist/util/vec.js'

const BUILDER = 'scripts/build-baseline.mjs'
const MODEL = 'Xenova/bge-small-zh-v1.5'
/** 卡上没写 origin / scope 时的回落值；含义见文件头「原样透传」一节。 */
const DEFAULT_ORIGIN = 'import'
const DEFAULT_SCOPE = 'global'
/** 批量编码的分块大小：一次喂太多会让 ONNX 运行时占用陡增。 */
const ENCODE_CHUNK = 32

/** 建库期望的 schema 对象下限；少于这个数说明 DDL 没跑全。 */
const MIN_OBJECTS = { table: 14, index: 10, trigger: 6 }

function parseArgs(argv) {
  const out = { out: join('.probe', 'baseline'), mock: false, label: '', source: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mock') out.mock = true
    else if (a === '--source') out.source = argv[++i] ?? ''
    else if (a === '--out') out.out = argv[++i] ?? out.out
    else if (a === '--label') out.label = argv[++i] ?? ''
  }
  return out
}

/** 取卡上的字符串字段：非空串才算「写了」，其余一律回落。 */
function pickString(v, fallback) {
  return typeof v === 'string' && v !== '' ? v : fallback
}

/** 构造向量：仅 --mock 使用，跑通链路而不等模型。 */
function hashVec(text) {
  const v = new Float32Array(VEC_DIM)
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  for (let i = 0; i < v.length; i++) {
    h ^= i + 1
    h = Math.imul(h, 16777619) >>> 0
    v[i] = ((h % 2000) - 1000) / 1000
  }
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

/** 真实编码器；返回 text → 向量 的回调。分批编码，避免一次性占满内存。 */
async function realEncoder(texts) {
  const { encodeBatch, ensureEncoder } = await import('../dist/encoder/index.js')
  const t0 = Date.now()
  const ok = await ensureEncoder({ model: MODEL })
  if (!ok) throw new Error('编码器不可用：没有它建不出可用的基准库（--mock 只能验流程）')
  console.log('  编码器就绪 ' + (Date.now() - t0) + ' ms')
  const cache = new Map()
  const tEnc = Date.now()
  const batches = Math.ceil(texts.length / ENCODE_CHUNK)
  for (let i = 0; i < texts.length; i += ENCODE_CHUNK) {
    const chunk = texts.slice(i, i + ENCODE_CHUNK)
    const vecs = await encodeBatch(chunk, { model: MODEL })
    chunk.forEach((t, j) => cache.set(t, vecs[j] ?? null))
    // 编码是整条链路里最慢也最静的一段（分批调模型），没有进度就分不清「慢」与「卡死」。
    const done = Math.min(i + ENCODE_CHUNK, texts.length)
    if ((i / ENCODE_CHUNK) % 20 === 19 || done === texts.length) {
      const per = (Date.now() - tEnc) / done
      console.log(
        '  编码 ' +
          done +
          '/' +
          texts.length +
          ' 批 ' +
          batches +
          ' 均摊 ' +
          per.toFixed(1) +
          ' ms/条 预计剩余 ' +
          Math.round((per * (texts.length - done)) / 1000) +
          ' 秒',
      )
    }
  }
  return async (t) => cache.get(t) ?? null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.source === '') {
    console.error('缺少 --source <cards.json>，用法见本文件头部注释。')
    process.exit(2)
  }
  if (!existsSync(args.source)) {
    console.error('源文件不存在：' + args.source)
    process.exit(2)
  }
  const label = args.label !== '' ? args.label : basename(args.source)
  const cards = JSON.parse(readFileSync(args.source, 'utf8'))
  if (!Array.isArray(cards)) throw new Error('源文件应为一个 JSON 数组')

  // 切分。先剥 frontmatter：不剥的话它会自成一条无意义的 atom。
  const drafts = []
  for (const c of cards) {
    const { meta, body } = stripFrontmatter(String(c.text ?? ''))
    const kind = String(meta.kind ?? c.kind ?? '知识')
    // 空串与不写同义：一个空的 origin 不是「来源是空」，而是「卡没声明」。
    const origin = pickString(c.origin, DEFAULT_ORIGIN)
    const scope = pickString(c.scope, DEFAULT_SCOPE)
    // 卡片标题跟着草稿走：库里的 atom 表没有 title 列，标题只用于事后做「标题→atom」的
    // 对齐（标定要的相关样本就靠它），所以随 atom-map.json 一起写出，不进库。
    const cardPath = String(c.path ?? '')
    const cardTitle = pickString(c.title, '')
    for (const d of draftAtoms(cardPath, body)) drafts.push({ ...d, kind, origin, scope, cardTitle })
  }
  console.log('来源 ' + cards.length + ' 篇 → 切出 atom 草稿 ' + drafts.length + ' 条')

  const encode = args.mock ? async (t) => hashVec(t) : await realEncoder(drafts.map((d) => d.text))

  rmSync(args.out, { recursive: true, force: true })
  mkdirSync(args.out, { recursive: true })
  const dbFile = join(args.out, 'lattice.db')
  const { db } = openVault(dbFile)
  const ctx = createWriteCtx(db, {}, { encode })
  const actions = { joined: 0, created: 0 }
  const atomMap = []
  const t1 = Date.now()
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]
    const r = await writeAtom(ctx, {
      text: d.text,
      kind: d.kind ?? '知识',
      source: label,
      sourceRef: d.sourcePath,
      // 来源与作用域一律来自卡（见文件头）。写死 'import' 会让库永远是单一来源，
      // 而这正是「来源 ≥ 2 类」测不出来的原因。
      origin: d.origin,
      scope: d.scope,
    })
    actions[r.action]++
    atomMap.push({ atomId: r.atomId, action: r.action, cardPath: d.sourcePath, cardTitle: d.cardTitle ?? '' })
    // 逐条写入的代价是**平方级**的：writeAtom 每次都要重建全库词表（entries.ts 的
    // buildVocabIndex，注释自认「库大到成为瓶颈时再引入汇总表」）。所以这里必须报均摊
    // 与剩余时间，否则「建 6000 条要一小时」和「卡死」在终端上长得一样。
    if ((i + 1) % 100 === 0 || i + 1 === drafts.length) {
      const per = (Date.now() - t1) / (i + 1)
      console.log(
        '  落库 ' +
          (i + 1) +
          '/' +
          drafts.length +
          ' 均摊 ' +
          per.toFixed(1) +
          ' ms/条 预计剩余 ' +
          Math.round((per * (drafts.length - i - 1)) / 1000) +
          ' 秒',
      )
    }
  }
  console.log('  落库完成 ' + drafts.length + ' 条，' + (Date.now() - t1) + ' ms')
  writeFileSync(join(args.out, 'atom-map.json'), JSON.stringify(atomMap), 'utf8')

  // ── 写自描述 ──
  // 版本号不写：唯一真相源是 PRAGMA user_version（旧实现把它复制进 meta，真实库里漂成 4 与 3）。
  const now = Date.now()
  setBuildInfo(db, { entryRule: ENTRY_RULE_ID, builder: BUILDER, builtAt: now, source: label })

  // ── 自检 ──
  const counts = {}
  for (const o of listObjects(db)) counts[o.type] = (counts[o.type] ?? 0) + 1
  const objectsOk = Object.entries(MIN_OBJECTS).every(([t, n]) => (counts[t] ?? 0) >= n)
  const rule = checkEntryRule(db, ENTRY_RULE_ID)

  // 定位性：来源文档的每个 H2 标题，能不能在某个 atom 的正文里找到。
  // 这是「不丢知识」的机械判据 —— 不靠人眼扫，脚本自己核。
  //
  // **对没有 H2 小节语料这条判据不适用**（实测：新闻正文一个 `##` 都没有，0/0 曾被
  // 当成「通过」）。空集通过是恒真判据 —— 它测不出任何东西，却会印一行 OK。所以这里
  // 显式区分「适用且全中」与「不适用」，不适用时报告与退出码都不把它算作通过。
  const one = (sql) => Number(db.prepare(sql).get().n)
  const joined = db
    .prepare('SELECT text FROM atom')
    .all()
    .map((r) => String(r.text))
    .join('\n')
  let h2 = 0
  let located = 0
  const missing = []
  for (const c of cards) {
    const { body } = stripFrontmatter(String(c.text ?? ''))
    for (const line of body.split('\n')) {
      if (!/^##\s+\S/.test(line)) continue
      h2++
      const heading = line.replace(/^##\s+/, '').trim()
      if (joined.includes(heading)) located++
      else missing.push(String(c.path ?? '') + ' :: ' + heading)
    }
  }

  const locApplicable = h2 > 0

  const stat = {
    label,
    source: resolve(args.source),
    builtAt: new Date(now).toISOString(),
    mock: args.mock,
    schemaVersion: SCHEMA_VERSION,
    entryRule: ENTRY_RULE_ID,
    ruleOk: rule.ok,
    objects: counts,
    atoms: one('SELECT COUNT(*) AS n FROM atom'),
    topics: one('SELECT COUNT(*) AS n FROM topic'),
    entries: one('SELECT COUNT(*) AS n FROM entry'),
    actions,
    localization: {
      applicable: locApplicable,
      h2,
      located,
      missing: missing.length,
      samples: missing.slice(0, 10),
    },
    atomMap: 'atom-map.json',
  }
  writeFileSync(join(args.out, 'build-report.json'), JSON.stringify(stat, null, 2), 'utf8')

  console.log('')
  console.log('=== 自检 ===')
  console.log('  入口规则   ' + (rule.ok ? 'OK ' : '不一致 ') + ENTRY_RULE_ID)
  console.log('  schema     ' + (objectsOk ? 'OK ' : '缺对象 ') + JSON.stringify(counts))
  console.log(
    '  定位性     ' +
      (locApplicable
        ? located + '/' + h2 + (missing.length > 0 ? '（缺 ' + missing.length + '）' : '')
        : '不适用（来源没有任何 H2 小节，此判据对本次语料测不出东西）'),
  )
  console.log('  atom ' + stat.atoms + ' / topic ' + stat.topics + ' / entry ' + stat.entries)
  if (missing.length > 0) {
    console.log('  缺失样例（前 5）：')
    for (const m of missing.slice(0, 5)) console.log('    ' + m)
  }
  if (args.mock) console.log('  注意：这是 mock 库，向量为构造值，不可当基准。')
  console.log('  报告 → ' + join(args.out, 'build-report.json'))
  db.close()

  // 定位性只在适用时参与判定；不适用不等于通过，报告里 applicable=false 如实记。
  const ok = rule.ok && objectsOk && (locApplicable ? missing.length === 0 : true)
  if (!ok) {
    console.error('自检未通过。')
    process.exitCode = 1
  }
}

await main()

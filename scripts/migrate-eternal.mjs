// 从 memory-eternal 迁移现有卡片到 dsh-lattice。
//
// 流程：导出（只读 API）→ 按 H2 切分 → 编码 → 落库 → 校验定位性。
//
// 三条纪律：
//   1. **只读原库**：全程只调 GET 端点，不写 memory-eternal
//   2. **导出可缓存**：`--export` 把卡片文本存成 JSON，之后离线跑，便于重试与复现
//   3. **校验不靠人眼**：T9 的判据是「每个原 H2 小节都能定位」，脚本自己核
//
// 用法：
//   node scripts/migrate-eternal.mjs --export           仅导出
//   node scripts/migrate-eternal.mjs --mock             用构造向量跑通链路（快，验流程）
//   node scripts/migrate-eternal.mjs                    真实模型迁移（慢，验质量）
//   node scripts/migrate-eternal.mjs --verify-only      只校验已有库

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { encodeBatch } from '../dist/encoder/index.js'
import { draftAtoms, stripFrontmatter } from '../dist/migrate/split.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { VEC_DIM } from '../dist/util/vec.js'

const API = 'http://127.0.0.1:19387/memory-eternal/api'
const OUT = '.probe'
const EXPORT_FILE = join(OUT, 'eternal-cards.json')
const DB_DIR = join(OUT, 'migrated')
const DB_FILE = join(DB_DIR, 'lattice.db')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
mkdirSync(OUT, { recursive: true })

/** 导出：只读 API，把卡片全文抓下来缓存。 */
async function doExport() {
  const list = await (await fetch(API + '/cards')).json()
  const cards = list.cards ?? []
  const out = []
  for (const c of cards) {
    const r = await fetch(API + '/card?path=' + encodeURIComponent(c.path))
    const j = await r.json()
    if (j.ok !== true) {
      console.log('跳过（读取失败）:', c.path)
      continue
    }
    out.push({
      path: c.path,
      title: c.title ?? '',
      kind: c.kind ?? '',
      tags: c.tags ?? [],
      text: j.text ?? '',
    })
  }
  writeFileSync(EXPORT_FILE, JSON.stringify(out, null, 1), 'utf8')
  console.log('已导出', out.length, '张卡 →', EXPORT_FILE)
  return out
}

function loadCards() {
  if (!existsSync(EXPORT_FILE)) throw new Error('没有导出文件，先跑 --export')
  return JSON.parse(readFileSync(EXPORT_FILE, 'utf8'))
}

/** 构造向量：用于 --mock，跑通链路而不等模型。 */
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

/** 校验：原 H2 小节能否在每个 atom 里定位。 */
function verify(cards, db) {
  const atoms = db
    .prepare('SELECT id, text FROM atom')
    .all()
    .map((r) => ({ id: Number(r.id), text: String(r.text) }))
  const joined = atoms.map((a) => a.text).join('\n')
  let h2 = 0
  let located = 0
  const missing = []
  for (const c of cards) {
    const lines = stripFrontmatter(String(c.text)).body.split('\n')
    for (const line of lines) {
      if (!/^##\s+\S/.test(line)) continue
      h2++
      const heading = line.replace(/^##\s+/, '').trim()
      if (joined.includes(heading)) located++
      else missing.push(c.path + ' :: ' + heading)
    }
  }
  const topics = Number(db.prepare('SELECT COUNT(*) AS n FROM topic').get().n)
  const entries = Number(db.prepare('SELECT COUNT(*) AS n FROM entry').get().n)
  return { atoms: atoms.length, h2, located, missing, topics, entries }
}

async function main() {
  let cards = existsSync(EXPORT_FILE) ? loadCards() : []
  if (has('--export') || cards.length === 0) cards = await doExport()
  if (has('--export')) return
  console.log('卡片', cards.length, '张')

  // 切分
  const drafts = []
  for (const c of cards) {
    // 先剥 frontmatter，否则它会自成原子（实测占 57 个无意义 atom）。
    const { meta, body } = stripFrontmatter(c.text)
    const kind = String(meta.kind ?? c.kind ?? '知识')
    for (const d of draftAtoms(c.path, body)) drafts.push({ ...d, kind })
  }
  const charLens = drafts.map((d) => d.text.length)
  console.log(
    '切出 atom 草稿',
    drafts.length,
    '个，字符数 p50 =',
    charLens.sort((a, b) => a - b)[Math.floor(charLens.length / 2)],
  )

  if (has('--verify-only')) {
    const { db } = openVault(DB_FILE)
    const v = verify(cards, db)
    report(v)
    db.close()
    return
  }

  // 落库
  rmSync(DB_DIR, { recursive: true, force: true })
  mkdirSync(DB_DIR, { recursive: true })
  const { db } = openVault(DB_FILE)
  const mock = has('--mock')
  let encode
  if (mock) {
    encode = async (t) => hashVec(t)
    console.log('模式：mock（构造向量，验流程）')
  } else {
    const { ensureEncoder } = await import('../dist/encoder/index.js')
    const model = 'Xenova/bge-small-zh-v1.5'
    const t0 = Date.now()
    const ok = await ensureEncoder({ model })
    console.log('编码器:', ok ? 'ready' : '不可用', '(', Date.now() - t0, 'ms )')
    encode = ok ? (t) => encodeBatch([t], { model }).then((r) => r[0] ?? null) : async () => null
  }
  const ctx = createWriteCtx(db, {}, { encode })
  const t1 = Date.now()
  const actions = { joined: 0, created: 0 }
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]
    const r = await writeAtom(ctx, {
      text: d.text,
      kind: d.kind ?? '知识',
      source: 'migrate',
      sourceRef: d.sourcePath,
    })
    actions[r.action]++
    if ((i + 1) % 50 === 0) console.log('  已写入', i + 1, '/', drafts.length)
  }
  const ms = Date.now() - t1
  console.log(
    '写入完成',
    drafts.length,
    '条，用时',
    ms,
    'ms（均值',
    (ms / drafts.length).toFixed(1),
    'ms/条）',
  )
  console.log('动作:', JSON.stringify(actions))

  const v = verify(cards, db)
  report(v)
  db.close()
}

function report(v) {
  console.log('')
  console.log('=== T9 判据 ===')
  console.log('原 H2 小节:', v.h2, ' | 可定位:', v.located, ' | 缺失:', v.missing.length)
  if (v.missing.length > 0) {
    console.log('缺失清单（前 10）:')
    for (const m of v.missing.slice(0, 10)) console.log('  ' + m)
  }
  console.log('atom:', v.atoms, ' | topic:', v.topics, ' | entry:', v.entries)
}

await main()

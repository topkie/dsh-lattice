// 候选召回率：目标在余弦上排到十几名时，还进不进得了候选池。
//
// 为什么这条要进门禁：现在所有判据（命中率、判空率、预算利用率）都量在**注入结果**上，
// 而注入结果的上游是候选池。候选池里没有的条目，后面的判定与排序再准也拿不到它。
// 三库对照里候选池命中 95%/100%/95%、注入命中 90%/100%/95% —— 这两个数只由人手跑一次，
// 门禁里没有任何一项会因为「候选生成退化」变红。
//
// 守的是 K_VEC 那条边界。K_VEC 自己的登记里写着「库长大时固定取前 N 会让召回质量悄悄退化」，
// 而这句话此前没有任何检查在守：向量粗筛宽度被调小，注入结果只会安静地变差。
//
// 为什么不用真实模型：门禁必须确定性、离线、秒级。这里直接往库里写合成向量与词条。
// 为什么不用 writeAtom 造数据：写入侧的写前校验按余弦 0.78 判同一条，这批条目会被合并掉。
//
// 用法：
//   node scripts/check-candidate-recall.mjs           通过则 exit 0
//   node scripts/check-candidate-recall.mjs --starve  把向量粗筛压到 8 条，必须变红
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { invalidateVecCache, recall } from '../dist/pipeline/search.js'
import { VEC_DIM } from '../dist/util/vec.js'

const STARVE = process.argv.includes('--starve')
const N_DISTRACT = 14
const TOP_N = 24
const WANT = 20

/** 与查询余弦固定为 cos 的单位向量：第一维放 cos，其余放 sin（按 i 错开，互不相同）。 */
function vecAt(cos, i) {
  const v = new Float32Array(VEC_DIM)
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos))
  v[0] = cos
  v[1 + (i % (VEC_DIM - 1))] = sin
  return v
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-cand-'))
const dbFile = join(dir, 'lattice.db')
const { db } = openVault(dbFile)
const now = Date.now()

db.prepare(
  'INSERT INTO topic(id, domain_id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at) VALUES (1, NULL, ?, zeroblob(2048), 1, 0.8, ?, ?)',
).run('合成', now, now)

/** 直接插一行 atom 与词条、正文，绕开写入侧的去重与抽词。 */
function seed(text, vec, terms) {
  const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
  const r = db
    .prepare(
      "INSERT INTO atom(kind, text, summary, embedding, topic_id, fit, scope, project_key, source, source_ref, polarity, flags, created_at, updated_at) VALUES ('结论', ?, ?, ?, 1, 0.8, 'global', NULL, NULL, NULL, NULL, 0, ?, ?)",
    )
    .run(text, text.slice(0, 40), blob, now, now)
  const id = Number(r.lastInsertRowid)
  db.prepare("INSERT INTO atom_topic(atom_id, topic_id, weight, origin) VALUES (?, 1, 1.0, 'primary')").run(
    id,
  )
  // 正文路走 atom_fts，它的外部内容表是 atom_search —— 直插 atom 不会自动填它。
  db.prepare('INSERT INTO atom_search(id, body) VALUES (?, ?)').run(id, text)
  // 词条按两字切：entry.bigram 存的是两字词，查询侧也按两字切。
  for (const t of terms) {
    db.prepare(
      "INSERT INTO entry(atom_id, term, bigram, weight, origin, hits, last_seen, created_at) VALUES (?, ?, ?, 0.6, 'extracted', 0, NULL, ?)",
    ).run(id, t, t, now)
  }
  return id
}

// 十四条干扰项的余弦比目标高一个档次，目标因此在向量路排第 15。
for (let i = 0; i < N_DISTRACT; i++)
  seed('干扰条目 ' + i + '：比目标更接近查询，但讲的是别的事。', vecAt(0.99, i), ['干扰' + i])
const target = seed('棱镜色散实验证明了介质对不同波长的折射率不同。', vecAt(0.95, 0), [
  '棱镜',
  '色散',
  '折射',
])
for (let i = 0; i < 60; i++) seed('填充条目 ' + i + '：与查询无关的内容。', vecAt(0.3, i), ['填充' + i])
invalidateVecCache(db)

const query = '棱镜色散是怎么回事'
const qv = vecAt(1, 0)
// --starve 把三路粗筛同时压到最窄：只压向量路的话，目标还会被入口路或图路带进来
// （这正是多路的意义），量不出退化。这条检查守的是「所有路都变窄」时的下限。
const opts = STARVE ? { topN: TOP_N, kVec: 8, kLex: 0, kGraph: 0 } : { topN: TOP_N }
const r = recall(db, query, qv, opts)

const rank = r.hits.findIndex((h) => h.id === target)
const reachable = rank >= 0
const passed = reachable && rank < WANT
const counts = r.meta.counts

console.log(
  '候选池 ' +
    r.hits.length +
    ' 条（topN ' +
    TOP_N +
    (STARVE ? '，三路粗筛压到最窄' : '') +
    '），目标名次 ' +
    (reachable ? rank + 1 : '不在池内'),
)
console.log(
  '各路口径：向量 ' +
    counts.vec +
    ' / 入口 ' +
    counts.entry +
    ' / 正文 ' +
    counts.body +
    ' / 图 ' +
    counts.graph,
)
db.close?.()
rmSync(dir, { recursive: true, force: true })

// 入口路仍然在工作：它不进排序，但决定了候选池里有没有这个人。
// 正文路在这类查询上本来就缺席 —— 它只喂 ≥3 字符的词，而「棱镜色散是怎么回事」切出来的
// 全是两字词（见 pipeline/search.ts 的 bodyPath），所以这里不要求它命中，只打印。
if (!STARVE && counts.entry < 1) {
  console.log('入口路退化：应当至少命中目标这一条，实际 0 条')
  process.exit(1)
}

if (STARVE) {
  // 反向自检：粗筛压到 8 条后目标必须掉出候选池，否则说明这条判据量不到粗筛宽度退化。
  if (passed) {
    console.log('判据失效：向量粗筛压到 8 条后目标仍在前 ' + WANT + ' 名，这条检查量不出退化')
    process.exit(1)
  }
  console.log('反向自检通过：向量粗筛压到 8 条后目标掉出候选池')
  process.exit(0)
}

if (!passed) {
  console.log(
    '候选召回率不达标：目标余弦排第 15，应当进前 ' +
      WANT +
      ' 名，实际' +
      (reachable ? '第 ' + (rank + 1) + ' 名' : '不在候选池里（向量粗筛宽度不够）'),
  )
  process.exit(1)
}
console.log('候选召回率通过：目标余弦排第 15，进前 ' + WANT + ' 名')

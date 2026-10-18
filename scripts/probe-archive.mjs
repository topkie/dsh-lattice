// 归档（T26）的观测量：打印判据 1 / 2 / 3 / 4 / 7 的原始输入与输出。
//
// 与 test/archive.test.mjs 的分工：那边是断言（进 CI），这边是把同一批输入下的
// 中间结果原样打出来，供人核对「到底看到了什么」。不联网、不依赖编码模型（向量由脚本注入），
// 也**不进** scripts/check-all.mjs —— 它没有失败模式，绿不绿不是它的职责。
//
// 用法：node scripts/probe-archive.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { VEC_DIM } from '../dist/util/vec.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { DUP_COS, DUP_LEX, recall } from '../dist/pipeline/search.js'
import { assembleView } from '../dist/pipeline/view.js'
import { setArchived } from '../dist/pipeline/archive.js'
import { listAtoms } from '../dist/pipeline/list.js'
import { inferEdges } from '../dist/graph/infer.js'

const oneHot = (i) => {
  const v = new Float32Array(VEC_DIM)
  v[i] = 1
  return v
}
const dir = mkdtempSync(join(tmpdir(), 't26-evidence-'))
const db = openVault(join(dir, 'lattice.db')).db
const V = oneHot(7)
const encode = async (t) => (t.includes('系统代理') ? V : oneHot(8))
const ctx = createWriteCtx(db, {}, { encode })
const a = (await writeAtom(ctx, { text: '系统代理必须走本地端口，否则访问境外源会直接超时。' })).atomId
const b = (await writeAtom(ctx, { text: '棱镜色散实验的读数记录在实验本第三页。' })).atomId
// 不打印临时库路径：那是本机路径，与判据无关，也不该出现在贴给别人看的输出里。
console.log('atom id：代理那条=' + a + '，无关那条=' + b)

const before = recall(db, '代理', V, {})
const viewBefore = assembleView(db, before, {}).text
console.log('\n[判据 1] 归档前 recall hits = ' + JSON.stringify(before.hits.map((h) => h.id)))
console.log('[判据 1] 归档前注入文本：\n' + viewBefore)

console.log(
  '\n[判据 2] 归档前 atom/entry/atom_topic 行数 = ' +
    ['atom', 'entry', 'atom_topic']
      .map((t) => t + '=' + Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n))
      .join(' '),
)
const vecBefore = db.prepare('SELECT hex(embedding) AS h FROM atom WHERE id = ?').get(a).h
console.log(
  '[判据 2] 归档前向量列 sha 前缀 = ' +
    vecBefore.slice(0, 32) +
    '…（长度 ' +
    vecBefore.length +
    ' 十六进制字符）',
)

setArchived(db, { atomId: a, archived: true })
const after = recall(db, '代理', V, {})
const viewAfter = assembleView(db, after, {}).text
console.log(
  '\n[判据 1] 归档后 recall hits = ' + JSON.stringify(after.hits.map((h) => h.id)) + '（代理那条不在其中）',
)
console.log('[判据 1] 归档后注入文本：\n' + viewAfter)
console.log('[判据 1] 归档后文本里还有「代理」吗：' + viewAfter.includes('代理'))
console.log(
  '[判据 2] 归档后 atom/entry/atom_topic 行数 = ' +
    ['atom', 'entry', 'atom_topic']
      .map((t) => t + '=' + Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n))
      .join(' '),
)
console.log(
  '[判据 2] 归档后向量列与归档前相同：' +
    (db.prepare('SELECT hex(embedding) AS h FROM atom WHERE id = ?').get(a).h === vecBefore),
)
console.log('[判据 4] 默认列表 total = ' + listAtoms(db, { limit: 50 }).total)
console.log('[判据 4] includeArchived total = ' + listAtoms(db, { includeArchived: true, limit: 50 }).total)
console.log(
  '[判据 4] flags=16 total = ' +
    listAtoms(db, { flags: 16, limit: 50 }).total +
    '，行 id = ' +
    JSON.stringify(listAtoms(db, { flags: 16, limit: 50 }).rows.map((r) => r.id)),
)

setArchived(db, { atomId: a, archived: false })
const again = recall(db, '代理', V, {})
const viewAgain = assembleView(db, again, {}).text
console.log('\n[判据 3] 恢复后 recall hits = ' + JSON.stringify(again.hits.map((h) => h.id)))
console.log('[判据 3] 恢复后文本与归档前逐字符相同：' + (viewAgain === viewBefore))

const V2 = oneHot(40)
const ctx2 = createWriteCtx(db, {}, { encode: async () => V2 })
const ids = []
for (const text of ['甲：同一方向的记忆第一条。', '乙：同一方向的记忆第二条。', '丙：同一方向的记忆第三条。'])
  ids.push((await writeAtom(ctx2, { text })).atomId)
setArchived(db, { atomId: ids[1], archived: true })
const outcome = inferEdges(db, { dupCos: DUP_COS, dupLex: DUP_LEX })
const edges = Number(
  db
    .prepare(
      "SELECT COUNT(*) AS n FROM edge WHERE origin = 'inferred' AND ((src_type = 'atom' AND src_id = ?) OR (dst_type = 'atom' AND dst_id = ?))",
    )
    .get(ids[1], ids[1]).n,
)
console.log(
  '\n[判据 7] 全量重建 status = ' + outcome.status + '；归档 atom #' + ids[1] + ' 的边数 = ' + edges,
)

db.close()
rmSync(dir, { recursive: true, force: true })

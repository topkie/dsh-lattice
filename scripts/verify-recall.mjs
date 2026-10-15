// 用真实模型验证召回：已知查询能否命中它该命中的那条记忆。
//
// 这是 T6 的验收判据。与单元测试的分工不变：单测用注入向量验分支，
// 这里用真实语义验「用户这么问，能不能问到」。
// 用法：node scripts/verify-recall.mjs

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { recall } from '../dist/pipeline/search.js'

const OUT = '.probe'
mkdirSync(OUT, { recursive: true })
const model = 'Xenova/bge-small-zh-v1.5'
const enc = (t) => encode(t, { model })
console.log('encoder:', (await ensureEncoder({ model })) ? 'ready' : 'unavailable')

/** 库内容：每条记忆带一个稳定标签，查询用标签来核对。 */
const NOTES = [
  ['pnpm', 'pnpm 的 nodeLinker 必须设为 hoisted，否则创建符号链接会失败。'],
  ['ts', 'TypeScript 只在构建期生效，运行期看到的是 dist 里的 JS 产物。'],
  ['wal', 'SQLite 的 WAL 模式允许一写多读，读操作不会阻塞写入。'],
  ['busy', 'busy_timeout 设为 5 秒，写入是毫秒级的，足够排队。'],
  ['cos', '余弦相似度在高维空间区分度不强，同域不同主题也可能接近 0.7。'],
  ['cls', 'bge 系列模型必须用 CLS 池化，均值池化会给出错误的相似度排序。'],
  ['ortho', '记忆卡的主题应当尽量正交，内容解耦，避免一张卡讲两件事。'],
  ['cleanup', '中间产物在一轮工作结束后清理，可复用脚本与环境要保留。'],
  ['sandbox', '受限沙箱里子进程的管道捕获会失败，改成单进程顺序执行。'],
  ['proxy', '系统代理必须走本地端口，否则访问境外源会直接超时。'],
  ['fts', 'FTS5 的 trigram 分词器对两字中文查询返回零命中。'],
  ['blob', '在 UPDATE 里绑定 BLOB 参数会静默不生效，要改成读改写。'],
]

/** 查询 → 期望命中的标签。用「用户会怎么问」而不是「记忆里怎么写的」。 */
const QUERIES = [
  ['符号链接创建失败怎么解决', 'pnpm'],
  ['为什么改的代码没生效', 'ts'],
  ['读写能不能并发', 'wal'],
  ['数据库锁等待时间', 'busy'],
  ['向量相似度分不开不同主题', 'cos'],
  ['池化方式怎么选', 'cls'],
  ['一张卡能写几件事', 'ortho'],
  ['工作结束后要清理什么', 'cleanup'],
  ['子进程管道报错', 'sandbox'],
  ['访问境外资源超时', 'proxy'],
  ['中文短词检索不到', 'fts'],
  ['更新二进制字段没效果', 'blob'],
]

const f = join(OUT, 'recall-verify.db')
for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true })
const { db } = openVault(f)
const ctx = createWriteCtx(db, {}, { encode: enc })
const idOf = new Map()
for (const [tag, text] of NOTES) {
  const r = await writeAtom(ctx, { text, kind: '结论', sourceRef: tag })
  idOf.set(tag, r.atomId)
}
console.log('写入', NOTES.length, '条；topic 数', db.prepare('SELECT COUNT(*) AS n FROM topic').get().n)
console.log('')
console.log('查询'.padEnd(22) + '期望  实际  名次  相似度  token')
console.log('-'.repeat(72))
let hit1 = 0,
  hit3 = 0,
  hit5 = 0,
  miss = 0
let totalMs = 0
for (const [query, expect] of QUERIES) {
  const qv = await enc(query)
  const t0 = Date.now()
  const r = recall(db, query, qv, { topN: 8 })
  totalMs += Date.now() - t0
  const want = idOf.get(expect)
  const rank = r.hits.findIndex((h) => h.id === want) + 1
  const hit = r.hits.find((h) => h.id === want)
  if (rank === 1) hit1++
  if (rank >= 1 && rank <= 3) hit3++
  if (rank >= 1 && rank <= 5) hit5++
  if (rank === 0) miss++
  const mark = rank === 1 ? 'OK ' : rank === 0 ? 'MISS' : 'TOP' + rank
  console.log(
    (mark + ' ' + query).padEnd(24) +
      expect.padEnd(8) +
      String(rank || '-').padEnd(6) +
      (hit === undefined ? '-' : hit.final.toFixed(4)).padEnd(8) +
      r.meta.counts.vec +
      '/' +
      r.meta.counts.entry +
      '/' +
      r.meta.counts.body +
      '/' +
      r.meta.counts.graph,
  )
}
const n = QUERIES.length
console.log('')
console.log(
  'Recall@1 =',
  hit1 + '/' + n,
  ' Recall@3 =',
  hit3 + '/' + n,
  ' Recall@5 =',
  hit5 + '/' + n,
  ' 完全落空 =',
  miss,
)
console.log('召回耗时均值 =', (totalMs / n).toFixed(1), 'ms（不含查询编码）')
const rr = recall(db, '随便问一句', await enc('随便问一句'), {})
console.log('退化标记：lexicalDegraded =', rr.meta.lexicalDegraded, ' shortTermMiss =', rr.meta.shortTermMiss)
db.close()
for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true })

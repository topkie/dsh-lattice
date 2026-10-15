// 用真实模型验证写入管线的落位行为（手动跑，不需要联网以外的东西）。
//
// 两组对照：
//   A 同义改写 —— 「同一件事的不同说法」，**应该**并进同一个 topic
//   B 异质记忆 —— 20 条互不相干的记忆，**不应该**被合并
// 这两个方向都要看：只测 A 会把阈值压低到乱并，只测 B 会把阈值抬到不并。

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'

const OUT = '.probe'
mkdirSync(OUT, { recursive: true })
const model = 'Xenova/bge-small-zh-v1.5'
const enc = (t) => encode(t, { model })
console.log('encoder:', (await ensureEncoder({ model })) ? 'ready' : 'unavailable')

const PARAPHRASE = [
  [
    'pnpm 的 nodeLinker 必须设为 hoisted，否则创建符号链接会失败。',
    'pnpm 必须配置 nodeLinker 为 hoisted 模式，符号链接在这个环境下创建不了。',
  ],
  [
    '系统代理必须走本地端口，否则访问境外源会直接超时。',
    '访问境外资源要走本地代理端口，不设代理就会连接超时。',
  ],
  [
    'SQLite 的 WAL 模式允许一写多读，读操作不会阻塞写入。',
    'WAL 模式下可以多个读者同时读，写操作不会被读阻塞。',
  ],
  [
    '余弦相似度在高维空间区分度不强，同域不同主题也可能接近 0.7。',
    '在高维向量上余弦的区分能力有限，不同主题的相似度也能到零点七。',
  ],
  [
    'bge 系列模型必须用 CLS 池化，均值池化会给出错误的相似度排序。',
    'bge 模型只能用 CLS 池化，用均值池化得到的相似度顺序是错的。',
  ],
  [
    '记忆卡的主题应当尽量正交，内容解耦，避免一张卡讲两件事。',
    '记忆卡要保证主题正交与内容解耦，不要在一张卡里塞两个主题。',
  ],
  [
    '中间产物在一轮工作结束后清理，可复用脚本与环境要保留。',
    '一轮工作结束后要清掉中间产物，同时保留可复用的脚本和环境。',
  ],
  [
    '受限沙箱里子进程的管道捕获会失败，改成单进程顺序执行。',
    '沙箱中子进程的管道读取不可用，只能改成单进程串行执行。',
  ],
]

// ── 每组用独立的库，避免组间互相干扰 ──────────────────────────────
console.log('\n== A 同义改写：应当并入 ==')
let joined = 0
for (let i = 0; i < PARAPHRASE.length; i++) {
  const f = join(OUT, 'paraphrase-' + i + '.db')
  for (const sfx of ['', '-wal', '-shm']) rmSync(f + sfx, { force: true })
  const { db } = openVault(f)
  const ctx = createWriteCtx(db, {}, { encode: enc })
  const a = await writeAtom(ctx, { text: PARAPHRASE[i][0], kind: '结论' })
  const b = await writeAtom(ctx, { text: PARAPHRASE[i][1], kind: '结论' })
  const e = b.evidence ?? {}
  const okPair = b.action === 'joined' && b.topicId === a.topicId
  if (okPair) joined++
  console.log(
    (okPair ? '  ✔' : '  ✘') + ' #' + i,
    '行动=' + b.action + '/' + (b.created ?? '-'),
    'cos=' + (e.sim1 === null || e.sim1 === undefined ? 'n/a' : e.sim1.toFixed(3)),
    'lex=' + (e.lex1 === undefined ? 'n/a' : e.lex1.toFixed(3)),
    'topic 数=' + db.prepare('SELECT COUNT(*) AS n FROM topic').get().n,
  )
  db.close()
}
console.log('A 结果：', joined + '/' + PARAPHRASE.length, '对并入成功')

// ── B 异质记忆：不应过度合并 ─────────────────────────────────────
const HETEROGENEOUS = [
  ['构建链', 'pnpm 的 nodeLinker 必须设为 hoisted，否则创建符号链接会失败。'],
  ['构建链', 'TypeScript 只在构建期生效，运行期看到的是 dist 里的 JS 产物。'],
  ['构建链', 'tsconfig 的 outDir 指到 dist，测试必须针对 dist 而不是 src 运行。'],
  ['网络', '系统代理必须走本地端口，否则访问境外源会直接超时。'],
  ['网络', '大文件下载走代理，但本地回环地址不能走代理，否则会自环。'],
  ['网络', '模型托管站连接超时时，换镜像源比反复重试更有效。'],
  ['数据库', 'SQLite 的 WAL 模式允许一写多读，读操作不会阻塞写入。'],
  ['数据库', 'WAL 只允许单写者，长事务持锁会让其他写入排队直到超时。'],
  ['数据库', 'busy_timeout 设为 5 秒，写入是毫秒级的，足够排队。'],
  ['向量', '余弦相似度在高维空间区分度不强，同域不同主题也可能接近 0.7。'],
  ['向量', '词面重叠（bigram）的区分度高于向量余弦，两者互补使用。'],
  ['向量', 'bge 系列模型必须用 CLS 池化，均值池化会给出错误的相似度排序。'],
  ['记忆', '记忆卡的主题应当尽量正交，内容解耦，避免一张卡讲两件事。'],
  ['记忆', '标题只当检索入口，可读性由摘要承担，不必追求标题优美。'],
  ['记忆', '入口条目不影响正文向量，因此不影响主题正交性。'],
  ['习惯', '中间产物在一轮工作结束后清理，可复用脚本与环境要保留。'],
  ['习惯', '踩到的坑要沉淀成记忆，否则下次还会踩同一个坑。'],
  ['习惯', '先做能跑通的最小链路，再逐层加精度，不要反过来。'],
  ['沙箱', '受限沙箱里子进程的管道捕获会失败，改成单进程顺序执行。'],
  ['沙箱', '写全局配置文件被拒时，申请一次性提权而不是绕过。'],
]
console.log('\n== B 异质记忆：不应合并 ==')
{
  const f = join(OUT, 'heterogeneous.db')
  for (const sfx of ['', '-wal', '-shm']) rmSync(f + sfx, { force: true })
  const { db } = openVault(f)
  const ctx = createWriteCtx(db, {}, { encode: enc })
  const t0 = Date.now()
  const res = []
  for (const [tag, text] of HETEROGENEOUS) {
    res.push({ tag, r: await writeAtom(ctx, { text, kind: '结论', source: 'probe', sourceRef: tag }) })
  }
  const ms = Date.now() - t0
  const stat = { joined: 0, created: 0, ambiguous: 0 }
  for (const { r } of res) {
    stat[r.action]++
    if (r.created === 'ambiguous') stat.ambiguous++
  }
  const topics = db.prepare('SELECT id, label, n_atoms FROM topic ORDER BY id').all()
  // 跨标签合并 = 误并（同一标签内部合并是子话题收敛，可以接受但不能过度）
  const cross = []
  for (const { tag, r } of res) {
    const others = db
      .prepare('SELECT a.source_ref AS tag FROM atom a WHERE a.topic_id = ? AND a.source_ref <> ?')
      .all(r.topicId, tag)
    if (others.length > 0) cross.push(tag + '↔' + others.map((o) => o.tag).join(','))
  }
  console.log('写入', res.length, '条用时', ms + 'ms', JSON.stringify(stat))
  console.log('topic 数:', topics.length, '（上限 20，越少说明合并越多）')
  console.log('跨标签合并:', cross.length === 0 ? '无' : [...new Set(cross)].join(' | '))
  const merged = topics.filter((t) => Number(t.n_atoms) > 1)
  console.log(
    '多成员 topic:',
    merged.length === 0 ? '无' : merged.map((t) => '#' + t.id + '(' + t.n_atoms + ')').join(' '),
  )
  db.close()
}

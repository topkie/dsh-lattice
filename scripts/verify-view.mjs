// 用真实模型验证注入组装：预算是否用满、装了几条、超预算次数是否为零。
// 预算取自实现的 DEFAULT_BUDGET（不是脚本里的字面量），所以这条脚本的口径跟着默认值走。
//
// 旧口径量的是锚 / 入口 / 路三段的字符占比，与当时的三段配额（55/20/25）对照。
// 三段与配额在机制替换（0.5.0）里删掉了：现在的口径是「按余弦序逐条装到字符预算」，
// 所以这里改成量四件事 —— 超预算次数（必须 0）、装了几条、用了预算的百分之多少、
// 未入选时有没有说明。判据不在这条脚本里，它只报数字；三库对照另有脚本。
// 「占预算」列在这个库里必然很低（只有 10 条笔记，装不满 5000）：它是样本量的读数，不是
// 预算没被用上。要判断填充率，看三库对照（各库上千条），不看这一列。
//
// 用法：node scripts/verify-view.mjs

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView, DEFAULT_BUDGET } from '../dist/pipeline/view.js'

const OUT = '.probe'
mkdirSync(OUT, { recursive: true })
const model = 'Xenova/bge-small-zh-v1.5'
const enc = (t) => encode(t, { model })
console.log('encoder:', (await ensureEncoder({ model })) ? 'ready' : 'unavailable')

const NOTES = [
  'pnpm 的 nodeLinker 必须设为 hoisted，否则创建符号链接会失败。',
  'TypeScript 只在构建期生效，运行期看到的是 dist 里的 JS 产物。',
  'SQLite 的 WAL 模式允许一写多读，读操作不会阻塞写入。',
  '余弦相似度在高维空间区分度不强，同域不同主题也可能接近 0.7。',
  'bge 系列模型必须用 CLS 池化，均值池化会给出错误的相似度排序。',
  '记忆卡的主题应当尽量正交，内容解耦，避免一张卡讲两件事。',
  '中间产物在一轮工作结束后清理，可复用脚本与环境要保留。',
  '受限沙箱里子进程的管道捕获会失败，改成单进程顺序执行。',
  '系统代理必须走本地端口，否则访问境外源会直接超时。',
  'FTS5 的 trigram 分词器对两字中文查询返回零命中。',
]

// 预算从实现取，不在脚本里另写一个数字。写死的 6000 在默认值改成 5000 之后仍在按旧值量，
// 「超预算 0 次」量的是 6000 这个数，与当前默认无关 —— 那正是这个字段曾经骗过的地方。
const BUDGET = DEFAULT_BUDGET
const f = join(OUT, 'view-verify.db')
for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true })
const { db } = openVault(f)
const ctx = createWriteCtx(db, {}, { encode: enc })
for (let i = 0; i < NOTES.length; i++) {
  await writeAtom(ctx, { text: NOTES[i], kind: '结论', sourceRef: 'n' + i })
}

const QUERIES = ['符号链接失败', '数据库并发读写', '池化方式', '清理中间产物', '中文短词检索', '代理超时']
let overBudget = 0
const rows = []
console.log('')
console.log('查询'.padEnd(16) + '总长   占预算  条数  重复压制  未列  有未入选说明')
console.log('-'.repeat(72))
for (const q of QUERIES) {
  const r = recall(db, q, await enc(q), { topN: 24 })
  const v = assembleView(db, r, { budget: BUDGET })
  if (v.text.length > BUDGET) overBudget++
  const pct = (v.text.length / BUDGET) * 100
  // 未入选的两种来源：同源真重复被压掉的、预算装不下的。两者都会在尾巴里说一句。
  const hasTail = /另有 \d+ 条|预算装不下了/.test(v.text)
  rows.push({ len: v.text.length, pct, count: v.anchors })
  console.log(
    q.padEnd(14) +
      String(v.text.length).padStart(6) +
      (pct.toFixed(0) + '%').padStart(8) +
      String(v.anchors).padStart(6) +
      String(v.duplicateDropped).padStart(9) +
      String(v.overBudget).padStart(7) +
      (hasTail ? '有' : '无').padStart(11),
  )
}
const avg = (k) => rows.reduce((a, x) => a + x[k], 0) / rows.length
console.log('')
console.log(
  '平均：总长 ' +
    avg('len').toFixed(0) +
    ' 字符（预算的 ' +
    avg('pct').toFixed(0) +
    '%），条数 ' +
    avg('count').toFixed(1),
)
console.log(
  '条数区间：' + Math.min(...rows.map((x) => x.count)) + '–' + Math.max(...rows.map((x) => x.count)),
)
console.log('超预算次数:', overBudget, '（必须为 0）')
console.log('')
const sample = recall(db, '池化方式', await enc('池化方式'), {})
const sv = assembleView(db, sample, { budget: 900 })
console.log('=== 小预算样本（budget=900）===')
console.log('总长:', sv.text.length, '（上限 900）条数:', sv.anchors, '未列:', sv.overBudget)
console.log('含「预算装不下了」:', sv.text.includes('预算装不下了'))
console.log('')
console.log(sv.text.slice(0, 420))
db.close()
for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true })

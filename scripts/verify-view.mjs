// 用真实模型验证注入组装：预算是否够用、三段的比例是否落在设计区间内。
//
// T7 的验收判据是「输出符合预算比例」。这里量的是**组装后各段的实际字符占比**，
// 与 SEGMENT_RATIO（55/20/25）对照 —— 两者不必逐位相等（段内容长度是算出来的），
// 但锚必须占大头，且总长不得超预算。
//
// 用法：node scripts/verify-view.mjs

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openVault } from '../dist/db/open.js'
import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import { recall } from '../dist/pipeline/search.js'
import { assembleView, SEGMENT_RATIO } from '../dist/pipeline/view.js'

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

const f = join(OUT, 'view-verify.db')
for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true })
const { db } = openVault(f)
const ctx = createWriteCtx(db, {}, { encode: enc })
for (let i = 0; i < NOTES.length; i++) {
  await writeAtom(ctx, { text: NOTES[i], kind: '结论', sourceRef: 'n' + i })
}

const QUERIES = ['符号链接失败', '数据库并发读写', '池化方式', '清理中间产物', '中文短词检索', '代理超时']
let overBudget = 0
const ratios = []
console.log('')
console.log('查询'.padEnd(16) + '总长  锚%   入口%  路%   锚数 入口主题 路行 降级 另有')
console.log('-'.repeat(78))
for (const q of QUERIES) {
  const r = recall(db, q, await enc(q), { topN: 24 })
  const v = assembleView(db, r, { budget: 6000 })
  if (v.text.length > 6000) overBudget++
  // 注意：不能把段落头的「绝对索引」当成长度 —— 那样锚段的长度会被算成
  // 锚+入口+路的偏移量，占比完全失真。这里按段落头切分后再量。
  const seg = (text) => {
    const a = text.indexOf('【锚】')
    const e = text.indexOf('【入口】')
    const p = text.indexOf('【路】')
    const endAnchor = e < 0 ? (p < 0 ? text.length : p) : e
    const endEntry = p < 0 ? text.length : p
    return {
      anchor: endAnchor - a,
      entry: e < 0 ? 0 : endEntry - e,
      path: p < 0 ? 0 : text.length - p,
    }
  }
  const sg = seg(v.text)
  const anchorChars = sg.anchor
  const entryChars = sg.entry
  const pathChars = sg.path
  const total = anchorChars + entryChars + pathChars || 1
  const pa = (anchorChars / total) * 100
  const pe = (entryChars / total) * 100
  const pp = (pathChars / total) * 100
  ratios.push([pa, pe, pp])
  console.log(
    q.padEnd(14) +
      String(v.text.length).padStart(5) +
      pa.toFixed(0).padStart(6) +
      pe.toFixed(0).padStart(7) +
      pp.toFixed(0).padStart(6) +
      String(v.anchors).padStart(6) +
      String(v.entryTopics).padStart(7) +
      String(v.pathLines).padStart(6) +
      String(v.demotedAnchors).padStart(5) +
      String(v.otherRelated).padStart(6),
  )
}
const avg = (i) => ratios.reduce((a, x) => a + x[i], 0) / ratios.length
console.log('')
console.log(
  '平均占比：锚 ' + avg(0).toFixed(1) + '%  入口 ' + avg(1).toFixed(1) + '%  路 ' + avg(2).toFixed(1) + '%',
)
console.log(
  '设计目标：锚 ' +
    SEGMENT_RATIO.anchors * 100 +
    '%  入口 ' +
    SEGMENT_RATIO.entries * 100 +
    '%  路 ' +
    SEGMENT_RATIO.paths * 100 +
    '%',
)
console.log('超预算次数:', overBudget, '（必须为 0）')
console.log('')
const sample = recall(db, '池化方式', await enc('池化方式'), {})
const sv = assembleView(db, sample, { budget: 900 })
console.log('=== 小预算样本（budget=900，触发裁剪）===')
console.log('触发裁剪:', JSON.stringify(sv.trimmed))
console.log('总长:', sv.text.length, '锚数:', sv.anchors)
console.log('')
console.log(sv.text.slice(0, 420))
db.close()
for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true })

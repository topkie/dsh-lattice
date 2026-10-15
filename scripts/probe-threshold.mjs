// 阈值标定实验：用**真正的同主题对**（同一件事的不同说法）测判定量的分布。
//
// 为什么不用"同域"当正样本：同一技术域下的两条记忆常常是**不同子话题**
// （「WAL 允许一写多读」与「WAL 只允许单写者」讲的是两件事），它们本就不该合并。
// 拿它们当正样本会把阈值往"过度合并"的方向拽。这里改用同义改写对。

import { ensureEncoder, encode } from '../dist/encoder/index.js'
import { bigramTerms, jaccard } from '../dist/util/text.js'
import { cosine } from '../dist/util/vec.js'

// 每行的两个/三个字符串是同一件事的不同表述。
const GROUPS = [
  [
    'pnpm 的 nodeLinker 必须设为 hoisted，否则创建符号链接会失败。',
    'pnpm 必须配置 nodeLinker 为 hoisted 模式，符号链接在这个环境下创建不了。',
    '把 pnpm 的 nodeLinker 改成 hoisted，不然装包时会因为符号链接失败。',
  ],
  [
    '系统代理必须走本地端口，否则访问境外源会直接超时。',
    '访问境外资源要走本地代理端口，不设代理就会连接超时。',
    '系统代理要配置本地端口，否则外网源一律超时。',
  ],
  [
    'SQLite 的 WAL 模式允许一写多读，读操作不会阻塞写入。',
    'WAL 模式下可以多个读者同时读，写操作不会被读阻塞。',
    '开启 WAL 之后读写可以并发，读不会挡住写。',
  ],
  [
    '余弦相似度在高维空间区分度不强，同域不同主题也可能接近 0.7。',
    '在高维向量上余弦的区分能力有限，不同主题的相似度也能到零点七。',
    '余弦相似度对高维向量区分度不够，跨主题的分数同样很高。',
  ],
  [
    'bge 系列模型必须用 CLS 池化，均值池化会给出错误的相似度排序。',
    'bge 模型只能用 CLS 池化，用均值池化得到的相似度顺序是错的。',
    'CLS 池化是 bge 模型的必要条件，均值池化会打乱相似度排序。',
  ],
  [
    '记忆卡的主题应当尽量正交，内容解耦，避免一张卡讲两件事。',
    '记忆卡要保证主题正交与内容解耦，不要在一张卡里塞两个主题。',
    '每张记忆卡的主题应尽量正交、内容解耦，一张卡只讲一件事。',
  ],
  [
    '中间产物在一轮工作结束后清理，可复用脚本与环境要保留。',
    '一轮工作结束后要清掉中间产物，同时保留可复用的脚本和环境。',
    '工作收尾时清理中间产物，但可复用的脚本与环境必须保留。',
  ],
  [
    '受限沙箱里子进程的管道捕获会失败，改成单进程顺序执行。',
    '沙箱中子进程的管道读取不可用，只能改成单进程串行执行。',
    '在受限沙箱里没法捕获子进程管道输出，要改为单进程依次执行。',
  ],
]

const model = 'Xenova/bge-small-zh-v1.5'
console.log('encoder:', (await ensureEncoder({ model })) ? 'ready' : 'unavailable')

const items = []
for (let g = 0; g < GROUPS.length; g++) {
  for (const text of GROUPS[g]) {
    const v = await encode(text, { model })
    items.push({ g, text, v, lex: bigramTerms(text) })
  }
}
const same = []
const diff = []
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    const rec = { cos: cosine(items[i].v, items[j].v), lex: jaccard(items[i].lex, items[j].lex) }
    if (items[i].g === items[j].g) same.push(rec)
    else diff.push(rec)
  }
}
function line(name, arr) {
  const cos = arr.map((r) => r.cos).sort((a, b) => a - b)
  const lex = arr.map((r) => r.lex).sort((a, b) => a - b)
  const q = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]
  console.log(
    name.padEnd(8) + ' n=' + String(arr.length).padStart(3),
    'cos min/p10/p50/p90/max=' +
      [cos[0], q(cos, 0.1), q(cos, 0.5), q(cos, 0.9), cos[cos.length - 1]].map((x) => x.toFixed(3)).join('/'),
    ' lex min/p50/p90/max=' +
      [lex[0], q(lex, 0.5), q(lex, 0.9), lex[lex.length - 1]].map((x) => x.toFixed(3)).join('/'),
  )
}
line('同主题', same)
line('跨主题', diff)
console.log('')
function gate(name, pred) {
  console.log(
    name.padEnd(34),
    '同主题 ' + String(same.filter(pred).length).padStart(2) + '/' + same.length,
    ' 跨主题误判 ' + diff.filter(pred).length + '/' + diff.length,
  )
}
for (const tc of [0.55, 0.6, 0.65, 0.7])
  for (const tl of [0, 0.02, 0.04]) {
    gate('cos>=' + tc + ' & lex>=' + tl, (r) => r.cos >= tc && r.lex >= tl)
  }
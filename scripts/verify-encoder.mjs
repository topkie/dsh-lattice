// 实测验证编码器：能否加载模型、输出维度、向量质量与耗时。
//
// 用法（先 pnpm build）：
//   node scripts/verify-encoder.mjs
//   ENCODER_MIRROR=https://your-mirror node scripts/verify-encoder.mjs
//
// 单元测试只覆盖降级路径（不联网、不下载模型）；真实编码质量由本脚本验证。

import { performance } from 'node:perf_hooks'
import { centroidOf, encodeBatch, encoderError, encoderState, ensureEncoder } from '../dist/encoder/index.js'
import { VEC_DIM, cosine, l2norm } from '../dist/util/vec.js'

const opts = {
  model: process.env.ENCODER_MODEL ?? 'Xenova/bge-small-zh-v1.5',
  remoteHost: process.env.ENCODER_MIRROR ?? '',
  cacheDir: process.env.ENCODER_CACHE ?? '',
}

// 三组文本：同义改写 / 同域不同题 / 跨域无关
const SAMPLES = {
  A: '访问大陆不可达地址时优先使用系统代理下载大文件',
  A2: '网络请求要走系统代理，否则大陆地址不可达',
  B: '记忆库索引机制与卡片组织规范',
  C: '混凝土水灰比决定强度，砂率影响和易性',
}

console.log('模型      :', opts.model, opts.remoteHost ? `（源 ${opts.remoteHost}）` : '（官方源）')

let t0 = performance.now()
const ok = await ensureEncoder(opts)
const loadMs = performance.now() - t0
console.log('加载      :', ok ? `成功，${(loadMs / 1000).toFixed(1)} s` : `失败 —— ${encoderError()}`)
if (!ok) {
  console.log('\n结论      : 编码器不可用。上层会退回词面检索（功能缩水但不崩），这本身也是设计内的行为。')
  process.exit(0)
}
console.log('状态      :', encoderState())

const keys = Object.keys(SAMPLES)
t0 = performance.now()
const vecs = await encodeBatch(
  keys.map((k) => SAMPLES[k]),
  opts,
)
const encMs = performance.now() - t0
if (vecs.some((v) => v === null)) {
  console.error('\n编码返回了 null，说明运行期失败：', encoderError())
  process.exit(1)
}

const dims = vecs[0].length
const norms = vecs.map((v) => l2norm(v))
console.log(
  `编码      : ${vecs.length} 条，${encMs.toFixed(0)} ms（${(encMs / vecs.length).toFixed(0)} ms/条）`,
)
console.log(`维度      : ${dims}（期望 ${VEC_DIM}）`)
console.log(`L2 范数   : ${norms.map((n) => n.toFixed(6)).join(', ')}`)

const [a, a2, b, c] = vecs
const sim = (x, y) => cosine(x, y)
console.log('\n相似度')
console.log(`  同义改写 A~A2 : ${sim(a, a2).toFixed(4)}`)
console.log(`  同域不同题 A~B : ${sim(a, b).toFixed(4)}`)
console.log(`  跨域无关 A~C   : ${sim(a, c).toFixed(4)}`)

const centroid = centroidOf(vecs)
const checks = [
  ['维度正确', dims === VEC_DIM],
  ['已归一化', norms.every((n) => Math.abs(n - 1) < 1e-5)],
  ['同义改写最相似', sim(a, a2) > sim(a, b) && sim(a, a2) > sim(a, c)],
  ['同域高于跨域', sim(a, b) > sim(a, c)],
  ['中心向量已归一化', Math.abs(l2norm(centroid) - 1) < 1e-5],
]
console.log('\n结论')
for (const [name, pass] of checks) console.log(`  ${pass ? '通过' : '未通过'}  ${name}`)
const failed = checks.filter(([, p]) => !p)
console.log(failed.length === 0 ? '\n全部通过。' : `\n${failed.length} 项未通过。`)
process.exit(failed.length === 0 ? 0 : 1)
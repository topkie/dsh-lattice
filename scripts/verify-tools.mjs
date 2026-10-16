// 工具端到端验证：按宿主调用工具的方式跑一遍完整链路（真实模型）。
//
// T8 的判据是「在 DSH 会话内可正常调用」。这里模拟宿主的调用形态：
// 用假 ctx 收集注册结果，然后按工具名调用 execute，检查输出是否可读、
// 是否真的读写到了库。
//
// 用法：node scripts/verify-tools.mjs

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../dist/index.js'
import { closeRuntime } from '../dist/state.js'

const OUT = '.probe'
mkdirSync(OUT, { recursive: true })
const dir = join(OUT, 'tools-verify')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const cfg = {
  enabled: true,
  dataDir: dir,
  encoderEnabled: true,
  encoderModel: 'Xenova/bge-small-zh-v1.5',
  encoderMirror: '',
  encoderCacheDir: '',
  tauJoin: 0.78,
  tauLex: 0.05,
  tauLexOnly: 0.1,
  tauNew: 0.5,
  viewBudget: 6000,
  topN: 24,
  mmapSize: 0,
  cacheSize: 0,
  busyTimeout: 0,
}

const reg = []
// 替身 ctx：只提供本脚本要验的那两件事。
//
// `inject` 是 T19 起宿主半用到的 —— 它拿它挂两条只读路由（`ctx.inject(['webServer'], cb)`）。
// 真宿主的契约是「服务可用才调 cb」，所以这里**如实照做**：不提供 webServer，于是回调不执行。
// 本脚本验的是工具，不是路由 —— 回调不跑正是它该有的行为。
apply(
  {
    get: (k) => (k === 'tools' ? { register: (t) => reg.push(t) } : undefined),
    inject: (_names, _cb) => {
      /* 宿主里没有 webServer 时不调 cb，与真宿主一致 */
    },
  },
  cfg,
)
const tool = (n) => reg.find((x) => x.name === n)
console.log('注册的工具:', reg.map((t) => t.name).join(', '))

console.log('')
console.log('=== lattice_write ===')
const texts = [
  'pnpm 的 nodeLinker 必须设为 hoisted，否则创建符号链接会失败。',
  'SQLite 的 WAL 模式允许一写多读，读操作不会阻塞写入。',
  'bge 系列模型必须用 CLS 池化，均值池化会给出错误的相似度排序。',
  '系统代理必须走本地端口，否则访问境外源会直接超时。',
  '记忆卡的主题应当尽量正交，内容解耦，避免一张卡讲两件事。',
]
const ids = []
for (const t of texts) {
  const out = await tool('lattice_write').execute({ text: t, refs: [] })
  const id = Number(/#(\d+)/.exec(out)[1])
  ids.push(id)
  console.log('  ' + out.split(String.fromCharCode(10))[0])
}

console.log('')
console.log('=== lattice_recall（6 个真实问法）===')
let bad = 0
for (const q of [
  '符号链接失败',
  '数据库并发',
  '池化方式选了错的',
  '境外资源超时',
  '一张卡能写几件事',
  '完全不相关的问题',
]) {
  const out = await tool('lattice_recall').execute({ query: q })
  const hasAnchor = out.includes('【锚】')
  const none = out.includes('没有找到相关记忆') // 只在空库时为真：召回总会给 topN，非空库上恒假
  const firstLine = out.split(String.fromCharCode(10)).find((l) => l.startsWith('- ')) ?? '(无锚)'
  const sim = /最高相似度 ([0-9.]+)/.exec(out)
  // 判据必须引用**实际会出现**的字符串。弱相关的真实信号是输出里的「可能不相关」标注，
  // 而不是「没有找到」—— 后者只在空库时出现，在非空库上恒为假，判据会永远指向同一侧。
  const verdict = out.includes('可能不相关') ? '弱相关' : '给出记忆'
  console.log(
    '  ' +
      q.padEnd(18) +
      verdict.padEnd(10) +
      (sim ? '相似度 ' + sim[1] : '—') +
      '  ' +
      firstLine.slice(0, 34),
  )
  console.log()
  // 非空库上 none 恒为假，而召回几乎总给锚 —— 这个计数器很少有机会增加（见处置清单 N1）。
  if (!none && !hasAnchor) bad++
}

console.log('')
console.log('=== lattice_expand ===')
const full = await tool('lattice_expand').execute({ atom_id: ids[0] })
console.log('  全文长度:', full.length, '| 含正文:', full.includes('nodeLinker'))
const rel = await tool('lattice_expand').execute({ atom_id: ids[0], mode: 'related' })
console.log('  兄弟:', rel.split(String.fromCharCode(10))[0].slice(0, 50))

console.log('')
console.log('=== lattice_list ===')
// 顺带验一次所有权：用户口述的这条要能被 origin 过滤出来。
const userOut = await tool('lattice_write').execute({
  text: '提交信息要写清为什么，而不是只写做了什么。',
  origin: 'user',
})
const userId = Number(/#(\d+)/.exec(userOut)[1])
const page1 = await tool('lattice_list').execute({ limit: 3 })
const pl = page1.split(String.fromCharCode(10))
console.log('  ' + pl[1])
console.log('  首行: ' + pl[2])
console.log('  翻页提示: ' + (page1.includes('下一页') ? '有' : '无'))
const onlyUser = await tool('lattice_list').execute({ origin: 'user' })
console.log('  只看用户说的: ' + onlyUser.split(String.fromCharCode(10))[1])
console.log('  命中 #' + userId + ': ' + String(onlyUser.includes('#' + userId)))
const byKind = await tool('lattice_list').execute({ kind: '结论', limit: 2 })
console.log('  按 kind 过滤: ' + byKind.split(String.fromCharCode(10))[1])
const byTopic = await tool('lattice_list').execute({ topic: 1 })
console.log('  按主题过滤: ' + byTopic.split(String.fromCharCode(10))[1])
console.log('')
console.log('=== lattice_ping ===')
const ping = JSON.parse(await tool('lattice_ping').execute({}))
console.log('  dataDir:', ping.dataDir === dir ? '正确' : ping.dataDir)
console.log('  工具:', (ping.tools ?? []).join(', '))

const final = await tool('lattice_recall').execute({ query: '任意' })
console.log('')
console.log('库现状:', final.split(String.fromCharCode(10))[0])
console.log('异常输出数:', bad)
closeRuntime()

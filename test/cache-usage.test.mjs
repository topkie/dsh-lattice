// 五处模块级缓存的占用可见性（lattice_ping 的 caches 字段）。
//
// 四条判据各自的用例：
//   1. 读得到 —— ping 输出里有每处缓存的条目数（编码器那一项例外，它是布尔）；
//   2. 是实时值 —— 触发缓存增长的那一步前后各 ping 一次，条目数必须变；
//   3. 不引入新开销 —— ping 不建缓存（行为断言 + 源码级断言）；
//   4. 不做容量上限 —— 可见性层里没有淘汰动作或容量常量（源码级断言）。
//
// 测试环境把编码器替身强制失败（test/stubs/），所以「编码器已加载」这一项在门禁里
// 看不到 true：那一项只能验「状态是现读的」（idle → unavailable）。真模型下 loaded
// 会变成 true，由 scripts/verify-tools.mjs 在真实环境看。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { apply } from '../dist/index.js'
import { closeRuntime, getRuntime } from '../dist/state.js'
import { cacheUsage } from '../dist/cache-usage.js'
import { createWriteCtx, topicLexCacheUsage, writeAtom } from '../dist/pipeline/write.js'
import { recall, vecCacheUsage } from '../dist/pipeline/search.js'
import { oldTopicCacheUsage, snapshotOldTopicOf } from '../dist/cluster/rebuild.js'
import { encoderCacheUsage, encoderState, resetEncoder } from '../dist/encoder/index.js'
import { readVocabCacheUsage } from '../dist/pipeline/entries.js'
import { VEC_DIM } from '../dist/util/vec.js'

let dir = ''
let registered = []

function fakeCtx() {
  return {
    registered,
    get: (k) => (k === 'tools' ? { register: (t) => registered.push(t) } : undefined),
    effect: (fn) => fn(),
    inject: () => {},
  }
}

function cfg() {
  return {
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
}

function tool(name) {
  const t = registered.find((x) => x.name === name)
  if (!t) throw new Error('工具未注册: ' + name)
  return t
}

/** 调一次 ping 并解析。刻意不包缓存：每次调用都应该是现读。 */
async function pingJson() {
  return JSON.parse(await tool('lattice_ping').execute({}))
}

/**
 * 取运行时的主库连接。
 *
 * **必须先 ping 一次**：运行时是单例，由第一次「打开库」的动作创建，而 ping 会带着
 * 插件配置（含 dataDir）走那条路径。直接 getRuntime({}) 会用一个没有 dataDir 的配置
 * 去建运行时 —— 落在用户的真实库目录上，而本用例只该碰自己建的临时库。
 */
async function runtimeDb() {
  await pingJson()
  return getRuntime({}).db
}

/** 单热向量：不同下标即正交，用来构造「主题之间不相似」的确定性输入。 */
function oneHot(i) {
  const v = new Float32Array(VEC_DIM)
  v[i % VEC_DIM] = 1
  return v
}

/**
 * 用**注入的编码器**直接写若干条记忆，让库里带上合法向量。
 *
 * 为什么不用 lattice_write：测试环境里编码器替身必定失败，走工具只会写入没有向量的
 * 记忆，而向量缓存的条目数要数的是**持有多少条向量** —— 没有向量时它正确地报 0。
 * 这些写入落在运行时的同一条连接上，所以 ping 读到的正是这一条连接上的缓存。
 */
async function seedVectors(db, texts) {
  const ctx = createWriteCtx(
    db,
    {},
    {
      encode: async (text) => oneHot(texts.indexOf(text) + 1),
    },
  )
  for (const text of texts) await writeAtom(ctx, { text })
}

// 全部用例收在**一个 describe 里**，钩子也放在里面。
//
// 为什么不能写在文件顶层（本文件踩过）：node:test 的顶层 beforeEach 挂在进程的根
// 上下文上 —— 同一次运行里**所有测试文件**的用例都会执行它。本文件的 import 排在
// run.mjs 末尾，它的钩子在别的文件的 beforeEach **之后**跑，closeRuntime() 会把别人
// 刚配好的日志库关掉：log.test.mjs 有 6 条用例因此变红（单独跑却全绿）。钩子放进
// describe，作用域就只剩这里的用例。
describe('缓存占用', () => {
  beforeEach(() => {
    // 编码器与运行时都是模块级单例：不复位的话会沿用上一个用例的 / 上一个文件的实例。
    resetEncoder()
    closeRuntime()
    registered = []
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-cache-usage-'))
    apply(fakeCtx(), cfg())
  })

  afterEach(() => {
    closeRuntime()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不阻断 */
    }
  })

  describe('缓存占用（判据 1）', () => {
    it('ping 输出里有每处缓存的条目数，不是「有 / 无」', async () => {
      const j = await pingJson()
      assert.ok(j.caches, 'ping 必须带 caches 字段')
      for (const key of ['vec', 'topicLex', 'readVocab', 'oldTopic']) {
        assert.equal(typeof j.caches[key].entries, 'number', key + ' 的条目数必须是数字')
        assert.ok(Number.isInteger(j.caches[key].entries), key + ' 的条目数必须是整数')
      }
      // 「条目数」的单位因缓存而异：向量按 atom、指纹按 topic、词表按 term。
      // 口径写进输出，读的人不必回来翻代码。
      assert.equal(j.caches.vec.unit, 'atom')
      assert.equal(j.caches.topicLex.unit, 'topic')
      assert.equal(j.caches.readVocab.unit, 'term')
      assert.equal(j.caches.oldTopic.unit, 'atom')
      // 编码器是模型本体，没有条目数：只报是否已加载（判据允许的例外）。
      assert.equal(typeof j.caches.encoder.loaded, 'boolean')
      assert.equal(j.caches.encoder.state, 'idle')
      assert.equal(j.caches.encoder.model, null)
    })
  })

  describe('缓存占用是实时值（判据 2）', () => {
    it('向量缓存：写 3 条并召回后，条目数从 0 变成 3', async () => {
      const j0 = await pingJson()
      assert.equal(j0.caches.vec.entries, 0)
      const db = getRuntime({}).db
      await seedVectors(db, [
        '系统代理必须走本地端口，否则访问境外源会超时。',
        '缓存击穿会让数据库在同一秒内被打满。',
        '日志按天切分，只保留最近七天的记录。',
      ])
      const before = await pingJson()
      assert.equal(before.caches.vec.cached, false, '只写不召回，向量缓存还没建')
      assert.equal(before.caches.vec.entries, 0)
      recall(db, '代理', oneHot(1), {})
      const after = await pingJson()
      assert.equal(after.caches.vec.cached, true)
      assert.equal(after.caches.vec.entries, 3, '三条都有合法向量，缓存里就该是 3')
    })

    it('topic 词面缓存：第二条写入评估过已有主题后，条目数从 0 变成 1', async () => {
      const db = await runtimeDb()
      const j0 = await pingJson()
      assert.equal(j0.caches.topicLex.entries, 0)
      const ctx = createWriteCtx(
        db,
        {},
        {
          encode: async (text) => oneHot(text.includes('代理') ? 1 : 2),
        },
      )
      await writeAtom(ctx, { text: '系统代理必须走本地端口，否则访问境外源会超时。' })
      const j1 = await pingJson()
      assert.equal(j1.caches.topicLex.entries, 0, '落进新建主题时不缓存任何指纹')
      // 两个文本的 bigram 完全不重叠、向量正交：第二条不会并入第一个主题，
      // 但它在落位时评估过第一个主题的指纹 —— 那份指纹留在缓存里。
      await writeAtom(ctx, { text: '棱镜色散实验的读数记录在实验本第三页。' })
      const j2 = await pingJson()
      assert.equal(j2.caches.topicLex.cached, true)
      assert.ok(
        j2.caches.topicLex.entries > j1.caches.topicLex.entries,
        '条目数必须变化：' + j1.caches.topicLex.entries + ' -> ' + j2.caches.topicLex.entries,
      )
      assert.ok(j2.caches.topicLex.terms > 0, 'terms 是真正占内存的量，必须大于 0')
    })

    it('查询侧词表缓存：召回工具命中一次后，条目数从 0 变成词表大小', async () => {
      const j0 = await pingJson()
      assert.equal(j0.caches.readVocab.entries, 0)
      await tool('lattice_write').execute({ text: '系统代理必须走本地端口，否则访问境外源会超时。' })
      const j1 = await pingJson()
      assert.equal(j1.caches.readVocab.cached, false, '写入侧不缓存词表（每次现算），条目数应当还是 0')
      assert.equal(j1.caches.readVocab.entries, 0)
      const out = await tool('lattice_recall').execute({ query: '代理', budget: 900 })
      assert.ok(!out.includes('没有找到'), '召回要命中才会触发反哺，输出：' + out)
      const j2 = await pingJson()
      assert.equal(j2.caches.readVocab.cached, true)
      assert.ok(
        j2.caches.readVocab.entries > 0,
        '词表里有 term，条目数必须大于 0（实际 ' + j2.caches.readVocab.entries + '）',
      )
    })

    it('重聚类快照：快照前后条目数从 0 变成 atom 数', async () => {
      const db = await runtimeDb()
      await seedVectors(db, [
        '系统代理必须走本地端口，否则访问境外源会超时。',
        '缓存击穿会让数据库在同一秒内被打满。',
        '日志按天切分，只保留最近七天的记录。',
      ])
      const j0 = await pingJson()
      assert.equal(j0.caches.oldTopic.entries, 0)
      const snap = snapshotOldTopicOf(db)
      assert.equal(snap.size, 3)
      const j1 = await pingJson()
      assert.equal(j1.caches.oldTopic.entries, 3, '读的必须是快照本体，不是快照大小')
    })

    it('编码器：loaded 是布尔，state 随真实加载尝试变化', async () => {
      const j0 = await pingJson()
      assert.equal(j0.caches.encoder.loaded, false)
      assert.equal(j0.caches.encoder.state, 'idle')
      // 召回会尝试加载编码器；替身必定失败，状态从 idle 走到 unavailable。
      // 这一条验的是「现读」：如果 ping 报的是启动时快照，state 会停在 idle。
      await tool('lattice_recall').execute({ query: '代理', budget: 900 })
      const j1 = await pingJson()
      assert.equal(j1.caches.encoder.state, 'unavailable')
      assert.equal(j1.caches.encoder.loaded, encoderState() === 'ready', 'loaded 必须与编码器真实状态一致')
    })
  })

  describe('ping 不引入新开销（判据 3）', () => {
    it('库里有带向量的 atom 时 ping 仍不建缓存；真正用一次缓存后才出现', async () => {
      const db = await runtimeDb()
      await seedVectors(db, [
        '系统代理必须走本地端口，否则访问境外源会超时。',
        '缓存击穿会让数据库在同一秒内被打满。',
      ])
      const j = await pingJson()
      // 若 ping 调了 loadVecCache，这里会是 2；若调了 readVocab，这里会大于 0。
      assert.equal(j.caches.vec.cached, false)
      assert.equal(j.caches.vec.entries, 0)
      assert.equal(j.caches.readVocab.cached, false)
      assert.equal(j.caches.readVocab.entries, 0)
      // 直接调聚合函数也一样：读数本身不该产生被读的对象。
      const direct = cacheUsage(db)
      assert.equal(direct.vec.entries, 0)
      assert.equal(direct.readVocab.entries, 0)
      // 对照：同一条连接上真正用一次缓存，条目数立刻出来 —— 上面的 0 不是「读不到」。
      recall(db, '代理', oneHot(1), {})
      const k = await pingJson()
      assert.equal(k.caches.vec.entries, 2)
    })
  })

  /**
   * 读数实现不许做的事：重建缓存、碰库、淘汰条目。
   *
   * 为什么检查**编译产物的函数体**（toString）而不是读 src：TS 签名里的返回类型
   * （`: { cached: boolean }`）也是花括号，按源码切函数体会先切到类型注解上，
   * 于是一条断言都命中不了 —— 判据恒真，比没有判据更糟。toString 拿到的是擦掉
   * 类型之后的真实执行体，也不受排版与注释影响。
   */
  const BANNED = [
    'buildVocabIndex',
    'loadVecCache',
    'topicLexOf(',
    'snapshotOldTopicOf',
    'ensureEncoder',
    'SELECT',
    '.delete(',
    '.clear(',
    '.splice(',
    'evict',
    'MAX_',
  ]

  function assertClean(text, where) {
    for (const token of BANNED) {
      assert.ok(!text.includes(token), where + ' 不该出现 ' + token)
    }
  }

  describe('可见性层不重建、不淘汰（判据 3 / 4）', () => {
    it('聚合函数只读缓存容器，不碰重建与淘汰', () => {
      assertClean(cacheUsage.toString(), 'cacheUsage')
    })

    it('五处读数函数各自不调用自己的构建 / 加载函数', () => {
      const fns = [
        vecCacheUsage,
        topicLexCacheUsage,
        readVocabCacheUsage,
        oldTopicCacheUsage,
        encoderCacheUsage,
      ]
      for (const fn of fns) assertClean(fn.toString(), fn.name)
    })

    it('ping 所在的模块走聚合函数，不直接引用任何构建函数', () => {
      // 不用 tool('lattice_ping').execute.toString()：注册表里的 execute 是 defineTool 的
      // 包装函数，拿它看不到原始执行体（断言会恒假）。这里查 ping 所在的编译产物本身。
      const js = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8')
      assert.ok(js.includes('cacheUsage'), 'ping 必须调用 cacheUsage')
      for (const token of ['loadVecCache', 'buildVocabIndex', 'snapshotOldTopicOf', 'topicLexOf(']) {
        assert.ok(!js.includes(token), 'ping 所在模块不该出现 ' + token)
      }
    })
  })
})

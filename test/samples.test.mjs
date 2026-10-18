// 校准样本库与 lattice_feedback（M4-T44 判据 12，裁决 #30/#33/#34）。
//
// 这一组用例的共同前提：**样本库与记忆库是两个文件**。每个用例都把两者放在同一个
// 临时 dataDir 下，再分别打开来断言 ——「反馈写没写进样本库」与「主库动没动」必须能
// 分别观察，否则判据 12 的「主库 edge 不新增」「主库表数不变」根本无法构造。

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../dist/index.js'
import { resetEncoder } from '../dist/encoder/index.js'
import { closeRuntime } from '../dist/state.js'
import {
  SAMPLE_OBVIOUS_MAX_TOP1,
  SAMPLE_UNCERTAIN_MAX_TOP1,
  STALE_FLAG,
  SampleStore,
  sampleFilePath,
} from '../dist/samples/store.js'
import {
  classifyNegative,
  closeSamples,
  collectAutoNegative,
  configureSamples,
  flushSamples,
  flushSamplesAsync,
  noteLastRecall,
  recordSample,
  resolveFeedbackRef,
  sampleStats,
} from '../dist/samples/index.js'

let dir = ''
let tools = []
/** 测试里显式打开的连接（Windows 上没关的连接会让临时目录删不掉）。 */
let extraDbs = []

function fakeCtx() {
  const registered = []
  return {
    registered,
    get: (k) => (k === 'tools' ? { register: (t) => registered.push(t) } : undefined),
    effect: (fn) => fn(),
    inject: () => {},
  }
}

/** 插件配置（与 index.ts 的默认值一致；samplesEnabled 默认开）。 */
function cfg(over = {}) {
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
    samplesEnabled: true,
    ...over,
  }
}

function tool(name) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error('工具未注册: ' + name)
  return t
}

/** 只读打开主库（开了就记下来，afterEach 统一关）。 */
function openMain() {
  const db = new DatabaseSync(join(dir, 'lattice.db'), { readOnly: true })
  extraDbs.push(db)
  return db
}

/** 只读打开样本库；不存在时返回 null（「没写过样本」也是一种要断言的状态）。 */
function openSamples() {
  const file = sampleFilePath(dir)
  if (!existsSync(file)) return null
  const db = new DatabaseSync(file, { readOnly: true })
  extraDbs.push(db)
  return db
}

function sampleRows() {
  const db = openSamples()
  if (db === null) return []
  return db
    .prepare(
      'SELECT id, created_at, kind, source, top1, vec, hit_ids, flags, encoder_model FROM recall_sample ORDER BY id',
    )
    .all()
}

function countOf(db, sql) {
  return Number(db.prepare(sql).get().n)
}

/** 主库的「形状 + 内容」指纹：对象集合与四张业务表的行数。 */
function mainShape() {
  const db = openMain()
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
    .map((r) => r.type + ':' + r.name)
  return {
    objects,
    counts: {
      atom: countOf(db, 'SELECT COUNT(*) AS n FROM atom'),
      topic: countOf(db, 'SELECT COUNT(*) AS n FROM topic'),
      entry: countOf(db, 'SELECT COUNT(*) AS n FROM entry'),
      edge: countOf(db, 'SELECT COUNT(*) AS n FROM edge'),
    },
  }
}

/** 上次召回文本里【锚】段的 atom id，按展示顺序。 */
function anchorIdsOf(text) {
  const head = text.split('【入口】')[0]
  return [...head.matchAll(/^- \[(\d+)/gm)].map((m) => Number(m[1]))
}

/**
 * 这一组的钩子放在 describe **内部**：node:test 的顶层 beforeEach/afterEach 是**全局**的，
 * 会作用到同一个进程里所有测试文件（实测：后注册的文件的 beforeEach 会关掉先注册文件的
 * 运行时）。样本用例要复位运行时与样本库，放在顶层就会把别的文件的日志/库状态一并关掉。
 */
describe('校准样本库与 lattice_feedback（判据 12）', () => {
  beforeEach(() => {
    resetEncoder()
    closeRuntime()
    closeSamples()
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-samples-' + process.pid + '-'))
    const ctx = fakeCtx()
    apply(ctx, cfg())
    tools = ctx.registered
  })

  afterEach(() => {
    for (const db of extraDbs) {
      try {
        db.close()
      } catch {
        /* 已关闭 */
      }
    }
    extraDbs = []
    closeRuntime()
    closeSamples()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * 写四条记忆并召回一次，返回召回文本。
   *
   * 第一条是**诱饵**：它让后面两条的 atom id（2、3）与它们在【锚】段里的序号（1、2）错开，
   * 否则「ref=2 映射到 atom #2」这种恒等情形会让用例看起来通过、其实没测到映射。
   */
  async function seedAndRecall() {
    await tool('lattice_write').execute({
      text: '集群的节点数上限是十二个，超过就要分片。',
    })
    await tool('lattice_write').execute({
      text: '系统代理必须走本地端口，否则访问境外源会超时。',
    })
    await tool('lattice_write').execute({
      text: '本地端口是代理的唯一出口，换端口就等于换了一条路。',
    })
    await tool('lattice_write').execute({
      text: '模型的缓存目录可以放在数据目录下，避免占满系统盘。',
    })
    return tool('lattice_recall').execute({ query: '系统代理 本地端口' })
  }

  describe('判据 12：lattice_feedback', () => {
    it('positive：样本库出现 kind=positive / source=feedback 行，存的是映射后的 atom id', async () => {
      const out = await seedAndRecall()
      const shown = anchorIdsOf(out)
      assert.ok(shown.length >= 2, '召回应当展示至少两条锚，输出: ' + out)
      const before = mainShape()
      const fb = await tool('lattice_feedback').execute({ kind: 'positive', ref: 2 })
      assert.ok(fb.includes('已记下反馈'), '输出: ' + fb)
      const rows = sampleRows()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].kind, 'positive')
      assert.equal(rows[0].source, 'feedback')
      // 样本库存的是 atom id（1-based 序号已由插件映射），不是序号本身。
      assert.deepEqual(JSON.parse(rows[0].hit_ids), [shown[1]])
      assert.ok(
        shown.some((id, i) => id !== i + 1),
        '序号与 atom id 至少有一处错开（否则测不出映射）：' + JSON.stringify(shown),
      )
      // 判据：主库 edge 不新增，其他表也不动。
      const after = mainShape()
      assert.deepEqual(after.counts, before.counts)
      assert.deepEqual(after.objects, before.objects)
    })

    it('negative：同样只写样本库', async () => {
      const out = await seedAndRecall()
      const shown = anchorIdsOf(out)
      const before = mainShape()
      const fb = await tool('lattice_feedback').execute({ kind: 'negative', ref: 1 })
      assert.ok(fb.includes('已记下反馈'), '输出: ' + fb)
      const rows = sampleRows()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].kind, 'negative')
      assert.equal(rows[0].source, 'feedback')
      assert.deepEqual(JSON.parse(rows[0].hit_ids), [shown[0]])
      assert.deepEqual(mainShape().counts, before.counts, '负样本更不该写主库')
    })

    it('ref 越界被拒且拒因可见：0 / 超条数 / 没有上次召回 / 非整数', async () => {
      // ① 还没有任何召回：ref 无从解析。
      const noRecall = await tool('lattice_feedback').execute({ kind: 'positive', ref: 1 })
      assert.ok(noRecall.includes('反馈被拒'), '输出: ' + noRecall)
      assert.ok(noRecall.includes('lattice_recall'), '拒因要告诉调用方先召回，输出: ' + noRecall)
      assert.equal(sampleRows().length, 0, '被拒时不得写样本')

      const out = await seedAndRecall()
      const shown = anchorIdsOf(out)
      const zero = await tool('lattice_feedback').execute({ kind: 'positive', ref: 0 })
      assert.ok(zero.includes('反馈被拒'), '输出: ' + zero)
      assert.ok(zero.includes('从 1 开始'), '拒因要说明序号起点，输出: ' + zero)
      const neg = await tool('lattice_feedback').execute({ kind: 'positive', ref: -3 })
      assert.ok(neg.includes('反馈被拒'), '输出: ' + neg)
      const over = await tool('lattice_feedback').execute({ kind: 'negative', ref: shown.length + 1 })
      assert.ok(over.includes('反馈被拒'), '输出: ' + over)
      assert.ok(
        over.includes('只展示了 ' + shown.length + ' 条'),
        '拒因要报出上次召回的实际条数，输出: ' + over,
      )
      const frac = await tool('lattice_feedback').execute({ kind: 'negative', ref: 1.5 })
      assert.ok(frac.includes('反馈被拒'), '输出: ' + frac)
      assert.ok(frac.includes('整数'), '拒因要说明必须是整数，输出: ' + frac)
      assert.equal(sampleRows().length, 0, '被拒的几次都不得写样本')
    })

    it('kind 只接受 positive / negative', async () => {
      await seedAndRecall()
      const bad = await tool('lattice_feedback').execute({ kind: 'maybe', ref: 1 })
      assert.ok(bad.includes('反馈被拒'), '输出: ' + bad)
      assert.ok(bad.includes('positive'), '拒因要说出合法取值，输出: ' + bad)
      assert.equal(sampleRows().length, 0)
    })

    it('连续调用不触发重标：主库对象集合、行数与 meta 都不变', async () => {
      await seedAndRecall()
      const db = openMain()
      const metaBefore = db.prepare('SELECT key, value FROM meta ORDER BY key').all()
      const before = mainShape()
      const a = await tool('lattice_feedback').execute({ kind: 'positive', ref: 1 })
      const b = await tool('lattice_feedback').execute({ kind: 'negative', ref: 2 })
      const c = await tool('lattice_feedback').execute({ kind: 'positive', ref: 1 })
      for (const out of [a, b, c]) assert.ok(out.includes('已记下反馈'), '输出: ' + out)
      const metaAfter = db.prepare('SELECT key, value FROM meta ORDER BY key').all()
      assert.deepEqual(metaAfter, metaBefore, '重标会写 meta 快照；这里必须一个字都没动')
      const after = mainShape()
      assert.deepEqual(after.objects, before.objects)
      assert.deepEqual(after.counts, before.counts)
      assert.equal(sampleRows().length, 3, '三次调用各写一条样本')
      // 重标会留日志事件（calib.recalibrate_done / failed）；样本路径不该产生它。
      flushSamples()
      const logFile = join(dir, 'logs', 'lattice-log.db')
      if (existsSync(logFile)) {
        const log = new DatabaseSync(logFile, { readOnly: true })
        try {
          const n = Number(log.prepare("SELECT COUNT(*) AS n FROM log WHERE event LIKE 'calib.%'").get().n)
          assert.equal(n, 0, '样本路径不得产生标定事件')
        } finally {
          log.close()
        }
      }
    })

    it('样本库是独立文件：主库 sqlite_master 里没有 recall_sample', async () => {
      await seedAndRecall()
      await tool('lattice_feedback').execute({ kind: 'positive', ref: 1 })
      const db = openMain()
      const names = db.prepare("SELECT name FROM sqlite_master WHERE name = 'recall_sample'").all()
      assert.deepEqual(names, [], '样本表不得出现在主库')
      assert.ok(existsSync(sampleFilePath(dir)), '样本库应当是一个独立文件')
      assert.ok(sampleFilePath(dir).includes('samples'), '样本库落在 samples/ 下：' + sampleFilePath(dir))
    })

    it('查询原文不落盘：样本库文件里找不到那次查询的文本', async () => {
      const marker = '独特查询标记ZQX987'
      await tool('lattice_write').execute({ text: '系统代理必须走本地端口，否则会超时。' })
      await tool('lattice_recall').execute({ query: '系统代理 ' + marker })
      await tool('lattice_feedback').execute({ kind: 'negative', ref: 1 })
      // 关掉连接，让 WAL 合并回主文件，再整体搜字节。
      closeSamples()
      const file = sampleFilePath(dir)
      assert.ok(existsSync(file))
      const needle = Buffer.from(marker, 'utf8')
      for (const suffix of ['', '-wal']) {
        if (!existsSync(file + suffix)) continue
        assert.equal(
          readFileSync(file + suffix).includes(needle),
          false,
          '样本库（含 WAL）不得出现查询原文：' + file + suffix,
        )
      }
    })
  })

  describe('ref 解析的边界', () => {
    it('序号数的是【锚】段里展示给模型的那几行', async () => {
      const out = await seedAndRecall()
      const shown = anchorIdsOf(out)
      const got = resolveFeedbackRef(2)
      assert.equal(got.ok, true)
      assert.equal(got.atomId, shown[1])
      assert.equal(resolveFeedbackRef(0).ok, false)
      assert.equal(resolveFeedbackRef(shown.length + 1).ok, false)
    })

    it('没有召回记录时报得出「先 recall」', () => {
      closeSamples()
      const r = resolveFeedbackRef(1)
      assert.equal(r.ok, false)
      assert.ok(r.reason.includes('lattice_recall'), r.reason)
    })
  })

  /** 一份「向量路有候选、词面零命中」的召回元数据；各用例只改需要的字段。 */
  function meta(over = {}) {
    return {
      counts: { vec: 3, entry: 0, body: 0, graph: 0 },
      lexicalDegraded: false,
      shortTermMiss: false,
      vectorMissing: false,
      suppressed: 0,
      primaryHits: 3,
      secondaryHits: 0,
      topCosine: 0.3,
      graphStatus: 'ok',
      elapsedMs: 1,
      ...over,
    }
  }

  describe('负样本自动收集：纯度规则与两档', () => {
    it('明显无关（top1 < 0.4）与不确定带（0.4~0.6）分得开，0.6 以上不收', () => {
      assert.equal(classifyNegative(meta({ topCosine: 0.3 })), 'obvious')
      assert.equal(classifyNegative(meta({ topCosine: SAMPLE_OBVIOUS_MAX_TOP1 - 0.01 })), 'obvious')
      assert.equal(classifyNegative(meta({ topCosine: SAMPLE_OBVIOUS_MAX_TOP1 })), 'uncertain')
      assert.equal(classifyNegative(meta({ topCosine: 0.5 })), 'uncertain')
      assert.equal(classifyNegative(meta({ topCosine: SAMPLE_UNCERTAIN_MAX_TOP1 })), 'uncertain')
      assert.equal(classifyNegative(meta({ topCosine: 0.61 })), null)
    })

    it('三个纯度条件：降级 / 词面命中 / 向量路零候选都不算负样本', () => {
      assert.equal(classifyNegative(meta({ vectorMissing: true })), null)
      assert.equal(classifyNegative(meta({ lexicalDegraded: true })), null)
      assert.equal(classifyNegative(meta({ shortTermMiss: true })), null)
      assert.equal(classifyNegative(meta({ counts: { vec: 3, entry: 2, body: 0, graph: 0 } })), null)
      assert.equal(classifyNegative(meta({ counts: { vec: 3, entry: 0, body: 1, graph: 0 } })), null)
      assert.equal(classifyNegative(meta({ counts: { vec: 0, entry: 0, body: 0, graph: 0 } })), null)
    })

    it('收集：入队并写进样本库（source=auto，kind=negative）', async () => {
      configureSamples(dir, { enabled: true, model: 'm1' })
      const row = collectAutoNegative({ query: 'q1', meta: meta({ topCosine: 0.5 }), vec: null, hitIds: [7] })
      assert.notEqual(row, null)
      assert.equal(await flushSamplesAsync(), true)
      const rows = sampleRows()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].kind, 'negative')
      assert.equal(rows[0].source, 'auto')
      assert.equal(rows[0].top1, 0.5)
      assert.deepEqual(JSON.parse(rows[0].hit_ids), [7])
    })

    it('不与上一条重复：同一查询第二次被挡下', () => {
      configureSamples(dir, { enabled: true, model: 'm1' })
      const a = collectAutoNegative({ query: '同一条查询', meta: meta(), vec: null, hitIds: [] })
      const b = collectAutoNegative({ query: '同一条查询', meta: meta(), vec: null, hitIds: [] })
      const c = collectAutoNegative({ query: '另一条查询', meta: meta(), vec: null, hitIds: [] })
      assert.notEqual(a, null)
      assert.equal(b, null)
      assert.notEqual(c, null)
    })

    it('开关关掉后自动收集停止，但显式反馈照常写', async () => {
      configureSamples(dir, { enabled: false, model: 'm1' })
      assert.equal(collectAutoNegative({ query: 'q', meta: meta(), vec: null, hitIds: [] }), null)
      flushSamples()
      assert.equal(sampleRows().length, 0)
      // feedback 不走自动收集：关的是抽样，不是模型对召回的显式判断。
      noteLastRecall({ ids: [11, 12], top1: 0.5, vec: null })
      const ok = await recordSample({
        kind: 'positive',
        source: 'feedback',
        top1: 0.5,
        vec: null,
        hitIds: [11],
      })
      assert.equal(ok, true)
      assert.equal(sampleRows().length, 1)
    })
  })

  describe('样本库的容量规则', () => {
    const DAY = 24 * 60 * 60 * 1000

    function row(over = {}) {
      return {
        createdAt: Date.now(),
        kind: 'negative',
        source: 'auto',
        top1: 0.3,
        vec: null,
        hitIds: [],
        encoderModel: 'm1',
        ...over,
      }
    }

    it('按天淘汰：91 天前的样本在下次写入时被删掉', () => {
      const store = new SampleStore(dir, { retainDays: 90, maxRows: 10000, negObviousMax: 2000 })
      const base = Date.now()
      try {
        store.append([row({ createdAt: base })])
        // 旧样本用直接写库造：走 append 的话，同一次写入末尾的 prune 当场就把它删了，
        // 测不到「下次写入时淘汰」这条规则本身。
        const raw = new DatabaseSync(sampleFilePath(dir))
        raw
          .prepare(
            'INSERT INTO recall_sample (created_at, kind, source, top1, vec, hit_ids, flags, encoder_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(base - 91 * DAY, 'negative', 'auto', 0.3, null, null, '', 'm1')
        raw.close()
        assert.equal(store.counts().total, 2)
        store.append([row({ createdAt: base + 1000 })])
        assert.equal(store.counts().total, 2, '新增一条、淘汰一条')
        const db = openSamples()
        const min = db.prepare('SELECT MIN(created_at) AS m FROM recall_sample').get()
        assert.ok(Number(min.m) >= base, '留下来的都不早于 90 天前')
      } finally {
        store.close()
      }
    })

    it('按总量淘汰：超过上限时删最旧的', () => {
      const store = new SampleStore(dir, { retainDays: 90, maxRows: 3, negObviousMax: 2000 })
      const base = Date.now()
      try {
        for (let i = 0; i < 5; i++) store.append([row({ createdAt: base - (5 - i) * 1000 })])
        assert.equal(store.counts().total, 3)
        const db = openSamples()
        const times = db.prepare('SELECT created_at FROM recall_sample ORDER BY created_at').all()
        // 写的是 base-5000..base-1000，留下最近三条 → 最早的一条应当是 base-3000。
        assert.ok(Number(times[0].created_at) >= base - 3000, '最旧的两条应当已淘汰')
      } finally {
        store.close()
      }
    })

    it('明显无关上限：超了删最旧，不确定带不受限', () => {
      const store = new SampleStore(dir, { retainDays: 90, maxRows: 10000, negObviousMax: 2 })
      const base = Date.now()
      try {
        store.append([
          row({ createdAt: base - 3000, top1: 0.1 }),
          row({ createdAt: base - 2000, top1: 0.2 }),
          row({ createdAt: base - 1000, top1: 0.5 }),
        ])
        assert.equal(store.counts().total, 3)
        // 再写一条明显无关：这一档已有 2 条，先删最旧的一条腾位置。
        store.append([row({ createdAt: base, top1: 0.15 })])
        const db = openSamples()
        const obvious = db
          .prepare('SELECT COUNT(*) AS n FROM recall_sample WHERE top1 < ?')
          .get(SAMPLE_OBVIOUS_MAX_TOP1)
        assert.equal(Number(obvious.n), 2, '明显无关一档封顶 2 条')
        assert.equal(store.counts().total, 3, '不确定带那条不能被挤掉')
      } finally {
        store.close()
      }
    })

    it('换编码模型：旧样本标失效，不删', () => {
      const store = new SampleStore(dir, { retainDays: 90, maxRows: 10000, negObviousMax: 2000 })
      try {
        store.append([row({ encoderModel: 'model-a' })])
        store.append([row({ encoderModel: 'model-b' })])
        const db = openSamples()
        const rows = db.prepare('SELECT encoder_model, flags FROM recall_sample ORDER BY id').all()
        assert.equal(rows.length, 2, '旧样本不删')
        assert.equal(rows[0].flags, STALE_FLAG, '换模型后旧样本标失效')
        assert.equal(rows[1].flags, '')
      } finally {
        store.close()
      }
    })
  })

  describe('ping 报样本条数', () => {
    it('只报 total / positive / negative，不报原文', async () => {
      await seedAndRecall()
      await tool('lattice_feedback').execute({ kind: 'positive', ref: 1 })
      await tool('lattice_feedback').execute({ kind: 'negative', ref: 2 })
      const j = JSON.parse(await tool('lattice_ping').execute({}))
      assert.deepEqual(j.samples, { total: 2, positive: 1, negative: 1 })
      assert.ok(!JSON.stringify(j.samples).includes('代理'), '条数里不该有原文')
      assert.deepEqual(sampleStats(), { total: 2, positive: 1, negative: 1 })
    })
  })
})

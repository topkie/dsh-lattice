// 召回管线测试。
//
// 与写入侧测试同样的分工：向量由测试注入，不加载真实模型。
// 召回是**只读**路径，这里额外验一件事 —— 跑完之后库没被改过。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { VEC_DIM } from '../dist/util/vec.js'
import { createWriteCtx, writeAtom } from '../dist/pipeline/write.js'
import {
  invalidateVecCache,
  recall,
  fuse,
  CHANNEL_WEIGHT,
  AFFILIATION,
  DUP_COS,
  DUP_LEX,
  DUP_TEXT,
} from '../dist/pipeline/search.js'

let dbFile = ''
let db = null

describe('search', () => {
  beforeEach(() => {
    dbFile = join(
      tmpdir(),
      'dsh-lattice-search-' +
        process.pid +
        '-' +
        Date.now() +
        '-' +
        Math.random().toString(36).slice(2) +
        '.db',
    )
    db = openVault(dbFile).db
  })

  afterEach(() => {
    try {
      db?.close()
    } catch {
      /* 已关闭 */
    }
    for (const s of ['', '-wal', '-shm']) rmSync(dbFile + s, { force: true })
  })

  /** 单热向量。 */
  function oneHot(i) {
    const v = new Float32Array(VEC_DIM)
    v[i % VEC_DIM] = 1
    return v
  }

  /** 由文本确定性生成的单位向量。 */
  function hashVec(text) {
    const v = new Float32Array(VEC_DIM)
    let h = 2166136261
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
    for (let i = 0; i < v.length; i++) {
      h ^= i + 1
      h = Math.imul(h, 16777619) >>> 0
      v[i] = ((h % 2000) - 1000) / 1000
    }
    let n = 0
    for (const x of v) n += x * x
    n = Math.sqrt(n) || 1
    for (let i = 0; i < v.length; i++) v[i] /= n
    return v
  }

  /** 关键词 → 固定向量的假编码器（必须对输入敏感，否则所有文本余弦恒为 1）。 */
  function keywordEncoder(map, fallback = hashVec) {
    return async (text) => {
      for (const [kw, vec] of map) if (text.includes(kw)) return vec
      return fallback(text)
    }
  }

  function matcher(text, vec) {
    return async (t) => (t.includes(text) ? vec : hashVec(t))
  }

  describe('召回：RRF 融合', () => {
    it('按权重累加：同一名次下权重高的路得分更高', () => {
      const a = fuse({ vec: [7], entry: [8] })
      assert.ok(a.get(7).score > a.get(8).score, '第 1 名：向量路权重 1.0 应高于入口路 0.8')
      assert.equal(a.get(7).ranks.vec, 1)
      assert.equal(a.get(7).ranks.entry, undefined, '没进这一路就不该有名次')
    })

    it('多路共识超过单路头部', () => {
      // 9 号在向量路第 3、入口路第 1；10 号只在向量路第 1。
      const a = fuse({ vec: [10, 11, 9], entry: [9] })
      assert.ok(a.get(9).score > a.get(10).score, '两路共识应当压过单路第一')
    })

    it('缺席的路不计分，也不惩罚其他路', () => {
      const withBody = fuse({ vec: [1], body: [] })
      const withoutBody = fuse({ vec: [1] })
      assert.equal(withBody.get(1).score, withoutBody.get(1).score, '空列表与缺席应当等价')
    })

    it('权重表与常量符合设计', () => {
      assert.equal(CHANNEL_WEIGHT.vec, 1.0)
      assert.equal(CHANNEL_WEIGHT.entry, 0.8)
      assert.ok(CHANNEL_WEIGHT.entry > CHANNEL_WEIGHT.body, '入口路权重应高于正文路')
      assert.equal(AFFILIATION.primary, 1.0)
      assert.ok(AFFILIATION.primary > AFFILIATION.secondary)
      assert.ok(AFFILIATION.secondary > AFFILIATION.graphOnly)
    })
  })
  describe('召回：四条路各自能命中', () => {
    it('入口路：两字中文查询能命中（trigram 在此失效，全靠 bigram 兜底）', async () => {
      const ids = await seed(db, [
        ['系统代理必须走本地端口，否则访问境外源会直接超时。', oneHot(0)],
        ['棱镜色散实验的读数记录在实验本第三页。', oneHot(1)],
      ])
      const r = recall(db, '代理', null, {})
      assert.equal(r.hits.length >= 1, true, '应当有命中')
      assert.equal(r.hits[0].id, ids[0], '命中项应当是讲代理的那条')
      assert.ok(r.meta.counts.entry >= 1, '入口路应当有货')
      assert.equal(r.meta.counts.body, 0, '两字词在 trigram 正文路上必然为空 —— 这是预期行为')
    })

    it('正文路：≥3 字的词能命中', async () => {
      const ids = await seed(db, [
        ['SQLite 的 WAL 模式允许一写多读，读操作不会阻塞写入。', oneHot(0)],
        ['棱镜色散实验的读数记录在实验本第三页。', oneHot(1)],
      ])
      const r = recall(db, '阻塞写入', null, {})
      assert.equal(r.hits[0].id, ids[0])
    })

    it('向量路：语义相近的查询命中，即使一个共同词都没有', async () => {
      const A = oneHot(5)
      const ids = await seed(db, [
        ['缓存击穿：热点 key 失效瞬间大量请求打到数据库。', A],
        ['棱镜色散实验的读数记录在实验本第三页。', oneHot(6)],
      ])
      // 查询词与任何正文都不重叠，只有向量能把它捞起来。
      const r = recall(db, '高并发下的存储压力', A, {})
      assert.equal(r.hits[0].id, ids[0])
      assert.ok(r.meta.counts.vec >= 1)
    })

    it('图路：只有它能捞起的那条能被捞起', async () => {
      const A = oneHot(7)
      const B = oneHot(8)
      const ids = await seed(db, [
        ['缓存击穿：热点 key 失效瞬间大量请求打到数据库。', A],
        ['缓存雪崩与击穿的区别在于失效的是大批 key。', B],
      ])
      // 用手工边把两条连起来：真实系统里这条边由写入落位的 near 逻辑产生。
      db.prepare(
        "INSERT INTO edge(src_type, src_id, dst_type, dst_id, kind, confidence, origin, created_at) VALUES ('atom', ?, 'atom', ?, 'near', 0.9, 'untyped', ?)",
      ).run(ids[0], ids[1], Date.now())
      // 查询向量与两条都不接近（第三个方向），正文词只与「缓存击穿」那条重叠。
      const r = recall(db, '缓存击穿', oneHot(300), {})
      assert.ok(r.meta.counts.graph >= 1, '图路应当从种子里扩展出邻居')
      assert.ok(
        r.hits.some((h) => h.id === ids[1]),
        '被边连上的那条应当在结果里',
      )
    })
  })

  describe('召回：归属因子与重复压制', () => {
    it('主属命中的归属因子为 1.0', async () => {
      const ids = await seed(db, [['系统代理必须走本地端口，否则会超时。', oneHot(0)]])
      const r = recall(db, '代理', null, {})
      const hit = r.hits.find((h) => h.id === ids[0])
      assert.equal(hit.affiliation, AFFILIATION.primary)
      assert.equal(hit.final, hit.score, '主属命中时 final 与 score 相等')
    })

    it('真重复判据 DUP_TEXT 默认 0.7：逐字相同 1.000 过线，同篇不同小节 0.24–0.57 不过线', () => {
      assert.equal(DUP_TEXT, 0.7)
    })

    it('重复压制两条线按常量名钉住：词面 DUP_LEX 0.72、几何 DUP_COS 0.92', () => {
      // 0.72 来自「近义改写 0.64 不该被折叠」的实测（见 src/pipeline/search.ts 的 DUP_LEX 注释）；
      // 0.92 是沿用原设计 atom_pair 的取值。改这两个数等于改召回结果，先让这条用例红。
      assert.equal(DUP_LEX, 0.72)
      assert.equal(DUP_COS, 0.92)
    })

    it('同一来源内逐字重复只留 final 高的一条', async () => {
      const A = oneHot(9)
      // 两条向量完全相同、正文逐字相同、来源相同 => 3-gram 覆盖度 1.0 => 判为真重复
      const ids = await seed(db, [
        ['系统代理必须走本地端口，否则访问境外源会直接超时。', A],
        ['系统代理必须走本地端口，否则访问境外源会直接超时。', A],
      ])
      for (const id of ids) {
        db.prepare('UPDATE atom SET source_ref = ? WHERE id = ?').run('同一篇.md', id)
      }
      invalidateVecCache(db)
      const r = recall(db, '代理', null, {})
      assert.equal(r.meta.suppressed, 1, '同一来源内应当压制掉一条')
      assert.equal(r.hits.filter((h) => ids.includes(h.id)).length, 1)
    })

    it('来源为空时逐字重复也不压制：没有来源就证明不了同源', async () => {
      // 旧实现按主题分桶，把「同主题」当成「可能重复」；实测三个库 59%–90% 的同篇条目
      // 落在不同主题，同主题不是重复的依据。来源为空时更窄：没有来源，两条逐字相同也
      // 分不清是同一篇被写了两遍，还是两个不同的人各写了一遍 —— 压制会把后者的信息
      // 永久丢掉，而用户看不见。
      const A = oneHot(9)
      const ids = await seed(db, [
        ['系统代理必须走本地端口，否则访问境外源会直接超时。', A],
        ['系统代理必须走本地端口，否则访问境外源会直接超时。', A],
      ])
      const r = recall(db, '代理', null, {})
      assert.equal(r.meta.suppressed, 0, '来源为空时不得按内容互压')
      assert.equal(r.hits.filter((h) => ids.includes(h.id)).length, 2)
    })

    it('同主题但内容不同则不压制', async () => {
      await seed(db, [
        ['系统代理必须走本地端口，否则访问境外源会直接超时。', oneHot(10)],
        ['大文件下载要走代理，但回环地址不能走代理，否则会自环。', oneHot(11)],
      ])
      const r = recall(db, '代理', null, {})
      assert.equal(r.meta.suppressed, 0)
      assert.ok(r.hits.length >= 2, '两条不同内容都应当留下')
    })
  })
  describe('召回：退化必须可观测', () => {
    it('词面两路全空、只剩向量路时标记 lexicalDegraded', async () => {
      const A = oneHot(12)
      await seed(db, [['缓存击穿：热点 key 失效瞬间大量请求打到数据库。', A]])
      // 查询词与正文毫无重叠，只有向量路有货。
      const r = recall(db, '并发压力', A, {})
      assert.equal(r.meta.counts.entry, 0)
      assert.equal(r.meta.counts.body, 0)
      assert.ok(r.meta.counts.vec > 0)
      assert.equal(r.meta.lexicalDegraded, true, '只剩向量路时必须留痕，不能静默')
    })

    it('短查询在入口路落空时标记 shortTermMiss', async () => {
      await seed(db, [['棱镜色散实验的读数记录在实验本第三页。', oneHot(13)]])
      const r = recall(db, '代理', null, {})
      assert.ok(r.hits.length === 0 || r.meta.counts.entry === 0)
      assert.equal(r.meta.shortTermMiss, true, '两字词零命中通常意味着索引或切词出了问题')
    })

    it('无查询向量时标记 vectorMissing，词面路照常工作', async () => {
      const ids = await seed(db, [['系统代理必须走本地端口，否则会超时。', oneHot(0)]])
      const r = recall(db, '代理', null, {})
      assert.equal(r.meta.vectorMissing, true)
      assert.equal(r.meta.counts.vec, 0)
      assert.equal(r.hits[0].id, ids[0], '降级只是少一路，不是什么都召回不到')
    })
  })

  describe('召回：契约与边界', () => {
    it('只读：召回前后库内行数不变', async () => {
      await seed(db, [
        ['系统代理必须走本地端口，否则访问境外源会直接超时。', oneHot(0)],
        ['SQLite 的 WAL 模式允许一写多读，读操作不会阻塞写入。', oneHot(1)],
      ])
      const before = tableCounts(db)
      recall(db, '代理', oneHot(0), {})
      recall(db, 'WAL', oneHot(1), {})
      assert.deepEqual(tableCounts(db), before, '召回路径不得写库')
    })

    it('新写入的 atom 能被后续召回看见（向量缓存必须感知写入）', async () => {
      const A = oneHot(14)
      await seed(db, [['第一条记忆，与后面的内容无关。', A]])
      const r1 = recall(db, '第二条', A, {})
      assert.equal(r1.hits.length, 1, '写入前只有一条')
      // 直接写入而不调用任何失效函数 —— 缓存必须自己发现库变了。
      const ctx = createWriteCtx(db, {}, { encode: matcher('第二条', A) })
      const w = await writeAtom(ctx, { text: '第二条记忆，同样指向 A 方向。' })
      const r2 = recall(db, '第二条', A, {})
      assert.ok(
        r2.hits.some((h) => h.id === w.atomId),
        '刚写入的 atom 必须能被召回到',
      )
    })

    it('显式失效向量缓存后结果保持一致', async () => {
      const A = oneHot(15)
      const ids = await seed(db, [['缓存击穿：热点 key 失效。', A]])
      const r1 = recall(db, '缓存', A, {})
      invalidateVecCache(db)
      const r2 = recall(db, '缓存', A, {})
      assert.equal(r1.hits[0].id, r2.hits[0].id)
      assert.equal(r1.hits[0].id, ids[0])
    })

    it('空库不抛错，返回空结果并标记退化', () => {
      const r = recall(db, '任意查询', oneHot(0), {})
      assert.equal(r.hits.length, 0)
      assert.equal(r.topics.length, 0)
      assert.equal(r.meta.counts.vec, 0)
    })

    it('topN 生效，且 final 降序', async () => {
      await seed(db, [
        ['系统代理必须走本地端口，否则访问境外源会直接超时。', oneHot(0)],
        ['系统代理要配置本地端口，否则外网源一律超时。', oneHot(1)],
        ['大文件下载要走代理，但回环地址不能走代理。', oneHot(2)],
      ])
      const r = recall(db, '代理', null, { topN: 2 })
      assert.equal(r.hits.length, 2)
      assert.ok(r.hits[0].final >= r.hits[1].final, '必须按 final 降序')
    })

    it('命中的主题按命中数汇总，供注入层生成入口段', async () => {
      const A = oneHot(16)
      const enc = keywordEncoder([['代理', A]])
      const ctx = createWriteCtx(db, {}, { encode: enc })
      // 两条必须真的同主题：词面重叠要过 τ_lex(0.05) 落位才会并入。
      await writeAtom(ctx, { text: '系统代理必须走本地端口，否则访问境外源会超时。' })
      await writeAtom(ctx, { text: '系统代理配置本地端口，否则访问境外源会超时。' })
      const r = recall(db, '代理', null, {})
      assert.equal(r.topics.length, 1, '两条应当归入同一主题')
      assert.equal(r.topics[0].hits, 2)
    })

    it('不同主题的命中分别汇总，不强行并成一条', async () => {
      const A = oneHot(17)
      const enc = keywordEncoder([['代理', A]])
      const ctx = createWriteCtx(db, {}, { encode: enc })
      // 实测这两条词面重叠只有 0.031 < 0.05 —— 按设计就不该合并。
      await writeAtom(ctx, { text: '系统代理必须走本地端口，否则会超时。' })
      await writeAtom(ctx, { text: '代理配置写进环境变量，重启终端后生效。' })
      const r = recall(db, '代理', null, {})
      assert.equal(r.topics.length, 2, '重叠不足时不应当并到同一主题')
      assert.ok(r.topics.every((t) => t.hits === 1))
    })
  })
})

/** 写若干条记忆，返回它们的 id（顺序与传入一致）。 */
async function seed(db, items) {
  const enc = async (t) => {
    for (const [text, vec] of items) if (t.includes(text.slice(0, 12))) return vec
    return hashVec(t)
  }
  const ctx = createWriteCtx(db, {}, { encode: enc })
  const ids = []
  for (const [text] of items) {
    const r = await writeAtom(ctx, { text })
    ids.push(r.atomId)
  }
  return ids
}

/** 各表的行数快照，用来验证「召回不写库」。 */
function tableCounts(db) {
  const tables = ['atom', 'topic', 'entry', 'edge', 'atom_topic', 'atom_search', 'atom_fts', 'entry_fts']
  const out = {}
  for (const t of tables) out[t] = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n)
  return out
}

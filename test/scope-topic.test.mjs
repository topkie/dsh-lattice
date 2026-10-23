// 写入侧派生行为的验证：一条用例验一件事，覆盖 scope 透传、主题归属、主题行上的聚合列与检索行正文。
//
// 这里验的是写入路径怎么处理 scope、主题归属与主题行上的聚合列；不验召回质量、不验阈值。
//
// 两组夹具，分开是因为要看的东西不同：
//   A 组只放一条 —— 走工具层（apply 注册 lattice_write 后从 ctx.registered 里取出），
//     因为这一条要同时覆盖参数默认值那一层（src/tools/index.ts）与写库那一层（src/pipeline/write.ts）。
//   B 组放其余十条 —— 直接 openVault + createWriteCtx + writeAtom，
//     因为要读库里的原始列值（含 BLOB），而工具回执只有一段给人看的文本。
//
// 编码模型一律不加载：B 组注入 encode 桩函数（文本片段 → 固定向量），A 组把 encoderEnabled 关掉、
// 直接走降级路径（零向量）。这些用例关心的量都不来自编码模型，加载它只会让用例变慢、依赖模型文件。
//
// 关于「同主题」怎么构造：落位并入已有主题要同时满足两个条件（src/pipeline/write.ts:716-717）——
// 向量余弦 >= tauJoin、词面重合 >= tauLex。所以下面凡是需要两条记忆并进同一主题的用例，
// 都让两条文本共享一段前缀（词面条件）、并给它们同一个向量（几何条件）。

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { apply } from '../dist/index.js'
import { closeRuntime, getRuntime } from '../dist/state.js'
import { openVault } from '../dist/db/open.js'
import { createWriteCtx, writeAtom, buildSearchBody, ForgottenError } from '../dist/pipeline/write.js'
import { forgetAtom } from '../dist/pipeline/forget.js'
import { recall } from '../dist/pipeline/search.js'
import { VEC_DIM } from '../dist/util/vec.js'
import { SUMMARY_CHARS } from '../dist/util/text.js'

// ── 共用小工具 ────────────────────────────────────────────────────────────

/** 第 i 个维度为 1、其余为 0 的向量。两段文本拿到同一个 i 就表示「几何上完全一样」。 */
function oneHot(i) {
  const v = new Float32Array(VEC_DIM)
  v[i % VEC_DIM] = 1
  return v
}

/**
 * 第 i 维为主、第 j 维为副的向量，与 oneHot(i) 的余弦恰为 w（副维取 sqrt(1-w²)）。
 * 用来构造「并入但对得不够完美」的写入，让两条记忆的 fit 不相等。
 */
function mixedVec(i, j, w) {
  const v = new Float32Array(VEC_DIM)
  v[i % VEC_DIM] = w
  v[j % VEC_DIM] = Math.sqrt(1 - w * w)
  return v
}

/**
 * 编码桩：按「文本片段 → 向量」的表返回。表里没有的文本给 oneHot(511)，
 * 也就是与表内任何向量都正交，用来当「和已有关联无关的文本」。
 */
function encodeWith(table) {
  return async (text) => {
    for (const [needle, vec] of table) if (text.includes(needle)) return vec
    return oneHot(511)
  }
}

/**
 * 把 db 包一层，让「重算 mean_fit」那条查询抛错。
 *
 * 写入路径里重算 mean_fit 的那一段是 try/catch 吞错的（src/pipeline/write.ts:944-950），
 * 不注入一次失败就只能观察到成功的分支。onFail 用来记「注入真的被问到过」。
 */
function wrapDb(db, { failGetWhen, onFail } = {}) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => {
          const stmt = target.prepare(sql)
          return new Proxy(stmt, {
            get(st, p) {
              if (p === 'get' && failGetWhen !== undefined && failGetWhen(sql)) {
                return () => {
                  if (onFail !== undefined) onFail(sql)
                  throw new Error('注入的失败：重算 mean_fit 的查询')
                }
              }
              const v = st[p]
              return typeof v === 'function' ? v.bind(st) : v
            },
          })
        }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

/** 库里「哪条记忆属于哪个主题」的指纹。用于比对两次写入之间既有行有没有被改过。 */
function assignmentHash(db, maxId) {
  const rows = db.prepare('SELECT id, topic_id FROM atom WHERE id <= ? ORDER BY id').all(maxId)
  const h = createHash('sha256')
  for (const r of rows) h.update(r.id + ':' + r.topic_id + ';')
  return h.digest('hex')
}

// 两条共享前缀的文本：前缀保证词面重合，同一个向量保证余弦为 1。
const TEXT_A = '系统代理必须走本地端口，否则访问境外源时会直接超时。'
const TEXT_B = '系统代理必须走本地端口，局域网内的访问同样不能例外。'
const SHARED = '系统代理必须走本地端口'

// ── A 组：工具层 ───────────────────────────────────────────────────

describe('A 组 · 工具层：scope 透传', () => {
  let dir
  let tools

  function fakeCtx() {
    const registered = []
    return {
      registered,
      get(name) {
        return name === 'tools'
          ? {
              register: (t) => {
                registered.push(t)
              },
            }
          : undefined
      },
      effect(fn) {
        return fn()
      },
      inject() {},
    }
  }

  function cfg() {
    return {
      enabled: true,
      dataDir: dir,
      // 关掉编码器：这条约定与向量无关，降级路径（零向量）照样写 scope。
      encoderEnabled: false,
      encoderModel: 'Xenova/bge-small-zh-v1.5',
      encoderMirror: '',
      encoderCacheDir: '',
      tauJoin: 0.78,
      tauLex: 0.05,
      tauLexOnly: 0.1,
      tauNew: 0.5,
      topN: 24,
      mmapSize: 0,
      cacheSize: 0,
      busyTimeout: 0,
    }
  }

  function tool(name) {
    const t = tools.find((x) => x.name === name)
    assert.ok(t, '工具没有注册：' + name)
    return t
  }

  beforeEach(() => {
    closeRuntime()
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-tools-'))
    const ctx = fakeCtx()
    apply(ctx, cfg())
    tools = ctx.registered
  })

  afterEach(() => {
    closeRuntime()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  it('scope 只做字符串透传：大小写不同的两个值原样入库', async () => {
    // #24 跨 scope 不归一
    await tool('lattice_write').execute({ text: '第一行：网关的端口映射由运维统一维护。', scope: 'Proj-A' })
    await tool('lattice_write').execute({ text: '第二行：值班表在每周一早上重新排一次。', scope: 'proj-a' })
    const db = getRuntime({}).db
    const scopes = db
      .prepare('SELECT scope FROM atom ORDER BY id')
      .all()
      .map((r) => r.scope)
    // 两条都写进去了，且 scope 一字不改（没有被转小写、没有被当成非法值改成 global）
    assert.deepEqual(scopes, ['Proj-A', 'proj-a'])
    // 两个值在库里是两个不同的值 —— 归一发生过的话这里会是 1
    assert.equal(db.prepare('SELECT COUNT(DISTINCT scope) AS n FROM atom').get().n, 2)
  })
})

// ── B 组：pipeline 层（其余十条） ────────────────────────────────────────

describe('B 组 · 写入路径：scope / 主题 / 聚合列', () => {
  let dir
  let db

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-pipe-'))
    db = openVault(join(dir, 'lattice.db')).db
  })

  afterEach(() => {
    closeRuntime()
    try {
      db?.close()
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  it('落位不看 scope：换了 scope 的相似文本仍并进同一个主题', async () => {
    // #25 落位候选不带 scope 条件
    const ctx = createWriteCtx(db, {}, { encode: encodeWith([[SHARED, oneHot(3)]]) })
    const a = await writeAtom(ctx, { text: TEXT_A, scope: 'p1' })
    const b = await writeAtom(ctx, { text: TEXT_B, scope: 'p2' })
    // 同一条主题：第二段的 topic_id 与第一段相同，且库里没有多出第二个主题
    assert.equal(b.topicId, a.topicId)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topic').get().n, 1)
  })

  it('防写回不看 scope：删过的文本换一个 scope 再写仍被拒', async () => {
    // #28 墓碑比对不看 scope
    const text = '境外源访问必须走系统代理，否则直连会被拒绝。'
    const ctx = createWriteCtx(db, {}, { encode: encodeWith([['境外源访问', oneHot(4)]]) })
    const a = await writeAtom(ctx, { text, scope: 'p1' })
    const summary = db.prepare('SELECT summary FROM atom WHERE id = ?').get(a.atomId).summary
    assert.ok(forgetAtom(db, { atomId: a.atomId }), '第一次删除应成功')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n, 0)

    // 同一段文本、换成 global 再写：内容一样就该被拦，scope 不同不是放行的理由
    await assert.rejects(
      () => writeAtom(ctx, { text, scope: 'global' }),
      (err) => {
        assert.ok(err instanceof ForgottenError, '应以 ForgottenError 拒绝写入，实际是：' + err)
        return true
      },
    )
    // 被拦之后库里不该出现这一条
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM atom').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM atom WHERE summary = ?').get(summary).n, 0)
  })

  it('topic 表没有 scope 列：不同 scope 的两条记忆共用一行主题', async () => {
    // #29 主题不按 scope 分区
    const ctx = createWriteCtx(db, {}, { encode: encodeWith([[SHARED, oneHot(3)]]) })
    const a = await writeAtom(ctx, { text: TEXT_A, scope: 'p1' })
    const b = await writeAtom(ctx, { text: TEXT_B, scope: 'global' })
    assert.equal(b.topicId, a.topicId)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topic').get().n, 1)

    const cols = db.prepare('PRAGMA table_info(topic)').all()
    assert.equal(cols.length, 8)
    assert.ok(
      cols.every((c) => c.name !== 'scope'),
      'topic 表不该有 scope 列，实际列：' + cols.map((c) => c.name).join(','),
    )
  })

  it('写入路径不改既有 atom 的归属：(id, topic_id) 指纹在写入前后一致', async () => {
    // #36 写入路径不 UPDATE atom.topic_id
    const ctx = createWriteCtx(db, {}, { encode: encodeWith([[SHARED, oneHot(3)]]) })
    const a = await writeAtom(ctx, { text: TEXT_A })
    const before = assignmentHash(db, a.atomId)
    const b = await writeAtom(ctx, { text: TEXT_B })
    const after = assignmentHash(db, a.atomId)
    // 指纹只覆盖写入前已存在的行：新写的那一条本来就该多一行，把它算进去等于让这条约束必然不成立
    assert.equal(after, before)
    // 指纹的灵敏度：单独把既有那条的归属改掉再算一次，指纹必须变。
    // 直接拿「含新行」的指纹去比证明不了这件事 —— 那个差异只说明行数变了。
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare('UPDATE atom SET topic_id = 999 WHERE id = ?').run(a.atomId)
    const tampered = assignmentHash(db, a.atomId)
    db.prepare('UPDATE atom SET topic_id = ? WHERE id = ?').run(a.topicId, a.atomId)
    db.exec('PRAGMA foreign_keys = ON')
    assert.notEqual(tampered, before, '指纹应对归属变化敏感，否则上面的「没变」说明不了任何事')
    // 前提检查：这次写入确实并进了 A 的主题。若它是新建主题，上面的「没变」也可能是「根本没比对」
    assert.equal(b.topicId, a.topicId)
  })

  it('新建主题的列值：sum_vec 等于该条记忆的向量、n_atoms=1、mean_fit=0、label 是摘要前 16 字符', async () => {
    // #38 新建主题的初值
    const text = '傍晚的路灯把影子拉得很长，我站在站台上等那班永远晚点的车。'
    const vec = oneHot(7)
    // 注入一次失败：否则写完之后 mean_fit 会立刻被重算成 AVG(fit)，看不到建行时写下的 0
    const failed = { calls: 0 }
    const wrapped = wrapDb(db, {
      failGetWhen: (sql) => sql.includes('AVG(fit)'),
      onFail: () => {
        failed.calls += 1
      },
    })
    const ctx = createWriteCtx(wrapped, {}, { encode: async () => vec })
    const r = await writeAtom(ctx, { text })
    assert.equal(failed.calls, 1, '注入应被问到一次（说明重算那段真的执行了）')

    const topic = db.prepare('SELECT * FROM topic WHERE id = ?').get(r.topicId)
    const atom = db.prepare('SELECT summary, embedding FROM atom WHERE id = ?').get(r.atomId)
    assert.equal(topic.n_atoms, 1)
    assert.equal(topic.mean_fit, 0)
    assert.equal(topic.label, atom.summary.slice(0, 16))
    // 文本 30 字，摘要有 16 字以上，所以 label 不可能是整条摘要的巧合
    assert.equal(Array.from(topic.label).length, 16)
    assert.deepEqual(Buffer.from(topic.sum_vec), Buffer.from(atom.embedding))
  })

  it('mean_fit 在提交之后按 AVG(fit) 重算，重算失败不阻断写入', async () => {
    // #39 mean_fit 重算位置与失败处理
    const ctx = createWriteCtx(db, {}, { encode: encodeWith([[SHARED, oneHot(3)]]) })
    const a = await writeAtom(ctx, { text: TEXT_A })
    const b = await writeAtom(ctx, { text: TEXT_B })
    assert.equal(b.topicId, a.topicId)
    const topic = db.prepare('SELECT mean_fit FROM topic WHERE id = ?').get(a.topicId)
    const avg = db.prepare('SELECT AVG(fit) AS f FROM atom WHERE topic_id = ?').get(a.topicId)
    // 重算过：主题行上的值与直接按成员算出来的平均值一致
    assert.equal(topic.mean_fit, avg.f)

    // 第二段：让重算那条查询抛错，写入本身不能跟着失败
    const failed = { calls: 0 }
    const wrapped = wrapDb(db, {
      failGetWhen: (sql) => sql.includes('AVG(fit)'),
      onFail: () => {
        failed.calls += 1
      },
    })
    const ctx2 = createWriteCtx(wrapped, {}, { encode: async () => oneHot(9) })
    const c = await writeAtom(ctx2, { text: '洗手间的门把手松了，需要找物业换一个螺丝。' })
    assert.equal(failed.calls, 1, '注入应被问到一次')
    assert.ok(c.atomId > b.atomId)
    // 前两条还在库里（失败的是重算，不是写入）
    assert.ok(db.prepare('SELECT 1 AS ok FROM atom WHERE id = ?').get(a.atomId))
    assert.ok(db.prepare('SELECT 1 AS ok FROM atom WHERE id = ?').get(b.atomId))
  })

  it('删除后重算 n_atoms 与 mean_fit，删空时不重写 sum_vec', async () => {
    // #41 删除后的主题聚合值
    // B 与 A 的余弦取 0.85：仍高于并入线（0.78），但两条的 fit 不相等 ——
    // 若两条的 fit 都是 1，重算出来的平均值与不重算时的旧值读数相同，这条断言就分不出重算有没有发生。
    const ctx = createWriteCtx(
      db,
      {},
      {
        encode: encodeWith([
          ['局域网内的访问', mixedVec(3, 100, 0.85)],
          ['否则访问境外源', oneHot(3)],
        ]),
      },
    )
    const a = await writeAtom(ctx, { text: TEXT_A })
    const b = await writeAtom(ctx, { text: TEXT_B })
    assert.equal(b.topicId, a.topicId)
    assert.notEqual(a.fit, b.fit)

    forgetAtom(db, { atomId: b.atomId })
    const afterB = db.prepare('SELECT n_atoms, mean_fit, sum_vec FROM topic WHERE id = ?').get(a.topicId)
    const avg = db.prepare('SELECT AVG(fit) AS f FROM atom WHERE topic_id = ?').get(a.topicId)
    const atomA = db.prepare('SELECT embedding FROM atom WHERE id = ?').get(a.atomId)
    assert.equal(afterB.n_atoms, 1)
    assert.equal(afterB.mean_fit, avg.f)
    // 且等于剩下那条 A 的 fit —— 不是删除前两条的平均值（那正是「没重算」时的读数）
    assert.equal(afterB.mean_fit, a.fit)
    // 剩下的成员只有 A，重算出来的和向量就是 A 的向量（这同时说明它不是零向量）
    assert.deepEqual(Buffer.from(afterB.sum_vec), Buffer.from(atomA.embedding))

    const sumBefore = Buffer.from(afterB.sum_vec)
    forgetAtom(db, { atomId: a.atomId })
    const afterA = db.prepare('SELECT n_atoms, sum_vec FROM topic WHERE id = ?').get(a.topicId)
    assert.equal(afterA.n_atoms, 0)
    // 空主题没有可用向量可累加，sum_vec 保持原样而不是被写成零
    assert.deepEqual(Buffer.from(afterA.sum_vec), sumBefore)
  })

  it('删除不删空主题，空主题也不再被落位选中', async () => {
    // #42 空主题保留、且不参与落位候选
    const lone = '机房的空调在夜间会切到除湿档，值班的人需要留意水位。'
    // 不能给它和 lone 同一个向量：lone 已被删成墓碑，写入前的墓碑判重按余弦算，
    // 同向量会被当成「删过的内容」直接拒写（ForgottenError）。所以这里只造无关向量，
    // 「不落空主题」的原因另用源码断言钉住，见用例末尾。
    const unrelated = '周末的市集改到了河对岸的旧仓库，摊位比上个月多了一倍。'
    const ctx = createWriteCtx(db, {}, { encode: encodeWith([[lone.slice(0, 8), oneHot(3)]]) })
    const a = await writeAtom(ctx, { text: lone })
    const emptyTopicId = a.topicId
    forgetAtom(db, { atomId: a.atomId })

    const still = db.prepare('SELECT n_atoms FROM topic WHERE id = ?').get(emptyTopicId)
    assert.ok(still, '主题行应仍在库里')
    assert.equal(still.n_atoms, 0)

    // 再写一条与它无关的文本：落位候选只取 n_atoms > 0 的主题，所以它必须另建主题
    const b = await writeAtom(ctx, { text: unrelated })
    assert.notEqual(b.topicId, emptyTopicId)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topic').get().n, 2)
    // 空主题没被新写入顺手填满
    assert.equal(db.prepare('SELECT n_atoms FROM topic WHERE id = ?').get(emptyTopicId).n_atoms, 0)
    // 上面「没落位」也可能只是因为 unrelated 与空主题余弦不够 —— 那说明不了 n_atoms 规则。
    // 真正的原因是候选查询按 n_atoms > 0 过滤，空主题根本进不了候选集。
    const writeSrc = readFileSync(new URL('../src/pipeline/write.ts', import.meta.url), 'utf8')
    assert.ok(
      writeSrc.includes('FROM topic WHERE n_atoms > 0'),
      '落位候选查询必须排除空主题（src/pipeline/write.ts）',
    )
  })

  it('atom_search.body 是「摘要 摘要 正文 入口词」，1600 字符只截正文段', async () => {
    // #46 body 的拼法与截断位置
    const summary = '摘'.repeat(SUMMARY_CHARS)
    const longText = '甲'.repeat(2000)
    const built = buildSearchBody(summary, longText, [])
    const parts = built.split(' ')
    // 前两段都是摘要：正文很长时摘要照样出现两次，不被截掉
    assert.equal(parts[0], summary)
    assert.equal(parts[1], summary)
    // 正文段被截到 1600 字符（上限常量是正文段的上限，不是整串的长度）
    assert.equal(parts[2].length, 1600)
    assert.equal((built.match(/甲/g) ?? []).length, 1600)
    // 整串长度 = 摘要 + 空格 + 摘要 + 空格 + 正文 + 空格 + 入口词（此处入口词为空）
    assert.equal(built.length, 2 * SUMMARY_CHARS + 2 + 1600 + 1)

    // 写入路径上正文走不到 1600（写入前已按 600 字切分），但仍要确认落库的 body 以两段摘要开头
    const ctx = createWriteCtx(db, {}, { encode: async () => oneHot(6) })
    const r = await writeAtom(ctx, { text: '乙'.repeat(500) })
    const stored = db.prepare('SELECT body FROM atom_search WHERE id = ?').get(r.atomId)
    const row = db.prepare('SELECT summary FROM atom WHERE id = ?').get(r.atomId)
    assert.ok(stored, 'atom_search 里应有这条记忆的 body')
    assert.ok(
      stored.body.startsWith(row.summary + ' ' + row.summary),
      'body 应以两段摘要开头，实际开头：' + stored.body.slice(0, 60),
    )
  })

  it('图路只走白名单关系：related 边带来候选、duplicate 边不带来', async () => {
    // #21 图路白名单（补缺-2）
    const bVec = oneHot(1)
    const cVec = oneHot(2)
    const aVec = oneHot(0)
    const ctx = createWriteCtx(
      db,
      {},
      {
        encode: encodeWith([
          ['香蕉要放在阴凉处', bVec],
          ['会议纪要抄送给了', cVec],
          ['系统的端口映射', aVec],
        ]),
      },
    )
    const b = await writeAtom(ctx, { text: '香蕉要放在阴凉处，别和苹果堆在一起。' })
    const c = await writeAtom(ctx, { text: '会议纪要抄送给了不在场的三位同事。' })
    const a = await writeAtom(ctx, {
      text: '系统的端口映射由网关统一维护。',
      edges: [
        { type: 'related', target: b.atomId },
        { type: 'duplicate', target: c.atomId },
      ],
    })
    // 写入侧两条边都收下了（duplicate 不被写入侧拒，拒它的是召回侧的图路白名单）
    assert.equal(a.edgesDeclared, 2)
    assert.deepEqual(a.edgesRejected ?? [], [])

    // 两条边都真的落库了。「C 没进候选」要能怪到白名单头上，先得证明库里确实有那条 duplicate 边
    // 只看声明边：写入路径另有一套机制会在写入后补推断的近邻边（src/graph/infer.ts 的 linkNewAtom），
    // 那是另一回事，混进来会让「这两条声明边都落了库」这句话失真。
    const edges = db
      .prepare("SELECT dst_id, kind FROM edge WHERE src_id = ? AND origin = 'declared' ORDER BY dst_id")
      .all(a.atomId)
    assert.deepEqual(
      edges.map((e) => [e.dst_id, e.kind]),
      [
        [b.atomId, 'related'],
        [c.atomId, 'duplicate'],
      ],
    )

    const query = '系统的端口映射由网关统一维护。'
    const r = recall(db, query, aVec, { kVec: 1 })
    const ids = r.hits.map((h) => h.id)
    const hitB = r.hits.find((h) => h.id === b.atomId)
    assert.ok(hitB, 'related 边应把 B 带进候选，实际候选：' + ids.join(','))
    // B 的文本与查询没有共同词、向量与查询正交，所以它只可能由 graph 这一路引入
    assert.deepEqual(Object.keys(hitB.ranks), ['graph'])
    assert.ok(r.meta.counts.graph >= 1)
    assert.ok(
      !ids.includes(c.atomId),
      'duplicate 边不在图路白名单里，C 不该被带进候选，实际候选：' + ids.join(','),
    )
  })
})

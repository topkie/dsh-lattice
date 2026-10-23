// 写入侧派生验证：取代（supersedes / unsupersede）与声明关系边（edges）的边界。
//
// 下面这组用例覆盖这些边界：目标不存在、目标存在但改写失败、同一目标多次取代、跨 scope 取代、
// 被切成两段时只落在第一段、时间戳不变、非正整数 target、同批重复声明、边数上限。
//
// 全部走真实工具入口（apply + 独立临时目录）：这些约定断言的是两件事 —— 调用方在回执文本里
// 看见了什么，以及库里最终留下了什么。回执文案取自 src/tools/index.ts 与 src/pipeline/write.ts，
// 改文案时这些用例会红，那是故意的：文案本身就是约定的一部分。
//
// 编码器关闭（encoderEnabled: false）：向量不是这十条的判据，关掉之后不必加载模型，
// 结果只由文本与库里的行决定。这与 declared-edges.test.mjs / unsupersede.test.mjs 的写法一致。
//
// 隔离纪律：每个用例自己的临时数据目录，结束时关闭运行时并删目录，不碰用户真实库。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { apply } from '../dist/index.js'
import { resetEncoder } from '../dist/encoder/index.js'
import { writeReviewed } from '../dist/pipeline/write.js'
import { closeRuntime, getRuntime } from '../dist/state.js'

let dir = ''
let tools = []

/** 最小假 ctx：插件只用到 tools.register 这一个服务，其余给同形状的替身。 */
function fakeCtx() {
  const registered = []
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
  if (!t) throw new Error('工具未注册: ' + name)
  return t
}

/** 写入一次，返回回执文本。 */
function write(args) {
  return tool('lattice_write').execute(args)
}

/** 回执里第一处「已写入记忆 #N」的 N。 */
function atomIdOf(receipt) {
  const m = /已写入记忆 #([0-9]+)/.exec(receipt)
  assert.ok(m !== null, '回执里没有 atom id：' + receipt)
  return Number(m[1])
}

/** 回执里含某个片段的行（用于按行计数、读单行原文）。 */
function receiptLines(receipt, needle) {
  return receipt.split(String.fromCharCode(10)).filter((line) => line.includes(needle))
}

function db() {
  return getRuntime({}).db
}

/** 一条 atom 的关系类列；行不存在直接判失败。 */
function atomRow(id) {
  const row = db()
    .prepare('SELECT superseded_by, superseded_at, updated_at, scope FROM atom WHERE id = ?')
    .get(id)
  assert.ok(row !== undefined, '库里没有 atom #' + id)
  return row
}

/** 某个 atom 声明出去的关系行（atom → atom，origin=declared）。 */
function declaredRows(srcId) {
  return db()
    .prepare(
      "SELECT kind, dst_id FROM edge WHERE src_type = 'atom' AND src_id = ? " +
        "AND dst_type = 'atom' AND origin = 'declared' ORDER BY kind, dst_id",
    )
    .all(srcId)
}

/** 以 dstId 为终点的取代关系行。取代不走 edge 表，这里应当是空的。 */
function supersedeEdgeRows(dstId) {
  return db()
    .prepare("SELECT id FROM edge WHERE dst_type = 'atom' AND dst_id = ? AND kind = 'supersedes'")
    .all(dstId)
}

/** 1200 字、20 个以句号结尾的句子：任何一半都超过单条上限 600，必定被切分。 */
function longText() {
  const POOL = '写入侧派生验证要求每条断言都落在观测到的副作用上'
  const parts = []
  for (let i = 0; i < 20; i += 1) {
    let s = '第' + (i + 1) + '句：'
    let k = i
    while (s.length < 59) {
      s += POOL[k % POOL.length]
      k += 1
    }
    parts.push(s + '。')
  }
  return parts.join('')
}

describe('写入侧取代关系与声明边的边界', () => {
  beforeEach(() => {
    // 编码器状态是模块级单例：不复位的话可能沿用上一个文件留下的状态。
    resetEncoder()
    closeRuntime()
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-supersede-'))
    const ctx = fakeCtx()
    apply(ctx, cfg())
    tools = ctx.registered
  })

  afterEach(() => {
    closeRuntime()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  })

  // #1 取代在写入事务提交之后单独执行
  it('目标不存在时回执同时出现「已写入记忆」与「未建立取代关系」两行', async () => {
    await write({ text: '系统代理必须走本地端口，否则访问境外源会超时。' })
    const out = await write({
      text: '代理改走 7890 端口，旧的写法不再适用。',
      supersedes: 999999,
    })
    const bid = atomIdOf(out)
    // 这两行一起出现就是「写入已经提交、取代没有建立」的独立证据：
    // 若取代被塞进写入事务并随失败回滚，回执里不会同时有「已写入」。
    assert.ok(out.includes('已写入记忆 #' + bid), '回执里应当有写入成功那一行：' + out)
    assert.ok(
      out.includes('注意：要取代的记忆 #999999 不存在，未建立取代关系。'),
      '回执里应当有取代未建立那一行：' + out,
    )
    atomRow(bid)
  })

  // #1 的另一半：目标在库里，但改写它这一步本身失败。
  it('目标存在但改写失败时，写入已经落库，错从取代那一步抛出来', async () => {
    const a = await write({ text: '旧写法：代理配置写在环境变量里，重启就丢。' })
    const aid = atomIdOf(a)
    const text = '新写法：代理配置写进配置文件，环境变量那条作废。'
    const rt = getRuntime({})
    const real = rt.db
    // 只拦取代那一条 UPDATE：其余查询照常走真库，所以「写入有没有落库」仍然可读。
    const broken = new Proxy(real, {
      get(t, p) {
        if (p === 'prepare') {
          return (sql) => {
            if (String(sql).includes('UPDATE atom SET superseded_by')) {
              throw new Error('注入：改写旧条失败')
            }
            return t.prepare(sql)
          }
        }
        const v = t[p]
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    let threw = null
    rt.db = broken
    try {
      await write({ text, supersedes: aid })
    } catch (e) {
      threw = e
    } finally {
      rt.db = real
    }
    assert.equal(
      threw === null ? null : threw.message,
      '注入：改写旧条失败',
      '没抛这个错就说明注入没命中，这条用例测的是别的路径',
    )
    // 写入在取代之前就已提交：这里抛的是取代那一步的错，用户写下的东西不该跟着消失。
    assert.ok(db().prepare('SELECT id FROM atom WHERE text = ?').get(text), '写入必须已经落库')
    assert.equal(atomRow(aid).superseded_by, null, '取代没建立，旧条的标记不该被改动')
  })

  // #2 目标不存在时只追加回执、不抛不回滚
  it('目标不存在时不抛异常，回执给出原因，本次写入照常落库', async () => {
    let threw = null
    let out = ''
    try {
      out = await write({ text: '取消取代只清掉标记，不删除任何记忆。', supersedes: 999999 })
    } catch (e) {
      threw = e
    }
    assert.equal(threw, null, '目标不存在不该抛异常，实际抛出：' + (threw && threw.message))
    assert.ok(
      out.includes('注意：要取代的记忆 #999999 不存在，未建立取代关系。'),
      '回执里应当给出目标不存在的原因：' + out,
    )
    // 不能出现成功那句：否则调用方会以为取代关系已经建立。
    assert.equal(out.includes('标记为被'), false, '目标不存在时不该报「标记为被…取代」：' + out)
    atomRow(atomIdOf(out))
  })

  // #4 无条件覆盖
  it('对同一条先后两次取代，最终指向最后一个取代者', async () => {
    const a = atomIdOf(await write({ text: '代理端口是 7890，这是最早的说法。' }))
    const b = atomIdOf(await write({ text: '代理端口改成 8080，最早的说法作废。', supersedes: a }))
    assert.equal(Number(atomRow(a).superseded_by), b, '第一次取代应当生效')
    const c = atomIdOf(await write({ text: '代理端口最后定在 9090，前两次的说法都作废。', supersedes: a }))
    assert.equal(Number(atomRow(a).superseded_by), c, '第二次取代应当直接覆盖，而不是拒绝或保留首个取代者')
    // 「库里没有任何一列还记着 B 取代过 A」：取代只写 atom 的两列、不写 edge 表，
    // 所以除了 superseded_by（现在指向 C）之外，没有别的地方留下第一次取代的痕迹。
    assert.equal(supersedeEdgeRows(a).length, 0, '取代不该在 edge 表里留行')
    assert.equal(atomRow(b).superseded_by, null, 'B 自己没有被取代，不该被动到')
  })

  // #5 重复调用刷新 superseded_at
  it('对同一条连续两次取代，superseded_at 被刷成更晚的时间', async () => {
    const a = atomIdOf(await write({ text: '这条记忆会被连续取代两次，用来观察时间戳。' }))
    await write({ text: '第一次取代它的新说法，写在这里。', supersedes: a })
    const t1 = Number(atomRow(a).superseded_at)
    assert.ok(t1 > 0, '第一次取代后 superseded_at 应当非空')
    // 间隔 5 毫秒：两次 UPDATE 都取 Date.now()，同一毫秒内取到相同的值会让「严格更大」判不出来。
    await new Promise((resolve) => setTimeout(resolve, 5))
    const c = atomIdOf(await write({ text: '第二次取代它的新说法，也写在这里。', supersedes: a }))
    const t2 = Number(atomRow(a).superseded_at)
    assert.ok(t2 > t1, '第二次取代应当刷新时间戳：第一次 ' + t1 + '，第二次 ' + t2)
    assert.equal(Number(atomRow(a).superseded_by), c, '取代者也应当更新成第二次写入的那条')
  })

  // #6 跨 scope 取代
  it('取代只按 id 匹配，跨 scope 也能建立', async () => {
    const a = atomIdOf(
      await write({ text: '全局域里的一条记忆，稍后会被项目域的那条取代。', scope: 'global' }),
    )
    const b = atomIdOf(
      await write({ text: '项目域里的这一条取代全局域的那一条。', scope: 'proj', supersedes: a }),
    )
    assert.equal(Number(atomRow(a).superseded_by), b, '跨 scope 取代应当成功')
    assert.equal(atomRow(a).scope, 'global', '被取代方写的是关系，不是归属：scope 不该被改写')
    assert.equal(atomRow(b).scope, 'proj', '取代方自己的 scope 也不该被改动')
  })

  // #7 切分后取代只落第一条
  it('取代一条会被切成两段的文本时，只落在第一段', async () => {
    const a = atomIdOf(await write({ text: '这条旧记忆会被一条按长度切开的文本取代。' }))
    const long = longText()
    assert.equal(long.length, 1200, '这条用例的输入应当是 1200 字，实际 ' + long.length)
    const out = await write({ text: long, supersedes: a })
    const writeLines = receiptLines(out, '已写入记忆 #')
    assert.equal(writeLines.length, 2, '1200 字应当被切成两段分别写入：' + out)
    assert.ok(out.includes('（切分后的第一条）'), '回执要说清取代落在哪一段：' + out)
    // 第一处「已写入记忆 #N」就是第一段。
    const firstId = Number(/已写入记忆 #([0-9]+)/.exec(writeLines[0])[1])
    assert.equal(Number(atomRow(a).superseded_by), firstId, '取代关系应当落在第一段上')
    assert.ok(Number(atomRow(a).superseded_at) > 0, '建立取代后 superseded_at 应当非空')
  })

  // #12 取代与取消取代只动两列
  it('取代与取消取代都不改 updated_at，superseded_at 从非空回到 NULL', async () => {
    const a = atomIdOf(await write({ text: '这条记忆的 updated_at 在两轮关系改动里都不该变。' }))
    const updatedAt = atomRow(a).updated_at
    // 基线本身要是真值：updated_at 为 NULL 时后面两次相等断言都恒真，等于没测。
    assert.ok(typeof updatedAt === 'number' && updatedAt > 0, '基线 updated_at 应当是非零数字：' + updatedAt)
    await write({ text: '一条新说法，用来取代上一条。', supersedes: a })
    const afterSupersede = atomRow(a)
    assert.equal(afterSupersede.updated_at, updatedAt, '建立取代只改关系，不该碰 updated_at')
    assert.ok(afterSupersede.superseded_at !== null, '建立取代后 superseded_at 应当非空')
    await write({ text: '这次只撤销改口，正文随便写一句占位。', unsupersede: a })
    const afterUnsupersede = atomRow(a)
    assert.equal(afterUnsupersede.updated_at, updatedAt, '取消取代也只改关系，不该碰 updated_at')
    assert.equal(afterUnsupersede.superseded_at, null, '取消取代后 superseded_at 应当回到 NULL')
    assert.equal(afterUnsupersede.superseded_by, null, '取消取代后 superseded_by 应当回到 NULL')
  })

  // #16 target 只接受正整数
  it('target 不是正整数时整条边被拒，且不落 edge 表', async () => {
    await write({ text: '第一个关系目标，用来证明 id 存在本身不是被拒的原因。' })
    const b = atomIdOf(await write({ text: '第二个关系目标，被下面那条边用非法 target 指向。' }))

    // 一、走工具入口：target 是数字但不是整数（1.5）。
    // 宿主只在参数形状上要求「是数字」，所以这个值能走到写入层，
    // 回执里也就能看到写入层给出的拒因。
    const out = await write({
      text: '声明一条 target 是小数 1.5 的关系边，应当被整条拒掉。',
      edges: [{ type: 'related', target: 1.5 }],
    })
    const c = atomIdOf(out)
    assert.ok(out.includes('target 必须是正整数 id'), '回执要给出拒因：' + out)
    assert.equal(receiptLines(out, '关系未建立').length, 1, '只该有 1 条被拒的边：' + out)
    // 落库条数那一行只在确实落库时才出现；被拒的边不该报成「关系 N 条（声明）」。
    assert.equal(/关系 [0-9]+ 条（声明）/.test(out), false, '被拒的边不算落库：' + out)
    assert.equal(declaredRows(c).length, 0, 'C 不该有任何声明关系行')

    // 二、走写入层：target 写成字符串（清单原本就想验的「不做 Number() 转换」）。
    // 这一层必须直接调 writeReviewed，而不是工具入口 —— 工具入口的参数校验会把字符串先拒掉
    // （观察到的报错是 INVALID_ARGS：edges[0].target must be a number），
    // 写入层的这条判断在那里根本走不到。本用例不断言宿主那一层会做什么，
    // 只把「写入层收到字符串时怎么处理」钉住。
    const direct = await writeReviewed(getRuntime({}).write, {
      text: '直接调写入层，声明一条 target 写成字符串的关系边。',
      edges: [{ type: 'related', target: String(b) }],
    })
    assert.equal(direct.results.length, 1, '边被拒不该拦住记忆本身')
    const rejected = (direct.results[0].edgesRejected ?? []).filter((n) => n.type === 'related')
    assert.equal(rejected.length, 1, '写入层应当拒掉这一条边')
    assert.equal(rejected[0].reason, 'target 必须是正整数 id', '拒因与工具回执用的是同一句')
    assert.equal(declaredRows(direct.results[0].atomId).length, 0, '写入层也不该为它落 edge 行')
  })

  // #17 同批重复 (type,target) 只拒后面那条
  it('同一批里重复声明同一条关系时，只拒后面那条', async () => {
    await write({ text: '同批重复关系里被指向的那一条，先写进库里。' })
    const b = atomIdOf(await write({ text: '这条才是下面那两条重复边指向的目标。' }))
    const out = await write({
      text: '同一批里把同一条关系声明了两次，观察回执与表里各留几条。',
      edges: [
        { type: 'related', target: b },
        { type: 'related', target: b },
      ],
    })
    const c = atomIdOf(out)
    const rejected = receiptLines(out, '关系未建立')
    assert.equal(rejected.length, 1, '两条相同的边只该拒后面那条：' + out)
    assert.ok(rejected[0].includes('与本次声明里的另一条重复'), '拒因要说明是同一批里重复：' + rejected[0])
    assert.equal(declaredRows(c).length, 1, 'edge 表里 C 指向 B 只该有 1 行')
    assert.ok(out.includes('关系 1 条（声明）'), '回执要报出实际落库 1 条：' + out)
  })

  // #18 出度上限 16
  it('一条记忆声明 17 条关系时，只有前 16 条落库', async () => {
    const topics = [
      '代理',
      '缓存',
      '数据库',
      '索引',
      '编码器',
      '词表',
      '召回路',
      '写入',
      '事务',
      '锁',
      '日志',
      '样本',
      '审计',
      '归档',
      '主题',
      '重聚类',
      '阈值',
    ]
    const targets = []
    for (let i = 0; i < topics.length; i += 1) {
      targets.push(
        atomIdOf(
          await write({
            text:
              '关系上限用例的第 ' + (i + 1) + ' 个目标，主题是' + topics[i] + '，只用来占住一个 atom id。',
          }),
        ),
      )
    }
    assert.equal(targets.length, 17)
    const edges = targets.map((id) => ({ type: 'related', target: id }))
    const out = await write({ text: '这条一次声明 17 条关系，按上限只该落库 16 条。', edges })
    const c = atomIdOf(out)
    assert.equal(declaredRows(c).length, 16, 'edge 表里应当新增 16 行声明关系')
    const rejected = receiptLines(out, '关系未建立')
    assert.equal(rejected.length, 1, '恰好 1 条被上限拒掉：' + out)
    assert.ok(rejected[0].includes('超过单条记忆的关系上限（16 条）'), '拒因要说明是条数上限：' + rejected[0])
    assert.ok(out.includes('关系 16 条（声明）'), '回执要报出实际落库 16 条：' + out)
  })
})

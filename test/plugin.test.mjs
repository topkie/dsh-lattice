import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import { Config, apply, inject, name } from '../dist/index.js'
import { openVault } from '../dist/db/open.js'
import { closeRuntime } from '../dist/state.js'

/**
 * 最小假 ctx：只实现插件用到的那两个服务，外加 `inject`。
 *
 * `inject(deps, callback)` 在真 cordis 里起的是一个**子 fiber**：deps 全部就绪才执行
 * callback，父插件不受影响（registry.ts：inject 就是 plugin({ inject, apply })）。
 * 替身按契约照做：给了 `webServer` 就跑回调，没给就只记下依赖、不跑。
 *
 * 为什么这两条要分开测：M3-T19 实测的那次失败**没有报错**，只是路由没注册 ——
 * 「静默跳过」正是缺陷的直接形态，所以要同时钉住「给了就注册」与「没给不抛也不注册」。
 */
function fakeCtx({ webServer } = {}) {
  const registered = []
  const routes = []
  const injected = []
  const ctx = {
    registered,
    routes,
    injected,
    get: (k) => {
      if (k === 'tools') return { register: (t) => registered.push(t) }
      if (k === 'webServer') return webServer
      return undefined
    },
    effect: (fn) => fn(),
    inject: (deps, callback) => {
      injected.push(deps)
      if (webServer === undefined) return
      callback(Object.assign({}, ctx, { webServer }))
    },
  }
  return ctx
}

/**
 * 用例配置。**每个用例一个临时库目录**，由 describe 内的 beforeEach 填。
 *
 * 为什么不能留空：`dataDir` 为空串时 `resolveDataDir` 会回落到用户的**真实库**
 * （`~/.dsh/lattice`）。任何会打开库的用例（ping、体检路由、工具 execute）都会读写它 ——
 * 宿主进程正持有时还会以 SQLITE_CANTOPEN 直接失败（2026-10-19 实际发生过，整套门禁挂在
 * 一件与被测行为无关的事情上）。用例只该碰自己建的库。
 */
let baseConfig = null
/** 本 describe 建过的临时目录，afterEach 统一清掉。 */
const tempDirs = []

describe('插件契约', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-plugin-'))
    tempDirs.push(dir)
    baseConfig = {
      enabled: true,
      dataDir: dir,
      encoderEnabled: true,
      encoderModel: 'Xenova/bge-small-zh-v1.5',
      tauJoin: 0.75,
      tauLex: 0.05,
      tauNew: 0.38,
      viewBudget: 6000,
      topN: 24,
    }
  })

  afterEach(() => {
    // 全局单例先复位，否则下一个用例拿到的还是这个目录的运行时。
    closeRuntime()
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('导出宿主所需的四个入口', () => {
    assert.equal(name, 'lattice')
    assert.ok(inject.includes('tools'))
    // schemastery 把字段表放在 `dict`（早期版本里叫 shape），两种都认。
    const fields = Config.dict ?? Config.shape
    assert.ok(Object.keys(fields).includes('enabled'))
    assert.equal(typeof apply, 'function')
  })

  /**
   * 模型侧的工具表是**闭集**，改它要先有裁决。
   *
   * 2026-10-18：按裁决 #30 新增第 6 个工具 `lattice_feedback`（样本反馈），
   * 本条断言因此从「四个业务工具 + ping」改为「五个业务工具 + ping = 6」。
   * 改这条的理由只该是「裁决表里多了一条」，不该是「代码里顺手多加了一个」。
   */
  it('激活时注册五个业务工具与一个健康检查（共六个，含 feedback）', () => {
    const ctx = fakeCtx()
    apply(ctx, baseConfig)
    const names = ctx.registered.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'lattice_expand',
      'lattice_feedback',
      'lattice_list',
      'lattice_ping',
      'lattice_recall',
      'lattice_write',
    ])
    assert.equal(names.length, 6)
    // T35 判据 8：audit 是内部模块 + 只读路由，绝不进模型侧（裁决 #26）。
    assert.ok(!names.includes('lattice_audit'), '体检不得注册成工具')
    for (const t of ctx.registered) assert.equal(typeof t.output.render, 'function')
  })

  it('健康检查返回版本与配置摘要', async () => {
    const ctx = fakeCtx()
    apply(ctx, baseConfig)
    // 按名字取 ping，不依赖注册顺序 —— 顺序是实现细节，不该被测试绑住。
    const ping = ctx.registered.find((t) => t.name === 'lattice_ping')
    const out = JSON.parse(await ping.execute({}, {}))
    assert.equal(out.ok, true)
    assert.equal(out.plugin, 'lattice')
    assert.equal(out.thresholds.tauJoin, baseConfig.tauJoin)
  })

  it('enabled=false 时不注册任何工具', () => {
    const ctx = fakeCtx()
    apply(ctx, { ...baseConfig, enabled: false })
    assert.equal(ctx.registered.length, 0)
  })

  it('宿主未提供 tools 服务时安全退出', () => {
    assert.doesNotThrow(() => apply({ get: () => undefined }, baseConfig))
  })

  it('宿主提供 webServer 时把十四条路由挂上去（六条只读 + 八条写）', () => {
    const routes = []
    const webServer = {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
    const ctx = fakeCtx({ webServer })
    apply(ctx, baseConfig)

    // 硬约束：这条路由只能是**条件**注入，不能进模块级 inject —— 进去就等于
    // 「没有 Web 载体的 profile 里整个插件都不激活」，连四个工具一起没。
    assert.deepEqual([...inject], ['tools'], '模块级 inject 不得包含 webServer')
    assert.deepEqual(ctx.injected, [['webServer']], '只对 webServer 做条件注入')

    // M3-T19 加了目录与搜索（共三条只读），M3-T20 加了删除（写端点），
    // M4-T44 加了日志导出（只读）与日志清空（写端点），
    // M4-T35 加了体检（只读；裁决 #26 明确它只出现在路由，不出现在工具表），
    // M4-T26 加了归档与恢复（两条写端点；模型侧不新增工具）。
    // M4-T29 加了拆分候选的确认与忽略（两条写端点；模型侧仍不新增工具）。
    // 条目详情也是一条只读路由（点开才取全文）。
    // 整理入口是两条写路由（规划 / 取消；状态并入体检，不单开只读路由）。
    // 断言路径**集合**而不是顺序：注册顺序是实现细节，不该被测试绑住。
    assert.equal(routes.length, 14, '六条只读路由 + 八条写路由都应挂上')
    assert.deepEqual(routes.map((r) => r.path).sort(), [
      '/api/lattice-archive',
      '/api/lattice-atom',
      '/api/lattice-atoms',
      '/api/lattice-audit',
      '/api/lattice-forget',
      '/api/lattice-log-clear',
      '/api/lattice-log-export',
      '/api/lattice-ping-mini',
      '/api/lattice-recluster-cancel',
      '/api/lattice-recluster-plan',
      '/api/lattice-search',
      '/api/lattice-split-confirm',
      '/api/lattice-split-ignore',
      '/api/lattice-unarchive',
    ])
    for (const route of routes) {
      assert.equal(route.kind, 'exact')
      assert.equal(typeof route.handler, 'function')
    }
  })

  /**
   * 写端点的三道栅栏。替身 req/res，按 node:http 的形状给最小字段。
   *
   * 只断言**本插件的行为**（AGENTS.md 第七节）：这里不验宿主会不会做某事，
   * 只验这条 handler 在给定输入下拒了什么、放行了什么。
   */
  function forgetHandler() {
    const routes = []
    const webServer = {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
    apply(fakeCtx({ webServer }), baseConfig)
    return routes.find((r) => r.path === '/api/lattice-forget').handler
  }

  /**
   * 最小 res 替身：记状态码与 body。
   *
   * **必须是真 EventEmitter**：node:http 的 ServerResponse.end() 会走写路径并挂 `finish`，
   * 普通对象上少一个 `on`，异常就会被 handler 的 catch 吞成 500 —— 断言因此拿到 500，
   * 于是看起来像「栅栏没生效」，其实是替身没造全。
   */
  function fakeRes() {
    const res = new EventEmitter()
    res.out = { status: 0, body: null }
    res.writeHead = (status) => {
      res.out.status = status
      return res
    }
    res.end = (text) => {
      if (typeof text === 'string') {
        try {
          res.out.body = JSON.parse(text)
        } catch {
          res.out.body = text
        }
      }
      return res
    }
    return res
  }

  /**
   * 最小 req 替身：**必须是真 EventEmitter**。
   *
   * 一开始写成「调用 on('data') 时立刻回调」的普通对象，结果 handler 挂监听之前 body 就发完了，
   * `readJsonBody` 的 Promise 永远不结算，express 层超时成了 500 —— 栅栏断言因此拿到 500 而不是
   * 415。替身不按被替代物的时序来，测出来的就不是真实行为。
   */
  function fakeReq({
    remote = '127.0.0.1',
    method = 'POST',
    type = 'application/json',
    body = '{"atom_id":1}',
  } = {}) {
    const req = new EventEmitter()
    req.socket = { remoteAddress: remote }
    req.method = method
    req.headers = type === null ? {} : { 'content-type': type }
    req.url = '/api/lattice-forget'
    req.destroy = () => {}
    // 无论什么方法都发完 body：真实请求的流一定会结束，替身不发的话，handler 里
    // `await readJsonBody` 的 Promise 永不结算 —— 那不是被测代码的行为，是替身的缺陷。
    setImmediate(() => {
      req.emit('data', Buffer.from(body, 'utf8'))
      req.emit('end')
    })
    return req
  }

  it('写端点第一道栅栏：非回环来源 403，且不问它用什么方法', async () => {
    const handler = forgetHandler()
    const res = fakeRes()
    await handler(fakeReq({ remote: '10.0.0.7' }), res)
    assert.equal(res.out.status, 403)
    assert.equal(res.out.body.error, 'forbidden')
  })

  it('写端点第二道栅栏：非 POST 405（GET 也拒，与只读端点方向相反）', async () => {
    const handler = forgetHandler()
    const res = fakeRes()
    await handler(fakeReq({ method: 'GET' }), res)
    assert.equal(res.out.status, 405)
    assert.equal(res.out.body.error, 'method')
  })

  it('写端点第三道栅栏：content-type 不是 application/json 时 415', async () => {
    const handler = forgetHandler()
    // 这正是跨站表单能发出的那一种 —— 挡的就是它。
    const res = fakeRes()
    await handler(fakeReq({ type: 'application/x-www-form-urlencoded' }), res)
    assert.equal(res.out.status, 415)
    assert.equal(res.out.body.error, 'content-type')

    // 缺头同样拒：默认值不算通过。
    const res2 = fakeRes()
    await handler(fakeReq({ type: null }), res2)
    assert.equal(res2.out.status, 415)
  })

  it('改写体不是合法 JSON 时 400，而不是当成空删除', async () => {
    const handler = forgetHandler()
    const res = fakeRes()
    await handler(fakeReq({ body: 'not json' }), res)
    assert.equal(res.out.status, 400)
    assert.equal(res.out.body.error, 'bad-body')
  })

  /**
   * 归档 / 恢复两条写端点（T26 判据 5、6）：栅栏与删除同形；重复调用是幂等而不是报错。
   *
   * 四条栅栏各拒一次，而不是只挑一条：四条挡的是四种不同的越权形态
   * （外站 / 方法 / 跨站简单请求的类型 / 超大请求体），漏一条就是漏一种。
   */
  it('归档路由：四条栅栏各拒一次（非回环 / 非 POST / 非 json / 超长体）', async () => {
    const routes = []
    const webServer = {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
    apply(fakeCtx({ webServer }), baseConfig)
    const archive = routes.find((r) => r.path === '/api/lattice-archive').handler
    const unarchive = routes.find((r) => r.path === '/api/lattice-unarchive').handler

    for (const handler of [archive, unarchive]) {
      let res = fakeRes()
      await handler(fakeReq({ remote: '10.0.0.7' }), res)
      assert.equal(res.out.status, 403, '非回环必须拒')

      res = fakeRes()
      await handler(fakeReq({ method: 'GET' }), res)
      assert.equal(res.out.status, 405, '只认 POST')

      res = fakeRes()
      await handler(fakeReq({ type: 'text/plain' }), res)
      assert.equal(res.out.status, 415, '只认 application/json')

      // 上限 4096 字节；超限要 400，不能被静默截断后当成合法请求。
      res = fakeRes()
      await handler(fakeReq({ body: '{"atom_id":' + '1'.repeat(5000) + '}' }), res)
      assert.equal(res.out.status, 400, '超长体必须拒')
      assert.equal(res.out.body.error, 'bad-body')
    }
  })

  it('归档路由：置位 / 清位 / 重复调用幂等，且不动正文与向量', async () => {
    const dir = baseConfig.dataDir
    const seedDb = openVault(join(dir, 'lattice.db')).db
    const now = Date.now()
    const id = Number(
      seedDb
        .prepare(
          'INSERT INTO atom (kind, text, summary, embedding, created_at, updated_at, flags)' +
            ' VALUES (?, ?, ?, ?, ?, ?, 0)',
        )
        .run(
          '知识',
          '归档路由用例：这条记忆的正文不该被改。',
          '归档路由用例',
          new Uint8Array(512 * 4),
          now,
          now,
        ).lastInsertRowid,
    )
    const vecBefore = seedDb.prepare('SELECT hex(embedding) AS h FROM atom WHERE id = ?').get(id).h
    seedDb.close()

    const routes = []
    const webServer = {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
    apply(fakeCtx({ webServer }), baseConfig)
    const archive = routes.find((r) => r.path === '/api/lattice-archive').handler
    const unarchive = routes.find((r) => r.path === '/api/lattice-unarchive').handler

    let res = fakeRes()
    await archive(fakeReq({ body: JSON.stringify({ atom_id: id }) }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.archived, true)
    assert.equal(res.out.body.changed, true)
    assert.equal(Number(res.out.body.flags) & 16, 16)

    // 第二次归档：不报错、不再写库，只把 changed 说成 false（界面据此说「之前就是」）。
    res = fakeRes()
    await archive(fakeReq({ body: JSON.stringify({ id }) }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.changed, false)
    assert.equal(Number(res.out.body.flags), 16)

    res = fakeRes()
    await unarchive(fakeReq({ body: JSON.stringify({ atom_id: id }) }), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.archived, false)
    assert.equal(Number(res.out.body.flags), 0)

    res = fakeRes()
    await unarchive(fakeReq({ body: JSON.stringify({ atom_id: id }) }), res)
    assert.equal(res.out.body.changed, false)
    assert.equal(Number(res.out.body.flags), 0)

    // 不存在的 id 报 404，而不是 200 —— 界面要能区分「改了」与「本来就不在」。
    res = fakeRes()
    await archive(fakeReq({ body: JSON.stringify({ atom_id: 999999 }) }), res)
    assert.equal(res.out.status, 404)

    const checkDb = openVault(join(dir, 'lattice.db')).db
    const row = checkDb.prepare('SELECT text, hex(embedding) AS h, flags FROM atom WHERE id = ?').get(id)
    checkDb.close()
    assert.equal(row.text, '归档路由用例：这条记忆的正文不该被改。', '归档不改正文')
    assert.equal(row.h, vecBefore, '归档不改向量')
    assert.equal(Number(row.flags), 0, '恢复之后位应当回到 0')
  })
  it('目录路由的 includeArchived：默认不列，显式传 1 时列出（T26 判据 4 的界面一侧）', () => {
    const seedDb = openVault(join(baseConfig.dataDir, 'lattice.db')).db
    const now = Date.now()
    seedDb
      .prepare(
        'INSERT INTO atom (kind, text, summary, embedding, created_at, updated_at, flags)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('知识', '归档条目不该出现在默认目录里。', '归档条目', new Uint8Array(512 * 4), now, now, 16)
    seedDb.close()

    const routes = []
    const webServer = {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
    apply(fakeCtx({ webServer }), baseConfig)
    const handler = routes.find((r) => r.path === '/api/lattice-atoms').handler

    let req = fakeReq({ method: 'GET' })
    req.url = '/api/lattice-atoms'
    let res = fakeRes()
    handler(req, res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.total, 0, '默认结果不含归档条目')

    req = fakeReq({ method: 'GET' })
    req.url = '/api/lattice-atoms?includeArchived=1'
    res = fakeRes()
    handler(req, res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.body.total, 1, '勾选「显示已归档」时要列出来')
  })
  /**
   * 体检端点（M4-T35）：栅栏与最近一条只读路由同形；没有库时**报无数据**，
   * 而不是 500、也不是「全部正常」。这条路由不走 getRuntime，所以不会顺手建库。
   */
  it('体检端点：非回环 403、非 GET 405、没有库时报无数据', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-audit-route-'))
    try {
      const routes = []
      const webServer = {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      }
      apply(fakeCtx({ webServer }), { ...baseConfig, dataDir: dir })
      const handler = routes.find((r) => r.path === '/api/lattice-audit').handler
      assert.equal(typeof handler, 'function')

      const denied = fakeRes()
      handler(fakeReq({ remote: '10.0.0.7', method: 'GET' }), denied)
      assert.equal(denied.out.status, 403)
      assert.equal(denied.out.body.error, 'forbidden')

      const wrongMethod = fakeRes()
      handler(fakeReq({ method: 'POST' }), wrongMethod)
      assert.equal(wrongMethod.out.status, 405)
      assert.equal(wrongMethod.out.body.error, 'method')

      const empty = fakeRes()
      handler(fakeReq({ method: 'GET' }), empty)
      assert.equal(empty.out.status, 200)
      assert.equal(empty.out.body.ok, true)
      assert.equal(empty.out.body.dataState, 'empty')
      assert.equal(empty.out.body.duplicates.state, 'no-data')
      assert.equal(empty.out.body.graph.state, 'no-data')
      assert.equal(empty.out.body.topics.singleMemberRatio, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('体检端点：有库时返回结构指标（只读打开，不建库）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lattice-audit-route-data-'))
    try {
      const file = join(dir, 'lattice.db')
      const { db } = openVault(file)
      db.prepare(
        'INSERT INTO topic(id, label, sum_vec, n_atoms, mean_fit, created_at, rebuilt_at) ' +
          'VALUES (1, ?, zeroblob(2048), 1, 0, 1, 1)',
      ).run('主题')
      db.prepare(
        'INSERT INTO atom(id, kind, text, summary, embedding, topic_id, fit, scope, origin, created_at, updated_at) ' +
          "VALUES (1, '结论', '正文', '摘要', zeroblob(2048), 1, 1.0, 'global', 'model', 1, 1)",
      ).run()
      db.close()

      const routes = []
      const webServer = {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      }
      apply(fakeCtx({ webServer }), { ...baseConfig, dataDir: dir })
      const handler = routes.find((r) => r.path === '/api/lattice-audit').handler
      const res = fakeRes()
      handler(fakeReq({ method: 'GET' }), res)
      assert.equal(res.out.status, 200)
      assert.equal(res.out.body.ok, true)
      assert.equal(res.out.body.dataState, 'ready')
      assert.equal(res.out.body.topics.atoms, 1)
      assert.equal(res.out.body.topics.singleMemberRatio, 1)
      assert.equal(res.out.body.duplicates.state, 'no-data')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('宿主没有 webServer 时不注册路由、不抛，六个工具照常在', () => {
    const ctx = fakeCtx()
    assert.doesNotThrow(() => apply(ctx, baseConfig))
    assert.deepEqual(ctx.injected, [['webServer']], '依赖照样声明，只是不会执行')
    assert.equal(ctx.routes.length, 0, '没有服务就不该有路由')
    // 与上一条合起来钉死「静默跳过」：不报错，但也不能什么都不做。
    assert.deepEqual(ctx.registered.map((t) => t.name).sort(), [
      'lattice_expand',
      'lattice_feedback',
      'lattice_list',
      'lattice_ping',
      'lattice_recall',
      'lattice_write',
    ])
  })
})

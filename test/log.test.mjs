// 降级日志模块（判据 9/10/11）：独立库、白名单、缓冲、轮换清理、导出、清空。
//
// 这一组用例的共同前提：**日志库与记忆库是两个文件**。
// 因此每个用例都把两者放在同一个临时 dataDir 下，再分别打开来断言 ——
// 「日志写没写进去」与「主库动没动」必须能分别观察，否则判据 9/11 里的
// 「主库 data_version 不变」根本无法构造。

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../dist/index.js'
import { openVault } from '../dist/db/open.js'
import { recall } from '../dist/pipeline/search.js'
import {
  CSV_HEADER,
  CSV_TRUNCATED,
  clearLog,
  closeLog,
  configureLog,
  exportLogCsv,
  flushLog,
  log,
  logDroppedCount,
  logEvent,
  logFilePath,
  logFiles,
  logWriteFailureCount,
  pendingLogRows,
} from '../dist/log/index.js'
import { LogClearError } from '../dist/log/store.js'
import { EVENT_DETAIL_KEYS, reasonCodeOf, sanitizeEvent } from '../dist/log/policy.js'
import { closeRuntime, getRuntime, noteRecallDegradations, runtimeEncode } from '../dist/state.js'

const ROTATED = /^lattice-log-(\d+)\.db$/

let dir = ''
/** 测试里显式打开的连接（Windows 上没关的连接会让临时目录删不掉）。 */
let extraDbs = []

describe('降级日志', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-log-' + process.pid + '-'))
    configureLog(dir)
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
    closeLog()
    rmSync(dir, { recursive: true, force: true })
  })

  /** 插件运行时配置的最小形状（与 index.ts 的默认值一致）。 */
  function runtimeCfg(dataDir) {
    return {
      dataDir,
      encoderEnabled: true,
      encoderModel: 'Xenova/bge-small-zh-v1.5',
      encoderMirror: '',
      encoderCacheDir: '',
      thresholds: { tauJoin: 0.78, tauLex: 0.05, tauLexOnly: 0.1, tauNew: 0.5 },
      topN: 24,
      resources: {},
    }
  }

  function openReadOnly(file) {
    const db = new DatabaseSync(file, { readOnly: true })
    extraDbs.push(db)
    return db
  }

  /** 读当前日志库的全部行。**读完即关**：Windows 上打开着的文件会让清空删不掉。 */
  function rowsOf(dataDir) {
    const file = logFilePath(dataDir)
    if (!existsSync(file)) return []
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return db.prepare('SELECT id, ts, level, event, detail FROM log ORDER BY id').all()
    } finally {
      db.close()
    }
  }

  function countOf(dataDir) {
    return rowsOf(dataDir).length
  }

  /** 全部日志文件（含轮换历史）里的总行数 —— 导出用例的对照值。 */
  function countAllFiles(dataDir) {
    let total = 0
    for (const file of logFiles(dataDir)) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        total += Number(db.prepare('SELECT COUNT(*) AS n FROM log').get().n)
      } finally {
        db.close()
      }
    }
    return total
  }

  /** 主库的表名集合（判据 9：主库不得出现日志表）。 */
  function mainTableNames(dataDir) {
    const rt = getRuntime(runtimeCfg(dataDir))
    return rt.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r.name))
  }

  /** 造几个历史文件（阈值调小，避免真写 4 MB）。 */
  function rotateSome(rounds = 30) {
    configureLog(dir, { fileMaxBytes: 300, keepFiles: 5, totalMaxBytes: 100000 })
    for (let i = 0; i < rounds; i++) {
      log.warn('recall.short_term_miss')
      flushLog()
    }
  }

  describe('降级日志：白名单与独立库（判据 9）', () => {
    it('编码器降级 → 独立日志库出现 encoder.unavailable，detail 只有白名单字段', async () => {
      const cfg = runtimeCfg(dir)
      getRuntime(cfg)
      // 测试替身让编码器必定加载失败（test/stubs/transformers.mjs）。
      const vec = await runtimeEncode(cfg, '一段不会出现在日志里的查询')
      assert.equal(vec, null, '替身下编码器不可用')
      flushLog()

      const rows = rowsOf(dir)
      const row = rows.find((r) => r.event === 'encoder.unavailable')
      assert.ok(row !== undefined, '日志库应出现 encoder.unavailable')
      assert.equal(row.level, 'warn')
      assert.equal(row.ts > 0, true)
      assert.deepEqual(Object.keys(JSON.parse(row.detail)), ['reason'], 'detail 只允许 reason')
      assert.equal(typeof JSON.parse(row.detail).reason, 'string')
      // 查询文本不得出现在日志库的任何一行里（整表扫描，不只这一行）。
      assert.equal(JSON.stringify(rows).includes('一段不会出现在日志里的查询'), false)
    })

    it('日志库与主库是两个文件：主库里没有日志表', async () => {
      const cfg = runtimeCfg(dir)
      getRuntime(cfg)
      await runtimeEncode(cfg, 'x')
      flushLog()
      assert.ok(existsSync(logFilePath(dir)), '日志库文件存在')
      assert.equal(existsSync(join(dir, 'lattice.db')), true, '主库文件存在')
      assert.equal(mainTableNames(dir).includes('log'), false, '主库不得出现 log 表')
    })

    it('未知事件整条丢弃，白名单外的字段不落库', () => {
      // 构造失败：试图把查询文本当事件名 / 当字段塞进去。
      log.warn('recall.query', { query: '秘密查询文本' })
      log.warn('encoder.unavailable', { reason: 'Error', query: '秘密查询文本', atom_id: 42 })
      log.warn('recall.vector_missing', { atom_id: 42 })
      flushLog()

      const rows = rowsOf(dir)
      assert.equal(rows.length, 2, '未知事件被丢弃；两条合法事件保留')
      for (const row of rows) {
        const detail = row.detail === null ? null : JSON.parse(row.detail)
        if (detail !== null) {
          assert.equal('query' in detail, false, '白名单外字段不得出现')
          assert.equal('atom_id' in detail, false, 'atom id 不得出现')
        }
      }
      assert.equal(JSON.stringify(rows).includes('秘密查询文本'), false)
    })

    it('字符串值只收短 token：路径 / 自由文本被替换成 other', () => {
      log.warn('graph.unavailable', { reason: 'D:/secret/path/模型.bin' })
      log.warn('encoder.unavailable', { reason: 'model_changed' })
      flushLog()
      const rows = rowsOf(dir)
      assert.equal(JSON.parse(rows[0].detail).reason, 'other', '非 token 的 reason 被替换')
      assert.equal(JSON.parse(rows[1].detail).reason, 'model_changed', '合法枚举原样保留')
    })

    /**
     * 白名单是**闭集**：多一个事件就是多一条「什么东西可能落进磁盘」的路径。
     *
     * 2026-10-18 增 `samples.unavailable`（样本库）：它与 `log.write_failed` 同形 ——
     * 旁路写不进时只记原因码。2026-10-22 删：样本库随反馈链退役，这个事件没有发送方了；
     * 白名单只留还有写入方的事件，留着它等于给一个不存在的旁路留落盘通道。
     * 改这里的每一条都要能说出「为什么它必须落盘」，
     * 否则下次就该删掉它而不是给测试打补丁。
     *
     * 2026-10-19 增 `split.ignored`（待拆分）：用户忽略候选**没有别的留痕处** ——
     * 它不写库、不建待办、不留状态，只清一位。不留这条日志，这个动作就等于从未发生。
     * 它不带任何字段（连 atom id 都不带），所以落盘的只有「发生过一次」。
     *
     * 2026-10-20 增 `split.confirmed` 与 `split.evicted`（后补）：确认原本只记 meta 状态，
     * 而那份状态是 FIFO 的 —— 被挤出清单的一条在状态里不留痕迹。「它被确认过」只剩日志
     * 能回答，这也是裁决里「留痕（日志）」的所指。淘汰只记条数，同样不带 id。
     *
     * 2026-10-20 增 `entry.cleared`（清空学到的入口）：清空删的是数据，
     * 而它没有别的留痕处 —— 零条也写一条，否则「清空了 0 条」与「没执行」分不开。
     */
    it('事件白名单覆盖草案里的事件（含三条 split.* 与 entry.cleared）', () => {
      assert.deepEqual(Object.keys(EVENT_DETAIL_KEYS).sort(), [
        'encoder.unavailable',
        'entry.cleared',
        'graph.unavailable',
        'log.write_failed',
        'recall.lexical_degraded',
        'recall.short_term_miss',
        'recall.vector_missing',
        'split.confirmed',
        'split.evicted',
        'split.ignored',
      ])
      // 等级也白名单化：三档之外的一律拒收（notice / debug 不接受）。
      assert.equal(sanitizeEvent('notice', 'encoder.unavailable', { reason: 'Error' }), null)
      assert.equal(sanitizeEvent('debug', 'encoder.unavailable', { reason: 'Error' }), null)
      // 三档本身都接受，等级原样落库。
      for (const level of ['info', 'warn', 'error']) {
        assert.equal(sanitizeEvent(level, 'encoder.unavailable', { reason: 'Error' })?.level, level)
      }
      assert.equal(reasonCodeOf(new TypeError('x')), 'TypeError')
      assert.equal(reasonCodeOf({ code: 'ENOENT' }), 'ENOENT')
    })

    it('按等级入口：log.info / log.warn / log.error 落库的等级各自正确，且不绕过白名单', () => {
      configureLog(dir)
      log.info('split.evicted', { evicted: 1 })
      log.warn('recall.vector_missing')
      log.error('log.write_failed', { reason: 'ENOENT' })
      // 包装层不做判断：不在白名单里的事件照样被丢，不会因为「换了新入口」就绕过校验。
      log.info('recall.query', { query: '不该出现的查询' })
      flushLog()
      const rows = rowsOf(dir)
      assert.deepEqual(
        rows.map((r) => r.level),
        ['info', 'warn', 'error'],
      )
      assert.deepEqual(
        rows.map((r) => r.event),
        ['split.evicted', 'recall.vector_missing', 'log.write_failed'],
      )

      // 底层 logEvent 仍在：按变量传等级时要靠它，走同一套过滤。
      logEvent('warn', 'recall.short_term_miss')
      flushLog()
      assert.equal(rowsOf(dir).length, 4)
    })

    it('缓冲：1000 条只入队、不触发同步 IO；队列有界并丢最旧', () => {
      const t0 = performance.now()
      for (let i = 0; i < 1000; i++) log.warn('recall.short_term_miss')
      const elapsed = performance.now() - t0
      assert.ok(elapsed < 50, '1000 次入队耗时 ' + elapsed.toFixed(1) + 'ms，应远小于 50ms')
      // flush 之前连库文件都不该存在 —— 入队路径上没有任何同步 IO。
      assert.equal(existsSync(logFilePath(dir)), false, 'flush 之前不应建库')
      assert.equal(pendingLogRows(), 200, '队列上限 200')
      assert.equal(logDroppedCount(), 800, '满了丢最旧并计数')
      flushLog()
      assert.equal(countOf(dir), 200)
    })

    it('1000 条入队后召回耗时与基线同量级', () => {
      const rt = getRuntime(runtimeCfg(dir))
      // 预热一次（首次召回会建图边），再计时。
      recall(rt.db, '缓存 索引', null, { topN: 24 })
      const time = (rounds) => {
        const t0 = performance.now()
        for (let i = 0; i < rounds; i++) recall(rt.db, '缓存 索引', null, { topN: 24 })
        return (performance.now() - t0) / rounds
      }
      const baseline = time(20)
      for (let i = 0; i < 1000; i++) log.warn('recall.short_term_miss')
      const withQueue = time(20)
      // 倍数是宽口径：这里要否掉的是「入队走了同步 IO」这种数量级差异，不是几微秒。
      assert.ok(
        withQueue < baseline * 5 + 2,
        '有队列时 ' + withQueue.toFixed(3) + 'ms/次，基线 ' + baseline.toFixed(3) + 'ms/次',
      )
    })

    it('轮换与清理：超阈值出现历史文件，文件数不超过上限', () => {
      rotateSome(40)
      const files = logFiles(dir)
      const rotated = readdirSync(join(dir, 'logs')).filter((n) => ROTATED.test(n))
      assert.ok(rotated.length >= 1, '应出现历史文件')
      assert.ok(files.length <= 5, '文件数（含当前库）不超过上限：' + files.length)
      // 清理后仍能继续写。
      log.warn('recall.short_term_miss')
      flushLog()
      assert.ok(countOf(dir) >= 1)
    })

    it('目录不可写：召回照常、不抛错，log.write_failed 限频一条', async () => {
      // 用「同名文件占住 logs 目录」构造不可写：mkdir 会失败，且与 Windows 权限无关。
      writeFileSync(join(dir, 'logs'), 'not a directory')
      const rt = getRuntime(runtimeCfg(dir))
      // 召回照常：降级埋点 + 召回本身都不该抛。
      assert.doesNotThrow(() => {
        noteRecallDegradations({ vectorMissing: true, lexicalDegraded: false, shortTermMiss: false })
        recall(rt.db, '缓存', null, { topN: 24 })
      })
      // 工具侧的真实召回路径也照常：编码器不可用 + 日志目录不可写，仍须返回文本。
      const recallTool = toolSet().find((t) => t.name === 'lattice_recall')
      const text = await recallTool.execute({ query: '缓存' })
      assert.equal(typeof text, 'string')
      assert.ok(text.length > 0)
      for (let i = 0; i < 5; i++) {
        log.warn('recall.short_term_miss')
        flushLog()
      }
      assert.ok(logWriteFailureCount() >= 5, '每次 flush 都失败并计数')
      // 恢复目录：队列里的行（含一条限频后的 log.write_failed）应当落进新库。
      rmSync(join(dir, 'logs'))
      configureLog(dir)
      flushLog()
      const rows = rowsOf(dir)
      assert.equal(rows.filter((r) => r.event === 'log.write_failed').length, 1, '写失败事件限频 1 条')
      assert.equal(
        JSON.parse(rows.find((r) => r.event === 'log.write_failed').detail).reason.length > 0,
        true,
      )
    })
  })

  describe('降级日志：导出（判据 10）', () => {
    it('CSV 四列表头；行数与导出范围内 COUNT(*) 一致；导出不写库', () => {
      log.warn('encoder.unavailable', { reason: 'Error' })
      log.error('log.write_failed', { reason: 'ENOENT' })
      flushLog()
      const file = logFilePath(dir)
      const db = openReadOnly(file)
      const before = Number(db.prepare('PRAGMA data_version').get().data_version)
      const out = exportLogCsv(dir)
      const after = Number(db.prepare('PRAGMA data_version').get().data_version)

      assert.equal(out.csv.split('\n')[0], CSV_HEADER)
      assert.equal(out.csv.split('\n')[0].split(',').length, 4, '表头四列')
      assert.equal(out.rows, 2)
      assert.equal(out.truncated, false)
      assert.equal(out.rows, countOf(dir), '行数与 COUNT(*) 一致')
      assert.equal(after, before, '导出前后日志库 data_version 不变（导出不写）')
      // detail 是原样保留的白名单 JSON。
      assert.ok(out.csv.includes('{""reason"":""Error""}'), 'detail 内的 JSON 应以 CSV 转义原样保留')
    })

    it('导出前后主库 data_version 不变', () => {
      const main = openVault(join(dir, 'lattice.db')).db
      extraDbs.push(main)
      const before = Number(main.prepare('PRAGMA data_version').get().data_version)
      log.warn('recall.vector_missing')
      flushLog()
      exportLogCsv(dir)
      const after = Number(main.prepare('PRAGMA data_version').get().data_version)
      assert.equal(after, before, '导出只读，不得让主库的 data_version 变化')
    })

    it('空日志导出空表头而不报错', () => {
      const out = exportLogCsv(dir)
      assert.equal(out.csv, CSV_HEADER + '\n')
      assert.equal(out.rows, 0)
      assert.equal(out.truncated, false)
    })

    it('构造失败：导出文件不含查询文本 / atom id / 路径', () => {
      // 三条都是「调用点写错」的最可能形态：把查询文本、路径或 atom id 塞进 detail。
      // 它们必须在导出之前就被丢弃。
      log.warn('recall.query', { query: '不能出现的查询' })
      log.warn('encoder.unavailable', {
        reason: 'D:/secret/模型.bin',
        detail: '原子 987654321',
      })
      log.warn('recall.short_term_miss', { atom_id: 987654321 })
      flushLog()
      const out = exportLogCsv(dir)
      for (const bad of ['不能出现的查询', 'D:/secret', '987654321']) {
        assert.equal(out.csv.includes(bad), false, '导出里不得出现 ' + bad)
      }
    })

    it('超过上限截断并标记 # truncated', () => {
      for (let i = 0; i < 5; i++) log.warn('recall.short_term_miss')
      flushLog()
      const byRows = exportLogCsv(dir, { maxRows: 2 })
      assert.equal(byRows.rows, 2)
      assert.equal(byRows.truncated, true)
      assert.ok(byRows.csv.endsWith(CSV_TRUNCATED + '\n'))
      // 字节上限同样生效（表头之外的第一个数据行就放不下）。
      const byBytes = exportLogCsv(dir, { maxBytes: Buffer.byteLength(CSV_HEADER + '\n') + 1 })
      assert.equal(byBytes.rows, 0)
      assert.equal(byBytes.truncated, true)
    })

    it('路由：导出的响应是 CSV 附件，四列表头', async () => {
      log.warn('encoder.unavailable', { reason: 'Error' })
      flushLog()
      const handler = routeSet().find((r) => r.path === '/api/lattice-log-export').handler
      const res = fakeRes()
      await handler(fakeReq('', 'GET'), res)
      assert.equal(res.out.status, 200)
      assert.match(String(res.out.headers['content-type']), /^text\/csv/)
      assert.match(
        String(res.out.headers['content-disposition']),
        /^attachment; filename="lattice-log-\d{8}\.csv"$/,
      )
      assert.equal(String(res.out.body).split('\n')[0], CSV_HEADER)
    })

    it('全量导出合并轮换后的历史文件，按时间升序', () => {
      rotateSome(20)
      const files = logFiles(dir)
      assert.ok(files.length > 1, '应有历史文件参与导出')
      const out = exportLogCsv(dir)
      assert.equal(out.rows, countAllFiles(dir), '导出范围 = 全部保留文件')
      assert.ok(out.files > 1)
      const dataLines = out.csv.trimEnd().split('\n').slice(1)
      const stamps = dataLines.map((line) => Number(line.split(',')[0]))
      assert.deepEqual(
        stamps,
        [...stamps].sort((a, b) => a - b),
        '应按时间升序',
      )
    })
  })

  describe('降级日志：清空（判据 11）', () => {
    it('清空后行数 0、历史文件不存在、主库 data_version 不变、不残留「已清空」行', () => {
      const main = openVault(join(dir, 'lattice.db')).db
      extraDbs.push(main)
      const before = Number(main.prepare('PRAGMA data_version').get().data_version)

      rotateSome(20)
      assert.ok(logFiles(dir).length > 1, '清空前有历史文件')
      const result = clearLog(dir)
      assert.ok(result.removed >= 2, '删除的文件数包含历史文件')
      assert.deepEqual(logFiles(dir), [], '日志文件（含历史）都不存在')
      const after = Number(main.prepare('PRAGMA data_version').get().data_version)
      assert.equal(after, before, '清空只动日志库，不动主库')
      // 主库还在、还能查 —— 防「清空把主库一起动」。
      assert.ok(existsSync(join(dir, 'lattice.db')))
      assert.equal(Number(main.prepare('SELECT COUNT(*) AS n FROM atom').get().n), 0)

      // 清空后立刻还能写（库会自动重建），且没有「已清空」事件。
      log.warn('recall.short_term_miss')
      flushLog()
      const rows = rowsOf(dir)
      assert.equal(rows.length, 1)
      assert.equal(
        rows.some((r) => r.event === 'log.cleared'),
        false,
        '不得残留「已清空」日志行',
      )
    })

    it('文件被占用 → 抛可读错误，日志库仍可用', () => {
      log.warn('recall.short_term_miss')
      flushLog()
      // 同名前缀的目录删不掉（Windows 上是 EPERM，POSIX 上是 EISDIR）—— 用文件名模式模拟占用。
      mkdirSync(join(dir, 'logs', 'lattice-log-9999999999999.db'))
      assert.throws(
        () => clearLog(dir),
        (err) => err instanceof LogClearError && /被占用/.test(err.message) && /重试/.test(err.message),
      )
      // 失败之后仍然能写、能读：不出现「删了一半，库不可用」。
      log.warn('recall.short_term_miss')
      flushLog()
      assert.equal(countOf(dir), 1)
    })

    it('路由：不带 {confirm:true} 的 POST 被 400 拒绝，带确认才清空', async () => {
      configureLog(dir)
      log.warn('recall.short_term_miss')
      flushLog()

      const routes = routeSet()
      const handler = routes.find((r) => r.path === '/api/lattice-log-clear').handler
      assert.equal(typeof handler, 'function')

      // 缺 confirm / confirm 非 true：400，且日志还在。
      for (const body of ['{}', '{"confirm":false}', '{"confirm":"yes"}']) {
        const res = fakeRes()
        await handler(fakeReq(body), res)
        assert.equal(res.out.status, 400, body + ' 应被拒')
        assert.equal(res.out.body.error, 'confirm-required')
      }
      assert.equal(countOf(dir), 1, '被拒的请求不得清空')

      // 带确认：200，行数 0。
      const res = fakeRes()
      await handler(fakeReq('{"confirm":true}'), res)
      assert.equal(res.out.status, 200, JSON.stringify(res.out.body))
      assert.equal(res.out.body.ok, true)
      assert.equal(logFiles(dir).length, 0)
    })
  })

  describe('降级日志：界面（判据 10/11 的入口）', () => {
    it('界面有导出与清空两个按钮，清空走二次确认', () => {
      const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
      assert.ok(client.includes("'/api/lattice-log-export'"), '导出按钮走只读路由')
      assert.ok(client.includes("'/api/lattice-log-clear'"), '清空按钮走写路由')
      assert.ok(client.includes('导出日志'))
      assert.ok(client.includes('清空日志'))
      assert.ok(client.includes('window.confirm('), '清空必须二次确认')
      assert.ok(client.includes('不可撤销'), '确认框要写明不可撤销')
    })
  })
})

// ───────────────────────── 路由替身（形状与 plugin.test.mjs 一致） ─────────────────────────

/** 用本用例的 dataDir 激活插件，取回它注册的路由（与 plugin.test.mjs 的假 ctx 同形）。 */
function routeSet() {
  const routes = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    gets: { tools: { register: () => {} } },
    webServer: null,
    get(k) {
      // webServer 只经 inject 的回调上下文出现（与 plugin.test.mjs 的替身同一口径）。
      if (k === 'webServer') return this.webServer
      return this.gets[k]
    },
    effect: (fn) => fn(),
    inject(deps, callback) {
      callback(Object.assign({}, this, { webServer }))
    },
  }
  apply(ctx, {
    enabled: true,
    dataDir: dir,
    encoderEnabled: false,
    encoderModel: 'Xenova/bge-small-zh-v1.5',
    tauJoin: 0.75,
    tauLex: 0.05,
    tauNew: 0.38,
    topN: 24,
  })
  return routes
}

/** 用本用例的 dataDir 激活插件，取回注册的工具（不看路由）。 */
function toolSet() {
  const registered = []
  const ctx = {
    get(k) {
      return k === 'tools' ? { register: (tool) => registered.push(tool) } : undefined
    },
    effect: (fn) => fn(),
    inject: () => {},
  }
  apply(ctx, {
    enabled: true,
    dataDir: dir,
    encoderEnabled: true,
    encoderModel: 'Xenova/bge-small-zh-v1.5',
    tauJoin: 0.75,
    tauLex: 0.05,
    tauNew: 0.38,
    topN: 24,
  })
  return registered
}

function fakeRes() {
  const res = new EventEmitter()
  res.out = { status: 0, body: null, headers: {} }
  res.writeHead = (status, headers) => {
    res.out.status = status
    res.out.headers = headers ?? {}
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

function fakeReq(body, method = 'POST') {
  const req = new EventEmitter()
  req.socket = { remoteAddress: '127.0.0.1' }
  req.method = method
  req.headers = { 'content-type': 'application/json' }
  req.url = '/api/lattice-log-clear'
  req.destroy = () => {}
  setImmediate(() => {
    req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

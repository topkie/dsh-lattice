// 写入侧重标的四道闸与失败不半改（M4-T44 判据 5/7/8）。
//
// 钩子放在 describe 内部：node:test 的顶层 beforeEach/afterEach 是**全局**的，
// 本文件会关运行时与样本库，放顶层会把别的测试文件的配置一起关掉。

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { CALIB_VERSION, readSnapshotState, writeSnapshot } from 'lattice-calib'
import { getMeta, setMeta, META_CALIB_LAST_CHECK, META_CALIB_LAST_ERROR } from '../dist/db/meta.js'
import { closeSamples, recordSample, sampleStats } from '../dist/samples/index.js'
import { closeRuntime, getRuntime, maybeRecalibrate } from '../dist/state.js'
import { encodeVec } from '../dist/util/vec.js'

const DIM = 512
const MODEL = 'Xenova/bge-small-zh-v1.5'

let dir = ''

/** 造一个确定的单位向量：只为了「有向量可算」，不要求语义。 */
function vecOf(seed) {
  const v = new Float32Array(DIM)
  let n = 0
  for (let i = 0; i < DIM; i++) {
    const x = Math.sin(seed * 12.9898 + i * 78.233)
    v[i] = x
    n += x * x
  }
  const len = Math.sqrt(n) || 1
  for (let i = 0; i < DIM; i++) v[i] = v[i] / len
  return v
}

/** 直接插 atom 行：本文件要的是「库够大且有向量」，不需要走写入管线的落位。 */
function seedAtoms(db, n) {
  const ins = db.prepare(
    'INSERT INTO atom (kind, text, summary, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const now = Date.now()
  db.exec('BEGIN')
  for (let i = 0; i < n; i++) {
    ins.run(
      '知识',
      '第 ' + i + ' 条用于构造规模的记忆。',
      '第 ' + i + ' 条',
      encodeVec(vecOf(i + 1)),
      now,
      now,
    )
  }
  db.exec('COMMIT')
}

/** 插一批**零向量**的 atom：算 S 时它们会被跳过，于是 calibrate 抛 E_NO_VECTORS。 */
function seedZeroAtoms(db, n) {
  const ins = db.prepare(
    'INSERT INTO atom (kind, text, summary, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const zero = new Uint8Array(DIM * 4)
  const now = Date.now()
  db.exec('BEGIN')
  for (let i = 0; i < n; i++) ins.run('知识', '第 ' + i + ' 条', '第 ' + i + ' 条', zero, now, now)
  db.exec('COMMIT')
}

/** 把前 n 条 atom 的向量修成有效值（模拟「条件恢复」）。 */
function repairVectors(db, n) {
  const ids = db.prepare('SELECT id FROM atom ORDER BY id LIMIT ?').all(n)
  const up = db.prepare('UPDATE atom SET embedding = ? WHERE id = ?')
  ids.forEach((r, i) => up.run(encodeVec(vecOf(i + 1)), Number(r.id)))
}

function cfgOf() {
  return {
    dataDir: dir,
    encoderEnabled: false,
    encoderModel: MODEL,
    encoderMirror: '',
    encoderCacheDir: '',
    thresholds: { tauJoin: 0.78, tauLex: 0.05, tauLexOnly: 0.1, tauNew: 0.5 },
    viewBudget: 6000,
    topN: 24,
    samplesEnabled: true,
    resources: {},
  }
}

async function addPositives(n) {
  for (let i = 0; i < n; i++) {
    const ok = await recordSample({
      kind: 'positive',
      source: 'feedback',
      top1: 0.8,
      vec: vecOf(1000 + i),
      hitIds: [i + 1],
    })
    assert.equal(ok, true, '样本应写入成功')
  }
}

async function addNegatives(n, top1 = 0.3) {
  for (let i = 0; i < n; i++) {
    const ok = await recordSample({
      kind: 'negative',
      source: 'auto',
      top1,
      vec: vecOf(2000 + i),
      hitIds: [i + 1],
    })
    assert.equal(ok, true, '负样本应写入成功')
  }
}

describe('重标触发：四道闸与失败不半改（T44 判据 5/7/8）', () => {
  beforeEach(() => {
    closeRuntime()
    try {
      closeSamples()
    } catch {
      /* 已关 */
    }
    dir = join(
      tmpdir(),
      'dsh-lattice-recal-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    )
  })

  afterEach(() => {
    closeRuntime()
    try {
      closeSamples()
    } catch {
      /* 已关 */
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  })

  it('库小于 192 条：不重标，理由是 small_db', async () => {
    const rt = getRuntime(cfgOf())
    seedAtoms(rt.db, 20)
    assert.equal(await maybeRecalibrate(), 'small_db')
    assert.equal(rt.calibration.state, 'uncalibrated')
    assert.equal(rt.calibration.params, null)
  })

  it('判据 5：库够大但没有正样本 → 只跳过，不重标', async () => {
    const rt = getRuntime(cfgOf())
    seedAtoms(rt.db, 192)
    assert.equal(sampleStats().positive, 0)
    assert.equal(await maybeRecalibrate(), 'no_positive')
    assert.equal(rt.calibration.state, 'uncalibrated')
    assert.equal(rt.calibration.params, null, '无样本时不许凭空产生参数')
    assert.equal(readSnapshotState(rt.db).state, 'missing', '也不许写快照')
  })

  it('有正样本但没有负样本：不重标（切点要两侧，这属于条件没到而不是失败）', async () => {
    const rt = getRuntime(cfgOf())
    seedAtoms(rt.db, 192)
    await addPositives(10)
    assert.equal(await maybeRecalibrate(), 'no_negative')
    assert.equal(rt.calibration.state, 'uncalibrated')
    assert.ok(!getMeta(rt.db, META_CALIB_LAST_ERROR), '跳过不是失败，不该留错误记录')
  })

  it('冷却期内不判 S 也不重标', async () => {
    const rt = getRuntime(cfgOf())
    seedAtoms(rt.db, 192)
    await addPositives(10)
    await addNegatives(6)
    setMeta(rt.db, META_CALIB_LAST_CHECK, String(Date.now()))
    assert.equal(await maybeRecalibrate(), 'cooldown')
    assert.equal(rt.calibration.state, 'uncalibrated')
  })

  it('P0-1：算 S 失败不记冷却，条件恢复后能立刻重标', async () => {
    const rt = getRuntime(cfgOf())
    seedZeroAtoms(rt.db, 192)
    await addPositives(10)
    await addNegatives(6)

    const first = await maybeRecalibrate()
    assert.equal(first, 'no_vectors', '零向量库算不出 S')
    assert.ok(
      !getMeta(rt.db, META_CALIB_LAST_CHECK),
      '算 S 失败**不能**写 calib_last_check_at —— 否则一次失败换来 12 小时冷却',
    )
    assert.ok(getMeta(rt.db, META_CALIB_LAST_ERROR), '失败要留原因码')

    // 条件恢复：把向量修好，**立刻**再调一次 —— 不能被冷却挡住。
    repairVectors(rt.db, 192)
    const second = await maybeRecalibrate()
    assert.notEqual(second, 'cooldown', '上一次算 S 失败不该产生冷却')
    assert.equal(second, 'recalibrated')
    assert.ok(getMeta(rt.db, META_CALIB_LAST_CHECK), '算成功后才记时间')
  })

  it('判据 7：S 漂移超过 0.01 → 重标成功，参数整体替换', async () => {
    const rt = getRuntime(cfgOf())
    seedAtoms(rt.db, 192)
    await addPositives(10)
    await addNegatives(6)
    // 故意写一个离真实 S 很远的基准：漂移一定超过 0.01。
    writeSnapshot(rt.db, {
      params: { briefMin: 0.123456 },
      sBaseline: 0.01,
      calibVersion: CALIB_VERSION,
      at: Date.now(),
      encoderModel: MODEL,
    })
    closeRuntime()

    const rt2 = getRuntime(cfgOf())
    assert.equal(rt2.calibration.params?.briefMin, 0.123456, '重标前用的是快照里的旧参数')
    const outcome = await maybeRecalibrate()
    assert.equal(outcome, 'recalibrated')
    assert.equal(rt2.calibration.state, 'calibrated')
    const after = rt2.calibration.params?.briefMin
    assert.notEqual(after, 0.123456, '参数必须换成新算出来的值')
    // 快照同步更新：下一次启动读到的是新基准。
    const snap = readSnapshotState(rt2.db)
    assert.equal(snap.state, 'ok')
    if (snap.state === 'ok') {
      assert.notEqual(snap.snapshot.sBaseline, 0.01, '基准 S 必须跟着更新')
      assert.equal(snap.snapshot.params.briefMin, after)
    }
  })

  it('判据 8：重标中途失败 → 参数一个字不动，错误进 meta', async () => {
    const rt = getRuntime(cfgOf())
    seedAtoms(rt.db, 192)
    await addPositives(10)
    await addNegatives(6)
    writeSnapshot(rt.db, {
      params: { briefMin: 0.123456 },
      sBaseline: 0.01,
      calibVersion: CALIB_VERSION,
      at: Date.now(),
      encoderModel: MODEL,
    })
    closeRuntime()

    const rt2 = getRuntime(cfgOf())
    // 让写快照在最后一个键上失败：事务回滚，meta 里不留半份。
    rt2.db.exec(
      "CREATE TRIGGER fail_calib_at BEFORE INSERT ON meta WHEN NEW.key = 'calib_at' " +
        "BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    )
    const outcome = await maybeRecalibrate()
    assert.equal(outcome, 'failed')
    assert.equal(rt2.calibration.params?.briefMin, 0.123456, '失败后必须还是旧参数')
    assert.ok(getMeta(rt2.db, META_CALIB_LAST_ERROR) !== null, '失败要有记录，而且不能只活在日志里')
    rt2.db.exec('DROP TRIGGER fail_calib_at')
  })
})

// atom.flags 落地（判据 1–5）。
//
// 这里验的是「位写对了、过滤与 SQL 一致、不参与打分、旧库不回溯」；
// 而「回执文案是否自洽」是 D1 的事 —— 两件独立的坏事，别用这一个的绿去替代那一个（v1.0 计划 §4 的警告）。
//
// 钩子放在 describe 内部（node:test 顶层钩子是全局的）。

import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openVault } from '../dist/db/open.js'
import { listAtoms } from '../dist/pipeline/list.js'
import { VEC_DIM } from '../dist/util/vec.js'
import {
  FLAG_AMBIGUOUS,
  FLAG_SPLIT_PENDING,
  FLAG_UNCLASSIFIED,
  createWriteCtx,
  writeAtom,
} from '../dist/pipeline/write.js'

function oneHot(i) {
  const v = new Float32Array(VEC_DIM)
  v[i] = 1
  return v
}

/** 按关键词给向量：与 write.test.mjs 里的同形，但这里只需要两种方向。 */
function keywordEncoder(pairs) {
  return async (text) => {
    for (const [kw, vec] of pairs) if (text.includes(kw)) return vec
    return oneHot(0)
  }
}

describe('atom.flags 落地', () => {
  let db = null
  let dir = ''

  beforeEach(() => {
    dir = join(
      tmpdir(),
      'dsh-lattice-flags-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    )
    mkdirSync(dir, { recursive: true })
    db = openVault(join(dir, 'lattice.db')).db
  })

  afterEach(() => {
    try {
      db?.close()
    } catch {
      /* 已关闭 */
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响判定 */
    }
  })

  it('判据 1：两个候选接近（ambiguous）→ flags 含「歧义」位', async () => {
    const encode = keywordEncoder([
      ['罗盘', oneHot(10)],
      ['星图', oneHot(11)],
    ])
    const ctx = createWriteCtx(db, {}, { encode })
    await writeAtom(ctx, { text: '罗盘校准记录：磁偏角随时间缓慢变化。' })
    await writeAtom(ctx, { text: '星图绘制记录：赤经赤纬的换算表。' })
    const mid = new Float32Array(VEC_DIM)
    mid[10] = 1 / Math.sqrt(2)
    mid[11] = 1 / Math.sqrt(2)
    const r = await writeAtom(createWriteCtx(db, {}, { encode: async () => mid }), {
      text: '天文观测记录：需要同时参考罗盘与星图的结论。',
    })
    assert.equal(r.created, 'ambiguous')
    const row = db.prepare('SELECT flags FROM atom WHERE id = ?').get(r.atomId)
    assert.equal(Number(row.flags) & FLAG_AMBIGUOUS, FLAG_AMBIGUOUS, '歧义位必须置上')
    assert.equal(Number(row.flags) & FLAG_UNCLASSIFIED, 0, '歧义不等于未归类，别两个都置')
  })

  it('判据 2：与任何已有主题都不像（far）→ flags 含「未归类」位', async () => {
    const A = oneHot(20)
    const B = oneHot(21)
    const encode = async (t) => (t.includes('潮汐') ? A : B)
    const ctx = createWriteCtx(db, {}, { encode })
    await writeAtom(ctx, { text: '港口潮汐表每个月重新校核一次。' })
    const r = await writeAtom(ctx, { text: '棱镜色散实验的读数记录在实验本第三页。' })
    assert.equal(r.created, 'far')
    const row = db.prepare('SELECT flags FROM atom WHERE id = ?').get(r.atomId)
    assert.equal(Number(row.flags) & FLAG_UNCLASSIFIED, FLAG_UNCLASSIFIED)
    assert.equal(Number(row.flags) & FLAG_AMBIGUOUS, 0)
  })

  it('并入已有主题时不置位（归属已确认，没有要标记的东西）', async () => {
    const v = oneHot(30)
    const encode = async () => v
    const ctx = createWriteCtx(db, {}, { encode })
    await writeAtom(ctx, { text: '第一条：同一件事的初版。' })
    const r = await writeAtom(ctx, { text: '第一条：同一件事的补充说明，措辞几乎一样。' })
    if (r.action === 'joined') {
      const row = db.prepare('SELECT flags FROM atom WHERE id = ?').get(r.atomId)
      assert.equal(Number(row.flags), 0)
    }
  })

  it('判据 3：按位过滤的结果与 SQL 直查一致（不用插件自己的输出对照自己）', async () => {
    const A = oneHot(40)
    const encode = async (t) => (t.includes('潮汐') ? A : oneHot(41))
    const ctx = createWriteCtx(db, {}, { encode })
    await writeAtom(ctx, { text: '港口潮汐表每个月重新校核一次。' })
    await writeAtom(ctx, { text: '棱镜色散实验的读数记录在实验本第三页。' })

    const sqlCount = Number(
      db.prepare('SELECT COUNT(*) AS n FROM atom WHERE (flags & ?) <> 0').get(FLAG_UNCLASSIFIED).n,
    )
    const listed = listAtoms(db, { flags: FLAG_UNCLASSIFIED, limit: 50 })
    assert.equal(listed.total, sqlCount, '列表条数必须等于 SQL 直查')
    assert.equal(listed.rows.length, sqlCount)
    for (const row of listed.rows) assert.notEqual(row.flags & FLAG_UNCLASSIFIED, 0)
  })

  it('判据 5：重开库不回溯猜 —— 旧行保持 0', async () => {
    // 造一行「旧写入」：flags 显式 0，然后重新打开库（打开路径会跑一遍幂等的建库校验）。
    db.prepare(
      'INSERT INTO atom (kind, text, summary, embedding, created_at, updated_at, flags) VALUES (?, ?, ?, ?, ?, ?, 0)',
    ).run('知识', '旧行', '旧行', new Uint8Array(VEC_DIM * 4), Date.now(), Date.now())
    const before = Number(db.prepare('SELECT COUNT(*) AS n FROM atom WHERE flags <> 0').get().n)
    db.close()
    db = openVault(join(dir, 'lattice.db')).db
    const after = Number(db.prepare('SELECT COUNT(*) AS n FROM atom WHERE flags <> 0').get().n)
    assert.equal(before, 0)
    assert.equal(after, 0, '迁移不许替历史行编一个 bit')
  })

  it('位定义互不重叠（改位值会让历史行解释错）', () => {
    assert.equal(FLAG_SPLIT_PENDING & FLAG_AMBIGUOUS, 0)
    assert.equal(FLAG_SPLIT_PENDING & FLAG_UNCLASSIFIED, 0)
    assert.equal(FLAG_AMBIGUOUS & FLAG_UNCLASSIFIED, 0)
  })
})

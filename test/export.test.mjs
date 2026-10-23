// 整库导出：JSON 快照与 markdown 清单。
//
// 这里钉四件事：
//   1. JSON 是一个完整快照 —— 顶层契约键齐、atoms 条数等于库里的行数、不含可重算的列；
//   2. 空库导出是空数组而不是错误；
//   3. markdown 每条记忆一行，正文里的 # / | / 反引号 / 换行不破坏结构；
//   4. 导出只读：前后 data_version 与行数都不变。
//
// 不做导入的验证：导入还没实现（理由见 src/export/snapshot.ts 的文件头）。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { exportJson, exportMarkdown } from '../dist/export/snapshot.js'
import { closeRuntime } from '../dist/state.js'
import { openVault } from '../dist/db/open.js'
import { VEC_DIM } from '../dist/util/vec.js'

let dir = ''
let db = null

/** 造一条 embedding：导出不读它，但列是 NOT NULL。 */
function vec(seed) {
  const v = new Float32Array(VEC_DIM)
  v[seed % VEC_DIM] = 1
  return Buffer.from(v.buffer)
}

function insertTopic(label, n) {
  const now = 1_760_000_000_000
  const info = db
    .prepare('INSERT INTO topic (label, sum_vec, n_atoms, created_at, rebuilt_at) VALUES (?, ?, ?, ?, ?)')
    .run(label, vec(1), n, now, now)
  return Number(info.lastInsertRowid)
}

function insertAtom(fields) {
  const now = 1_760_000_000_000
  const info = db
    .prepare(
      'INSERT INTO atom (kind, text, summary, embedding, topic_id, origin, source, source_ref, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      fields.kind ?? '结论',
      fields.text ?? '一条正文',
      fields.summary ?? fields.text ?? '一条正文',
      vec(2),
      fields.topicId ?? null,
      fields.origin ?? 'user',
      fields.source ?? null,
      fields.sourceRef ?? null,
      fields.createdAt ?? now,
      now,
    )
  return Number(info.lastInsertRowid)
}

function insertEdge(src, dst, kind = 'related') {
  db.prepare(
    'INSERT INTO edge (src_type, src_id, dst_type, dst_id, kind, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('atom', src, 'atom', dst, kind, 'declared', 1_760_000_000_000)
}

describe('整库导出', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-lattice-export-'))
    db = openVault(join(dir, 'lattice.db')).db
  })

  afterEach(() => {
    closeRuntime()
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

  it('JSON 是完整快照：契约键齐、条数等于库里行数、不含可重算的列', () => {
    const topicId = insertTopic('导出', 2)
    const a = insertAtom({ text: '第一条', topicId })
    const b = insertAtom({ text: '第二条', topicId })
    insertEdge(a, b)
    const out = exportJson(db, { version: '9.9.9', now: 1_760_000_000_000 })
    const body = JSON.parse(out.text)
    assert.equal(body.version, '9.9.9')
    assert.equal(body.schemaVersion, 5)
    assert.equal(body.exportedAt, new Date(1_760_000_000_000).toISOString())
    assert.deepEqual(body.counts, { atoms: 2, topics: 1, edges: 1 })
    assert.equal(body.atoms.length, db.prepare('SELECT COUNT(*) AS n FROM atom').get().n)
    assert.equal(body.topics.length, db.prepare('SELECT COUNT(*) AS n FROM topic').get().n)
    assert.equal(body.edges.length, db.prepare('SELECT COUNT(*) AS n FROM edge').get().n)
    // 列清单与库一致：superseded_at 在，可重算的 embedding / entry 不在。
    assert.ok('superseded_at' in body.atoms[0], '缺少 superseded_at 列')
    assert.ok(!('embedding' in body.atoms[0]), 'embedding 是从正文算出来的，不该导出')
    assert.ok(!('sum_vec' in body.topics[0]), 'sum_vec 是二进制派生列，不该导出')
    // 文件大小是真的：bytes 与 UTF-8 字节数一致，供完成记录里的「文件多大」使用。
    assert.equal(out.bytes, Buffer.byteLength(out.text))
  })

  it('空库导出是空数组，不是错误', () => {
    const out = exportJson(db, { version: '9.9.9' })
    const body = JSON.parse(out.text)
    assert.deepEqual(body.atoms, [])
    assert.deepEqual(body.topics, [])
    assert.deepEqual(body.edges, [])
    assert.deepEqual(body.counts, { atoms: 0, topics: 0, edges: 0 })
    const md = exportMarkdown(db, { version: '9.9.9' })
    assert.ok(md.text.includes('# lattice 记忆库导出'))
    assert.ok(!md.text.includes('## 主题'), '空库不该出现空主题标题')
  })

  it('markdown 每条记忆一行，正文里的 # | 反引号换行不破坏结构', () => {
    const topicId = insertTopic('结构', 3)
    const plain = insertAtom({ text: '普通一条', topicId })
    const tricky = insertAtom({
      text: '# 不像标题\n| 不像表格 |\n`看起来像代码` 与 ## 二级标题',
      topicId,
    })
    insertAtom({ text: '没有归属的一条', topicId: null })
    const out = exportMarkdown(db, { version: '9.9.9' })
    const lines = out.text.split('\n')
    // 每条记忆恰好一行，且都以 '- `#id`' 开头：正文里的 # 与换行都被压进那一行。
    const itemLines = lines.filter((line) => line.startsWith('- `#'))
    assert.equal(itemLines.length, 3)
    assert.ok(out.text.includes('`#' + plain + '`'))
    assert.ok(out.text.includes('`#' + tricky + '`'))
    assert.ok(out.text.includes('不像标题'))
    // 子内容不能造出标题行：除顶层标题与主题节标题外，没有别的 # 行。
    const headings = lines.filter((line) => line.startsWith('#'))
    assert.deepEqual(
      headings.map((line) => line.slice(0, 3)),
      ['# l', '## ', '## '],
      '标题只该有三种：顶层一行、两个主题节（含未归类）',
    )
    assert.ok(out.text.includes('## 未归类（1 条）'))
  })

  it('导出只读：前后行数与 data_version 都不变', () => {
    const topicId = insertTopic('只读', 1)
    insertAtom({ text: '只读一条', topicId })
    const before = {
      atoms: db.prepare('SELECT COUNT(*) AS n FROM atom').get().n,
      version: db.prepare('PRAGMA data_version').get().data_version,
    }
    exportJson(db, { version: '9.9.9' })
    exportMarkdown(db, { version: '9.9.9' })
    const after = {
      atoms: db.prepare('SELECT COUNT(*) AS n FROM atom').get().n,
      version: db.prepare('PRAGMA data_version').get().data_version,
    }
    assert.equal(after.atoms, before.atoms)
    assert.equal(after.version, before.version, '导出不该写库：data_version 变了就是写了')
  })
})

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { listObjects, migrate, openDb, openVault, schemaVersion } from '../dist/db/open.js'

let dbFile = ''

beforeEach(() => {
  dbFile = join(
    tmpdir(),
    `dsh-lattice-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  )
})

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbFile + suffix, { force: true })
})

describe('建库与迁移', () => {
  it('从空文件建到最新版本，并留下足够的 schema 对象', () => {
    const { db, migration } = openVault(dbFile)
    assert.equal(migration.from, 0)
    assert.ok(migration.to > 0)
    assert.equal(schemaVersion(db), migration.to)
    const objs = listObjects(db)
    assert.ok(objs.filter((o) => o.type === 'table').length >= 12, '表数不足')
    assert.ok(objs.filter((o) => o.type === 'index').length >= 8, '索引数不足')
    assert.ok(objs.filter((o) => o.type === 'trigger').length >= 6, '触发器数不足')
    db.close()
  })

  it('迁移幂等', () => {
    const db = openDb(dbFile)
    migrate(db)
    assert.equal(migrate(db).applied, 0)
    db.close()
  })

  it('开启 WAL 与外键约束', () => {
    const db = openDb(dbFile)
    assert.equal(String(db.prepare('PRAGMA journal_mode').get().journal_mode), 'wal')
    assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1)
    db.close()
  })

  it('外键约束真正生效', () => {
    const { db } = openVault(dbFile)
    assert.throws(() =>
      db.exec(
        "INSERT INTO entry(atom_id, term, weight, origin, created_at) VALUES (999, 'x', 1, 'declared', 0)",
      ),
    )
    db.close()
  })
})

describe('两层检索索引', () => {
  it('正文 trigram 对两字词返回空，Entry 层 bigram 兜底命中', () => {
    const { db } = openVault(dbFile)
    const text = '访问大陆不可达地址时优先使用系统代理下载大文件'
    db.exec(
      `INSERT INTO atom(id, kind, text, summary, embedding, scope, flags, created_at, updated_at)
       VALUES (1, 'conclusion', '${text}', '系统代理', zeroblob(2048), 'global', 0, 0, 0)`,
    )
    db.exec(`INSERT INTO atom_search(id, body) VALUES (1, '${text}')`)
    db.exec(
      `INSERT INTO entry(atom_id, term, bigram, weight, origin, created_at)
       VALUES (1, '系统代理', '系统 统代 代理', 0.6, 'extracted', 0)`,
    )
    const hit = (sql, q) => Number(db.prepare(sql).get(q).c)
    assert.equal(
      hit('SELECT count(*) c FROM atom_fts WHERE atom_fts MATCH ?', '代理'),
      0,
      'trigram 不该命中两字词',
    )
    assert.equal(hit('SELECT count(*) c FROM atom_fts WHERE atom_fts MATCH ?', '系统代理'), 1)
    assert.equal(
      hit('SELECT count(*) c FROM entry_fts WHERE entry_fts MATCH ?', '代理'),
      1,
      'Entry 层应兜住短词',
    )
    db.close()
  })
})
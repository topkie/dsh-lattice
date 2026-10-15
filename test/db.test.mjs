import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { META_ENTRY_RULE, checkEntryRule, ensureMeta, getMeta, readMeta, setMeta } from '../dist/db/meta.js'
import { listObjects, migrate, openDb, openVault, schemaVersion } from '../dist/db/open.js'
import { MIGRATIONS, SCHEMA_VERSION, normalizeOrigin } from '../dist/db/schema.js'
import { ENTRY_RULE_ID } from '../dist/pipeline/entries.js'
import { recordRecall } from '../dist/pipeline/search.js'

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

describe('schema 迁移', () => {
  it('v1 的库只跑增量就能升到最新版', () => {
    const db = openDb(dbFile)
    // 手工造一个 v1 的库：只执行 v1 那一步，并把版本号停在那里。
    db.exec('BEGIN')
    for (const stmt of MIGRATIONS[0]) db.exec(stmt)
    db.exec('PRAGMA user_version = 1')
    db.exec('COMMIT')
    assert.equal(schemaVersion(db), 1)
    assert.throws(() => db.prepare('SELECT * FROM meta').get(), '升级前不该有 meta 表')

    const r = migrate(db)
    assert.equal(r.from, 1)
    assert.equal(r.to, SCHEMA_VERSION)
    assert.ok(r.applied > 0, '只跑增量也必须真的执行了语句')
    assert.equal(schemaVersion(db), SCHEMA_VERSION)
    assert.doesNotThrow(() => db.prepare('SELECT * FROM meta').get())
    db.close()
  })

  it('迁移步骤表覆盖每一个版本跨度', () => {
    assert.equal(MIGRATIONS.length, SCHEMA_VERSION)
  })
})

describe('库自描述', () => {
  it('setMeta 覆盖，ensureMeta 保持原值', () => {
    const { db } = openVault(dbFile)
    setMeta(db, META_ENTRY_RULE, 'a')
    assert.equal(getMeta(db, META_ENTRY_RULE), 'a')
    setMeta(db, META_ENTRY_RULE, 'b')
    assert.equal(getMeta(db, META_ENTRY_RULE), 'b')
    assert.equal(ensureMeta(db, META_ENTRY_RULE, 'c'), false)
    assert.equal(getMeta(db, META_ENTRY_RULE), 'b')
    assert.equal(ensureMeta(db, 'fresh', 'x'), true)
    assert.equal(getMeta(db, 'fresh'), 'x')
    assert.equal(getMeta(db, 'never-written'), undefined)
    db.close()
  })

  it('readMeta 按键排序返回全部', () => {
    const { db } = openVault(dbFile)
    setMeta(db, 'b', '2')
    setMeta(db, 'a', '1')
    assert.deepEqual(Object.keys(readMeta(db)), ['a', 'b'])
    db.close()
  })

  it('规则比对：一致才算 ok，缺自描述与不一致都不算', () => {
    const { db } = openVault(dbFile)
    setMeta(db, META_ENTRY_RULE, ENTRY_RULE_ID)
    assert.deepEqual(checkEntryRule(db, ENTRY_RULE_ID), {
      ok: true,
      stored: ENTRY_RULE_ID,
      current: ENTRY_RULE_ID,
    })

    const other = checkEntryRule(db, 'bigram-idf-v1')
    assert.equal(other.ok, false)
    assert.equal(other.stored, ENTRY_RULE_ID)

    // 没有自描述的库（v1 建的）必须报「不可比」，不能静默当作一致。
    db.exec("DELETE FROM meta WHERE key = '" + META_ENTRY_RULE + "'")
    const none = checkEntryRule(db, ENTRY_RULE_ID)
    assert.equal(none.ok, false)
    assert.equal(none.stored, null)
    db.close()
  })
})

describe('所有权与生命周期状态', () => {
  it('origin 收敛：不认识的值退回默认，脏值不进库', () => {
    assert.equal(normalizeOrigin('user'), 'user')
    assert.equal(normalizeOrigin('import'), 'import')
    assert.equal(normalizeOrigin(undefined), 'model')
    assert.equal(normalizeOrigin('nonsense'), 'model')
    assert.equal(normalizeOrigin('nonsense', 'import'), 'import')
  })

  it('v1 的库升级后带 origin 列，导入行按 source 推断出来', () => {
    const db = openDb(dbFile)
    db.exec('BEGIN')
    for (const stmt of MIGRATIONS[0]) db.exec(stmt)
    db.exec('PRAGMA user_version = 1')
    db.exec('COMMIT')
    // 一条导入的（带 source）与一条运行时写的（不带）—— 迁移要能分开它们。
    db.exec(
      `INSERT INTO atom(id, kind, text, summary, embedding, scope, flags, source, created_at, updated_at)
       VALUES (1, 'k', 't', 's', zeroblob(2048), 'global', 0, 'migrate', 0, 0)`,
    )
    db.exec(
      `INSERT INTO atom(id, kind, text, summary, embedding, scope, flags, created_at, updated_at)
       VALUES (2, 'k', 't', 's', zeroblob(2048), 'global', 0, 0, 0)`,
    )
    migrate(db)
    const rows = db.prepare('SELECT id, origin FROM atom ORDER BY id').all()
    assert.equal(String(rows[0].origin), 'import')
    assert.equal(String(rows[1].origin), 'model')
    db.close()
  })

  it('命中计数只增不改，且不碰未命中的行', () => {
    const { db } = openVault(dbFile)
    const ins = db.prepare(
      'INSERT INTO atom(id, kind, text, summary, embedding, scope, flags, created_at, updated_at) VALUES (?, ?, ?, ?, zeroblob(2048), ?, 0, 0, 0)',
    )
    for (const id of [1, 2]) ins.run(id, 'k', 't', 's', 'global')
    // IN 里有重复值也只更新一次 —— 正是想要的：同一次召回里同一条记忆只记一次。
    assert.equal(recordRecall(db, [1, 1, 1], 111), 1)
    assert.equal(recordRecall(db, [1], 222), 1)
    assert.equal(recordRecall(db, [], 333), 0)
    const rows = db.prepare('SELECT id, recall_hits, last_recalled_at FROM atom ORDER BY id').all()
    assert.equal(Number(rows[0].recall_hits), 2)
    assert.equal(Number(rows[0].last_recalled_at), 222)
    assert.equal(Number(rows[1].recall_hits), 0)
    db.close()
  })
})

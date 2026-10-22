import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { checkEntryRule, ensureBuildInfo, readBuildInfo, setBuildInfo } from '../dist/db/build-info.js'
import { listObjects, migrate, openDb, openVault, schemaVersion } from '../dist/db/open.js'
import { MIGRATIONS, SCHEMA_VERSION, normalizeOrigin } from '../dist/db/schema.js'
import { ENTRY_RULE_ID } from '../dist/pipeline/entries.js'
import { recordRecall } from '../dist/pipeline/search.js'

let dbFile = ''

describe('db', () => {
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
      for (const name of ['build_info', 'recluster_state', 'split_queue']) {
        assert.ok(
          objs.some((o) => o.type === 'table' && o.name === name),
          '缺少 v5 的表：' + name,
        )
      }
      // calib_state 在 0.9 的结构变更里删掉了：它 0.5.0 起没有读写方。
      assert.ok(!objs.some((o) => o.type === 'table' && o.name === 'calib_state'), 'calib_state 应已删除')
      // 版本号是声明；上面缺对象就抛的那一步（missingObjects）是证据。
      assert.equal(schemaVersion(db), SCHEMA_VERSION)
      db.close()
    })

    it('只读打开一个旧版本的库：不迁移、不报错，如实报告库的实际版本', () => {
      // 造一个「版本落后」的库：建到最新版，再把版本号改回去（表是全的，只有版本号旧）。
      // 这正是改过 schema 之后、还没重建的库的样子 —— 而它必须能被只读打开。
      const seed = openVault(dbFile)
      seed.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`)
      seed.db.close()

      const { db, migration } = openVault(dbFile, { readOnly: true })
      // 没被迁移：版本仍是旧的，且 applied 为 0
      assert.equal(schemaVersion(db), SCHEMA_VERSION - 1)
      assert.equal(migration.applied, 0)
      // 如实报告的是「库的实际版本」，不是插件支持的版本
      assert.equal(migration.from, SCHEMA_VERSION - 1)
      assert.equal(migration.to, SCHEMA_VERSION - 1)
      db.close()

      // 再打开一次确认那个库确实没被写过
      const again = openDb(dbFile)
      assert.equal(schemaVersion(again), SCHEMA_VERSION - 1)
      again.close()
    })

    it('只读打开最新版本的库：同样不迁移，结果一致', () => {
      const seed = openVault(dbFile)
      seed.db.close()
      const { db, migration } = openVault(dbFile, { readOnly: true })
      assert.equal(schemaVersion(db), SCHEMA_VERSION)
      assert.equal(migration.applied, 0)
      assert.equal(migration.to, SCHEMA_VERSION)
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
    it('v4 的库（未发布的内部版本）打开即报错，且版本号不动', () => {
      const seed = openDb(dbFile)
      // 造一个「结构是新的、版本号是旧」的库：它等价于改过 schema 但没重建的内部库。
      seed.exec('BEGIN')
      for (const stmt of MIGRATIONS[0]) seed.exec(stmt)
      seed.exec('PRAGMA user_version = 4')
      seed.exec('COMMIT')
      seed.close()

      assert.throws(() => openVault(dbFile), /来自未发布的内部构建/)

      // 判据③的另一半：报错不能顺手写库。版本号仍是 4。
      const after = openDb(dbFile)
      assert.equal(schemaVersion(after), 4)
      after.close()
    })

    it('版本号是 5 但结构不符：打开即报错，并列出缺的对象', () => {
      const seed = openDb(dbFile)
      seed.exec('BEGIN')
      for (const stmt of MIGRATIONS[0]) seed.exec(stmt)
      seed.exec('COMMIT')
      // 手工制造「声明是 v5、结构不是」：删掉一张 v5 才有的表（它的索引一起没了）。
      seed.exec('DROP TABLE split_queue')
      seed.exec('PRAGMA user_version = 5')
      seed.close()

      assert.throws(() => openVault(dbFile), /结构不符[\s\S]*split_queue/)
    })

    it('建表中途失败：回滚到空库，不留下半截结构', () => {
      const db = openDb(dbFile)
      // 预先占住一个快照里要建的表名，让它在中途撞车（atom 之前已经有表建出来了）。
      db.exec('CREATE TABLE atom (x INTEGER)')
      assert.throws(() => migrate(db))
      assert.equal(schemaVersion(db), 0, '失败不能把版本号留在 5')
      assert.throws(() => db.prepare('SELECT 1 FROM topic').get(), '半截建出来的表要一起回滚')
      db.close()
    })

    it('迁移表只有一份快照，没有历史增量链', () => {
      // 0.9 是首个对外版本：没有外部库需要升级，所以只保留「空库直建 v5」。
      assert.equal(MIGRATIONS.length, 1)
    })
  })

  describe('库自描述', () => {
    it('运行时给库补一份自描述，已存在的一律不动', () => {
      const { db } = openVault(dbFile)
      // openVault 只建结构；写自描述是运行时启动那一步的事（state.ts 的 stampVault）。
      assert.equal(readBuildInfo(db), null)
      assert.equal(ensureBuildInfo(db, { entryRule: ENTRY_RULE_ID, builder: 'runtime' }), true)
      const first = readBuildInfo(db)
      assert.equal(first.entryRule, ENTRY_RULE_ID)
      assert.equal(first.builder, 'runtime')
      assert.equal(
        ensureBuildInfo(db, { entryRule: 'other', builder: 'probe' }),
        false,
        '已有自描述时一个字都不改',
      )
      assert.equal(readBuildInfo(db).entryRule, ENTRY_RULE_ID)
      db.close()
    })

    it('setBuildInfo 覆盖四项', () => {
      const { db } = openVault(dbFile)
      setBuildInfo(db, { entryRule: 'other', builder: 'probe', builtAt: 123, source: 'dir/name' })
      assert.deepEqual(readBuildInfo(db), {
        entryRule: 'other',
        builder: 'probe',
        builtAt: 123,
        source: 'dir/name',
      })
      db.close()
    })

    it('没有自描述的库：读到 null，ensure 说它写了', () => {
      const db = openDb(dbFile)
      migrate(db)
      assert.equal(readBuildInfo(db), null)
      assert.equal(ensureBuildInfo(db, { entryRule: 'r', builder: 'b' }), true)
      assert.equal(readBuildInfo(db).builder, 'b')
      db.close()
    })

    it('规则比对：一致才算 ok，缺自描述与不一致都不算', () => {
      const { db } = openVault(dbFile)
      // 写自描述是运行时的事（state.ts 的 stampVault），openVault 只建结构 —— 这里显式补一份。
      ensureBuildInfo(db, { entryRule: ENTRY_RULE_ID, builder: 'runtime' })
      assert.deepEqual(checkEntryRule(db, ENTRY_RULE_ID), {
        ok: true,
        stored: ENTRY_RULE_ID,
        current: ENTRY_RULE_ID,
      })

      const other = checkEntryRule(db, 'bigram-idf-v1')
      assert.equal(other.ok, false)
      assert.equal(other.stored, ENTRY_RULE_ID)

      // 没有自描述的库必须报「不可比」，不能静默当作一致。
      db.exec('DELETE FROM build_info')
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

    it('atom 的 origin 列有默认值：没给就是 model', () => {
      const db = openDb(dbFile)
      migrate(db)
      db.exec(
        `INSERT INTO atom(kind, text, summary, embedding, scope, flags, created_at, updated_at)
       VALUES ('k', 't', 's', zeroblob(2048), 'global', 0, 0, 0)`,
      )
      assert.equal(String(db.prepare('SELECT origin FROM atom').get().origin), 'model')
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
})

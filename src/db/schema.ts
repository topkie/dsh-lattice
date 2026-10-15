// dsh-lattice 存储层 schema。
//
// 三条设计要点：
//   1. **真相源唯一**：atom 本体、declared 边/归属/入口、learned 入口不可重算；而
//      topic / domain / atom_pair / atom_search / 全部 FTS 索引 / inferred 边都能由
//      atom 重算。因此备份只需覆盖前者，算法升级也不必做数据迁移。
//   2. **两层检索索引**：正文用 FTS5 的 trigram 分词器；但 trigram 按 3 字符滑窗，
//      对长度 ≤2 的中文查询返回 0 命中，而中文技术查询里两字词极常见，所以 entry 层
//      再叠一层 CJK bigram 索引（unicode61）兜底。
//   3. **主题不落库中心向量**：topic 只存 sum_vec 与 n_atoms，归一化中心在查询时现算。
//      这样增量加减与全量重算逐位等价，不会被浮点漂移破坏上面第 1 条不变量。

import type { ResourceParams } from '../util/memory.js'

/** schema 版本；用 PRAGMA user_version 持久化。结构变更必须 +1 并补迁移分支。 */
export const SCHEMA_VERSION = 1

/**
 * 连接建立时按序执行的 PRAGMA（不能放在事务里）。
 *
 * 其中三个参数与**机器**相关，不再写死：mmap_size / cache_size 由可用内存与库大小推导，
 * busy_timeout 由实测的写入耗时推导（见 util/memory.ts 的推导规则）。
 * 其余四个是语义性设置，与机器无关，保持常量。
 */
export function pragmas(res: ResourceParams): readonly string[] {
  return [
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = NORMAL',
    'PRAGMA foreign_keys = ON',
    // cache_size 用负值表示「单位是 KiB」；这里统一以字节换算。
    'PRAGMA busy_timeout = ' + res.busyTimeout,
    'PRAGMA mmap_size = ' + res.mmapSize,
    'PRAGMA cache_size = -' + Math.round(res.cacheSize / 1024),
    'PRAGMA wal_autocheckpoint = 1000',
  ]
}

/** 建库语句，按依赖顺序排列；migrate() 在单个事务内依次执行。 */
export const DDL: readonly string[] = [
  // ── 域：派生，topic 的上层聚类 ─────────────────────────────
  `CREATE TABLE domain (
    id          INTEGER PRIMARY KEY,
    label       TEXT    NOT NULL,
    centroid    BLOB    NOT NULL,
    topic_count INTEGER NOT NULL DEFAULT 0,
    built_at    INTEGER NOT NULL
  )`,

  // ── 主题：派生，可全量重算 ────────────────────────────────
  `CREATE TABLE topic (
    id           INTEGER PRIMARY KEY,
    domain_id    INTEGER REFERENCES domain(id) ON DELETE SET NULL,
    label        TEXT    NOT NULL,
    sum_vec      BLOB    NOT NULL,
    n_atoms      INTEGER NOT NULL DEFAULT 0,
    mean_fit     REAL    NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    rebuilt_at   INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_topic_domain ON topic(domain_id)`,

  // ── 原子：唯一真相源 ─────────────────────────────────────
  `CREATE TABLE atom (
    id            INTEGER PRIMARY KEY,
    kind          TEXT    NOT NULL,
    text          TEXT    NOT NULL,
    summary       TEXT    NOT NULL,
    embedding     BLOB    NOT NULL,
    topic_id      INTEGER REFERENCES topic(id) ON DELETE SET NULL,
    fit           REAL    NOT NULL DEFAULT 0,
    scope         TEXT    NOT NULL DEFAULT 'global',
    project_key   TEXT,
    source        TEXT,
    source_ref    TEXT,
    polarity      INTEGER,
    flags         INTEGER NOT NULL DEFAULT 0,
    superseded_by INTEGER REFERENCES atom(id) ON DELETE SET NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_atom_topic   ON atom(topic_id)`,
  `CREATE INDEX idx_atom_created ON atom(created_at DESC)`,
  `CREATE INDEX idx_atom_scope   ON atom(scope, project_key)`,
  `CREATE INDEX idx_atom_flags   ON atom(flags) WHERE flags <> 0`,

  // ── 主属/次属：主属唯一，次属多元 ─────────────────────────
  `CREATE TABLE atom_topic (
    atom_id  INTEGER NOT NULL REFERENCES atom(id)  ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
    weight   REAL    NOT NULL,
    origin   TEXT    NOT NULL,
    PRIMARY KEY (atom_id, topic_id)
  ) WITHOUT ROWID`,
  `CREATE INDEX idx_atom_topic_topic ON atom_topic(topic_id)`,

  // ── 边：declared 是真相源，其余可重算 ─────────────────────
  `CREATE TABLE edge (
    id         INTEGER PRIMARY KEY,
    src_type   TEXT NOT NULL,
    src_id     INTEGER NOT NULL,
    dst_type   TEXT NOT NULL,
    dst_id     INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    origin     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(src_type, src_id, dst_type, dst_id, kind)
  )`,
  `CREATE INDEX idx_edge_src ON edge(src_type, src_id, kind)`,
  `CREATE INDEX idx_edge_dst ON edge(dst_type, dst_id, kind)`,

  // ── 入口：declared/learned 是真相源，extracted 可重算 ─────
  `CREATE TABLE entry (
    id         INTEGER PRIMARY KEY,
    atom_id    INTEGER NOT NULL REFERENCES atom(id) ON DELETE CASCADE,
    term       TEXT    NOT NULL,
    bigram     TEXT    NOT NULL DEFAULT '',
    weight     REAL    NOT NULL,
    origin     TEXT    NOT NULL,
    hits       INTEGER NOT NULL DEFAULT 0,
    last_seen  INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(atom_id, term, origin)
  )`,
  `CREATE INDEX idx_entry_term ON entry(term)`,
  `CREATE INDEX idx_entry_atom ON entry(atom_id)`,
  // Entry 层 bigram 索引：兜底 trigram 对 ≤2 字中文查询失效
  `CREATE VIRTUAL TABLE entry_fts USING fts5(bigram, content='entry', content_rowid='id', tokenize='unicode61')`,
  `CREATE TRIGGER trg_entry_ai AFTER INSERT ON entry BEGIN
    INSERT INTO entry_fts(rowid, bigram) VALUES (new.id, new.bigram);
  END`,
  `CREATE TRIGGER trg_entry_ad AFTER DELETE ON entry BEGIN
    INSERT INTO entry_fts(entry_fts, rowid, bigram) VALUES ('delete', old.id, old.bigram);
  END`,
  `CREATE TRIGGER trg_entry_au AFTER UPDATE ON entry BEGIN
    INSERT INTO entry_fts(entry_fts, rowid, bigram) VALUES ('delete', old.id, old.bigram);
    INSERT INTO entry_fts(rowid, bigram) VALUES (new.id, new.bigram);
  END`,

  // ── 高相似原子对：派生，重算时全量重建 ────────────────────
  `CREATE TABLE atom_pair (
    a_id    INTEGER NOT NULL,
    b_id    INTEGER NOT NULL,
    cos     REAL NOT NULL,
    lexical REAL NOT NULL,
    PRIMARY KEY (a_id, b_id)
  ) WITHOUT ROWID`,

  // ── 检索侧物化表 + FTS5（trigram）────────────────────────
  `CREATE TABLE atom_search (
    id   INTEGER PRIMARY KEY,
    body TEXT NOT NULL
  )`,
  `CREATE VIRTUAL TABLE atom_fts USING fts5(body, content='atom_search', content_rowid='id', tokenize='trigram')`,
  `CREATE TRIGGER trg_search_ai AFTER INSERT ON atom_search BEGIN
    INSERT INTO atom_fts(rowid, body) VALUES (new.id, new.body);
  END`,
  `CREATE TRIGGER trg_search_ad AFTER DELETE ON atom_search BEGIN
    INSERT INTO atom_fts(atom_fts, rowid, body) VALUES ('delete', old.id, old.body);
  END`,
  `CREATE TRIGGER trg_search_au AFTER UPDATE ON atom_search BEGIN
    INSERT INTO atom_fts(atom_fts, rowid, body) VALUES ('delete', old.id, old.body);
    INSERT INTO atom_fts(rowid, body) VALUES (new.id, new.body);
  END`,
]

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
//   4. **墓碑与活着的记忆分表**：显式删除（§44）的凭证进 `forgotten`，不进 `atom`。
//      一句话：「活着的记忆」这条不变量不该靠每处查询都记得加过滤。
//   5. **状态各占一张单行表**：库自描述、整理进度、重标进度、拆分队列四件事各自成表，
//      理由见 SNAPSHOT_V5 的注释 —— 一句话：同一件事的几个字段必须一起变或一起不变。
//      库里因此只剩一张 key-value 表 `meta`，它由外部包 `lattice-calib` 的校准快照占用。

import type { ResourceParams } from '../util/memory.js'

/**
 * schema 版本；用 PRAGMA user_version 持久化。
 *
 * **0.9 起版本链只有一步**：MIGRATIONS 的第 0 步直接建出最新结构（SNAPSHOT_V5），
 * 不再重放 v1→v4 的历史增量。理由：0.9 是第一次公开发布，不存在外部持有的旧库；
 * 而保留历史链意味着 v1 的建表语句要永久冻结在代码里（改一处它就再也升不上来），
 * 新建库的路径也永远带着 35 条语句的历史包袱。
 *
 * **1.0 之后要重新累积增量**：一旦有外部库在外面，就不能再「只发布快照」——
 * 那时起每一次结构变更都要加一步 MIGRATIONS，并保证旧库能一路升上来。
 */
export const SCHEMA_VERSION = 5

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

/**
 * v5 快照：库的全部结构，一次建出。
 *
 * 顺序即依赖顺序（被引用的表在前），所以它能从空文件直接执行。
 * FTS5 的影子表（entry_fts_data / atom_fts_idx …）不写在这里 —— 建虚表时由 SQLite
 * 自动创建，显式再建一次会冲突。
 */
const SNAPSHOT_V5: readonly string[] = [
  // ── 域与主题：派生，可由 atom 重算 ─────────────────────────
  `CREATE TABLE domain (
    id          INTEGER PRIMARY KEY,
    label       TEXT    NOT NULL,
    centroid    BLOB    NOT NULL,
    topic_count INTEGER NOT NULL DEFAULT 0,
    built_at    INTEGER NOT NULL
  )`,
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

  // ── 记忆本体：真相源 ───────────────────────────────────────
  `CREATE TABLE atom (
    id               INTEGER PRIMARY KEY,
    kind             TEXT    NOT NULL,
    text             TEXT    NOT NULL,
    summary          TEXT    NOT NULL,
    embedding        BLOB    NOT NULL,
    topic_id         INTEGER REFERENCES topic(id) ON DELETE SET NULL,
    fit              REAL    NOT NULL DEFAULT 0,
    scope            TEXT    NOT NULL DEFAULT 'global',
    project_key      TEXT,
    source           TEXT,
    source_ref       TEXT,
    polarity         INTEGER,
    flags            INTEGER NOT NULL DEFAULT 0,
    superseded_by    INTEGER REFERENCES atom(id) ON DELETE SET NULL,
    origin           TEXT    NOT NULL DEFAULT 'model',
    recall_hits      INTEGER NOT NULL DEFAULT 0,
    last_recalled_at INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_atom_topic   ON atom(topic_id)`,
  `CREATE INDEX idx_atom_created ON atom(created_at DESC)`,
  `CREATE INDEX idx_atom_scope   ON atom(scope, project_key)`,
  `CREATE INDEX idx_atom_origin  ON atom(origin)`,
  `CREATE INDEX idx_atom_flags   ON atom(flags) WHERE flags <> 0`,
  `CREATE TABLE atom_topic (
    atom_id  INTEGER NOT NULL REFERENCES atom(id)  ON DELETE CASCADE,
    topic_id INTEGER NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
    weight   REAL    NOT NULL,
    origin   TEXT    NOT NULL,
    PRIMARY KEY (atom_id, topic_id)
  ) WITHOUT ROWID`,
  `CREATE INDEX idx_atom_topic_topic ON atom_topic(topic_id)`,

  // ── 边：declared 与 inferred 共用一张表，origin 区分 ──────
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

  // ── 入口：词面层，lemma 与 bigram 两套检索口径 ────────────
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
  // 两字词靠 bigram 兜底：trigram 分词器对长度 ≤2 的查询返回 0 命中。
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

  // ── 近邻对与正文索引：整份可重算 ──────────────────────────
  `CREATE TABLE atom_pair (
    a_id    INTEGER NOT NULL,
    b_id    INTEGER NOT NULL,
    cos     REAL NOT NULL,
    lexical REAL NOT NULL,
    PRIMARY KEY (a_id, b_id)
  ) WITHOUT ROWID`,
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

  // ── 显式删除的墓碑（§44）──
  `CREATE TABLE forgotten (
    id          INTEGER PRIMARY KEY,
    atom_id     INTEGER NOT NULL,
    fingerprint TEXT    NOT NULL,
    embedding   BLOB    NOT NULL,
    kind        TEXT    NOT NULL,
    scope       TEXT    NOT NULL DEFAULT 'global',
    project_key TEXT,
    origin      TEXT    NOT NULL DEFAULT 'model',
    summary     TEXT    NOT NULL DEFAULT '',
    deleted_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_forgotten_deleted ON forgotten(deleted_at DESC)`,
  `CREATE INDEX idx_forgotten_scope ON forgotten(scope, project_key)`,

  // ── 状态：四件事各一张单行/队列表（v5 新增，取代原来的 meta 键值表）──
  //
  // **为什么不是一张 key-value 表**：原来的 meta 把所有状态压成字符串键值对，
  // 于是「同一件事的几个字段」在库里没有共同边界 —— 整理的三态是三个键，写一个
  // 键失败时另外两个已经是新值；拆分清单是一整份 JSON，每次读写都要整份读改写。
  // 分成四张表之后，同一行的一次 UPDATE 要么全成功要么全失败，而清单类状态按行增删。
  //
  // **为什么每张状态表都有 id = 1 的 CHECK**：它们在语义上都是「一个实例」，
  // 有第二行就说明有代码写错了。约束写进表里，比在每个调用点记得加 WHERE 可靠。
  `CREATE TABLE build_info (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    entry_rule TEXT    NOT NULL,
    builder    TEXT    NOT NULL,
    built_at   INTEGER NOT NULL,
    source     TEXT
  )`,
  `CREATE TABLE recluster_state (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    planned_at   INTEGER,
    started_at   INTEGER,
    completed_at INTEGER
  )`,
  `CREATE TABLE calib_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    last_check_at INTEGER,
    last_error    TEXT
  )`,
  // 拆分队列：一行一条候选。
  //
  // `segments` 是「按长度切时切了几段」，`confirmed` 是「用户确认过应当拆分」。
  // 两者放同一行是因为它们描述同一条候选的两个阶段，而淘汰都按 `added_at` 的最早优先：
  // 分两张表就要维护两份上限，且「确认」这一步要跨表搬数据。
  //
  // **外键 ON DELETE CASCADE**：库里已经没有这条记忆时，它的队列行必须跟着消失。
  // 否则 `split_queue` 会留下指向不存在 id 的行，而那句提示会在别的地方被读到。
  `CREATE TABLE split_queue (
    atom_id   INTEGER PRIMARY KEY REFERENCES atom(id) ON DELETE CASCADE,
    segments  INTEGER,
    confirmed INTEGER NOT NULL DEFAULT 0,
    added_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_split_queue_confirmed ON split_queue(confirmed, added_at)`,

  // ── 校准快照：库里唯一一张 key-value 表，且不由本插件写 ──
  //
  // 占用者是外部包 `lattice-calib` 0.1.0 的 `recalibrateAndWrite()`：它在同一个事务里写
  // 5 个键（calib_params / calib_s_baseline / calib_version / calib_at /
  // calib_encoder_model），并在写之前要求这张表已经存在（包的约定是「只加键、不改库结构」）。
  //
  // **为什么它没跟着旧 meta 一起消失**：本插件自己的状态键已经搬进上面四张表，但这 5 个键
  // 的写入方在另一个包里，删表会让重标定在写快照那一步直接抛错。
  // 跨包契约不能由本仓库单方面改 —— 要让它也搬走，得先改 `lattice-calib` 的存储。
  // 在那之前，这张表只服务校准快照；本插件不再往里写任何状态。
  `CREATE TABLE meta (
    key        TEXT PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
]

/**
 * 记忆的所有权归属。默认 model —— 写入方不声明时，按「模型写的」记。
 *
 * 为什么默认不是 user：判错的代价不对称。模型把用户的话记成 model，最坏是漏标；反过来
 * 把模型的推断标成 user，用户会以为那是自己说过的 —— 而审计正是这个字段存在的理由。
 */
export type AtomOrigin = 'user' | 'model' | 'import'
export const ATOM_ORIGINS: readonly AtomOrigin[] = ['user', 'model', 'import']

/**
 * 记忆类型。与设计说明 §2.5「什么该进记忆库」的六类对齐。
 *
 * **为什么是这六类**：它们各自回答「下次做同类事时能省下什么」—— 一个坑省一次错误，
 * 一条命令省一次翻文档，一条环境事实省一次试探。类型不参与检索（检索靠向量与词面），
 * 它只决定写的人怎么归类、读的人怎么用。
 *
 * 「命令与参数」是一个整体，不拆两档：一条命令脱离参数没有可执行价值，而参数脱离
 * 命令不知道该填给谁。
 */
export type AtomKind = '结论' | '坑' | '命令与参数' | '环境' | '步骤' | '数据'
export const ATOM_KINDS: readonly AtomKind[] = ['结论', '坑', '命令与参数', '环境', '步骤', '数据']

/**
 * 历史别名：改名之前写进来的值。
 *
 * 库里已有存量，而旧行**不回溯**（与 flags 同一条纪律）。所以写入时归一到主名，
 * 查询时主名与别名一起匹配 —— 否则一次改名会让旧条目从过滤结果里消失。
 */
export const ATOM_KIND_ALIASES: Readonly<Record<string, AtomKind>> = { 参数: '命令与参数' }

/**
 * 收敛写入方给的 kind：认识的原样返回（别名归一到主名），不认识的回落到 fallback。
 *
 * 为什么回落而不是抛错：类型是**供人读的标签**，不是约束。为一个标签拒收整条记忆，
 * 代价明显更大 —— 但回落必须可见（回执里说明），否则统计口径会悄悄漂移。
 */
export function normalizeAtomKind(v: unknown, fallback: AtomKind = '结论'): AtomKind {
  const s = String(v ?? '').trim()
  if ((ATOM_KINDS as readonly string[]).includes(s)) return s as AtomKind
  return ATOM_KIND_ALIASES[s] ?? fallback
}

/**
 * 查询 `kind` 时要一起匹配的库内值：主名 + 映射到它的历史别名。
 *
 * 不认识的值**原样返回**（而不是回落到结论）：查一个不存在的类型应该得到空结果，
 * 而不是「悄悄返回结论类条目」——后者会让调用方以为库里真有这一类。
 */
export function atomKindFilterValues(kind: string): string[] {
  const s = String(kind ?? '').trim()
  if (s === '') return []
  const main = ATOM_KIND_ALIASES[s] ?? s
  const old = Object.keys(ATOM_KIND_ALIASES).filter((k) => ATOM_KIND_ALIASES[k] === main)
  return [main, ...old]
}

/** 收敛写入方给的 origin：不认识的值退回 fallback，不让脏值进库。 */
export function normalizeOrigin(v: unknown, fallback: AtomOrigin = 'model'): AtomOrigin {
  const s = String(v ?? '')
  return (ATOM_ORIGINS as readonly string[]).includes(s) ? (s as AtomOrigin) : fallback
}

/**
 * 迁移步骤表：MIGRATIONS[i] 把库从版本 i 升到版本 i+1。
 *
 * 0.9 起只有第 0 步（快照）。第 1.0 版起，这一数组只允许**追加**，不允许修改或删除
 * 已有的步骤 —— 外面的库要靠它一路升上来。
 */
export const MIGRATIONS: readonly (readonly string[])[] = [SNAPSHOT_V5]

/** 全部 DDL 的扁平视图，供建库校验比对 schema 对象是否齐全。 */
export const DDL: readonly string[] = MIGRATIONS.flat()

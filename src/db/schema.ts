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
//      理由见 DDL_V4 —— 一句话：「活着的记忆」这条不变量不该靠每处查询都记得加过滤。

import type { ResourceParams } from '../util/memory.js'

/**
 * schema 版本；用 PRAGMA user_version 持久化。
 *
 * 结构变更必须 +1，并在 MIGRATIONS 末尾追加「把上一版升到这一版」的语句。
 * **历史步骤不可修改、不可删除**——已经发出去的库要靠它一路升上来。
 */
export const SCHEMA_VERSION = 4

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
 * v1 建库语句，按依赖顺序排列。
 *
 * 之所以保留成独立的一份而不直接改这个数组：新建的库要从 v0 一路走到最新版，
 * 而已经存在的 v1 库只需要跑增量。两件事共用一份语句会互相牵制。
 */
const DDL_V1: readonly string[] = [
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

/**
 * v2 新增：库自描述元数据。
 *
 * 为什么要有这张表：标准验证库必须能自己说清「我是用哪套规则生成的」。
 * 入口抽取规则一改，旧库与新代码产出的库就不是同一套规则，跨规则比较会得出错误结论；
 * 而库文件会被复制、移动、归档，随附一份说明文件最先丢。放进库里最可靠。
 */
const DDL_V2: readonly string[] = [
  `CREATE TABLE meta (
    key        TEXT PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
]

/**
 * 迁移步骤表：MIGRATIONS[i] 把库从版本 i 升到版本 i+1。
 *
 * 顺序即语义，不得重排 —— 旧库缺哪几步就跑哪几步（见 open.ts 的 migrate）。
 */
/**
 * v3 新增：所有权与生命周期状态。
 *
 * `origin` 记「这条记忆是谁写的」，是**所有权维度**：用户说的、模型推断的、从别处导入的，
 * 在「该不该信、该不该删」上不是一回事。原 schema 里只有 entry 与 atom_topic 有 origin，
 * 那说的是「入口 / 归属是怎么来的」，atom 自己没有。
 *
 * 迁移时按 source 推断已有行：v1/v2 期间只有导入路径会带 source，运行时写入不带。
 * 追溯不到的一律留在默认值 model —— 猜错所有权比留空更糟。
 */
const DDL_V3: readonly string[] = [
  `ALTER TABLE atom ADD COLUMN origin TEXT NOT NULL DEFAULT 'model'`,
  `UPDATE atom SET origin = 'import' WHERE source IS NOT NULL`,
  `ALTER TABLE atom ADD COLUMN recall_hits INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE atom ADD COLUMN last_recalled_at INTEGER`,
  `CREATE INDEX idx_atom_origin ON atom(origin)`,
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
 * 记忆类型。与开发笔记 §2.5「什么该进记忆库」的六类对齐。
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
 * v4 新增：显式删除的墓碑（§44）。
 *
 * **为什么单独一张表、不给 atom 加 deleted_at 列**：`atom` 每一行的语义是「一条活着的
 * 记忆」。把墓碑混进去会污染**所有**对它的查询 —— 召回、目录、计数、健康指标 —— 而
 * 「每处都要记得加过滤」正是本项目反复吃亏的形态。单独成表之后，「活着的记忆」这条
 * 不变量继续由 `atom` 自己保证，一条 SQL 就能看出它成立。
 *
 * **墓碑是凭证，不是被隐藏的数据**：删完那条 atom 就真的不在了。这张表只记「它曾经
 * 存在过」，用来在做不到「删了就再不出现」的地方把写回拦下来 —— 真删之后，写回本身
 * 就不可检测了。
 *
 * **`embedding` 为什么也要留下来**：这条判据是「词面 + 余弦」两票，而余弦要拿被删那条的
 *   - 与落位判据同粒度（§3/§20 的「是不是一件事」用的就是 bigram 集合 + Jaccard），
 *     所以它不是一个新判据；
 *   - 存文本而不是存哈希，是为了让一条 `SELECT fingerprint FROM forgotten` 就能看出
 *     「拦的是哪几句话」—— 调试一个只在删除后才出现的判据，可读性比几十字节重要。
 *     代价是每行比哈希大一个数量级，而它与「用户删除过的条数」同阶，远小于库本身。
 */
const DDL_V4: readonly string[] = [
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
]

export const MIGRATIONS: readonly (readonly string[])[] = [DDL_V1, DDL_V2, DDL_V3, DDL_V4]

/** 全部 DDL 的扁平视图，供建库校验比对 schema 对象是否齐全。 */
export const DDL: readonly string[] = MIGRATIONS.flat()

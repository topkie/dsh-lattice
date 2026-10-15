# Changelog

本文件记录本项目的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **[设计原则](docs/PRINCIPLES.md)**：根本约束——职责边界（模型管内容、插件管形式）、
  四条行为边界、数据边界与刻意放弃项。与之冲突的改动一律不做
- 写入管线：两票落位（向量余弦 + 词面重叠）、主题增量维护、入口三级权重
  （declared / extracted / learned）
- 召回管线：四路融合（向量 / 入口 / 正文 / 图）+ 归属加权，三段式注入组装
  （锚 / 入口 / 路）与按顺序降级的裁剪
- 宿主工具：`lattice_ping` / `lattice_write` / `lattice_recall` / `lattice_expand` / `lattice_list`
- `lattice_list`：列目录（id / 类型 / 摘要 / 所有权 / scope / 主题 / 取回次数），分页并可按
  条件过滤 —— 补上「库里有什么」这个此前无法被回答的问题
- 迁移与评测脚本：现有卡片迁移、等 token 召回对比、多组真实模型验证
- 存储层：单库 SQLite schema，含 atom / topic / entry / edge 等表与两层检索索引
  （正文 trigram + 入口 bigram）
- 文本工具：CJK bigram 切词、码点安全的摘要抽取、Markdown 清洗、词面 Jaccard
- 向量工具：float32 BLOB 编解码、点积 / 范数 / 归一化 / 余弦
- 插件骨架：可被宿主加载的插件契约与健康检查工具
- 状态信号：`atom.origin`（用户 / 模型 / 导入）、`superseded_by` 的写入与展示、召回命中计数。
  锚段行按需带状态标记；`lattice_write` 用 `origin` 与 `supersedes` 表达所有权与取代关系

### Changed

- 存储层：schema 改为**版本化迁移**（`MIGRATIONS` 按版本递进），新增 `meta` 表承载库自描述
- schema v3：`atom` 增加 `origin` / `recall_hits` / `last_recalled_at`。迁移按 `source` 推断
  已有行的所有权归属（导入路径带 source，运行时写入不带），追溯不到的一律留在默认值
- 标准验证库：基准库现在自带「我是用哪套规则生成的」，生成方式固定为
  `scripts/build-baseline.mjs`；入口规则的改动必须同步 `ENTRY_RULE_ID`
- 新增 `scripts/verify-recall-baseline.mjs`：基准库上的召回回归，入口规则改动后必跑
- 注入按**匹配质量分档**（完整 / 精简 / 摘录）：无关查询的注入字符从约 4968 降到 995~1056，
  而 gold 的 Recall@12 保持 95.0%。低相关提示线由 0.68 改为 0.45 —— 原值实测永不触发

### Fixed

- 迁移只会「一次建全部表」：库已是 v1 时重跑建表语句会因表已存在而失败，升级路径实际不存在。
  改为按版本递进，只跑缺的那几步
- 入口词混入数字与符号片段（`u4e00` / `0x1c` / `9_` / `v1` / `0335` 等）：它们因「绝无仅有」
  被 IDF 排到高位，挤占每主题只展示 8 条的窗口。改为候选资格判据「必须是纯字母或汉字」。
  实测展示窗口噪声 250/2223 (11.2%) → 0，Recall@12 与 @24 均保持 95.0%
- 入口抽取**退化成了字典序**：词表统计取自 entry 表（数的是「已经被选为入口的词」），
  df 被压成 0~5 六个取值，75.99% 的 atom 十六个权重完全并列 —— 排序由字典序兜底，
  实际选出的是「候选里码点最小的 16 个」，高频真词被系统性挤掉。改为从 atom 正文统计，
  并列时按语料频次兜底。实测 Recall@12 90.0% → 95.0%
- 整段中文混入入口：切词把「连续汉字」整段当成一个词，于是「全程没有建分支」「为什么
  会这样」这类原文切片也成了候选 —— 它们不会被任何查询命中，却占着每 atom 只有十几个的
  槽位。限制到四字以内后，展示窗口里超过四字的片段由 405 条降为 0

### Removed

- 两个与本机环境耦合的脚本（桌面端迁移与对照评测）移出仓库——它们依赖特定来源系统的
  只读接口与数据格式，外部用户无法使用。导入能力改为「由模型判决、脚本按来源临时编写」，
  设计约束见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 的「导入既有记忆」

[Unreleased]: https://github.com/topkie/dsh-lattice/releases

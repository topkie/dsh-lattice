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
- 宿主工具：`lattice_ping` / `lattice_write` / `lattice_recall` / `lattice_expand`
- 迁移与评测脚本：现有卡片迁移、等 token 召回对比、多组真实模型验证
- 存储层：单库 SQLite schema，含 atom / topic / entry / edge 等表与两层检索索引
  （正文 trigram + 入口 bigram）
- 文本工具：CJK bigram 切词、码点安全的摘要抽取、Markdown 清洗、词面 Jaccard
- 向量工具：float32 BLOB 编解码、点积 / 范数 / 归一化 / 余弦
- 插件骨架：可被宿主加载的插件契约与健康检查工具

### Fixed

- 入口词混入数字与符号片段（`u4e00` / `0x1c` / `9_` / `v1` / `0335` 等）：它们因「绝无仅有」
  被 IDF 排到高位，挤占每主题只展示 8 条的窗口。改为候选资格判据「必须是纯字母或汉字」。
  实测展示窗口噪声 250/2223 (11.2%) → 0，Recall@12 与 @24 均保持 95.0%

[Unreleased]: https://github.com/topkie/dsh-lattice/releases

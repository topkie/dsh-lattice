# Changelog

本文件记录本项目的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 存储层：单库 SQLite schema，含 atom / topic / entry / edge 等表与两层检索索引
  （正文 trigram + 入口 bigram）
- 文本工具：CJK bigram 切词、码点安全的摘要抽取、Markdown 清洗、词面 Jaccard
- 向量工具：float32 BLOB 编解码、点积 / 范数 / 归一化 / 余弦
- 插件骨架：可被宿主加载的插件契约与健康检查工具

[Unreleased]: https://github.com/topkie/dsh-lattice/releases

# dsh-lattice

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地记忆插件：
> 把对话与工作中值得长期复用的知识，沉淀成**结构化、可检索、可重建**的本地记忆。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

> **状态：早期开发中。** 存储层、文本与向量工具层已完成并有测试覆盖；
> 编码层、写入与召回管线尚在实现。接口可能变动。

## 它解决什么

把笔记按「一张卡一个主题」手工整理，规模一上来就会遇到两难：

- **想省上下文**，就得让每张卡片彼此独立、不重复——但独立了之后，
  换一种问法就找不到它；
- **想找得到**，就得让同一件事有多个说法、多处出现——但那样又占上下文，
  而且相似却不一致的条目会让模型悄悄用错，且**不会报错**。

dsh-lattice 的做法不是在这两者之间折中，而是**把它们分开**：

| 原理 | 落在哪 | 作用 |
|---|---|---|
| **知识正交** | 记忆正文 | 一份知识只存一份 |
| **入口冗余** | 检索入口 | 同一个意思有多个说法可命中 |
| **链接显式** | 关联边 | 知识之间的关系写出来 |

三条原理被分配到不同的数据结构上，互不干扰；其中「入口不参与正交判定」让
增加入口永远不会污染记忆本身的质量。

## 特性

- **本地优先**：单文件 SQLite，数据全在本地，无云端依赖
- **中文友好**：针对中文查询的两层检索索引，短词也能命中
- **结构化**：记忆以「原子」为单位，主题由聚类派生，可随时重算
- **可重建**：除记忆本体外的一切都能从本体重算，备份与升级都很轻
- **可降级**：向量模型不可用时自动退回词面检索，功能缩水但不崩

## 安装

```bash
# 安装到宿主 profile（安装后需重启宿主）
cd <DSH_HOME>/profiles/<profile>
dsh plugin --profile <profile> add dsh-lattice
```

卸载：从该 profile 的 `package.json` 中移除依赖，并删除 `node_modules/dsh-lattice`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dataDir` | 空 | 数据目录；留空使用默认位置 |
| `encoderEnabled` | `true` | 关掉即为纯词面模式 |
| `encoderModel` | `BAAI/bge-small-zh-v1.5` | 向量模型 |
| `tauJoin` | `0.75` | 并入已有主题所需的余弦阈值 |
| `tauLex` | `0.12` | 并入所需的词面重叠阈值 |
| `tauNew` | `0.38` | 新建主题的余弦阈值 |
| `viewBudget` | `6000` | 单次注入的字符预算 |
| `topN` | `24` | 交注入层的候选数 |

> 落位判定需要**余弦与词面同时达标**：同一大类内部，不同主题的余弦可能高到 0.73，
> 而同一主题最低约 0.75，仅凭余弦会静默合并不同主题。

## 文档

| 文档 | 内容 |
|---|---|
| [架构](docs/ARCHITECTURE.md) | 记忆模型、存储布局、检索与写入流程 |
| [开发指南](docs/DEVELOPMENT.md) | 环境、命令、模块划分、关键约束 |
| [贡献指南](CONTRIBUTING.md) | 提交流程与代码约定 |
| [变更日志](CHANGELOG.md) | 版本历史 |

## 贡献

欢迎提交 Issue 与 Pull Request。动手前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
# dsh-lattice

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地记忆插件：
> 把对话与工作中值得长期复用的知识，沉淀成**结构化、可检索、可重建**的本地记忆。

它的定位可以概括成一句话：**一个本子和一支笔**。
不自动替你记、不猜你要什么；只保证写下的东西找得回、改得动、删得掉。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

> **状态：0.9.0，第一个对外发布版。** 存储、编码、写入、召回、注入组装、1 跳图扩展与六个工具都已实现，
> 门禁带 467 条测试；设置页能列出现有记忆、搜到指定一条、不借助模型把它删掉。
> 整理（重聚类）要手动触发，没有定时自动执行。其余已知限制见 [CHANGELOG](CHANGELOG.md) 的「已知限制」一节。

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
- **零第三方依赖**：运行时只依赖本项目自研的 `lattice-calib`（标定工具链，自身也不含第三方包）；
  向量模型是**可选**依赖，没装就退回词面检索
- **中文友好**：针对中文查询的两层检索索引，短词也能命中
- **结构化**：记忆以「原子」为单位，主题由聚类派生，可随时重算
- **可重建**：除记忆本体外的一切都能从本体重算，备份与升级都很轻
- **可降级**：向量模型不可用时自动退回词面检索，功能缩水但不崩
- **降级留痕**：降级事件写入独立的日志库（只记白名单内的字段，不含查询文本），
  设置页可导出 CSV 或清空；日志与记忆数据互不影响
- **看得见也在手里**：设置页里能直接看库里有什么、搜到某一条、**不借模型把它删掉**；
  每条会显示来源、被取回次数与是否已被取代
- **写入有把关**：过短或过长的内容会被拦下并说明怎么办，与已有内容重复的会被提示（只提示、不阻止）

## 安装

本插件还没有发布到 npm（它与运行时依赖 [`lattice-calib`](https://github.com/topkie/lattice-calib)
都不在 npm 上），所以现在只有从源码装这一条路。需要 Node 22 以上、git 与 pnpm ≥ 9（与 [开发指南](docs/DEVELOPMENT.md) 的要求一致）。

```bash
git clone https://github.com/topkie/dsh-lattice.git
git clone https://github.com/topkie/lattice-calib.git

# 两个都要构建：插件运行时 import 标定包
cd lattice-calib && pnpm install && pnpm run build && cd ..

cd dsh-lattice
# 标定包还没发到 npm，把刚构建的这份装成依赖（会写进本地的 package.json）
pnpm add ../lattice-calib
pnpm run build
```

构建完把下面两组文件放进宿主 profile 的 `node_modules`（两个目录平级），然后重启宿主：

| 目标目录 | 放什么 |
|---|---|
| `node_modules/dsh-lattice/` | `dist/`、`lib/`、`package.json`、`cordis.patch.yml` |
| `node_modules/lattice-calib/` | `dist/`、`package.json` |

profile 的位置因平台而异，通常在用户目录下 `.dsh/profiles/<profile 名>/`；不确定就找宿主配置里 `profiles/` 所在的那一层。
只复制 `dist/` 或只复制 `lib/` 会出现「后端是新版、设置页是旧版」，两样要一起复制。

装好后用一次写入与一次召回确认：让模型调 `lattice_write` 存一条，再调 `lattice_recall` 查它；
也可以直接调 `lattice_ping`：它返回插件版本、标定状态、数据目录、编码器配置（`off` 或模型名），以及五处缓存的实时占用 —— 编码器是否真的加载成功看 `caches.encoder.state`。

卸载：删掉 `node_modules/dsh-lattice/` 与 `node_modules/lattice-calib/`，重启宿主。
记忆数据在独立的数据目录里，不会被这一步删掉。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dataDir` | 空 | 数据目录；留空使用默认位置 |
| `encoderEnabled` | `true` | 关掉即为纯词面模式 |
| `encoderModel` | `Xenova/bge-small-zh-v1.5` | 向量模型 |
| `tauJoin` | `0.78` | 并入已有主题所需的余弦阈值（可调范围 0.6~0.95） |
| `tauLex` | `0.05` | 并入所需的词面重叠阈值（0.02~0.5） |
| `tauLexOnly` | `0.1` | 只靠词面就判同主题的阈值（0.02~0.6） |
| `tauNew` | `0.5` | 新建主题的余弦阈值（0.2~0.8） |
| `viewBudget` | `6000` | 单次注入的字符预算 |
| `topN` | `24` | 交注入层的候选数 |
| `samplesEnabled` | `true` | 校准样本的自动收集（负样本）；关掉后显式 `lattice_feedback` 仍可用 |

> 落位判定需要**余弦与词面同时达标**：同一大类内部，不同主题的余弦可能高到 0.73，
> 而同一主题最低约 0.75，仅凭余弦会静默合并不同主题。

## 文档

| 文档 | 内容 |
|---|---|
| [**设计原则**](docs/PRINCIPLES.md) | **根本约束：职责边界、行为边界、数据边界**。与之冲突的改动一律不做 |
| [宿主接入契约](docs/INTEGRATION.md) | 第一次接入先读：什么时候该查记忆、一条记忆怎么写、六个工具各管到哪、失败与降级时看到什么 |
| [架构](docs/ARCHITECTURE.md) | 记忆模型、存储布局、检索与写入流程 |
| [开发指南](docs/DEVELOPMENT.md) | 环境、命令、模块划分、关键约束 |
| [阈值登记](docs/THRESHOLDS.md) | 代码里那些数字为什么是这个值、什么条件该重标、这套检查查得出什么查不出什么 |
| [迁移规范](docs/MIGRATION.md) | 从其他记忆库迁入时的组织、流程、验收与回滚 |
| [贡献指南](CONTRIBUTING.md) | 提交流程与代码约定 |
| [变更日志](CHANGELOG.md) | 版本历史 |

## 贡献

欢迎提交 Issue 与 Pull Request。动手前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

# dsh-lattice

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地记忆插件：
> 把对话与工作中值得长期复用的知识，沉淀成**结构化、可检索、可重建**的本地记忆。

它的定位可以概括成一句话：**一个本子和一支笔**。
不自动替你记、不猜你要什么；只保证写下的东西找得回、改得动、删得掉。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org)

> **状态：首个对外发布版，尚未发布。** 存储、编码、写入、召回、注入组装、1 跳图扩展与五个工具都已实现，
> 门禁带 470 条测试；设置页能列出现有记忆、搜到指定一条、不借助模型把它删掉。
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
- **零第三方依赖**：运行时不 import 任何外部包（标定工具链 `lattice-calib` 已于 0.5.0 退役）；
  向量模型是**可选**依赖，没装就退回词面检索。源码装时它会连带几十个包一起装上，
  不需要向量就在安装时加 `--omit=optional`，插件其余部分不受影响
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

npm 上的 `dsh-lattice` 目前只是一个占位包：`npm view dsh-lattice` 能查到 `0.0.0`，包的 description 写明请勿安装。
所以可用版本只能从源码装。需要 Node 22.13 以上、git 与 pnpm ≥ 9
（与 [开发指南](docs/DEVELOPMENT.md) 的要求一致）。`node` 要在 `PATH` 里 —— 有几个依赖的
安装脚本会直接调用 `node` 命令，找不到就会装出缺原生二进制的半成品。

包管理器默认不跑依赖的构建脚本，这是第二个来源：npm 12 实测拦下 `onnxruntime-node`、`sharp`、
`protobufjs` 三个包的安装脚本，效果与上面相同 —— 装得上、写得进，但召回退回纯词面。
判据是 `lattice_ping` 的 `caches.encoder.state`，不是 `loaded` 就说明模型没起来。
本仓库的 `pnpm-workspace.yaml` 已按两个版本各自认识的字段名放行这四个包，用 pnpm 装不会遇到这一步。

模型权重不在 npm 包里：装依赖只装运行时（`@huggingface/transformers`），第一次加载编码器才去
`huggingface.co` 取 `Xenova/bge-small-zh-v1.5`，拿不到再试 `hf-mirror.com` —— 两条源按这个顺序试，
前一条成功就不再试后一条。国内网络实测官方源解析被污染（解析到 `31.13.95.17`），
`curl` 报 `(28) Failed to connect to huggingface.co port 443 after 21045 ms`，镜像实测 9.9 秒下完并加载。
两条都失败时编码器停在未加载状态、召回退回纯词面 —— 表现与上面两种一模一样，只看行为分不出来。
界面「配置」页会逐条列出试过哪个源、各花了多久、错在哪一句，所以先看那里。
配置项 `encoderMirror` 换掉第二条源；填成官方地址就只试官方一次。

```bash
git clone https://github.com/topkie/dsh-lattice.git
cd dsh-lattice
pnpm install --no-frozen-lockfile
pnpm run build
```

构建完把下面一组文件放进宿主 profile 的 `node_modules`，然后重启宿主：

| 目标目录 | 放什么 |
|---|---|
| `node_modules/dsh-lattice/` | `dist/`、`lib/`、`package.json`、`cordis.patch.yml` |

profile 的位置因平台而异，通常在用户目录下 `.dsh/profiles/<profile 名>/`；不确定就找宿主配置里 `profiles/` 所在的那一层。
只复制 `dist/` 或只复制 `lib/` 会出现「后端是新版、设置页是旧版」，两样要一起复制。

`cordis.patch.yml` 是 bundle 补丁层：`package.json` 的 `dsh.bundle.patch` 指向它，宿主据此在 profile 里
插入 id 为 `lattice` 的插件条目并给出默认配置（`enabled`、`encoderEnabled`）；profile 自己的
`cordis.patch.yml` 可以按这个 id 覆盖或禁用。漏复制它，profile 里的 `package.json` 就指向一个不存在的文件。

装好后用一次写入与一次召回确认：让模型调 `lattice_write` 存一条，再调 `lattice_recall` 查它；
也可以直接调 `lattice_ping`：它返回插件版本、数据目录、编码器配置（`off` 或模型名），以及五处缓存的实时占用 —— 编码器是否真的加载成功看 `caches.encoder.state`。

卸载：删掉 `node_modules/dsh-lattice/`，重启宿主。
记忆数据在独立的数据目录里，不会被这一步删掉。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dataDir` | 空（即 `<数据目录>/lattice`） | 数据目录；留空按 `DSH_HOME/lattice` 解析，未设置 `DSH_HOME` 时用 `~/.dsh/lattice` |
| `encoderEnabled` | `true` | 关掉即为纯词面模式 |
| `encoderModel` | `Xenova/bge-small-zh-v1.5` | 向量模型 |
| `encoderMirror` | 空 | 第二下载源。留空等于 `https://hf-mirror.com`；官方源总是先试一次，填成官方地址就只试官方 |
| `encoderCacheDir` | 空 | 模型缓存目录；留空用运行时默认位置 |
| `tauJoin` | `0.78` | 并入已有主题所需的余弦阈值（可调范围 0.6~0.95） |
| `tauLex` | `0.05` | 并入所需的词面重叠阈值（0.02~0.5） |
| `tauLexOnly` | `0.1` | 只靠词面就判同主题的阈值（0.02~0.6） |
| `tauNew` | `0.5` | 新建主题的余弦阈值（0.2~0.8） |
| `viewBudget` | `5000` | 单次注入的字符预算 |
| `topN` | `24` | 交注入层的候选数 |
| `mmapSize` | `0` | SQLite mmap 窗口字节数；0 = 按机器内存与库大小自动 |
| `cacheSize` | `0` | SQLite 页缓存字节数；0 = 自动 |
| `busyTimeout` | `0` | 写锁等待上限毫秒；0 = 自动 |

> 落位判定需要**余弦与词面同时达标**：同一大类内部，不同主题的余弦可能高到 0.73，
> 而同一主题最低约 0.75，仅凭余弦会静默合并不同主题。

## 文档

| 文档 | 内容 |
|---|---|
| [**设计原则**](docs/PRINCIPLES.md) | **根本约束：职责边界、行为边界、数据边界**。与之冲突的改动一律不做 |
| [宿主接入契约](docs/INTEGRATION.md) | 第一次接入先读：什么时候该查记忆、一条记忆怎么写、五个工具各管到哪、失败与降级时看到什么 |
| [架构](docs/ARCHITECTURE.md) | 记忆模型、存储布局、检索与写入流程 |
| [为什么这么定](docs/DESIGN-RATIONALE.md) | 七处决策当时为什么这么定、否掉了什么、代价是什么 |
| [开发指南](docs/DEVELOPMENT.md) | 环境、命令、模块划分、关键约束 |
| [阈值登记](docs/THRESHOLDS.md) | 代码里那些数字为什么是这个值、什么条件该重标、这套检查查得出什么查不出什么 |
| [迁移规范](docs/MIGRATION.md) | 从其他记忆库迁入时的组织、流程、验收与回滚 |
| [贡献指南](CONTRIBUTING.md) | 提交流程与代码约定 |
| [变更日志](CHANGELOG.md) | 版本历史 |

## 贡献

欢迎提交 Issue 与 Pull Request。动手前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

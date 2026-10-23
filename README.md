# dsh-lattice

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地记忆插件：
> 把对话与工作中值得长期复用的知识，沉淀成**结构化、可检索、可重建**的本地记忆。

它的定位可以概括成一句话：**一个本子和一支笔**。
不自动替你记、不猜你要什么；只保证写下的东西找得回、改得动、删得掉。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org)

> **状态：首个对外发布版，尚未发布。** 存储、编码、写入、召回、注入组装、1 跳图扩展与五个工具都已实现；
> 设置页能列出库里的记忆、搜到指定一条、不借助模型把它删掉，也能改两项运行参数、把整库导出成
> JSON 或 Markdown。整理（重聚类）要手动触发，没有定时自动执行。
> 其余已知限制见 [CHANGELOG](CHANGELOG.md) 的「已知限制」一节。

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

三种装法，从最省事到最灵活。三种装完都要重启宿主；记忆存在本机数据目录里，换装法不会丢数据。

当前 npm 上的 `dsh-lattice` 还只是一个占位包（`npm view dsh-lattice` 能查到 `0.0.0`，
包的 description 写明请勿安装），GitHub 上的发布也还没开始 —— 前两种等正式版上线后可用，
现在能走的是第三种。

### 一、插件管理器（图形化，最省事）

在宿主的插件管理界面里搜索 `dsh-lattice`，点安装，重启宿主。依赖登记与插件清单由界面代做，
不需要手改文件。装完在设置的「lattice 记忆库」页看得到入口就说明装对了；看不到就把
`dsh-lattice` 加进 profile 目录 `package.json` 的 `dsh.profile.bundles` 数组再重启。

### 二、npm

在**宿主 profile 目录**（通常在用户目录下 `.dsh/profiles/<profile 名>/`）里装：

```bash
pnpm add dsh-lattice
```

再把 `dsh-lattice` 加进同一目录 `package.json` 里 `dsh.profile.bundles` 那个数组，重启宿主。
要固定版本就写 `pnpm add dsh-lattice@0.10.0`；之后升级用 `pnpm update dsh-lattice` 再重启。

### 三、GitHub 源码

想改代码、或者要用还没发到 npm 的提交时走这条。需要 Node 22.13 以上、git 与 pnpm ≥ 9。
`node` 要在 `PATH` 里 —— 有几个依赖的安装脚本会直接调用 `node` 命令，找不到就会装出
缺原生二进制的半成品。

```bash
git clone https://github.com/topkie/dsh-lattice.git
cd dsh-lattice
pnpm install --no-frozen-lockfile
pnpm run build
```

然后在 profile 目录把它登记为依赖，路径换成上一步那个目录的绝对路径：

```bash
pnpm add "file:<dsh-lattice 目录的绝对路径>"
```

再把 `dsh-lattice` 加进同一目录 `package.json` 里 `dsh.profile.bundles` 那个数组，重启宿主。
更新到新提交：源码目录 `git pull`、`pnpm install --no-frozen-lockfile`、`pnpm run build`，
再到 profile 目录重跑一次那条 `pnpm add`，重启。

### 第一次加载要下模型

模型权重不在包里：第一次加载编码器才去 `huggingface.co` 取 `Xenova/bge-small-zh-v1.5`
（约 23 MB），拿不到再试 `modelscope.cn`（魔搭），前一条成功就不再试后一条。两条都不通时
编码器停在未加载状态、召回退回纯词面 —— 只看行为分不出来是哪一步的问题。界面「配置」页
会逐条列出试过哪个源、各花了多久、错在哪一句，所以先看那里。配置项 `encoderMirror` 决定
第二条源；填成官方地址就只试官方一次。

### 装上了但召回只走词面

包管理器默认不跑依赖的构建脚本：npm 12 实测拦下 `onnxruntime-node`、`sharp`、`protobufjs`
三个包的安装脚本，效果是写得进、召回退回纯词面。判据是 `lattice_ping` 的
`caches.encoder.state`，不是 `loaded` 就说明编码器没起来。走第三种时在本仓库里 `pnpm install`
不会遇到这一步 —— `pnpm-workspace.yaml` 已放行这四个包；前两种装的是发布出来的包，
碰不碰得到取决于宿主或 npm 的设置。

### 确认装好了

让模型调 `lattice_write` 存一条，再调 `lattice_recall` 查它；也可以直接调 `lattice_ping`：
它返回插件版本、数据目录、编码器配置，以及五处缓存的实时占用。编码器是否真的加载成功，
看 `caches.encoder.state`。

日常在设置的「lattice 记忆库」页：能看库里有什么、搜到某一条、把它删掉，也能改两项运行参数、
把整库导出成 JSON 或 Markdown。写什么时候发生由模型决定，页面上不写。

### 卸载

按装法对应着来：插件管理器里卸载；命令行装的在 profile 目录 `pnpm remove dsh-lattice` 并把名字
从 `dsh.profile.bundles` 里删掉；第三种还可以顺手删掉 clone 下来的目录。都要重启宿主。
记忆数据在独立的数据目录里，这几步都不会删它。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dataDir` | 空（即 `<数据目录>/lattice`） | 数据目录；留空按 `DSH_HOME/lattice` 解析，未设置 `DSH_HOME` 时用 `~/.dsh/lattice` |
| `encoderEnabled` | `true` | 关掉即为纯词面模式 |
| `encoderModel` | `Xenova/bge-small-zh-v1.5` | 向量模型 |
| `encoderMirror` | 空 | 第二下载源。留空等于 `https://modelscope.cn`（魔搭）；官方源总是先试一次，填成官方地址就只试官方 |
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

其中 `viewBudget` 与 `topN` 能在设置页「lattice 记忆库 → 配置」里直接改，改完即时生效；
其余十三项要在 profile 的 `cordis.patch.yml` 里改，然后重启宿主 —— 它们要么在建连接时用掉，
要么被写进上下文快照，改了也不会立刻按新值走。

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
| [发布流程](docs/RELEASING.md) | 维护者用：切 CHANGELOG、打 tag、发 GitHub Release 与 npm |
| [变更日志](CHANGELOG.md) | 版本历史 |

## 贡献

欢迎提交 Issue 与 Pull Request。动手前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

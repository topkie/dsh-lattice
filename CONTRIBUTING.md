# 贡献指南

感谢你考虑为 dsh-lattice 做出贡献。

## 开始之前

- **先读 [docs/PRINCIPLES.md](docs/PRINCIPLES.md)**——它是根本约束，与之冲突的改动会被直接拒绝
- 较大的改动请先开 Issue 讨论，避免做完才发现方向不一致
- 改动走任务分支，提交前确保**门禁**全绿（跑法见下方「分支与合并」）

## 修改 `AGENTS.md` 的规则

仓库根目录有一个 `AGENTS.md`，写着 AI 编码助手（agent）在本仓库工作时的约定
（建分支、门禁命令、脱敏范围等）。**不使用这类工具的话，跳过本节即可。**

它对**所有**在本仓库工作的人生效，所以**改动它比改代码更重**：

- **单独一条提交**，不与代码改动混在一起 —— 否则「为什么加这条约束」会被埋在无关的 diff 里；
- 提交正文写清**为什么**、以及**会影响谁的工作方式**；
- 加一条之前先问：被违反时是「做错了」，还是「做法不同」？**只收前者** ——
  后者属于个人工作方式，不适合作为仓库级的约定。

## 开发环境

见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

### 装进宿主看效果

改完代码要在宿主里看到效果，除了构建还要把产物送进 profile。两条路各有用处。

**按包管理器装（与用户的装法一致）**：在 profile 目录把本仓库登记为依赖，
`pnpm add "file:<本仓库绝对路径>"`，再把 `dsh-lattice` 加进该目录 `package.json` 的
`dsh.profile.bundles` 数组。pnpm 按本仓库 `package.json` 的 `files` 白名单复制 `dist/`、`lib/`、
`cordis.patch.yml`、`package.json` 与几份文档，源码目录里改的东西不会自动跟过来 ——
每次改完要重跑一次那条 `pnpm add`。

**手工覆盖（只在排障时用）**：直接把 `dist/`、`lib/`、`package.json`、`cordis.patch.yml`
复制进 `<profile>/node_modules/dsh-lattice/`。只复制 `dist/` 或只复制 `lib/` 会出现「后端是新版、
设置页是旧版」，两样要一起复制。这样做的代价是：profile 里下次跑 `pnpm install` 会把它恢复成
包管理器那一份，手工改动随之丢失。

`cordis.patch.yml` 是本仓库的 bundle 补丁层：`package.json` 的 `dsh.bundle.patch` 指向它，
宿主据此在 profile 里插入 id 为 `lattice` 的插件条目并给出默认配置（`enabled`、`encoderEnabled`）；
profile 自己的 `cordis.patch.yml` 可以按这个 id 覆盖或禁用（后层优先）。漏了它，宿主那边就指向
一个不存在的文件。

产物换完之后重启宿主。界面半 `lib/client.js` 不参与 `tsc`，改它不用构建，但同样要重启或刷新页面。

## 分支与合并

main 永远可发布。**不要在 main 上直接提交**，所有改动走任务分支。

**签出前先回到 `main`**：`git checkout main && git checkout -b feat/<slug>`。
`checkout -b` 是从**当前**位置建分支 —— 停在别的任务分支上时，新分支会带着它的提交，
合并时把不相干的改动一起带进来。

分支类型与命名：

| 分支 | 用途 | 命名 |
|---|---|---|
| `feat/<slug>` | 新功能 | `feat/view-assembly` |
| `fix/<slug>` | 缺陷修复 | `fix/recall-empty-result` |
| `docs/<slug>` | 仅文档 | `docs/constant-table` |

在分支上可以自由提交（允许中间态与试错提交）。合并前把分支压成一条干净提交：

```bash
git checkout main
git merge --squash feat/<slug>
git commit -m "feat: <摘要>"
```

### 合并门禁（顺序不能反）

1. **门禁全绿** —— 构建、类型检查、代码检查、格式检查、阈值登记、阈值来历评审、三条来历查询、文档一致性、日志边界、候选召回率、单元测试，共 11 项，一条命令跑完（跑法见下）；
2. 涉及编码或召回的改动，再手动跑一次 `scripts/verify-*.mjs`（真实模型，需联网，因此不进 CI）；
3. 两项都过了才合并。

门禁会把当前分支名打在第一行，在 `main` 上跑时会多一句提醒 —— 它本应在任务分支上跑。
分支名通过环境变量传入，这样脚本自己不需要调 git（受限环境下子进程可能起不来）：

```bash
# bash / Git Bash
GIT_BRANCH=$(git branch --show-current) node scripts/check-all.mjs
```

```powershell
# PowerShell
$env:GIT_BRANCH = (git branch --show-current); node scripts/check-all.mjs
```

**不传这个变量时，它显示「分支：未知」—— 那不叫通过，是提醒根本没生效。**

**只提示不阻断**：合并后回 main 复验是合法操作，强行失败只会让人绕过这个脚本。

CI 对**所有分支**的 push 都会跑整条门禁 —— 与本地同一条命令 `node scripts/check-all.mjs`，
不是另抄一份步骤清单（抄一次就会漏一项，2026-10-21 的审核正是这样发现 CI 少跑 5 项）。

新增或改动阈值时，登记项要写清来历（`recheckable` / `chosen`）—— 写法与三个查询见
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 的「阈值登记」一节。没有来历的新条目会让门禁红；
已有的待评审项按类写在 [CHANGELOG.md](CHANGELOG.md) 的「已知限制」里，每类带一条自查命令。

### 门禁 11 项，各自的失败条件

一条命令跑完 11 项，但排查时要知道是哪一项、怎么单独跑、什么样的改动会让它红。
下表 2026-10-22 逐项实测过一次：11 项都以非零码退出，跑完都还原了原文件。

| 步骤 | 单独跑 | 守什么 | 让它变红 |
|---|---|---|---|
| `build` | `node node_modules/typescript/bin/tsc -p tsconfig.json` | 编译到 `dist/`。测试与 verify 脚本 import 的是 `dist/`，跳过它会在旧产物上变绿 | 在 `src/` 任一文件写一行 `const broken: number = 'a'` |
| `typecheck` | `node node_modules/typescript/bin/tsc --noEmit` | 类型错误，不产出 `dist/` | 同上 |
| `lint` | `node node_modules/eslint/bin/eslint.js .` | eslint 对全仓（源码、测试、脚本、界面代码） | 在 `src/` 加一个没用到的局部变量 |
| `format` | `node node_modules/prettier/bin/prettier.cjs --check 'src/**/*.ts' 'test/**/*.mjs' 'scripts/**/*.mjs' 'lib/**/*.js' '.github/**/*.yml'` | 源码、测试、脚本、界面代码、CI 配置五组文件的格式 | 写一行 `const a=1;export default a`（不换行、等号两侧无空格） |
| `thresholds` | `node scripts/print-thresholds.mjs` | `src/` 里每个数值常量都登记了来历，或在豁免清单里 | 加一行模块级 `PROBE_MAGIC = 42` |
| `thresholds-review` | `node scripts/print-thresholds.mjs --check-review` | 把当前待评审条数报出来（基线文件已删除，存量比对只在文件被重建时执行） | 重建 `thresholds-review-baseline.json` 并往 `unguarded` 加一个库里没有的键 |
| `thresholds-query` | `node scripts/print-thresholds.mjs --undated` | 三条来历查询的命令行分派真的能跑到 | 让脚本在分派处抛错（0.4.1 上的真实形态是 `ReferenceError`，而门禁只跑 `--check-review`，绕开了它） |
| `docs` | `node scripts/check-docs.mjs` | 文档里提到的仓库内路径与表名能在仓库里找到 | 在 `docs/` 里写一个不存在的路径 |
| `log-boundary` | `node scripts/check-log-boundary.mjs` | 除 `src/log/` 外没有别处写日志 | 在 `src/` 任一文件写一行 `INSERT INTO log` |
| `candidate-recall` | `node scripts/check-candidate-recall.mjs` | 目标在余弦上排到十几名时仍能进候选池 | 把 `scripts/check-candidate-recall.mjs` 里的 `WANT = 20` 改成 5 |
| `test` | `node --import ./test/stubs/register.mjs test/run.mjs` | 单元测试，编码器用替身 | 在任一测试文件末尾加一句 `assert.equal(1, 2)` |

`--import` 那一段不能漏：漏了编码器会真加载，降级路径的用例在联网机器上全部变红。

## 提 PR

1. **fork 本仓库**，在自己名下克隆。
2. **从 `main` 开分支**（见上一节），改完推到自己 fork 的这个分支上。
3. **对 `topkie/dsh-lattice` 的 `main` 开 PR**。标题用约定式提交的格式（`fix: …` / `feat: …`），
   合并时它会被当作用户看到的提交信息；描述按仓库自带的 PR 模板填，其中「怎么验证的」一栏要贴
   命令与输出。
4. **等 CI**。所有分支的 push、所有 PR 都会跑同一条门禁（`node scripts/check-all.mjs`），与你在
   本地跑的是同一条命令，不是另抄的一份清单。红了就地修，不要另开一个 PR，也不要在评论里说明
   「这项不影响」—— 门禁里的每一项都对应一种真实故障，上一节的表里写了让它变红的最小改法。
5. **不要自己合并**。合并由维护者做，用 squash（GitHub 的 Squash and merge），PR 里有多少条
   试错提交都会被压成一条。

三件容易踩的事：

- **改了依赖**：`pnpm-lock.yaml` 必须一起提交。CI 用 `--frozen-lockfile`，不同步时直接报
  `ERR_PNPM_OUTDATED_LOCKFILE`；本地默认不加这个开关，所以这个错只会在 CI 上出现。
- **改了 `AGENTS.md`**：单独一条提交（见本文第二节「修改 AGENTS.md 的规则」）。
- **大改动**：先开 Issue 谈方向，不要写两周再提。判据是「会不会改到对外接口」—— 工具的入参与
  返回、库结构、配置项语义，这三类都算。

## 提交信息

采用约定式提交（Conventional Commits），首行格式：

```
<类型>: <简短描述>
```

| 类型 | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 仅文档变更 |
| `refactor` | 不改变行为的重构 |
| `test` | 测试相关 |
| `chore` | 构建、依赖、工具链 |

正文可分段补充**为什么**这样改；涉及取舍时请写明被放弃的方案。

## 代码约定

- TypeScript 严格模式，不使用 `any` 逃逸类型检查（确有必要时需注释说明）
- 模块依赖方向：`tools → pipeline → {db, encoder} → util`，**不允许反向依赖**
- 新增公共函数需带注释说明**为什么**，而不只是复述函数名
- 涉及性能敏感路径的改动，请在 PR 描述里附上测量方式与结果
- **事务里不要让出事件循环**：SQLite 的事务跟连接走，不是跟代码块走。事务开着时 `await`，
  事件循环会去执行别的任务，而那个任务的写入用的是同一条连接、会被卷进这个尚未提交的事务
  —— 跟着一起提交，或一起回滚，而且不报错。本插件只有一条主库连接，所以这条适用于任何
  开事务的代码。要让出就把重计算挪到事务外：重聚类就是这么做的（1374 条的库，全程 1280 毫秒，
  事务只占 26 毫秒）。进度回调请保持同步返回 `void`，不要返回 Promise。
- **动了日志事件，就同步白名单**：改 `src/log/` 里的事件或字段，必须同时更新
  `src/log/policy.ts` 的白名单，否则门禁的 `log-boundary` 步骤会红。写步骤名而不是编号 ——
  门禁加步骤时编号会变。

## 测试

- 纯函数逻辑 → 单元测试
- 涉及数据库 → 用内存库或临时文件，测完删除
- 修复缺陷时请补一个能复现该缺陷的用例

## 发布

打 tag、发 GitHub Release 与 npm 是维护者的动作，步骤在 [docs/RELEASING.md](docs/RELEASING.md)。
贡献者不需要读；想知道自己那条改动什么时候会到用户手里，那里也写了版本号怎么定。

## 许可证

贡献即表示你同意以本项目的 [MIT 许可证](LICENSE) 发布你的贡献。

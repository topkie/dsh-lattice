# 发布流程

写给维护者。贡献者提 PR 看 [CONTRIBUTING.md](../CONTRIBUTING.md)，不需要读本文。

## 口径

| 项 | 定法 |
|---|---|
| 发到哪 | 两处都发：GitHub Release 与 npm，版本号相同 |
| tag 谁打 | **维护者**。不由 CI 打，也不由贡献者打 |
| 每个版本是什么 | 一批能单独验收的改动。做完打一个 tag，不跳号 |
| 版本号 | 语义化版本。破坏性改动进 major，新增进 minor，修复进 patch |
| 0.x 期间的例外 | 破坏性改动可以进 minor，但 CHANGELOG 该段要写 `### Breaking` |

版本号只有一个来源：`package.json` 的 `version`。插件的 `VERSION` 常量运行时从它读
（`src/index.ts` 里那三行），`lattice_ping` 报的就是它。所以改版本号只改一处，不要在两处各写一遍。

## 一、准备

1. **切 CHANGELOG**。把 `[Unreleased]` 改成 `## [x.y.z] - YYYY-MM-DD`，并在文件顶部重开一个空的
   `## [Unreleased]`。该段按 `Added` / `Changed` / `Fixed` / `Breaking` 分类，每条写清后果而不只是
   动作（「删了 `meta` 表」要跟一句「重新标定前得先加回表」）。
2. **同步版本号**。`package.json` 的 `version` 改成同一个号。
3. **先看包里会有什么**：

   ```
   npm pack --dry-run
   ```

   `package.json` 的 `files` 白名单决定内容，当前是 `dist`、`lib`、`cordis.patch.yml`、`README.md`、
   `CHANGELOG.md`、`LICENSE` 六项。`dist` 不在版本控制里，所以打包前必须先构建过。

4. **门禁全绿**，把最后一行贴进 PR 或提交正文：

   ```bash
   GIT_BRANCH=$(git branch --show-current) node scripts/check-all.mjs
   ```

5. **干净副本装一遍**。涉及依赖、构建或 `files` 白名单的改动必须做，其余可选：

   ```bash
   git worktree add ../clean --detach HEAD
   cd ../clean && pnpm install --frozen-lockfile && pnpm run build
   ```

   `--frozen-lockfile` 与 CI 用的是同一个开关。它红了说明 `pnpm-lock.yaml` 与 `package.json`
   不同步，本地能装而 CI 装不上就是这一类。

## 二、提交与打 tag

```bash
git checkout main
git merge --ff-only <任务分支>        # 分支上已 squash 成一条时用这个
git tag -a vX.Y.Z -m "X.Y.Z：<一句话>"
git push origin main
git push origin vX.Y.Z
```

tag 名带 `v` 前缀，`package.json` 的 `version` 不带 —— 两处保持这个差别，别写成两种风格。

## 三、GitHub Release

网页操作：仓库 → Releases → Draft a new release → 选刚推的 tag → 标题填 `X.Y.Z` → 正文**直接贴**
CHANGELOG 里该段（从 `## [x.y.z]` 到下一个 `## [` 之前）→ Publish。

正文不要另写一套说辞。两处说法一旦不同，读的人就得分清哪份是全的。

## 四、npm

```bash
npm whoami              # 确认登录的是有发布权的账号
npm pack --dry-run      # 再看一次内容与体积
npm publish --access public
npm view dsh-lattice version dist-tags
```

发布前确认 `package.json` 里没有 `private: true`。有的话先删掉，否则 `npm publish` 直接拒绝。

`dist-tags.latest` 应当指向刚发的版本。仓库里目前**没有** `packageManager` 之外的特殊字段，
`packageManager` 固定为 `pnpm@9.15.9`（与 CI 同值），发布时不受它影响。

## 五、发完之后

- 在宿主里装一次发布产物（不是源码目录）：在 profile 目录 `pnpm add dsh-lattice@X.Y.Z`，
  重启，`lattice_ping` 的 `version` 应对上。
- 读一遍 npm 页面与 Release 页面，确认 README 的渲染与链接没有断。
- 有已知限制的版本，`CHANGELOG.md` 的「已知限制」一节要有对应条目，并且每条都带一条自查命令
  —— 只写「可能不准」的条目，读者无法判断自己有没有中。

## 失败与回滚

| 情况 | 能做什么 | 边界 |
|---|---|---|
| tag 打错位置 | 删本地与远端 tag 后重打：`git push --delete origin vX.Y.Z` | 别人已经拉到这个 tag 之后不要删，改发下一个号 |
| Release 正文写错 | 直接编辑 Release | 无风险 |
| npm 包内容错了 | 24 小时内 `npm unpublish dsh-lattice@X.Y.Z`，然后重发同号 | 过了 24 小时只能 `npm deprecate` 并发下一个号；版本号永久占用 |
| npm 版本号发错（比如少了个 0） | 同上，24 小时内可收回 | 依赖它的人一旦装上就不能收回，宁可发小号 |

一条实测过的限制：用**绕过双因子**的 granular token 不能 unpublish，会返回
`403 ... may not perform this action`。要保留「24 小时内可收回」这个能力，就得用能过双因子的方式登录；
否则任何发布事故都只能靠 deprecate 与下一个版本号处理。

## 当前状态

npm 上有 `dsh-lattice@0.0.0` 与一个 `0.0.0-stage`，都是占位：前者是首次发布时随版本建立的占位包，
后者是 npm 在首次发布流程里自动写入的临时版本，已标记为弃用。正式版本发出去之后，`latest` 会指向
正式版本，这两个占位不需要手动处理。
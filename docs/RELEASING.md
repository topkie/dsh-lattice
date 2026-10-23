# 发布流程

写给维护者。贡献者提 PR 看 [CONTRIBUTING.md](../CONTRIBUTING.md)，不需要读本文。

## 口径

| 项 | 定法 |
|---|---|
| 发到哪 | 两处都发：GitHub Release 与 npm，版本号相同 |
| tag 谁打 | **维护者**。不由 CI 打，也不由贡献者打 |
| 谁来发 | npm 由 CI 在推 tag 后自动发（`.github/workflows/release.yml`）；GitHub Release 手工建 |
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

   推 tag 之后 CI 会在发布前再跑一遍同一套。本地这遍是为了在推之前发现红，不是为了省 CI 的时间。

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

推 tag 会立刻触发 `.github/workflows/release.yml`：它核对版本、跑一遍门禁、把包发到 npm。
所以 tag 要打在确认要发的那个提交上，推之前先看一眼 `git log --oneline -3`。

## 三、GitHub Release

网页操作：仓库 → Releases → Draft a new release → 选刚推的 tag → 标题填 `X.Y.Z` → 正文**直接贴**
CHANGELOG 里该段（从 `## [x.y.z]` 到下一个 `## [` 之前）→ Publish。

正文不要另写一套说辞。两处说法一旦不同，读的人就得分清哪份是全的。

这一节没有自动化，与 npm 那条流水线互不依赖：npm 先发成功、Release 过一会儿补，也不影响包本身。
不自动建 Release 的原因是正文要人挑段落 —— 「贴哪一段、要不要补一句已知限制」是判断不是复制；
而 Release 建错了随时可编辑，不构成不可逆风险，所以它不排在进行自动化的队列前面。

## 四、npm

推 tag 之后由 `.github/workflows/release.yml` 发，不需要在本机操作。它按顺序做四件事：

1. 核对 tag 与 `package.json` 的版本一致（`v0.10.0` 对 `0.10.0`），不一致直接失败；
2. 跑一遍门禁 —— tag 可能落在任意分支上，不能假设 `main` 已经绿过；
3. `npm pack --dry-run`，把六项白名单实际打进包里什么、体积多少留在日志里；
4. `npm publish --access public --provenance`。

认证走 npm 的 trusted publishing：仓库与 CI 里都不存能改发布状态的凭据，发布时 npm 用 GitHub 的
OIDC 凭据换一张短期发布凭据。代价是要在 npm 网页上登记一次。

### 一次性登记

不登记的话 publish 换不到凭据，这一步会失败。

1. 打开包设置页：npmjs.com → 自己的头像 → Packages → dsh-lattice → Settings → Trusted Publisher；
2. Provider 选 **GitHub Actions**；
3. Repository 填 `topkie/dsh-lattice`；
4. Workflow filename 一栏填 `.github/workflows/release.yml` 的文件名，也就是 release.yml（不带路径）；
5. Environment 留空 —— workflow 里没有声明 environment，填了会要求 workflow 也声明同名的那一个；
6. 保存。

之后只有 workflow 改文件名时才需要回来改这一项。npm 官方的说明见
[trusted publishing](https://docs.npmjs.com/trusted-publishers)。

### 手工兜底

CI 因为登记漏了、npm 短暂不可用或权限问题失败时，在本机发：

```bash
npm whoami              # 确认登录的是有发布权的账号
npm pack --dry-run      # 再看一次内容与体积
npm publish --access public
npm view dsh-lattice version dist-tags
```

发布前确认 `package.json` 里没有 `private: true`。有的话先删掉，否则 `npm publish` 直接拒绝。

`dist-tags.latest` 应当指向刚发的版本。`packageManager` 固定为 `pnpm@9.15.9`（与 CI 同值），
发布时不受它影响。

## 五、发完之后

- 在宿主里装一次发布产物（不是源码目录）：在 profile 目录 `pnpm add dsh-lattice@X.Y.Z`，
  重启，`lattice_ping` 的 `version` 应对上。
- 在 npm 包页面点开刚发的版本，确认 Provenance 一栏指向推 tag 的那个提交。这是「包是 CI 从这份
  代码构建的」唯一能被外部核对的记录，也是走 trusted publishing 而不是存 token 的主要收益。
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
| 推了 tag 但 CI 发布失败（npm 上还没有这个版本） | 修好后删 tag 重推：`git push --delete origin vX.Y.Z` 加 `git tag -d vX.Y.Z`，再重打重推 | 删 tag 会再触发一次发布流程；若上一次其实已经发成功，重推只会撞「该版本已存在」 |
| trusted publisher 漏登记，或 workflow 改了文件名 | 到包设置页补登记或改名字，然后删 tag 重推 | 登记与那次 CI 运行之间没有重试，必须重推来触发 |
| tag 打早了（不是要发的那个提交） | 同上，删 tag 重打 | 一旦 npm 上已有这个版本，改内容就只能发下一个号 |

一条实测过的限制：用**绕过双因子**的 granular token 不能 unpublish，会返回
`403 ... may not perform this action`。要保留「24 小时内可收回」这个能力，就得用能过双因子的方式登录；
否则任何发布事故都只能靠 deprecate 与下一个版本号处理。

## 当前状态

npm 上有 `dsh-lattice@0.0.0` 与一个 `0.0.0-stage`，都是占位：前者是首次发布时随版本建立的占位包，
后者是 npm 在首次发布流程里自动写入的临时版本，已标记为弃用。正式版本发出去之后，`latest` 会指向
正式版本，这两个占位不需要手动处理。

`.github/workflows/release.yml` 已就位，但**首次使用前要先做上面那次 trusted publisher 登记**，
否则推 tag 会在 publish 这一步失败。这种失败是可恢复的：npm 上还没有新版本，补登记后删 tag 重推即可。
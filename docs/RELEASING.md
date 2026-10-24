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
| 分支 | `main` 只放发布：接收 `dev` 的合并、打 tag。开发与 PR 都在 `dev` 上 |
| tag 名 | 带 `v` 前缀：`v0.10.0`。`0.10.0` 之前的 8 个 tag 没有 `v`（`0.2.0` 到 `0.9.1`），不追溯改 |

版本号只有一个来源：`package.json` 的 `version`。插件的 `VERSION` 常量运行时从它读
（`src/index.ts` 里那三行），`lattice_ping` 报的就是它。所以改版本号只改一处，不要在两处各写一遍。

## 一、准备

这一节都在 `dev` 上做。版本号与 CHANGELOG 是「要发出去的内容」，得先合进 `dev`、再随 `dev`
一起进 `main`。`main` 上不直接改文件 —— 那条分支只有两个动作：接收 `dev` 的合并、打 tag。

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
   git checkout dev                      # 要发出去的就是 dev 上这些提交，验这一份
   git worktree add ../clean --detach HEAD
   cd ../clean && pnpm install --frozen-lockfile && pnpm run build
   ```

   `--frozen-lockfile` 与 CI 用的是同一个开关。它红了说明 `pnpm-lock.yaml` 与 `package.json`
   不同步，本地能装而 CI 装不上就是这一类。

## 二、合进 main 与打 tag

前提：「一、准备」里的改动已经在 `dev` 上、门禁绿过。

`main` 每发一版只多一个**合并提交**：把 `dev` 合进来，tag 打在那个合并提交上。

```bash
git checkout dev
git pull --ff-only origin dev
git checkout main
git pull --ff-only origin main
git merge --no-ff dev -m "merge: 发布 vX.Y.Z"
```

为什么是合并提交而不是快进：`main` 的每个末端对应一版发布，`git log main` 上一行一版；快进会让
`main` 与 `dev` 永远指向同一个提交，事后从图上分不出哪一段改动属于哪一版。

合并提交很容易造歪，两条必查：

- **树必须等于 `dev` 的树**：`git diff --stat dev main` 输出为空。造错树的合并提交会把没准备发的
  东西带进发布线，而它和正常合并在 `git log` 上长得一模一样；
- **父必须是两个**：`git log -1 --format=%P` 给出两段哈希，前一段是上一次发布的 `main` 末端，
  后一段是这次的 `dev` 末端。

受限环境里 `git merge --no-ff` 可能失败（`error: cannot create standard output pipe for stash:
Permission denied` / `fatal: could not run stash.`）—— 那是那台机器 git 的限制，与流程无关。
等价做法是手工造合并提交，造完照样跑上面两条核对：

```bash
tree=$(git rev-parse dev^{tree})
merge=$(git commit-tree "$tree" -p "$(git rev-parse main)" -p "$(git rev-parse dev)" -m "merge: 发布 vX.Y.Z")
git update-ref refs/heads/main "$merge"
```

不要用 `--squash` 代替：它在 `dev` 上压成一条普通提交，`main` 上就没有合并边界了。

```bash
git tag -a vX.Y.Z -m "X.Y.Z：<一句话>"
git push origin main
git push origin vX.Y.Z
```

先推 `main` 再推 tag：`release.yml` 会 `git fetch origin main` 再校验「tag 指向的提交在 `main` 上」，
远端还没收到 `main` 时这一步会失败。

tag 名带 `v` 前缀，`package.json` 的 `version` 不带 —— 两处保持这个差别，别写成两种风格。

`v` 不只是习惯，它是触发条件：`.github/workflows/release.yml` 的 `tags` 是 `v*`。打成 `0.10.0`
会 tag 建成功、`git push` 也不报错，但 workflow 不触发 —— npm 上不会有这个版本，也没有任何
地方会说它错了。`0.10.0` 之前的 8 个 tag 没有 `v`，不追溯重打：重打会改历史，而旧 tag 可能
已经有人拉过。

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
2. 核对 tag 指向的提交在 `main` 上（不在就直接失败），然后跑一遍门禁；
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

## 紧急修复（hotfix）

已经发出去的版本有必须马上修的问题时，路和普通改动相同，只有两处不同：改动要小而准，出来的是补丁号。

```bash
git checkout dev && git checkout -b fix/hotfix-<slug>
# 只带修这一处所需的改动，不要顺手带上 dev 上别的提交
```

改完跑门禁（与普通改动同一条命令），合进 `dev`，再按第二节把 `dev` 合进 `main`、打 `vX.Y.(Z+1)` 的 tag。

一处要当心：如果 `dev` 上已经有一批没发布的改动，直接合进 `main` 会把它们一起发出去。
这种情况下从 `main` 签一个分支、只带修复提交，单独打 tag —— `release.yml` 要求的是
「tag 指向的提交在 `main` 上」，不要求等于 `main` 末端。

补丁号是 `X.Y.(Z+1)` 而不是 `X.(Y+1).0`：前者表示行为不变、只修了一个错。

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
| workflow 报「tag 不在 main 上」 | 删 tag，把那笔提交合进 `dev`、再按第二节合进 `main`，重打重推 | 这一步失败时 npm 上还没有新版本，可以安全重试 |

一条实测过的限制：用**绕过双因子**的 granular token 不能 unpublish，会返回
`403 ... may not perform this action`。要保留「24 小时内可收回」这个能力，就得用能过双因子的方式登录；
否则任何发布事故都只能靠 deprecate 与下一个版本号处理。
# AGENTS.md — 本仓库的开发约定

给在本仓库工作的 agent（智能体）。**面向人的约定在 [CONTRIBUTING.md](CONTRIBUTING.md)，
命令与工程细节在 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，根本约束在
[docs/PRINCIPLES.md](docs/PRINCIPLES.md)** —— 那三份是正文。

这里只写「已经写进文档、但到了动手那一刻仍然会被忘掉」的那几条。
差别不在内容，在**位置**：文档要人去翻，这里会随工作区指令自动出现在上下文里。
与上面三份冲突时，以它们为准。

**本文件只收「不知道就会做错」的事实，不收工作方式偏好** —— 后者因人而异，
写进来等于替所有人做决定。判据：这条被违反时，是**做错了**，还是**做法不同**？

## 一、开工第一件事是建分支

**从 `main` 签出**：`git checkout main && git checkout -b <type>/<slug>` —— **不是先读代码**。

已有记录表明：知道这条规矩，仍然会在主干上从改代码一路做到提交。
也有过「停在任务分支上直接 `checkout -b`」—— 新分支会带上那条分支的提交，
squash 时把不相干的改动一并带进来。

命名与合并方式见 [CONTRIBUTING.md](CONTRIBUTING.md#分支与合并)。

## 二、门禁必须带着分支名跑

```bash
GIT_BRANCH=$(git branch --show-current) node scripts/check-all.mjs
```

三条容易忽略的：

- 它把当前分支名打在第一行；**在 `main` 上跑会多一句提醒** —— 看到那句提醒说明已经走错，停下建分支。
- **不传 `GIT_BRANCH` 时它显示「分支：未知」** —— 那不叫通过，是提醒根本没生效。
- 全绿只覆盖静态检查与单元测试。**涉及编码或召回的改动，还要手动跑一次 `scripts/verify-*.mjs`** ——
  它们要联网、耗时数十秒，因此不进 CI，也就不会替你挡住这类改动。

## 三、写入本仓库：一律脱敏

**脱敏指的不是把署名抹掉**，而是：不要把「本不该公开、且与你的贡献无关」的信息写进去。
前者是防泄露，后者是个人选择 —— 方向甚至相反：防泄露要少说，署名要多说。两件事不要混。

写入或修改的任何内容都算，不止文档：代码注释、脚本头、`console` 输出、变量名、
README、CHANGELOG、**以及 git 提交信息**。

- 不得出现：**机器路径、内部项目名、私有数据规模、凭据与密钥、他人的隐私**。
- **署名由提交者自己决定**：想署真名就署，想用 noreply 就用 —— 唯一的要求是**别替别人决定**。

## 四、改完代码不会自动进宿主

插件在宿主里是**实体拷贝**（包管理器的 `file:` 依赖），改完源码不会自动同步过去；
宿主的健康检查**要重启**才会报出新版本。同步做法：重新构建后，把 `package.json` 与 `dist/`
覆盖到宿主 profile 的 `node_modules/dsh-lattice/`。

## 五、个人补充放 `AGENTS.local.md`

本文件是全仓库共享的，**不承载个人工作方式**。

要补充自己的工作方式，在仓库根目录（或任意子目录）新建 `AGENTS.local.md`。

## 六、改动本文件：比改代码更重

它影响**所有**在本仓库工作的人，所以：

- **单独一条提交**，不与代码改动混在一起 —— 否则「为什么加这条约束」会被埋在无关的 diff 里；
- 提交正文写清**为什么**、以及**会影响谁的工作方式**；
- 加一条之前先问：被违反时是「做错了」还是「做法不同」？**只收前者** ——
  后者请放 `AGENTS.local.md`（第五节）。

## 七、三个会静默出错的命令

**① 合并分支用 `cherry-pick -n`，别用 `git merge --squash`。**

本机沙箱下后者会失败：

```
error: cannot create standard output pipe for stash: Permission denied
fatal: could not run stash.
```

它内部要跑 `git stash`，而 stash 需要创建管道（受限环境不允许）。`cherry-pick -n` **不需要 stash**，
效果等价：把那条分支的改动放进暂存区，再由你提交成一条 squash 提交。**分支上有多个提交时，逐个 `-n`。**

**② `rm -rf` 会跟随 junction，删掉链接指向的目标。**

worktree 与探针目录里会建 `node_modules` 的 junction（指回主仓库，因为 worktree 不带依赖）。
**`rm -rf` 那个 junction 会把主仓库的 `node_modules` 整个删掉** —— 已发生过一次（215 个包）。

删之前先看清它是不是链接：

```
(Get-Item $p -Force).Attributes    # 含 ReparsePoint 就是链接
(Get-Item $p).Delete()             # 只删链接本身
```

**②之补：`git worktree remove` 不删 `node_modules` 的 junction。**

所以每清理一个 worktree，都会在 `.worktrees/<名字>/` 下**留下一个 junction 空壳**；
**而最后来 `rm -rf .worktrees` 收尾的人会跟随链接删掉主仓库的 `node_modules`** ——
与 ② 是同一个事故形态，只是发生在「收尾那一步」而不是「删探针那一步」。

**做法**：`git worktree remove` 之后，对该目录下的 `node_modules` 用 `(Get-Item $p).Delete()` 删链接，
再删那个空目录。**别用 `rm -rf` 收尾 `.worktrees/`。**

**③ `git worktree prune` 会清理「管理记录已丢失」的 worktree，而那些目录里可能还有未提交的文件。**

它已经删掉过一个子体的 **2474 行未提交代码**（那些文件从未 `git add` 过，所以 git 里连对象都没有，
**找不回来**）。删 worktree 之前先 `git -C <那个目录> status --short` 看清有没有东西。

**连带的一条**：子体的产出**尽早提交** —— 不是「写完再提交」，而是每完成一组就 `git add -A && git commit -m "wip: …"`。
合并时反正会 squash 掉，**而中途中断的代价从「全部丢失」降到「丢最后一段」**。

## 八、不为项目之外的东西兜底

- **检查只断言本仓库的行为。** 宿主或工具链不按预期时，记录并上报 —— 不要在代码里加绕行让它变绿。
- **用例只测本仓库。** 不断言「宿主会不会做某事」。
- **模拟不得进 CI。** 可以用模拟确认影响、把结论写进文档；进了 CI 之后，
  绿就不再等于「插件在真宿主上正常」。
- **依赖有问题时，能绕过就绕过；绕不过建议用户提 Issue 指出问题。**
  在项目自己的代码里绕开是可以的。不可以的是：在本地打补丁、改 `node_modules`、
  或把绕行固化进检查与 CI；**是否更换依赖由项目维护者决定。**

> 别名：AGENTS 仓库约定 开发约定 dsh-lattice 开发流程 分支 脱敏 worktree junction cherry-pick 个人补充 本地补充 责任边界 不兜底

# 贡献指南

感谢你考虑为 dsh-lattice 做出贡献。

## 开始之前

- 较大的改动请先开 Issue 讨论，避免做完才发现方向不一致
- 改动走任务分支，提交前确保 `node scripts/check-all.mjs` 全绿（见下方「分支与合并」）

## 开发环境

见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 分支与合并

main 永远可发布。**不要在 main 上直接提交**，所有改动走任务分支：

| 分支 | 用途 | 命名 |
|---|---|---|
| `feat/<slug>` | 新功能 | `feat/t7-view-assembly` |
| `fix/<slug>` | 缺陷修复 | `fix/recall-empty-result` |
| `docs/<slug>` | 仅文档 | `docs/constant-table` |

在分支上可以自由提交（允许中间态与试错提交）。合并前把分支压成一条干净提交：

```bash
git checkout main
git merge --squash feat/<slug>
git commit -m "feat: <摘要>"
```

### 合并门禁（顺序不能反）

1. `node scripts/check-all.mjs` 全绿 —— 类型检查、代码检查、格式检查、单元测试，一条命令跑完；
2. 涉及编码或召回的改动，再手动跑一次 `scripts/verify-*.mjs`（真实模型，需联网，因此不进 CI）；
3. 两项都过了才合并。

门禁会把当前分支名打在第一行，在 `main` 上跑时会多一句提醒 —— 它本应在任务分支上跑。
分支名通过环境变量传入，这样脚本自己不需要调 git（受限环境下子进程可能起不来）：

```bash
GIT_BRANCH=$(git branch --show-current) node scripts/check-all.mjs
```

**只提示不阻断**：合并后回 main 复验是合法操作，强行失败只会让人绕过这个脚本。

CI 对**所有分支**的 push 都会跑第 1 项。

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

## 测试

- 纯函数逻辑 → 单元测试
- 涉及数据库 → 用内存库或临时文件，测完删除
- 修复缺陷时请补一个能复现该缺陷的用例

## 许可证

贡献即表示你同意以本项目的 [MIT 许可证](LICENSE) 发布你的贡献。

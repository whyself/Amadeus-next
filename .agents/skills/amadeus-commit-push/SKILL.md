---
name: amadeus-commit-push
description: 在 Amadeus-next 仓库中提交、推送、强制推送、推送发布 tag，或声称检查已通过之前使用；用于写出符合约定的提交信息，并挑选能覆盖即将推送改动的最小检查集，而不是条件反射地跑全部检查。
---

# Amadeus-next 提交与推送

本 skill 规定提交信息的写法，以及推送前要拿到的本地证据。它是指导，不是脚本。只在用户要求时提交、推送或发布。

## 提交信息

标题用 Conventional Commits：

```
type(scope): 动词原形开头的行为描述
```

- `type` 常用 `feat`（新能力）、`fix`（修复缺陷）、`docs`（只改文档、注释或许可证）、`test`（只改测试）、`refactor`（行为不变的结构调整）、`perf`、`build`（构建、依赖、打包）、`ci`、`chore`、`revert`。
- `scope` 写包目录名（`packages/<目录名>` 中的目录名，与发布 tag 的前缀相同），例如 `feat(files): ...`；改动跨多个包或属于整个仓库时省略 scope。
- 描述写这次提交带来的行为结果，不写改了哪个文件；用英文，小写开头，结尾不加句号。
- 破坏性变更在 type 或 scope 后加 `!`，例如 `feat(reader)!: ...`，并在正文写出用户的迁移方法。
- `revert` 写恢复了什么行为，而不是 "Revert 'xxx'"。

正文写原因：为什么需要这次改动，以及评审需要知道的机制。不复述 diff 已经展示的内容。

## 检查即将推送的改动

1. 确认仓库和分支。

```sh
git status --short --branch
git rev-parse --show-toplevel
```

2. 对照远端分支查看完整的改动范围。

```sh
git fetch origin
git diff --stat origin/<分支>...HEAD
git log --oneline origin/<分支>..HEAD
```

## 选择相关证据

没有通用的本地基线。每个行为改动都需要一个最窄的、在发生回归时会失败的测试或检查；只有改动真正触及的部分，才追加更宽的检查。

- **包的源码行为**：运行该包对应的测试。共享的契约改变时，追加依赖它的其他包的测试。
- **TypeScript 代码**：运行 `pnpm run lint` 和 `pnpm run typecheck`。
- **包清单、公共导出、`cordis.patch.yml` 或构建配置**：运行 `pnpm run build`，在包目录 `pnpm pack` 并检查打包内容，再按 [AGENTS.md](../../../AGENTS.md#命令) 的本地验证方法把它装进隔离的 `DSH_HOME`，确认配置层出现、插件能加载。
- **文档、注释或 skill**：按 [docs/AGENTS.md](../../../docs/AGENTS.md) 检查，并运行 `git diff --check`。
- **发布流程（`.github/workflows/publish.yml`、版本号、tag）**：确认 tag 中的版本与包的 `package.json` 一致，并在本地完成 `pnpm pack`。

不要仅仅因为接下来要提交或推送，就手动重复一个已经通过的检查。

只有在用户明确要求、正在诊断 CI 失败，或者改动横跨整个仓库、没有更窄的检查集说得过去时，才在本地跑全部检查。

## 保护改写历史的推送

在改写分支的历史之前，先 fetch 远端分支并记下它确切的提交 ID；发布时用 `--force-with-lease=<分支>:<记下的提交 ID>`，这样如果有人同时更新了远端，推送会被中止。永远不用裸 `--force`。

## 处理失败

如果某个相关检查失败，停下来修复它，或说明是什么阻塞了它。不要先推上去指望 CI 结果不一样。

如果某个失败看起来和环境有关，要拿出证据：

- 记录确切的命令、失败的测试和平台相关的差异。
- 确认与平台无关的相关证据都通过了。
- 只有在用户明确要求或同意时，才跳过失败的检查，并准确报告失败了什么、为什么预期 CI 会不同。

## 推送流程

1. 把选中的相关检查跑一次。
2. 按上文写好提交信息并提交。
3. 正常推送；改写过历史的分支使用确切的 lease。
4. 核实远端 ref 和本地 `HEAD` 一致。

```sh
git rev-parse HEAD origin/$(git branch --show-current)
```

推送会触发 CI 或发布时，推送后查看运行结果：

```sh
gh run list --limit 5
```

还在运行的检查如实报告为进行中。先查明失败原因，再判断它属于改动本身还是环境。汇报时只列实际运行过的命令。

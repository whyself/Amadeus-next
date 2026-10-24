# AGENTS.md

Amadeus-next 是一组 DeepSeek Harness（DSH）插件包（bundle），用户通过 `dsh plugin add <包名>` 安装到自己的 DSH profile 中运行。

## 沟通

- 回复用户使用中文；代码、命令、标识符和提交信息保持英文。
- 只在用户要求时提交、推送或发布。

## 仓库结构

```
packages/<name>/   每个目录是一个可单独安装的 bundle：package.json 声明 dsh.bundle，带 cordis.patch.yml
docs/              跨包文档；单个包的配置、行为与限制写在该包的 README.md
```

- pnpm workspace，ESM（`"type": "module"`），TypeScript 源码在 `src/`，构建产物在 `lib/`。
- 包名 `@amadeus-dsh/<name>`。包之间通过包名导入，不使用跨包相对路径。
- 文档、README 和包描述只写中文。

## 命令

```sh
pnpm install
pnpm run lint        # oxlint，规则来自 DSH 的 .oxlintrc.json，去掉了 DSH 内部专用规则
pnpm run typecheck
pnpm run build       # 每个包 tsc 输出到 lib/
```

本地验证一个包：在包目录 `pnpm pack`，再用 `dsh plugin --profile <name> add <tgz 路径>` 装进一个隔离的 `DSH_HOME`，`dsh --profile <name> --dump-config` 应出现该包的配置层。

## 与 DSH 的解耦

- **只依赖 DSH 的公开扩展点**：服务、事件、`systemPrompt`、`appendPluginRecord`、客户端插槽和 cordis 组合。只从 `@deepseek-ai/*` 包的公开 `exports` 导入，不读 DSH 安装目录或 `node_modules` 内的路径。缺少扩展点时先向用户说明取舍，不复制或改写 DSH 原生插件。
- **兼容性显式声明**：每个包的 `engines.dsh` 写出已验证的 DSH 版本范围，DSH 安装和启动时据此拒绝不兼容版本。当前基线为 0.2.1-rc.3，范围写 `>=0.2.1-rc.3 <0.3.0-0`；DSH 比较时包含预发布版本，上限用 `-0` 排除 0.3.0 的预发布。需要与宿主共享实例的 `@deepseek-ai/*` 包同时写进 `peerDependencies` 与 `devDependencies`；第三方依赖写进 `dependencies`。
- **配置走 cordis**：随部署变化的选项是经过 Schemastery 校验的插件 `Config` 字段，可在 profile 的 `cordis.patch.yml` 中修改。`DEFAULT_*` 常量不算可配置。
- **外部程序不由插件安装**：需要外部可执行文件或服务时，经 `Config` 指定路径或地址，加载时检测；缺失时报出明确错误并只停用该功能。

## 插件约定（来自 DSH）

- 所有注册经过 `ctx.effect()` / `ctx.on()`，`register()` 返回销毁函数；插件 dispose 后不留下副作用。
- waterfall 监听器必须调用 `next()`。
- 模型可见 ⟺ 已记录：进入模型请求的内容必须能从 Session 日志重建，新增模型可见输入要写对应的插件会话记录。
- 共享状态挂在服务或插件实例上；不新增模块级单例、全局缓存或 `globalThis` 状态。
- 客户端界面文字走 locale 字典，不在 JSX 里硬编码。
- 配置错误在加载时报错；不静默跳过缺失的引用。

## 代码

- `strict: true` 与 `noImplicitAny`；每个保留的 `any` 写明为何无法收窄。禁止 `as unknown` / `<unknown>` 断言。
- 同进程、有类型的接口之间信任 TypeScript；运行时校验只放在配置、模型或工具的 JSON、持久化文件、子进程和网络边界。
- 默认值在显式的 `resolve()` 步骤给出，不在执行函数里写隐藏的 `?? default`；不写多层 `?.` 回退来掩盖值该不该存在。
- 封闭联合的 `switch` 以 `assertNever` 结尾。
- 空 `catch` 写明吞掉的错误和原因，`try` 只包一条语句。catch 后只打日志就继续不算恢复。
- 每个抽象、配置项和兼容路径都要有当前的消费者；没有就删除。优先使用维护中的依赖，前提是它确实删掉了自有代码。

## 文字

- 文档和注释写当前状态：不写 "used to / no longer / 本次改动"，不引用会话里的决策编号、PR 讨论或未提交的草稿。检验标准：只看 HEAD 的读者能否解析每个引用、验证每个断言。
- 注释只写非显然的契约：行为、失败、所有权、时机；不复述代码，不为代码辩护。
- 每条事实只有一个归属，其他地方放链接。导出的 API 写 JSDoc，函数类导出带 `@param` / `@returns`。
- 直接命名具体的检查、类型或 API，不用比喻。

## 证据

- 单元测试用 Vitest。测试验证外部状态（文件、日志、事件、销毁后的注册表），不断言模型或 agent 的自述；只 mock LLM、网络和时钟。
- 每个 bundle 有一个经过真实 DSH Loader 组合的加载测试，覆盖安装后 `cordis.patch.yml` 能被组合、插件能启动和销毁。
- 新增的检查规则附一个会被它拒绝的非法用例。
- 推送前只跑覆盖本次改动的检查；汇报时只列实际运行过的命令。无法自动化的行为标注为需要人工验收。

## Git

- 提交信息用 Conventional Commits：`type(scope): 动词开头的行为描述`，scope 写包名；破坏性变更加 `!`。
- 正文写原因；末尾用 `Validation:` 列出实际运行的检查、结果和负向对照。
- 测试和评审修复保留为独立提交；改写远端历史只用 `--force-with-lease`。

## 发布

- 发布到 npm，发布内容是预构建的 `lib/`、`cordis.patch.yml` 和 locale 文件；用户安装时不需要授权构建脚本。
- 由 GitHub Actions 发布并附 provenance；包带 `dsh-plugin` 关键词，仓库带 `dsh-plugin` topic。
- 推送 `<包目录名>@<版本>` 格式的 tag（例如 `test@0.1.0`）触发 `.github/workflows/publish.yml`；tag 中的版本必须与该包 `package.json` 一致。npm 端为每个包配置 Trusted Publisher，不使用长期 token。

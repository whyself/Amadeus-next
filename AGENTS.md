# AGENTS.md

Amadeus-next 是面向个性化、一体化、remote work 的一组 DeepSeek Harness（DSH）插件包（bundle），用户通过 `dsh plugin add <包名>` 安装到自己的 DSH profile 中运行。

## 沟通

- 回复用户使用中文；代码、命令、标识符和提交信息保持英文。
- 只在用户要求时提交、推送或发布。

## 仓库结构

```
packages/<name>/   每个目录是一个可单独安装的 bundle：package.json 声明 dsh.bundle，带 cordis.patch.yml
docs/              跨包文档；单个包的配置、行为与限制写在该包的 README.md
scripts/           文档门禁、代码门禁和测试工具，由根 package.json 的命令调用
.agents/           Agent Notes（决策记录）与 skills；.claude/skills 链接到 .agents/skills
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
pnpm run test        # Vitest，包括各个门禁自身的反例测试
pnpm run doc-sync    # 文档门禁：一段一行、相对链接与锚点、代码中的文档路径、提交哈希引用、Agent Note 格式、skill 元数据、导出 JSDoc、字数预算、界面文案、包 README 结尾章节
pnpm run hygiene     # 代码门禁：禁止断言到 unknown、包清单规范（包名、engines.dsh、peer 与 dev 依赖、bundle patch）
```

改动 Markdown、`.agents/` 或导出的 API 后运行 `pnpm run doc-sync`；改动源码或包清单后运行 `pnpm run hygiene`。提交前 git hook 修复并检查暂存文件的 lint 和空白，推送前运行 `typecheck`。CI 在每次推送到 master 和每个 PR 上运行 `lint`、`typecheck`、`build`、`hygiene`、`test` 与 `doc-sync`。

本地验证一个包：在包目录 `pnpm pack`，再用 `dsh plugin --profile <name> add <tgz 路径>` 装进一个隔离的 `DSH_HOME`，`dsh --profile <name> --dump-config` 应出现该包的配置层。

## 与 DSH 的解耦

- **只依赖 DSH 的公开扩展点**，例如服务、事件、工具注册、waterfall、`systemPrompt`、`appendPluginRecord`、客户端插槽，以及在 `cordis.patch.yml` 中替换或禁用内置插件。只从 `@deepseek-ai/*` 包的公开 `exports` 导入，不读 DSH 安装目录或 `node_modules` 内的路径。找不到扩展点时先向用户说明可选方案和代价，不复制或改写 DSH 原生插件。
- **兼容性显式声明**：每个包的 `engines.dsh` 写出已验证的 DSH 版本范围，DSH 安装和启动时据此拒绝不兼容版本。当前基线为 0.2.1-rc.3，范围写 `>=0.2.1-rc.3 <0.3.0-0`；DSH 比较时包含预发布版本，上限用 `-0` 排除 0.3.0 的预发布。需要与宿主共享实例的 `@deepseek-ai/*` 包同时写进 `peerDependencies` 与 `devDependencies`；第三方依赖写进 `dependencies`。
- **配置走 cordis**：随部署变化的选项是经过 Schemastery 校验的插件 `Config` 字段，可在 profile 的 `cordis.patch.yml` 中修改。`DEFAULT_*` 常量不算可配置。
- **外部程序不由插件安装**：需要外部可执行文件或服务时，经 `Config` 指定路径或地址，加载时检测；缺失时报出明确错误，只停用依赖它的功能，插件其余部分照常加载。

## 插件约定

- 所有注册经过 `ctx.effect()` / `ctx.on()`；插件自己提供的注册表，其 `register()` 返回销毁函数。插件 dispose 后不留下副作用。
- waterfall 监听器必须调用 `next()`。
- 模型可见 ⟺ 已记录：进入模型请求的内容必须能从 Session 日志重建，新增模型可见输入要写对应的插件会话记录。
- 共享状态挂在服务或插件实例上；不新增模块级单例、全局缓存或 `globalThis` 状态。
- 客户端界面文字走 locale 字典，不在 JSX 里硬编码。
- `Config` 校验失败或引用的插件、服务、文件不存在时，插件加载失败并报出原因；不静默跳过缺失的引用。外部程序缺失按上文只停用对应功能。

## 代码

- `strict: true` 与 `noImplicitAny`；每个保留的 `any` 写明为何无法收窄。禁止 `as unknown` / `<unknown>` 断言。
- 同进程、有类型的接口之间信任 TypeScript；运行时校验只放在配置、模型或工具的 JSON、持久化文件、子进程和网络边界。
- 默认值在显式的 `resolve()` 步骤给出，不在执行函数里写隐藏的 `?? default`；不写多层 `?.` 回退来掩盖值该不该存在。
- 按判别字段 `switch`：封闭联合以本仓库自己定义的 `assertNever` 结尾，不依赖 DSH 的工具包；可通过声明合并扩展的联合走一个写明理由的 `default`。
- 空 `catch` 写明吞掉的错误和原因，`try` 只包一条语句。catch 后只打日志就继续不算恢复。
- 每个抽象、配置项和兼容路径都要有当前的消费者；没有就删除。优先使用维护中的依赖，前提是它确实删掉了自有代码。

## 文字

- docs/ 和注释写当前状态，不写变更经过，不引用会话里的决策编号、PR 讨论或未提交的草稿：只看 HEAD 的读者必须能解析每个引用、验证每个断言（[规则](.agents/skills/amadeus-trim-cot-leakage/SKILL.md)）。
- 注释只写非显然的契约：行为、失败、所有权、时机；不复述代码，不为代码辩护（[规则](.agents/skills/amadeus-prose-standard/SKILL.md)）。
- 导出的 API 写 JSDoc，函数类导出带 `@param` / `@returns`。
- 写文档前先读 [docs/AGENTS.md](docs/AGENTS.md)：分层、一事实一归属和 slop 清单在那里。
- **只为长期有效的决策理由写 Agent Note**；机械性和局部的改动不写，包括局部 UI 调整（[范围](.agents/notes/README.md#什么时候写)）。

## 测试与验证

- 单元测试用 Vitest。测试验证外部状态（文件、日志、事件、销毁后的注册表），不断言模型或 agent 的自述；只 mock LLM、网络和时钟。
- 每个 bundle 有一个经过真实 DSH Loader 组合的加载测试，覆盖安装后 `cordis.patch.yml` 能被组合、插件能启动和销毁。
- 新增的检查规则附一个会被它拒绝的非法用例。
- 汇报时只列实际运行过的命令。无法自动化的行为标注为需要人工验收。

## 发布

- 发布到 npm，发布内容是预构建的 `lib/`、`cordis.patch.yml` 和 locale 文件；用户安装时不需要授权构建脚本。
- 由 GitHub Actions 发布并附 provenance；包带 `dsh-plugin` 关键词，仓库带 `dsh-plugin` topic。
- 推送 `<包目录名>@<版本>` 格式的 tag（例如 `test@0.1.0`）触发 `.github/workflows/publish.yml`；tag 中的版本必须与该包 `package.json` 一致。npm 端为每个包配置 Trusted Publisher，不使用长期 token。

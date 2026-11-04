# Agent Note: 以独立 bundle 插件包替代自托管启动器，与 DSH 解耦

Status: implemented

## 问题

原 `Amadeus` 仓库将插件与自托管容器运行时捆绑在同一个单体工作台中，导致插件无法作为标准 DSH 扩展独立分发和随上游平滑升级：

- **非公开路径与启动链路耦合**：启动入口 `scripts/start.mjs` 直接调用 `node_modules/@deepseek-ai/dsh/lib/bin.js`；配置生成脚本通过 `require.resolve` 读取 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 等包内非公开文件，将插件加载路径改写为 `file://` URL 并生成命令行 `--patch` 覆盖层，还会直接调用 `@deepseek-ai/dsh/profile-boot` 和 `@deepseek-ai/dsh-app-boot` 改写用户 `DSH_HOME` 下 `profiles/amadeus/` 的 `package.json` 与 `cordis.patch.yml`。
- **原生插件复制与双包载体**：为绕过扩展点限制和外部 profile 的模块解析规则，维护了 `@deepseek-ai/dsh-tool-session-query` 的工具层源码副本（`packages/session-query-global`），并将浏览器插件拆成 `dsh-amadeus-browser`（bundle 壳）与 `dsh-amadeus-browser-runtime`（构建产物载体）两个包同步构建。
- **隐式版本与实例绑定**：根工作区锁定单一 `@deepseek-ai/dsh` 预发布版本，插件包未声明 `engines.dsh`，且部分插件将 `@deepseek-ai/*` 放入 `dependencies`，在用户独立安装的 profile 中存在重复安装或破坏 Cordis 宿主单例的风险。
- **外部软件生命周期混入插件仓**：仓库和启动流程承担了 Chromium 安装检测（`scripts/browser-bootstrap.mjs` 穿透多层 `createRequire` 解析 Playwright CLI）、code-server 与 LaTeX Workshop 补丁脚本及容器编排，使插件无法直接通过 `dsh plugin add` 安装到用户已有的本地或远端 DSH 环境。

## 决策

`Amadeus-next` 只交付可通过 `dsh plugin add <包名>` 安装到用户自有 DSH profile 的独立插件包（`@amadeus-dsh/<name>`），将宿主启动、profile 管理和外部软件安装交还给 DSH 与部署环境：

- **单一的 bundle 分发契约**：每个 `packages/<name>/` 都是独立的 npm 包，包含预构建的 `lib/`、`cordis.patch.yml` 和 locale 资源，并在 `package.json` 的 `dsh.bundle.patch` 中声明配置补丁。不提供自定义启动器，不在安装期运行构建脚本，也不拆分额外的 `-runtime` 载体包。
- **只使用公开扩展点与公开导出**：插件只通过服务、事件、工具注册、waterfall、`systemPrompt`、`appendPluginRecord`、客户端插槽以及 `cordis.patch.yml` 的内置插件替换或禁用与宿主交互；只从 `@deepseek-ai/*` 的 `exports` 公开入口导入，不读取 `node_modules` 内部文件路径，也不复制或改写 DSH 原生插件。
- **显式版本范围与共享实例约束**：每个包在 `engines.dsh` 中声明已验证的 DSH 版本范围（当前为 `>=0.2.2-alpha.3 <0.3.0-0`）；需要与宿主共享实例的 `@deepseek-ai/*` 包同时写入 `peerDependencies` 和 `devDependencies`（其中 `@deepseek-ai/cordis` 绝不写入 `dependencies`），第三方运行时依赖写入 `dependencies`。该契约由 [scripts/verify-package-meta.ts](../../../../scripts/verify-package-meta.ts) 在 `pnpm run hygiene` 中强制校验。
- **配置归属 Cordis，外部程序按需检测**：随部署变化的选项定义为经过 Schemastery 校验的插件 `Config` 字段，由用户在自身 profile 的 `cordis.patch.yml` 中配置。需要外部可执行文件或服务时，通过 `Config` 接收路径或地址并在插件加载时检测；缺失时报错并仅停用依赖该程序的功能，不由插件或启动脚本代为下载安装。
- **以真实 Loader 组合验证替代启动器集成**：每个 bundle 通过 [scripts/test-support/boot-bundle.ts](../../../../scripts/test-support/boot-bundle.ts) 在真实的 `@deepseek-ai/cordis-plugin-loader` 与 `@deepseek-ai/cordis-plugin-include` 下从构建产物 `lib/` 和 `cordis.patch.yml` 启动与销毁，验证安装后的组合行为。

## 考虑过的替代方案

**保留原 `Amadeus` 的 `scripts/start.mjs` 启动器与集中式 `--patch` 生成脚本。** 落选原因：命令行 `--patch` 位于最高优先级覆盖层，会压制用户在 DSH 原生设置界面中对 profile 层所做的修改；为绕开该冲突而直接读写 `profiles/<name>/cordis.patch.yml` 又耦合了 DSH 内部的 profile 存储格式，且无法支持用户通过 `dsh plugin add` 将单个插件装入已有 profile。

**遇到未公开的能力时复制 DSH 原生插件源码并在仓内维护分支（如原 `packages/session-query-global`）。** 落选原因：源码副本把插件与单次 DSH 预发布版本的内部实现细节和提示词锁死，上游每次调整内部服务接口、参数校验或工具激活机制都会造成静默分叉。缺少公开扩展点时，向用户说明可选方案与代价，或向上游争取扩展点，不在本仓维护原生插件副本。

**在插件加载或仓库脚本中自动安装外部运行时（如自动拉起 Playwright CLI 安装 Chromium 或给外部服务打补丁）。** 落选原因：插件运行在用户自有的 DSH 进程内，隐式下载二进制文件或修改宿主外部目录既违反最小权限预期，也依赖包管理器在 `node_modules` 中的非公开嵌套结构。

## 后果

- **获得的能力**：用户可以按需选用任意 `@amadeus-dsh/<name>` 插件装入自己的本地或远端 DSH profile，使用 DSH 原生 CLI 与设置界面管理配置；`engines.dsh` 与 [scripts/verify-package-meta.ts](../../../../scripts/verify-package-meta.ts) 保证了包清单、共享实例依赖和 `cordis.patch.yml` 插入项在发布前即经过静态校验与真实 Loader 组合测试。
- **付出的代价与转移的职责**：本仓库不再提供含 TeX Live、code-server 和容器编排的一体化 Docker 镜像，外部程序需由用户或部署环境先行准备并在 `Config` 中配置路径或地址；当某项定制不存在公开的 DSH 扩展点时，功能会被推迟或缩小范围，而不能通过读取 DSH 内部文件或复制原生插件强行落地。

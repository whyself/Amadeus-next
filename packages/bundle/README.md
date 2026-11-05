# Amadeus DSH

此总包整合 Amadeus 品牌与[代码编辑器](../editor/README.md)。品牌标识沿用 Amadeus 图案，统一侧栏标识、左上角名称、新会话中央标识和网页图标；撤销插件后恢复宿主插槽和原网页图标。不向系统安装外部运行时。

## 安装与组合

使用 `dsh plugin add @amadeus-dsh/bundle` 安装总包。Editor 作为 npm 依赖随总包安装，由总包的配置补丁启用，不需要再执行单独的安装命令；Code Server 在 Editor 设置页经用户选择后下载，安装规则与配置归[Editor](../editor/README.md#按需安装)所有。

只需要编辑器时，安装 `@amadeus-dsh/editor`。两个包使用同一个 `amadeus-editor` 配置项，保留 Editor 的独立分发方式。通过 DSH 插件页管理总包及其组成项的启用状态，Editor 的配置入口位于组成项详情。

## 本地包与发布顺序

总包依赖相应版本的 Editor，发布时先发布 Editor，再发布总包。本地 tarball 的新版本尚未发布时，需要在隔离验证 profile 的 `pnpm-workspace.yaml` 中将 Editor 依赖覆盖到它的 tarball，再用 `dsh plugin --profile <name> add <总包 tgz>` 安装总包；同时传入两个 tgz 不会让 pnpm 自动用本地文件替代传递依赖。开发验证不修改已有用户 profile。

## 模型体验

无，因为品牌与编辑器界面不向模型请求添加内容。

## 已知限制与延期工作

- 网页标题由 DSH 的构建配置管理，本包不修改宿主的会话标题逻辑。
- 总包仅包含本仓库已有的 Editor，不包含旧项目中的阅读器、文件管理或浏览器插件。
- 第三方插件占用相同品牌插槽且优先级同为 `-100` 时，宿主会报告注册冲突。

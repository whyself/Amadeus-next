# @amadeus-dsh/example

最小 DSH 插件：通过 `ctx.effect()` 注册一个 effect，加载时在终端打印 `[amadeus-example] plugin loaded`，插件被销毁时打印 `[amadeus-example] plugin disposed`。它是仓库内的插件示例，也是文档门禁和插件测试的检查对象；`package.json` 声明了 `"private": true`，不发布到 npm。

`tests/loader.spec.ts` 是真实 Loader 加载测试的模板：它按用户安装后的方式，用 Loader 加载本包的 `cordis.patch.yml`，断言插件启动，再断言销毁后 effect 被撤销。新包照此编写自己的加载测试，测试工具见 [scripts/test-support/boot-bundle.ts](../../scripts/test-support/boot-bundle.ts)。

## 模型体验

无，因为插件只向终端打印日志，不注册工具、提示词或会话记录，不向模型请求添加任何内容。

## 已知限制与延期工作

- **不发布**：本包不发布到 npm。npm 上 `@amadeus-dsh/test` 的 `0.0.0-stage`、`0.1.0`、`0.1.1` 只用于验证发布流程，已标记弃用。
- **只有一个 effect**：插件除了打印日志的 effect，不注册工具、服务、配置或界面。

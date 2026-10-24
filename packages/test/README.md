# @amadeus-dsh/test

加载时在终端打印 `[amadeus-test] plugin loaded!` 的最小 DSH 插件，不注册任何能力，用于验证本仓库的构建与发布流程。

```sh
dsh plugin --profile <profile> add @amadeus-dsh/test
```

支持的 DSH 版本见 `package.json` 的 `engines.dsh`。

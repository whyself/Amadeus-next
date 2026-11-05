# @amadeus-dsh/editor

此包在右侧栏提供 code-server 编辑器。右侧栏向导、`workspace.editor` 快捷键、文件树和文档预览中的按钮可打开编辑器；文件的普通单击仍使用原生预览。

Desktop 通过独立的 HTTP 或 HTTPS 地址嵌入 code-server，Web 通过 DSH 的同源代理加载；Desktop 须能直接访问 `upstream` 指向的服务。插件界面使用宿主的语言设置，自动模式跟随系统语言；可在通用设置中选择中文或英文。

使用 `dsh plugin add @amadeus-dsh/editor` 安装，可在插件详情页或 profile 的 `cordis.patch.yml` 中配置插件。桌面快捷键默认为 `Primary+E`，Web 默认为 `Primary+Alt+E`。

配置保存后在重启 DSH 时生效。code-server 无法启动时，编辑器显示连接失败提示与重试入口，插件设置仍可使用。

## 按需安装

本机模式的插件设置页提供“下载并安装”，默认不下载、不安装。向导显示准备步骤、下载进度、取消和重试，在运行 DSH 的机器上下载 code-server；下载后使用 GitHub 官方发布资产的 SHA-256 校验，解压并验证版本，重启 DSH 后使用。配置保存和下载安装是两个独立操作。

`downloadVersion` 默认 `4.145.0`，接受 `>=4.90.0 <5.0.0` 的正式版本；`downloadBaseUrl` 默认 `https://github.com/coder/code-server/releases/download`，可指定保持 `/v<版本>/<发行文件名>` 目录结构的 HTTPS 镜像，但校验信息仍需访问 GitHub API。`installDir` 默认 `$DSH_HOME/editor/runtime`，版本分别放入其子目录；这三个选项修改后须保存并重启 DSH，向导显示当前生效的来源与目录。已下载的文件在卸载插件后保留，不修改系统 PATH，也不安装系统依赖。

向导支持 Linux/macOS 的 x64 和 arm64；Windows 可在 WSL 中运行 DSH，或连接外部服务。设置了 `executablePath` 时优先使用该路径；留空时优先使用指定下载版本的已安装文件，否则从 PATH 查找 `code-server`。外部服务模式不显示安装入口。

受管模式通过 `executablePath` 指定 code-server 可执行文件，启动时要求版本不低于 4.90.0 且低于 5.0.0。`stateDir` 保存用户设置、安装的扩展和运行状态，默认使用 `$DSH_HOME/editor`（未设置 `DSH_HOME` 时为 `~/.dsh/editor`）；未配置 `upstream` 时尝试启动本机 code-server，启动失败只停用编辑器功能。

外部模式通过 `upstream` 指定已运行且免认证的 HTTP 或 HTTPS 服务，外部实例须与 DSH 使用相同的工作区路径。默认的 `bridgeMode: required` 还要求共享回环网络和桥接注册目录；显式配置 `bridgeMode: disabled` 可关闭桥接。

外部实例启用桥接时，需要将本包的 [`extension/`](extension/) 部署到该实例扩展目录下的 `amadeus-bridge/`，并在启动 code-server 前设置 `AMADEUS_BRIDGE_DIR=<stateDir>/bridges`。该目录须与 DSH 共享且可写；外部模式不会自动安装桥接扩展或注入环境变量。不满足这些条件时，需显式关闭桥接，或改用受管模式。

`startupTimeoutMs` 控制进程启动超时，`bridgeTimeoutMs` 控制桥接请求超时，`maxHotWorkspaces` 指定客户端热工作区数量上限，默认分别为 15000 毫秒、3000 毫秒和 3 个工作区。

准备接口、工作区 API 和编辑器代理同时接受 DSH 监听地址与 `publicOrigin` 配置的公开来源；请求带有 Origin 时，须与所用 Host 对应的来源一致。经过反向代理时，将 `publicOrigin` 配置为浏览器使用的完整 HTTP 或 HTTPS 来源，且代理必须转发对应的 Host；本机仍可使用 DSH 监听地址访问。

桥接模式下，关闭或驱逐工作区前会检查未保存的文本、未命名文档和脏标签页。保存后重新检查；状态未知、检查失败、保存失败或用户取消时保留原 iframe。多个窗口打开同一工作区时禁止自动跨窗口丢弃修改。

默认通过 `?folder=` 打开当前会话工作区，项目 `.vscode` 配置按编辑器原生规则生效。主题经桥接写入用户级设置，不写入工作区设置。代码和终端字号由 code-server 自身设置控制，不随 DSH 字号变化。

受管实例首次创建用户设置时，将 `workbench.secondarySideBar.defaultVisibility` 设为 `hidden`，使新工作区默认隐藏右侧 Chat。已有用户设置与工作区保存的布局保持原样；可在 code-server 的用户设置中修改该值，并手动关闭已打开工作区的右侧栏。

## 模型体验

无，因为此包不向模型请求添加内容。

## 已知限制与延期工作

- 外部实例使用 `bridgeMode: disabled` 时不提供文件定位、主题同步和未保存草稿保护。
- Desktop 直连 code-server 不经过 DSH 的浏览器认证；受管实例只监听回环地址，外部实例的访问保护由部署方负责。
- 文件定位等待桥接注册，连续失败后显示错误，需重新发起打开操作。
- 编辑器选区引用与 PDF 划词注释尚未接入。
- 同一工作区在多个浏览器窗口打开时，关闭检查采用保守策略，不能自动跨窗口丢弃修改。
- Desktop 中已绑定的宿主快捷键可能先于编辑器处理；本包不修改宿主键盘策略，编辑器内置终端可通过菜单打开。
- 更新或卸载插件会重建或销毁编辑器实例，操作前需要保存编辑器内的修改。
- code-server 具备终端、任务和扩展执行能力，工作区入口校验不提供操作系统级隔离；部署需要可信的宿主用户和受保护的访问入口。

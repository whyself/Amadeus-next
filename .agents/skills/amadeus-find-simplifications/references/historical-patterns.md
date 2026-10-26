# 历史简化模式

当一个候选的价值无法靠"搜索没用到的符号"来确定时，用这些例子校准。它们来自 DeepSeek Harness 已记录的决策，链接指向 DSH 仓库 `dsh-v0.2.1-rc.3` 标签下的 Agent Note；它们说明的是决策方式，不是本仓库当前可删除的东西。DSH 中位于 `archived/` 的 Note 是冻结的快照：只读 Note 本身，不追踪也不修复它的外链。应用某个模式之前，先核实本仓库当前的所有者和已发布数据的义务。

## 要求完整的生效路径

一个声明、一个序列化分支和一个测试，可以拼成看似完整的支持，实际上功能并不生效。两端都要追踪：必须有东西产生这个值，也必须有实现遵守它。[无生产者变体的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.md) 删掉了没有产生方的预留联合成员和缓存提示。[无效请求参数的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-07-04-drop-inert-request-knobs.md) 区分了每个适配器都拒绝的参数，和 hook 可以使用的、真正生效的请求字段。删除范围包括声明、转发、只测拒绝的测试和生成的文档。

没有固定调用方，是比"不可达"更弱的证据。[skill 注册 API 删除提案的否决](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/rejected/simplification/2026-07-12-prune-unused-skill-registry-api.md) 保留了一条有意设计的第三方注册路径。对于登记在目录中的服务，在宣布它是死代码之前，要检查通用的插件调用和返回值。一个可用的扩展点，和一个没有任何提供方能遵守的字段，需要不同的结论。

## 在消费方做决定的地方减少区分

把每个公开变体对应到它所支持的消费方行动。[模型可用性与团队目标的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-09-15-model-agent-availability-and-team-targets.md) 只给模型一个可用的团队目标，并把多种驻留状态投影为同一种可用性，而内部路由仍保留会话身份和驻留状态。[与能力无关的沙箱上下文](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-07-31-capability-neutral-sandbox-policy-context.md) 用如实的条件式策略措辞，替代了两个近似的能力注册表；确切的工具可用性仍由工具 schema 表达。收益包括注册方法、销毁状态、失效处理和组合测试。

不要只因为某个渲染器忽略了两个不同的持久化事实，就把它们合并掉。[删除持久化步骤边界提案的否决](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/rejected/simplification/2026-06-20-drop-durable-step-boundaries.md) 保留了显式的开始和完成事实，因为空的失败步骤、崩溃修复和排查都需要它们。只有底层的区分仍然必要时，才简化投影。

## 用更小的显式承诺换掉通用行为

一个有人在用的功能，仍可能是满足所需结果的昂贵方式。[固定频率调度的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-08-09-bounded-fixed-rate-schedule.md) 放弃了日历式重复和错过时刻的补放，删掉了解析器、求值器、跨记录检查、持久化变体和积压状态。[非事务性 Loader 的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/implemented/simplification/2026-09-09-nontransactional-loader.md) 放弃了插件的自动回滚，保留了失败报告和由消费方负责的激活检查。把通用回滚挪到另一个包，成本依然存在。

损失要和删除写得一样清楚。[截断被中断轮次提案的否决](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/rejected/simplification/2026-06-20-truncate-interrupted-turns.md) 否决了一个更简单的恢复算法，因为一个未完成的轮次里可能包含大量真实的工作。仅凭方便、更小的联合类型或更少的测试，不足以证明可以丢掉必需的数据或行为。调查可以提出取舍，但不代表获准实施。

## 在使用它的操作处显式写出假设

寻找已经长出共享存储、同步或确认机制的局部默认值。[显式调度时区的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/implemented/simplification/2026-08-09-explicit-schedule-time-zone.md) 让浏览器的信息留在发起请求上，并要求调度操作显式给出时区，删掉了会话默认值和跨标签页的冲突状态。[注入内容去封装的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-07-20-unwrap-injected-content-envelopes.md) 把封装交给调用方，删掉了穿过无关层级传递的封装控制项。两者都减少了需要解释同一个假设的所有者数量。

不要把一项要求挪到必须执行它的位置之后。[Remote 输入只在 Host 校验的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-09-15-host-only-remote-input-validation.md) 删掉了 Client 端重复的 schema 执行，但保留了查找和业务调用之前的 Host 校验，以及本地的参数个数和上下文绑定检查。它写明的代价是：格式错误的输入更晚才失败，并且失去了 Client 解析附带的脱敏效果。

## 在使用时推导，或复用已有的投递所有者

对每个缓存或事件订阅，问清消费方什么时候需要这个值，以及是否已有权威来源保存着它。[反馈遥测](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-08-06-buffer-free-feedback-telemetry.md) 在反馈时读取规范的会话前缀，删掉了持续拷贝的反馈前缓冲区及其监听器。[推导工作区最近使用顺序](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-09-10-derived-workspace-recency.md) 对当前摘要排序，而不是持久化提升历史；手动排序仍是独立的用户状态。[Web 子 agent 投影](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-09-08-web-subagent-catalog-projections.md) 复用共享的流和投影存储，删掉了功能通知、重复读取和第二个成员缓存。

时机上的承诺决定这种做法是否成立。反馈时脱敏和捕获时脱敏是不同的；手动排序无法从活动时间戳推导出来；流缺少基线时，可能仍需要一次初始的历史读取。把这些剩余义务写出来，而不是宣称所有缓存都是多余的。

## 去掉偶然形成的组合所有者

在相信"demo"、"support"或"example"这类名字之前，先检查实际的启动和解析路径。[共享基础配置的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-07-29-shared-base-config-overlays.md) 删掉了重复的组合和透传设置；overlay 放在哪里由 Loader 的实际行为决定。[归属本地的 profile 与指南的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-08-24-owner-local-profile-tests-and-guides.md) 把测试、指南和发布资源分配给各自的所有者，删掉了一个只为解析而存在的 workspace。[合并子 agent 控制服务的决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-07-26-merge-subagent-control-service.md) 使用显式的部署策略，而不是从提供方或同级工具是否存在来推断，同时在内部保留了可选依赖。

包的数量变少本身不够。不同的调用意图可能有不同的所有权和完成时机；保留下来的服务定义可能服务于多个独立的提供方。要证明替代方案真实的组合和依赖行为，并计入所有剩余的配置和生命周期胶水代码。

## 用被否决的实验检验"等价"的说法

[SSE 解析器替换](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/archived/simplification/2026-07-26-eventsource-parser-for-deepseek-sse.md) 删掉了通用的分帧代码及其一致性测试，同时保留了提供方专用的终止处理适配层，并写明了对截断结尾更严格的行为。相反，[内置 timer promises 提案的否决](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/rejected/simplification/2026-07-26-builtin-timer-promises-for-hand-rolled-sleeps.md) 记录了一个名义上等价的内置功能，为了一点点删减，破坏了确定性的假时钟测试。[依赖替换审计](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/.agents/notes/rejected/simplification/2026-07-26-dependency-swaps-rejected-by-nih-audit.md) 区分了可以替换的通用代码，和库并不实现的配置上限、安全规则、生命周期所有权和部署行为。

过去的否决是有范围的反证，不是永久的禁用名单。只有拿出针对当初失败前提的新证据，才重新考虑它，并把实现、胶水代码、测试、依赖和所支持的行为放在一起衡量。

# 召回探针

用于 [分类](../SKILL.md#分类) 的探测命令。每一条命中都需要语义判断：探针按设计会多匹配，也必然会漏匹配，所以要配合不带模式地通读范围内文字最密集的部分。

## 调用规则

- 加 `--hidden --glob '!.git/**'`，以便搜索 `.agents/`；ripgrep 默认跳过点开头的目录。
- 排除条件放在最后，免得后面的包含条件把它们重新加回来：`--glob '!node_modules/**' --glob '!**/lib/**' --glob '!.agents/skills/amadeus-trim-cot-leakage/**'`（本 skill 自己的文件为了校准而引用了泄漏的措辞）。
- 自然语言的英文探针加 `-i`，让句首大写也能命中（"This PR adds…"、"Probably fine…"）；第一行匹配代码模式的探针保持区分大小写，否则 `\bT\d\b` 和 `\bP-I\b` 会变成噪音。
- 匹配完整短语。`\bthis PR\b` 必须能匹配 "this PR adds"，而不匹配 "this project"、"this process" 或 "this provider"。
- 一个零命中的模式在匹配到已知阳性例子之前什么也证明不了；一个噪音大的模式在排除相近的阴性例子之前也什么都证明不了。信任语料上的结果之前，两边都要校准。

## 中文探针

```sh
# 中文文档和注释中的变更叙述与评审过程。
rg -n --hidden '评审|上一?轮|旧版|老的|不再|以前|本版|这次|遗留|目前|暂时' --glob '*.md' ...

# 中文文字中的失效引用和计划残留。
rg -n --hidden '决策 ?\d|审计 ?[A-Z]?\d|设计 ?§|计划 ?§|§\d|应该够|应该没问题|先这样' ...

# 英文代码注释和 JSDoc 中夹带的中文工作片段。
rg -n --hidden '(^[[:space:]]*(//|/\*|\*)|//|/\*)[^\r\n]*(设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有|端)' --glob '*.{ts,tsx,js,jsx,mjs,cjs,css}' ...
```

## 英文探针

```sh
rg -n --hidden '\(decision \d|\(audit [A-Z]\d|design §|plan §|design ledger|\(B ruling|\bP-I\b|\bW\d\b|\bT\d\b' ...
rg -n --hidden -i '\bthis PR\b|\bthis branch\b|\bthis stack\b|\blater PRs?\b|\bprevious commits?\b|\bthis commit\b' ...
rg -n --hidden -i '\bused to\b|\bno longer\b|\bpreviously\b|\bthe old\b|\bwas renamed\b|\bwas moved\b' ...
rg -n --hidden -i '\bv1\b|this cut|\bcut \d|\btoday\b|\bfor now\b|roadmap' ...
rg -n --hidden -i 'rejected in review|review round|reviewer|as of v\d' ...
rg -n --hidden -i 'probably |should be enough|should suffice|it simply|is safe —|is safe --' ...
```

## 已知的误报类型

判断后保留，预计还会遇到：

- **工具性的 "used to"**："the key used to sign requests" 表示用途，不表示时间。时间性的用法前面有一个主语状态（"colors used to come from…"）。
- **运行时的新旧**："旧连接排空后新连接才开始接受请求" 指的是交接过程中的两个运行时对象，不是仓库状态。
- **流程文档里的 "PR"**：讲 PR 工作流本身的文档（模板、流程说明）合理地使用 "PR"；禁止的是文档站在某一个 PR 的视角描述代码。
- **作为协议或路径片段的 `v1`**：`/v1/chat` 这样的端点和传输格式名称是标识符，不是版本戳。
- **有已提交归属的 `§N`**：外部标准（RFC 9110 §10.1.5）和拥有自身章节编号的已提交文档可以按章节引用。
- **运行时的 "今天" 和录制的时间戳**：询问当前日期的 prompt 或测试使用的是运行时时间，不是仓库的版本戳；录制的 CLI 输出保留原样。到达模型或用户的措辞在修改前仍需遵守行为验证规则。
- **版本化语境中的 "本版本"**：在发布说明这类版本化的产物中，"本版本" 指这个发布，是合理的写法；禁止的是作为裸时间戳、等同于 "这次" 的 "本版"。

# Agent Note: Harness 选择的 subagent 子级

Status: implemented

[English](2026-09-24-harness-selected-subagent-children.md) | 中文

## 问题

subagent seam 的进程外产品提供方——`dsh-subagent-acp`、`dsh-subagent-codex` 与 `dsh-subagent-claude-code`（[能力 seam Agent Note](2026-06-21-subagent-capability-seam.zh.md)、[产品提供方 Agent Note](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)）——各自拥有私有传输层，每次调用启动一个产品进程，并返回父级作用域的 run，没有持久的子 `Session`。这样的子 agent 在 Web UI 中不可见，无法恢复或继续，且每个提供方都重复实现生命周期、cwd、能力与诊断管线。

Agent 注册表本就挂载多个 agent harness——进程内循环、Codex app-server 驱动与 ACP 驱动——且每个都产生持久 Session。然而被委派的子 agent 始终运行在父级的 harness 下，外部 harness Session 也无法调用 dsh 工具，因此外部父级根本无法委派。

## 决策

新建的子 agent 可以运行在任何已挂载的 agent harness 下。`SubagentStartRequest.harness` 指定 harness；`SubagentCapabilities.harness` 是可选字段，缺省表示不支持。`spawn` 声明该能力，并通过 `ctx.agents.create({ harness })` 把子 agent 创建为携带 `parentSession` 谱系的普通持久 Session。`fork` 不设置它，因为其父级历史种子只能在拥有父级日志的 harness 下继续；进程外提供方不设置它，因为它们的子 agent 不是已挂载的 harness。`ctx.subagents` 在任何子级工作开始前拒绝不受支持或未挂载的选择，一次性启动与可继续启动都一样。省略时保留拥有父级会话的 harness。

当提供方支持该能力且挂载了多个允许的 harness 时，`dsh-tool-subagent` 暴露面向模型的 `harness` 参数；可选的 `harnesses` 配置收窄可选范围，工具在执行时强制检查该允许列表。

harness 解析只有一个所有者。`AgentRegistry.resolveHarness(harness, 'create' | 'resume')` 返回一次 `create` 或 `resume` 调用会落到的已挂载 harness——指定的 harness；否则对 resume 取未记录日志的所有者；再否则取唯一挂载的 harness——subagent 代码调用它，而不是重复这些回退。`persona`、`toolFilter` 与 `outputSchema` 通过循环的作用域组合安装，因此除非解析出的 harness 声明 `AgentHarness.hostsLoopComposition`，否则会被拒绝；循环 harness 与 `AgentRegistry.setFactory` 声明了它。所解析 harness 不服务的请求提供方路由会被拒绝；当显式 harness 选择无法服务子 agent 仅从父级继承的路由时，该路由会被丢弃，由所选 harness 应用自己的默认值。非循环 harness 上的子 agent 在创建期间记录 `subagent/descriptor`，因为这类 harness 不发出 `agent/pre-step`。冷恢复读取子 agent 自己的 `agent/harness` 记录，当该 harness 不再挂载时拒绝。

harness 选择的子 agent 与任何进程内子 agent 获得相同的委派权限状态：沙箱覆盖、钉定为 `never` 的审批策略（[钉定 never 的 Agent Note](2026-08-10-subagent-approval-pinned-never.zh.md)）以及权限预设。ACP 驱动把该状态映射为无法逃出受限沙箱的 agent 模式：`read-only` 沙箱在任何审批策略下都选择 `ask` 或 `plan`；只有 `danger-full-access` 下的 `never` 才选择自动批准模式（`bypass` 或 `bypassPermissions`）；`workspace-write` 下的 `never` 选择 harness 自有的受控自主模式（`auto`、`smart` 或 `build`），使委派子级能够运行命令；可写沙箱上的 `ask` 会话选择接受编辑的模式，由审批策略回答其余每次请求。

`ctx.agentToolBridge` 通过经认证的逐 agent MCP 端点向外部 harness Session 提供 dsh 工具，包括 `subagent` 与 Agent Team 工具，因此每个经桥接的 harness 都能委派给每个已挂载 harness。每次绑定都会记录一条列出所服务工具名的 `agent-tool-bridge/exposed`。

`dsh-agent-external` 中的外部 harness 创建事务安排步骤顺序，使桥接能看到作用域工具。ACP 与 Codex 宿主设置 `announceBeforeBind`；进程内 loop 的绑定不快照任何内容，因此仍先绑定，再以实时分发进入并宣告。对设置了 `announceBeforeBind` 的宿主，调用方 setup 之后，宿主记录 `agent/harness`，用 `SessionStore.enter(session, { deferPublication: true })` 让 Session 进入存储，宣告 `session/created`，并等待 `agent/created` 监听器，它们安装该 agent 的作用域委派与 Team 工具。之后 `bind()` 才发送 `session/new` 或 `thread/start`，其工具快照因此包含这些工具。延迟进入会暂扣 `session/event` 分发。绑定成功后，宿主通过写句柄存储进入存储之前的日志，并调用 `SessionStore.publish(session)`，它按日志顺序把每个暂扣的追加分发给所有观察者；持久化经其实时路径写入它们。回滚的绑定从不分发暂扣的追加，因此被拒绝的握手不会留下任何已存储或已观察的内容，会话 id 仍可复用。延迟进入的 `SessionStore.flush()` 会等待发布，因此握手期间的检查点也覆盖暂扣的追加。

harness 选择的子 agent 是委派给外部产品的推荐路径。一次性产品提供方仍然可用：web-app 预设以 `disabled: true` 挂载 `subagent_codex` 与 `subagent_claude_code` 工具行，`dsh-subagent-acp` 可供挂载它的组合使用。`dsh-subagent-dsh-sdk` 仍是进程隔离后端：在内存或崩溃隔离比共享进程开销更重要的场景，它通过 TypeScript SDK 驱动独立的 Harness 子进程。

## 考虑过的替代方案

- **删除一次性产品提供方。**尚未把产品挂载为 harness 的部署，或依赖钉定的产品 CLI、产品专属诊断或每次调用一个一次性进程的部署，会失去其路由；默认禁用地保留它们，每个只需一行工具配置。
- **每对 harness 一个专用提供方。**每一对都会重复 `spawn` 已提供的持久 Session、策略钉定与能力拒绝语义，且对 Session UI 仍不可见。
- **在 `bind()` 之后运行 `agent/created`。**握手会快照工具集，之后安装的作用域工具永远到不了 `session/new` 或 `thread/start`。
- **在 `bind()` 之前发布 Session。**观察者与持久化会看到一次仍可能被拒绝的握手的创建事件，留下回滚无法撤回的残留；延迟发布把观察保持在提交点之后。
- **与固定的循环 harness id 比较。**以其他 id 注册的 harness 无法声明自己承载循环组合；`hostsLoopComposition` 让 harness 自行声明。

## 影响

委派给任何已挂载 harness 的成本是一份提供方实现加一行工具配置；harness 矩阵是任意到任意的，因为每个已挂载 harness 都可选，且每个经桥接的外部 Session 自身也能调用 `subagent`。harness 选择的子 agent 通过普通 Session 机制获得持久化、Web 可见性与可继续性。harness 选择的子 agent 的推理强度经由 `agentOptions.reasoningEffort` 设置，`spawn` 会将其合并进所选 harness 的子级选项。

放弃的部分：harness 选择的子 agent 的 Session 与驱动位于父级的 Harness 进程中，因此隔离仍选用 `dsh-subagent-dsh-sdk`；外部 harness 上不能使用仅循环可用的选项；harness 已卸载的可继续子 agent 无法冷恢复；`session/event` 观察者在发布时才收到创建窗口内的追加，而不是在每次追加提交时收到。预设不安装也不认证外部产品——挂载 harness 属于宿主组合的工作。将 harness 子 agent 的审批路由到父会话仍属延后事项。

## 测试

`packages/subagent/subagent/tests/service.spec.ts` 覆盖能力与未挂载 harness 的拒绝；`continuation-inheritance.spec.ts` 覆盖仅循环选项的拒绝、带种子子 agent 的所有权，以及按子 agent 记录的 harness 冷恢复，包括该 harness 未挂载时的拒绝；`packages/subagent/subagent-in-process-driver/tests/subagent-in-process-driver.spec.ts` 覆盖路由兼容性与被丢弃的继承路由；`packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` 覆盖 `harness` 参数、`harnesses` 允许列表与 schema 重建。`packages/core/agent/tests/harness.spec.ts` 覆盖 `resolveHarness`。`packages/core/session/tests/session.spec.ts` 覆盖暂扣分发、按序发布，以及从不分发的已回滚延迟进入。`packages/core/agent-acp/tests/tool-bridge.spec.ts` 覆盖 `agent/created` 作用域工具进入握手快照，`agent-acp.spec.ts` 覆盖模式映射。`snapshots/session/acp-bridged-subagent` 录制外部 harness 父级经 `agentToolBridge` 触达 `subagent` 工具。

一次无头真实模型验证在 `web` profile 上运行（团队行另加 Agent Team 叠加层），经远程 RPC 驱动 `session/create` 与 `session/prompt`，并读取持久化 Session 日志。委派调用在子 Session 以所请求运行时记录 `agent/harness` 且子级回复进入父级工具结果时计为确认；经桥接的父级与队友还会在绑定时记录一条 `agent-tool-bridge/exposed`，列出所服务的工具——当外部 harness 报告缺少委派或 Team 工具时，这是要检查的特征。

已确认的 `subagent` 配对：

| 父 harness | 子 harness | 工具路径 |
|---|---|---|
| `dsh` | `dsh` | 进程内 `subagent` |
| `dsh` | `devin` | 进程内 `subagent` |
| `devin` | `dsh` | 桥接 `subagent` |
| `codex` | `devin` | 桥接 `subagent` |
| `codex` | `dsh` | 桥接 `subagent` |
| `claude` | `dsh` | 桥接 `subagent` |
| `claude` | `devin` | 桥接 `subagent` |

已确认的 `spawn_teammate` 配对：

| Lead harness | 队友 harness | 说明 |
|---|---|---|
| `dsh` | `dsh` | 同运行时默认 |
| `devin` | `devin` | 队友经桥接暴露九个 Team 工具 |
| `claude` | `claude` | 同运行时默认 |
| `dsh` | `devin` | 跨 harness，走目标默认路由 |
| `devin` | `dsh` | 跨 harness，显式给出 `provider`/`model` |

覆盖缺口：`grok`、`opencode` 与 `mimo` 既未作为父级也未作为子级验证，但它们与已确认的 ACP harness 走相同的 `agent-acp` 绑定路径；`codex` 与 `claude` 未作为跨 harness 团队成员验证；在此 profile 下，由外部父级选择的 `dsh` 子级没有默认路由，`spawn_teammate` 必须传入 `provider`/`model`，否则循环的 `{{model}}` 装配会拒绝首轮。

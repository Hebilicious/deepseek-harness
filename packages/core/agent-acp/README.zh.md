---
description: "dsh 的多 harness ACP 会话驱动器：每个已配置 harness 一个共享进程，每个 dsh 会话一个 ACP 会话，模型选择器按 harness 提供目录，认证 Remote 按 harness 划分。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-acp

[English](README.md) | 中文

## 概述

让 agent（智能体）会话运行在 ACP harness 上而不是进程内循环上。一个插件实例可同时驱动多个 harness（Devin、Grok Build、opencode、mimocode，或任何其他 ACP agent）：每个 harness 拥有自己的共享进程、自己的 agent 注册表身份，以及自己在模型选择器中的路由。每个会话都在所属 harness 的进程上绑定自己的 ACP 会话：提示词以 `session/prompt` 发出，更新以持久的 assistant 与工具事件返回，权限请求路由进 dsh 审批 seam。harness 保有循环、提示词、工具、MCP 服务器与配置；dsh 保有会话、transcript（文本记录）、审批、通知与选择器。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当会话应运行在 ACP harness 账号而不是 dsh 模型路由上时，挂载本提供方。[`dsh-web-acp`](../../bundle/web-acp/README.zh.md) bundle 为浏览器界面挂载它，任何组合也可以自行添加该配置行。

### 何时选择

当希望由某个 harness 自带的循环、提示词、工具、MCP 服务器与配置服务该会话，且双方能就 Agent Client Protocol 达成一致时，选择本驱动器。每个已配置条目都会在 `ctx.agents` 中注册一个 harness，因此会话调用方需指名其想要的 harness，而持久的 `agent/harness` 记录会让恢复停留在同一个 harness 上。进程内的 [`dsh-agent-loop`](../agent-loop/README.zh.md) 注册为独立的 `dsh` harness，因此一个 profile 可以同时提供两者，由调用方选择。

### 配置

```yaml
- id: agent-acp
  name: '@deepseek-ai/dsh-agent-acp'
  config:
    harnesses:
      - id: devin
        name: Devin
        description: Devin runs the session through devin acp
        executable: devin
        args: ['acp']
      - id: grok
        name: Grok Build
        description: xAI Grok Build runs the session through grok agent
        executable: grok
        args: ['agent', '--no-leader', 'stdio']
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `harnesses` | 必填 | 本插件实例驱动的 ACP harness 条目；id 必须唯一 |
| `harnesses[].id` | 必填 | 小写 slug；`ctx.agents` 的 harness id，也是 `ctx.llm` 的目录路由 |
| `harnesses[].name` | 必填 | harness 选择器中的人类可读名称 |
| `harnesses[].description` | — | 一句话说明由什么运行会话 |
| `harnesses[].executable` | 必填 | harness 可执行文件名或绝对路径 |
| `harnesses[].args` | `['acp']` | 可执行文件之后的参数 |
| `harnesses[].cwd` | `process.cwd()` | harness 进程自身的工作目录；会话各自携带自己的工作目录 |
| `harnesses[].env` | `{}` | 叠加在已清洗父环境之上的显式环境变量 |
| `harnesses[].sandbox` | `workspace-write` | 未记录 `sandbox/mode` 覆盖的会话所使用的文件系统沙箱 |
| `harnesses[].approval` | `ask` | 未记录 `approval/policy` 覆盖的会话所使用的审批路由 |
| `harnesses[].mode` | — | 对会话 `mode` 配置选项的部署级覆盖 |
| `harnesses[].model` | — | 位于会话 `model/selection` 之下的部署默认值 |
| `harnesses[].reasoningEffort` | — | 位于会话选择之下的部署默认值 |
| `harnesses[].catalogArgs` | — | 模型目录 CLI 参数；省略时目录仅取自会话声明 |
| `harnesses[].authStatusArgs` | `['auth', 'status']` | 认证状态命令参数 |
| `harnesses[].authLogoutArgs` | `['auth', 'logout']` | 认证登出命令参数 |
| `disposeGraceMs` | `5000` | 受管范围终止层级之间的宽限期 |
| `eofGraceMs` | `2000` | stdin EOF 之后、升级终止之前的窗口 |
| `cliTimeoutMs` | `180000` | 单个一次性 CLI 动词的截止时间，超时后驱动器放弃该调用 |

### 首个会话之前

每个 harness 都需要各自已认证的 CLI：运行一次 `devin auth login`、`grok login` 或该 harness 对应的命令，或通过 `acp` Remote 的 `login` 方法启动其浏览器流程。该服务同时上报 agent 声明的认证方法与该 harness 认证状态 CLI 的判定结果，因此设置界面可以指出缺失的是哪一半。`acp` Remote 接收 harness id：`status({harness})`、`login({harness, methodId})` 与 `logout({harness})`；没有条目挂载该 id 时会以 `gateway/bad-request` 失败并列出已挂载的 id。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 每个 harness 一个运行时

每个已配置条目构建自己的 `AcpRuntime`，它惰性启动该 harness 的进程，并记忆其连接与 agent 的 initialize 响应。ACP SDK 校验入站帧；驱动器自有的 `AcpClientConnection` 把握手固定为 `clientCapabilities: {}`，因此 harness 自行服务其文件系统与终端工作，而不是回调 dsh，并按 `sessionId` 把每条通知与请求路由到已注册的 peer。端点会被记忆直到子进程退出或连接失败，随后被退役，因此下一次 `connect()` 会启动新的子进程。每个运行时、其 agent 工厂宿主与其目录路由都处于各自的 effect 中，因此卸载插件会恰好处置每个 harness 的进程一次。同一个运行时通过同一个子进程 seam 运行该条目的短命令（`catalogArgs`、`authStatusArgs`、`authLogoutArgs`），每个都受 `cliTimeoutMs` 约束。

### agent 注册表身份

每个条目构建自己的 `AcpAgentHost`，它通过 `ctx.agents.registerHarness` 注册 `{id, name, description, factory}`。`ctx.agents.create` 与 `ctx.agents.resume` 按 harness id 分派，每个宿主都会向它发布的会话追加持久的 `agent/harness` 记录，因此指名其他 harness 的恢复会被拒绝，而不是重放该 harness 无法驱动的对话。

### 会话绑定

`bind()` 加入所属 harness 的共享连接，并在 dsh 会话发布之前创建 ACP 会话（`session/new`）或加载已记录的那个（`session/load`）。新会话追加带 agent 所发 id 的 `agent-acp/session`；恢复要求 agent 声明 `loadSession`，否则驱动器以 `session "<id>" cannot resume: the agent does not advertise loadSession` 明确失败。peer 只在加载响应之后注册，因此重放的历史绝不会重复提交。会话声明还会重新发布该 harness 的模型目录。

### 轮次驱动

一次 `session/prompt` 就是一个持久的 dsh 步骤。`agent_message_chunk` 与 `agent_thought_chunk` 更新汇入 assistant 流，`tool_call` 与 `tool_call_update` 提交持久的工具事件对，`plan` 渲染为文本块，`config_option_update` 刷新会话已知的配置选项。响应的停止原因映射为轮次结束：`end_turn` 完成，`max_tokens` 记录上限，`cancelled` 以用户原因中止，`refusal` 或 `max_turn_requests` 以固定错误码失败。若轮次结束时仍有未关闭的工具调用或 assistant 流，驱动器会为其收尾，因此不会留下悬空的模型可见内容。

### 模型目录

每个 harness id 同时也是一个 `ctx.llm` 提供方路由，由为该 id 注册的 `AcpCatalogAdapter` 服务。目录就是该 harness 自己的会话声明：agent 发送 `models.availableModels` 时用它，否则用 `model` 配置选项的可选值。已绑定会话最近一次非空声明胜出，因此选择器反映正在运行的 harness。配置了 `catalogArgs` 的条目还会在尚无会话声明时运行该 CLI 列表命令；未配置时，尚无绑定会话的 harness 不列出任何模型。该路由不提供 stream，流请求会明确失败。

### 权限、模式与推理强度

`session/request_permission` 路由进 `ctx.approval`；`form` 模式的 `elicitation/create` 在其 schema 是字符串与枚举字段的扁平对象时路由进 `ctx.userQuestions`。没有审批服务、没有活动轮次或 schema 更复杂时，驱动器选择拒绝或取消而不是猜测。每次提示词之前，驱动器用 `session/set_config_option` 应用会话的选择，且仅限会话声明过的选项：`model` 携带持久选择或部署默认值，已声明的推理强度选项（Devin 的 `thought_level`、Grok Build 的 `reasoning_effort`，或任何属于 ACP `thought_level` 分类的选项）携带会话强度或部署默认值，`mode` 携带 DSH 沙箱与审批旋钮。harness 未声明的请求值会被记录一次日志，并附上实际会运行的值，绝不静默丢弃。

### 认证操作

`acpHarness` 服务在 `acp` 命名空间发布一个 Remote：`status`、`login` 与 `logout`，各自接收 harness id。登出在 agent 声明时优先使用 ACP `logout` 请求，否则运行该条目的 `authLogoutArgs`，因为随包发布的 Devin 把 `agentCapabilities.auth` 回答为 `{}`。

### 源码导图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `acpHarness` 服务：逐条目的运行时、宿主、目录路由与认证 Remote |
| [`src/config.ts`](src/config.ts) | harness 条目、静态 Config schema 与默认值解析 |
| [`src/agent.ts`](src/agent.ts) | `AcpAgent`：会话生命周期、轮次驱动、更新投影、权限 |
| [`src/host.ts`](src/host.ts) | `AcpAgentHost`：注册一个 harness 并把其运行时绑定进每个 agent |
| [`src/runtime.ts`](src/runtime.ts) | `AcpRuntime`：单个 harness 的进程、连接、CLI 动词与模型目录 |
| [`src/connection.ts`](src/connection.ts) | `AcpClientConnection`：握手、会话路由、致命状态观测 |
| [`src/protocol.ts`](src/protocol.ts) | 停止原因、工具内容、提示词块、权限结果、配置选项与会话声明 |
| [`src/catalog.ts`](src/catalog.ts) | `AcpCatalogAdapter`：某个 harness id 的纯目录路由 |
| [`src/session-state.ts`](src/session-state.ts) | `agent-acp/session` 事件及其投影 |
| [`src/types.ts`](src/types.ts) | 客户端安全的账号负载、目录条目与 Remote 错误码 |
| [`tests/agent-acp.spec.ts`](tests/agent-acp.spec.ts) | 基于 mock ACP agent 的轮次、会话、权限、模式、认证与目录行为 |
| [`tests/agent-edge.spec.ts`](tests/agent-edge.spec.ts) | 更新变体、附件、拒绝、会话级覆盖与退化 agent 响应 |
| [`tests/multi-harness.spec.ts`](tests/multi-harness.spec.ts) | 单插件多 harness：路由、恢复、认证作用域、目录与选项应用 |
| [`tests/catalog.spec.ts`](tests/catalog.spec.ts) | 目录路由：会话声明、配置选项回退、缺失目录与提供方名称 |
| [`tests/config.spec.ts`](tests/config.spec.ts) | 条目默认值与无法挂载的 harness 列表的明确拒绝 |
| [`tests/runtime.spec.ts`](tests/runtime.spec.ts) | 运行时生命周期：握手中途处置、子进程死亡后重启、CLI 动词、取消 |
| [`tests/service.spec.ts`](tests/service.spec.ts) | 已挂载 harness 身份与 Remote 错误归一化 |
| [`tests/protocol.spec.ts`](tests/protocol.spec.ts) | 不启动子进程的纯 wire 辅助函数映射 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 插件在真实 Loader 树中挂载并注册 |
| — | 未发布运行时 invariant 伴随包：持久关系是 `agent-acp/session` 折叠与共享投影器提交的会话事件，二者都由其所属包断言。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-agent-external](../agent-external/README.zh.md)——本驱动器所基于的驱动器基类、inbox 与 create/resume/publish 事务。
- [dsh-agent](../agent/README.zh.md)——每个条目注册进的 harness 注册表，以及 create/resume 的分派入口。
- [dsh-web-acp](../../bundle/web-acp/README.zh.md)——在浏览器 profile 中运行本驱动器的 bundle。
- [dsh-agent-loop](../agent-loop/README.zh.md)——作为独立 `dsh` harness 与本驱动器并存的进程内驱动器。
- [Agent Client Protocol](https://agentclientprotocol.com)——本驱动器与每个 ACP harness 共同遵循的公开协议规范。
- [核心子系统](../../../docs/subsystems/core.zh.md)——驱动器所实现的 `Agent` 约定与轮次流程。

-----

<a id="model-experience"></a>
## 模型体验

### harness 轮次

#### 模型看到什么

被认领的用户输入会转换为 ACP 提示词块：文本原样传递，能解析出宿主路径的文件或图片附件变为 ACP `resource_link` 块。路径无法解析的附件降级为 `[file: name]` 占位符，而不是让轮次失败。模型看到的其他内容（harness 的提示词、先前轮次与工具定义）都属于 harness 进程，而不属于 dsh。

#### Token 影响

dsh 每轮只贡献新的用户输入；harness 为自身的提示词、历史与工具 schema 付费。harness 以 `agent_thought_chunk` 流式输出的推理文本会记入 dsh transcript，但 dsh 绝不回传，因为 harness 自己的上下文已经持有它。

#### KV Cache 影响

请求前缀由 harness 拥有，因此 dsh 既无法保证也无法度量复用。在同一个 ACP 会话内，只要模型与模式不变，前缀就是只追加的；改动其中任何一项都会发起一个此前缀可能无法匹配的请求。

### 会话模式与模型选择

#### 模型看到什么

每次提示词之前，驱动器用 `session/set_config_option` 应用会话的选择：`model` 选项携带持久的 `model/selection` 或部署默认值，推理强度选项携带会话选中的强度，`mode` 选项携带沙箱与审批旋钮。会话未声明的值会被记录日志，并附上实际会运行的值；持久的 `request/header` 记录 harness 自报的模型，会话未声明模型选项时则为 `agent-default`。

#### Token 影响

没有直接的 token 成本。所应用的模型、模式与推理强度会改变 harness 为该轮执行多少推理与工具工作。

#### KV Cache 影响

更换模型会替换路由，因此按先前模型缓存的前缀不会被复用。当模型与历史不变时，仅改变模式或推理强度不会影响 token 前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本驱动器何时是错误选择或需要运维注意。它们是当前的包约束，不是任务清单。

- **Devin 没有只读权限模式**——ACP 会话模式为 `accept-edits`、`smart`、`ask`、`plan` 与 `bypass`。没有任何一个把 agent 限制为只读，因此 dsh 的 `read-only` 沙箱无法由 Devin 强制执行；驱动器会记录一条日志，指明会话实际运行的模式，而不是假装已应用。
- **某个 harness 可能没有为 DSH 旋钮提供模式**——opencode 与 mimocode 声明 `build` 与 `plan`，因此驱动器为可写会话应用 `build`；当只提供 `plan`（或什么都没有）时，记录一条日志指明请求与实际生效的模式。永远会记录日志，绝不静默跳过。
- **每个 harness 拥有轮次，dsh 拥有外壳**——循环、提示词、工具、MCP 服务器与配置都在 harness 内。DSH 保有持久会话、transcript、审批、通知与模型选择器；驱动器每轮转发模型选择，并上报 harness 自报的当前模型。
- **每个 harness 需要各自的登录**——会话需要每个 harness 已登录的 CLI（`devin auth login`、`grok login` 等）；dsh 既不存储也不提供这些凭据。
- **目录需要已绑定的会话**——选择器路由依据活动会话的声明作答，因此尚无会话的条目不会列出任何模型，除非部署为其配置了 `catalogArgs`。CLI 目录较慢的 harness（Devin 会通过网络刷新）会让每次选择器读取都等待它，并受调用方 signal 与 `cliTimeoutMs` 约束。
- **受限子进程中的目录写入可能失败**——在 Linux 上，本地子进程提供方的 systemd-scope 路径会让子进程的 stdout 处于非阻塞状态，因此 Devin 约 180 KB 的目录写入可能以 `exited 101 ... Resource temporarily unavailable (os error 11)` 失败；驱动器上报 CLI 的退出码与 stderr 末尾，该 stdio 缺陷属于子进程提供方，而非本包。
- **会话只能在其记录的 harness 上恢复**——持久的 `agent/harness` 记录决定恢复路由，其他 harness 会拒绝该会话，而不是重放它无法驱动的对话。
- **没有轮次中途转向**——ACP 不携带转向通道，因此 `steer()` 输入会留在队列中等待下一轮，而不会到达正在运行的轮次。
- **未声明 `loadSession` 时已记录会话无法恢复**——不声明该能力的 agent 会让绑定失败，而不是静默开始一个新会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>

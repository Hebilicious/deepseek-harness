---
description: "dsh 的 Codex 会话驱动器：每个已配置条目一个 app-server 实例，每个会话一个 Codex 线程，按 harness 划分的账号操作，并把 Codex 模型放进选择器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

[English](README.md) | 中文

## 概述

让 agent（智能体）会话运行在 Codex 上而不是进程内循环上。一个插件实例可驱动一个或多个 Codex 实例，每个实例拥有自己的 `codex app-server` 进程、`CODEX_HOME`、凭据，以及自己在模型选择器中的路由；每个会话绑定自己的 Codex 线程。驱动器通过 JSON-RPC 转发每个轮次，把 Codex 条目投影为会话事件，把 Codex 审批请求路由进 dsh 审批 seam，并暴露账号操作。挂载 `agentToolBridge` 后，会话的 dsh 工具会以一个经过认证的回环 MCP 端点的形式借给线程。Codex 保有循环、提示词、工具与配置；dsh 保有会话、transcript（文本记录）、审批与模型选择器。

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

当会话应运行在 Codex 账号而不是 dsh 模型路由上时，挂载本提供方。[`dsh-web-codex`](../../bundle/web-codex/README.zh.md) bundle 为浏览器界面挂载它并带一个 `codex` 实例，任何组合也可以自行添加该配置行。

### 何时选择

当希望由 Codex 自带的循环、提示词、工具、MCP 服务器与 `config.toml` 服务该会话时，选择本驱动器。每个已配置条目都会以自身 id 在 `ctx.agents` 中注册一个 agent harness，并以该 id 作为自己在模型选择器中的路由，因此一个 profile 可以把它与 [`dsh-agent-loop`](../agent-loop/README.zh.md) 以及任意 ACP harness 一起挂载，也可以让工作账号与个人账号并行。随包发布的 `dsh-web-codex` bundle 仍会禁用循环行，使该 profile 只运行 Codex。

### 配置

```yaml
- id: agent-codex
  name: '@deepseek-ai/dsh-agent-codex'
  config:
    harnesses:
      - id: work
        name: Work Codex
        description: OpenAI Codex runs the session through codex app-server
        codexHome: /home/me/.codex-work
        sandbox: workspace-write
      - id: personal
        name: Personal Codex
        codexHome: /home/me/.codex-personal
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `harnesses` | 必填 | 本插件实例驱动的 Codex 实例条目；id 必须唯一 |
| `harnesses[].id` | `codex` | 小写 slug；`ctx.agents` 的 harness id，也是 `ctx.llm` 的目录路由 |
| `harnesses[].name` | `Codex` | harness 选择器中的人类可读名称 |
| `harnesses[].description` | — | 一句话说明由什么运行会话 |
| `harnesses[].executable` | `codex` | Codex 可执行文件名或绝对路径 |
| `harnesses[].args` | `['app-server']` | 可执行文件之后的参数 |
| `harnesses[].codexHome` | `~/.codex` | 交给子进程的 `CODEX_HOME`；拥有认证、`config.toml`、MCP 服务器与钩子 |
| `harnesses[].env` | `{}` | 叠加在已清洗父环境之上的显式环境变量 |
| `harnesses[].sandbox` | `workspace-write` | 未记录 `sandbox/mode` 覆盖的会话所使用的文件系统沙箱 |
| `harnesses[].networkAccess` | `false` | 结构化沙箱策略中的 `networkAccess` 成员 |
| `harnesses[].approval` | `ask` | `ask` 映射为 Codex 的 `on-request` 审批，`never` 映射为不审批 |
| `harnesses[].model` | — | 位于会话 `model/selection` 之下的部署默认值 |
| `harnesses[].reasoningEffort` | — | 位于会话选择之下的部署默认值 |
| `harnesses[].credentialRef` | — | 为无人值守的 `account/login/start {type:'apiKey'}` 解析的凭据引用 |
| `disposeGraceMs` | `5000` | 受管范围终止层级之间的宽限期 |
| `eofGraceMs` | `2000` | stdin EOF 之后、升级终止之前的窗口 |

### 首个会话之前

当某个实例的 app-server 报告的账号未认证且要求 OpenAI 认证时，驱动器拒绝为该实例绑定会话。此时 `bind()` 抛出 `agent-codex: Codex is not authenticated; sign in through the settings panel or run`，其后是 `codex login` 命令。请针对该实例的 `CODEX_HOME` 运行一次 `codex login`，或设置它的 `credentialRef`，让无人值守部署可以通过 `account/login/start` 发送 API key。`codex` Remote 接收实例 id：`status({harness})`、`loginDeviceCode({harness})`、`loginBrowser({harness})`、`cancelLogin({harness, loginId})`、`logout({harness})`、`rateLimits({harness})` 与 `events({harness})`；没有条目挂载该 id 时会以 `gateway/bad-request` 失败并列出已挂载的 id。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 每个实例一个运行时

每个已配置条目构建自己的 `CodexAppServerRuntime`，它在该实例首个会话绑定时惰性启动 `codex app-server` 并记忆该连接，因此同一实例上的并发绑定共享同一次握手。运行时把线程范围的服务器请求与通知路由到拥有该线程 id 的 agent；某个 peer 自身的失败只停留在该 peer 上，而传输失败会使该实例的连接对其所有线程失效。退役子进程会清除记忆，因此下一次 `connect()` 会启动新的进程，而不是交回一个已死的端点。

### 实例身份

每个条目构建自己的 `CodexAgentHost`，它通过 `ctx.agents.registerHarness` 注册 `{id, name, description, factory}`。`ctx.agents.create` 与 `ctx.agents.resume` 按 harness id 分派，每个宿主都会向自己发布的会话追加持久 `agent/harness` 记录，因此另一个实例会拒绝该会话，而不会重放一段它无法驱动的对话。未指定 harness 的创建在仅挂载一个实例时解析到该实例，挂载多个实例时则明确失败。每个运行时、其宿主与其目录路由都处于各自的 effect 中，因此卸载插件会恰好处置每个实例的进程一次。

### 线程绑定

`bind()` 加入所属实例的连接、证明账号已认证，然后恢复已记录的线程或启动新线程，全部发生在会话发布之前。全新的 `thread/start` 以 `ephemeral: false` 运行并追加 `agent-codex/thread`；已记录的线程以 `excludeTurns: true` 恢复。若 Codex 对一个从未收到提示词的线程返回 `-32600 no rollout found`，驱动器会记录警告并启动新线程；其他任何拒绝都保持致命，而恢复出的 id 与记录值不一致属于协议错误。`unbind()` 在该实例进程仍然存活时发送 `thread/unsubscribe`。

### 桥接的 dsh 工具

当部署挂载了 [`ctx.agentToolBridge`](../agent-tool-bridge/README.zh.md) 时，`bind()` 为该 agent 打开一个经过认证的回环 MCP 端点，并以 `mcp_servers.<name>` 配置覆盖的形式——携带其 URL 与 `Authorization` bearer 请求头——同时传给 `thread/start` 与 `thread/resume`，使 Codex 在其自身的 MCP 集成下加载该会话的 dsh 工具。Codex 以 `mcp__<name>__<tool>` 上报每次桥接调用；共享投影器通过桥解析该名称并把调用记录为 dsh 工具名；当工具声明了 `presentationMeta` 时，其结果携带该执行的 `meta`。`thread/resume` 没有 `dynamicTools` 成员，因此端点经由两个请求都接受的 `config` 覆盖传入，而不使用实验性的动态工具 API。持久的 `agent-tool-bridge/exposed` 事件记录的是一次端点凭证的签发以及端点打开时的工具列表——即使绑定随后回滚、该端点从未服务过任何线程，这条记录也会留下。每次绑定都打开一个带全新凭证的新端点；`unbind()`——或回滚的绑定——将其关闭并吊销该 token。未挂载桥时，线程请求不携带 `config` 成员。

### 轮次驱动

一个 Codex 轮次就是一个持久 dsh 步骤。`turn/start` 携带已认领的输入、`clientUserMessageId`、生效的审批策略与沙箱策略，以及选定的 `model`/`effort`；通知通过 `ExternalTurnProjector` 流式进入。轮次 id 在 `turn/started` 或 `turn/start` 响应提交它之前都是临时的，先到达的帧会被缓冲并重放。`turn/completed` 把 `completed` 映射为已完成轮次、`interrupted` 映射为已中止轮次，把 `failed` 映射为 `max-tokens` 或由 Codex 失败类别推导出的错误码。被中断或失败的轮次仍会结算其未完成的工具条目与 assistant 流，因此不会有悬空的 `tool/call` 残留。

### 审批、提问与 elicitation

Codex 的命令、文件变更与权限请求通过 `ctx.approval` 路由；`item/tool/requestUserInput` 与 `mcpServer/elicitation/request` 通过 `ctx.userQuestions` 路由。两个服务都未挂载、或没有进行中的轮次时，每个请求都会被拒绝而不是自动批准。schema 为字符串、枚举、布尔或数字字段的扁平对象的 elicitation 会变成每个字段一个问题；更复杂的 schema 会拒绝，而不是编造内容。

### 账号操作

`codexAppServer` 服务在 `codex` 命名空间中发布一个按 harness 划分的 Remote：`status`、`loginDeviceCode`、`loginBrowser`、`cancelLogin`、`logout`、`rateLimits`，以及账号通知的 `events` 流，每个方法都指名一个已挂载实例。未知 id 会以 `gateway/bad-request` 失败并列出已挂载的 id。`credentialRef` 为每个实例最多驱动一次 `account/login/start {type:'apiKey'}`，且 key 值绝不进入日志或 transcript。

### 模型目录

每个实例 id 同时也是一个 `ctx.llm` 提供方路由，由为该 id 注册的 `CodexCatalogAdapter` 提供服务。选择器的每次读取都通过该实例自己的连接遍历其 `model/list`，因此两个实例可以提供不同账号的目录。该路由不提供任何流，流请求会明确失败。

### 源码导览

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `codexAppServer` 服务：逐条目的运行时、宿主、目录路由与账号 Remote |
| [`src/config.ts`](src/config.ts) | 实例条目、静态 Config schema 与默认值解析 |
| [`src/agent.ts`](src/agent.ts) | `CodexAgent`：线程生命周期、轮次驱动、条目投影、审批、工具桥接端点 |
| [`src/host.ts`](src/host.ts) | `CodexAgentHost`：注册一个实例并把其运行时绑定进每个 agent |
| [`src/runtime.ts`](src/runtime.ts) | `CodexAppServerRuntime`：单个实例的进程、连接、线程路由、账号调用与 `model/list` |
| [`src/connection.ts`](src/connection.ts) | `CodexAppServerConnection`：行传输、握手、请求/通知分派 |
| [`src/protocol.ts`](src/protocol.ts) | 线上解码、权限模式、终止轮次状态、失败分类 |
| [`src/catalog.ts`](src/catalog.ts) | `CodexCatalogAdapter`：单个实例 id 的仅目录路由 |
| [`src/thread-state.ts`](src/thread-state.ts) | `agent-codex/thread` 事件及其投影 |
| [`src/types.ts`](src/types.ts) | 客户端安全的账号载荷与 Remote 错误码 |
| [`tests/agent-codex.spec.ts`](tests/agent-codex.spec.ts) | 基于 mock app-server 的轮次、线程、审批、账号与工具桥行为 |
| [`tests/multi-instance.spec.ts`](tests/multi-instance.spec.ts) | 一个插件中的多个实例：路由、home、恢复、账号范围与处置 |
| [`tests/config.spec.ts`](tests/config.spec.ts) | 条目默认值，以及无法挂载的实例列表所引发的明确拒绝 |
| [`tests/service.spec.ts`](tests/service.spec.ts) | 已挂载的实例身份，以及 Remote 的范围与错误归一化 |
| [`tests/runtime-lifecycle.spec.ts`](tests/runtime-lifecycle.spec.ts) | 进程启动、退役与处置 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 插件通过真实 Loader 树挂载并注册 |
| — | 不发布运行时不变式伴随包：持久关系是 `agent-codex/thread` 折叠与共享投影器提交的会话事件，二者都由其所属包断言。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-agent-external](../agent-external/README.zh.md)——本驱动器所基于的驱动器基类、inbox 与创建/恢复/发布事务。
- [dsh-agent](../agent/README.zh.md)——每个条目注册进的 harness 注册表，以及创建/恢复的分派入口。
- [dsh-web-codex](../../bundle/web-codex/README.zh.md)——在本驱动器上运行浏览器 profile 的 bundle。
- [dsh-agent-loop](../agent-loop/README.zh.md)——profile 作为 `dsh` harness 与本驱动器并行挂载的进程内驱动器。
- [核心子系统](../../../docs/subsystems/core.zh.md)——驱动器所实现的 `Agent` 约定与轮次流程。

-----

<a id="model-experience"></a>
## 模型体验

### Codex harness 轮次

#### 模型看到什么

已认领的用户输入以 Codex `UserInput` 条目的形式转发：文本块原样通过，带可解析附件路径的图片变成 `localImage`，文件变成其确定性句柄文本。模型看到的其余内容——Codex 的系统提示词、更早的轮次与其工具定义——都属于 Codex 进程，而不属于 dsh；已挂载的 `agentToolBridge` 会把该会话的 dsh 工具作为一台 MCP 服务器的条目加进来。

#### token 影响

dsh 每个轮次只贡献新的用户输入；Codex 为其提示词、历史与它向模型提供的工具 schema 付费，桥接的 dsh 工具也在其中。驱动器无法转发的输入块会让该轮次以 `agent-codex: Codex sessions cannot forward ... input blocks` 错误失败，而不是被静默丢弃。

#### KV 缓存影响

Codex 拥有请求前缀，因此 dsh 既无法保证也无法度量复用。在同一个 Codex 线程内，只要模型与线程设置不变，前缀就是只追加的；更改 `model`、`effort` 或权限策略会发起一个前缀可能不匹配的请求。

### 模型选择器目录

#### 模型看到什么

每个实例 id 都是一个 `ctx.llm` 路由，其条目来自该实例的 `model/list`，包括每个模型的显示名与推理强度菜单。选择器的选择以 `turn/start` 的 `model` 与 `effort` 成员到达轮次，持久的 `request/header` 记录实际运行的内容。harness 把实例 id 注册为自己的 `modelProvider`，因此选择器只为该实例运行的 Session 列出这一路由，`session.selectModel` 也会拒绝这些 Session 选择其他路由。

#### token 影响

没有直接的 token 成本。所选的推理强度改变 Codex 在该轮次花费的思考 token 数量。

#### KV 缓存影响

模型或强度变化会替换该路由；上一个路由下缓存的前缀不会被复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了本驱动器何时是不当选择或需要运维留意。它们是本包当前的约束，而不是任务清单。

- **`dsh-web-codex` bundle 让其 profile 只运行 Codex**——它禁用了 `agent-loop` 行。驱动器自身不需要这种排除：多 harness 的 profile 会把它与循环以及各 ACP harness 一起挂载。
- **多个 Codex 账号需要多个条目**——挂载两个 id 不同的 `harnesses` 条目，即可让同一个 `codex` CLI 的两个实例并行；每个条目拥有自己的进程、`codexHome`、`credentialRef` 与目录路由，因此一次 `codex login` 或一个 API key 只作用于声明它的那个实例。
- **Codex 拥有轮次，dsh 拥有外壳**——循环、提示词、工具、MCP 服务器与配置都住在 Codex 里，而已挂载的 `agentToolBridge` 会把该会话的 dsh 工具作为又一台这样的 MCP 服务器借给线程。DSH 保有持久会话、transcript、审批、通知与模型选择器；驱动器按轮次转发模型选择，并报告 harness 自身当前使用的模型，在 Codex 从未报告时回退到 `agent-default`。
- **`config.toml` 中的 `[mcp_servers.dsh]` 会被遮蔽**——绑定时下发的 `mcp_servers.<name>` 配置覆盖对每个已绑定会话生效，实例 `config.toml` 中以桥所用名字声明的 MCP 服务器会被覆盖；为 `agentToolBridge` 配置另一个 `serverName` 即可让两者并存。
- **Codex 账号是必需项，本包不提供**——会话需要带有已完成 `codex login` 的 `CODEX_HOME`，或为 API-key 路径提供 `credentialRef`；dsh 既不存储也不配置 Codex 凭据。
- **模型目录依赖该 CLI**——选择器的每次读取都通过该实例的 app-server 遍历 `model/list`，因此不可达、损坏或缓慢的 `codex` 二进制会让该实例的路由没有条目。
- **没有 rollout 的线程会被替换**——已绑定但从未收到提示词的会话持有一个没有已存 rollout 的 Codex 线程；下一次绑定会记录警告并启动新线程，而不是恢复它。
- **实例路由不提供任何模型调用**——针对实例 id 的 `ctx.llm` 请求会抛出；该路由的存在只是为了让选择器能够枚举该实例的 Codex 模型。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

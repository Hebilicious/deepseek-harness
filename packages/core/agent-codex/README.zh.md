---
description: "dsh 的 Codex 会话驱动器：把每个会话绑定到各自的 app-server 线程，通过 Codex JSON-RPC 协议驱动轮次，并把 Codex 模型放进选择器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-codex

[English](README.md) | 中文

## 概述

让 agent（智能体）会话运行在 Codex 上而不是进程内循环上：一个 `codex app-server` 进程服务整个 profile，每个会话绑定自己的 Codex 线程并拥有持久线程 id。驱动器通过 JSON-RPC 转发每个轮次，把 Codex 条目投影为 `assistant/message`、`tool/call` 与 `tool/result` 事件，把 Codex 审批请求路由进 dsh 审批 seam，并暴露设置界面所需的账号操作。Codex 保有循环、提示词、工具、MCP 服务器与配置；dsh 保有会话、transcript（文本记录）、审批、通知与模型选择器。它需要已登录的 Codex 账号，挂载它会取代该 profile 的进程内循环。

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

当会话应运行在 Codex 账号而不是 dsh 模型路由上时，挂载本提供方。[`dsh-web-codex`](../../bundle/web-codex/README.zh.md) bundle 为浏览器界面挂载它，任何组合也可以自行添加该配置行。

### 何时选择

当希望由 Codex 自带的循环、提示词、工具、MCP 服务器与 `config.toml` 服务该会话时，选择本驱动器。驱动器把自身注册为 `codex` agent harness，因此组合可以把它与 [`dsh-agent-loop`](../agent-loop/README.zh.md) 以及任意 ACP harness 一起挂载；随包发布的 `dsh-web-codex` bundle 仍会禁用循环行，使该 profile 只运行 Codex。

### 配置

```yaml
- id: agent-codex
  name: '@deepseek-ai/dsh-agent-codex'
  config:
    codexHome: /home/me/.codex
    sandbox: workspace-write
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executable` | `codex` | Codex 可执行文件名或绝对路径 |
| `args` | `['app-server']` | 可执行文件之后的参数 |
| `codexHome` | `~/.codex` | 交给子进程的 `CODEX_HOME`；拥有认证、`config.toml`、MCP 服务器与钩子 |
| `env` | `{}` | 叠加在已清洗父环境之上的显式环境变量 |
| `sandbox` | `workspace-write` | 未记录 `sandbox/mode` 覆盖的会话所使用的文件系统沙箱 |
| `networkAccess` | `false` | 结构化沙箱策略中的 `networkAccess` 成员 |
| `approval` | `ask` | `ask` 映射为 Codex 的 `on-request` 审批，`never` 映射为不审批 |
| `model` | — | 位于会话 `model/selection` 之下的部署默认值 |
| `reasoningEffort` | — | 位于会话选择之下的部署默认值 |
| `credentialRef` | — | 为无人值守的 `account/login/start {type:'apiKey'}` 解析的凭据引用 |
| `disposeGraceMs` | `5000` | 受管范围终止层级之间的宽限期 |
| `eofGraceMs` | `2000` | stdin EOF 之后、升级终止之前的窗口 |

### 首个会话之前

当 app-server 报告的账号未认证且要求 OpenAI 认证时，驱动器拒绝绑定会话。此时 `bind()` 抛出 `agent-codex: Codex is not authenticated; sign in through the settings panel or run`，其后是 `codex login` 命令。请针对配置的 `CODEX_HOME` 运行一次 `codex login`，或设置 `credentialRef`，让无人值守部署可以通过 `account/login/start` 发送 API key。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 共享 app-server 运行时

每个挂载的插件有一个 `CodexAppServerRuntime`，它在首次会话绑定时惰性启动 `codex app-server` 并记忆化该连接，因此并发绑定共享同一次握手。运行时把线程作用域的服务端请求与通知路由给拥有该线程 id 的 agent；某个 peer 自身的失败只停留在该 peer 上，而传输失败会让所有线程的连接失效。退役子进程会清空记忆化结果，因此下一次 `connect()` 会启动全新进程，而不是交回已死的端点。

### 线程绑定

`bind()` 加入共享连接、证明账号已认证，然后恢复已记录的线程或启动新线程，全部发生在会话发布之前。全新的 `thread/start` 以 `ephemeral: false` 运行并追加 `agent-codex/thread`；已记录的线程以 `excludeTurns: true` 恢复。若 Codex 对一个从未收到提示词的线程返回 `-32600 no rollout found`，驱动器会记录警告并启动新线程；其他任何拒绝都保持致命，而恢复出的 id 与记录值不一致属于协议错误。`unbind()` 在共享进程仍然存活时发送 `thread/unsubscribe`。

### 轮次驱动

一个 Codex 轮次就是一个持久 dsh 步骤。`turn/start` 携带领取到的输入、`clientUserMessageId`、生效的审批策略与沙箱策略，以及选定的 `model`／`effort`；通知经 `ExternalTurnProjector` 流式投影。在 `turn/started` 或 `turn/start` 响应提交之前，轮次 id 是临时的，先到的帧会被缓冲并重放。`turn/completed` 把 `completed` 映射为已完成轮次、`interrupted` 映射为已中止轮次，`failed` 映射为 `max-tokens` 或由 Codex 失败类别派生的错误码。被中断或失败的轮次仍会结算未完成的工具条目与 assistant 流，因此悬空的 `tool/call` 不会残留。

### 审批、提问与 elicitation

Codex 的命令、文件变更与权限请求经 `ctx.approval` 路由；`item/tool/requestUserInput` 与 `mcpServer/elicitation/request` 经 `ctx.userQuestions` 路由。两个服务都未挂载或没有存活轮次时，每个请求都会被拒绝，而不是自动批准。schema 为字符串、枚举、布尔或数字字段扁平对象的 elicitation 会变成每个字段一个问题；更复杂的 schema 会被拒绝，而不是编造内容。

### 账号操作

`codexAppServer` 服务在 `codex` 命名空间发布连接级 Remote：`status`、`loginDeviceCode`、`loginBrowser`、`cancelLogin`、`logout`、`rateLimits`，以及账号通知的 `events` 流。`credentialRef` 在每个进程生命周期内最多驱动一次 `account/login/start {type:'apiKey'}`，且 key 值绝不进入日志或 transcript。

### 源码映射

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `codexAppServer` 服务：配置、目录注册、host 挂载、账号 Remote |
| [`src/agent.ts`](src/agent.ts) | `CodexAgent`：线程生命周期、轮次驱动、条目投影、审批 |
| [`src/host.ts`](src/host.ts) | `CodexAgentHost`：把运行时与部署配置绑定进每个 agent |
| [`src/runtime.ts`](src/runtime.ts) | `CodexAppServerRuntime`：进程、连接、线程路由、账号调用、`model/list` |
| [`src/connection.ts`](src/connection.ts) | `CodexAppServerConnection`：行传输、握手、请求／通知分发 |
| [`src/protocol.ts`](src/protocol.ts) | 协议解码、权限模式、终态轮次状态、失败分类 |
| [`src/catalog.ts`](src/catalog.ts) | `CodexCatalogAdapter`：仅提供目录的 `codex` 模型路由 |
| [`src/thread-state.ts`](src/thread-state.ts) | `agent-codex/thread` 事件及其投影 |
| [`src/types.ts`](src/types.ts) | 客户端安全的账号载荷与 Remote 错误码 |
| [`tests/agent-codex.spec.ts`](tests/agent-codex.spec.ts) | 基于 mock app-server 的轮次、线程、审批与账号行为 |
| [`tests/runtime-lifecycle.spec.ts`](tests/runtime-lifecycle.spec.ts) | 共享进程的启动、退役与 dispose |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 插件在真实 Loader 树中挂载并注册 |
| — | 不发布运行时不变式伴生入口：其持久关系是 `agent-codex/thread` 折叠区与共享投影器提交的会话事件，二者均由所属包断言。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-agent-external](../agent-external/README.zh.md)——本驱动器所基于的驱动器基座、收件箱与 create/resume/publish 事务。
- [dsh-web-codex](../../bundle/web-codex/README.zh.md)——让浏览器 profile 运行在本驱动器上的 bundle。
- [dsh-agent-loop](../agent-loop/README.zh.md)——在 profile 中被本驱动器取代的进程内驱动器。
- [Core 子系统](../../../docs/subsystems/core.zh.md)——驱动器所实现的 `Agent` 约定与轮次流程。

-----

<a id="model-experience"></a>
## 模型体验

### Codex harness 轮次

#### 模型看到什么

领取到的用户输入会作为 Codex `UserInput` 条目转发：文本块原样通过，能解析出附件路径的图片变为 `localImage`，文件变为其确定性的句柄文本。模型看到的其余内容——Codex 的系统提示词、它更早的轮次及其工具定义——都属于 Codex 进程，而不属于 dsh。

#### Token 影响

dsh 每轮只贡献新的用户输入；Codex 为它自己的提示词、历史与工具 schema 付费。驱动器无法转发的内容块会让该轮次以 `agent-codex: Codex sessions cannot forward ... input blocks` 错误失败，而不是被静默丢弃。

#### KV Cache 影响

请求前缀由 Codex 拥有，因此 dsh 既不能保证也无法测量复用。在同一个 Codex 线程内，只要模型与线程设置不变，前缀就是仅追加的；更改 `model`、`effort` 或权限策略会发起一个此前缀可能不匹配的请求。

### 模型选择器目录

#### 模型看到什么

`codex` 路由会出现在 `ctx.llm.listModels()` 中，其条目读取自 app-server 的 `model/list`，包含每个模型的显示名与推理强度菜单。选择器中的选择会作为 `turn/start` 的 `model` 与 `effort` 成员抵达轮次，持久 `request/header` 记录实际运行的内容。

#### Token 影响

没有直接 token 成本。选定的推理强度会改变 Codex 在该轮次消耗的思考 token 量。

#### KV Cache 影响

更换模型或推理强度会替换路由；旧路由下已缓存的前缀不再复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本驱动器何时不合适或何时需要运维注意。它们是当前包约束，不是任务积压。

- **`dsh-web-codex` bundle 让其 profile 只运行 Codex**——它会禁用 `agent-loop` 行。驱动器本身并不要求这种排除：多 harness 的 profile 会把它与循环及各个 ACP harness 一起挂载。
- **轮次归 Codex，外壳归 dsh**——循环、提示词、工具、MCP 服务器与配置都位于 Codex。DSH 保留持久会话、transcript、审批、通知与模型选择器；驱动器每轮转发一次模型选择，并上报 harness 自己当前的模型，当 Codex 从不上报时回退为 `agent-default`。
- **需要 Codex 账号，且不由此包提供**——会话需要完成了 `codex login` 的 `CODEX_HOME`，或为 API-key 路径提供 `credentialRef`；dsh 既不保存也不提供 Codex 凭据。
- **模型目录依赖该 CLI**——每次选择器读取都会经共享 app-server 走一遍 `model/list`，因此 `codex` 二进制不可达、损坏或缓慢时，选择器就没有条目。
- **没有 rollout 的线程会被替换**——已绑定但从未收到提示词的会话拥有一个没有已存 rollout 的 Codex 线程；下次绑定时会记录警告并启动新线程，而不是恢复。
- **`codex` 路由不提供模型调用**——该提供方上的 `ctx.llm` 请求会抛出；它存在的目的是让选择器能枚举 Codex 模型。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

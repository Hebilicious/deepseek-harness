---
description: "dsh 的 Devin 会话驱动器：把每个会话绑定到共享 `devin acp` 进程上各自的 ACP 会话，通过 Agent Client Protocol 驱动轮次，并把 Devin 模型放进选择器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-acp

[English](README.md) | 中文

## 概述

让 agent（智能体）会话运行在 Devin 上而不是进程内循环上：一个 `devin acp` 进程服务整个 profile，每个会话绑定自己的 ACP 会话并拥有持久会话 id。驱动器用 `session/prompt` 发送每次提示词，把 ACP 会话更新投影为 `assistant/message`、`tool/call` 与 `tool/result` 事件，把 Devin 权限请求路由进 dsh 审批 seam，并暴露 Devin 的认证操作。Devin 保有循环、提示词、工具、MCP 服务器与配置；dsh 保有会话、transcript（文本记录）、审批、通知与模型选择器。它需要已登录的 Devin CLI，挂载它会取代该 profile 的进程内循环。

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

当会话应通过 Agent Client Protocol 运行在 Devin 账号而不是 dsh 模型路由上时，挂载本提供方。[`dsh-web-acp`](../../bundle/web-acp/README.zh.md) bundle 为浏览器界面挂载它，任何组合也可以自行添加该配置行。

### 何时选择

当希望由 Devin 自带的循环、提示词、工具、MCP 服务器与配置服务该会话，且双方能就 Agent Client Protocol 达成一致时，选择本驱动器。驱动器把自身注册为 `ctx.agents` 工厂，而 `AgentRegistry.setFactory()` 只接受一个工厂，因此组合中不能同时运行 [`dsh-agent-loop`](../agent-loop/README.zh.md)；随包发布的 bundle 会禁用该配置行。

### 配置

```yaml
- id: agent-acp
  name: '@deepseek-ai/dsh-agent-acp'
  config:
    sandbox: workspace-write
    approval: ask
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executable` | `devin` | harness 可执行文件名或绝对路径 |
| `args` | `['acp']` | 可执行文件之后的参数 |
| `cwd` | `process.cwd()` | harness 进程自身的工作目录；会话各自携带自己的工作目录 |
| `env` | `{}` | 叠加在已清洗父环境之上的显式环境变量 |
| `sandbox` | `workspace-write` | 未记录 `sandbox/mode` 覆盖的会话所使用的文件系统沙箱 |
| `approval` | `ask` | 未记录 `approval/policy` 覆盖的会话所使用的审批路由 |
| `mode` | — | 对会话 `mode` 配置选项的部署级覆盖 |
| `model` | — | 位于会话 `model/selection` 之下的部署默认值 |
| `disposeGraceMs` | `5000` | 受管范围终止层级之间的宽限期 |
| `eofGraceMs` | `2000` | stdin EOF 之后、升级终止之前的窗口 |
| `modelsArgs` | `['models', 'list', '--format', 'json']` | 模型目录命令参数 |
| `authStatusArgs` | `['auth', 'status']` | 认证状态命令参数 |
| `authLogoutArgs` | `['auth', 'logout']` | 认证登出命令参数 |
| `cliTimeoutMs` | `180000` | 单个一次性 CLI 动词的截止时间，超时后驱动器放弃该调用 |

### 首个会话之前

会话需要已认证的 Devin CLI：运行一次 `devin auth login`，或通过 `acp` Remote 的 `login` 方法启动浏览器流程。该服务同时上报 agent 声明的认证方法与 `devin auth status` 的判定结果，因此设置界面可以指出缺失的是哪一半。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 共享 ACP 运行时

每个挂载的插件有一个 `AcpRuntime`，它惰性启动 `devin acp`，并记忆化连接与 agent 的 initialize 响应。ACP SDK 负责校验入站帧；驱动器自带的 `AcpClientConnection` 把握手固定在 `clientCapabilities: {}`，因此 Devin 自行提供文件系统与终端工作，而不回调 dsh，并把每条通知与请求路由给按其 `sessionId` 注册的 peer。该端点会被记忆化，直到子进程退出或连接失败；此后它会被回收，因此下一次 `connect()` 会启动全新子进程，而不是返回已死的端点。`dispose()` 在第一个 await 之前就置位，因此仍在进行中的握手会被等待并拆除，而不会被发布，之后每次 `connect()` 都会失败。同一运行时也通过同一条 subprocess seam 运行短命的 CLI 动词（`models list`、`auth status`、`auth logout`），每次调用都受 `cliTimeoutMs` 约束。

### 会话绑定

`bind()` 加入共享连接，并创建 ACP 会话（`session/new`）或加载已记录的会话（`session/load`），全部发生在 dsh 会话发布之前。全新会话追加带 agent 签发 id 的 `agent-acp/session`；恢复要求 agent 声明 `loadSession`，否则驱动器会以 `session "<id>" cannot resume: the agent does not advertise loadSession` 明确失败。peer 只在 load 响应之后注册，因此重放的历史不会重复提交。

### 轮次驱动

一次 `session/prompt` 就是一个持久 dsh 步骤。`agent_message_chunk` 与 `agent_thought_chunk` 更新喂给一条 assistant 流，`tool_call` 与 `tool_call_update` 提交持久工具事件对，`plan` 渲染为文本块，`config_option_update` 刷新会话已知的配置选项。响应的停止原因映射为轮次结束：`end_turn` 完成、`max_tokens` 记录上限、`cancelled` 以用户原因中止，`refusal` 或 `max_turn_requests` 以固定错误码失败。轮次结束时仍打开的工具调用或 assistant 流会被结算，因此不会留下悬空的模型可见内容。

### 权限与 elicitation

`session/request_permission` 经 `ctx.approval` 路由；处于 `form` 模式且 schema 为字符串与枚举字段扁平对象的 `elicitation/create` 经 `ctx.userQuestions` 路由。没有审批服务、没有存活轮次或 schema 更复杂时，驱动器会拒绝或取消，而不是猜测。

### 认证操作

`acpHarness` 服务在 `acp` 命名空间发布连接级 Remote：`status`、`login` 与 `logout`。当 agent 声明了 ACP `logout` 请求时登出优先使用它，否则运行 `devin auth logout`，因为随包发布的 Devin 把 `agentCapabilities.auth` 上报为 `{}`。

### 源码映射

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `acpHarness` 服务：配置、目录注册、host 挂载、认证 Remote |
| [`src/agent.ts`](src/agent.ts) | `AcpAgent`：会话生命周期、轮次驱动、更新投影、权限 |
| [`src/host.ts`](src/host.ts) | `AcpAgentHost`：把运行时与部署配置绑定进每个 agent |
| [`src/runtime.ts`](src/runtime.ts) | `AcpRuntime`：进程、连接、CLI 动词、模型目录、认证 |
| [`src/connection.ts`](src/connection.ts) | `AcpClientConnection`：握手、会话路由、致命状态观测 |
| [`src/protocol.ts`](src/protocol.ts) | 停止原因、工具内容、提示词块、权限结果、配置选项 |
| [`src/catalog.ts`](src/catalog.ts) | `DevinCatalogAdapter`：仅提供目录的 `devin` 模型路由 |
| [`src/session-state.ts`](src/session-state.ts) | `agent-acp/session` 事件及其投影 |
| [`src/types.ts`](src/types.ts) | 客户端安全的 Devin 账号载荷与 Remote 错误码 |
| [`tests/agent-acp.spec.ts`](tests/agent-acp.spec.ts) | 基于 mock ACP agent 的轮次、会话、权限、模式、认证与目录行为 |
| [`tests/agent-edge.spec.ts`](tests/agent-edge.spec.ts) | 更新变体、附件、拒绝路径、会话级覆盖与降级的 agent 响应 |
| [`tests/runtime.spec.ts`](tests/runtime.spec.ts) | 运行时生命周期：握手中途的销毁、子进程死亡后重启、CLI 动词、取消 |
| [`tests/service.spec.ts`](tests/service.spec.ts) | `AcpHarness` 配置回退与 Remote 错误归一化 |
| [`tests/protocol.spec.ts`](tests/protocol.spec.ts) | 无子进程的纯 wire 辅助映射 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 插件在真实 Loader 树中挂载并注册 |
| — | 不发布运行时不变式伴生入口：其持久关系是 `agent-acp/session` 折叠区与共享投影器提交的会话事件，二者均由所属包断言。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-agent-external](../agent-external/README.zh.md)——本驱动器所基于的驱动器基座、收件箱与 create/resume/publish 事务。
- [dsh-web-acp](../../bundle/web-acp/README.zh.md)——让浏览器 profile 运行在本驱动器上的 bundle。
- [dsh-agent-loop](../agent-loop/README.zh.md)——在 profile 中被本驱动器取代的进程内驱动器。
- [Agent Client Protocol](https://agentclientprotocol.com)——Devin 与本驱动器所讲的公开协议规范。
- [Core 子系统](../../../docs/subsystems/core.zh.md)——驱动器所实现的 `Agent` 约定与轮次流程。

-----

<a id="model-experience"></a>
## 模型体验

### Devin harness 轮次

#### 模型看到什么

领取到的用户输入会转换为 ACP 提示词块：文本原样通过，能解析出宿主路径的文件或图片附件变为 ACP `resource_link` 块。路径无法解析的附件会降级为 `[file: name]` 占位文本，而不是让该轮次失败。模型看到的其余内容——Devin 的提示词、它更早的轮次及其工具定义——都属于 Devin 进程，而不属于 dsh。

#### Token 影响

dsh 每轮只贡献新的用户输入；Devin 为它自己的提示词、历史与工具 schema 付费。Devin 以 `agent_thought_chunk` 流式发出的推理文本会记录进 dsh transcript，但 dsh 绝不会把它回传给 Devin——Devin 自己的上下文里已经有它。

#### KV Cache 影响

请求前缀由 Devin 拥有，因此 dsh 既不能保证也无法测量复用。在同一个 ACP 会话内，只要模型与模式不变，前缀就是仅追加的；更改其中任一项都会发起一个此前缀可能不匹配的请求。

### 会话模式与模型选择

#### 模型看到什么

每次提示词之前，驱动器用 `session/set_config_option` 应用会话的选择：`model` 选项携带持久 `model/selection` 或部署默认值，`mode` 选项携带沙箱与审批旋钮。会话未声明的值会被记录日志并附上实际将运行的值，持久 `request/header` 则记录 agent 自己上报的模型。

#### Token 影响

没有直接 token 成本。应用后的模型与模式会改变 Devin 为本轮执行的推理与工具工作量。

#### KV Cache 影响

更换模型会替换路由，因此旧模型下缓存的前缀不再复用。仅更换模式时，只要模型与历史不变，token 前缀保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本驱动器何时不合适或何时需要运维注意。它们是当前包约束，不是任务积压。

- **Devin 没有只读权限模式**——`devin --permission-mode` 接受的是审批模式（`auto`、`accept-edits`、`smart`、`dangerous`），ACP 会话模式则是 `accept-edits`、`smart`、`ask`、`plan` 与 `bypass`。它们都不把 agent 限制为只读，因此 dsh 的 `read-only` 沙箱无法由 Devin 强制执行；驱动器会记录警告，指明该会话实际运行的模式，而不是假装已经应用。
- **它会取代 profile 的 agent loop**——`ctx.agents.setFactory()` 只接受一个工厂，因此挂载本驱动器会在整个 profile 内排除 `dsh-agent-loop`；`dsh-web-acp` bundle 会禁用该配置行，而不是把两者组合起来。
- **轮次归 Devin，外壳归 dsh**——循环、提示词、工具、MCP 服务器与配置都位于 Devin。DSH 保留持久会话、transcript、审批、通知与模型选择器；驱动器每轮转发一次模型选择，并上报 agent 自己当前的模型，当会话未声明模型选项时回退为 `agent-default`。
- **需要 Devin 登录，且不由此包提供**——会话需要 `devin auth login`；dsh 既不保存也不提供 Devin 凭据。
- **模型目录依赖该 CLI**——`devin` 路由走 `devin models list --format json`，因此该 CLI 不可达、未认证或缓慢时，选择器就没有条目；每次调用都受调用方 signal 与 `cliTimeoutMs` 约束。
- **目录输出可能在受管子进程内失败**——在 Linux 上，本地 subprocess 提供者的 systemd scope 路径会让子进程的 stdout 处于非阻塞状态，因此约 180 KB 的目录输出可能以 `exited 101 ... Resource temporarily unavailable (os error 11)` 终止；驱动器会报告该 CLI 的退出码与 stderr 尾部，该 stdio 缺陷属于 subprocess 提供者，而非本包。
- **不支持轮次中途 steering**——ACP 不提供 steering 通道，因此 `steer()` 输入会排队等待下一个轮次，而不会抵达正在运行的轮次。
- **已记录的会话在缺少 `loadSession` 时无法恢复**——未声明该能力的 agent 会让绑定失败，而不是静默启动一个全新会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

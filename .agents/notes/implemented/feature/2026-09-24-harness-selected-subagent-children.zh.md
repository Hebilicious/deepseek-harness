# Agent Note: Harness 选择的 subagent 子级取代一次性产品后端

Status: implemented

[English](2026-09-24-harness-selected-subagent-children.md) | 中文

## 问题

subagent seam 曾交付三个一次性的进程外提供方——`dsh-subagent-acp`、`dsh-subagent-codex` 与 `dsh-subagent-claude-code`（[能力 seam Agent Note](2026-06-21-subagent-capability-seam.zh.md)、[产品提供方 Agent Note](../../archived/feature/2026-08-04-claude-code-and-codex-subagent-backends.md)）。每个提供方各自拥有私有传输层，每次调用启动一个产品进程，并返回父级作用域的 run，没有持久的子 `Session`：子 agent 在 Web UI 中不可见，无法恢复或继续，且各提供方重复实现生命周期、cwd、能力与诊断管线。

后来的两项机制使这些提供方变得多余。`SubagentStartRequest.harness` 让进程内 `spawn` 提供方通过 `ctx.agents.create({ harness })` 创建子 agent——即在任何已挂载 agent harness（包括 Codex app-server 与 ACP 驱动）下运行的普通持久 Session。`agentToolBridge` 让外部 harness Session 调用 dsh 工具（包括 `subagent`），因此每个 harness 无需成对的专用提供方即可委派给其他 harness。

## 决策

三个产品提供方已删除。交付的委派路径只有一条：`dsh-tool-subagent` 绑定 `spawn` 提供方并暴露面向模型的 `harness` 参数；可选的 `harnesses` 配置限制可选列表，省略时提供所有已挂载 harness。未挂载的 `harness` 值在启动时被拒绝。子 agent 是携带 `parentSession` 谱系的一等 Session——在 Web UI 中可见，可通过普通 Session 机制恢复与继续。

`dsh-subagent-dsh-sdk` 保留为进程隔离后端：在内存或崩溃隔离比共享进程开销更重要的场景，它通过 TypeScript SDK 驱动独立的 Harness 子进程。

## 考虑过的替代方案

- **在 harness 选择之外保留产品提供方。**三条私有传输层会重复 spawn 路径已覆盖的语义——持久 Session、委派策略钉定、能力拒绝——同时对 Session UI 不可见且无法继续。
- **为每次调用的进程隔离而保留它们。**进程隔离已由 `dsh-subagent-dsh-sdk` 承接；产品提供方在此之外没有额外的隔离能力。
- **为触达 ACP 而保留 ACP 客户端提供方。**ACP 子 agent 现在是经 `harness` 选择的 `agent-acp` Session；外部 ACP agent 则通过 `agentToolBridge` 反向触达，不再需要专用客户端提供方。

## 影响

委派的成本是一份提供方实现加一行工具配置，而非每个产品各一份提供方；harness 矩阵是任意到任意的，因为每个已挂载 harness 都可选，且每个经桥接的外部 Session 自身也能调用 `subagent`。子 Session 免费获得持久化、Web 可见性与可继续性。诸如 Codex 子 agent 推理强度钉定这类提供方专属选项由 `agentOptions.reasoningEffort` 覆盖，`spawn` 会将其合并进所选 harness 的子级选项。

放弃的部分：专用提供方可以钉定产品 CLI、塑造产品专属诊断，并把每个子 agent 隔离在一次性进程中；保留的 SDK 后端覆盖隔离场景，产品诊断经由通用 `SubagentResult.diagnostic` 通道到达。预设不再携带禁用的产品工具行，也没有任何预设行负责安装或认证外部产品——挂载 harness 属于宿主组合的工作。将 harness 子 agent 的审批路由到父会话仍属延后事项。

## 测试

注册表与工具测试覆盖 `harness` 校验与未挂载 harness 的拒绝；`snapshots/session/acp-bridged-subagent` 录制外部 harness 子 agent 经 `agentToolBridge` 触达 `subagent` 工具；`product-subagent-result-diagnostic` 通过共享结果契约保留对提供方诊断的确定性覆盖。

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

---
description: "在 dsh 中编写 agent 驱动器的共享基座：持久收件箱、轮次与步骤边界、create/resume/publish 事务，以及受管 harness 进程。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-external

[English](README.md) | 中文

## 概述

编写 agent（智能体）驱动器时，可复用 dsh 已定义的每一项面向会话的行为：持久收件箱、阶段状态机、取消、轮次与步骤边界、create/resume/publish 事务，以及受管 harness 进程可证明的 teardown。保留自己的步骤循环时继承 `ManagedAgent`；把轮次内部交给外部 harness 进程时，继承 `ExternalAgent` 并配合 `ExternalAgentHost`。消费方是 [`dsh-agent-loop`](../agent-loop/README.zh.md)、[`dsh-agent-codex`](../agent-codex/README.zh.md) 与 [`dsh-agent-acp`](../agent-acp/README.zh.md)。要新增驱动器就选用本包；单独挂载本包不会注册任何内容。

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

### 何时使用

dsh 中的每个驱动器都继承本包，而不是重新实现会话外壳。`dsh-agent-loop` 继承 `ManagedAgent` 并保留自己的步骤循环；`dsh-agent-codex` 与 `dsh-agent-acp` 继承 `ExternalAgent`，让 Codex 账号或 Devin CLI 拥有循环、提示词、工具、MCP 服务器与配置。驱动器自行调用 `ctx.llm` 与 `ctx.tools` 时选择 `ManagedAgent`；模型工作通过协议在其他进程中完成时，选择 `ExternalAgent` 加 `ExternalAgentHost`。

驱动器把自身注册为一个 agent harness：`AgentRegistry.registerHarness({ id, name, factory })` 按 harness id 记录每次注册，因此多个驱动器可以共存于同一进程，`session.create`/`resume` 指定拥有该会话的 harness。独占整个 profile 的驱动器仍可使用 `ctx.agents.setFactory()`，它注册内置的 `dsh` id。

### 入口

继承两种 agent 形态之一；外部 harness 还需继承负责构造它的 host。

```text
import { ExternalAgent, ExternalAgentHost, type ExternalTurnDrive } from '@deepseek-ai/dsh-agent-external'

class MyAgent extends ExternalAgent {
  async bind(signal: AbortSignal): Promise<void> { /* open the harness conversation */ }
  async unbind(): Promise<void> { /* release it while the process is still alive */ }
  protected async driveTurn(messages: readonly UserMessage[], drive: ExternalTurnDrive): Promise<TurnEndReason> {
    drive.projector.noteRoute({ provider: 'my-harness', model: 'current' })
    // stream harness output through drive.projector, then report the ending
    return { kind: 'completed' }
  }
  protected steerLive(): Promise<boolean> { return Promise.resolve(false) }
  protected interruptTurn(_drive: ExternalTurnDrive): Promise<void> { return Promise.resolve() }
}

class MyHost extends ExternalAgentHost<MyAgent> {
  protected constructAgent(hostCtx, id, options, session): MyAgent {
    return new MyAgent(hostCtx, id, options, session)
  }
}
```

在服务构造函数中构造 `MyHost` 会注册 `turnBoundary` 投影、工厂持有的生命周期 teardown，以及工厂槽位本身，全部以该服务的 fiber 为作用域。`bind()` 在发布之前运行，因此被拒绝的握手会回滚整个创建过程，该会话 id 仍可再次使用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计理念

本包把一个 agent 拆成面向会话的一半与面向 harness 的一半。`ManagedAgent` 拥有会话能看到的一切：持久收件箱、活动阶段状态机、唤醒闩锁、维护互斥、协作式取消，以及围绕一次 `runTurnBody()` 调用的 `turn/start` … `turn/end` 骨架。`ExternalAgent` 在其上增加 harness 接口：外部轮次从第 1 步开始，驱动器在 harness 每次新的模型响应时调用 `drive.nextStep()`，因此日志与进程内循环一样，每一步承载一条 assistant 消息及其工具调用；实时 steering 与注入通过驱动器自己的动词抵达 harness，模型路由来自持久选择折叠区。在空闲时收到 harness 输出的驱动器用 `hasUnpromptedHarnessWork` 报告它，并从 `driveUnpromptedTurn` 投影；空的收件箱认领于是会开启一个没有用户消息的轮次，而不是停下来。`ExternalAgentHost` 拥有每个驱动器共享的生命周期，因此驱动器实现只包含协议转换。

### 生命周期事务

挂载后端时，`createAgent()` 准备私有会话、通过 `persistence.create()` 取得持久写所有权、在所有者 fiber 上构造驱动器、运行调用方 setup、在未发布状态下等待 `bind()`、冲刷发布前的后缀，此后才进入两个注册表、宣告会话与 agent、发出 `agent/session-start`，并返回已发布的句柄。`resume()` 先打开写句柄（从而排除同 id 的并发恢复）、读取物理上有效的日志、追加 `interruptedTurnClosers`，并以 `resume` 来源走同一条发布路径。任何失败、取消或所有者 dispose 都会回滚事务而不发布任一身份；共享 teardown 是记忆化的：停止驱动器、`unbind()`、撤销 agent 作用域、排空并关闭写句柄，最后 detach 两个注册表。

### 持久收件箱与投影

`DurableAgentInbox` 把待处理输入存进会话日志：每次变更提交一条 `agent/inbox/spliced` 事件，并发出 `agent/inbox/inserted`、`agent/inbox/claimed` 或 `agent/inbox/discarded`，因此领取结果在重启与回放后依然存在。host 注册 `turnBoundary`（打开的轮次、最后的步骤边界、最后的轮次），并在驱动器未选择退出时注册 `externalModelSelection`，即选择器写入的持久 `model/selection` 记录的折叠区。`dsh-agent-loop` 选择退出，因为它通过会话控制器自带的折叠区读取模型选择。

### 轮次投影

`ExternalTurnProjector` 是 harness 观测结果变为持久事件的唯一位置：`beginAssistant()` 打开一条流式尝试，它发出 `agent/assistant-stream` 帧，并结算为 `assistant/message` 或仅日志的 `assistant/attempt`；`toolCall()`／`toolResult()` 提交成对事件；`noteRoute()` 在上报路由变化时记录 `request/header`。

### Harness 进程

`ExternalHarnessProcess.spawn()` 通过 `ctx.subprocess` 解析可执行文件，以管道 stdio 与有界 stderr 尾部启动它，并在提供方未返回管道时拒绝。`dispose()` 先结束 stdin，给子进程一个冲刷自身持久化状态的时间窗，随后经 `terminate()` 升级，并等待整个受管范围退出；seam 无法回收的部分会抛出，而不是报告为干净停止。

### 源码映射

| 文件 | 作用 |
|---|---|
| [`src/base.ts`](src/base.ts) | `ManagedAgent`：收件箱、阶段状态机、取消、维护互斥、轮次骨架 |
| [`src/agent.ts`](src/agent.ts) | `ExternalAgent`：多步骤的外部轮次、实时 steering 与注入、`HARNESS_DEFAULT_MODEL` 路由标记 |
| [`src/host.ts`](src/host.ts) | `ExternalAgentHost`：create/resume/publish 事务、注册、反向 teardown |
| [`src/lifecycle.ts`](src/lifecycle.ts) | `FactoryOwnership`、中止竞态、agent 选项校验 |
| [`src/inbox.ts`](src/inbox.ts) | `DurableAgentInbox` 与 `inbox` 投影 |
| [`src/turn-boundary.ts`](src/turn-boundary.ts) | 共享的 `turnBoundary` 投影 |
| [`src/model-selection.ts`](src/model-selection.ts) | `externalModelSelection` 折叠区 |
| [`src/projector.ts`](src/projector.ts) | `ExternalTurnProjector`：assistant 流、工具事件对、路由日志 |
| [`src/assistant-stream.ts`](src/assistant-stream.ts) | `AssistantStreamAttempt`：实时帧加持久紧凑流 |
| [`src/process.ts`](src/process.ts) | `ExternalHarnessProcess`：spawn、stderr 尾部、teardown 阶梯 |
| [`tests/agent-external.spec.ts`](tests/agent-external.spec.ts) | 基于假驱动器的生命周期、teardown 与中止竞态 |
| [`tests/inbox.spec.ts`](tests/inbox.spec.ts) | 持久收件箱命令与回放 |
| — | 不发布运行时不变式伴生入口：每项贡献都是由注册表释放的 effect，其折叠的持久关系由所属 session 与 projection 包断言。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-agent-loop](../agent-loop/README.zh.md)——继承 `ManagedAgent` 并把本 host 挂载为 `LoopAgentHost` 的进程内驱动器。
- [dsh-agent-codex](../agent-codex/README.zh.md)——基于 Codex app-server JSON-RPC 协议的驱动器。
- [dsh-agent-acp](../agent-acp/README.zh.md)——基于 Agent Client Protocol 的驱动器。
- [agent 包](../agent/README.zh.md)——本基座实现的公开 `Agent` 约定、注册表与 `agent/*` 事件。
- [Core 子系统](../../../docs/subsystems/core.zh.md)——轮次流程、投影 seam 与取消决策。

-----

<a id="model-experience"></a>
## 模型体验

### 每轮模型选择

#### 模型看到什么

每个轮次的驱动器都会读取 `currentSelection()`，即该会话最新的持久 `model/selection`，并把解析出的提供方、模型与推理强度转发给它自己的 harness。基座自身从不写入请求；由驱动器决定哪次 harness 调用携带它们。

#### Token 影响

没有直接 token 成本。该选择决定由哪个模型服务本轮，harness 侧的推理强度会改变思考 token 的消耗量。

#### KV Cache 影响

更换选择会替换模型路由，因此旧路由下已缓存的前缀不再复用。同一路由下的连续轮次保持仅追加。

### 持久路由记录

#### 模型看到什么

`ExternalTurnProjector.noteRoute()` 记录一条携带本轮真实所用提供方与模型的持久 `request/header`。当 harness 从不上报其模型时，驱动器记录 `HARNESS_DEFAULT_MODEL`（`agent-default`），而不是空值或臆造的 id，使 transcript（文本记录）如实反映是谁选择了模型。

#### Token 影响

每次路由变化产生一条 header 事件；header 本身不会发送给模型。

#### KV Cache 影响

无。记录的 header 描述请求，但不改变其 token 序列。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本基座不为驱动器决定什么。它们是当前包约束，不是任务积压。

- **一个会话只由一个 harness 拥有**——会话以 `agent/harness` 事件记录其 harness，换用其他 harness 的 resume 会被拒绝，因此对话无法在驱动器之间迁移；挂载多个驱动器的 profile 改为在创建时选择 harness。
- **轮次归 harness 所有**——对 `ExternalAgent` 而言，循环、提示词、工具、MCP 服务器与配置都位于外部进程中。DSH 保留持久会话、transcript、审批、通知与模型选择器；驱动器每轮转发一次模型选择，并上报 harness 自己当前的模型。
- **harness 凭据在 DSH 之外**——Codex 会话需要 Codex 账号（`CODEX_HOME`、`codex login`），Devin 会话需要 `devin auth login`；DSH 既不保存也不提供任何一方。
- **模型目录来自 harness**——若驱动器的选择器数据来自某条 CLI 调用，当该 CLI 不可达或缓慢时，选择器就没有条目。
- **不发布不变式伴生入口**——除会话日志与投影注册表已断言的内容外，本包不拥有任何事件序列或可变关系。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

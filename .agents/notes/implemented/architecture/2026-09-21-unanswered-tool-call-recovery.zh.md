# Agent Note: Recover unanswered assistant tool calls

Status: implemented

[English](2026-09-21-unanswered-tool-call-recovery.md) | 中文

## Problem

一个步骤先提交其 assistant 消息，然后才运行其中的工具调用。当工具调度在该提交之后失败时，轮次以 `turn/end { kind: 'error' }` 关闭，留下已提交的调用而没有 `tool/result`。

这种历史无法被严格的提供方表示：DeepSeek Messages 序列化器会以 `INVALID_REQUEST`（"tool calls need immediate results"）拒绝结果不在紧随其后的用户轮次中的 assistant 工具调用，因此该路由上的每次后续请求都会失败，会话在那里持续不可用。崩溃修复（`interruptedTurnClosers`）只关闭仍处于打开状态的最终轮次中的调用，因此留在*已关闭*轮次里的调用会在每次恢复后继续存在。真实会话通过一次调度器失败进入该状态，随后每次切换到严格路由都会失败。

## Decision

写方关闭自己放弃的调用，派生历史不暴露任何无人应答的调用。

`packages/core/session/src/repair.ts` 中的 `toolCallRecovery(call, seq)` 为一个未应答的调用构建载荷与 surface 放置信息，两个生产方共用它：`interruptedTurnClosers` 处理因崩溃而遗留的打开轮次，`executeToolCalls`（`packages/core/agent-loop/src/tool-calls.ts`）处理终止性调度器失败。已记录 `tool/call` 的调用得到 `TOOL_OUTCOME_UNKNOWN`，以及提示模型在重试前核实外部状态的文本；从未进入分派的调用得到 `TOOL_NOT_STARTED`。两者都保留会话格式迁移所识别的规范消息标识 `interrupted-tool-result-<callId>-<seq>`。

发生终止性失败时，`executeToolCalls` 为失败分组中所有未提交的调用以及所有从未启动的调用记录恢复结果，然后重新抛出调度器失败。取消已经用 `ABORTED_BEFORE_DISPATCH` 结果关闭未分派的调用（[决策](2026-08-10-cancelled-stream-prefix-finalize.zh.md)）；本决策把同样的关闭扩展到离开步骤的失败。被拒绝的恢复追加不得取代该失败，因此该追加被包容处理，失败原样上报。

`Session.deriveMessages()` 省略没有任何用户轮次应答、且没有任何打开步骤仍能应答的 assistant 工具调用，并在该调用是其唯一内容时省略整条消息。步骤仍打开的调用属于待处理：该步骤会应答它，因此它保持可见。`Session.unanswerableToolCalls()` 报告被省略的集合，并按表层与步骤状态缓存。

该规则与协议要求一致，因此由更早版本写入的历史会在下一次请求时自行修复，而不是拒绝运行。持久日志保留该调用，人类可见的 transcript 仍然显示它。`withoutUnanswerableToolCalls` 把同一投影应用到单条消息，压缩用它构造回放给摘要器的前缀——那同样是一个提供方请求。压缩还读取同一集合用于其切分点配平折叠，该折叠只统计仍由某个答案或某个打开步骤负责的调用，因为被省略的调用没有可拆分的配对。在此之前，这类调用使其之后的每个切分点都不配平，范围选择只能遮蔽它之前的节点；损坏靠近头部的会话会永远重新摘要自己的检查点，再也无法装回其窗口。

## Alternatives considered

**保留拒绝，并要求用户新建会话。** 否决：该拒绝会在每次尝试时重复，除一个缺失结果外持久历史完好无损，而且受影响的会话无法从 GUI 手工修复。

**改写持久日志以插入缺失结果。** 否决：seq 是连续的位置，插入会使之后每个事件以及引用它们的每个 `sourceEventSeqs` 与 compaction 范围重新编号；已提交的 generation 也从不移动或覆盖。

**通过持久消息投影事件修复。** 否决：改写已记录的 assistant 消息需要新的投影事件类型、注册的纯投影以及目录重新生成，而这只是重复派生过程已经依据同一日志确定性完成的修复。

**在提供方序列化器中合成结果。** 否决：该协议规则并非特定于某个提供方（Anthropic Messages 同样强制它），而且没有会话事件记录的模型可见结果会仅为一条路由破坏日志历史规则。

## Consequences

历史中包含未应答调用的会话可以在每条路由上再次运行，且无需触碰持久数据。在该类遗留历史中模型看不到那个调用；人类可见的 transcript 仍然显示它，而由本版本记录的失败会带有明确的恢复结果。调度器失败仍以其原始错误码结束其轮次。

压缩可在同一历史上继续工作：被放弃的调用不再把范围选择钉死在其之前记录的节点上，因此溢出恢复能够遮蔽损坏前缀，把请求重新带回窗口之内。

恢复结果对模型可见，因此会参与快照以及下一步构建的请求；对于所有调用都有应答的历史，派生规则不会移除任何内容。

## Verification

`packages/core/session/tests/unanswered-tool-calls.spec.ts` 固定派生行为：已关闭步骤从未应答的调用被丢弃，其消息的其余部分保留；仍打开步骤中的调用保留；只承载被丢弃调用的消息消失；已应答的调用保留；同一日志的分离式重放派生出相同历史。

`packages/core/agent-loop/tests/tool-calls.spec.ts` 固定写方行为：失败的独占分组用 `TOOL_OUTCOME_UNKNOWN` 关闭其已记录的调用、用 `TOOL_NOT_STARTED` 关闭从未启动的调用；失败的并行分组关闭其未启动的同组成员；之后的派生历史没有未应答调用；被拒绝的恢复追加仍会上报调度器失败。

`packages/compaction/compaction/tests/tool-pairing.spec.ts` 固定：已关闭步骤从未应答的调用不约束任何切分点，而打开的调用仍然约束。`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` 固定范围选择会越过这类调用，而不是停在它之前，并固定摘要前缀会省略它。

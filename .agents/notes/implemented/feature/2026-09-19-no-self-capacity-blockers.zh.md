# Agent Note: 由部署提供的提示词策略文本

Status: implemented

[English](2026-09-19-no-self-capacity-blockers.md) | 中文

## 问题

agent（智能体）会从 harness 自身的措辞中虚构出一份预算。压缩检查点写着较早的一段对话被压缩「to free up context」，这指明了一个刚刚发生变化的量，于是模型可能把腾出的空间读成一份必须精打细算使用的配额，并在配额看起来不多时停下来。目标策略把难度、不确定性和仍有用的剩余工作列为不充分的阻塞理由，却没有说明什么才算充分；goal-round 提示词的完成协议以「If work remains, leave the goal active for the next round」结尾，这读起来像是允许用一份状态汇报结束一轮。实际观察到的 Round 以「my context is limited」和「I need a fresh session so I am handing off here」为由阻塞，并汇报一项待做的整文件重构的规模，而不是开始做它。

执行侧只要达到配置的 Round 数就接受任何非空 `blocked_reason`，因此模型给出借口的那一刻，运行时没有任何东西反驳它，Round 计数下限也只是把它推迟。

## 决策

三个经过校验的字符串字段承载模型可见策略，且默认都为空，因此默认部署的提示词文本、工具 schema、执行器行为与会话录制输出逐字节保持不变。凡是改变模型可见文本的内容都以文本传入：没有任何布尔值在本包撰写的措辞之间做选择。

### 目标策略与容量筛查

[`dsh-tool-goal`](../../../../packages/goal/tool-goal/README.zh.md) 提供 `blockedReasonPolicy?: string`，原样追加到 `tool:goal` 系统提示词章节。提供文本同时会开启容量筛查，因为运行时不予强制的策略只是说明而非策略：`src/blocker.ts` 保存容量词表（context、token、budget、compact、session、exhausted、exhaustion）与外部条件词表（环境拒绝的访问、凭据与人类决定、产品需求），`update_goal` 在 `action: blocked` 时拒绝只提到容量而未给出外部条件的理由，以 `GOAL_TOOL_BLOCK_REASON_CAPACITY` 返回，任何 Round、任一权限下都如此，且先于 Round 计数门槛。

两半彼此独立，README 也写明这一点：文本告诉模型部署允许什么，词表才是执行时检查的内容。不允许词表所接受的任何措辞的策略会让模型无法报告阻塞；允许超出词表范围的策略会被执行侧拒绝。

### 检查点框架

[`dsh-compaction-basic`](../../../../packages/compaction/compaction-basic/README.zh.md) 提供 `checkpointNotice?: string`，追加到每个检查点前导。框架标签由本包拥有，因此配置会拒绝包含 `<compacted-summary>` 或 `</compacted-summary>` 的声明，而不是让部署破坏合并既有检查点的回放约定。`frameSummary` 以可选参数接收该声明，因此默认调用点渲染的前导保持不变。

### Goal Round 提示词

[`dsh-goal-round-driver`](../../../../packages/goal/goal-round-driver/README.zh.md) 提供 `roundProtocol?: string`，它替换渲染出的 `<goal_round>` 块中本包的默认完成协议；为空或未提供时渲染 `STANDARD_PROTOCOL`。该包的不变式伴生入口接收同一个 `roundProtocol`，并按配置的文本校验每条 goal 来源消息，因此对部署自己的措辞仍保持精确校验，而不是接受任何内容。在一种协议下录制的会话，在驱动器配置为另一种协议时会使不变式失败，这是自行拥有措辞的代价。

### 这些设置在哪里组合

`tool-goal` 与 `compaction-basic` 是 agent preset 行，因此由 preset 提供它们的文本；web bundle 正是因此禁用了它们的 host 行。`goal-round-driver` 与 goal 服务一起留在 host 平面，Gateway 远程端点在那里解析 goal 领域，因此它的行在 profile 层组合，而不是由 preset 组合。

## 测试

三个包中的单元测试覆盖默认值与提供的文本：默认路径保持现有指引、前导、Round 提示词以及接受任何非空理由；提供的策略被原样追加，并筛查执行器的拒绝与外部条件放行；提供的声明落在替换检查点上；提供的协议被排入模型并由不变式校验，一旦配置了另一种协议，默认文本即被拒绝。配置校验覆盖非字符串值以及携带框架标签的声明，容量词表本身直接断言三种结果：只含容量、容量加外部词项、以及不含容量词项。由于所有默认值为空，录制会话语料与工具目录都保留已提交的模型可见文本；只有生成的配置目录新增这三个字段。

## 考虑过的替代方案

- **用布尔值在本包撰写的文本之间切换**——不予采纳：开关把措辞对部署隐藏起来，而更严格的措辞是部署对模型行为的选择，不是默认实现中的缺陷。
- **追加而非替换 Round 协议**——不予采纳：想要不同措辞的部署会保留本包的协议文本，包括它正想移除的交接句，并且必须复述其余指令才能控制结果。
- **让不变式接受任何 goal 来源消息**——不予采纳：配置提供文本时，不变式仍能精确比对；放弃比对照等于移除了「续行消息是渲染出的提示词而非伪造内容」的唯一检查。
- **让容量筛查无条件生效**——不予采纳，理由与文本相同：未声明任何策略的部署不应被强制一套策略，而无条件的筛查会改变默认行为与所有已录制的执行器快照。
- **把 `goal-round-driver` 移入 preset，让 preset 拥有 Round 提示词**——不予采纳：已记录的 [host 平面决策](../../../notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.zh.md)把 goal 服务及其会话驱动器保留在 Gateway 远程端点可解析之处，而省略该行的 preset 会静默失去自动续行。
- **把更严格的文本作为新默认值随附**——不予采纳：那会为每个部署改变所有已录制的系统提示词、工具 schema 与 goal-round fixture，属于默认策略变更，而不是配置面。

## 后果

- 默认部署在行为、token 与录制输出上都不受影响；这些字段存在，但在部署提供文本前不生效。
- 提供文本的部署自行拥有其措辞；生成的目录与录制会话语料只固定默认值，因此本仓库无法评审该部署的模型读到的内容。
- 容量筛查基于词表并随提供的策略生效：同时提到容量与听起来像外部条件的短语的理由会通过，而只用容量词汇表述的真实障碍会被拒绝，直到用其他说法重新表述。
- Round 提示词的不变式与配置相关：在一种协议下录制的会话在另一种协议下会失败，因此更改协议的部署会影响其自身早期会话的回放。

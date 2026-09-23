---
description: "Web GUI 新建会话界面的 agent harness（智能体框架）选择器：选择由哪个已挂载的 harness 运行新会话，并回读既有会话所运行的 harness；供挂载多个 harness 的部署的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-harness

[English](README.md) | 中文

## 概述

从本部署挂载的 harness 中选择由哪个 agent harness 运行新的 Web GUI 会话。菜单每一行都带有该 harness 自己的名称与描述，选择会被暂存为该会话创建时所用的 harness。已存在的会话显示它所运行的 harness，且不提供切换，因为另一个 harness 无法继续该会话。挂载不足两个 harness 的部署不渲染任何控件，其创建请求也保持不变。

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

把本插件与对话包一起挂载；新建会话界面随后在工作区与 agent 模式控件旁得到 `conversation.hero.agentHarness` chip。已挂载的 harness 来自宿主目录：插件生效时读取一次，每次重连后再读一次，两个界面每次挂载时也各读一次；读取失败时 chip 保持它已有的目录。

在会话标题左侧，同一插件还提供 harness 标记：一个 `HarnessBadge`，显示当前打开的会话由哪个 harness 拥有；只要会话记录了 harness 就会渲染，无论部署挂载一个还是多个。它不承载任何操作，因为 harness 在创建时即已固定。

### 选择 harness

chip 显示当前界面上这个会话将运行的 harness，并打开一个列出全部已挂载 harness 的菜单，每行带各自的名称与描述。第一个已挂载的 harness 是初始选择，选择后立即替换。

在尚无会话时，该选择暂存在 Session Controller 上，因此工作区流程发出的创建请求会带上它。该流程会先发布会话、再由用户选择 harness，因此这个会话仍处于待定状态：chip 在此继续提供菜单，选择会通过 `sessions.bindHarness` 记录 harness，而不是依赖一个已经发出的创建请求。两种情况下，该选择同时成为下一个新会话的初始选择。

### 会话存在之后

会话会记录其 harness，宿主拒绝把该会话交给第二个 harness。因此对于已经开始轮次的会话，chip 显示该会话记录的 harness，处于禁用状态，并以该 harness 自己的描述作为工具提示；日志中未记录 harness 且已无法再接受选择时会话不渲染任何内容。该记录通过 `agentHarness` 会话投影到达浏览器，由 [`dsh-agent`](../../core/agent/README.zh.md) 以只读方式发布。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

一个控制器（`seat-store.ts`）在快照 store 中保存目录与暂存的选择；chip 组件只是对该 store、标准会话 seat 及其自身 locale 命名空间的呈现。插件通过 `slots.inject('conversation.hero.agentHarness', ...)` 注册 chip，因此该贡献等待 ui-conversation 的声明，而不依赖 apply 顺序，并随插件 fiber 一同移除。目录读取使用 `ctx.remote.session.harnessCatalog`，暂存使用 `ctx.sessions.stageHarness`，由 Session Controller 的 client 应用到下一个既未显式指名 harness、也未携带既有身份的创建请求上。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-agent](../../core/agent/README.zh.md) —— harness 注册表，以及本 chip 所报告的持久化 `agent/harness` 记录。
- [dsh-api-session-controller](../../api/session-controller/README.zh.md) —— `session.harnessCatalog` Remote 与携带该选择的创建请求。
- [ui-conversation](../ui-conversation/README.zh.md) —— 声明本 chip 所填充 seat 的 hero 行。
- [ui-agent-preset](../ui-agent-preset/README.zh.md) —— 同一行上相邻的暂存式选择。
- [客户端包地图](../README.zh.md) —— 相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由新会话创建时所用的 agent harness；该 harness 拥有所有面向模型的效果。

#### KV Cache 影响

没有直接的失效影响。选择 harness 只决定由哪个 harness 创建下一个会话；它既不改变运行中会话的请求前缀，也不改写既有会话记录的 harness。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了当前的 harness 界面。

- **菜单需要一个无会话的界面** —— 工作区流程一旦连接工作区就会创建会话，因此选择器仅在当前无会话时提供；已经存在的空白会话与其他会话一样显示其记录的 harness。
- **注册顺序决定初始选择** —— 目录按注册顺序发布已挂载的 harness，且不指定默认项，因此第一个已挂载的 harness 既是 chip 的初始选择，也是此后每个新会话的起点，直到被新的选择替换。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。这是浏览器侧界面插件，其 Node 侧不拥有事件流或可变运行时数据；目录与暂存的选择属于 Session Controller，记录的 harness 属于 `dsh-agent`。

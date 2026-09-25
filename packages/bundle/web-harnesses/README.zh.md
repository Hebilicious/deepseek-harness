---
description: "dsh 浏览器 profile，同一个 GUI 提供所有 agent harness：进程内循环、Codex，以及配置好的 ACP harness，按会话选择。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-harnesses

[English](README.md) | 中文

## 概述

运行 `dsh web`，为每个会话选择由哪个 agent harness 运行。该层叠放在 [`dsh-base`](../base/README.zh.md) 与 [`dsh-web-app`](../web-app/README.zh.md) 之上，把进程内 agent 循环保留为 `dsh` harness，并加入 Codex 驱动器以及每个已配置 harness 对应的一条 ACP 驱动器条目：Devin、Grok Build、opencode、mimocode 与 Claude Code。每个 harness 保留自己的循环、提示词、工具、MCP 服务器与配置，而 dsh 保留会话、transcript、审批、通知与模型选择器。每个 harness 都必须在本机安装并已登录，且各自启动自己的进程。

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

### 启动 profile

```sh
dsh web
```

`web` profile 模板随 dsh 提供，按顺序叠放 `dsh-base`、`dsh-web-app` 与本 bundle，因此 harness 选择器是普通浏览器界面的一部分。若某个 home 的 `web` profile 在该层出现之前就已初始化，可用 `web-harnesses` 模板，它列出同样的三个 bundle。

### 安装到其他 profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-web-harnesses
dsh plugin --profile <name> remove @deepseek-ai/dsh-web-harnesses
```

随附 bundle 从 dsh 安装中解析；由于该包声明 `dsh.bundle.patch`，启动器会为该 profile 启用这一层。该层期望 profile 已包含它要修补的行，因此请在 `dsh-base` 与 `dsh-web-app` 之后添加。挂载单 harness bundle（例如 `dsh-web-codex`）的 profile 不得同时挂载本层，因为那个 bundle 会禁用本层保留的 `agent-loop` 行。

### 该层改动的内容

| 目标行 | 改动 |
|---|---|
| `agent-default-model` | `provider: ''`、`model: ''`：部署级默认值只属于某一个 harness 的目录路由，因此在选择器或 `model/selection` 选定之前，会话不携带默认值 |
| `session-title-llm` | 固定为 `deepseek-official` / `deepseek-flash`，因为外部 harness 的会话记录路由是仅提供目录的 adapter，不提供流式输出 |
| `agent-codex` | 插入：每个 profile 一个共享 app-server，每个会话一个 Codex 线程 |
| `agent-acp` | 插入五条 harness 条目，各一个进程：`devin`、`grok`、`opencode`、`mimo`、`claude` |
| `agent-tool-bridge` | 插入：为每个 agent 提供一个经认证的回环 MCP 端点，把会话作用域内可见的 dsh 工具提供给外部 harness，排除每个 harness 原生已有或只有进程内循环才能驱动的工具名 |

harness 行本身就是普通的 profile 配置。在 profile 自己的 `cordis.patch.yml` 中改写、添加或移除 ACP 条目，选择器会跟随已挂载的集合。

### Claude Code 通过适配器运行

Claude Code 自身不使用 Agent Client Protocol，因此 `claude` 条目运行 [Agent Client Protocol 项目的适配器](https://github.com/agentclientprotocol/claude-agent-acp)，由该适配器在底层驱动 `claude` CLI。条目固定了适配器版本并用 `npx` 解析；若机器已全局安装适配器，可把这两个字段替换为 `executable: claude-agent-acp` 且不带参数。该适配器通过 ACP 方法而非 CLI 命令报告授权状态，因此两个命令列表为空，并且服务进程的 `PATH` 中必须有 `claude`。

驱动器约定、配置与限制见 [`dsh-agent-codex`](../../core/agent-codex/README.zh.md) 与 [`dsh-agent-acp`](../../core/agent-acp/README.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 补丁语义

补丁会替换目标行的整个 `config`，`insert` 列表追加新行。因此本 bundle 只声明自己拥有的内容：两项 id 定位的覆盖与三行插入。profile 自己的 `cordis.patch.yml`、home 级补丁以及任何 `--patch` 覆盖仍在本层之后应用，因此部署可以在不修改 bundle 的情况下新增 harness、改写可执行文件或调整沙箱策略。

### 为什么多个 harness 可以共存

每个驱动器通过 `ctx.agents.registerHarness({ id, name, factory })` 注册工厂，进程内循环也以同样方式注册 `dsh` harness，因此一个进程为每个 harness id 持有一个工厂。`session.create` 指定 harness，所属工厂在发布前的后缀中把它记录为 `agent/harness` 事件，`resume` 依据该记录路由。命名未挂载 harness 的请求会列出已挂载的 id 并失败，而不会回退到另一个。

### 为什么标题请求要改路由

`dsh-session-title-first-prompt-llm` 会解析会话记录的路由。对外部 harness 而言，该路由是仅提供目录的 adapter，其 `stream()` 总是抛出，因此本层把标题行固定到 base 挂载的 DeepSeek 路由：无论哪个 harness 运行轮次，标题都照常工作。

### 源码映射

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 整个层：两项覆盖与插入的桥接与驱动器行 |
| [`src/index.ts`](src/index.ts) | 仅模块标记；该包不提供运行时 API |
| [`packages/boot/app-boot/src/profile.ts`](../../boot/app-boot/src/profile.ts) | 叠放本 bundle 的 `web` 与 `web-harnesses` profile 模板 |

</details>

**运行时不变式：** 不发布配套 invariant，因为本 bundle 是补丁层：它把默认模型与标题路由指向与 harness 无关的值，并插入驱动器行。驱动器包拥有生命周期与协议不变式，而本 bundle 不持有自己的可变关系。

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-agent-acp](../../core/agent-acp/README.zh.md)——本层为 Devin、Grok Build、opencode 与 mimocode 挂载的 ACP 驱动器。
- [dsh-agent-codex](../../core/agent-codex/README.zh.md)——本层挂载的 Codex app-server 驱动器。
- [dsh-agent-tool-bridge](../../core/agent-tool-bridge/README.zh.md)——把作用域内 dsh 工具提供给已挂载外部 harness 的回环 MCP 桥。
- [dsh-agent](../../core/agent/README.zh.md)——每个驱动器注册所用的 harness 注册表。
- [dsh-web-app](../web-app/README.zh.md)——本层所基于的浏览器界面。
- [Bundle 包地图](../README.zh.md)——基于同一核心构建的各个界面。

-----

<a id="model-experience"></a>
## 模型体验

### 由 harness 拥有的会话轮次

#### 模型看到什么

每个会话的轮次在用户选定的 harness 内运行。对 `dsh` harness 而言就是 base 自己的循环、提示词与工具；对其他 harness 而言则是该 harness 的提示词、历史与工具定义，dsh 只贡献会话领取的用户输入，以及从该 harness 流式条目投影出的持久 transcript。

#### Token 影响

运行在外部 harness 上的会话不再为 base 的提示词分段与工具 schema 付费，而由该 harness 为自己的部分付费。模型与推理强度按会话、按 harness 选择，因此同一条提示词的成本取决于由谁运行。

#### KV Cache 影响

外部会话的请求前缀由 harness 拥有，因此 dsh 既无法保证也无法测量复用。更换 harness、模型或推理强度，或在无法恢复的会话之后开启新的 harness 侧会话，都会产生与先前前缀不匹配的请求。

### 会话标题请求

#### 模型看到什么

首条提示词标题提供方发送一个小请求，携带会话的起始用户消息与字数指令。本层把该请求固定到 `deepseek-official` / `deepseek-flash`，因此它永远不会解析到仅提供目录的 harness 路由。

#### Token 影响

每个会话一次有界标题请求：最多 4096 输入字节与 64 输出 token，超时 60000 毫秒。

#### KV Cache 影响

与会话的 harness 轮次相互独立；标题请求有自己的短提示词，不复用也不使会话前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该 profile 何时不适合使用，或需要运维上的注意。它们是当前包约束，不是任务积压。

- **该 profile 不提供部署级默认模型**——默认值只属于某一个 harness 的目录路由，因此本层将其清空。运行在进程内 `dsh` harness 上的会话需要在首轮之前于选择器中选定模型，而外部 harness 会在会话记录 `model/selection` 之前应用自己的默认值。
- **每个外部 harness 都是独立程序**——Codex 与每条 ACP 条目各自启动进程：app-server 在首个会话绑定时启动，ACP harness 在首个会话绑定或模型选择器首次请求其目录时启动。每个可执行文件都必须已安装、已登录，并且能被服务进程按名称或绝对路径找到；对 mimocode 而言通常意味着把其安装目录加入 `PATH`，对 Claude Code 而言则意味着 `claude` 与可解析的适配器都要存在。
- **Claude Code 依赖第三方适配器**——`claude` 条目运行 `@agentclientprotocol/claude-agent-acp`，版本在本 bundle 中固定，并在首次使用时由 `npx` 获取；因此在适配器被缓存之前该 harness 需要网络访问，并且适配器必须与其驱动的 `claude` CLI 保持同步。Anthropic 未提供 ACP 模式，本 bundle 中该适配器是唯一受支持的路径。由于目录探测默认开启，全新安装中的首次模型选择器读取就会解析并启动该适配器；若部署在选定 Claude 会话之前不得运行它，可在该条目上设置 `probeCatalog: false`，并全局安装适配器，将 `executable` 设为 `claude-agent-acp` 且不带参数。
- **一个会话只属于一个 harness**——记录的 `agent/harness` 事件在创建时将其固定。以其他 harness 恢复该会话会被拒绝，因为另一个 harness 无法继续这段对话。
- **未记录 harness 的会话由进程内循环恢复**——在 `agent/harness` 记录出现之前写下的日志由进程内循环驱动，因此打开或 fork 它会在 `dsh` 上继续，并从那时起记录该 harness。记录着本 profile 未挂载的 harness 的会话仍会被拒绝。
- **审批与沙箱策略按 harness 各自生效**——每条 ACP 条目携带自己的 `sandbox` 与 `approval` 默认值；不提供只读模式的 harness 无法满足只读预期，驱动器会记录实际生效的模式。
- **模型目录来自 harness**——条目读取自已绑定会话自身的通告或配置好的目录命令，因此不可达或损坏的 harness 可执行文件会让其分组在选择器中为空。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>

---
description: "由 Codex 驱动的 dsh 浏览器 profile：与 dsh-web-app 相同的 GUI 与核心，但由共享的 `codex app-server` 服务每个会话，而不是进程内循环。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-codex

[English](README.md) | 中文

## 概述

运行 `dsh --profile web-codex` 可获得与 `dsh --profile web` 相同的浏览器 GUI，但每个会话都绑定到共享 `codex app-server` 进程上各自的 Codex 线程。该层叠加在 [`dsh-base`](../base/README.zh.md) 与 [`dsh-web-app`](../web-app/README.zh.md) 之上，禁用进程内 agent（智能体）loop，并插入 Codex 驱动器。此后 Codex 拥有循环、提示词、工具、MCP 服务器与配置，而 dsh 保有会话、transcript（文本记录）、审批、通知与模型选择器。你需要已登录的 Codex 账号，且一个 profile 只运行一个驱动器。

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
dsh --profile web-codex
```

`web-codex` profile 模板随 dsh 发布，并按此顺序叠加 `dsh-base`、`dsh-web-app` 与本 bundle。启动过程、打印的 URL 行、浏览器交接以及 GUI 本身的表现与 [`dsh-web-app`](../web-app/README.zh.md) 所述完全一致；差别只在于每个会话背后的驱动器。

### 安装到其他 profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-web-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-web-codex
```

随包发布的 bundle 从 dsh 安装目录解析；由于本包声明了 `dsh.bundle.patch`，启动器会为该 profile 激活这一层。该层要求 profile 中已存在它要打补丁的配置行，因此请在 `dsh-base` 与 `dsh-web-app` 之后添加。

### 该层改变了什么

| 目标配置行 | 变更 |
|---|---|
| `agent-loop` | 被禁用，因此该 profile 的每个会话都由 Codex 运行，而不提供并行挂载的循环 |
| `agent-default-model` | `provider: codex`、`model: ''`，因此新会话在选择器或 `model/selection` 做出选择之前不携带模型 |
| `session-title-llm` | 固定为 `deepseek-official`／`deepseek-flash`，因为会话记录的路由是仅提供目录、不提供流的 `codex` 适配器 |
| `agent-codex` | 被插入：每个 profile 一个共享 app-server，每个会话一个 Codex 线程 |

驱动器自身的约定、配置与限制见 [`dsh-agent-codex`](../../core/agent-codex/README.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 补丁语义

补丁会替换目标配置行的整个 `config`，而 `insert` 列表会追加新的配置行。因此本 bundle 只声明它拥有的内容：两个按 id 定位的覆盖、一个禁用，以及一个插入的配置行。profile 自身的 `cordis.patch.yml`、home 级补丁与任何 `--patch` 覆盖仍在该层之后生效，因此部署无需修改 bundle 即可重新指定驱动器的 `codexHome`、沙箱或审批策略。

### 为什么循环离开了组合

`dsh-agent-loop` 注册 `dsh` harness，`dsh-agent-codex` 注册 `codex` harness，因此组合可以同时挂载两者。本层只保留 Codex：禁用 base 的 `agent-loop` 配置行并插入该驱动器，把 harness 选择交给 profile 而不是选择器。当一个 profile 需要同时提供两者时，请使用 [`dsh-web-harnesses`](../web-harnesses/README.zh.md)。

### 为什么标题请求被改道

`dsh-session-title-first-prompt-llm` 会解析会话记录的路由。在该 profile 中，这条路由是 `codex` 提供方，即 `stream()` 总会抛出的仅目录适配器。本层把标题配置行固定到 base 挂载的 DeepSeek 路由，因此会话本身运行在 Codex 上时，会话标题依然可用。

### 源码映射

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 整个层：一个禁用、两个覆盖与驱动器插入 |
| [`src/index.ts`](src/index.ts) | 仅模块标记；本包不携带运行时 API |
| [`packages/boot/app-boot/src/profile.ts`](../../boot/app-boot/src/profile.ts) | 叠加本 bundle 的 `web-codex` profile 模板 |

</details>

**运行时不变式：** 不发布伴随包，因为本 bundle 是一层补丁：它禁用 `agent-loop` 配置行，把默认模型与标题路由指向 Codex 驱动器，并插入驱动器配置行。生命周期与协议不变式由驱动器包负责，本 bundle 自身没有可变关系需要检查。

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-agent-codex](../../core/agent-codex/README.zh.md)——本层挂载的驱动器、其配置与限制。
- [dsh-web-app](../web-app/README.zh.md)——本层所构建于其上的浏览器界面。
- [dsh-base](../base/README.zh.md)——每个基于 base 的 profile 都从它开始的共享核心。
- [Bundle 包地图](../README.zh.md)——构建在同一核心之上的各种界面。
- [Profile 插件 bundle](../../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md)——profile 与 bundle 的组合设计。

-----

<a id="model-experience"></a>
## 模型体验

### 由 Codex 驱动的会话轮次

#### 模型看到什么

每个会话的轮次都运行在 Codex 内部，因此模型看到的是 Codex 自己的提示词、历史与工具定义，而不是 base 组装的 dsh 版本。dsh 贡献会话领取到的用户输入，以及它从 Codex 流式条目投影出的持久 transcript。

#### Token 影响

base 的提示词 section 与工具 schema 不再抵达模型，其每步成本随之消失。改由 Codex 为自己的提示词与工具付费，且会话选定的推理强度会改变它消耗的思考 token 量。

#### KV Cache 影响

请求前缀由 Codex 拥有，因此 dsh 既不能保证也无法测量复用。更换模型或推理强度，或在线程无法恢复后启用新的 Codex 线程，都会发起一个此前缀可能不匹配的请求。

### 会话标题请求

#### 模型看到什么

首条提示词标题提供方会发送一个小请求，携带会话的开场用户消息与词数指令。本层把该请求固定到 `deepseek-official`／`deepseek-flash`，因此它绝不会解析到仅提供目录的 `codex` 路由。

#### Token 影响

每个会话一次有界标题请求：最多 4096 输入字节与 64 输出 token，超时 60000 毫秒。

#### KV Cache 影响

与会话的 Codex 轮次相互独立；标题请求有自己简短的提示词，既不复用也不使会话前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本 profile 何时不合适或何时需要运维注意。它们是当前包约束，不是任务积压。

- **该 profile 只运行一个驱动器**——本层禁用 `agent-loop`，因此每个会话都运行在 Codex 上，harness 选择器只有一个条目。需要挂载多个 harness 时请使用 [`dsh-web-harnesses`](../web-harnesses/README.zh.md)。
- **轮次归 Codex，外壳归 dsh**——循环、提示词、工具、MCP 服务器与配置都位于 Codex；dsh 保留持久会话、transcript、审批、通知与模型选择器，并每轮转发选择器的选择。
- **需要 Codex 账号，且不由此包提供**——在配置的 `CODEX_HOME` 完成 `codex login`，或由 `credentialRef` 提供 API key 之前，驱动器的 `codex app-server` 无法绑定会话；dsh 既不保存也不提供 Codex 凭据。
- **模型选择器依赖该 CLI**——条目来自 app-server 的 `model/list`，因此 `codex` 二进制不可达、损坏或缓慢时，选择器为空。
- **标题仍走 DeepSeek 路由**——本层把 `session-title-llm` 固定到 `deepseek-official`／`deepseek-flash`；移除或重命名该路由的部署必须重新指定该配置行，因为 `codex` 路由不提供流。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

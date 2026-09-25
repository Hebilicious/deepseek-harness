# Agent Note: Codex 子级推理强度

Status: implemented
Archived: 2026-09-24

[English](2026-09-13-codex-child-reasoning-effort.md) | 中文

## Problem

[Codex subagent 提供方](../../../../packages/subagent/subagent-codex/README.zh.md)可以固定子级的模型、权限模式、环境与释放宽限，却无法固定它的推理强度。因此强度来自 Codex 自身的解析结果：用户的 `~/.codex/config.toml`，再被被委派项目的 `.codex/config.toml` 覆盖，并经 `thread/start` 的 `reasoningEffort` 回报。

于是一次希望与交互式 Codex 会话使用不同强度的委派只剩坏选项。把提供方配置项指向第二个 `CODEX_HOME` 确实能让子级读取另一份配置，但那个 home 需要自己的身份验证，而且它的 `auth-locks` 目录与另一份账号 token 放在一起。改共享的 `~/.codex/config.toml` 又会改变每一个交互式 Codex 会话。

[产品 subagent 后端](2026-08-04-claude-code-and-codex-subagent-backends.zh.md)这篇笔记拥有该提供方既有形态：每次运行一个新进程、新线程、新轮次，Codex 原生配置是权威。[凭证记录与授权流程](../architecture/2026-08-13-credential-records-and-authorization-flows.zh.md)这篇笔记拥有"harness 为何不读取其他工具的凭据文件"这一决定。

## Decision

`@deepseek-ai/dsh-subagent-codex` 接受可选的非空 `reasoningEffort`，并把它的值作为该次运行唯一一次 `turn/start` 的 `effort` 字段发送。模型与线程字段保持原位：`thread/start` 仍携带 `cwd`、`ephemeral`、可选 `model` 以及所选权限模式。

该字段就是所固定协议自有的每轮覆盖，生成 schema 对它的描述是"覆盖本轮及后续轮次的推理强度"。一次运行就是一条线程中的一个轮次，因此每轮覆盖恰好等于该提供方实例的作用域，也就不需要第二个 Codex home 来表达它。省略时不发送该字段，Codex 自身的解析结果继续生效。

取值是与协议 `ReasoningEffort`（模型公布的推理强度值）以及既有 `model` 字段一致的自由格式非空字符串。提供方不发现推理强度、不改写拼写、也不设置回退。

## Alternatives considered

- **按强度使用第二个 `CODEX_HOME`。** 它当下可用，也是此前的临时做法，但子级因此拥有独立的 Codex 状态与独立的身份验证。以软链接共享账号 token 会让两个 home 共用一个文件、却各有一个 `auth-locks` 目录，于是并发刷新没有互斥；复制它则会产生第二条刷新谱系，并可能使第一条失效。
- **在 `thread/start` 上设置 `config.model_reasoning_effort`。** 协议在那里接受任意配置覆盖，并在 `ThreadStartResponse.reasoningEffort` 中回报解析结果，因此可观测。但它是原始配置逃生口而非类型化字段，配置键一旦改名就会静默失效。
- **要求推理强度只能取固定集合中的值。** 协议并不约束它，模型各自公布自己的级别，而提供方不发现模型；固定列表既会拒绝更新的级别，也无法验证模型确实遵守它。
- **只把强度留给原生配置。** 这让提供方更小，但委派也就无法与交互式 Codex 会话不同，而这正是该设置的唯一目的。

## Consequences

Profile 配置项固定子级强度，既不触碰 `~/.codex/config.toml`、被委派项目的 Codex 配置，也不需要第二个 Codex home。提供方仍以原有的粗粒度类别报告 `turn/start` 失败，强度搭载在同一条经过校验的纯文本轮次上。

由于协议接受任意非空字符串，拼写错误的级别会未经校验地抵达 Codex。提供方不检测服务端如何使用它，因此 README 陈述目标模型公布的取值，而不假装做过校验。

## Testing

提供方测试固定配置 schema（接受非空值、拒绝空值），并以 `reasoningEffort: 'max'` 对假 app-server 跑一次完整的委派启动，断言 `turn/start` 负载携带 `effort: 'max'`，而 `thread/start` 不携带任何 `effort`。既有的精确负载 wire 测试继续断言未配置的 wire 不发送 `effort` 字段。

实现前用两次针对所固定 0.153.4 app-server 的实时探测确立了该机制：`turn/start` 在 `experimentalApi: false` 下接受 `effort`，而 `thread/start` 会回报 Codex 从原生配置解析出的强度，配置值覆盖的正是它。

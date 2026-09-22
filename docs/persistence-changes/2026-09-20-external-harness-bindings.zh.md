---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-20-external-harness-bindings

[English](2026-09-20-external-harness-bindings.md) | 中文

## 概述

新增两个仅供日志的 Session 事件，把 Session 绑定到外部 harness 自己的会话身份：agent-codex/thread 携带 Codex 线程 id，agent-acp/session 携带 ACP 会话 id。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-20-external-harness-bindings
baseline: false
changes:
  - root: "event:agent-acp/session"
    previous: null
    after: "f00b255540ce6368d8eabf9ef1f7b683a3e16d11af63b89c60542ca8251c708e"
    decision: same-version
  - root: "event:agent-codex/thread"
    previous: null
    after: "2fc23180e2c3b84732b2f63a11ad05f457b45371ffe49e1e4b01bb2f6639713c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

同版本新增。既有记录仍然有效，未挂载 Codex 或 ACP 驱动器的构建永远不会写入这两个事件。两者都是读取时必需而非可忽略：不声明它们的构建会拒绝包含该事件的日志，因此由 Codex 或 ACP profile 创建的会话需要由携带对应驱动器的构建打开。每个事件在绑定时只追加一次，位于发布前的后缀中；resume 读取折叠结果并以记录的 id 调用 thread/resume 或 session/load。磁盘上没有 rollout 的 Codex 线程会改用新线程，此时追加第二个 agent-codex/thread 事件并把折叠结果重新绑定到最新 id。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/agent-codex/tests packages/core/agent-acp/tests packages/subagent/subagent-codex/tests packages/subagent/subagent-acp/tests：19 个文件、444 个测试通过。pnpm exec vitest run packages/core/agent-loop/tests packages/core/agent-external/tests：25 个文件、479 个测试通过。pnpm run test:snapshot：160 个通过、2 个跳过。

<a id="dev-note"></a>
## 开发备注

无。

---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-22-agent-harness-record

[English](2026-09-22-agent-harness-record.md) | 中文

## 概述

新增一个仅供日志的 Session 事件 agent/harness，记录该会话的 agent 由哪个 agent harness 拥有。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-agent-harness-record
baseline: false
changes:
  - root: "event:agent/harness"
    previous: null
    after: "297cac9c86389e3507f2163d2ba3b29717b893c0735df5ef3a2940fcc45f20ae"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

同版本新增。既有记录仍然有效，其中没有该事件，resume 会将其解析为写下所有先于该记录的日志的进程内循环；挂载多个 harness 却没有循环的部署会拒绝这样的 resume。事件由拥有该会话的 harness 自己的工厂在发布前的后缀中追加一次，因此在任何轮次运行前即已持久化。它与所有已声明事件一样是读取时必需的：不声明它的构建会拒绝包含该事件的日志，因此由多 harness 部署创建的会话需要由携带该事件词汇的构建打开。resume 依据记录的 id 路由，命名其他 harness 的请求会被拒绝，而不会在第二个 harness 下重放该会话。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/agent/tests packages/core/agent-external/tests packages/core/agent-loop/tests：通过。pnpm exec vitest run packages/api packages/session：通过。pnpm run test:snapshot：通过。

<a id="dev-note"></a>
## 开发备注

无。

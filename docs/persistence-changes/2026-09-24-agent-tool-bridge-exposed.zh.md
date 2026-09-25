---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-agent-tool-bridge-exposed

[English](2026-09-24-agent-tool-bridge-exposed.md) | 中文

## 概述

新增仅记录日志的 agent-tool-bridge/exposed Session 事件，记录 agent-tool-bridge MCP 端点向外部 harness 暴露的工具名列表。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-agent-tool-bridge-exposed
baseline: false
changes:
  - root: "event:agent-tool-bridge/exposed"
    previous: null
    after: "287f7b8c75a974e229b803985696279da5ed8c202564ff8686ef4b1dab68b8aa"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录不受影响：本次仅新增一个事件类型，未修改任何现有类型的字段。未声明该事件的构建会拒绝包含它的日志，与 KNOWN_SESSION_EVENT_TYPES 对其它仓库内事件的策略一致。

<a id="verification"></a>
## 验证

npx vitest run packages/core/agent-tool-bridge：bridge 测试断言了追加的事件及其 tools 负载；pnpm run gen-persistence-catalog 已重新生成目录。

<a id="dev-note"></a>
## 开发备注

无。

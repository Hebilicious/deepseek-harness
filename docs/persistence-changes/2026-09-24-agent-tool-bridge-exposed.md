---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-agent-tool-bridge-exposed

English | [中文](2026-09-24-agent-tool-bridge-exposed.zh.md)

## Summary

Adds the log-only agent-tool-bridge/exposed Session event recording the tool names an agent-tool-bridge MCP endpoint exposes to an external harness.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records are unaffected: the change adds one new event type with no field edits to existing types. Builds that do not declare the event refuse logs containing it, matching the KNOWN_SESSION_EVENT_TYPES policy for every other in-repo event.

<a id="verification"></a>
## Verification

npx vitest run packages/core/agent-tool-bridge: bridge spec asserts the appended event and its tools payload; pnpm run gen-persistence-catalog regenerated the catalogs.

<a id="dev-note"></a>
## Dev Note

None.

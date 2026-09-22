---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-20-external-harness-bindings

English | [中文](2026-09-20-external-harness-bindings.zh.md)

## Summary

Adds two log-only Session events that bind a Session to the foreign harness's own conversation identity: agent-codex/thread carries the Codex thread id and agent-acp/session carries the ACP session id.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Same-version addition. Existing records remain valid, and a build with no Codex or ACP driver never writes these events. Both types are required-on-read rather than ignorable: a build that does not declare them refuses a log that contains one, so a session created by a Codex or ACP profile is opened by a build that ships that driver. Each event is appended once, at bind time, inside the pre-publication suffix; resume reads the fold and calls thread/resume or session/load with the recorded identity. A Codex thread with no rollout on disk is replaced by a fresh thread, which appends a second agent-codex/thread event and rebinds the fold to the newest id.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/agent-codex/tests packages/core/agent-acp/tests packages/subagent/subagent-codex/tests packages/subagent/subagent-acp/tests: 19 files, 444 tests passed. pnpm exec vitest run packages/core/agent-loop/tests packages/core/agent-external/tests: 25 files, 479 tests passed. pnpm run test:snapshot: 160 passed, 2 skipped.

<a id="dev-note"></a>
## Dev Note

None.

---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-agent-harness-record

English | [中文](2026-09-22-agent-harness-record.zh.md)

## Summary

Adds one log-only Session event, agent/harness, recording which agent harness owns the session's agent.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Same-version addition. Existing records remain valid and carry no harness event, which resume resolves to the in-process loop that wrote every log predating the record; a deployment mounting several harnesses without a loop refuses that resume. The event is appended once, by the owning harness's own factory, inside the pre-publication suffix, so it is durable before any turn runs. It is required-on-read like every other declared event: a build that does not declare it refuses a log that contains one, so a session created by a multi-harness deployment is opened by a build that ships this vocabulary. Resume routes through the recorded id, and a request that names a different harness is refused rather than replaying the conversation under a second harness.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/agent/tests packages/core/agent-external/tests packages/core/agent-loop/tests: pass. pnpm exec vitest run packages/api packages/session: pass. pnpm run test:snapshot: pass.

<a id="dev-note"></a>
## Dev Note

None.

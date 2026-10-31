---
description: "Shared telemetry transport plugins for business consumers."
kind: "package-group"
---

# telemetry/ — shared reporting

English | [中文](README.zh.md)

## Summary

This group provides reporting infrastructure shared by product analytics, feedback-authorized Session uploads, and agent activity export. Business plugins select events, identities, authorization, and redaction; transport plugins own encoding and delivery.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`otel`](otel/README.md) | Cordis service creating independent ordinary-event, span, and byte-bounded Session-log channels |
| [`agent-telemetry-otel`](agent-telemetry-otel/README.md) | Agent activity as OTLP/HTTP logs and spans, configured by the OpenTelemetry environment variables |

<a id="related-documentation"></a>
## Related documentation

- [OTel subsystem](../../docs/subsystems/otel.md) — shared service and consumer ownership.

<a id="dev-note"></a>
## Dev Note

None.

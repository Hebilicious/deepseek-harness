---
description: "供业务调用方共享的遥测传输插件。"
kind: "package-group"
---

# telemetry/ — 共享上报

[English](README.md) | 中文

## 概述

本组提供产品埋点、反馈授权 Session 上传和智能体活动导出共用的上报基础设施。业务插件选择事件、身份、授权和脱敏规则；传输插件负责编码和投递。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`otel`](otel/README.zh.md) | 创建独立普通事件通道、span 通道和受字节上限约束的 Session 日志通道的 Cordis 服务 |
| [`agent-telemetry-otel`](agent-telemetry-otel/README.zh.md) | 以 OTLP/HTTP 日志和 span 导出智能体活动，由 OpenTelemetry 环境变量配置 |

<a id="related-documentation"></a>
## 相关文档

- [OTel 子系统](../../docs/subsystems/otel.zh.md) — 共享服务与调用方职责。

<a id="dev-note"></a>
## 开发备注

无。

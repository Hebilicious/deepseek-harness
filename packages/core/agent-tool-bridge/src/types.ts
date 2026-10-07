/**
 * Public contract of the `agentToolBridge` service: the tool view an external
 * harness session may reach, the call it may run, and the loopback MCP
 * endpoint that carries both.
 *
 * @module @deepseek-ai/dsh-agent-tool-bridge/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** One dsh tool projected for an external harness: model-facing fields only. */
export interface BridgedTool {
  /** The registered tool name, as `tools/call` names it. */
  readonly name: string
  /** The tool's model-facing description. */
  readonly description: string
  /** The tool's JSON Schema arguments object. */
  readonly inputSchema: Record<string, unknown>
}

/** One tool invocation the endpoint's MCP handler asks the bridge to run. */
export interface BridgeToolCall {
  /** The tool name to execute; must be a member of the agent's bridged set. */
  readonly name: string
  /** Parsed call arguments; the tool's own schema validates them. */
  readonly arguments: unknown
  /** Caller cancellation, forwarded to the tool execution. */
  readonly signal: AbortSignal
}

/** The settled outcome of one bridged call, in dsh content blocks. */
export interface BridgedToolResult {
  /** Model-facing content, or the materialized error text on failure. */
  readonly content: ContentBlock[]
  /** Whether the call failed — policy denial, guard rejection, or tool error. */
  readonly isError: boolean
}

/**
 * One settled bridged execution retained for transcript correlation. The
 * external driver reports the harness's own `tool/call`/`tool/result` pair;
 * the bridge keeps the dsh execution's presentation `meta` so the driver's
 * `tool/result` can carry the same card payload an in-process call logs.
 */
export interface BridgedCompletion {
  /** The dsh tool the call ran — the name `tool/call` is logged under. */
  readonly name: string
  /** Canonical JSON of the call's arguments: object keys sorted recursively. */
  readonly argumentsJson: string
  /** The execution's `presentationMeta` projection, when the tool produced one. */
  readonly meta?: JsonValue
}

/**
 * One opened MCP endpoint, exactly as an ACP `mcpServers` http entry needs it:
 * the URL plus the header set the client must send. `close` revokes the
 * endpoint's credential and stops serving it; the owning agent's disposal
 * closes it implicitly.
 */
export interface BridgeMcpEndpoint {
  /** The MCP server name the endpoint serves under. */
  readonly name: string
  /** Loopback URL the client connects to. */
  readonly url: string
  /** HTTP headers the client must attach to every request. */
  readonly headers: readonly { name: string; value: string }[]
  /** Revoke the endpoint's credential and close its in-flight exchanges. */
  close(): Promise<void>
}

/** Plugin config. Omitted fields take the defaults named on each member. */
export interface Config {
  /** Tool names withheld from every bridged agent (default none). */
  exclude?: string[]
  /** Loopback interface the shared listener binds (default `127.0.0.1`). */
  host?: string
  /** TCP port the shared listener binds; `0` (default) asks the OS for one. */
  port?: number
  /**
   * MCP server identity presented to clients (default `dsh`). It joins the
   * harness-visible tool name `mcp__<serverName>__<tool>` and Codex's
   * `mcp_servers.<serverName>` config key, so empty strings, `.`, and `__`
   * are rejected.
   */
  serverName?: string
  /**
   * Settled bridged calls retained per agent so a harness-reported
   * `tool/result` can pick up the dsh execution's `meta` (default 100). The
   * oldest entry is dropped once the limit is reached.
   */
  correlationLimit?: number
}

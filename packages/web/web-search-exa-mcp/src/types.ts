/**
 * Wire types for the hosted Exa MCP endpoint (`POST https://mcp.exa.ai/mcp`).
 * Types only — no runtime code. One JSON-RPC `tools/call` returns one MCP
 * result whose single `text` content block carries Exa's rendered source
 * blocks; the endpoint has no structured source array.
 *
 * @module @deepseek-ai/dsh-web-search-exa-mcp/types
 */

/**
 * Arguments the endpoint's `web_search_exa` tool accepts. Its input schema sets
 * `additionalProperties: false`, so an unknown argument fails the call.
 */
export interface ExaMcpSearchArguments {
  query: string
  /** The endpoint's result-count control; it defaults to 10 when omitted. */
  numResults?: number
}

/** The JSON-RPC request envelope for one MCP `tools/call`. */
export interface ExaMcpToolCallRequest {
  jsonrpc: '2.0'
  id: number
  method: 'tools/call'
  params: {
    name: string
    arguments: ExaMcpSearchArguments
  }
}

/** One MCP content block. Only a `text` block carries Exa's rendered sources. */
export interface ExaMcpContentBlock {
  type: string
  text?: string
}

/** The `result` arm of the endpoint's JSON-RPC response. */
export interface ExaMcpToolResult {
  /** An entry is `null` when the endpoint sends a malformed content block. */
  content?: (ExaMcpContentBlock | null)[]
  /** True when the endpoint reports a tool-level failure in a 2xx body. */
  isError?: boolean
}

/** The endpoint's JSON-RPC error object. */
export interface ExaMcpError {
  code?: number
  message?: string
}

/**
 * The endpoint's JSON-RPC response envelope, sent either as a plain JSON body
 * or as the `data:` payload of one SSE message.
 */
export interface ExaMcpResponse {
  result?: ExaMcpToolResult
  error?: ExaMcpError
}

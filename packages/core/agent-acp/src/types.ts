/**
 * Client-safe Devin account payloads shared by the Remote surface and its
 * generated client. Shapes are flattened forms of the ACP `initialize`
 * auth-method vocabulary plus the `devin auth` CLI's status output.
 *
 * @module @deepseek-ai/dsh-agent-acp/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A Devin auth status/logout read failed at the CLI or ACP endpoint. */
    'acp/auth-failed': {}
    /** An ACP `authenticate` or `logout` request failed at the agent. */
    'acp/login-failed': {}
  }
}

/** One advertised ACP auth method, flattened for the settings panel. */
export interface DevinAuthMethod {
  /** The method id `authenticate` accepts (`devin-browser` for Devin). */
  readonly id: string
  /** Human-readable method label. */
  readonly name: string
  /** What the method does, when the agent described it. */
  readonly description?: string
}

/** The Devin agent's account state, connection-global. */
export interface DevinAccountSnapshot {
  /** Whether the agent's initialize response is available (the connection is up). */
  readonly connected: boolean
  /** The auth methods the agent advertised. */
  readonly authMethods: readonly DevinAuthMethod[]
  /** The `devin auth status` CLI verdict, when the CLI answered. */
  readonly cliLoggedIn?: boolean
  /** The trimmed `devin auth status` output, when the CLI answered. */
  readonly cliDetail?: string
  /** Agent info (`name`/`title`/`version`) the agent reported at initialize. */
  readonly agentInfo?: {
    readonly name: string
    readonly title?: string
    readonly version: string
  }
}

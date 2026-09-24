/**
 * Client-safe ACP payloads shared by the Remote surface and its generated
 * client, plus the model-catalog entry the picker route answers with. Account
 * shapes are flattened forms of the ACP `initialize` auth-method vocabulary
 * plus the harness CLI's status output.
 *
 * @module @deepseek-ai/dsh-agent-acp/types
 */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A harness auth status/logout read failed at the CLI or ACP endpoint. */
    'acp/auth-failed': {}
    /** An ACP `authenticate` or `logout` request failed at the agent. */
    'acp/login-failed': {}
  }
}

/** One model a harness advertises for the model picker. */
export interface AcpCatalogModel {
  /** Model id the session's `model` config option accepts. */
  readonly id: string
  /** Human-readable label. */
  readonly name: string
  /** Cost or capability summary, when the harness reports one. */
  readonly description?: string
  /** Reasoning efforts the session's reasoning-effort option offers, when it advertises one. */
  readonly reasoning?: AcpCatalogReasoning
}

/** One harness's reasoning-effort menu, as its session advertises it. */
export interface AcpCatalogReasoning {
  /** Selectable effort values in advert order. */
  readonly efforts: readonly { readonly id: ReasoningEffortId; readonly name: string; readonly description?: string }[]
  /** The value the session runs before a selection. */
  readonly defaultEffort?: ReasoningEffortId
}

/** One advertised ACP auth method, flattened for the settings panel. */
export interface AcpAuthMethod {
  /** The method id `authenticate` accepts (`devin-browser` for Devin). */
  readonly id: string
  /** Human-readable method label. */
  readonly name: string
  /** What the method does, when the agent described it. */
  readonly description?: string
}

/** One harness's account state, connection-global. */
export interface AcpAccountSnapshot {
  /** Whether the agent's initialize response is available (the connection is up). */
  readonly connected: boolean
  /** The auth methods the agent advertised. */
  readonly authMethods: readonly AcpAuthMethod[]
  /** The auth-status CLI verdict, when the CLI answered. */
  readonly cliLoggedIn?: boolean
  /** The trimmed auth-status CLI output, when the CLI answered. */
  readonly cliDetail?: string
  /** Agent info (`name`/`title`/`version`) the agent reported at initialize. */
  readonly agentInfo?: {
    readonly name: string
    readonly title?: string
    readonly version: string
  }
}

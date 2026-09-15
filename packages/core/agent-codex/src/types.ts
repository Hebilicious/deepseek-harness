/**
 * Client-safe Codex account payloads shared by the Remote surface and its
 * generated client. Shapes are flattened forms of the app-server's
 * `account/*` vocabulary; Codex-owned enums cross as strings.
 *
 * @module @deepseek-ai/dsh-agent-codex/types
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/dsh-typert-protocol/types' {
  interface RemoteErrorDetailsMap {
    /** A Codex account or rate-limit request failed at the app-server. */
    'codex/account-failed': {}
    /** A Codex login start/cancel/logout request failed at the app-server. */
    'codex/login-failed': {}
  }
}

/** Normalized `account/read` answer, connection-global. */
export interface CodexAccountSnapshot {
  /** Whether the app-server reported a signed-in account. */
  readonly authenticated: boolean
  /** Whether this Codex home requires an OpenAI sign-in at all. */
  readonly requiresOpenaiAuth: boolean
  /** Account discriminator (`chatgpt`, `apiKey`, `amazonBedrock`), when signed in. */
  readonly accountType?: string
  /** ChatGPT account email, when reported. */
  readonly email?: string
  /** ChatGPT plan label, when reported. */
  readonly planType?: string
}

/** The result of starting a device-code login, for the settings panel to render. */
export interface CodexDeviceCodeLogin {
  /** Login attempt identity; `cancelLogin` takes it back. */
  readonly loginId: string
  /** URL the user opens to authorize. */
  readonly verificationUrl: string
  /** One-time code the user enters after signing in. */
  readonly userCode: string
}

/** The result of starting a browser OAuth login, for the settings panel to open. */
export interface CodexBrowserLogin {
  /** Login attempt identity; `cancelLogin` takes it back. */
  readonly loginId: string
  /** URL the client opens in a browser to start the OAuth flow. */
  readonly authUrl: string
}

/** One connection-global account notification forwarded to subscribers. */
export interface CodexAccountNotification {
  /** The app-server notification method (`account/login/completed`, `account/updated`, `account/rateLimits/updated`). */
  readonly method: string
  /** The decoded notification payload, opaque to DSH. */
  readonly params: JsonValue
}

/** Normalized `account/rateLimits/read` answer for the settings panel. */
export interface CodexRateLimits {
  /** The app-server's primary rate-limit snapshot, opaque to DSH. */
  readonly rateLimits: JsonValue
  /** Per-meter snapshots keyed by limit id, when the backend reports them. */
  readonly rateLimitsByLimitId: Record<string, JsonValue> | null
}

/**
 * Codex session driver plugin: one shared `codex app-server --stdio` process
 * per profile, one `ctx.agents` factory binding every session to its own
 * Codex thread, the `codex` catalog route for the model picker, and the
 * connection-global account Remote the settings panel drives.
 *
 * @module @deepseek-ai/dsh-agent-codex
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import {
  Remote,
  RemoteError,
  TypertRemoteService,
  type RemoteErrorCode,
} from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { CODEX_PROVIDER, type CodexAgentConfig } from './agent.ts'
import { CodexCatalogAdapter } from './catalog.ts'
import { CodexAgentHost } from './host.ts'
import {
  CodexAppServerRuntime,
  CODEX_PREFIX,
  defaultCodexHome,
  type CodexRuntimeOptions,
} from './runtime.ts'
import type {
  CodexAccountNotification,
  CodexAccountSnapshot,
  CodexBrowserLogin,
  CodexDeviceCodeLogin,
  CodexRateLimits,
} from './types.ts'

export { CodexAgent, CODEX_PROVIDER, type CodexAgentConfig } from './agent.ts'
export { CodexCatalogAdapter } from './catalog.ts'
export { CodexAppServerConnection } from './connection.ts'
export { CodexAgentHost } from './host.ts'
export {
  codexObject,
  CodexRequestRefused,
  codexString,
  codexThreadIdOf,
  codexTurnFailureInfo,
  CODEX_TERMINAL_TURN_STATUSES,
  THREAD_PERMISSION_PARAMS,
  CODEX_PERMISSION_MODES,
  DEFAULT_CODEX_PERMISSION_MODE,
  type CodexPermissionMode,
  type CodexTurnFailureInfo,
  type CodexWireFailureFacts,
  type JsonObject,
} from './protocol.ts'
export {
  CodexAppServerRuntime,
  CODEX_PREFIX,
  defaultCodexHome,
  type CodexRuntimeOptions,
  type CodexThreadPeer,
} from './runtime.ts'
export { codexThreadOf, codexThreadProjection, type CodexThreadState } from './thread-state.ts'
export type {
  CodexAccountNotification,
  CodexAccountSnapshot,
  CodexBrowserLogin,
  CodexDeviceCodeLogin,
  CodexRateLimits,
} from './types.ts'

/** Plugin config; every field optional — `static Config` supplies defaults. */
export interface Config {
  /** Codex executable name or absolute path (default `codex`). */
  executable?: string
  /** Arguments after the executable (default `['app-server']`). */
  args?: string[]
  /** `CODEX_HOME` handed to the child; owns auth, config.toml, MCP, hooks (default `~/.codex`). */
  codexHome?: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  env?: Record<string, string>
  /** Filesystem sandbox for sessions that log no `sandbox/mode` override (default `workspace-write`). */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** `networkAccess` inside the structured `sandboxPolicy` overrides (default `false`). */
  networkAccess?: boolean
  /** Approval routing for sessions that log no `approval/policy` override (default `ask`). */
  approval?: 'ask' | 'never'
  /** Deployment default model beneath the session's `model/selection`. */
  model?: string
  /** Deployment default reasoning effort beneath the session's selection. */
  reasoningEffort?: string
  /** Credential reference (env-var name) resolved for unattended `account/login/start {type:'apiKey'}`. */
  credentialRef?: string
  /** Grace in milliseconds between managed-range termination tiers (default 5000). */
  disposeGraceMs?: number
  /** Tier-1 window in milliseconds after stdin EOF before escalation (default 2000). */
  eofGraceMs?: number
}

const DEFAULT_DISPOSE_GRACE_MS = 5000
const DEFAULT_EOF_GRACE_MS = 2000

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Codex session driver: agent factory host plus connection-global account Remote. */
    codexAppServer: CodexAppServer
  }
}

/**
 * The `codexAppServer` service (`codex` Remote namespace). Owns the shared
 * app-server process and connection, the agent-factory host, the `codex`
 * catalog adapter, and every account/login/rate-limit operation — none of
 * which belong to a session.
 */
export class CodexAppServer extends TypertRemoteService {
  static inject = [
    'agents',
    'sessions',
    'sessionProjections',
    'subprocess',
    'llm',
    'typert',
  ]

  /** Inline schema call: the config catalog walks `static Config` statically. */
  static Config: z<Config> = z.object({
    executable: z.string().min(1).default('codex'),
    args: z.array(z.string()).default(['app-server']),
    codexHome: z.string().min(1),
    env: z.dict(z.string()).default({}),
    sandbox: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const)
      .default('workspace-write'),
    networkAccess: z.boolean().default(false),
    approval: z.union(['ask', 'never'] as const).default('ask'),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1),
    credentialRef: z.string().min(1),
    disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
    eofGraceMs: z.number().default(DEFAULT_EOF_GRACE_MS),
  })

  private readonly runtime: CodexAppServerRuntime
  private apiKeyLoginAttempted = false

  /**
   * @param ctx - the plugin fiber context.
   * @param config - resolved plugin config.
   */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'codexAppServer', { namespace: 'codex' })
    const runtimeOptions: CodexRuntimeOptions = {
      command: config.executable ?? 'codex',
      args: config.args ?? ['app-server'],
      codexHome: config.codexHome ?? defaultCodexHome(),
      env: config.env ?? {},
      disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
      eofGraceMs: config.eofGraceMs ?? DEFAULT_EOF_GRACE_MS,
    }
    this.runtime = new CodexAppServerRuntime(ctx, runtimeOptions)
    const agentConfig: CodexAgentConfig = {
      sandbox: config.sandbox ?? 'workspace-write',
      approval: config.approval ?? 'ask',
      networkAccess: config.networkAccess ?? false,
      ...config.model === undefined ? {} : { model: config.model },
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
      ...config.credentialRef === undefined
        ? {}
        : { loginWithApiKey: () => this.loginWithConfiguredKey() },
    }
    // The host constructor owns its registrations: the codexThread
    // projection, shared transaction ownership, and `agents.setFactory`.
    new CodexAgentHost(ctx, this.runtime, agentConfig)
    ctx.effect(() => () => this.runtime.dispose(), 'codexAppServer.dispose()')
    ctx.effect(
      () => ctx.llm.registerAdapter([CODEX_PROVIDER], new CodexCatalogAdapter(this.runtime)),
      'codexAppServer.catalog()',
    )
  }

  // ---- connection-global account Remote surface ----

  /**
   * Read the Codex account state.
   * @param signal - caller lifetime.
   * @returns normalized account facts.
   */
  @Remote
  async status(signal: AbortSignal): Promise<CodexAccountSnapshot> {
    try {
      return await this.runtime.readAccount(signal)
    } catch (error: unknown) {
      throw asRemoteError('codex/account-failed', error)
    }
  }

  /**
   * Start a device-code login; the panel shows the URL and code.
   * @param signal - caller lifetime.
   * @returns the attempt id, verification URL, and one-time code.
   */
  @Remote('loginDeviceCode')
  async beginDeviceCode(signal: AbortSignal): Promise<CodexDeviceCodeLogin> {
    try {
      return await this.runtime.beginDeviceCodeLogin(signal)
    } catch (error: unknown) {
      throw asRemoteError('codex/login-failed', error)
    }
  }

  /**
   * Start a browser OAuth login; usable only where a browser can reach the
   * app-server's localhost callback.
   * @param signal - caller lifetime.
   * @returns the attempt id and authorization URL.
   */
  @Remote('loginBrowser')
  async beginBrowser(signal: AbortSignal): Promise<CodexBrowserLogin> {
    try {
      return await this.runtime.beginBrowserLogin(signal)
    } catch (error: unknown) {
      throw asRemoteError('codex/login-failed', error)
    }
  }

  /**
   * Cancel one in-flight login attempt.
   * @param request - `{loginId}` from a login start.
   * @param signal - caller lifetime.
   */
  @Remote('cancelLogin')
  async cancelLogin(request: { loginId?: string }, signal: AbortSignal): Promise<void> {
    if (typeof request.loginId !== 'string' || request.loginId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'cancelLogin requires a loginId', {})
    }
    try {
      await this.runtime.cancelLogin(request.loginId, signal)
    } catch (error: unknown) {
      throw asRemoteError('codex/login-failed', error)
    }
  }

  /**
   * Sign the Codex account out.
   * @param signal - caller lifetime.
   */
  @Remote
  async logout(signal: AbortSignal): Promise<void> {
    try {
      await this.runtime.logout(signal)
    } catch (error: unknown) {
      throw asRemoteError('codex/login-failed', error)
    }
  }

  /**
   * Read account quota.
   * @param signal - caller lifetime.
   * @returns the normalized rate-limit payload.
   */
  @Remote
  async rateLimits(signal: AbortSignal): Promise<CodexRateLimits> {
    try {
      return await this.runtime.readRateLimits(signal)
    } catch (error: unknown) {
      throw asRemoteError('codex/account-failed', error)
    }
  }

  /**
   * Stream connection-global account notifications
   * (`account/login/completed`, `account/updated`, `account/rateLimits/updated`).
   * @param signal - caller lifetime; aborting ends the stream.
   * @returns account notifications as they arrive.
   */
  @Remote({ mode: 'stream' })
  async *events(signal: AbortSignal): AsyncIterable<CodexAccountNotification> {
    const queue: CodexAccountNotification[] = []
    let wake: (() => void) | undefined
    const detach = this.runtime.onAccountNotification((method, params) => {
      queue.push({ method, params: params as JsonValue })
      wake?.()
    })
    const onAbort = (): void => wake?.()
    signal.addEventListener('abort', onAbort)
    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as CodexAccountNotification
        if (signal.aborted) return
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      wake = undefined
      signal.removeEventListener('abort', onAbort)
      detach()
    }
  }

  /**
   * Resolve the configured credential and run `account/login/start
   * {type:'apiKey'}` — at most once per process lifetime, and only while the
   * agent-side bind still reports signed out.
   */
  private async loginWithConfiguredKey(): Promise<void> {
    if (this.apiKeyLoginAttempted) return
    this.apiKeyLoginAttempted = true
    const refName = this.config.credentialRef
    if (refName === undefined) return
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new Error(`${CODEX_PREFIX}: apiKey login needs a credential provider (mount dsh-credentials)`)
    }
    const resolved = await credentials.resolve(credentialRef(refName))
    if (resolved === undefined) {
      throw new Error(`${CODEX_PREFIX}: credential "${refName}" is not configured`)
    }
    await this.runtime.loginWithApiKey(resolved.value)
  }
}

/** Wrap a runtime failure as a Remote error under one Codex code. */
function asRemoteError(code: RemoteErrorCode, error: unknown): RemoteError {
  const message = error instanceof Error ? error.message : String(error)
  return new RemoteError(code, message, {})
}

export default CodexAppServer

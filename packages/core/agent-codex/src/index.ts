/**
 * Codex session driver plugin: one `codex app-server --stdio` process per
 * configured instance, one `ctx.agents` factory and one `ctx.llm` catalog
 * route per instance, and the harness-scoped account Remote the settings
 * panel drives. Every instance is effect-scoped, so unloading the plugin
 * disposes each app-server process.
 *
 * @module @deepseek-ai/dsh-agent-codex
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessId } from '@deepseek-ai/dsh-agent'
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
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-credentials'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CodexAgentConfig } from './agent.ts'
import { CodexCatalogAdapter } from './catalog.ts'
import {
  codexHarnessEntrySchema,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_EOF_GRACE_MS,
  resolveHarnessEntries,
  type Config,
  type ResolvedCodexHarnessEntry,
} from './config.ts'
import { CodexAgentHost } from './host.ts'
import {
  CodexAppServerRuntime,
  CODEX_PREFIX,
  type CodexRuntimeOptions,
} from './runtime.ts'
import type {
  CodexAccountNotification,
  CodexAccountSnapshot,
  CodexBrowserLogin,
  CodexDeviceCodeLogin,
  CodexRateLimits,
} from './types.ts'

export { CodexAgent, type CodexAgentConfig } from './agent.ts'
export { CodexCatalogAdapter } from './catalog.ts'
export {
  codexHarnessEntrySchema,
  resolveHarnessEntries,
  type CodexHarnessEntry,
  type Config,
  type ResolvedCodexHarnessEntry,
} from './config.ts'
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Codex session driver: per-instance agent factories plus the harness-scoped account Remote. */
    codexAppServer: CodexAppServer
  }
}

/** One mounted Codex instance: its resolved entry, its own runtime, and its own unattended-login latch. */
interface MountedCodexHarness {
  /** Resolved config entry with every deployment default applied. */
  readonly entry: ResolvedCodexHarnessEntry
  /** The app-server runtime owning this instance's process and connection. */
  readonly runtime: CodexAppServerRuntime
  /** Set once this instance attempted its configured api-key login. */
  apiKeyLoginAttempted: boolean
}

/**
 * The `codexAppServer` service (`codex` Remote namespace). Owns one app-server
 * runtime, one agent-factory host, and one catalog adapter per configured
 * instance, plus every account/login/rate-limit operation — none of which
 * belong to a session.
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
    harnesses: z.array(codexHarnessEntrySchema).required(),
    disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
    eofGraceMs: z.number().default(DEFAULT_EOF_GRACE_MS),
  })

  /** Mounted instances by id, in config order. */
  private readonly mounted = new Map<string, MountedCodexHarness>()

  /**
   * @param ctx - the plugin fiber context.
   * @param config - resolved plugin config; every entry is validated here, once.
   */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'codexAppServer', { namespace: 'codex' })
    for (const entry of resolveHarnessEntries(config)) {
      const runtime = new CodexAppServerRuntime(ctx, runtimeOptionsFor(entry, config))
      const mounted: MountedCodexHarness = { entry, runtime, apiKeyLoginAttempted: false }
      this.mounted.set(entry.id, mounted)
      // The host constructor owns its registrations: the codexThread
      // projection, shared transaction ownership, and this instance in
      // `ctx.agents`, all effect-scoped so unloading disposes only them.
      new CodexAgentHost(ctx, runtime, this.agentConfigFor(mounted))
      ctx.effect(() => () => runtime.dispose(), `codexAppServer(${entry.id}).dispose()`)
      ctx.effect(
        () => ctx.llm.registerAdapter([entry.id], new CodexCatalogAdapter(entry.id, entry.name, runtime)),
        `codexAppServer(${entry.id}).catalog()`,
      )
    }
  }

  // ---- harness-scoped account Remote surface ----

  /**
   * Read one instance's Codex account state.
   * @param request - `{harness}` naming a mounted instance.
   * @param signal - caller lifetime.
   * @returns normalized account facts.
   */
  @Remote
  async status(request: { harness: string }, signal: AbortSignal): Promise<CodexAccountSnapshot> {
    return await this.withRuntime(request.harness, 'codex/account-failed', runtime => runtime.readAccount(signal))
  }

  /**
   * Start a device-code login; the panel shows the URL and code.
   * @param request - `{harness}` naming a mounted instance.
   * @param signal - caller lifetime.
   * @returns the attempt id, verification URL, and one-time code.
   */
  @Remote('loginDeviceCode')
  async beginDeviceCode(request: { harness: string }, signal: AbortSignal): Promise<CodexDeviceCodeLogin> {
    return await this.withRuntime(
      request.harness,
      'codex/login-failed',
      runtime => runtime.beginDeviceCodeLogin(signal),
    )
  }

  /**
   * Start a browser OAuth login; usable only where a browser can reach the
   * app-server's localhost callback.
   * @param request - `{harness}` naming a mounted instance.
   * @param signal - caller lifetime.
   * @returns the attempt id and authorization URL.
   */
  @Remote('loginBrowser')
  async beginBrowser(request: { harness: string }, signal: AbortSignal): Promise<CodexBrowserLogin> {
    return await this.withRuntime(
      request.harness,
      'codex/login-failed',
      runtime => runtime.beginBrowserLogin(signal),
    )
  }

  /**
   * Cancel one in-flight login attempt.
   * @param request - `{harness, loginId}`; the id comes from a login start.
   * @param signal - caller lifetime.
   */
  @Remote('cancelLogin')
  async cancelLogin(request: { harness: string; loginId?: string }, signal: AbortSignal): Promise<void> {
    const loginId = request.loginId
    if (typeof loginId !== 'string' || loginId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'cancelLogin requires a loginId', {})
    }
    await this.withRuntime(request.harness, 'codex/login-failed', runtime => runtime.cancelLogin(loginId, signal))
  }

  /**
   * Sign one instance's Codex account out.
   * @param request - `{harness}` naming a mounted instance.
   * @param signal - caller lifetime.
   */
  @Remote
  async logout(request: { harness: string }, signal: AbortSignal): Promise<void> {
    await this.withRuntime(request.harness, 'codex/login-failed', runtime => runtime.logout(signal))
  }

  /**
   * Read one instance's account quota.
   * @param request - `{harness}` naming a mounted instance.
   * @param signal - caller lifetime.
   * @returns the normalized rate-limit payload.
   */
  @Remote
  async rateLimits(request: { harness: string }, signal: AbortSignal): Promise<CodexRateLimits> {
    return await this.withRuntime(request.harness, 'codex/account-failed', runtime => runtime.readRateLimits(signal))
  }

  /**
   * Stream one instance's account notifications
   * (`account/login/completed`, `account/updated`, `account/rateLimits/updated`).
   * @param request - `{harness}` naming a mounted instance.
   * @param signal - caller lifetime; aborting ends the stream.
   * @returns account notifications as they arrive.
   */
  @Remote({ mode: 'stream' })
  async *events(request: { harness: string }, signal: AbortSignal): AsyncIterable<CodexAccountNotification> {
    const { runtime } = this.require(request.harness)
    const queue: CodexAccountNotification[] = []
    let wake: (() => void) | undefined
    const detach = runtime.onAccountNotification((method, params) => {
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
   * Run one account operation on a mounted instance, reporting a runtime
   * failure under the operation's Remote code.
   * @param harness - instance id from the caller.
   * @param code - Remote error code a runtime failure is reported under.
   * @param operation - the runtime call to run on the resolved instance.
   * @returns whatever the operation resolves.
   */
  private async withRuntime<T>(
    harness: string,
    code: RemoteErrorCode,
    operation: (runtime: CodexAppServerRuntime) => Promise<T>,
  ): Promise<T> {
    const { runtime } = this.require(harness)
    try {
      return await operation(runtime)
    } catch (error: unknown) {
      throw asRemoteError(code, error)
    }
  }

  /**
   * Resolve one mounted instance by id.
   * @param harness - instance id from the caller.
   * @returns the mounted instance.
   */
  private require(harness: string): MountedCodexHarness {
    const mounted = this.mounted.get(harness)
    if (mounted === undefined) {
      throw new RemoteError(
        'gateway/bad-request',
        `unknown Codex harness ${JSON.stringify(harness)} (mounted: ${[...this.mounted.keys()].join(', ')})`,
        {},
      )
    }
    return mounted
  }

  /** Bind one entry's identity and deployment defaults to the agents it constructs. */
  private agentConfigFor(mounted: MountedCodexHarness): CodexAgentConfig {
    const { entry } = mounted
    const credentialName = entry.credentialRef
    return {
      harness: {
        id: HarnessId(entry.id),
        name: entry.name,
        ...entry.description === undefined ? {} : { description: entry.description },
        // The catalog adapter this plugin registers under the same id.
        modelProvider: entry.id,
      },
      sandbox: entry.sandbox,
      approval: entry.approval,
      networkAccess: entry.networkAccess,
      ...entry.model === undefined ? {} : { model: entry.model },
      ...entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort },
      ...credentialName === undefined
        ? {}
        : { loginWithApiKey: () => this.loginWithConfiguredKey(mounted, credentialName) },
    }
  }

  /**
   * Resolve one instance's configured credential and run `account/login/start
   * {type:'apiKey'}` — at most once per instance, and only while the
   * agent-side bind still reports signed out.
   * @param mounted - the instance whose runtime receives the login.
   * @param refName - the configured credential reference (env-var name).
   */
  private async loginWithConfiguredKey(mounted: MountedCodexHarness, refName: string): Promise<void> {
    if (mounted.apiKeyLoginAttempted) return
    mounted.apiKeyLoginAttempted = true
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new Error(`${CODEX_PREFIX}: apiKey login needs a credential provider (mount dsh-credentials)`)
    }
    // Loaded here rather than at module scope: the credential seam is an
    // optional peer, and only this login path needs its brand helper.
    const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
    const resolved = await credentials.resolve(credentialRef(refName))
    if (resolved === undefined) {
      throw new Error(`${CODEX_PREFIX}: credential "${refName}" is not configured`)
    }
    await mounted.runtime.loginWithApiKey(resolved.value)
  }
}

/** Resolve one entry's process options, applying the plugin-wide termination graces. */
function runtimeOptionsFor(entry: ResolvedCodexHarnessEntry, config: Config): CodexRuntimeOptions {
  return {
    command: entry.executable,
    args: entry.args,
    codexHome: entry.codexHome,
    env: entry.env,
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    eofGraceMs: config.eofGraceMs ?? DEFAULT_EOF_GRACE_MS,
  }
}

/** Wrap a runtime failure as a Remote error under one Codex code. */
function asRemoteError(code: RemoteErrorCode, error: unknown): RemoteError {
  // Every rejection a Remote method sees is an Error: the runtime normalizes
  // non-Error reasons at its process and transport boundaries.
  /* v8 ignore next -- see above */
  const message = error instanceof Error ? error.message : String(error)
  return new RemoteError(code, message, {})
}

export default CodexAppServer

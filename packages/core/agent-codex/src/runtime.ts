/**
 * Profile-owned Codex app-server runtime: one managed `codex app-server
 * --stdio` process per mounted plugin, one JSON-RPC connection over its
 * stdio, and a router that fans thread-scoped server requests and
 * notifications out to the agent that owns each thread. Connection-global
 * methods (`account/*`, `model/list`) run directly on the connection.
 *
 * @module @deepseek-ai/dsh-agent-codex/runtime
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ExternalHarnessProcess } from '@deepseek-ai/dsh-agent-external'
import type {
  CodexAccountSnapshot,
  CodexBrowserLogin,
  CodexDeviceCodeLogin,
  CodexRateLimits,
} from './types.ts'
import { CodexAppServerConnection } from './connection.ts'
import {
  codexObject,
  CodexRequestRefused,
  codexString,
  codexThreadIdOf,
  type JsonObject,
} from './protocol.ts'

/** Diagnostic prefix for every error this package raises. */
export const CODEX_PREFIX = 'agent-codex'

export { CodexRequestRefused }

/** Per-agent handler the router addresses by `threadId`. */
export interface CodexThreadPeer {
  /**
   * Consume one notification addressed to this peer's thread.
   * @param method - the wire method name.
   * @param params - the decoded params object.
   */
  notification(method: string, params: JsonObject): void
  /**
   * Answer one server→client request addressed to this peer's thread.
   * @param method - the wire method name.
   * @param params - the decoded params object.
   * @returns the response `result` payload.
   */
  request(method: string, params: JsonObject): Promise<unknown>
}

/** Fully resolved runtime settings owned by the plugin Config. */
export interface CodexRuntimeOptions {
  /** Executable name or absolute path; resolved through the subprocess seam. */
  readonly command: string
  /** Arguments after the executable; the app-server stdio invocation. */
  readonly args: readonly string[]
  /** Explicit `CODEX_HOME` handed to the child; owns auth, config, MCP, hooks. */
  readonly codexHome: string
  /** Explicit environment entries layered over the scrubbed parent base. */
  readonly env: Readonly<Record<string, string>>
  /** Provider termination-escalation grace (ms). */
  readonly disposeGraceMs: number
  /** Tier-1 window after stdin EOF before termination escalation (ms). */
  readonly eofGraceMs: number
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * One app-server process and connection per mounted profile. Sessions bind
 * threads over the shared connection; the account and model-catalog surfaces
 * use the same connection outside any session. Construction is cheap —
 * {@link connect} spawns lazily and memoizes startup so concurrent session
 * binds share one handshake.
 */
export class CodexAppServerRuntime {
  private process: ExternalHarnessProcess | undefined
  private connection: CodexAppServerConnection | undefined
  private startup: Promise<CodexAppServerConnection> | undefined
  private processExit: Error | undefined
  private readonly threads = new Map<string, CodexThreadPeer>()
  private readonly accountListeners = new Set<(method: string, params: JsonObject) => void>()
  private disposing: Promise<void> | undefined

  /**
   * @param ctx - the plugin service's context: subprocess seam and logger.
   * @param options - fully resolved runtime settings.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: CodexRuntimeOptions,
  ) {}

  /** Whether the shared process is currently usable for new work. */
  get available(): boolean {
    return this.connection !== undefined && this.processExit === undefined && this.disposing === undefined
  }

  /**
   * Lazily spawn the app-server and complete the protocol handshake. Shared
   * and memoized: concurrent callers join the same startup; a failed startup
   * is not retried implicitly — the rejection is cached so a broken
   * deployment fails loudly instead of respawning in a loop.
   * @param signal - caller cancellation for the startup await.
   * @returns the live connection.
   */
  connect(signal?: AbortSignal): Promise<CodexAppServerConnection> {
    if (this.startup !== undefined) return this.startup
    const started = this.spawnAndInitialize()
    this.startup = started
    // A rejected startup must not poison later callers through an unhandled
    // rejection, but the failure stays cached so every caller sees it.
    started.catch(() => {})
    if (signal !== undefined) {
      return Promise.race([
        started,
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
            return
          }
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
          }, { once: true })
        }),
      ])
    }
    return started
  }

  /**
   * Route one thread-scoped or connection-global request from the server.
   * Thread requests resolve to the owning agent's peer; connection-global
   * methods are rejected here — the runtime answers them through its own
   * typed methods instead.
   */
  private async dispatchRequest(method: string, params: JsonObject): Promise<unknown> {
    const threadId = codexThreadIdOf(params)
    if (threadId !== undefined) {
      const peer = this.threads.get(threadId)
      if (peer === undefined) {
        throw new CodexRequestRefused(
          `${CODEX_PREFIX}: app-server addressed a request to unregistered thread "${threadId}"`,
        )
      }
      return peer.request(method, params)
    }
    // A request without a thread id has no owning session. The account
    // surface is client-initiated only, so nothing legitimate reaches here.
    throw new CodexRequestRefused(`${CODEX_PREFIX}: unsupported app-server request ${JSON.stringify(method)}`)
  }

  /**
   * Route one notification to its thread peer, or to account listeners when
   * it carries no thread id. Unknown threads are dropped: notifications
   * already in flight when a thread unsubscribes land here legitimately.
   */
  private dispatchNotification(method: string, params: JsonObject): void {
    const threadId = codexThreadIdOf(params)
    if (threadId === undefined) {
      for (const listener of this.accountListeners) listener(method, params)
      return
    }
    const peer = this.threads.get(threadId)
    if (peer === undefined) {
      this.ctx.logger.debug?.(`${CODEX_PREFIX}: dropped ${method} for unregistered thread "${threadId}"`)
      return
    }
    peer.notification(method, params)
  }

  /** Subscribe to connection-global notifications (account/login/*). */
  onAccountNotification(listener: (method: string, params: JsonObject) => void): () => void {
    this.accountListeners.add(listener)
    return () => { this.accountListeners.delete(listener) }
  }

  /**
   * Associate one agent's peer with a Codex thread id for request and
   * notification routing. Returns the disposer.
   * @param threadId - the bound thread.
   * @param peer - the agent's dispatch surface.
   */
  registerThread(threadId: string, peer: CodexThreadPeer): () => void {
    if (this.threads.has(threadId)) {
      throw new Error(`${CODEX_PREFIX}: thread "${threadId}" already has a registered peer`)
    }
    this.threads.set(threadId, peer)
    return () => {
      if (this.threads.get(threadId) === peer) this.threads.delete(threadId)
    }
  }

  /**
   * Read the account state through the shared connection.
   * @param signal - caller cancellation.
   * @returns normalized account facts.
   */
  async readAccount(signal?: AbortSignal): Promise<CodexAccountSnapshot> {
    const connection = await this.connect(signal)
    const response = codexObject(
      await connection.request('account/read', {}, signal),
      'account/read response',
      CODEX_PREFIX,
    )
    return normalizeAccount(response)
  }

  /**
   * Run one `account/login/start {type:'apiKey'}` exchange. The key value
   * never enters logs or the session transcript.
   * @param apiKey - resolved credential value.
   * @param signal - caller cancellation.
   */
  async loginWithApiKey(apiKey: string, signal?: AbortSignal): Promise<void> {
    const connection = await this.connect(signal)
    await connection.request('account/login/start', { type: 'apiKey', apiKey }, signal)
  }

  /**
   * Start a device-code login (`account/login/start {type:'chatgptDeviceCode'}`).
   * @param signal - caller cancellation.
   * @returns the attempt id plus the URL and code the settings panel shows.
   */
  async beginDeviceCodeLogin(signal?: AbortSignal): Promise<CodexDeviceCodeLogin> {
    const connection = await this.connect(signal)
    const response = codexObject(
      await connection.request('account/login/start', { type: 'chatgptDeviceCode' }, signal),
      'account/login/start response',
      CODEX_PREFIX,
    )
    return {
      loginId: codexString(response.loginId, 'device-code login id', CODEX_PREFIX),
      verificationUrl: codexString(response.verificationUrl, 'device-code verificationUrl', CODEX_PREFIX),
      userCode: codexString(response.userCode, 'device-code userCode', CODEX_PREFIX),
    }
  }

  /**
   * Start a browser OAuth login (`account/login/start {type:'chatgpt'}`). The
   * browser must be able to reach the app-server's localhost callback.
   * @param signal - caller cancellation.
   * @returns the attempt id plus the authorization URL.
   */
  async beginBrowserLogin(signal?: AbortSignal): Promise<CodexBrowserLogin> {
    const connection = await this.connect(signal)
    const response = codexObject(
      await connection.request('account/login/start', { type: 'chatgpt' }, signal),
      'account/login/start response',
      CODEX_PREFIX,
    )
    return {
      loginId: codexString(response.loginId, 'browser login id', CODEX_PREFIX),
      authUrl: codexString(response.authUrl, 'browser authUrl', CODEX_PREFIX),
    }
  }

  /**
   * Cancel one in-flight login attempt (`account/login/cancel`).
   * @param loginId - the attempt id a login start returned.
   * @param signal - caller cancellation.
   */
  async cancelLogin(loginId: string, signal?: AbortSignal): Promise<void> {
    const connection = await this.connect(signal)
    await connection.request('account/login/cancel', { loginId }, signal)
  }

  /**
   * Sign the Codex account out (`account/logout`).
   * @param signal - caller cancellation.
   */
  async logout(signal?: AbortSignal): Promise<void> {
    const connection = await this.connect(signal)
    await connection.request('account/logout', {}, signal)
  }

  /**
   * Read account quota (`account/rateLimits/read`).
   * @param signal - caller cancellation.
   * @returns the normalized rate-limit payload for the settings panel.
   */
  async readRateLimits(signal?: AbortSignal): Promise<CodexRateLimits> {
    const connection = await this.connect(signal)
    const response = codexObject(
      await connection.request('account/rateLimits/read', {}, signal),
      'account/rateLimits/read response',
      CODEX_PREFIX,
    )
    const byLimit = response.rateLimitsByLimitId !== null && typeof response.rateLimitsByLimitId === 'object'
      ? response.rateLimitsByLimitId as Record<string, JsonValue>
      : null
    return {
      rateLimits: response.rateLimits as JsonValue,
      rateLimitsByLimitId: byLimit,
    }
  }

  /**
   * Enumerate the Codex model catalog over the shared connection, walking
   * `model/list` pages to exhaustion.
   * @param signal - caller cancellation.
   * @returns the decoded model entries in server order.
   */
  async listCodexModels(signal?: AbortSignal): Promise<JsonObject[]> {
    const connection = await this.connect(signal)
    const models: JsonObject[] = []
    let cursor: string | undefined
    for (;;) {
      const response = codexObject(
        await connection.request('model/list', {
          ...cursor === undefined ? {} : { cursor },
          includeHidden: false,
        }, signal),
        'model/list response',
        CODEX_PREFIX,
      )
      const data = response.data
      if (!Array.isArray(data)) {
        throw new Error(`${CODEX_PREFIX}: app-server returned invalid model/list data`)
      }
      for (const entry of data) models.push(codexObject(entry, 'model/list entry', CODEX_PREFIX))
      const next = response.nextCursor
      if (next === null || next === undefined) return models
      if (typeof next !== 'string' || next.length === 0) {
        throw new Error(`${CODEX_PREFIX}: app-server returned invalid model/list cursor`)
      }
      cursor = next
    }
  }

  /**
   * Close the connection, then walk the managed-range teardown ladder.
   * Idempotent and memoized: every caller joins the same quiescence proof.
   */
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.connection?.close()
      if (this.process !== undefined) {
        await this.process.dispose(this.options.eofGraceMs)
      }
      const startup = this.startup
      if (startup !== undefined) await startup.catch(() => {})
    })()
  }

  private async spawnAndInitialize(): Promise<CodexAppServerConnection> {
    if (this.processExit !== undefined) throw this.processExit
    if (this.disposing !== undefined) throw new Error(`${CODEX_PREFIX}: runtime is disposed`)
    const env: Record<string, string> = {
      ...scrubbedParentEnv(),
      CODEX_HOME: this.options.codexHome,
      ...this.options.env,
    }
    const process = await ExternalHarnessProcess.spawn(this.ctx.subprocess, {
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.codexHome,
      env,
      graceMs: this.options.disposeGraceMs,
    })
    process.done.then(
      (outcome) => {
        this.processExit = new Error(
          `${CODEX_PREFIX}: app-server exited (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}): ${process.stderrTail()}`,
        )
        this.connection?.close()
      },
      (error: unknown) => {
        this.processExit = toError(error)
        this.connection?.close()
      },
    )
    const connection = new CodexAppServerConnection(
      process.stdout,
      process.stdin,
      {
        request: (method, params) => this.dispatchRequest(method, params),
        notification: (method, params) => this.dispatchNotification(method, params),
      },
      CODEX_PREFIX,
    )
    try {
      connection.start()
      await connection.initialize(new AbortController().signal)
    } catch (error: unknown) {
      connection.close()
      await process.dispose(this.options.eofGraceMs).catch(() => {})
      throw error
    }
    this.process = process
    this.connection = connection
    return connection
  }
}

function normalizeAccount(response: JsonObject): CodexAccountSnapshot {
  const requiresOpenaiAuth = response.requiresOpenaiAuth === true
  const account = response.account
  if (account === null || account === undefined) {
    return { authenticated: false, requiresOpenaiAuth }
  }
  const record = codexObject(account, 'account/read account', CODEX_PREFIX)
  const type = codexString(record.type, 'account/read account type', CODEX_PREFIX)
  const email = typeof record.email === 'string' ? record.email : undefined
  const planType = typeof record.planType === 'string' ? record.planType : undefined
  return {
    authenticated: true,
    requiresOpenaiAuth,
    accountType: type,
    ...email === undefined ? {} : { email },
    ...planType === undefined ? {} : { planType },
  }
}

/** Default `CODEX_HOME` when the deployment does not set one: `~/.codex`. */
export function defaultCodexHome(): string {
  return join(homedir(), '.codex')
}

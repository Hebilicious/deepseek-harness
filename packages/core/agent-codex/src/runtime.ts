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
   * Report a failure the peer raised while consuming its own notification.
   * The runtime scopes the failure here instead of failing the shared
   * connection, so one session's failure cannot take down every other thread.
   * @param error - the failure the peer's notification dispatch raised.
   */
  failed(error: Error): void
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
 * One spawned app-server child with the wire that speaks to it. The pair is
 * published before the initialize handshake completes, so teardown can reach a
 * child that is still starting; {@link retired} memoizes its quiescence proof.
 */
interface LiveAppServer {
  readonly process: ExternalHarnessProcess
  readonly connection: CodexAppServerConnection
  /** Settles when the retired child reached quiescence; set at first retirement. */
  retired?: Promise<void>
}

/**
 * One app-server process and connection for one configured instance. Sessions
 * bind threads over that instance's connection; its account and model-catalog
 * surfaces use the same connection outside any session. Construction is cheap
 * — {@link connect} spawns lazily and memoizes startup so concurrent session
 * binds share one handshake.
 */
export class CodexAppServerRuntime {
  private live: LiveAppServer | undefined
  private startup: Promise<CodexAppServerConnection> | undefined
  /** Quiescence proof for every retired child, awaited by {@link dispose}. */
  private retirement: Promise<void> = Promise.resolve()
  private readonly threads = new Map<string, CodexThreadPeer>()
  private readonly accountListeners = new Set<(method: string, params: JsonObject) => void>()
  private disposal: Promise<void> | undefined

  /**
   * @param ctx - the plugin service's context: subprocess seam and logger.
   * @param options - fully resolved runtime settings.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: CodexRuntimeOptions,
  ) {}

  /** Whether {@link dispose} has latched. Teardown outranks every later connect. */
  private get disposing(): boolean {
    return this.disposal !== undefined
  }

  /**
   * Lazily spawn the app-server and complete the protocol handshake. Shared
   * and memoized: concurrent callers join the same startup. A startup failure
   * clears the memo, so the next caller retries on a fresh child rather than
   * reusing a connection whose process is gone.
   * @param signal - caller cancellation for the startup await.
   * @returns the live connection.
   */
  connect(signal?: AbortSignal): Promise<CodexAppServerConnection> {
    if (this.disposing) return Promise.reject(this.disposedError())
    if (this.startup === undefined) {
      const started = this.spawnAndInitialize()
      this.startup = started
      // A rejected startup must not poison later callers through an unhandled
      // rejection, and must not stay memoized: the next connect() spawns again.
      started.catch(() => {
        if (this.startup === started) this.startup = undefined
      })
    }
    const startup = this.startup
    if (signal === undefined) return startup
    return Promise.race([
      startup,
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
   * already in flight when a thread unsubscribes land here legitimately. A
   * peer's own failure stays on that peer: the frame was already delivered,
   * and the connection is still coherent for every other thread.
   */
  private dispatchNotification(method: string, params: JsonObject): void {
    const threadId = codexThreadIdOf(params)
    if (threadId === undefined) {
      for (const listener of this.accountListeners) {
        try {
          listener(method, params)
        } catch (error: unknown) {
          // Connection-global listeners are observers of account traffic; one
          // failing subscriber must not fail the session serving it.
          this.ctx.logger.warn(`${CODEX_PREFIX}: account notification listener failed: ${toError(error).message}`)
        }
      }
      return
    }
    const peer = this.threads.get(threadId)
    if (peer === undefined) {
      this.ctx.logger.debug(`${CODEX_PREFIX}: dropped ${method} for unregistered thread "${threadId}"`)
      return
    }
    try {
      peer.notification(method, params)
    } catch (error: unknown) {
      // Notification handlers end in durable session appends, so a failure is
      // scoped to the thread that owns the frame. Only the connection's own
      // transport failures (stream error, EOF, write failure) fail the
      // connection for every session; a delivered frame that one session
      // cannot fold does not make the wire unusable for the others.
      peer.failed(toError(error))
    }
  }

  /**
   * Subscribe to connection-global notifications (account/login/*).
   * @param listener - receives every account notification name and its params.
   * @returns a disposer that detaches the listener.
   */
  onAccountNotification(listener: (method: string, params: JsonObject) => void): () => void {
    this.accountListeners.add(listener)
    return () => { this.accountListeners.delete(listener) }
  }

  /**
   * Associate one agent's peer with a Codex thread id for request and
   * notification routing.
   * @param threadId - the bound thread.
   * @param peer - the agent's dispatch surface.
   * @returns a disposer that retires the thread peer.
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
   * Idempotent and memoized: every caller joins the same quiescence proof. The
   * teardown latches before its first await, so a connect() racing it refuses
   * instead of receiving a child this call is about to reap, and a startup
   * still spawning publishes its pair into {@link live} for the retirement
   * below rather than leaking it past the return.
   */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      // Read both slots before the first await: retiring the pair clears them,
      // and the in-flight startup below must still be awaited.
      const startup = this.startup
      const live = this.live
      // Retiring the published pair first reaps a child whose initialize
      // handshake is still in flight; its startup then rejects instead of
      // hanging. A spawn that has not published yet refuses on the disposal
      // latch and retires its own pair before the startup settles.
      if (live !== undefined) await this.retire(live, this.disposedError())
      if (startup !== undefined) await startup.catch(() => {})
      await this.retirement
    })()
  }

  private disposedError(): Error {
    return new Error(`${CODEX_PREFIX}: runtime is disposed`)
  }

  private async spawnAndInitialize(): Promise<CodexAppServerConnection> {
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
    const connection = new CodexAppServerConnection(
      process.stdout,
      process.stdin,
      {
        request: (method, params) => this.dispatchRequest(method, params),
        notification: (method, params) => { this.dispatchNotification(method, params) },
      },
      CODEX_PREFIX,
    )
    const live: LiveAppServer = { process, connection }
    // Publish the pair before the handshake: a dispose that begins while
    // initialize is still in flight must be able to reap the child, and only
    // then observe the startup it interrupts.
    this.live = live
    if (this.disposing) {
      await this.retire(live, this.disposedError())
      throw this.disposedError()
    }
    process.done.then(
      (outcome) => {
        void this.retire(live, new Error(
          `${CODEX_PREFIX}: app-server exited (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}): ${process.stderrTail()}`,
        ))
      },
      (error: unknown) => {
        void this.retire(live, toError(error))
      },
    )
    // The wire can also fail while the child still runs (a stream error, or a
    // router defect): retire the pair so the next connect() spawns a fresh
    // child instead of reusing a connection nothing can use.
    void connection.fatal.catch((error: unknown) => this.retire(live, toError(error)))
    try {
      connection.start()
      await connection.initialize(new AbortController().signal)
    } catch (error: unknown) {
      await this.retire(live, toError(error))
      throw error
    }
    return connection
  }

  /**
   * Retire one live pair after its child or wire failed: fail the wire so
   * requests already racing it reject, clear the memoized pair so a later
   * connect() spawns a fresh child, then dispose the child to quiescence.
   * Memoized per pair: concurrent owners join one teardown.
   */
  private retire(live: LiveAppServer, error: Error): Promise<void> {
    if (live.retired !== undefined) return live.retired
    const disposal = this.disposeLive(live, error)
    live.retired = disposal
    this.retirement = this.retirement.then(() => disposal)
    return disposal
  }

  private async disposeLive(live: LiveAppServer, error: Error): Promise<void> {
    // retire() is memoized per pair and every publication clears its
    // predecessor, so the pair reaching here still owns the memo slots.
    /* v8 ignore next -- unreachable alternative: a newer pair cannot be published before this one is cleared here */
    if (this.live === live) {
      this.live = undefined
      this.startup = undefined
    }
    live.connection.fail(error)
    try {
      await live.process.dispose(this.options.eofGraceMs)
    } catch (failure: unknown) {
      // Quiescence is already lost for this child; the caller that owns the
      // failure (a session bind, or runtime disposal) reports the original
      // error, so teardown only records what the seam could not reap.
      this.ctx.logger.warn(`${CODEX_PREFIX}: app-server teardown failed: ${toError(failure).message}`)
    }
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

/**
 * Default `CODEX_HOME` when the deployment does not set one: `~/.codex`.
 * @returns the resolved default Codex home path.
 */
export function defaultCodexHome(): string {
  return join(homedir(), '.codex')
}

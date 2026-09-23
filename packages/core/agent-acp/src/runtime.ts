/**
 * One harness's ACP runtime: one ACP harness child process, one
 * {@link AcpClientConnection}, the model catalog the harness advertises on its
 * sessions plus the optional CLI catalog verb, and the auth CLI verbs the
 * settings panel drives. All state here is connection-global for that
 * harness, never session-local.
 *
 * @module @deepseek-ai/dsh-agent-acp/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InitializeResponse } from '@agentclientprotocol/sdk'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { ExternalHarnessProcess } from '@deepseek-ai/dsh-agent-external'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { AcpClientConnection } from './connection.ts'
import { AcpProtocolError, acpAdvertisedModels, acpPrefix, type AcpSessionAdvert } from './protocol.ts'
import type { AcpCatalogModel } from './types.ts'

/** Options the plugin resolves once per harness at construction; all fields required but the catalog verb. */
export interface AcpRuntimeOptions {
  /** Harness id this runtime belongs to, used to attribute every diagnostic. */
  readonly harness: string
  /** Harness executable name or path. */
  readonly command: string
  /** Arguments after the executable (default `['acp']`). */
  readonly args: readonly string[]
  /** Working directory for the harness process itself. */
  readonly cwd: string
  /** Explicit environment entries layered over the scrubbed parent base. */
  readonly env: Readonly<Record<string, string>>
  /** Provider termination-escalation grace (ms). */
  readonly disposeGraceMs: number
  /** Tier-1 window after stdin EOF before termination escalation (ms). */
  readonly eofGraceMs: number
  /** Model-catalog CLI arguments; omitted, the catalog comes from a session advert. */
  readonly catalogArgs?: readonly string[]
  /** Whether to open one throwaway session for the catalog when no session has bound yet (default true). */
  readonly probeCatalog: boolean
  /** Auth-status command arguments (default `['auth', 'status']`). */
  readonly authStatusArgs: readonly string[]
  /** Auth-logout command arguments (default `['auth', 'logout']`). */
  readonly authLogoutArgs: readonly string[]
  /** Deadline for one CLI verb (ms); Devin's `models list` refreshes over the network. */
  readonly cliTimeoutMs: number
  /** How long a catalog read is reused before the next read (ms; default 300000). */
  readonly catalogCacheMs: number
  /** How long a failed catalog read is remembered before the next attempt (ms; default 30000). */
  readonly catalogFailureCacheMs: number
}

/**
 * Classify one catalog rejection for the failure cache.
 *
 * A cancellation says nothing about the harness and must not empty its picker
 * for the failure window: callers of {@link AcpRuntime.catalog} share one
 * memoized connect, so a cancel that belongs to whichever caller started it (a
 * session bind aborted with its turn, say) surfaces here too. The runtime's own
 * probe deadline is its own bound expiring rather than a harness verdict, so a
 * stalled harness answers the next read instead of every poll inside a window.
 * @param deadline - the deadline signal the runtime passes to its own reads.
 * @param error - the rejection to classify.
 * @returns true when the rejection is a fact about the harness.
 * @internal
 */
export function isHarnessFailure(deadline: AbortSignal | undefined, error: unknown): boolean {
  // Read cancelled by this runtime's own deadline rather than refused by the
  // harness: remembering it would answer every poll inside the failure window
  // with a stale timeout instead of letting a recovered harness through.
  const ownDeadline = deadline !== undefined && deadline.aborted && error === deadline.reason
  const cancellations = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
  return !ownDeadline && !cancellations
}

/**
 * One harness's shared ACP runtime. `connect` memoizes one live connection;
 * teardown disposes the managed process through {@link ExternalHarnessProcess}
 * so quiescence is proven, not assumed.
 */
export class AcpRuntime {
  private process: ExternalHarnessProcess | undefined
  private connection: AcpClientConnection | undefined
  private connecting: Promise<AcpClientConnection> | undefined
  private initializeResponse: InitializeResponse | undefined
  private advert: readonly AcpCatalogModel[] = []
  private catalogRead: { at: number; models: readonly AcpCatalogModel[] } | undefined
  private catalogFailure: { at: number; error: unknown } | undefined
  private catalogPending: Promise<readonly AcpCatalogModel[]> | undefined
  /** Deadline of the probe currently in flight, so a rejection can be classified. */
  private catalogDeadline: AbortSignal | undefined
  private disposed = false

  /**
   * @param ctx - the plugin service context (logger and subprocess seam).
   * @param options - resolved runtime options for this harness.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: AcpRuntimeOptions,
  ) {}

  /** The agent's initialize response after connect; undefined until the first connect settles. */
  get initializeInfo(): InitializeResponse | undefined {
    return this.initializeResponse
  }

  /**
   * The model catalog the most recent bound session advertised. Empty until a
   * session binds, because the advert is the harness's own statement of what
   * it can run.
   */
  get advertisedModels(): readonly AcpCatalogModel[] {
    return this.advert
  }

  /**
   * Publish the catalog one bound session advertised. The newest non-empty
   * advert wins: an empty one says nothing about the harness, and replacing a
   * known catalog with it would empty the picker for a live deployment.
   * @param models - entries the session advertises, possibly none.
   */
  recordAdvert(models: readonly AcpCatalogModel[]): void {
    if (models.length > 0) this.advert = models
  }

  /**
   * Spawn and handshake this harness's process exactly once. A memoized
   * endpoint whose child exited or whose connection went fatal is retired by
   * its own observers, so this call respawns rather than handing back a dead
   * endpoint.
   * @param signal - caller cancellation for the startup window.
   * @returns the live shared connection.
   */
  async connect(signal?: AbortSignal): Promise<AcpClientConnection> {
    if (this.disposed) throw new Error(`${this.prefix}: runtime is disposed`)
    const live = this.connection
    if (live !== undefined) return live
    this.connecting ??= this.openConnection(signal)
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  /**
   * The model catalog this harness publishes to the picker. A bound session's
   * advert wins; otherwise the configured CLI verb answers; otherwise, when
   * probing is enabled, the runtime opens one throwaway session to read what
   * the harness offers, so a deployment that has not started a session of this
   * harness yet still offers real models in the picker. The probe's session is
   * closed again when the agent advertises `close` or `delete`, and its result
   * is reused for `catalogCacheMs` like any other read.
   * @param signal - caller cancellation, checked before the read starts because
   *   a read already shared with another caller is not that caller's to cancel.
   * @returns the advertised or CLI-listed models, possibly empty.
   */
  async catalog(signal?: AbortSignal): Promise<readonly AcpCatalogModel[]> {
    if (this.advert.length > 0) return this.advert
    const cached = this.catalogRead
    if (cached !== undefined && Date.now() - cached.at < this.options.catalogCacheMs) return cached.models
    const failed = this.catalogFailure
    if (failed !== undefined && Date.now() - failed.at < this.options.catalogFailureCacheMs) throw failed.error
    // One read serves every caller: a picker that polls must not spawn a
    // harness CLI per request, and both its result and its failure are
    // remembered for their windows instead of retried on every read. The read
    // is not bound to a caller's signal, so an already-cancelled caller starts
    // nothing: a rejection nothing awaits would surface as an unhandled
    // rejection instead.
    signal?.throwIfAborted()
    this.catalogPending ??= this.readCatalog()
      .then((models) => {
        this.catalogRead = { at: Date.now(), models }
        this.catalogFailure = undefined
        return models
      }, (error: unknown) => {
        if (isHarnessFailure(this.catalogDeadline, error)) this.catalogFailure = { at: Date.now(), error }
        throw error
      })
      .finally(() => { this.catalogPending = undefined })
    return await this.catalogPending
  }

  /** Read the catalog once: the CLI verb when configured, otherwise one probe session. */
  private async readCatalog(): Promise<readonly AcpCatalogModel[]> {
    const listed = await this.listCatalogCli()
    if (listed.length > 0) return listed
    if (!this.options.probeCatalog) return []
    return await this.probeCatalog()
  }

  /**
   * Open one throwaway session, read the catalog it advertises, and close it
   * again when the agent offers that. A probe is a catalog read, not a
   * session the operator asked for, so it must not accumulate: an agent that
   * advertises no close keeps the session until the process exits, because
   * dropping the connection without closing would leave the harness believing
   * the session is live. Closing is best effort: a close that fails leaves the
   * session to the process lifetime and must not fail the catalog read or make
   * the next read open another probe.
   *
   * Every step carries `cliTimeoutMs`: this read is single-flight, so a harness
   * that starts but never answers would leave the picker's route for this
   * harness pending for the process lifetime. Cancelling the request is what
   * tells the harness to drop the session it was opening, so the deadline does
   * not leave one behind.
   */
  private async probeCatalog(): Promise<readonly AcpCatalogModel[]> {
    const deadline = new AbortController()
    // Published so a rejection can be told apart from another caller's cancel;
    // the promise handler that reads it runs while this probe is still the
    // single in-flight read.
    this.catalogDeadline = deadline.signal
    const timer = setTimeout(() => {
      deadline.abort(
        new AcpProtocolError(`${this.prefix}: the catalog probe did not answer within ${String(this.options.cliTimeoutMs)}ms`),
      )
    }, this.options.cliTimeoutMs)
    try {
      const connection = await this.connect(deadline.signal)
      const response = await connection.request<AcpSessionAdvert & { sessionId?: string }>(
        'session/new',
        { cwd: this.options.cwd, mcpServers: [] },
        deadline.signal,
      )
      const sessionId = response.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new AcpProtocolError(`${this.prefix}: session/new returned no session id`)
      }
      const models = acpAdvertisedModels(response)
      this.recordAdvert(models)
      try {
        await this.closeProbeSession(connection, sessionId, deadline.signal)
      } catch (error: unknown) {
        this.ctx.logger.warn(`${this.prefix}: closing the catalog probe session failed: ${errorChain(error)}`)
      }
      return models
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Close a probe session through whichever capability the agent advertises.
   * @param connection - the live shared connection.
   * @param sessionId - the probe session to close.
   * @param signal - the probe's own deadline, so a close that never answers
   *   cannot hold the single-flight catalog read open.
   */
  private async closeProbeSession(
    connection: AcpClientConnection,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const capabilities = this.initializeResponse?.agentCapabilities?.sessionCapabilities
    if (capabilities?.close !== undefined) {
      await connection.request('session/close', { sessionId }, signal)
      return
    }
    if (capabilities?.delete !== undefined) {
      await connection.request('session/delete', { sessionId }, signal)
    }
  }

  /**
   * Read the optional CLI catalog verb this harness configures. Devin's
   * `models list` is the only shipped shape: families with variants, each
   * naming a model id and label.
   * @param signal - caller cancellation for the CLI run.
   * @returns catalog entries, or none when no verb is configured.
   */
  async listCatalogCli(signal?: AbortSignal): Promise<AcpCatalogModel[]> {
    const args = this.options.catalogArgs
    if (args === undefined) return []
    const output = await this.runCli(args, signal)
    const parsed: unknown = JSON.parse(output)
    const families = typeof parsed === 'object' && parsed !== null
      ? (parsed as { families?: unknown }).families
      : undefined
    if (!Array.isArray(families)) {
      throw new Error(`${this.prefix}: models list returned no families array`)
    }
    const entries: AcpCatalogModel[] = []
    for (const family of families) {
      const variants = typeof family === 'object' && family !== null
        ? (family as { variants?: unknown }).variants
        : undefined
      if (!Array.isArray(variants)) continue
      for (const variant of variants) {
        if (typeof variant !== 'object' || variant === null) continue
        const record = variant as Record<string, unknown>
        const id = typeof record.model_uid === 'string' ? record.model_uid : undefined
        const name = typeof record.label === 'string' ? record.label : undefined
        if (id === undefined || name === undefined) continue
        const cost = typeof record.cost_summary === 'string' ? record.cost_summary : undefined
        entries.push({
          id,
          name,
          ...cost === undefined ? {} : { description: cost },
        })
      }
    }
    return entries
  }

  /**
   * Run the harness's auth-status verb and report its exit state and trimmed
   * output.
   * @param signal - caller cancellation.
   * @returns the CLI's exit fact and diagnostic text.
   */
  async authStatus(signal?: AbortSignal): Promise<{ loggedIn: boolean; detail: string }> {
    if (this.options.authStatusArgs.length === 0) {
      return {
        loggedIn: false,
        detail: `${this.prefix}: this harness reports authorization through its ACP methods, not a CLI verb`,
      }
    }
    try {
      const output = await this.runCli(this.options.authStatusArgs, signal, true)
      return { loggedIn: output.exitCode === 0, detail: output.text.trim() }
    } catch (error: unknown) {
      return { loggedIn: false, detail: errorChain(error) }
    }
  }

  /**
   * Run the harness's auth-logout verb.
   * @param signal - caller cancellation.
   */
  async authLogout(signal?: AbortSignal): Promise<void> {
    if (this.options.authLogoutArgs.length === 0) {
      throw new Error(
        `${this.prefix}: this harness configures no auth-logout command and advertises no ACP logout method`,
      )
    }
    await this.runCli(this.options.authLogoutArgs, signal)
  }

  /**
   * Forward the ACP `authenticate` request to this harness's shared agent
   * (Devin's `devin-browser` method opens the browser).
   * @param methodId - one advertised auth-method id.
   * @param signal - caller cancellation.
   */
  async authenticate(methodId: string, signal?: AbortSignal): Promise<void> {
    const connection = await this.connect(signal)
    await connection.request('authenticate', { methodId }, signal)
  }

  /**
   * Sign the account out: the ACP `logout` request when the connected agent
   * advertises it, otherwise the harness's auth-logout CLI. Real Devin answers
   * `agentCapabilities.auth` as `{}` — no logout method — so the CLI carries
   * that deployment, and a request the agent does not serve is never sent. A
   * harness that has not connected yet is connected first, because only the
   * agent's own initialize response says whether it serves `logout`.
   * @param signal - caller cancellation.
   */
  async logout(signal?: AbortSignal): Promise<void> {
    if (this.initializeResponse === undefined) await this.connect(signal)
    const connection = this.connection
    if (connection === undefined || !this.advertisesLogout()) {
      await this.authLogout(signal)
      return
    }
    await connection.request('logout', {}, signal)
  }

  /** Whether the connected agent advertises the ACP `logout` method. */
  private advertisesLogout(): boolean {
    return this.initializeResponse?.agentCapabilities?.auth?.logout != null
  }

  /**
   * Register the peer owning one ACP session id.
   * @param sessionId - the agent-issued session id.
   * @param peer - dispatch surface for that session's frames.
   * @returns the disposer that detaches the peer.
   */
  registerSession(sessionId: string, peer: Parameters<AcpClientConnection['registerPeer']>[1]): () => void {
    if (this.connection === undefined) {
      throw new Error(`${this.prefix}: session registration before connect`)
    }
    return this.connection.registerPeer(sessionId, peer)
  }

  /** The shared connection when established; undefined before first connect. */
  get active(): AcpClientConnection | undefined {
    return this.connection
  }

  /**
   * Close the shared connection and dispose the managed process; resolves at
   * whole-range quiescence. The latch is set before the first await so a
   * connect already in flight cannot publish an endpoint after this call
   * returns; the in-flight startup is awaited and tears down whatever it
   * produced.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const starting = this.connecting
    if (starting !== undefined) await starting.catch(() => {})
    this.connection?.close()
    this.connection = undefined
    this.initializeResponse = undefined
    const process = this.process
    this.process = undefined
    if (process !== undefined) await process.dispose(this.options.eofGraceMs)
  }

  /** Diagnostic tag naming this harness in every message the runtime raises. */
  private get prefix(): string {
    return acpPrefix(this.options.harness)
  }

  private async openConnection(signal?: AbortSignal): Promise<AcpClientConnection> {
    const process = await ExternalHarnessProcess.spawn(this.ctx.subprocess, {
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
      env: this.options.env,
      graceMs: this.options.disposeGraceMs,
      ...signal === undefined ? {} : { signal },
    })
    try {
      const { connection, initialize } = await AcpClientConnection.open(
        process.stdout,
        process.stdin,
        signal ?? new AbortController().signal,
      )
      // A handshake that settles after dispose() latched must not publish an
      // endpoint nothing owns any more: close it and drop the child here, so
      // disposal stays the only owner of the process range.
      if (this.disposed) {
        connection.close()
        throw new Error(`${this.prefix}: runtime is disposed`)
      }
      this.adopt(process, connection, initialize)
      return connection
    } catch (error: unknown) {
      /* v8 ignore next -- teardown of a child whose handshake failed is
         already best-effort at this point; the startup error is what callers act on. */
      await process.dispose(this.options.eofGraceMs).catch(() => {})
      throw error
    }
  }

  /**
   * Publish a fresh endpoint and arrange for its removal when it dies. A
   * later {@link connect} then spawns a new child instead of handing back an
   * endpoint whose process or connection is already gone.
   */
  private adopt(
    process: ExternalHarnessProcess,
    connection: AcpClientConnection,
    initialize: InitializeResponse,
  ): void {
    this.process = process
    this.connection = connection
    this.initializeResponse = initialize
    const retired = (): void => { this.retire(connection, process) }
    // Child exit and connection fatality are independent observations of the
    // same endpoint dying; whichever lands first retires it once.
    void process.done.then(retired, retired)
    void connection.fatal.then(retired, retired)
  }

  /**
   * Drop the endpoint owning `connection` and reap its child, which may
   * outlive the connection that exposed the failure.
   */
  private retire(connection: AcpClientConnection, process: ExternalHarnessProcess): void {
    // Disposal clears the endpoint before it closes the connection, so a
    // retirement racing it finds a different (or no) connection and stops.
    if (this.connection !== connection) return
    this.connection = undefined
    this.initializeResponse = undefined
    this.process = undefined
    /* v8 ignore next 3 -- a failed reap has no observable producer: the range
       this child owns is already gone whenever retirement runs. */
    void process.dispose(this.options.eofGraceMs).catch((error: unknown) => {
      this.ctx.logger.warn(`${this.prefix}: reaping the failed child failed: ${errorChain(error)}`)
    })
  }

  /**
   * Run one short-lived CLI command through the same subprocess seam.
   * @param args - arguments after the configured command.
   * @param signal - caller cancellation.
   * @param capture - whether to capture exit details without rejecting on
   *   non-zero exit.
   * @returns stdout text, or the text plus exit code when `capture`.
   */
  private async runCli(
    args: readonly string[],
    signal?: AbortSignal,
    capture?: false,
  ): Promise<string>
  private async runCli(
    args: readonly string[],
    signal: AbortSignal | undefined,
    capture: true,
  ): Promise<{ text: string; exitCode: number | null }>
  private async runCli(
    args: readonly string[],
    signal?: AbortSignal,
    capture = false,
  ): Promise<string | { text: string; exitCode: number | null }> {
    const executable = await this.ctx.subprocess.resolveExecutable(
      this.options.command,
      this.options.env,
      signal,
    )
    // The provider turns an abort into a signal exit, so the deadline is read
    // back after settlement to report a timeout as one.
    const deadline = new AbortController()
    const timer = setTimeout(() => {
      deadline.abort(new Error(`${this.prefix}: ${this.options.command} ${args.join(' ')} timed out`))
    }, this.options.cliTimeoutMs)
    const bound = signal === undefined
      ? deadline.signal
      : AbortSignal.any([signal, deadline.signal])
    let outcome: SubprocessOutcome
    let handle: SubprocessHandle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [executable, ...args],
        cwd: this.options.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 8 * 1024 * 1024 },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: this.options.disposeGraceMs,
        env: this.options.env,
        signal: bound,
      })
      outcome = await handle.done
    } finally {
      clearTimeout(timer)
    }
    if (deadline.signal.aborted) {
      throw new Error(
        `${this.prefix}: ${this.options.command} ${args.join(' ')} did not answer within ${String(this.options.cliTimeoutMs)}ms`,
      )
    }
    /* v8 ignore next -- the seam publishes a stdout reader for every collect-mode stream. */
    const text = handle.collected.stdout?.readFrom(0).text ?? ''
    if (capture) return { text, exitCode: outcome.exitCode }
    if (outcome.exitCode !== 0) {
      /* v8 ignore next -- the seam publishes a stderr reader for every collect-mode stream. */
      const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
      throw new Error(
        `${this.prefix}: ${this.options.command} ${args.join(' ')} exited ${String(outcome.exitCode)}${stderr === '' ? '' : `: ${stderr}`}`,
      )
    }
    return text
  }
}

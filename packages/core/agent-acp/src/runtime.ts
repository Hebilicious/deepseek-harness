/**
 * Profile-shared ACP runtime: one `devin acp`-shape child process, one
 * {@link AcpClientConnection}, the Devin model catalog read
 * (`devin models list --format json`), and the auth CLI verbs the settings
 * panel drives. All state here is connection-global, never session-local.
 *
 * @module @deepseek-ai/dsh-agent-acp/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InitializeResponse } from '@agentclientprotocol/sdk'
import { ExternalHarnessProcess } from '@deepseek-ai/dsh-agent-external'
import { AcpClientConnection } from './connection.ts'
import { ACP_PREFIX } from './protocol.ts'

/** Options the plugin resolves once at construction; all fields required. */
export interface AcpRuntimeOptions {
  /** Harness executable (default `devin`). */
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
  /** Model-catalog command arguments (default `['models', 'list', '--format', 'json']`). */
  readonly modelsArgs: readonly string[]
  /** Auth-status command arguments (default `['auth', 'status']`). */
  readonly authStatusArgs: readonly string[]
  /** Auth-logout command arguments (default `['auth', 'logout']`). */
  readonly authLogoutArgs: readonly string[]
}

/** One catalog entry from `devin models list`. */
export interface DevinModelEntry {
  /** Opaque model uid the ACP `model` config option accepts. */
  readonly id: string
  /** Human-readable label. */
  readonly name: string
  /** Cost/capability summary, when the CLI reports one. */
  readonly description?: string
  /** Whether the model accepts image input, when the CLI reports it. */
  readonly supportsImages?: boolean
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * The profile's shared ACP runtime. `connect` memoizes one live connection;
 * teardown disposes the managed process through {@link ExternalHarnessProcess}
 * so quiescence is proven, not assumed.
 */
export class AcpRuntime {
  private process: ExternalHarnessProcess | undefined
  private connection: AcpClientConnection | undefined
  private connecting: Promise<AcpClientConnection> | undefined
  private initializeResponse: InitializeResponse | undefined
  private disposed = false

  /**
   * @param ctx - the plugin service context (logger and subprocess seam).
   * @param options - resolved runtime options.
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
   * Spawn and handshake the shared `devin acp` process exactly once.
   * @param signal - caller cancellation for the startup window.
   * @returns the live shared connection.
   */
  async connect(signal?: AbortSignal): Promise<AcpClientConnection> {
    if (this.disposed) throw new Error(`${ACP_PREFIX}: runtime is disposed`)
    if (this.connection !== undefined) return this.connection
    this.connecting ??= this.openConnection(signal)
    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  /**
   * Enumerate the Devin model catalog through the CLI (`devin models list
   * --format json`), flattened into one entry per variant.
   * @param signal - caller cancellation.
   * @returns catalog entries in CLI order.
   */
  async listDevinModels(signal?: AbortSignal): Promise<DevinModelEntry[]> {
    const output = await this.runCli(this.options.modelsArgs, signal)
    const parsed: unknown = JSON.parse(output)
    const families = typeof parsed === 'object' && parsed !== null
      ? (parsed as { families?: unknown }).families
      : undefined
    if (!Array.isArray(families)) {
      throw new Error(`${ACP_PREFIX}: models list returned no families array`)
    }
    const entries: DevinModelEntry[] = []
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
        const supportsImages = typeof record.supports_images === 'boolean'
          ? record.supports_images
          : undefined
        const cost = typeof record.cost_summary === 'string' ? record.cost_summary : undefined
        entries.push({
          id,
          name,
          ...cost === undefined ? {} : { description: cost },
          ...supportsImages === undefined ? {} : { supportsImages },
        })
      }
    }
    return entries
  }

  /**
   * Run `devin auth status` and report its exit state and trimmed output.
   * @param signal - caller cancellation.
   * @returns the CLI's exit fact and diagnostic text.
   */
  async authStatus(signal?: AbortSignal): Promise<{ loggedIn: boolean; detail: string }> {
    try {
      const output = await this.runCli(this.options.authStatusArgs, signal, true)
      return { loggedIn: output.exitCode === 0, detail: output.text.trim() }
    } catch (error: unknown) {
      return { loggedIn: false, detail: toError(error).message }
    }
  }

  /**
   * Run `devin auth logout`.
   * @param signal - caller cancellation.
   */
  async authLogout(signal?: AbortSignal): Promise<void> {
    await this.runCli(this.options.authLogoutArgs, signal)
  }

  /**
   * Forward the ACP `authenticate` request to the shared agent (Devin's
   * `devin-browser` method opens the browser).
   * @param methodId - one advertised auth-method id.
   * @param signal - caller cancellation.
   */
  async authenticate(methodId: string, signal?: AbortSignal): Promise<void> {
    const connection = await this.connect(signal)
    await connection.request('authenticate', { methodId }, signal)
  }

  /**
   * Forward the ACP `logout` request to the shared agent.
   * @param signal - caller cancellation.
   */
  async logout(signal?: AbortSignal): Promise<void> {
    const connection = await this.connect(signal)
    await connection.request('logout', {}, signal)
  }

  /**
   * Register the peer owning one ACP session id.
   * @param sessionId - the agent-issued session id.
   * @param peer - dispatch surface for that session's frames.
   * @returns the disposer that detaches the peer.
   */
  registerSession(sessionId: string, peer: Parameters<AcpClientConnection['registerPeer']>[1]): () => void {
    if (this.connection === undefined) {
      throw new Error(`${ACP_PREFIX}: session registration before connect`)
    }
    return this.connection.registerPeer(sessionId, peer)
  }

  /** The shared connection when established; undefined before first connect. */
  get active(): AcpClientConnection | undefined {
    return this.connection
  }

  /**
   * Close the shared connection and dispose the managed process; resolves at
   * whole-range quiescence.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.connection?.close()
    const process = this.process
    this.process = undefined
    this.connection = undefined
    if (process !== undefined) await process.dispose(this.options.eofGraceMs)
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
      this.process = process
      this.connection = connection
      this.initializeResponse = initialize
      return connection
    } catch (error: unknown) {
      await process.dispose(this.options.eofGraceMs).catch(() => {})
      throw error
    }
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
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...args],
      cwd: this.options.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8 * 1024 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: this.options.disposeGraceMs,
      env: this.options.env,
      ...signal === undefined ? {} : { signal },
    })
    const outcome = await handle.done
    const text = handle.collected.stdout?.readFrom(0).text ?? ''
    if (capture) return { text, exitCode: outcome.exitCode }
    if (outcome.exitCode !== 0) {
      const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
      throw new Error(
        `${ACP_PREFIX}: ${this.options.command} ${args.join(' ')} exited ${String(outcome.exitCode)}${stderr === '' ? '' : `: ${stderr}`}`,
      )
    }
    return text
  }
}

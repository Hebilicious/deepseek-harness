/**
 * Managed external-harness process: spawn through the subprocess seam with a
 * resolved executable and a bounded stderr diagnostic tail, and a cooperative
 * teardown ladder that resolves only at whole-range quiescence.
 *
 * @module @deepseek-ai/dsh-agent-external/process
 */

import type { Readable, Writable } from 'node:stream'
import { disposeSubprocessChild } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessRuntime,
} from '@deepseek-ai/dsh-subprocess'

/** Default in-memory stderr tail: enough for a startup diagnostic, never a transcript. */
const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024

/** Fully-specified harness-process spawn request; the seam applies no defaults. */
export interface ExternalHarnessSpawnRequest {
  /** Bare command name or absolute path, resolved through the subprocess seam. */
  readonly command: string
  /** Arguments appended after the resolved executable. */
  readonly args: readonly string[]
  /** Working directory for the child. */
  readonly cwd: string
  /**
   * Explicit environment entries layered over the scrubbed parent base: a
   * string is a deliberate opt-in, `undefined` removes an ambient entry.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** In-memory stderr tail cap in bytes; defaults to {@link DEFAULT_STDERR_TAIL_BYTES}. */
  readonly stderrMaxBytes?: number
  /** Provider termination-escalation grace (ms). */
  readonly graceMs: number
  /**
   * Abort signal bounding executable resolution and the pre-spawn check only.
   * The spawned range deliberately takes NO signal: a caller-scoped abort would
   * SIGTERM the shared profile process, while {@link dispose} and provider
   * teardown already own its lifetime.
   */
  readonly signal?: AbortSignal
}

/**
 * One managed harness child with piped stdin/stdout for the wire protocol and
 * a bounded stderr reader for diagnostics. {@link dispose} is the only
 * teardown verb; it resolves at managed-range quiescence, not at the top-level
 * process's exit report.
 */
export class ExternalHarnessProcess {
  private constructor(
    private readonly handle: SubprocessHandle,
    private readonly stderrReader: SubprocessOutputReader | undefined,
  ) {}

  /**
   * Resolve the command and spawn the child. A resolution or spawn failure
   * rejects before any handle exists; the returned process is already live.
   * @param runtime - the mounted subprocess service.
   * @param request - the fully-specified spawn request.
   * @returns the live managed process.
   */
  static async spawn(
    runtime: SubprocessRuntime,
    request: ExternalHarnessSpawnRequest,
  ): Promise<ExternalHarnessProcess> {
    const env = request.env === undefined
      ? undefined
      : Object.fromEntries(
        Object.entries(request.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
    const executable = await runtime.resolveExecutable(request.command, env, request.signal)
    request.signal?.throwIfAborted()
    const handle = runtime.spawn({
      argv: [executable, ...request.args],
      cwd: request.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: request.stderrMaxBytes ?? DEFAULT_STDERR_TAIL_BYTES },
      },
      graceMs: request.graceMs,
      env: request.env === undefined ? undefined : { ...request.env },
    })
    if (handle.stdin === undefined || handle.stdout === undefined) {
      // The spawn contract guarantees piped stdio; a provider that breaks it
      // fails the driver loudly instead of hanging the wire reader.
      handle.terminate()
      await handle.waitForExit().catch(() => {})
      throw new Error(`subprocess provider returned no piped stdio for "${request.command}"`)
    }
    return new ExternalHarnessProcess(handle, handle.collected.stderr)
  }

  /** Writable wire stream into the child. */
  get stdin(): Writable {
    // eslint-disable-next-line typescript/no-non-null-assertion -- spawn rejects a missing pipe
    return this.handle.stdin!
  }

  /** Readable wire stream out of the child. */
  get stdout(): Readable {
    // eslint-disable-next-line typescript/no-non-null-assertion -- spawn rejects a missing pipe
    return this.handle.stdout!
  }

  /** Spawned-command exit facts; rejects for spawn or provider failures. */
  get done(): Promise<SubprocessOutcome> {
    return this.handle.done
  }

  /**
   * The retained stderr tail, for diagnostics after a failure or unexpected exit.
   * @returns the collected stderr text, or an empty string when the provider collected none.
   */
  stderrTail(): string {
    return this.stderrReader?.readFrom(0).text ?? ''
  }

  /**
   * Cooperative teardown ladder over the seam's public verbs; resolves only
   * at whole-range quiescence. Delegates to {@link disposeSubprocessChild},
   * which closes stdin, holds the child on the EOF grace, and escalates
   * through the terminate() procedure and its whole-range exit proof when that
   * grace expires.
   * @param eofGraceMs - tier-1 window after stdin EOF.
   * @returns resolves at managed-range quiescence; rejects with the single tier failure, or an `AggregateError` when several tiers failed.
   */
  dispose(eofGraceMs: number): Promise<void> {
    return disposeSubprocessChild(this.handle, eofGraceMs)
  }
}

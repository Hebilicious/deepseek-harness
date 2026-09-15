/**
 * Managed external-harness process: spawn through the subprocess seam with a
 * resolved executable and a bounded stderr diagnostic tail, and a cooperative
 * teardown ladder that resolves only at whole-range quiescence.
 *
 * @module @deepseek-ai/dsh-agent-external/process
 */

import type { Readable, Writable } from 'node:stream'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessRuntime,
} from '@deepseek-ai/dsh-subprocess'

/** Default in-memory stderr tail: enough for a startup diagnostic, never a transcript. */
const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Bounded managed-range exit wait: observes the handle's range until it is empty or `ms` elapses. */
async function rangeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

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

  /** The retained stderr tail, for diagnostics after a failure or unexpected exit. */
  stderrTail(): string {
    return this.stderrReader?.readFrom(0).text ?? ''
  }

  /**
   * Cooperative teardown ladder over the seam's public verbs; resolves only
   * at whole-range quiescence: stdin EOF (the child's window to flush
   * persistence and reap its own descendants), then the terminate()
   * escalation and its whole-range exit proof.
   * @param eofGraceMs - tier-1 window after stdin EOF.
   */
  async dispose(eofGraceMs: number): Promise<void> {
    const failures: Error[] = []
    this.handle.stdin?.end()
    let exited = false
    try {
      exited = await rangeExitsWithin(this.handle, eofGraceMs)
    } catch (error: unknown) {
      failures.push(toError(error))
    }
    if (!exited) {
      // terminate() owns the bounded SIGTERM→SIGKILL timer. Its unbounded wait
      // is the process owner's exit proof, not a second derived grace.
      this.handle.terminate()
      try {
        await this.handle.waitForExit()
      } catch (error: unknown) {
        failures.push(toError(error))
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'harness subprocess teardown failed')
  }
}

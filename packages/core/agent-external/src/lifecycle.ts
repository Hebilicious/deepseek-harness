/**
 * Factory-level lifecycle ownership shared by agent drivers: fused caller/
 * owner/teardown cancellation, live-agent tracking, and quiescent disposal.
 *
 * @module @deepseek-ai/dsh-agent-external/lifecycle
 */

import type { Context } from '@deepseek-ai/cordis'
import { FiberState } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Fiber states that cannot own or serve a new lifecycle. */
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])

/**
 * Factory-level ownership: live agent teardowns plus startup work. The label
 * names the owning driver in abort reasons (`<label> is not active`).
 */
export class FactoryOwnership {
  private accepting = true
  private readonly teardown = new AbortController()
  private readonly inactive = Promise.withResolvers<void>()
  private readonly liveAgents = new Set<() => Promise<void>>()
  private startupTasks = new Set<Promise<void>>()

  constructor(
    private readonly fiber: Context['fiber'],
    private readonly label: string,
  ) {}

  /** Aborts (reason: `<label> is not active` error) when factory teardown begins. */
  get signal(): AbortSignal {
    return this.teardown.signal
  }

  /** Whether this factory may still accept new lifecycles.
   * @returns `true` while the owner fiber is live and teardown has not begun.
   */
  isActive(): boolean {
    return this.accepting && !INACTIVE_STATES.has(this.fiber.state)
  }

  /**
   * Track one live agent's shared teardown until it has run.
   * @param dispose - the agent's memoized teardown.
   * @returns a function that stops tracking it.
   */
  track(dispose: () => Promise<void>): () => void {
    this.liveAgents.add(dispose)
    return () => { this.liveAgents.delete(dispose) }
  }

  /**
   * Join config startup work that begins before an agent exists.
   * @param job - the startup work factory disposal awaits.
   */
  trackStartup(job: Promise<void>): void {
    this.startupTasks.add(job)
    const forget = () => { this.startupTasks.delete(job) }
    void job.then(forget, forget)
  }

  /**
   * Join one public create/resume continuation; factory dispose awaits its settlement.
   * @param job - the continuation whose settlement disposal awaits.
   */
  trackWrapper(job: Promise<unknown>): void {
    this.trackStartup(job.then(() => undefined, () => undefined))
  }

  /**
   * Resolve `job`, or stop waiting when factory teardown begins.
   * @param job - the wait a caller must not extend past teardown.
   */
  async waitWhileActive(job: Promise<void>): Promise<void> {
    await Promise.race([job, this.inactive.promise])
  }

  /** Abort every fused signal and join live teardowns and startup work.
   * @returns a promise that settles at full quiescence.
   */
  async dispose(): Promise<void> {
    this.accepting = false
    this.teardown.abort(new Error(`${this.label} is not active`))
    this.inactive.resolve()
    await Promise.all([
      ...[...this.liveAgents].map(dispose => dispose()),
      ...this.startupTasks,
    ])
  }
}

/**
 * Await `operation`, or throw the signal's reason as soon as it aborts.
 * @param operation - the promise or value to await.
 * @param signal - cancellation whose reason becomes the thrown error.
 * @param id - session identity named in the abort error message.
 * @returns the operation's value when it settles first.
 */
export async function raceAbort<T>(
  operation: PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
): Promise<T> {
  const toAbortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  if (signal.aborted) throw toAbortError()
  const aborted = Promise.withResolvers<never>()
  const listener = (): void => { aborted.reject(toAbortError()) }
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

/**
 * Start an abortable operation and release a value that arrives after cancellation.
 * @param operation - starts the work and returns its promise.
 * @param signal - cancellation whose reason becomes the thrown error.
 * @param id - session identity named in the abort error message.
 * @param releaseAbandoned - receives a value that arrives after cancellation.
 * @returns the operation's value when it settles first.
 */
export async function raceAbortCall<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
  id: SessionId,
  releaseAbandoned?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  }
  const pending = Promise.resolve().then(operation)
  try {
    return await raceAbort(pending, signal, id)
  } catch (error: unknown) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while the operation is awaited.
    if (signal.aborted && releaseAbandoned !== undefined) {
      void pending.then(releaseAbandoned, () => undefined)
    }
    throw error
  }
}

/**
 * Reject an output-token cap that cannot be represented exactly on the request wire.
 * @param options - the agent options to validate.
 */
export function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

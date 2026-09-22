/**
 * Cooperative teardown ladder for one provider-managed child range: stdin EOF,
 * one bounded wait for the range to drain, then the termination escalation
 * with its whole-range exit proof. A consumer whose child follows a different
 * cooperation order builds its own ladder over the same seam verbs.
 *
 * @module @deepseek-ai/dsh-subprocess/dispose
 */

import type { SubprocessHandle } from './types.ts'

/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Bounded managed-range exit wait: observes the handle's range until it is empty or `ms` elapses.
 * @param child - the handle whose managed range is observed.
 * @param ms - upper bound in milliseconds for the wait.
 * @returns `true` when the managed range emptied within the bound, `false` when the bound aborted the wait first.
 */
async function rangeExitsWithin(child: SubprocessHandle, ms: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  try {
    return await child.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cooperative teardown ladder over the seam's public verbs; resolves only at
 * whole-range quiescence. stdin EOF gives the child its window to flush
 * persistence and reap its own descendants; when the managed range is still
 * non-empty after `eofGraceMs`, `terminate()` starts the provider's documented
 * termination procedure and the same range is awaited again. `terminate()` owns
 * the provider's bounded SIGTERM→SIGKILL timer, so that final wait is the
 * process owner's exit proof rather than a second derived grace.
 *
 * A failing tier never skips a later tier: every failure is collected in the
 * order the tiers produced it.
 * @param child - the handle whose managed range is torn down.
 * @param eofGraceMs - tier-1 window after stdin EOF, before the terminate escalation.
 * @returns resolves at whole-range quiescence; rejects with the single tier failure, or an `AggregateError` when several tiers failed.
 */
export async function disposeSubprocessChild(child: SubprocessHandle, eofGraceMs: number): Promise<void> {
  const failures: Error[] = []
  child.stdin?.end()
  let exited = false
  try {
    exited = await rangeExitsWithin(child, eofGraceMs)
  } catch (error: unknown) {
    failures.push(toError(error))
  }
  if (!exited) {
    child.terminate()
    try {
      await child.waitForExit()
    } catch (error: unknown) {
      failures.push(toError(error))
    }
  }
  const [firstFailure, ...laterFailures] = failures
  if (firstFailure !== undefined && laterFailures.length === 0) throw firstFailure
  if (firstFailure !== undefined) throw new AggregateError(failures, 'subprocess teardown failed')
}

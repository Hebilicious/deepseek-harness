import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { disposeSubprocessChild } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/**
 * Unit coverage for the shared teardown ladder, imported through the package
 * root so the public export is pinned too. Handles are fakes because the ladder
 * is defined only in terms of the seam's verbs: a fake records which verb ran at
 * which tier and when the escalation tier was reached, which a real child's
 * wall-clock behavior cannot show. The same function runs against real
 * short-lived node children in agent-external's suite, through
 * `ManagedProcess.dispose`.
 */

interface FakeScript {
  /** Answer for the bounded tier; receiving the signal lets a case resolve false only on expiry. */
  bounded: (signal: AbortSignal) => Promise<boolean>
  /** Answer for the escalation tier's unbounded wait; defaults to a proven exit. */
  final?: () => Promise<boolean>
  /** Pass false to model a handle spawned without a stdin pipe. */
  stdin?: boolean
}

/** One scripted managed range plus the call order its verbs recorded. */
function fakeChild(script: FakeScript): { handle: SubprocessHandle; calls: string[] } {
  const calls: string[] = []
  const final = script.final ?? ((): Promise<boolean> => Promise.resolve(true))
  const handle: SubprocessHandle = {
    stdin: script.stdin === false ? undefined : new PassThrough(),
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {},
    done: new Promise<SubprocessOutcome>(() => {}),
    terminate: () => { calls.push('terminate') },
    waitForExit: (signal?: AbortSignal) => {
      if (signal === undefined) {
        calls.push('final wait')
        return final()
      }
      calls.push('bounded wait')
      return script.bounded(signal)
    },
  }
  return { handle, calls }
}

describe('disposeSubprocessChild (the shared cooperative teardown ladder)', () => {
  it('closes stdin and resolves without terminating when the range exits inside the EOF grace', async () => {
    const { handle, calls } = fakeChild({ bounded: () => Promise.resolve(true) })

    await expect(disposeSubprocessChild(handle, 5_000)).resolves.toBeUndefined()

    expect(handle.stdin?.writableEnded).toBe(true)
    expect(calls).toEqual(['bounded wait'])
  })

  it('escalates through terminate when the EOF grace expires, then awaits the range again', async () => {
    let boundedSignal: AbortSignal | undefined
    const { handle, calls } = fakeChild({
      bounded: (signal) => {
        boundedSignal = signal
        return new Promise<boolean>((resolve) => {
          signal.addEventListener('abort', () => { resolve(false) }, { once: true })
        })
      },
    })

    await expect(disposeSubprocessChild(handle, 20)).resolves.toBeUndefined()

    expect(boundedSignal?.aborted).toBe(true)
    expect(calls).toEqual(['bounded wait', 'terminate', 'final wait'])
  })

  it('rethrows the bounded wait failure alone after the escalation succeeds', async () => {
    const failure = new Error('range watch failed')
    const { handle, calls } = fakeChild({
      bounded: () => Promise.reject(failure),
      final: () => Promise.resolve(true),
    })

    await expect(disposeSubprocessChild(handle, 5_000)).rejects.toBe(failure)

    expect(calls).toEqual(['bounded wait', 'terminate', 'final wait'])
  })

  it('preserves both tier failures in observation order', async () => {
    const boundedFailure = new Error('bounded wait failed')
    const finalFailure = new Error('final wait failed')
    const { handle } = fakeChild({
      bounded: () => Promise.reject(boundedFailure),
      final: () => Promise.reject(finalFailure),
    })

    let failure: unknown
    try {
      await disposeSubprocessChild(handle, 5_000)
    } catch (error: unknown) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([boundedFailure, finalFailure])
    expect((failure as Error).message).toBe('subprocess teardown failed')
  })

  it('normalizes a non-Error rejection from the bounded wait', async () => {
    const rejection: unknown = 'range watch failed'
    // A thrown non-Error is the rejection this case must observe.
    const { handle } = fakeChild({ bounded: async () => { throw rejection } })

    await expect(disposeSubprocessChild(handle, 5_000)).rejects.toThrow('range watch failed')
  })

  it('tears down a handle whose stdin was not piped', async () => {
    const { handle, calls } = fakeChild({ stdin: false, bounded: () => Promise.resolve(true) })

    await expect(disposeSubprocessChild(handle, 5_000)).resolves.toBeUndefined()

    expect(handle.stdin).toBeUndefined()
    expect(calls).toEqual(['bounded wait'])
  })
})

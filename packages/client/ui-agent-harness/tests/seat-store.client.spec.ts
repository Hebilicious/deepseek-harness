/**
 * The seat controller: one catalog read per connection, the harness staged for
 * the next session, and the rule that keeps a deployment mounting one harness
 * on the create request it already sent.
 */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { HarnessId } from '@deepseek-ai/dsh-agent/types'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionHarnessCatalog,
  SessionHarnessOption,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { AgentHarnessSeatController } from '../src/client/seat-store.ts'

const hid = (value: string): HarnessId => value as HarnessId

const option = (id: string, name: string, description?: string): SessionHarnessOption => ({
  id: hid(id),
  name,
  ...description === undefined ? {} : { description },
})

const CATALOG: SessionHarnessCatalog = {
  harnesses: [
    option('dsh', 'DeepSeek Harness', 'The in-process agent loop.'),
    option('codex', 'Codex', 'Runs the Codex CLI.'),
  ],
}

const SINGLE: SessionHarnessCatalog = { harnesses: [option('dsh', 'DeepSeek Harness')] }

const FAILURE: RemoteResult<SessionHarnessCatalog> = {
  ok: false,
  error: new RemoteError('gateway/internal', 'catalog unavailable', {}),
}

type Answer = RemoteResult<SessionHarnessCatalog>

/** A controller over catalog reads the spec answers by hand. */
function bench() {
  const stages: HarnessId[] = []
  const pending: Array<(result: Answer) => void> = []
  let reads = 0
  const ctx = {
    remote: {
      session: {
        harnessCatalog: () => {
          reads += 1
          return new Promise<Answer>((resolve) => { pending.push(resolve) })
        },
      },
    },
    sessions: { stageHarness: (harness: HarnessId) => { stages.push(harness) } },
  } as unknown as Context
  const controller = new AgentHarnessSeatController(ctx)
  return {
    controller,
    stages,
    reads: (): number => reads,
    /** Start a load; the caller settles it through {@link resolve} or {@link answer}. */
    start: (): Promise<void> => controller.load(),
    /** Settle one queued read by position, so a spec can answer out of order. */
    resolve: (index: number, result: Answer): void => { pending[index]?.(result) },
    /** Start one load, answer it, and await it. */
    answer: async (result: Answer): Promise<void> => {
      const loading = controller.load()
      pending.shift()?.(result)
      await loading
    },
  }
}

describe('the harness catalog read', () => {
  it('publishes the mounted harnesses and stages the first one', async () => {
    const b = bench()

    await b.answer({ ok: true, value: CATALOG })

    expect(b.controller.store.getSnapshot().harnesses.map(entry => entry.id)).toEqual(['dsh', 'codex'])
    expect(b.controller.store.getSnapshot().current).toBe('dsh')
    // The host refuses a create that names no harness while several are
    // mounted, so the chip stages its own opening choice.
    expect(b.stages).toEqual(['dsh'])
    expect(b.reads()).toBe(1)
  })

  it('stages nothing while the deployment mounts one harness', async () => {
    const b = bench()

    await b.answer({ ok: true, value: SINGLE })

    expect(b.controller.store.getSnapshot().harnesses).toHaveLength(1)
    // The host resolves its sole harness for a create that names none, and any
    // stage an earlier catalog left behind is cleared rather than shipped.
    expect(b.stages).toEqual([undefined])
  })

  it('stages nothing while the deployment mounts none', async () => {
    const b = bench()

    await b.answer({ ok: true, value: { harnesses: [] } })

    expect(b.controller.store.getSnapshot()).toEqual({ harnesses: [], current: null })
    // Nothing to stage, so the stage is cleared.
    expect(b.stages).toEqual([undefined])
  })

  it('keeps the previous catalog and stage when a later read fails', async () => {
    const b = bench()
    await b.answer({ ok: true, value: CATALOG })
    b.stages.length = 0

    await b.answer(FAILURE)

    expect(b.controller.store.getSnapshot().harnesses).toHaveLength(2)
    expect(b.stages).toEqual([])
  })

  it('leaves the seat empty when the first read fails', async () => {
    const b = bench()

    await b.answer(FAILURE)

    expect(b.controller.store.getSnapshot()).toEqual({ harnesses: [], current: null })
    // A failed read publishes nothing, so it neither stages nor clears.
    expect(b.stages).toEqual([])
  })

  it('publishes only the newest answer of overlapping reads', async () => {
    const b = bench()
    const first = b.start()
    const second = b.start()

    b.resolve(1, { ok: true, value: SINGLE })
    b.resolve(0, { ok: true, value: CATALOG })
    await Promise.all([first, second])

    expect(b.controller.store.getSnapshot().harnesses).toHaveLength(1)
  })
})

describe('the staged choice', () => {
  it('stages a pick immediately, before any catalog read', () => {
    const b = bench()

    b.controller.select(hid('codex'))

    expect(b.controller.store.getSnapshot().current).toBe('codex')
    expect(b.stages).toEqual(['codex'])
  })

  it('keeps a staged harness the deployment still mounts across a refresh', async () => {
    const b = bench()
    await b.answer({ ok: true, value: CATALOG })
    b.controller.select(hid('codex'))
    b.stages.length = 0

    await b.answer({ ok: true, value: CATALOG })

    expect(b.controller.store.getSnapshot().current).toBe('codex')
    expect(b.stages).toEqual(['codex'])
  })

  it('falls back to the first mounted harness when the staged one is gone', async () => {
    const b = bench()
    await b.answer({ ok: true, value: CATALOG })
    b.controller.select(hid('codex'))
    b.stages.length = 0

    await b.answer({ ok: true, value: SINGLE })

    expect(b.controller.store.getSnapshot().current).toBe('dsh')
    // The earlier stage no longer names a mounted harness, so it is cleared
    // rather than left for the next create to be refused.
    expect(b.stages).toEqual([undefined])
  })
})

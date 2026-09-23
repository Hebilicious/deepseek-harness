/**
 * The seat controller: one catalog read per connection, the harness staged for
 * the next session, and the rule that keeps a deployment mounting one harness
 * on the create request it already sent.
 */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { HarnessId } from '@deepseek-ai/dsh-agent/types'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
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
  const workspaces = {
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', sessionIds: ['session-1'] }] }) },
  }
  const stages: HarnessId[] = []
  const bindings: Array<[string, HarnessId]> = []
  const bindable = new Set<string>()
  let rebinding: string | undefined
  const pending: Array<(result: Answer) => void> = []
  let reads = 0
  const ctx = {
    get: (name: string) => (name === 'workspaces' ? workspaces : undefined),
    remote: {
      session: {
        harnessCatalog: () => {
          reads += 1
          return new Promise<Answer>((resolve) => { pending.push(resolve) })
        },
      },
    },
    sessions: {
      stageHarness: (harness: HarnessId) => { stages.push(harness) },
      harnessProvisional: (sessionId: string) => bindable.has(sessionId),
      bindHarness: async (sessionId: string, harness: HarnessId) => {
        bindings.push([sessionId, harness])
        bindable.delete(sessionId)
        return rebinding ?? sessionId
      },
    },
  } as unknown as Context
  const controller = new AgentHarnessSeatController(ctx)
  return {
    controller,
    stages,
    bindings,
    bindable,
    rebindTo: (sessionId: string) => { rebinding = sessionId },
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

describe('a Session the Workspace flow already published', () => {
  it('binds the pick to the provisional Session instead of staging it', async () => {
    const b = bench()
    await b.answer({ ok: true, value: CATALOG })
    b.stages.length = 0
    b.bindable.add('session-1')

    await b.controller.apply(SessionId('session-1'), hid('codex'))

    // The Session records the choice, so the create that follows carries it and
    // the stage is not what the binding rides on.
    expect(b.bindings).toEqual([['session-1', 'codex']])
    expect(b.stages).toEqual(['codex'])
    expect(b.controller.store.getSnapshot().current).toBe('codex')
  })

  it('stages the pick for the next Session once the window has closed', async () => {
    const b = bench()
    await b.answer({ ok: true, value: CATALOG })
    b.stages.length = 0

    await b.controller.apply(SessionId('session-1'), hid('codex'))

    expect(b.bindings).toEqual([])
    expect(b.stages).toEqual(['codex'])
  })

  it('hands the replacement back so the shell can follow it', async () => {
    const b = bench()
    await b.answer({ ok: true, value: CATALOG })
    b.bindable.add('session-1')
    b.rebindTo('session-2')

    // A pick on a Session that already records a harness moves the choice to a
    // replacement, and the caller needs that identity to show it.
    await expect(b.controller.apply(SessionId('session-1'), hid('codex'))).resolves.toBe('session-2')
  })

  it('answers whether a Session is still provisional', async () => {
    const b = bench()
    b.bindable.add('session-1')

    expect(b.controller.bindable(SessionId('session-1'))).toBe(true)
    expect(b.controller.bindable(SessionId('session-2'))).toBe(false)
    expect(b.controller.bindable(undefined)).toBe(false)
  })
})

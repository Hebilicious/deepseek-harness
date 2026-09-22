/**
 * Registration: the new-session harness chip comes from one apply, waits for
 * the ui-conversation declaration that authorizes it, reads the mounted
 * catalog before it can render, and stages a choice the next create request
 * carries. Disposal removes the contribution with its fiber.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { HarnessId } from '@deepseek-ai/dsh-agent/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionHarnessCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { AgentHarnessSeat } from '../src/client/AgentHarnessSeat.tsx'
import { HarnessBadgeSeat } from '../src/client/HarnessBadgeSeat.tsx'
import type { AgentHarnessSeatInjected } from '../src/client/AgentHarnessSeat.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

const hid = (value: string): HarnessId => value as HarnessId

const CATALOG: SessionHarnessCatalog = {
  harnesses: [
    { id: hid('dsh'), name: 'DeepSeek Harness', description: 'The in-process agent loop.' },
    { id: hid('codex'), name: 'Codex', description: 'Runs the Codex CLI.' },
  ],
}

const SINGLE: SessionHarnessCatalog = { harnesses: [{ id: hid('dsh'), name: 'DeepSeek Harness' }] }

/** A root frame declaring both seats this plugin waits for. */
function declareConversation(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.hero.agentHarness': { kind: 'single', scope: 'session-maybe' },
      'conversation.session.header.harness': { kind: 'single', scope: 'session' },
    },
  } as never, () => null)
}

async function bench(catalog: SessionHarnessCatalog = CATALOG) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const stages: HarnessId[] = []
  let reads = 0
  let answer: RemoteResult<SessionHarnessCatalog> = { ok: true, value: catalog }
  let rejects = false
  ctx.provide('sessions', {
    stageHarness: (harness: HarnessId) => { stages.push(harness) },
  } as never)
  new TestRemote(ctx, {
    session: {
      harnessCatalog: () => {
        reads += 1
        return rejects
          ? Promise.reject(new Error('wire unavailable'))
          : Promise.resolve(answer)
      },
    },
  })
  const slots = ctx.get('slots') as SlotRegistry
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx,
    slots,
    stages,
    reads: (): number => reads,
    setCatalog: (value: SessionHarnessCatalog) => { answer = { ok: true, value } },
    failCatalog: () => {
      answer = {
        ok: false,
        error: new RemoteError('gateway/internal', 'catalog unavailable', {}),
      }
    },
    rejectCatalog: () => { rejects = true },
    fiber,
  }
}

/** The chip's injected face, as the renderer would resolve it. */
function seatFace(slots: SlotRegistry): AgentHarnessSeatInjected {
  const entry = slots.entries('conversation.hero.agentHarness')[0]
  if (entry === undefined) throw new Error('the chip is not registered')
  return (entry.inject as unknown as () => AgentHarnessSeatInjected)()
}

describe('ui-agent-harness apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'sessions', 'locale', 'remote', 'remote.session'])
  })

  it('registers the chip and the header mark only while the conversation declares those seats', async () => {
    const b = await bench()

    // A bare register into an undeclared slot is an error, so each surface
    // waits on the actual declaration instead of on apply order.
    expect(b.slots.entries('conversation.hero.agentHarness')).toHaveLength(0)
    expect(b.slots.entries('conversation.session.header.harness')).toHaveLength(0)

    const dispose = declareConversation(b.slots)
    expect(b.slots.entries('conversation.hero.agentHarness')[0]!.component).toBe(AgentHarnessSeat)
    expect(b.slots.entries('conversation.session.header.harness')[0]!.component).toBe(HarnessBadgeSeat)

    dispose()
    expect(b.slots.entries('conversation.hero.agentHarness')).toHaveLength(0)
    expect(b.slots.entries('conversation.session.header.harness')).toHaveLength(0)
  })

  it('gives the header mark the same catalog and staging face as the chip', async () => {
    const b = await bench()
    declareConversation(b.slots)

    const entry = b.slots.entries('conversation.session.header.harness')[0]
    if (entry === undefined) throw new Error('the header mark is not registered')
    const injectFace = entry.inject
    if (injectFace === undefined) throw new Error('the header mark declares no injection face')
    const injected = injectFace() as { hooks: unknown; load: () => Promise<void> }
    expect(injected.hooks).toBeDefined()

    await injected.load()
    expect(b.reads()).toBeGreaterThan(0)
  })

  it('removes the chip with its fiber', async () => {
    const b = await bench()
    declareConversation(b.slots)

    await b.fiber.dispose()

    expect(b.slots.entries('conversation.hero.agentHarness')).toHaveLength(0)
  })

  it('reads the mounted catalog before the chip can render', async () => {
    const b = await bench()

    // A New Session started anywhere in the shell still creates its Session
    // through this client, so the staged harness must exist before the chip.
    await vi.waitFor(() => { expect(b.reads()).toBe(1) })
    expect(b.stages).toEqual(['dsh'])
  })

  it('serves the chip its catalog snapshot and stages a pick', async () => {
    const b = await bench()
    declareConversation(b.slots)
    await vi.waitFor(() => { expect(b.reads()).toBe(1) })

    const face = seatFace(b.slots)
    expect(face.hooks.agentHarnessSeat.getSnapshot().harnesses).toHaveLength(2)
    face.select(hid('codex'))

    expect(b.stages).toEqual(['dsh', 'codex'])
    expect(face.hooks.agentHarnessSeat.getSnapshot().current).toBe('codex')
  })

  it('reloads the catalog through the chip and on reconnect', async () => {
    const b = await bench()
    declareConversation(b.slots)
    await vi.waitFor(() => { expect(b.reads()).toBe(1) })

    const face = seatFace(b.slots)
    await face.load()
    expect(b.reads()).toBe(2)

    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.reads()).toBe(3) })
  })

  it('stages nothing while the deployment mounts one harness', async () => {
    const b = await bench(SINGLE)
    declareConversation(b.slots)
    await vi.waitFor(() => { expect(b.reads()).toBe(1) })

    const face = seatFace(b.slots)

    expect(face.hooks.agentHarnessSeat.getSnapshot().harnesses).toHaveLength(1)
    expect(b.stages).toEqual([])
  })

  it('stages nothing when the catalog read fails', async () => {
    const b = await bench()
    b.stages.length = 0
    b.failCatalog()

    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.reads()).toBe(2) })

    expect(b.stages).toEqual([])
  })

  it('keeps the shell running when the catalog call itself rejects', async () => {
    const b = await bench()
    b.stages.length = 0
    b.rejectCatalog()

    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.reads()).toBe(2) })

    expect(b.stages).toEqual([])
    expect(b.slots.entries('conversation.hero.agentHarness')).toHaveLength(0)
  })

  it('follows the deployment when it mounts a second harness', async () => {
    const b = await bench(SINGLE)
    declareConversation(b.slots)
    await vi.waitFor(() => { expect(b.stages).toEqual([]) })

    b.setCatalog(CATALOG)
    await seatFace(b.slots).load()

    expect(b.stages).toEqual(['dsh'])
  })
})

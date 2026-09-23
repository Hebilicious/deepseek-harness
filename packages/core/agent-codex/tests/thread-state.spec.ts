/**
 * Unit tests for the durable Codex thread-binding fold: the projection that
 * records which app-server thread a session owns, including the rebind a
 * resume performs when the recorded thread has no rollout left, and the read
 * helper the driver and its tests use.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { codexThreadOf, codexThreadProjection } from '../src/thread-state.ts'

/** The projection's fold, destructured so the call is not read as `Function.apply`. */
const fold = codexThreadProjection.apply

/** One durable binding event, as the driver appends it. */
function binding(threadId: string, seq: number): SessionEvent<'agent-codex/thread'> {
  return { type: 'agent-codex/thread', seq: SessionSeq(seq), time: 0, data: { threadId } }
}

/** One event the projection does not own; the fold must return it unchanged. */
const foreignEvent = { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 1 } } as SessionEvent

describe('codexThreadProjection', () => {
  it('starts with no bound thread', () => {
    expect(codexThreadProjection.init()).toBeNull()
  })

  it('returns the same state for an event it does not own', () => {
    const state = { threadId: 'thread-1' }
    expect(codexThreadProjection.apply(state, foreignEvent)).toBe(state)
  })

  it('folds the bound thread id', () => {
    expect(fold(null, binding('thread-1', 3))).toEqual({ threadId: 'thread-1' })
  })

  it('replaces the binding when a later event rebinds the session', () => {
    const rebound = fold({ threadId: 'thread-1' }, binding('thread-2', 9))
    expect(rebound).toEqual({ threadId: 'thread-2' })
  })

  it.each([
    ['a non-string thread id', { threadId: 7 }],
    ['an empty thread id', { threadId: '' }],
  ])('refuses %s', (_label, data) => {
    const event = { type: 'agent-codex/thread', seq: SessionSeq(4), time: 0, data } as SessionEvent
    expect(() => fold(null, event))
      .toThrow('invalid agent-codex/thread at seq 4')
  })
})

describe('codexThreadOf', () => {
  it('reads the folded thread id', () => {
    const projections = {
      stateOf: () => ({ threadId: 'thread-1' }),
    } as unknown as Pick<SessionProjectionRegistry, 'stateOf'>
    expect(codexThreadOf(projections, {} as never)).toBe('thread-1')
  })

  it('answers undefined before any binding', () => {
    const projections = { stateOf: () => null } as unknown as Pick<SessionProjectionRegistry, 'stateOf'>
    expect(codexThreadOf(projections, {} as never)).toBeUndefined()
  })
})

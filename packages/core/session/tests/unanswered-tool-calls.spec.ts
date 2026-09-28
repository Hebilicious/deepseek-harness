/**
 * Derived history drops assistant tool calls that no tool message answers and
 * no open step can answer later: every provider protocol requires a call to
 * carry its result before the next assistant message, so such a call would make the
 * session unusable there. The durable log keeps the call the human transcript
 * shows, and a call whose step is still open stays visible until its result
 * lands.
 */

import { describe, expect, it } from 'vitest'
import {
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'

function assistantCall(session: Session, text: string | undefined, callIds: string[], turn = 1, step = 1): void {
  session.append('assistant/message', {
    stream: [],
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [
        ...text === undefined ? [] : [{ type: 'text' as const, text }],
        ...callIds.map(id => ({ type: 'tool-call' as const, id: ToolCallId(id), name: 'read', arguments: '{}' })),
      ],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
}

function userText(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function toolResult(session: Session, callId: string, turn = 1, step = 1): void {
  session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
}

/** Run one closed step, the shape a failed step leaves in the durable log. */
function closedStep(session: Session, turn: number, step: number, body: () => void): void {
  session.append('step/start', { turn, step })
  body()
  session.append('step/end', { turn, step })
}

/** Run one step and leave it open, the shape a step has while its calls run. */
function openStep(session: Session, turn: number, step: number, body: () => void): void {
  session.append('step/start', { turn, step })
  body()
}

describe('derived history without unanswerable tool calls', () => {
  it('drops a call whose closed step never answered it and keeps the rest of its message', () => {
    const session = Session.create(SessionId('unanswerable-call'))
    session.append('turn/start', { turn: 1 })
    userText(session, 'go')
    closedStep(session, 1, 1, () => { assistantCall(session, 'working', ['a']) })
    userText(session, 'stop')

    const messages = session.deriveMessages()
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'working' }])
    expect([...session.unanswerableToolCalls()]).toEqual([ToolCallId('a')])
    // The durable log still records the call the human transcript shows.
    expect(session.snapshotEvents().some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'tool-call'))).toBe(true)
  })

  it('keeps a call whose step is still open', () => {
    const session = Session.create(SessionId('pending-call'))
    session.append('turn/start', { turn: 1 })
    openStep(session, 1, 1, () => {
      userText(session, 'go')
      assistantCall(session, 'working', ['a'])
    })

    expect([...session.unanswerableToolCalls()]).toEqual([])
    expect(session.deriveMessages()[1]?.content).toEqual([
      { type: 'text', text: 'working' },
      { type: 'tool-call', id: ToolCallId('a'), name: 'read', arguments: '{}' },
    ])

    // Closing the step without a result makes the call unanswerable.
    session.append('step/end', { turn: 1, step: 1 })
    expect([...session.unanswerableToolCalls()]).toEqual([ToolCallId('a')])
    expect(session.deriveMessages()[1]?.content).toEqual([{ type: 'text', text: 'working' }])
  })

  it('keeps a call recorded before the step still running', () => {
    const session = Session.create(SessionId('earlier-step-call'))
    session.append('turn/start', { turn: 1 })
    closedStep(session, 1, 1, () => { assistantCall(session, undefined, ['lost']) })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } } })
    session.append('turn/start', { turn: 2 })
    openStep(session, 2, 1, () => { assistantCall(session, undefined, ['running']) })

    // The closed step can never answer its call; the open one still will.
    expect([...session.unanswerableToolCalls()]).toEqual([ToolCallId('lost')])
  })

  it('drops a message whose only content was the unanswerable call', () => {
    const session = Session.create(SessionId('unanswerable-only-call'))
    session.append('turn/start', { turn: 1 })
    closedStep(session, 1, 1, () => {
      userText(session, 'go')
      assistantCall(session, undefined, ['a'])
    })
    userText(session, 'stop')

    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'user'])
  })

  it('drops a call the next assistant turn never answers', () => {
    const session = Session.create(SessionId('unanswered-before-assistant'))
    session.append('turn/start', { turn: 1 })
    closedStep(session, 1, 1, () => {
      userText(session, 'go')
      assistantCall(session, undefined, ['a'])
    })
    closedStep(session, 1, 2, () => { assistantCall(session, 'answered nothing', []) })

    const messages = session.deriveMessages()
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'answered nothing' }])
  })

  it('keeps a call answered by the tool message that follows it', () => {
    const session = Session.create(SessionId('answered-call'))
    session.append('turn/start', { turn: 1 })
    closedStep(session, 1, 1, () => {
      userText(session, 'go')
      assistantCall(session, undefined, ['a'])
      toolResult(session, 'a')
    })
    userText(session, 'continue')

    const messages = session.deriveMessages()
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(messages[1]?.content).toEqual([{ type: 'tool-call', id: ToolCallId('a'), name: 'read', arguments: '{}' }])
  })

  it('leaves a result whose call a surface replacement removed untouched', () => {
    const session = Session.create(SessionId('orphan-result'))
    session.append('turn/start', { turn: 1 })
    closedStep(session, 1, 1, () => {
      userText(session, 'go')
      assistantCall(session, undefined, ['a'])
      toolResult(session, 'a')
    })
    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'assistant', 'tool'])

    const nodes = session.surface.nodes
    // A checkpoint shadows the call; the result node keeps its own place.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: nodes[1]!, endSeq: nodes[1]! }, sourceEventSeqs: [nodes[1]!] })

    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'user', 'tool'])
  })

  it('shares one projection across calls and rebuilds it when the step closes', () => {
    const session = Session.create(SessionId('shared-projection'))
    session.append('turn/start', { turn: 1 })
    openStep(session, 1, 1, () => {
      userText(session, 'go')
      assistantCall(session, 'working', ['a'])
    })

    const first = session.deriveMessages()
    const second = session.deriveMessages()
    expect(second).not.toBe(first)
    expect(second[1]).toBe(first[1])
    expect(Object.isFrozen(first[1])).toBe(true)

    session.append('step/end', { turn: 1, step: 1 })
    const repaired = session.deriveMessages()
    expect(repaired[1]).not.toBe(first[1])
    expect(repaired[1]?.content).toEqual([{ type: 'text', text: 'working' }])
    // The projection is reused while the unanswerable set is unchanged.
    const repeated = session.deriveMessages()
    expect(repeated).not.toBe(repaired)
    expect(repeated[1]).toBe(repaired[1])
  })

  it('ignores unanswerable calls in a detached replay of the same log', () => {
    const session = Session.create(SessionId('detached-replay'))
    session.append('turn/start', { turn: 1 })
    closedStep(session, 1, 1, () => {
      userText(session, 'go')
      assistantCall(session, undefined, ['a'])
    })
    userText(session, 'stop')
    const replayed = Session.create(SessionId('detached-replay-copy'), session.snapshotEvents())
    expect(replayed.deriveMessages()).toEqual(session.deriveMessages())
  })
})

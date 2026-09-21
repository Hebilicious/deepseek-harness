/**
 * Derived history drops assistant tool calls no user turn answers: every
 * provider protocol requires a call to carry its result in the user turn that
 * follows, so an unanswered call would make the session unusable there. The
 * durable log keeps the call the human transcript shows.
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

describe('derived history without unanswered tool calls', () => {
  it('drops an unanswered call and keeps the rest of its message', () => {
    const session = Session.create(SessionId('unanswered-call'))
    session.append('turn/start', { turn: 1 })
    userText(session, 'go')
    assistantCall(session, 'working', ['a'])
    userText(session, 'stop')

    const messages = session.deriveMessages()
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'working' }])
    // The durable log still records the call the human transcript shows.
    expect(session.snapshotEvents().some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'tool-call'))).toBe(true)
  })

  it('drops a message whose only content was the unanswered call', () => {
    const session = Session.create(SessionId('unanswered-only-call'))
    session.append('turn/start', { turn: 1 })
    userText(session, 'go')
    assistantCall(session, undefined, ['a'])
    userText(session, 'stop')

    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'user'])
  })

  it('drops a call the next assistant turn never answers', () => {
    const session = Session.create(SessionId('unanswered-before-assistant'))
    session.append('turn/start', { turn: 1 })
    userText(session, 'go')
    assistantCall(session, undefined, ['a'])
    assistantCall(session, 'answered nothing', [])

    const messages = session.deriveMessages()
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'answered nothing' }])
  })

  it('keeps a call answered by the user turn that follows it', () => {
    const session = Session.create(SessionId('answered-call'))
    session.append('turn/start', { turn: 1 })
    userText(session, 'go')
    assistantCall(session, undefined, ['a'])
    toolResult(session, 'a')
    userText(session, 'continue')

    const messages = session.deriveMessages()
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'user'])
    expect(messages[1]?.content).toEqual([{ type: 'tool-call', id: ToolCallId('a'), name: 'read', arguments: '{}' }])
  })

  it('restores a dropped call once its result arrives in a later user turn', () => {
    const session = Session.create(SessionId('late-result'))
    session.append('turn/start', { turn: 1 })
    userText(session, 'go')
    assistantCall(session, undefined, ['a'])
    userText(session, 'interrupted')
    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'user'])

    toolResult(session, 'a')
    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'assistant', 'user', 'user'])
  })

  it('leaves a result whose call a surface replacement removed untouched', () => {
    const session = Session.create(SessionId('orphan-result'))
    session.append('turn/start', { turn: 1 })
    userText(session, 'go')
    assistantCall(session, undefined, ['a'])
    toolResult(session, 'a')
    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'assistant', 'user'])

    const nodes = session.surface.nodes
    // A checkpoint shadows the call; the result node keeps its own place.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', startSeq: nodes[1]!, endSeq: nodes[1]! }, sourceEventSeqs: [nodes[1]!] })

    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'user', 'user'])
  })

  it('shares one projection across calls and rebuilds it when the answer arrives', () => {
    const session = Session.create(SessionId('shared-projection'))
    session.append('turn/start', { turn: 1 })
    userText(session, 'go')
    assistantCall(session, 'working', ['a'])
    userText(session, 'stop')

    const first = session.deriveMessages()
    const second = session.deriveMessages()
    expect(second).not.toBe(first)
    expect(second[1]).toBe(first[1])
    expect(Object.isFrozen(first[1])).toBe(true)

    toolResult(session, 'a')
    const repaired = session.deriveMessages()
    expect(repaired[1]).not.toBe(first[1])
    expect(repaired[1]?.content).toEqual([
      { type: 'text', text: 'working' },
      { type: 'tool-call', id: ToolCallId('a'), name: 'read', arguments: '{}' },
    ])
  })

  it('ignores unanswered calls in a detached replay of the same log', () => {
    const session = Session.create(SessionId('detached-replay'))
    session.append('turn/start', { turn: 1 })
    userText(session, 'go')
    assistantCall(session, undefined, ['a'])
    userText(session, 'stop')
    const replayed = Session.create(SessionId('detached-replay-copy'), session.snapshotEvents())
    expect(replayed.deriveMessages()).toEqual(session.deriveMessages())
  })
})

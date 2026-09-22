/**
 * Unit tests for the shared Codex app-server protocol vocabulary: the wire
 * validators every caller uses at the frame boundary, the terminal-turn
 * failure classifier's complete `codexErrorInfo` vocabulary, and the soft
 * thread-id reader the router routes on.
 */

import { describe, expect, it } from 'vitest'
import {
  codexObject,
  CodexRequestRefused,
  codexString,
  codexThreadIdOf,
  codexTurnFailureInfo,
  type JsonObject,
} from '../src/protocol.ts'

describe('wire validators', () => {
  it('returns the plain object it was given', () => {
    const record: JsonObject = { threadId: 'thread-1' }
    expect(codexObject(record, 'thread/start response', 'agent-codex')).toBe(record)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['a string', 'x'],
    ['an array', []],
    ['a boolean', true],
  ])('rejects %s as an object', (_label, value) => {
    expect(() => codexObject(value, 'thread/start response', 'agent-codex'))
      .toThrow('agent-codex: app-server returned invalid thread/start response')
  })

  it('returns a non-empty string and rejects every other form', () => {
    expect(codexString('thread-1', 'thread id', 'agent-codex')).toBe('thread-1')
    for (const value of [undefined, null, 1, '', [], {}]) {
      expect(() => codexString(value, 'thread id', 'agent-codex'))
        .toThrow('agent-codex: app-server returned invalid thread id')
    }
  })

  it('reads a thread id only from a non-empty string member', () => {
    expect(codexThreadIdOf({ threadId: 'thread-1' })).toBe('thread-1')
    expect(codexThreadIdOf({ threadId: '' })).toBeUndefined()
    expect(codexThreadIdOf({ threadId: 7 })).toBeUndefined()
    expect(codexThreadIdOf({})).toBeUndefined()
  })

  it('names a request-scoped refusal in its own error type', () => {
    const refusal = new CodexRequestRefused('agent-codex: no such method')
    expect(refusal).toBeInstanceOf(Error)
    expect(refusal.name).toBe('CodexRequestRefused')
  })
})

describe('terminal-turn failure classification', () => {
  it.each([
    ['a non-terminal status', { status: 'completed' }],
    ['a failed turn without an error member', { status: 'failed' }],
    ['a failed turn whose error is null', { status: 'failed', error: null }],
    ['a failed turn whose error is an array', { status: 'failed', error: [] }],
    ['a failed turn whose error is a string', { status: 'failed', error: 'boom' }],
    ['a failed turn without codexErrorInfo', { status: 'failed', error: { message: 'boom' } }],
    ['an unrecognized codexErrorInfo string', { status: 'failed', error: { codexErrorInfo: 'brandNewFailure' } }],
    ['a null codexErrorInfo', { status: 'failed', error: { codexErrorInfo: null } }],
    ['a numeric codexErrorInfo', { status: 'failed', error: { codexErrorInfo: 7 } }],
    ['an array codexErrorInfo', { status: 'failed', error: { codexErrorInfo: [] } }],
  ])('classifies %s as unknown', (_label, turn) => {
    expect(codexTurnFailureInfo(turn)).toEqual({ category: 'unknown' })
  })

  it.each([
    ['contextWindowExceeded', { category: 'limit', maxTokens: true }],
    ['sessionBudgetExceeded', { category: 'limit' }],
    ['usageLimitExceeded', { category: 'limit' }],
    ['serverOverloaded', { category: 'service' }],
    ['internalServerError', { category: 'service' }],
    ['cyberPolicy', { category: 'access-policy' }],
    ['misalignmentPolicyViolation', { category: 'access-policy' }],
    ['unauthorized', { category: 'access-policy' }],
    ['badRequest', { category: 'product-error' }],
    ['threadRollbackFailed', { category: 'product-error' }],
    ['other', { category: 'product-error' }],
    ['sandboxError', { category: 'access-policy', sandboxFailure: true }],
  ])('classifies the %s member form', (codexErrorInfo, expected) => {
    expect(codexTurnFailureInfo({ status: 'failed', error: { codexErrorInfo } })).toEqual(expected)
  })

  it.each([
    ['httpConnectionFailed', { httpStatusCode: 502 }, { category: 'transport', httpStatus: 502 }],
    ['httpConnectionFailed', {}, { category: 'transport' }],
    ['responseStreamConnectionFailed', { httpStatusCode: 0 }, { category: 'transport', httpStatus: 0 }],
    ['responseStreamDisconnected', { httpStatusCode: 65_535 }, { category: 'transport', httpStatus: 65_535 }],
    ['responseTooManyFailedAttempts', { httpStatusCode: -1 }, { category: 'transport' }],
    ['responseTooManyFailedAttempts', { httpStatusCode: 65_536 }, { category: 'transport' }],
    ['responseTooManyFailedAttempts', { httpStatusCode: 1.5 }, { category: 'transport' }],
    ['responseTooManyFailedAttempts', { httpStatusCode: '500' }, { category: 'transport' }],
    ['activeTurnNotSteerable', {}, { category: 'product-error' }],
    ['someFutureFailure', { httpStatusCode: 500 }, { category: 'unknown' }],
  ])('classifies the %s member form with %o', (member, detail, expected) => {
    expect(codexTurnFailureInfo({ status: 'failed', error: { codexErrorInfo: { [member]: detail } } }))
      .toEqual(expected)
  })

  it.each([
    ['an empty object', {}],
    ['a member whose detail is not an object', { activeTurnNotSteerable: 'not steerable' }],
    ['two members', { activeTurnNotSteerable: {}, badRequest: {} }],
  ])('classifies %s as unknown', (_label, codexErrorInfo) => {
    expect(codexTurnFailureInfo({ status: 'failed', error: { codexErrorInfo } })).toEqual({ category: 'unknown' })
  })
})

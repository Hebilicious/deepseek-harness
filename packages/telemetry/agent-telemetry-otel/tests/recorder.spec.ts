import { afterEach, describe, expect, it } from 'vitest'
import { SpanStatusCode } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace'
import type { OTelEventRecord } from '@deepseek-ai/dsh-otel'
import { SessionId, SessionSeq, type SessionEvent, type SessionEventMap, type SessionEventType } from '@deepseek-ai/dsh-session'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import { AgentActivityRecorder, type ObservedSession } from '../src/recorder.ts'

const providers: TracerProvider[] = []
afterEach(async () => { for (const provider of providers.splice(0)) await provider.shutdown() })

function harness(sinks: { events?: boolean; spans?: boolean } = { events: true, spans: true }) {
  const records: OTelEventRecord[] = []
  const exporter = new InMemorySpanExporter()
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
  providers.push(provider)
  const recorder = new AgentActivityRecorder({
    ...sinks.events === true ? { events: { emit: (record: OTelEventRecord) => { records.push(record) } } } : {},
    ...sinks.spans === true ? { tracer: provider.getTracer('test') } : {},
  })
  const byName = (name: string) => records.filter(record => record.eventName === name).map(record => record.attributes)
  const spans = (name: string): ReadableSpan[] => exporter.getFinishedSpans().filter(span => span.name === name)
  return { recorder, records, byName, spans }
}

function session(id: string, header: ObservedSession['header'] = {}, firstLiveSeq = 0): ObservedSession & { next: number; time: number } {
  return { id: SessionId(id), header, firstLiveSeq, next: firstLiveSeq, time: 1_800_000_000_000 }
}

/** Append-ordered synthetic event: sequence numbers increase by one and time by 10 ms. */
function event<K extends SessionEventType>(owner: { next: number; time: number }, type: K, data: SessionEventMap[K]): SessionEvent {
  owner.time += 10
  return { type, seq: SessionSeq(owner.next++), time: owner.time, data, surfaceOp: 'append' } as SessionEvent
}

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 5, reasoningTokens: 7 }
const message = (text: string, model = 'model-a') => ({ id: MessageId('m'), role: 'assistant' as const, content: [{ type: 'text' as const, text }],
  source: { kind: 'model' as const, provider: 'test-provider', model } })
const header = (model: string) => ({ header: { config: { provider: 'test-provider', model } }, reason: 'initial' as const })
const toolResult = (callId: string, isError?: true) => ({ id: MessageId('r'), role: 'tool' as const, content: [{ type: 'text' as const, text: 'secret output' }],
  source: { kind: 'tool' as const, callId: ToolCallId(callId) }, toolCallId: ToolCallId(callId), ...isError && { isError } })

describe('agent activity records', () => {
  it('reports a turn with a model request, an approved MCP tool, a failed tool, and token totals', () => {
    const { recorder, records, byName, spans } = harness()
    const s = session('session-a')
    const feed = <K extends SessionEventType>(type: K, data: SessionEventMap[K]) => { recorder.observe(s, event(s, type, data)) }
    feed('turn/start', { turn: 1 })
    feed('step/start', { turn: 1, step: 1 })
    feed('request/header', header('model-a') as SessionEventMap['request/header'])
    feed('user/message', { id: MessageId('u'), role: 'user', content: [{ type: 'text', text: 'secret prompt' }, { type: 'reasoning', text: 'secret' }],
      source: { kind: 'user' } })
    feed('user/message', { id: MessageId('i'), role: 'user', content: [{ type: 'text', text: 'injected' }],
      source: { kind: 'system-prompt' } })
    feed('assistant/message', { turn: 1, step: 1, message: message('reply'), stream: [], usage })
    feed('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'mcp__aircon__set_power', arguments: '{"secret":true}' })
    feed('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-2'), name: 'bash', arguments: '{"command":"secret"}' })
    feed('approval/asked', { id: ApprovalRequestId('approval-1'), toolName: 'mcp__aircon__set_power', callId: ToolCallId('call-1'), reason: 'secret reason' })
    feed('approval/decided', { id: ApprovalRequestId('approval-1'), outcome: 'allowed-once' })
    feed('tool/result', { turn: 1, step: 1, message: toolResult('call-1') })
    feed('tool/result', { turn: 1, step: 1, message: toolResult('call-2', true), error: { name: 'Timeout', code: 'TIMEOUT', reason: 'secret' } })
    feed('step/end', { turn: 1, step: 1 })
    feed('step/start', { turn: 1, step: 2 })
    feed('assistant/message', { turn: 1, step: 2, message: message('done'), stream: [], usage: { inputTokens: 3, outputTokens: 4 } })
    feed('step/end', { turn: 1, step: 2 })
    feed('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(records.map(record => record.eventName)).toEqual(['dsh.session_start', 'dsh.user_prompt', 'dsh.api_request', 'dsh.tool_decision',
      'dsh.tool_result', 'dsh.tool_result', 'dsh.api_request', 'dsh.turn_end'])
    expect(JSON.stringify(records)).not.toContain('secret')
    expect(byName('dsh.session_start')).toEqual([expect.objectContaining({ 'session.id': 'session-a', resumed: false })])
    expect(byName('dsh.user_prompt')).toEqual([expect.objectContaining({ prompt_length: 13, 'prompt.id': 'session-a:1', turn: 1, step: 1 })])
    expect(byName('dsh.api_request')[0]).toEqual(expect.objectContaining({ provider: 'test-provider', model: 'model-a', duration_ms: 40, attempt: 1,
      input_tokens: 100, output_tokens: 20, cache_read_tokens: 900, cache_creation_tokens: 5, reasoning_tokens: 7 }))
    expect(byName('dsh.api_request')[1]).not.toHaveProperty('cache_read_tokens')
    expect(byName('dsh.tool_decision')).toEqual([expect.objectContaining({ tool_name: 'mcp__aircon__set_power', mcp_server_name: 'aircon',
      mcp_tool_name: 'set_power', call_id: 'call-1', decision: 'allowed-once', source: 'approval' })])
    expect(byName('dsh.tool_result')).toEqual([
      expect.objectContaining({ tool_name: 'mcp__aircon__set_power', success: true, decision: 'allowed-once', duration_ms: 40 }),
      expect.objectContaining({ tool_name: 'bash', success: false, error_code: 'TIMEOUT', duration_ms: 40 }),
    ])
    expect(byName('dsh.turn_end')).toEqual([expect.objectContaining({ outcome: 'completed', steps: 2, tool_calls: 2, tool_failures: 1,
      input_tokens: 103, output_tokens: 24, cache_read_tokens: 900, cache_creation_tokens: 5, duration_ms: 160 })])

    const [turn] = spans('dsh.turn')
    expect(turn?.attributes).toEqual(expect.objectContaining({ outcome: 'completed', 'prompt.id': 'session-a:1' }))
    const children = [...spans('dsh.llm_request'), ...spans('dsh.tool')]
    expect(children).toHaveLength(4)
    for (const child of children) expect(child.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId)
    expect(spans('dsh.tool')[0]?.events.map(item => item.name)).toEqual(['dsh.tool_decision'])
    expect(spans('dsh.tool')[1]?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'TIMEOUT' })
    const toolRecord = records.find(record => record.eventName === 'dsh.tool_result')
    expect(toolRecord?.spanContext?.spanId).toBe(spans('dsh.tool')[0]?.spanContext().spanId)
  })

  it('reports retries, an uncommitted final attempt, and the failing turn', () => {
    const { recorder, byName, spans } = harness()
    const s = session('session-b')
    const feed = <K extends SessionEventType>(type: K, data: SessionEventMap[K]) => { recorder.observe(s, event(s, type, data)) }
    feed('request/header', header('model-b') as SessionEventMap['request/header'])
    feed('turn/start', { turn: 2 })
    feed('step/start', { turn: 2, step: 1 })
    feed('assistant/attempt', { turn: 2, step: 1, stream: [] })
    feed('llm/retry', { retryId: RetryId('r1'), turn: 2, step: 1, provider: 'test-provider', mode: 'normal', policyKey: 'p', retry: 1, maxRetries: 3,
      delayMs: 5, failure: { message: 'secret', code: 'RATE_LIMIT', status: 429 } })
    feed('llm/retry-started', { retryId: RetryId('r1'), turn: 2, step: 1, retry: 1 })
    feed('assistant/attempt', { turn: 2, step: 1, stream: [] })
    feed('llm/retry', { retryId: RetryId('r2'), turn: 2, step: 1, provider: 'test-provider', mode: 'always', policyKey: 'p', retry: 2,
      delayMs: 5, failure: { message: 'secret', code: 'SERVER' } })
    feed('llm/retry-started', { retryId: RetryId('r2'), turn: 2, step: 1, retry: 2 })
    feed('assistant/attempt', { turn: 2, step: 1, stream: [] })
    feed('step/end', { turn: 2, step: 1 })
    feed('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'secret', code: 'AUTH', status: 401 } } })

    expect(byName('dsh.api_error')).toEqual([
      expect.objectContaining({ error_code: 'RATE_LIMIT', status_code: 429, attempt: 1, model: 'model-b', duration_ms: 20 }),
      expect.objectContaining({ error_code: 'SERVER', attempt: 2, duration_ms: 20 }),
      expect.objectContaining({ error_code: 'AUTH', status_code: 401, attempt: 3 }),
    ])
    expect(byName('dsh.api_error')[1]).not.toHaveProperty('status_code')
    expect(byName('dsh.turn_end')).toEqual([expect.objectContaining({ outcome: 'error', error_code: 'AUTH', status_code: 401 })])
    expect(spans('dsh.turn')[0]?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'AUTH' })
    expect(spans('dsh.llm_request').map(span => [span.status.code, span.events.map(item => item.name)])).toEqual([
      [SpanStatusCode.ERROR, ['dsh.api_error']], [SpanStatusCode.ERROR, ['dsh.api_error']], [SpanStatusCode.ERROR, []]])
  })

  it('reports cancellation causes and errors without a failed attempt', () => {
    const { recorder, byName } = harness({ events: true })
    const s = session('session-c')
    const feed = <K extends SessionEventType>(type: K, data: SessionEventMap[K]) => { recorder.observe(s, event(s, type, data)) }
    feed('turn/start', { turn: 1 })
    feed('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    feed('turn/start', { turn: 2 })
    feed('step/start', { turn: 2, step: 1 })
    feed('assistant/attempt', { turn: 2, step: 1, stream: [] })
    feed('assistant/message', { turn: 2, step: 1, message: message('late'), stream: [], interrupted: true })
    feed('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'secret', code: 'UNKNOWN' } } })
    expect(byName('dsh.turn_end')).toEqual([
      expect.objectContaining({ outcome: 'aborted', cancel_cause: 'user' }),
      expect.objectContaining({ outcome: 'error', error_code: 'UNKNOWN' }),
    ])
    expect(byName('dsh.api_request')).toEqual([expect.objectContaining({ interrupted: true })])
    expect(byName('dsh.api_error')).toEqual([])
  })

  it('makes a subagent turn a child of the parent tool call that runs it', () => {
    const { recorder, byName, spans } = harness()
    const parent = session('parent')
    const child = session('child', { parentSession: SessionId('parent'), origin: 'subagent', delegationDepth: 1, agentPreset: 'researcher' })
    recorder.observe(parent, event(parent, 'turn/start', { turn: 1 }))
    recorder.observe(parent, event(parent, 'tool/call', { turn: 1, step: 1, callId: ToolCallId('delegate'), name: 'agent', arguments: '{}' }))
    recorder.observe(child, event(child, 'turn/start', { turn: 1 }))
    recorder.observe(child, event(child, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const orphan = session('orphan', { parentSession: SessionId('unknown') })
    recorder.observe(orphan, event(orphan, 'turn/start', { turn: 1 }))
    recorder.observe(orphan, event(orphan, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    recorder.observe(parent, event(parent, 'tool/result', { turn: 1, step: 1, message: toolResult('delegate') }))
    const turnBeforeTool = session('parent-2')
    const childOfTurn = session('child-2', { parentSession: SessionId('parent-2') })
    recorder.observe(turnBeforeTool, event(turnBeforeTool, 'turn/start', { turn: 1 }))
    recorder.observe(childOfTurn, event(childOfTurn, 'turn/start', { turn: 1 }))
    recorder.observe(childOfTurn, event(childOfTurn, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))

    const tool = spans('dsh.tool')[0]
    const turns = spans('dsh.turn')
    expect(turns.find(span => span.attributes['session.id'] === 'child')?.parentSpanContext?.spanId).toBe(tool?.spanContext().spanId)
    expect(turns.find(span => span.attributes['session.id'] === 'child')?.spanContext().traceId).toBe(tool?.spanContext().traceId)
    expect(turns.find(span => span.attributes['session.id'] === 'orphan')?.parentSpanContext).toBeUndefined()
    expect(turns.find(span => span.attributes['session.id'] === 'child-2')?.parentSpanContext).toBeDefined()
    expect(byName('dsh.session_start').find(attributes => attributes?.['session.id'] === 'child')).toEqual(expect.objectContaining({
      'parent_session.id': 'parent', 'session.origin': 'subagent', delegation_depth: 1, agent_preset: 'researcher' }))
  })

  it('ignores restored history and events that report no activity', () => {
    const { recorder, records } = harness()
    const s = session('restored', {}, 5)
    recorder.observe(s, { type: 'turn/start', seq: SessionSeq(2), time: 1, data: { turn: 1 } })
    expect(records).toEqual([])
    recorder.observe(s, event(s, 'session/end-seed', {}))
    expect(records.map(record => record.attributes?.resumed)).toEqual([true])
    recorder.observe(s, event(s, 'llm/retry-started', { retryId: RetryId('r'), turn: 1, step: 1, retry: 1 }))
    recorder.observe(s, event(s, 'llm/retry', { retryId: RetryId('r'), turn: 1, step: 1, provider: 'p', mode: 'always', policyKey: 'p', retry: 1,
      delayMs: 1, failure: { message: 'secret', code: 'SERVER' } }))
    recorder.observe(s, event(s, 'approval/decided', { id: ApprovalRequestId('unknown'), outcome: 'unavailable' }))
    recorder.observe(s, event(s, 'approval/asked', { id: ApprovalRequestId('no-call'), toolName: 'bash' }))
    recorder.observe(s, event(s, 'approval/decided', { id: ApprovalRequestId('no-call'), outcome: 'rejected' }))
    recorder.observe(s, event(s, 'tool/result', { turn: 1, step: 1, message: toolResult('unknown', true) }))
    recorder.observe(s, event(s, 'assistant/message', { turn: 1, step: 1, message: message('x'), stream: [] }))
    recorder.observe(s, event(s, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(records.map(record => [record.eventName, record.attributes])).toEqual([
      ['dsh.session_start', expect.anything()],
      ['dsh.api_error', expect.not.objectContaining({ duration_ms: expect.any(Number) as number })],
      ['dsh.tool_decision', expect.objectContaining({ decision: 'unavailable', source: 'approval' })],
      ['dsh.tool_decision', expect.objectContaining({ tool_name: 'bash', decision: 'rejected' })],
      ['dsh.tool_result', expect.objectContaining({ call_id: 'unknown', success: false, error_code: 'TOOL_ERROR' })],
      ['dsh.api_request', expect.not.objectContaining({ duration_ms: expect.any(Number) as number })],
    ])
  })

  it('tolerates model and tool events outside a turn and parents without open spans', () => {
    const { recorder, byName, spans } = harness()
    const parent = session('idle-parent')
    recorder.observe(parent, event(parent, 'turn/start', { turn: 1 }))
    recorder.observe(parent, event(parent, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const child = session('late-child', { parentSession: SessionId('idle-parent') })
    recorder.observe(child, event(child, 'step/start', { turn: 1, step: 1 }))
    recorder.observe(child, event(child, 'assistant/attempt', { turn: 1, step: 1, stream: [] }))
    recorder.observe(child, event(child, 'tool/call', { turn: 1, step: 1, callId: ToolCallId('c'), name: 'bash', arguments: '{}' }))
    recorder.observe(child, event(child, 'tool/result', { turn: 1, step: 1, message: toolResult('c') }))
    recorder.observe(child, event(child, 'step/end', { turn: 1, step: 1 }))
    recorder.observe(child, event(child, 'turn/start', { turn: 1 }))
    recorder.observe(child, event(child, 'assistant/attempt', { turn: 1, step: 1, stream: [] }))
    recorder.observe(child, event(child, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'secret', code: 'SERVER' } } }))
    expect(spans('dsh.tool')[0]?.parentSpanContext).toBeUndefined()
    expect(spans('dsh.turn').find(span => span.attributes['session.id'] === 'late-child')?.parentSpanContext).toBeUndefined()
    expect(byName('dsh.api_error')).toEqual([expect.objectContaining({ error_code: 'SERVER', attempt: 1 })])
  })

  it('ends open spans when a session closes or the recorder unloads, and sends nothing without sinks', () => {
    const { recorder, spans } = harness({ spans: true })
    const a = session('a')
    const b = session('b')
    for (const s of [a, b]) {
      recorder.observe(s, event(s, 'turn/start', { turn: 1 }))
      recorder.observe(s, event(s, 'step/start', { turn: 1, step: 1 }))
      recorder.observe(s, event(s, 'assistant/attempt', { turn: 1, step: 1, stream: [] }))
      recorder.observe(s, event(s, 'llm/retry', { retryId: RetryId('r'), turn: 1, step: 1, provider: 'p', mode: 'always', policyKey: 'p', retry: 1,
        delayMs: 1, failure: { message: 'secret', code: 'SERVER' } }))
      recorder.observe(s, event(s, 'tool/call', { turn: 1, step: 1, callId: ToolCallId('c'), name: 'bash', arguments: '{}' }))
    }
    recorder.close(a.id, a.time + 5)
    recorder.close(SessionId('never-seen'), 0)
    expect(spans('dsh.turn').map(span => span.attributes['session.id'])).toEqual(['a'])
    expect(spans('dsh.llm_request')[0]?.events.map(item => item.name)).toEqual(['dsh.api_error'])
    recorder.closeAll(b.time + 5)
    expect(spans('dsh.turn')).toHaveLength(2)
    expect(spans('dsh.tool')).toHaveLength(2)
    recorder.observe(a, event(a, 'turn/start', { turn: 2 }))
    recorder.observe(a, event(a, 'turn/start', { turn: 3 }))
    expect(spans('dsh.turn')).toHaveLength(3)

    const silent = harness({})
    const s = session('silent')
    silent.recorder.observe(s, event(s, 'turn/start', { turn: 1 }))
    silent.recorder.observe(s, event(s, 'step/start', { turn: 1, step: 1 }))
    silent.recorder.observe(s, event(s, 'assistant/attempt', { turn: 1, step: 1, stream: [] }))
    silent.recorder.observe(s, event(s, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(silent.records).toEqual([])
    expect(silent.spans('dsh.turn')).toEqual([])
  })
})

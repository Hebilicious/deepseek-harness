/**
 * Driver edge-case tests: ACP update variants the happy path never sends,
 * attachment prompt blocks, approval and elicitation refusals, session-level
 * permission overrides, and harness cycles that arrive with no prompt open.
 * Each case runs the real
 * driver against the scripted mock `devin acp` child.
 */

import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { acpSessionOf, acpSessionProjection } from '../src/index.ts'
import {
  type Bench,
  events,
  eventsOf,
  recordedCalls,
  send,
  setup,
  teardown,
  turnEndKind,
  waitForFile,
} from './bench.ts'

let bench: Bench | undefined
afterEach(async () => {
  await teardown(bench)
  bench = undefined
})

const TEST_TIMEOUT = 30_000

/** Read the mock's recorded params for one method. */
async function paramsOf(file: string, method: string): Promise<unknown[]> {
  return (await recordedCalls(file)).filter(call => call.method === method).map(call => call.params)
}

describe('ACP update variants', () => {
  it('projects a nameless tool call and a failed update carrying only raw output', async () => {
    bench = await setup({ MOCK_TOOL_BARE: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e1'), agentOptions: {} })
    send(agent, 'bare tool')
    await agent.whenIdle()

    const call = eventsOf(agent, 'tool/call')[0]!
    // The call carries an empty title and no rawInput.
    expect(JSON.stringify(call.data)).toContain('"tool"')
    expect(JSON.stringify(call.data)).toContain('{}')
    const result = eventsOf(agent, 'tool/result')[0]!
    expect((result.data as { message: { content: { isError?: boolean }[] } }).message.content[0]!.isError).toBe(true)
    expect(JSON.stringify(result.data)).toContain('boom')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('ignores non-text chunks and commits an empty attempt at settlement', async () => {
    bench = await setup({
      MOCK_TEXT_IMAGE: '1',
      MOCK_THOUGHT: '',
      MOCK_MESSAGE_ID: 'msg-1',
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e2'), agentOptions: {} })
    send(agent, 'image only')
    await agent.whenIdle()

    // The turn still closes one assistant attempt per ACP messageId lane, but
    // no text block ever opened, so nothing is committed as a message.
    expect(eventsOf(agent, 'assistant/message')).toHaveLength(0)
    expect(eventsOf(agent, 'assistant/attempt')).toHaveLength(2)
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('ignores updates the driver does not project', async () => {
    bench = await setup({ MOCK_UNHANDLED_UPDATE: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e3'), agentOptions: {} })
    send(agent, 'mode update')
    await agent.whenIdle()

    expect(eventsOf(agent, 'assistant/message')).toHaveLength(1)
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('adopts a config_option_update pushed during the turn', async () => {
    bench = await setup({
      MOCK_CONFIG_UPDATE: '1',
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          currentValue: 'accept-edits',
          options: [{ value: 'accept-edits', name: 'Code' }],
        },
      ]),
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e4'), agentOptions: {} })
    send(agent, 'config push')
    await agent.whenIdle()

    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('answers requests addressed to a session this client does not carry', async () => {
    bench = await setup({ MOCK_UNREGISTERED_REQUEST: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e5'), agentOptions: {} })
    send(agent, 'stray requests')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const byMethod = new Map(calls.map(call => [call.method, call.params]))
    expect(byMethod.get('unregistered-permission')).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(byMethod.get('unregistered-elicitation')).toEqual({ action: 'decline' })
    expect(byMethod.get('sessionless-elicitation')).toEqual({ action: 'decline' })
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('records a harness cycle that arrives after the prompt as its own turn', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'agent-acp-idle-')), 'sent')
    bench = await setup({ MOCK_IDLE_UPDATE_FILE: marker }, { questions: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e6'), agentOptions: {} })
    send(agent, 'late updates')
    await agent.whenIdle()
    // The marker lands only after the child's probe requests round-tripped, so
    // the wake turn has closed and the probes saw no live turn.
    await waitForFile(marker, TEST_TIMEOUT - 5000)
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const byMethod = new Map(calls.map(call => [call.method, call.params]))
    expect(byMethod.get('idle-permission')).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(byMethod.get('idle-elicitation')).toEqual({ action: 'decline' })
    expect(eventsOf(agent, 'user/message')).toHaveLength(1)
    expect(eventsOf(agent, 'turn/start')).toHaveLength(2)
    const wake = eventsOf(agent, 'assistant/message')
      .map(event => JSON.stringify(event.data))
      .filter(data => data.includes('late message') || data.includes('still in the wake'))
    expect(wake.length).toBeGreaterThan(0)
    expect(wake.every(data => data.includes('"turn":2'))).toBe(true)
    expect(eventsOf(agent, 'tool/call').some(event => JSON.stringify(event.data).includes('"turn":2'))).toBe(true)
  }, TEST_TIMEOUT)

  it('aborts an open harness cycle when the session is cancelled', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'agent-acp-idle-hang-')), 'sent')
    bench = await setup({
      MOCK_IDLE_UPDATE_FILE: marker,
      MOCK_IDLE_HANG: '1',
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'claude-opus',
        options: [{ value: 'claude-opus', name: 'Opus' }],
      }]),
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e6b'), agentOptions: {} })
    send(agent, 'hang the wake')
    await agent.whenIdle()
    await waitForFile(marker, TEST_TIMEOUT - 5000)
    await vi.waitFor(() => {
      expect(eventsOf(agent, 'turn/start')).toHaveLength(2)
    })

    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    const endings = eventsOf(agent, 'turn/end').map(event => JSON.stringify(event.data))
    expect(endings[0]).toContain('"kind":"completed"')
    expect(endings[1]).toContain('"kind":"aborted"')
  }, TEST_TIMEOUT)

  it('lets a user message preempt an open harness cycle', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'agent-acp-idle-preempt-')), 'sent')
    bench = await setup({ MOCK_IDLE_UPDATE_FILE: marker, MOCK_IDLE_HANG: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e6c'), agentOptions: {} })
    send(agent, 'hang the wake')
    await agent.whenIdle()
    await waitForFile(marker, TEST_TIMEOUT - 5000)
    await vi.waitFor(() => {
      expect(eventsOf(agent, 'turn/start')).toHaveLength(2)
    })

    send(agent, 'user follows')
    await agent.whenIdle()

    expect(eventsOf(agent, 'turn/start')).toHaveLength(3)
    expect(eventsOf(agent, 'user/message')).toHaveLength(2)
    const prompts = await paramsOf(bench.recordFile, 'session/prompt')
    expect(prompts).toHaveLength(2)
  }, TEST_TIMEOUT)

  it('keeps a harness cycle that arrives during config selection on the prompt turn', async () => {
    bench = await setup({
      MOCK_OVERLAP_WAKE: '1',
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'mode',
        name: 'Session Mode',
        type: 'select',
        currentValue: 'accept-edits',
        options: [
          { value: 'accept-edits', name: 'Code' },
          { value: 'ask', name: 'Ask' },
        ],
      }]),
    }, { config: { sandbox: 'read-only' } })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e6d'), agentOptions: {} })
    send(agent, 'overlap')
    await agent.whenIdle()

    expect(eventsOf(agent, 'turn/start')).toHaveLength(1)
    const overlap = eventsOf(agent, 'assistant/message')
      .map(event => JSON.stringify(event.data))
      .filter(data => data.includes('overlap message'))
    expect(overlap.length).toBeGreaterThan(0)
    expect(overlap.every(data => data.includes('"turn":1'))).toBe(true)
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('leaves a quiet inject queued until the harness cycle closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-acp-idle-inject-'))
    const marker = join(dir, 'sent')
    const release = join(dir, 'release')
    bench = await setup({
      MOCK_IDLE_UPDATE_FILE: marker,
      MOCK_IDLE_RELEASE_FILE: release,
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e6e'), agentOptions: {} })
    send(agent, 'wake then inject')
    await agent.whenIdle()
    await waitForFile(marker, TEST_TIMEOUT - 5000)
    await vi.waitFor(() => {
      expect(eventsOf(agent, 'turn/start')).toHaveLength(2)
    })

    agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'job done' }],
      source: { kind: 'user' },
    }))
    await Promise.resolve()
    writeFileSync(release, 'go')
    await agent.whenIdle()

    const methods = (await recordedCalls(bench.recordFile)).map(call => call.method)
    const closeAt = methods.indexOf('idle-closed')
    const prompts = methods.flatMap((method, index) => method === 'session/prompt' ? [index] : [])
    expect(prompts).toHaveLength(2)
    expect(closeAt).toBeGreaterThan(-1)
    expect(closeAt).toBeLessThan(prompts[1] ?? -1)
    const wake = eventsOf(agent, 'assistant/message')
      .map(event => JSON.stringify(event.data))
      .filter(data => data.includes('late message') || data.includes('still in the wake'))
    expect(wake.length).toBeGreaterThan(0)
    expect(wake.every(data => data.includes('"turn":2'))).toBe(true)
    const log = agent.session.snapshotEvents()
    const lateAt = log.findIndex(event =>
      event.type === 'assistant/message' && JSON.stringify(event.data).includes('late message'))
    const noticeAt = log.findIndex(event =>
      event.type === 'user/message' && JSON.stringify(event.data).includes('job done'))
    expect(lateAt).toBeGreaterThan(-1)
    expect(noticeAt).toBeGreaterThan(lateAt)
    const startsBefore = (index: number): number =>
      log.slice(0, index).filter(event => event.type === 'turn/start').length
    expect(startsBefore(lateAt)).toBe(2)
    expect(startsBefore(noticeAt)).toBe(3)
  }, TEST_TIMEOUT)

  it('lets a steer preempt an open harness cycle', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'agent-acp-idle-steer-')), 'sent')
    bench = await setup({ MOCK_IDLE_UPDATE_FILE: marker, MOCK_IDLE_HANG: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e6f'), agentOptions: {} })
    send(agent, 'hang the wake')
    await agent.whenIdle()
    await waitForFile(marker, TEST_TIMEOUT - 5000)
    await vi.waitFor(() => {
      expect(eventsOf(agent, 'turn/start')).toHaveLength(2)
    })

    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'steer now' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(eventsOf(agent, 'turn/start')).toHaveLength(3)
    expect(await paramsOf(bench.recordFile, 'session/prompt')).toHaveLength(2)
  }, TEST_TIMEOUT)
})

describe('ACP prompt content', () => {
  it('degrades an attachment to a text handle when no attachment service is mounted', async () => {
    bench = await setup()
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e32'), agentOptions: {} })
    agent.followup(createUserMessage({
      content: [{ type: 'file', attachment: { attachmentId: AttachmentId('file-3'), name: 'notes.txt', bytes: 4 } }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const prompts = await paramsOf(bench.recordFile, 'session/prompt')
    expect((prompts[0] as { prompt: unknown[] }).prompt).toEqual([{ type: 'text', text: '[file: notes.txt]' }])
  }, TEST_TIMEOUT)

  it('reads a grouped mode option and applies the matching value', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          currentValue: 'accept-edits',
          options: [
            { group: 'editing', name: 'Editing', options: [{ value: 'accept-edits', name: 'Code' }] },
            { group: 'read', name: 'Reading', options: [{ value: 'ask', name: 'Ask' }] },
          ],
        },
      ]),
    }, { config: { sandbox: 'read-only' } })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e33'), agentOptions: {} })
    send(agent, 'grouped options')
    await agent.whenIdle()

    const sets = await paramsOf(bench.recordFile, 'session/set_config_option')
    expect((sets[0] as { value: string }).value).toBe('ask')
  }, TEST_TIMEOUT)

  it('sends attachments as resource links resolved through the attachment service', async () => {
    bench = await setup({}, { attachments: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e7'), agentOptions: {} })
    agent.followup(createUserMessage({
      content: [
        { type: 'text', text: 'see files' },
        { type: 'file', attachment: { attachmentId: AttachmentId('file-1'), name: 'notes.txt', bytes: 4 } },
        {
          type: 'image',
          attachment: { attachmentId: AttachmentId('img-1'), mediaType: 'image/png', bytes: 9, width: 2, height: 2 },
        },
      ],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const prompts = await paramsOf(bench.recordFile, 'session/prompt')
    const blocks = (prompts[0] as { prompt: { type: string; uri?: string; name?: string; text?: string }[] }).prompt
    expect(blocks).toEqual([
      { type: 'text', text: 'see files' },
      { type: 'resource_link', uri: 'file:///attachments/file-1', name: 'notes.txt' },
      { type: 'resource_link', uri: 'file:///attachments/img-1.png', name: '/attachments/img-1.png' },
    ])
  }, TEST_TIMEOUT)

  it('degrades to text handles and warns when attachment resolution fails', async () => {
    bench = await setup({}, { attachments: true })
    bench.attachments!.failing = true
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e8'), agentOptions: {} })
    agent.followup(createUserMessage({
      content: [{ type: 'file', attachment: { attachmentId: AttachmentId('file-2'), name: 'notes.txt', bytes: 4 } }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const prompts = await paramsOf(bench.recordFile, 'session/prompt')
    expect((prompts[0] as { prompt: unknown[] }).prompt).toEqual([{ type: 'text', text: '[file: notes.txt]' }])
    expect(warn.mock.calls.map(call => String(call[0])).some(message => message.includes('attachment'))).toBe(true)
    warn.mockRestore()
  }, TEST_TIMEOUT)
})

describe('ACP approvals and elicitation refusals', () => {
  it('cancels a permission request when no approval service is mounted', async () => {
    bench = await setup({ MOCK_PERMISSION: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e9'), agentOptions: {} })
    send(agent, 'needs approval')
    await agent.whenIdle()

    const outcomes = await paramsOf(bench.recordFile, 'permission-outcome')
    expect(outcomes[0]).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(turnEndKind(agent)).toBe('aborted')
  }, TEST_TIMEOUT)

  it('fails closed and warns when the approval seam rejects', async () => {
    bench = await setup({ MOCK_PERMISSION: '1' }, { approval: 'fake' })
    bench.approval!.failure = new Error('approval backend down')
    const warn = vi.spyOn(bench.ctx.logger, 'warn')

    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e10'), agentOptions: {} })
    send(agent, 'needs approval')
    await agent.whenIdle()

    const outcomes = await paramsOf(bench.recordFile, 'permission-outcome')
    expect(outcomes[0]).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(warn.mock.calls.map(call => String(call[0])).some(message => message.includes('approval'))).toBe(true)
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('declines non-form, schemaless, and failing elicitations', async () => {
    bench = await setup({ MOCK_ELICIT: '1', MOCK_ELICIT_MODE: 'url' }, { questions: true })
    let created = await bench.ctx.agents.create({ sessionId: SessionId('e11'), agentOptions: {} })
    send(created.agent, 'url mode')
    await created.agent.whenIdle()
    let outcomes = await paramsOf(bench.recordFile, 'elicitation-outcome')
    expect(outcomes[0]).toEqual({ action: 'decline' })

    await teardown(bench)
    bench = await setup({ MOCK_ELICIT: '1' }, { questions: true })
    created = await bench.ctx.agents.create({ sessionId: SessionId('e12'), agentOptions: {} })
    bench.questions!.failure = new Error('no interactive user')
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    send(created.agent, 'failing ask')
    await created.agent.whenIdle()
    outcomes = await paramsOf(bench.recordFile, 'elicitation-outcome')
    expect(outcomes[0]).toEqual({ action: 'decline' })
    expect(warn.mock.calls.map(call => String(call[0])).some(message => message.includes('elicitation'))).toBe(true)
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('accepts multi-select and custom answers, and omits unanswered questions', async () => {
    bench = await setup({ MOCK_ELICIT: '1', MOCK_ELICIT_EXTRA: '1' }, { questions: true })
    bench.questions!.answers = id => (id === 'choice'
      ? { id, selected: ['alpha', 'beta'], custom: 'gamma' }
      // An answer with no selections contributes no content at all.
      : { id, selected: [] })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e13'), agentOptions: {} })
    send(agent, 'answer')
    await agent.whenIdle()

    const outcomes = await paramsOf(bench.recordFile, 'elicitation-outcome')
    expect(outcomes[0]).toEqual({ action: 'accept', content: { choice: ['alpha', 'beta', 'gamma'] } })
  }, TEST_TIMEOUT)
})

describe('session-scoped permission overrides', () => {
  it('reads the sandbox and approval overrides from the session log', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          currentValue: 'accept-edits',
          options: [
            { value: 'accept-edits', name: 'Code' },
            { value: 'ask', name: 'Ask' },
            { value: 'bypass', name: 'Bypass Permissions' },
          ],
        },
      ]),
    }, { approval: true, sandboxPolicy: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e14'), agentOptions: {} })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')

    setSandboxMode(agent.session, 'read-only')
    send(agent, 'read-only turn')
    await agent.whenIdle()
    let sets = await paramsOf(bench.recordFile, 'session/set_config_option')
    expect((sets[0] as { value: string }).value).toBe('ask')
    expect(warn.mock.calls.map(call => String(call[0])).some(message => message.includes('read-only'))).toBe(true)

    setApprovalPolicy(agent.session, 'never')
    send(agent, 'never turn')
    await agent.whenIdle()
    sets = await paramsOf(bench.recordFile, 'session/set_config_option')
    expect(sets.map(params => (params as { value: string }).value)).toEqual(['ask', 'bypass'])
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('warns when a read-only session advertises no mode option or no matching mode', async () => {
    bench = await setup({}, { config: { sandbox: 'read-only' } })
    let created = await bench.ctx.agents.create({ sessionId: SessionId('e15'), agentOptions: {} })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    send(created.agent, 'no mode option')
    await created.agent.whenIdle()
    let warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings.some(message => message.includes('read-only') && message.includes('no mode option'))).toBe(true)
    warn.mockRestore()

    await teardown(bench)
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          currentValue: 'accept-edits',
          options: [{ value: 'accept-edits', name: 'Code' }],
        },
      ]),
    }, { config: { sandbox: 'read-only' } })
    created = await bench.ctx.agents.create({ sessionId: SessionId('e16'), agentOptions: {} })
    const second = vi.spyOn(bench.ctx.logger, 'warn')
    send(created.agent, 'no matching mode')
    await created.agent.whenIdle()
    warnings = second.mock.calls.map(call => String(call[0]))
    expect(warnings.some(message => message.includes('read-only') && message.includes('"accept-edits"'))).toBe(true)
    expect(await paramsOf(bench.recordFile, 'session/set_config_option')).toEqual([])
    second.mockRestore()
  }, TEST_TIMEOUT)
})

describe('model selection record', () => {
  it('reports the harness default when another provider owns the selection', async () => {
    bench = await setup()
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('e17'),
      agentOptions: { provider: 'other-provider', model: 'other-model' },
    })
    send(agent, 'foreign route')
    await agent.whenIdle()

    const header = events(agent).find(event => event.type === 'request/header')
    const config = (header?.data['header'] as { config: { provider: string; model: string } }).config
    expect(config.provider).toBe('devin')
    expect(config.model).toBe('agent-default')
    expect(await paramsOf(bench.recordFile, 'session/set_config_option')).toEqual([])
  }, TEST_TIMEOUT)

  it('carries the selected reasoning effort into the durable route', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'swe-1',
          options: [{ value: 'swe-1', name: 'SWE 1' }],
        },
      ]),
    })
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('e18'),
      agentOptions: { provider: 'devin', model: 'swe-1', reasoningEffort: brandString<ReasoningEffortId>('high') },
    })
    send(agent, 'reasoning route')
    await agent.whenIdle()

    const header = events(agent).find(event => event.type === 'request/header')
    const config = (header?.data['header'] as { config: { reasoningEffort?: string } }).config
    expect(config.reasoningEffort).toBe('high')
  }, TEST_TIMEOUT)
})

describe('session binding projection', () => {
  it('lets a later agent-acp/session replace the binding and rejects a malformed one', async () => {
    bench = await setup()
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e19'), agentOptions: {} })

    agent.session.append('agent-acp/session', { sessionId: 'second' })
    expect(acpSessionOf(bench.ctx.sessionProjections, agent.session)).toBe('second')

    // A log whose first binding carries no id is corrupt; the fold rejects it
    // rather than resuming an unaddressable ACP session.
    const corrupt = {
      type: 'agent-acp/session',
      seq: 1,
      data: { sessionId: '' },
    } as never
    const { apply } = acpSessionProjection
    expect(() => apply(null, corrupt)).toThrow('invalid agent-acp/session')
  }, TEST_TIMEOUT)
})

describe('elicitation schema mapping', () => {
  it('asks a question per property and offers only real enum labels', async () => {
    bench = await setup({ MOCK_ELICIT: '1', MOCK_ELICIT_EXTRA: '1' }, { questions: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e22'), agentOptions: {} })
    send(agent, 'two properties')
    await agent.whenIdle()

    const asked = bench.questions!.lastAsk
    expect(asked?.questions).toEqual([
      { id: 'choice', question: 'Pick one', detail: 'mock elicitation', options: [{ label: 'alpha' }, { label: 'beta' }] },
      { id: 'count', question: 'count', detail: 'mock elicitation' },
    ])
    expect((await paramsOf(bench.recordFile, 'elicitation-outcome'))[0])
      .toEqual({ action: 'accept', content: { choice: 'beta', count: 'beta' } })
  }, TEST_TIMEOUT)

  it('declines a form elicitation that carries no properties map', async () => {
    bench = await setup({ MOCK_ELICIT: '1', MOCK_ELICIT_NO_PROPERTIES: '1' }, { questions: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e23'), agentOptions: {} })
    send(agent, 'no properties')
    await agent.whenIdle()

    expect(bench.questions!.lastAsk).toBeUndefined()
    expect((await paramsOf(bench.recordFile, 'elicitation-outcome'))[0]).toEqual({ action: 'decline' })
  }, TEST_TIMEOUT)
})

describe('permission request naming', () => {
  it('falls back to the generic tool name when the agent sends no usable title', async () => {
    bench = await setup({ MOCK_PERMISSION: '1', MOCK_PERMISSION_TITLE: '' }, { approval: true })
    const asked: { toolName?: string; reason?: string }[] = []
    bench.ctx.on('approval/request', (request) => {
      asked.push({
        ...request.toolName === undefined ? {} : { toolName: request.toolName },
        ...request.reason === undefined ? {} : { reason: request.reason },
      })
      return Promise.resolve('allowed-once' as const)
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e24'), agentOptions: {} })
    send(agent, 'unnamed approval')
    await agent.whenIdle()

    expect(asked[0]).toEqual({ toolName: 'tool', reason: 'tool' })
  }, TEST_TIMEOUT)
})

describe('repeated and degenerate streams', () => {
  it('appends repeated chunks to the open block of each lane', async () => {
    bench = await setup({
      MOCK_REPEAT_CHUNKS: '1',
      MOCK_TEXT: 'again',
      MOCK_THOUGHT: 'think',
      MOCK_PLAN: JSON.stringify([{ content: 'step' }]),
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e25'), agentOptions: {} })
    send(agent, 'repeat')
    await agent.whenIdle()

    const committed = JSON.stringify(eventsOf(agent, 'assistant/message').map(event => event.data))
    expect(committed).toContain('againagain')
    expect(committed).toContain('thinkthink')
    expect(committed).toContain('- [pending] step\\n- [pending] step')
  }, TEST_TIMEOUT)

  it('opens no assistant stream for a plan whose entries carry no content', async () => {
    bench = await setup({ MOCK_PLAN: JSON.stringify([{ content: '' }]) })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e26'), agentOptions: {} })
    send(agent, 'empty plan')
    await agent.whenIdle()

    expect(eventsOf(agent, 'assistant/attempt')).toHaveLength(0)
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('defaults the stop reason and keeps the advertised options when the agent omits them', async () => {
    bench = await setup({
      MOCK_NO_STOP_REASON: '1',
      MOCK_SET_OPTION_EMPTY: '1',
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          currentValue: 'accept-edits',
          options: [{ value: 'accept-edits', name: 'Code' }, { value: 'ask', name: 'Ask' }],
        },
      ]),
    }, { config: { sandbox: 'read-only' } })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('e27'), agentOptions: {} })
    send(agent, 'no stop reason')
    await agent.whenIdle()

    expect(turnEndKind(agent)).toBe('completed')
    expect((await paramsOf(bench.recordFile, 'session/set_config_option')).length).toBe(1)
    // The agent answered set_config_option without options, so the driver
    // keeps its last known value and reports that as the mode in effect.
    expect(warn.mock.calls.map(call => String(call[0])).some(message => message.includes('"accept-edits"'))).toBe(true)
    warn.mockRestore()
  }, TEST_TIMEOUT)
})

describe('degraded agent responses', () => {
  it('binds a session whose agent advertises no config options', async () => {
    bench = await setup({ MOCK_NO_CONFIG_OPTIONS: '1', MOCK_LOAD_SESSION: '1', MOCK_SESSION_ID: 'acp-minimal' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('e28'), agentOptions: {} })
    send(first.agent, 'minimal')
    await first.agent.whenIdle()
    await first.dispose()

    const resumed = await bench.ctx.agents.resume({ resumeSessionId: SessionId('e28') })
    send(resumed.agent, 'minimal again')
    await resumed.agent.whenIdle()

    expect(turnEndKind(resumed.agent)).toBe('completed')
    expect((await recordedCalls(bench.recordFile)).some(call => call.method === 'session/load')).toBe(true)
    await resumed.dispose()
  }, TEST_TIMEOUT)
})

describe('shared ACP session ids', () => {
  it('keeps the surviving peer registered when a replaced peer detaches', async () => {
    bench = await setup({ MOCK_SESSION_ID: 'acp-shared' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('e30'), agentOptions: {} })
    const second = await bench.ctx.agents.create({ sessionId: SessionId('e31'), agentOptions: {} })
    // Both agents bound the same agent-side session id; the second owns the
    // routing entry. Detaching the first must not detach the second.
    await first.dispose()

    send(second.agent, 'still routed')
    await second.agent.whenIdle()
    expect(eventsOf(second.agent, 'assistant/message')).toHaveLength(1)
    await second.dispose()
  }, TEST_TIMEOUT)
})

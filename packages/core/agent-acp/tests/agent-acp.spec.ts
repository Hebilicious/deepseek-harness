/**
 * Keyless integration tests for the ACP session driver. Each case spawns a
 * REAL subprocess — the scripted mock `devin acp` agent
 * (tests/mock-acp-agent.ts) — and drives it through the REAL driver over real
 * ACP JSON-RPC stdio: connection setup, session creation and load, prompt
 * projection, permission and elicitation routing, cancellation, fatal
 * teardown, and quiescent disposal are all exercised end to end. No model,
 * no network.
 */

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { AcpCatalogAdapter, AcpHarness, acpSessionOf } from '../src/index.ts'
import type { AcpHarnessEntry } from '../src/index.ts'
import type { AcpRuntime } from '../src/runtime.ts'
import {
  type Bench,
  events,
  eventsOf,
  recordedCalls,
  send,
  setup,
  teardown,
  turnEndKind,
  waitForCall,
  waitForFile,
} from './bench.ts'

let bench: Bench | undefined
afterEach(async () => {
  await teardown(bench)
  bench = undefined
})

const TEST_TIMEOUT = 30_000

describe('agent-acp driver', () => {
  it('creates a session over ACP with no optional client capabilities', async () => {
    bench = await setup()
    const handle = await bench.ctx.agents.create({ sessionId: SessionId('s1'), agentOptions: {} })
    await handle.dispose()

    const calls = await recordedCalls(bench.recordFile)
    const initialize = calls.find(call => call.method === 'initialize')
    expect(initialize).toBeDefined()
    // The agent-side SDK normalizes omitted capabilities to explicit false.
    expect((initialize!.params as { clientCapabilities?: unknown }).clientCapabilities)
      .toEqual({
        auth: { terminal: false },
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      })
    const created = calls.find(call => call.method === 'session/new')
    expect(created).toBeDefined()
    expect(calls.some(call => call.method === 'session/load')).toBe(false)
  }, TEST_TIMEOUT)

  it('binds the ACP session durably and projects a text turn', async () => {
    bench = await setup({ MOCK_TEXT: 'hello from acp' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s2'), agentOptions: {} })

    const binding = acpSessionOf(bench.ctx.sessionProjections, agent.session)
    expect(binding).toBeDefined()

    send(agent, 'hi')
    await agent.whenIdle()

    const log = events(agent)
    const bound = log.find(event => event.type === 'agent-acp/session')
    expect(bound).toBeDefined()
    const assistant = log.find(event => event.type === 'assistant/message')
    expect(assistant).toBeDefined()
    const content = assistant!.data['message'].content
    expect(content.some(block => block.type === 'text' && block.text === 'hello from acp'))
      .toBe(true)
    expect(turnEndKind(agent)).toBe('completed')
    const header = log.find(event => event.type === 'request/header')
    expect((header?.data['header'] as { config: { provider: string } }).config.provider)
      .toBe('devin')
  }, TEST_TIMEOUT)

  it('projects reasoning and plan updates into the assistant stream', async () => {
    bench = await setup({
      MOCK_THOUGHT: 'deliberating',
      MOCK_PLAN: JSON.stringify([
        { content: 'first step', status: 'completed' },
        { content: 'second step', status: 'pending' },
      ]),
      MOCK_TEXT: 'done',
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s3'), agentOptions: {} })
    send(agent, 'plan it')
    await agent.whenIdle()

    const assistant = eventsOf(agent, 'assistant/message')
    // The ACP message stream and the turn-level plan update commit as
    // separate assistant messages.
    expect(assistant).toHaveLength(2)
    const content = assistant.map(event => JSON.stringify(event.data)).join('\n')
    expect(content).toContain('deliberating')
    expect(content).toContain('[completed] first step')
    expect(content).toContain('[pending] second step')
    expect(content).toContain('done')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('projects tool calls and terminal results', async () => {
    bench = await setup({ MOCK_TOOL: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s4'), agentOptions: {} })
    send(agent, 'run a tool')
    await agent.whenIdle()

    expect(eventsOf(agent, 'tool/call')).toHaveLength(1)
    const results = eventsOf(agent, 'tool/result')
    expect(results).toHaveLength(1)
    const message = (results[0]!.data as {
      message: { isError: boolean; content: { text?: string }[] }
    }).message
    expect(message.isError).toBe(false)
    expect(JSON.stringify(message.content)).toContain('tool output')
  }, TEST_TIMEOUT)

  it('commits streamed tool input and keeps text and tool calls in the order the agent sent them', async () => {
    const call = (toolCallId: string, name: string) => ({ sessionUpdate: 'tool_call', toolCallId, name, title: name, kind: 'execute', rawInput: {} })
    const done = (toolCallId: string) => ({
      sessionUpdate: 'tool_call_update', toolCallId, status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: `${toolCallId} output` } }],
    })
    bench = await setup({
      MOCK_TEXT: 'closing text',
      MOCK_SCRIPT: JSON.stringify([
        // A chunk with no text opens a lane with nothing to commit before a call.
        { sessionUpdate: 'agent_message_chunk', messageId: 'm0', content: { type: 'image', data: 'AQ==', mimeType: 'image/png' } },
        { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'first I look' } },
        // Claude Code announces a call with `{}` and refines it as input streams.
        call('c1', 'Bash'),
        { sessionUpdate: 'tool_call_update', toolCallId: 'c1', rawInput: { command: 'ls' }, title: 'ls' },
        done('c1'),
        // No refinement: the next frame, a terminal update, a permission
        // request, a plan, or the turn end commits it with what it has.
        call('c2', 'Write'),
        { sessionUpdate: 'agent_thought_chunk', messageId: 'm2', content: { type: 'text', text: 'thinking' } },
        call('c3', 'Read'),
        done('c3'),
        call('c4', 'Bash'),
        { permission: { toolCallId: 'c4', title: 'rm', rawInput: { command: 'rm x' } } },
        call('c5', 'Grep'),
        { permission: { toolCallId: 'c5', title: 'grep' } },
        call('c6', 'Glob'),
        { sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending', priority: 'medium' }] },
        call('c7', 'Edit'),
      ]),
    }, { approval: 'fake' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s4s'), agentOptions: {} })
    send(agent, 'stream tools')
    await agent.whenIdle()

    const order = agent.session.snapshotEvents().flatMap((event) => {
      if (event.type === 'tool/call') {
        const data = event.data as { callId: string; arguments: string }
        return [`call ${data.callId} ${data.arguments}`]
      }
      if (event.type === 'tool/result') return [`result ${(event.data as { message: { toolCallId: string } }).message.toolCallId}`]
      if (event.type === 'assistant/message') return ['text']
      return []
    })
    expect(order).toEqual([
      'text',
      // Each call first commits its standalone tool-call advertisement.
      'text',
      'call c1 {"command":"ls"}',
      'result c1',
      'text',
      'call c2 {}',
      // The thought streamed after c2, before c3.
      'text',
      'text',
      'call c3 {}',
      'result c3',
      'text',
      'call c4 {"command":"rm x"}',
      'text',
      'call c5 {}',
      'text',
      'call c6 {}',
      // The plan streamed after c6, before c7.
      'text',
      'text',
      'call c7 {}',
      // Calls with no terminal update close at settlement, before the final text.
      'result c2',
      'result c4',
      'result c5',
      'result c6',
      'result c7',
      'text',
    ])
  }, TEST_TIMEOUT)

  it('opens a durable step for each model response the agent streams', async () => {
    const call = (toolCallId: string) => ({ sessionUpdate: 'tool_call', toolCallId, name: 'Bash', title: 'Bash', kind: 'execute', rawInput: { command: toolCallId } })
    const done = (toolCallId: string) => ({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [] })
    bench = await setup({
      MOCK_TEXT: 'all done',
      MOCK_SCRIPT: JSON.stringify([
        { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'one' } },
        call('a'),
        // Text while a call is still open stays in its step.
        { sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: 'waiting' } },
        done('a'),
        // A response of parallel calls only, with no text.
        call('b'),
        call('c'),
        done('b'),
        done('c'),
        { sessionUpdate: 'plan', entries: [{ content: 'next', status: 'pending', priority: 'medium' }] },
      ]),
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s4t'), agentOptions: {} })
    send(agent, 'steps')
    await agent.whenIdle()

    const steps = agent.session.snapshotEvents().flatMap((event) => {
      const data = event.data as { step?: number; callId?: string }
      if (event.type === 'step/start') return [`step ${data.step}`]
      if (event.type === 'tool/call') return [`call ${data.callId}`]
      if (event.type === 'tool/result') return ['result']
      if (event.type === 'assistant/message') return ['text']
      return []
    })
    expect(steps).toEqual([
      // Each call's standalone advertisement precedes its `tool/call`.
      'step 1', 'text', 'text', 'call a', 'text', 'result',
      'step 2', 'text', 'call b', 'text', 'call c', 'result', 'result',
      'step 3', 'text', 'text',
    ])
  }, TEST_TIMEOUT)

  it('interleaves text, a tool call, and post-call text in one turn', async () => {
    bench = await setup({ MOCK_TOOL: '1', MOCK_INTERLEAVED: 'before tool ', MOCK_TEXT: 'after tool' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s4i'), agentOptions: {} })
    send(agent, 'run a tool')
    await agent.whenIdle()

    const log = events(agent)
    const sequence = log.map(event => event.type)
    // The call's announcement commits the streamed text first; its settled
    // input lands on a standalone advertisement right before the `tool/call`.
    const messages = sequence.flatMap((type, index) => type === 'assistant/message' ? [index] : [])
    expect(messages).toHaveLength(3)
    const callIndex = sequence.indexOf('tool/call')
    const resultIndex = sequence.indexOf('tool/result')
    expect(messages[0]! < messages[1]! && messages[1]! < callIndex
      && callIndex < resultIndex && resultIndex < messages[2]!).toBe(true)

    const first = log[messages[0]!]
    expect(first!.type === 'assistant/message' && first!.data['message']).toMatchObject({
      content: [{ type: 'text', text: 'before tool ' }],
    })
    const advert = log[messages[1]!]
    expect(advert!.type === 'assistant/message' && advert!.data['message']).toMatchObject({
      content: [
        { type: 'tool-call', id: 'mock-tool-1', name: 'mock tool', arguments: '{"command":"true"}' },
      ],
    })
    const second = log[messages[2]!]
    expect(second!.type === 'assistant/message' && second!.data['message']).toMatchObject({
      content: [{ type: 'text', text: 'after tool' }],
    })
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('settles an ad-closed stream lane without reopening when no more text arrives', async () => {
    bench = await setup({ MOCK_TOOL: '1', MOCK_INTERLEAVED: 'before tool ', MOCK_TEXT: '' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s4j'), agentOptions: {} })
    send(agent, 'run a tool')
    await agent.whenIdle()

    const log = events(agent)
    const sequence = log.map(event => event.type)
    // The pre-call text message and the standalone advertisement are the only
    // assistant messages; settlement commits no third, empty message.
    const messages = sequence.flatMap((type, index) => type === 'assistant/message' ? [index] : [])
    expect(messages).toHaveLength(2)
    expect(messages[0]! < messages[1]! && messages[1]! < sequence.indexOf('tool/call')).toBe(true)
    const first = log[messages[0]!]
    expect(first!.type === 'assistant/message' && first!.data['message']).toMatchObject({
      content: [{ type: 'text', text: 'before tool ' }],
    })
    const advert = log[messages[1]!]
    expect(advert!.type === 'assistant/message' && advert!.data['message']).toMatchObject({
      content: [
        { type: 'tool-call', id: 'mock-tool-1', name: 'mock tool', arguments: '{"command":"true"}' },
      ],
    })
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('closes an open tool call as an error result at turn settlement', async () => {
    bench = await setup({ MOCK_TOOL_OPEN: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s5'), agentOptions: {} })
    send(agent, 'open tool')
    await agent.whenIdle()

    const results = eventsOf(agent, 'tool/result')
    expect(results).toHaveLength(1)
    expect((results[0]!.data as { message: { isError: boolean } }).message.isError).toBe(true)
  }, TEST_TIMEOUT)

  it('routes permission requests through the approval seam', async () => {
    bench = await setup({ MOCK_PERMISSION: '1' }, { approval: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s6'), agentOptions: {} })
    bench.ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))

    send(agent, 'needs approval')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'permission-outcome')
    expect(JSON.stringify(outcome)).toContain('"yes"')
    expect(eventsOf(agent, 'approval/asked')).toHaveLength(1)
    expect(eventsOf(agent, 'approval/decided')).toHaveLength(1)
  }, TEST_TIMEOUT)

  it('maps a rejection to the offered reject option', async () => {
    bench = await setup({ MOCK_PERMISSION: '1' }, { approval: true })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s7'), agentOptions: {} })
    bench.ctx.on('approval/request', () => Promise.resolve('rejected' as const))

    send(agent, 'deny me')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'permission-outcome')
    expect(JSON.stringify(outcome)).toContain('"no"')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('declines elicitation without a user-questions service and accepts with one', async () => {
    bench = await setup({ MOCK_ELICIT: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s8'), agentOptions: {} })
    send(agent, 'decline')
    await agent.whenIdle()
    let calls = await recordedCalls(bench.recordFile)
    expect(JSON.stringify(calls.find(call => call.method === 'elicitation-outcome')))
      .toContain('decline')
    await teardown(bench)
    bench = undefined

    bench = await setup({ MOCK_ELICIT: '1' }, { questions: true })
    const second = await bench.ctx.agents.create({ sessionId: SessionId('s9'), agentOptions: {} })
    send(second.agent, 'answer')
    await second.agent.whenIdle()
    calls = await recordedCalls(bench.recordFile)
    const outcome = calls.find(call => call.method === 'elicitation-outcome')
    expect(JSON.stringify(outcome)).toContain('accept')
    expect(JSON.stringify(outcome)).toContain('beta')
  }, TEST_TIMEOUT)

  it('applies the session model/mode through session/set_config_option', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'swe-1',
          options: [{ value: 'swe-1', name: 'SWE 1' }, { value: 'swe-2', name: 'SWE 2' }],
        },
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'accept-edits', name: 'Accept edits' },
            { value: 'bypass', name: 'Bypass' },
          ],
        },
      ]),
    })
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('s10'),
      agentOptions: { provider: 'devin', model: 'swe-2' },
    })
    send(agent, 'with model')
    await agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const sets = calls.filter(call => call.method === 'session/set_config_option')
    const byConfig = new Map(sets.map(call => [
      (call.params as { configId: string }).configId,
      (call.params as { value: string }).value,
    ]))
    expect(byConfig.get('model')).toBe('swe-2')
    expect(byConfig.get('mode')).toBe('accept-edits')
  }, TEST_TIMEOUT)

  it('resumes a persisted session through session/load', async () => {
    bench = await setup({ MOCK_LOAD_SESSION: '1', MOCK_SESSION_ID: 'acp-fixed-1' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s11'), agentOptions: {} })
    send(first.agent, 'first turn')
    await first.agent.whenIdle()
    await first.dispose()

    const resumed = await bench.ctx.agents.resume({ resumeSessionId: SessionId('s11') })
    send(resumed.agent, 'second turn')
    await resumed.agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const load = calls.find(call => call.method === 'session/load')
    expect(load).toBeDefined()
    expect((load!.params as { sessionId: string }).sessionId).toBe('acp-fixed-1')
    expect(eventsOf(resumed.agent, 'assistant/message').length).toBeGreaterThanOrEqual(2)
    await resumed.dispose()
  }, TEST_TIMEOUT)

  it('replaces an ACP session the agent no longer knows when no turn reached it', async () => {
    bench = await setup({ MOCK_LOAD_SESSION: '1', MOCK_LOAD_UNKNOWN: '1', MOCK_TEXT: 'fresh' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s11b'), agentOptions: {} })
    const recorded = acpSessionOf(bench.ctx.sessionProjections, first.agent.session)
    await first.dispose()

    const resumed = await bench.ctx.agents.resume({ resumeSessionId: SessionId('s11b') })
    const rebound = acpSessionOf(bench.ctx.sessionProjections, resumed.agent.session)
    expect(rebound).toBeDefined()
    expect(rebound).not.toBe(recorded)
    send(resumed.agent, 'first turn')
    await resumed.agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    expect(calls.map(call => call.method).filter(method => method.startsWith('session/') && method !== 'session/prompt'))
      .toEqual(['session/new', 'session/load', 'session/new'])
    expect(calls.find(call => call.method === 'session/prompt')?.params).toMatchObject({ sessionId: rebound })
    expect(eventsOf(resumed.agent, 'assistant/message')).toHaveLength(1)
    await resumed.dispose()
  }, TEST_TIMEOUT)

  it('keeps the failure for an unknown ACP session that already ran a turn', async () => {
    bench = await setup({ MOCK_LOAD_SESSION: '1', MOCK_LOAD_UNKNOWN: '1' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s11c'), agentOptions: {} })
    send(first.agent, 'first turn')
    await first.agent.whenIdle()
    await first.dispose()

    await expect(bench.ctx.agents.resume({ resumeSessionId: SessionId('s11c') }))
      .rejects.toThrow('Resource not found')
  }, TEST_TIMEOUT)

  it('rejects resume when the agent does not advertise loadSession', async () => {
    bench = await setup({ MOCK_SESSION_ID: 'acp-fixed-2' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('s12'), agentOptions: {} })
    send(first.agent, 'first turn')
    await first.agent.whenIdle()
    await first.dispose()

    await expect(bench.ctx.agents.resume({ resumeSessionId: SessionId('s12') }))
      .rejects.toThrow('loadSession')
  }, TEST_TIMEOUT)

  it('cancels a hung prompt through session/cancel', async () => {
    const ready = join(await mkdtemp(join(tmpdir(), 'agent-acp-ready-')), 'ready')
    bench = await setup({ MOCK_HANG: '1', MOCK_READY_FILE: ready })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s13'), agentOptions: {} })
    send(agent, 'hang')
    await waitForFile(ready, TEST_TIMEOUT - 5000)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    // `whenIdle` settles on the aborted drive; the fire-and-forget
    // session/cancel notification reaches the child's record independently.
    const calls = await waitForCall(bench.recordFile, 'session/cancel', TEST_TIMEOUT - 5000)
    expect(calls.some(call => call.method === 'session/cancel')).toBe(true)
    expect(turnEndKind(agent)).toBe('aborted')
  }, TEST_TIMEOUT)

  it('keeps a steered message queued because ACP has no mid-turn steering', async () => {
    const ready = join(await mkdtemp(join(tmpdir(), 'agent-acp-steer-')), 'ready')
    bench = await setup({ MOCK_HANG_ONCE: '1', MOCK_READY_FILE: ready })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s31'), agentOptions: {} })
    send(agent, 'first')
    await waitForFile(ready, TEST_TIMEOUT - 5000)

    // The steer cannot reach the running prompt, so it stays pending and the
    // next turn carries it.
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'steered input' }],
      source: { kind: 'user' },
    }))
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()

    const prompts = (await recordedCalls(bench.recordFile)).filter(call => call.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(JSON.stringify(prompts[1])).toContain('steered input')
    expect(eventsOf(agent, 'user/message')).toHaveLength(2)
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('settles partial streams on a fatal child exit', async () => {
    bench = await setup({ MOCK_CRASH_AFTER_CHUNK: '1', MOCK_TEXT: 'partial answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s14'), agentOptions: {} })
    send(agent, 'crash')
    await agent.whenIdle()

    const assistant = eventsOf(agent, 'assistant/message')
    expect(assistant).toHaveLength(1)
    expect(JSON.stringify(assistant[0]!.data)).toContain('partial answer')
    expect(turnEndKind(agent)).not.toBe('completed')
  }, TEST_TIMEOUT)

  it('rolls creation back when initialize crashes', async () => {
    bench = await setup({ MOCK_CRASH_ON_INITIALIZE: '1' })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('s15'), agentOptions: {} }))
      .rejects.toThrow()
    expect(bench.ctx.agents.roots()).toHaveLength(0)
  }, TEST_TIMEOUT)

  it('rejects a session/new response without a session id', async () => {
    bench = await setup({ MOCK_MISSING_SESSION_ID: '1' })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('s16'), agentOptions: {} }))
      .rejects.toThrow('session id')
    expect(bench.ctx.agents.roots()).toHaveLength(0)
  }, TEST_TIMEOUT)

  it('quiesces the child through the EOF grace window on dispose', async () => {
    const flushMarker = join(await mkdtemp(join(tmpdir(), 'agent-acp-flush-')), 'flushed')
    bench = await setup({ MOCK_FLUSH_ON_EOF: flushMarker, MOCK_FLUSH_DELAY_MS: '50' })
    await bench.ctx.agents.create({ sessionId: SessionId('s17'), agentOptions: {} })
    // Unload the harness alone: fiber teardown runs sibling disposables
    // concurrently, so the subprocess provider would SIGTERM the child before
    // the driver's stdin-EOF grace can land.
    bench.ctx.registry.delete(AcpHarness)
    await waitForFile(flushMarker, TEST_TIMEOUT - 5000)
  }, TEST_TIMEOUT)

  it('enumerates the devin catalog and reports auth state through the CLI', async () => {
    bench = await setup({
      MOCK_MODELS_JSON: JSON.stringify({
        families: [{
          variants: [
            { model_uid: 'swe-1', label: 'SWE 1', cost_summary: 'standard' },
            { model_uid: 'swe-2', label: 'SWE 2' },
          ],
        }],
      }),
      MOCK_AUTH_DETAIL: 'logged in as mock@example.com',
      MOCK_AGENT_INFO: JSON.stringify({ name: 'mock-agent', title: 'Mock Agent', version: '0.0.0' }),
      MOCK_AUTH_METHODS: JSON.stringify([
        { id: 'devin-browser', name: 'Log in with browser', description: 'Sign in via your browser' },
        { id: 'devin-api-key', name: 'API key' },
      ]),
    })
    const models = await bench.ctx.llm.listModels('devin')
    expect(models.map(model => model.id)).toEqual(['swe-1', 'swe-2'])
    expect(models[0]!.description).toBe('standard')
    // `devin models list` reports no per-model modality, so the catalog
    // leaves the field unknown rather than claiming text-only.
    expect(models[0]!.inputModalities).toBeUndefined()

    const disconnected = await bench.ctx.acpHarness.status({ harness: 'devin' }, new AbortController().signal)
    expect(disconnected.connected).toBe(false)
    expect(disconnected.cliLoggedIn).toBe(true)
    expect(disconnected.cliDetail).toBe('logged in as mock@example.com')
    // A session connect publishes the agent's advertised auth facts.
    await bench.ctx.agents.create({ sessionId: SessionId('s18'), agentOptions: {} })
    const status = await bench.ctx.acpHarness.status({ harness: 'devin' }, new AbortController().signal)
    expect(status.connected).toBe(true)
    expect(status.authMethods).toEqual([
      { id: 'devin-browser', name: 'Log in with browser', description: 'Sign in via your browser' },
      { id: 'devin-api-key', name: 'API key' },
    ])
    expect(status.agentInfo).toEqual({ name: 'mock-agent', title: 'Mock Agent', version: '0.0.0' })
  }, TEST_TIMEOUT)

  it('applies a real Devin mode to a read-only session and reports the constraint once', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          currentValue: 'accept-edits',
          options: [
            { value: 'accept-edits', name: 'Code' },
            { value: 'smart', name: 'Smart' },
            { value: 'ask', name: 'Ask' },
            { value: 'plan', name: 'Plan' },
            { value: 'bypass', name: 'Bypass Permissions' },
          ],
        },
      ]),
    }, { config: { sandbox: 'read-only' } })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s19'), agentOptions: {} })

    send(agent, 'first')
    await agent.whenIdle()
    send(agent, 'second')
    await agent.whenIdle()

    const sets = (await recordedCalls(bench.recordFile))
      .filter(call => call.method === 'session/set_config_option')
    expect(sets.map(call => (call.params as { value: string }).value)).toEqual(['ask'])
    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('read-only')
    expect(warnings[0]).toContain('"ask"')
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('honours the deployment mode override', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          currentValue: 'accept-edits',
          options: [{ value: 'accept-edits', name: 'Code' }, { value: 'plan', name: 'Plan' }],
        },
      ]),
    }, { config: { mode: 'plan' } })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s20'), agentOptions: {} })
    send(agent, 'plan it')
    await agent.whenIdle()

    const sets = (await recordedCalls(bench.recordFile))
      .filter(call => call.method === 'session/set_config_option')
    expect((sets[0]!.params as { value: string }).value).toBe('plan')
  }, TEST_TIMEOUT)

  it('warns with the requested and effective model when the session does not advertise it', async () => {
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
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('s21'),
      agentOptions: { provider: 'devin', model: 'swe-9' },
    })
    send(agent, 'unknown model')
    await agent.whenIdle()

    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings.some(message => message.includes('"swe-9"') && message.includes('"swe-1"'))).toBe(true)
    // The transcript reports the model the agent says it will run.
    const header = events(agent).find(event => event.type === 'request/header')
    expect((header?.data['header'] as { config: { model: string } }).config.model).toBe('swe-1')
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('warns when a requested model cannot be applied because no model option exists', async () => {
    bench = await setup()
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('s22'),
      agentOptions: { provider: 'devin', model: 'swe-9' },
    })
    send(agent, 'no model option')
    await agent.whenIdle()

    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings.some(message => message.includes('"swe-9"') && message.includes('no model option'))).toBe(true)
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('maps the never approval policy to the auto-approve mode only over danger-full-access', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'mode',
          name: 'Session Mode',
          type: 'select',
          currentValue: 'accept-edits',
          options: [{ value: 'accept-edits', name: 'Code' }, { value: 'bypass', name: 'Bypass Permissions' }],
        },
      ]),
    }, { config: { approval: 'never', sandbox: 'danger-full-access' } })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s23'), agentOptions: {} })
    send(agent, 'no prompts')
    await agent.whenIdle()

    const sets = (await recordedCalls(bench.recordFile))
      .filter(call => call.method === 'session/set_config_option')
    expect((sets[0]!.params as { value: string }).value).toBe('bypass')
  }, TEST_TIMEOUT)

  it('maps the permission knobs onto the Claude Code adapter modes', async () => {
    const claudeModes = JSON.stringify([{
      id: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: 'default',
      options: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].map(value => ({ value, name: value })),
    }])
    const modes = async () => (await recordedCalls(bench!.recordFile))
      .filter(call => call.method === 'session/set_config_option')
      .map(call => (call.params as { value: string }).value)
    const run = async (id: string, config: Partial<AcpHarnessEntry>): Promise<string[]> => {
      bench = await setup({ MOCK_CONFIG_OPTIONS: claudeModes }, { config })
      const handle = await bench.ctx.agents.create({ sessionId: SessionId(id), agentOptions: {} })
      send(handle.agent, 'go')
      await handle.agent.whenIdle()
      const applied = await modes()
      await teardown(bench)
      bench = undefined
      return applied
    }
    expect(await run('s23c', { approval: 'never', sandbox: 'danger-full-access' })).toEqual(['bypassPermissions'])
    // A delegated child pins `never`; over a confined sandbox it must not
    // escape into the harness's unconfined auto-approve mode.
    expect(await run('s23h', { approval: 'never', sandbox: 'workspace-write' })).toEqual(['acceptEdits'])
    expect(await run('s23i', { approval: 'never', sandbox: 'read-only' })).toEqual(['plan'])

    bench = await setup({ MOCK_CONFIG_OPTIONS: claudeModes }, { config: { approval: 'ask' } })
    const ask = await bench.ctx.agents.create({ sessionId: SessionId('s23d'), agentOptions: {} })
    send(ask.agent, 'edits only')
    await ask.agent.whenIdle()
    expect(await modes()).toEqual(['acceptEdits'])
  }, TEST_TIMEOUT)

  it('applies a permission change to the harness mode without waiting for the next turn', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'mode',
        name: 'Mode',
        type: 'select',
        currentValue: 'default',
        options: ['default', 'acceptEdits', 'plan', 'bypassPermissions'].map(value => ({ value, name: value })),
      }]),
      MOCK_SET_OPTION_FAIL: 'plan',
    }, { approval: true, sandboxPolicy: true })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s23e'), agentOptions: {} })
    const other = await bench.ctx.agents.create({ sessionId: SessionId('s23f'), agentOptions: {} })
    send(agent, 'first')
    await agent.whenIdle()
    const acpSession = acpSessionOf(bench.ctx.sessionProjections, agent.session)
    const modes = async () => (await recordedCalls(bench!.recordFile))
      .filter(call => call.method === 'session/set_config_option'
        && (call.params as { sessionId: string }).sessionId === acpSession)
      .map(call => (call.params as { value: string }).value)
    expect(await modes()).toEqual(['acceptEdits'])

    // Another session's switch changes only that session's mode.
    setSandboxMode(other.agent.session, 'danger-full-access')
    setApprovalPolicy(other.agent.session, 'never')
    setSandboxMode(agent.session, 'danger-full-access')
    setApprovalPolicy(agent.session, 'never')
    await vi.waitFor(async () => { expect(await modes()).toEqual(['acceptEdits', 'bypassPermissions']) })
    // A turn waits for any queued write before comparing modes, and an
    // unchanged mode sends nothing.
    send(agent, 'second')
    await agent.whenIdle()
    expect(await modes()).toEqual(['acceptEdits', 'bypassPermissions'])

    // A harness that refuses the mode is reported; the next turn tries again.
    setApprovalPolicy(agent.session, 'ask')
    setSandboxMode(agent.session, 'read-only')
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(call => String(call[0]).includes('mode "plan" was not applied after a permission change'))).toBe(true)
    })
    // Queued writes read the knobs when they run, so both switches ask for `plan`.
    expect(new Set((await modes()).slice(2))).toEqual(new Set(['plan']))
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('keeps the known options when a mode write answers without them', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'mode',
        name: 'Mode',
        type: 'select',
        currentValue: 'acceptEdits',
        options: ['acceptEdits', 'bypassPermissions'].map(value => ({ value, name: value })),
      }]),
      MOCK_SET_OPTION_EMPTY: '1',
    }, { approval: true, config: { sandbox: 'danger-full-access' } })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s23g'), agentOptions: {} })
    setApprovalPolicy(agent.session, 'never')
    await vi.waitFor(async () => {
      expect((await recordedCalls(bench!.recordFile)).filter(call => call.method === 'session/set_config_option')
        .map(call => (call.params as { value: string }).value)).toEqual(['bypassPermissions'])
    })
    send(agent, 'still bound')
    await agent.whenIdle()
    expect(eventsOf(agent, 'turn/end')).toHaveLength(1)
  }, TEST_TIMEOUT)

  it('closes the ACP session on dispose and warns when close fails', async () => {
    const pidFile = join(await mkdtemp(join(tmpdir(), 'agent-acp-close-')), 'pid')
    bench = await setup({ MOCK_CLOSE: '1', MOCK_PID_FILE: pidFile })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const handle = await bench.ctx.agents.create({ sessionId: SessionId('s24'), agentOptions: {} })
    await waitForFile(pidFile, TEST_TIMEOUT - 5000)
    await handle.dispose()

    let calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'session/close')).toBe(true)

    // A close against a dead child fails the request, and teardown still
    // completes: the connection already released every session it carried.
    const second = await bench.ctx.agents.create({ sessionId: SessionId('s25'), agentOptions: {} })
    const pid = Number(await readFile(pidFile, 'utf8'))
    process.kill(pid, 'SIGKILL')
    await second.agent.whenIdle()
    await second.dispose()
    calls = await recordedCalls(bench.recordFile)
    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings.some(message => message.includes('session/close'))).toBe(true)
    expect(calls.filter(call => call.method === 'session/close').length).toBeGreaterThanOrEqual(1)
    warn.mockRestore()
  }, TEST_TIMEOUT)

  it('logs out through the CLI when the agent advertises no ACP logout method', async () => {
    bench = await setup()
    const handle = await bench.ctx.agents.create({ sessionId: SessionId('s26'), agentOptions: {} })
    await bench.ctx.acpHarness.logout({ harness: 'devin' }, new AbortController().signal)

    const calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'logout')).toBe(false)
    expect(calls.some(call => call.method === 'cli' && (call.params as { argv: string[] }).argv.includes('logout')))
      .toBe(true)
    await handle.dispose()
  }, TEST_TIMEOUT)

  it('uses the agent logout method when it is advertised', async () => {
    bench = await setup({ MOCK_LOGOUT: '1' })
    await bench.ctx.agents.create({ sessionId: SessionId('s27'), agentOptions: {} })
    await bench.ctx.acpHarness.logout({ harness: 'devin' }, new AbortController().signal)

    const calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'logout')).toBe(true)
    expect(calls.some(call => call.method === 'cli' && (call.params as { argv: string[] }).argv.includes('logout')))
      .toBe(false)
  }, TEST_TIMEOUT)

  it('authenticates through the advertised method and rejects an unadvertised request', async () => {
    bench = await setup({
      MOCK_AUTH_METHODS: JSON.stringify([{ id: 'devin-browser', name: 'Log in with browser' }]),
    })
    await bench.ctx.agents.create({ sessionId: SessionId('s28'), agentOptions: {} })
    await bench.ctx.acpHarness.login({ harness: 'devin' }, new AbortController().signal)

    const calls = await recordedCalls(bench.recordFile)
    const authenticate = calls.find(call => call.method === 'authenticate')
    expect((authenticate?.params as { methodId: string }).methodId).toBe('devin-browser')
  }, TEST_TIMEOUT)

  it('rejects login when the agent advertises no auth methods', async () => {
    bench = await setup()
    await bench.ctx.agents.create({ sessionId: SessionId('s29'), agentOptions: {} })
    await expect(bench.ctx.acpHarness.login({ harness: 'devin' }, new AbortController().signal))
      .rejects.toThrow('no auth methods')
  }, TEST_TIMEOUT)

  it('resolves a listed model and an unlisted id through the catalog adapter', async () => {
    bench = await setup({
      MOCK_MODELS_JSON: JSON.stringify({
        families: [{ variants: [{ model_uid: 'swe-1', label: 'SWE 1', cost_summary: 'standard' }] }],
      }),
    })
    const signal = new AbortController().signal
    expect(await bench.ctx.llm.resolveModelInfo('devin', 'swe-1', signal)).toMatchObject({
      provider: 'devin',
      id: 'swe-1',
      name: 'SWE 1',
      description: 'standard',
    })
    // A picker-stored selection survives a model that dropped out of the listing.
    expect(await bench.ctx.llm.resolveModelInfo('devin', 'retired-model', signal)).toMatchObject({
      provider: 'devin',
      id: 'retired-model',
      name: 'retired-model',
    })
  }, TEST_TIMEOUT)

  it('rejects stream calls as a catalog-only provider', async () => {
    const adapter = new AcpCatalogAdapter('devin', 'Devin', {
      advertisedModels: [],
      listCatalogCli: async () => [],
    } as unknown as AcpRuntime)
    expect(() => adapter.stream({ messages: [] } as never)).toThrow('catalog')
  })
})

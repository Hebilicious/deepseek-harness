/**
 * `agentToolBridge` wiring for the ACP driver: a REAL subprocess mock agent
 * advertises (or omits) `mcpCapabilities.http`, and the specs assert the
 * `mcpServers` entry `session/new`/`session/load` carry, the endpoint's
 * reachability and credential requirement the mock itself probes, the durable
 * `agent-tool-bridge/exposed` event, and revocation at unbind.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AcpRuntime } from '../src/runtime.ts'
import {
  type Bench,
  eventsOf,
  recordedCalls,
  send,
  setup,
  teardown,
  waitForCall,
} from './bench.ts'

let bench: Bench | undefined
afterEach(async () => {
  await teardown(bench)
  bench = undefined
})

const TEST_TIMEOUT = 30_000

const bridgeEcho = defineTool({
  name: 'bridge_echo',
  description: 'echo text back through the bridge',
  parameters: { text: { type: 'string' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
    presentationMeta: (_args, value) => ({ echoed: value }),
  },
  async execute(args) {
    return `pong:${args.text ?? ''}`
  },
})

/** One `mcpServers` entry as the ACP `session/new`/`session/load` params carry it. */
interface McpServerEntry {
  type: string
  name: string
  url: string
  headers: { name: string; value: string }[]
}

/** The `session/new`/`session/load` params' `mcpServers` entry list. */
function mcpServersOf(call: { params: unknown }): McpServerEntry[] {
  return (call.params as { mcpServers?: never[] }).mcpServers ?? []
}

describe('agent-acp tool bridge wiring', () => {
  it('passes a live authenticated MCP endpoint to session/new and records the exposure', async () => {
    bench = await setup(
      {
        MOCK_MCP_HTTP: '1',
        MOCK_MCP_PROBE: '1',
        MOCK_MCP_CALL: JSON.stringify({ name: 'bridge_echo', arguments: { text: 'ping' } }),
      },
      { bridge: true },
    )
    bench.ctx.tools.register(bridgeEcho)

    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('bridge-1'), agentOptions: {} })

    const calls = await recordedCalls(bench.recordFile)
    const created = calls.find(call => call.method === 'session/new')
    expect(created).toBeDefined()
    const servers = mcpServersOf(created!)
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({ type: 'http', name: 'dsh' })
    expect(servers[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const authorization = servers[0]!.headers.find(header => header.name === 'Authorization')
    expect(authorization?.value).toMatch(/^Bearer /)

    // The mock probed the endpoint from its own process: 401 without the
    // bearer token, then the agent's bridged tools under it.
    const unauthorized = calls.find(call => call.method === 'mcp-unauthorized')
    expect(unauthorized?.params).toMatchObject({ status: 401 })
    const tools = calls.find(call => call.method === 'mcp-tools')
    const listed = (tools?.params as { result?: { tools?: { name: string }[] } })?.result?.tools
    expect(listed?.map(tool => tool.name)).toEqual(['bridge_echo'])
    const called = calls.find(call => call.method === 'mcp-call')
    expect(called?.params).toMatchObject({
      result: { content: [{ type: 'text', text: 'pong:ping' }] },
    })

    // The tool list the harness may see is logged durably.
    const exposed = eventsOf(agent, 'agent-tool-bridge/exposed')
    expect(exposed).toHaveLength(1)
    expect(exposed[0]!.data).toEqual({ tools: ['bridge_echo'] })
  }, TEST_TIMEOUT)

  it('exposes agent/created-scoped tools to the handshake tool snapshot', async () => {
    bench = await setup(
      { MOCK_MCP_HTTP: '1', MOCK_MCP_PROBE: '1' },
      { bridge: true },
    )
    // Standing compositions install delegation and Team tools from an
    // `agent/created` listener into the created agent's own scope. ACP peers
    // snapshot the MCP tool list inside `session/new`, so that handshake must
    // already observe them.
    bench.ctx.on('agent/created', ({ agent }) => {
      agent.ctx.inject(['tools'], (runtimeCtx) => {
        runtimeCtx.tools.register(defineTool({
          name: 'bridge_scoped_echo',
          description: 'scoped echo installed by a creation listener',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          execute: () => Promise.resolve('pong'),
        }))
      })
    })

    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('bridge-scoped'), agentOptions: {} })

    const calls = await recordedCalls(bench.recordFile)
    const tools = calls.find(call => call.method === 'mcp-tools')
    const listed = (tools?.params as { result?: { tools?: { name: string }[] } })?.result?.tools
    expect(listed?.map(tool => tool.name)).toEqual(['bridge_scoped_echo'])
    const exposed = eventsOf(agent, 'agent-tool-bridge/exposed')
    expect(exposed).toHaveLength(1)
    expect(exposed[0]!.data).toEqual({ tools: ['bridge_scoped_echo'] })
  }, TEST_TIMEOUT)

  it('logs a prompt-time bridged call under the dsh name with the execution meta', async () => {
    bench = await setup(
      {
        MOCK_MCP_HTTP: '1',
        MOCK_MCP_PROMPT_CALL: JSON.stringify({ name: 'bridge_echo', arguments: { text: 'ping' } }),
      },
      { bridge: true },
    )
    bench.ctx.tools.register(bridgeEcho)

    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('bridge-meta'), agentOptions: {} })
    send(agent, 'call it')
    await agent.whenIdle()

    // The mock called the endpoint and reported Devin's shape: display title,
    // canonical `mcp__dsh__bridge_echo` in `_meta`. The log carries the dsh
    // tool name and the harness's arguments.
    const calls = eventsOf(agent, 'tool/call')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.type === 'tool/call' && calls[0]!.data.name).toBe('bridge_echo')
    expect(calls[0]!.type === 'tool/call' && calls[0]!.data.arguments).toBe(JSON.stringify({ text: 'ping' }))

    // The result keeps the model-visible content the harness reported and
    // picks up the execution's presentation meta.
    const results = eventsOf(agent, 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.type === 'tool/result' && results[0]!.data.meta).toEqual({ echoed: 'pong:ping' })
    const message = (results[0]!.data as { message: {
      content: { type: string; content?: { type: string; text?: string }[] }[]
    } }).message
    expect(message.content).toEqual([{
      type: 'tool-result',
      toolCallId: 'mcp-call-1',
      isError: false,
      content: [{ type: 'text', text: 'pong:ping' }],
    }])

    const called = (await recordedCalls(bench.recordFile)).find(call => call.method === 'mcp-prompt-call')
    expect(called?.params).toMatchObject({ result: { content: [{ type: 'text', text: 'pong:ping' }] } })
  }, TEST_TIMEOUT)

  it('resolves a bridged call reported in Claude Code shape: canonical name as title', async () => {
    bench = await setup(
      {
        MOCK_MCP_HTTP: '1',
        MOCK_MCP_PROMPT_STYLE: 'claude',
        MOCK_MCP_PROMPT_CALL: JSON.stringify({ name: 'bridge_echo', arguments: { text: 'ping' } }),
      },
      { bridge: true },
    )
    bench.ctx.tools.register(bridgeEcho)

    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('bridge-claude'), agentOptions: {} })
    send(agent, 'call it')
    await agent.whenIdle()

    const calls = eventsOf(agent, 'tool/call')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.type === 'tool/call' && calls[0]!.data.name).toBe('bridge_echo')
    const results = eventsOf(agent, 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.type === 'tool/result' && results[0]!.data.meta).toEqual({ echoed: 'pong:ping' })
  }, TEST_TIMEOUT)

  it('revokes the endpoint credential when the agent is disposed', async () => {
    bench = await setup({ MOCK_MCP_HTTP: '1' }, { bridge: true })
    const handle = await bench.ctx.agents.create({ sessionId: SessionId('bridge-2'), agentOptions: {} })

    const calls = await recordedCalls(bench.recordFile)
    const servers = mcpServersOf(calls.find(call => call.method === 'session/new')!)
    expect(servers).toHaveLength(1)
    const { url, headers } = servers[0]!
    const headersObject = Object.fromEntries(headers.map(header => [header.name, header.value]))

    await handle.dispose()

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headersObject },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(response.status).toBe(401)
    await response.arrayBuffer()
  }, TEST_TIMEOUT)

  it('sends no mcpServers and warns once when the harness lacks MCP http support', async () => {
    bench = await setup({ MOCK_MCP_PROBE: '1' }, { bridge: true })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')

    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('bridge-3'), agentOptions: {} })

    const calls = await recordedCalls(bench.recordFile)
    const servers = mcpServersOf(calls.find(call => call.method === 'session/new')!)
    expect(servers).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('devin'))
    expect(eventsOf(agent, 'agent-tool-bridge/exposed')).toHaveLength(0)
  }, TEST_TIMEOUT)

  it('sends no mcpServers when the bridge is not mounted', async () => {
    bench = await setup({ MOCK_MCP_HTTP: '1' })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')

    await bench.ctx.agents.create({ sessionId: SessionId('bridge-4'), agentOptions: {} })

    const calls = await recordedCalls(bench.recordFile)
    const servers = mcpServersOf(calls.find(call => call.method === 'session/new')!)
    expect(servers).toEqual([])
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('tool-bridge'))
  }, TEST_TIMEOUT)

  it('carries the endpoint on session/load for a resumed session', async () => {
    bench = await setup(
      { MOCK_MCP_HTTP: '1', MOCK_LOAD_SESSION: '1', MOCK_SESSION_ID: 'acp-fixed-bridge' },
      { bridge: true },
    )
    const first = await bench.ctx.agents.create({ sessionId: SessionId('bridge-5'), agentOptions: {} })
    await first.dispose()

    const resumed = await bench.ctx.agents.resume({ resumeSessionId: SessionId('bridge-5') })
    await resumed.agent.whenIdle()

    const calls = await recordedCalls(bench.recordFile)
    const loaded = calls.find(call => call.method === 'session/load')
    expect(loaded).toBeDefined()
    const servers = mcpServersOf(loaded!)
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({ type: 'http', name: 'dsh' })

    // The resumed agent owns a fresh credential: its exposure event is on the
    // session and the previous endpoint's token no longer answers.
    const exposed = eventsOf(resumed.agent, 'agent-tool-bridge/exposed')
    expect(exposed.length).toBeGreaterThanOrEqual(1)
    await resumed.dispose()
  }, TEST_TIMEOUT)

  it('closes the endpoint and the orphan ACP session when bind rolls back', async () => {
    bench = await setup({ MOCK_MCP_HTTP: '1', MOCK_CLOSE: '1' }, { bridge: true })
    const spy = vi.spyOn(AcpRuntime.prototype, 'registerSession').mockImplementation(() => {
      throw new Error('register refused')
    })
    await expect(
      bench.ctx.agents.create({ sessionId: SessionId('bridge-rollback'), agentOptions: {} }),
    ).rejects.toThrow('register refused')
    spy.mockRestore()

    // The session/new payload already carried the endpoint, so rollback asked
    // the harness to close the session and revoked the endpoint credential.
    const calls = await waitForCall(bench.recordFile, 'session/close')
    const { url, headers } = mcpServersOf(calls.find(call => call.method === 'session/new')!)[0]!
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...Object.fromEntries(headers.map(header => [header.name, header.value])),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(response.status).toBe(401)
    await response.arrayBuffer()
  }, TEST_TIMEOUT)

  it('logs a failed rollback session/close and still revokes the endpoint', async () => {
    bench = await setup(
      { MOCK_MCP_HTTP: '1', MOCK_CLOSE: '1', MOCK_CLOSE_ERROR: '1' },
      { bridge: true },
    )
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const spy = vi.spyOn(AcpRuntime.prototype, 'registerSession').mockImplementation(() => {
      throw new Error('register refused')
    })
    await expect(
      bench.ctx.agents.create({ sessionId: SessionId('bridge-rollback-close'), agentOptions: {} }),
    ).rejects.toThrow('register refused')
    spy.mockRestore()

    const calls = await waitForCall(bench.recordFile, 'session/close')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session/close during bind rollback failed'))
    const { url, headers } = mcpServersOf(calls.find(call => call.method === 'session/new')!)[0]!
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...Object.fromEntries(headers.map(header => [header.name, header.value])),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(response.status).toBe(401)
    await response.arrayBuffer()
  }, TEST_TIMEOUT)

  it('logs a bridge endpoint close failure during unbind', async () => {
    bench = await setup({ MOCK_MCP_HTTP: '1' }, { bridge: true })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    const bridge = bench.ctx.agentToolBridge
    vi.spyOn(bridge, 'openMcpEndpoint').mockResolvedValue({
      name: 'dsh',
      url: 'http://127.0.0.1:1/mcp',
      headers: [],
      close: () => Promise.reject(new Error('endpoint close blew up')),
    })
    const handle = await bench.ctx.agents.create({
      sessionId: SessionId('bridge-close-fail'),
      agentOptions: {},
    })

    await handle.dispose()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tool-bridge endpoint close failed'))
  }, TEST_TIMEOUT)

  it('opens the catalog probe session without the endpoint', async () => {
    // The default MOCK_MODELS_JSON is `{families: []}`, so the catalog read
    // falls through to the throwaway probe session.
    bench = await setup({ MOCK_MCP_HTTP: '1' }, { bridge: true })
    await bench.ctx.llm.listModels('devin')

    const calls = await waitForCall(bench.recordFile, 'session/new')
    const probe = calls.find(call => call.method === 'session/new')
    expect(probe).toBeDefined()
    expect(mcpServersOf(probe!)).toEqual([])
  }, TEST_TIMEOUT)
})

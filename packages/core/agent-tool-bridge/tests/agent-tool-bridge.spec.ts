import { createServer, request as httpRequest } from 'node:http'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import AgentToolBridge, { type Config as BridgeConfig } from '@deepseek-ai/dsh-agent-tool-bridge'
import type { BridgeMcpEndpoint } from '@deepseek-ai/dsh-agent-tool-bridge/types'

function sessionId(value: string): SessionId {
  return SessionId(`agent:${value}`)
}

const ping = defineTool({
  name: 'ping',
  description: 'replies pong',
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute() {
    return 'pong'
  },
})

const blocked = defineTool({
  name: 'blocked',
  description: 'secret',
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute() {
    return 'unreachable'
  },
})

/** Tool whose output is a caller-chosen ContentBlock sequence. */
function blocksTool(blocks: () => ContentBlock[]): ToolDefinition {
  return defineTool({
    name: 'blocks',
    description: 'renders configured blocks',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => blocks() },
    async execute() {
      return 'ok'
    },
  })
}

interface Bench {
  ctx: Context
  bridge: AgentToolBridge
  agent(): Agent
  session(agent: Agent): Session
  events(type: string): { type: string; data: unknown }[]
}

interface FakeAttachments {
  readImage?(ref: ImageAttachmentRef): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
  imageHostPath?(ref: ImageAttachmentRef): string | undefined
  fileHostPath?(ref: FileAttachmentRef): string | undefined
}

async function setup(
  config?: BridgeConfig,
  options?: { attachments?: FakeAttachments },
): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options?.attachments !== undefined) ctx.provide('attachments', options.attachments)
  await ctx.plugin(AgentToolBridge, config)
  const bridge = ctx.agentToolBridge
  ctx.tools.register(ping)
  ctx.tools.register(blocked)

  const sessions = new Map<string, Session>()
  function session(agent: Agent): Session {
    const s = sessions.get(String(agent.id))
    if (s === undefined) throw new Error(`no session for ${String(agent.id)}`)
    return s
  }
  return {
    ctx,
    bridge,
    agent() {
      const id = sessionId(`agent-${sessions.size + 1}`)
      const s = ctx.sessions.create(id)
      sessions.set(String(id), s)
      // The agent object is itself the scope key; the bridge only reads
      // `session` (for the exposed event) and passes the object through.
      return { id, session: s } as unknown as Agent
    },
    session,
    events(type: string) {
      return [...sessions.values()].flatMap(s =>
        s.snapshotEvents().filter(e => e.type === type),
      )
    },
  }
}

async function connect(endpoint: BridgeMcpEndpoint): Promise<Client> {
  const headers = Object.fromEntries(endpoint.headers.map(h => [h.name, h.value]))
  const client = new Client({ name: 'spec', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers } }))
  return client
}

async function httpStatus(url: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  return res.status
}

/** POST with full control over Host/Origin, which fetch forbids overriding. */
function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
    }, (res) => {
      res.resume()
      res.on('end', () => {
        resolve(res.statusCode ?? 0)
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
  })
}

const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:abc123def456'),
  mediaType: 'image/png',
  bytes: 4,
  width: 2,
  height: 2,
}
const fileRef: FileAttachmentRef = {
  attachmentId: AttachmentId('sha256:999888777666'),
  name: 'data.bin',
  bytes: 9,
}

let bench: Bench | undefined
afterEach(async () => {
  await bench?.ctx.fiber.dispose()
  bench = undefined
})

describe('AgentToolBridge', () => {
  it('fails loud on a non-loopback host', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const failing = async (): Promise<void> => {
      await ctx.plugin(AgentToolBridge, { host: '0.0.0.0' })
    }
    await expect(failing()).rejects.toThrow('loopback')
    await ctx.fiber.dispose()
  })

  it('disposes cleanly without an endpoint', async () => {
    bench = await setup()
    expect(bench.ctx.agentToolBridge).toBeInstanceOf(AgentToolBridge)
  })

  it('applies field defaults when constructed without the config schema', async () => {
    // `ctx.plugin` resolves `static Config`, so the `??` fallbacks exist only
    // for direct construction — exercise them once here.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const bridge = new AgentToolBridge(ctx, {})
    ctx.tools.register(ping)
    const id = sessionId('direct')
    const agent = { id, session: ctx.sessions.create(id) } as unknown as Agent

    const endpoint = await bridge.openMcpEndpoint(agent)
    expect(endpoint.name).toMatch(/^dsh-[0-9a-f]{6}$/)
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const client = await connect(endpoint)
    expect((await client.listTools()).tools.map(t => t.name)).toContain('ping')
    await client.close()
    await ctx.fiber.dispose()
  })

  it('closes live endpoints and the listener on service disposal', async () => {
    bench = await setup()
    const endpoint = await bench.bridge.openMcpEndpoint(bench.agent())
    const headers = Object.fromEntries(endpoint.headers.map(h => [h.name, h.value]))
    await bench.ctx.fiber.dispose()
    bench = undefined
    await expect(fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    })).rejects.toThrow()
  })

  it('surfaces a failed bridged call as an MCP error result', async () => {
    bench = await setup()
    const agent = bench.agent()
    vi.spyOn(bench.ctx.tools, 'execute').mockRejectedValue(new Error('pipeline down'))

    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'ping', arguments: {} })
    expect(result.isError).toBe(true)
    await client.close()
    await endpoint.close()
  })

  it('logs a request-level failure through the MCP handler error hook', async () => {
    bench = await setup()
    const agent = bench.agent()
    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    const warn = vi.spyOn(bench.ctx.logger, 'warn')
    vi.spyOn(bench.ctx.tools, 'schemas').mockImplementation(() => {
      throw new Error('schemas down')
    })

    await expect(client.listTools()).rejects.toThrow()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('schemas down'))
    })
    await client.close()
    await endpoint.close()
  })

  it('opens an authenticated MCP endpoint that exposes the agent view', async () => {
    bench = await setup({ exclude: ['blocked'] })
    const agent = bench.agent()
    const endpoint = await bench.bridge.openMcpEndpoint(agent)

    expect(endpoint.name).toMatch(/^dsh-[0-9a-f]{6}$/)
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const auth = endpoint.headers.find(h => h.name === 'Authorization')
    expect(auth?.value).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/)

    const client = await connect(endpoint)
    expect(client.getServerVersion()?.name).toBe(endpoint.name)
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toContain('ping')
    expect(tools.tools.map(t => t.name)).not.toContain('blocked')

    const result = await client.callTool({ name: 'ping', arguments: {} })
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }])

    const exposed = bench.events('agent-tool-bridge/exposed')
    expect(exposed).toHaveLength(1)
    expect(exposed[0]?.data).toEqual({ tools: ['ping'] })

    await client.close()
    await endpoint.close()
    await endpoint.close()
  })

  it('applies configured name and port', async () => {
    bench = await setup({ serverName: 'bridge-x', port: 0 })
    const endpoint = await bench.bridge.openMcpEndpoint(bench.agent())
    expect(endpoint.name).toMatch(/^bridge-x-[0-9a-f]{6}$/)
    const again = await bench.bridge.openMcpEndpoint(bench.agent())
    expect(again.name).not.toBe(endpoint.name)
    await again.close()
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    await endpoint.close()
  })

  it('binds ::1 and reports a bracketed IPv6 URL', async () => {
    bench = await setup({ host: '::1' })
    const endpoint = await bench.bridge.openMcpEndpoint(bench.agent())
    expect(endpoint.url).toMatch(/^http:\/\/\[::1\]:\d+\/mcp$/)
    const client = await connect(endpoint)
    expect((await client.listTools()).tools.map(t => t.name)).toContain('ping')
    await client.close()
    await endpoint.close()
  })

  it('binds localhost and reports the resolved address', async () => {
    bench = await setup({ host: 'localhost' })
    const endpoint = await bench.bridge.openMcpEndpoint(bench.agent())
    expect(endpoint.url).toMatch(/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\/mcp$/)
    const client = await connect(endpoint)
    expect((await client.listTools()).tools.map(t => t.name)).toContain('ping')
    await client.close()
    await endpoint.close()
  })

  it('shares one listener across concurrent opens', async () => {
    bench = await setup()
    const first = bench.agent()
    const second = bench.agent()
    const [a, b] = await Promise.all([
      bench.bridge.openMcpEndpoint(first),
      bench.bridge.openMcpEndpoint(second),
    ])
    expect(new URL(a.url).port).toBe(new URL(b.url).port)

    const client = await connect(b)
    bench.ctx.emit('agent/disposed', { agent: first })
    // Close of the surviving endpoint is unaffected by the sibling's disposal.
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toContain('ping')
    await client.close()
    await b.close()
  })

  it('retries the bind after a listen failure', async () => {
    const blocker = createServer()
    blocker.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => blocker.once('listening', resolve))
    const address = blocker.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    const port = address.port
    bench = await setup({ port })

    await expect(bench.bridge.openMcpEndpoint(bench.agent())).rejects.toThrow()
    await new Promise<void>(resolve => blocker.close(() => { resolve() }))

    const endpoint = await bench.bridge.openMcpEndpoint(bench.agent())
    expect(endpoint.url).toContain(`:${port}/mcp`)
    await endpoint.close()
  })

  it('rejects a foreign Host header before authentication', async () => {
    bench = await setup()
    const endpoint = await bench.bridge.openMcpEndpoint(bench.agent())
    const headers = Object.fromEntries(endpoint.headers.map(h => [h.name, h.value]))
    expect(await rawStatus(endpoint.url, { ...headers, host: 'evil.example' })).toBe(403)
    await endpoint.close()
  })

  it('rejects a foreign Origin header before authentication', async () => {
    bench = await setup()
    const endpoint = await bench.bridge.openMcpEndpoint(bench.agent())
    const headers = Object.fromEntries(endpoint.headers.map(h => [h.name, h.value]))
    expect(await rawStatus(endpoint.url, { ...headers, origin: 'https://evil.example' })).toBe(403)
    await endpoint.close()
  })

  it('returns 401 for missing or malformed bearer credentials', async () => {
    bench = await setup()
    const endpoint = await bench.bridge.openMcpEndpoint(bench.agent())
    expect(await httpStatus(endpoint.url, {})).toBe(401)
    expect(await httpStatus(endpoint.url, { authorization: 'Basic abc' })).toBe(401)
    // Same-length wrong token exercises the constant-time compare.
    const token = endpoint.headers[0]!.value.slice('Bearer '.length)
    expect(await httpStatus(endpoint.url, { authorization: `Bearer ${'a'.repeat(token.length)}` })).toBe(401)
    await endpoint.close()
  })

  it('rejects requests with a revoked credential after close', async () => {
    bench = await setup()
    const agent = bench.agent()
    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    bench.ctx.emit('agent/disposed', { agent })

    const deadline = Date.now() + 5_000
    let status = 0
    while (Date.now() < deadline) {
      status = await httpStatus(endpoint.url, {
        authorization: endpoint.headers[0]!.value,
      })
      if (status === 401) break
      await new Promise(r => setTimeout(r, 20))
    }
    expect(status).toBe(401)
  })

  it('preserves the append error when rollback close fails', async () => {
    bench = await setup()
    const agent = bench.agent()
    vi.spyOn(bench.session(agent), 'append').mockImplementation(() => {
      throw new Error('append refused')
    })
    await expect(bench.bridge.openMcpEndpoint(agent)).rejects.toThrow('append refused')
    vi.restoreAllMocks()

    // The failed open rolled back; a retry binds a fresh endpoint.
    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    await endpoint.close()
    const exposed = bench.events('agent-tool-bridge/exposed')
    expect(exposed).toHaveLength(1)
  })

  it('aborts an in-flight tools/call when the endpoint closes', async () => {
    bench = await setup()
    const agent = bench.agent()
    const started = Promise.withResolvers<undefined>()
    const settled = Promise.withResolvers<'aborted'>()
    bench.ctx.tools.register(defineTool({
      name: 'gate',
      description: 'settles only on abort',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(_args, exec) {
        started.resolve(undefined)
        await new Promise<void>((resolve) => {
          if (exec.signal.aborted) {
            resolve()
            return
          }
          exec.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        settled.resolve('aborted')
        return 'done'
      },
    }))

    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    const call = client.callTool({ name: 'gate', arguments: {} }).then(() => 'resolved', () => 'rejected')
    await started.promise
    await endpoint.close()
    expect(await settled.promise).toBe('aborted')
    await call
    await client.close()
  })

  it('maps every content block kind to MCP content', async () => {
    bench = await setup()
    const agent = bench.agent()
    bench.ctx.tools.register(blocksTool(() => [
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'because' },
      { type: 'image', attachment: imageRef },
      { type: 'file', attachment: fileRef },
      { type: 'tool-call', id: ToolCallId('tc2'), name: 'ping', arguments: '{}' },
    ]))

    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'blocks', arguments: {} })
    const content = result.content as { type: string; text?: string }[]
    expect(content).toHaveLength(5)
    expect(content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(content[1]).toEqual({ type: 'text', text: 'because' })
    expect(content[2]).toEqual({ type: 'text', text: '[image (2x2px, image/png, sha256:abc123de): bytes unavailable through this bridge]' })
    expect(content[3]?.text).toContain('File "data.bin"')
    expect(content[4]?.text).toContain('"type":"tool-call"')
    await client.close()
    await endpoint.close()
  })

  it('serves image bytes when attachments can read them', async () => {
    bench = await setup(undefined, {
      attachments: {
        readImage: ref => Promise.resolve({ ref, data: new Uint8Array([1, 2, 3]) }),
        imageHostPath: () => '/host/image.png',
      },
    })
    const agent = bench.agent()
    bench.ctx.tools.register(blocksTool(() => [{ type: 'image', attachment: imageRef }]))

    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'blocks', arguments: {} })
    expect(result.content).toEqual([
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
    ])
    await client.close()
    await endpoint.close()
  })

  it('degrades to the saved path when image bytes cannot be read', async () => {
    bench = await setup(undefined, {
      attachments: {
        readImage: () => Promise.reject(new Error('no store')),
        imageHostPath: () => '/host/image.png',
        fileHostPath: () => '/host/data.bin',
      },
    })
    const agent = bench.agent()
    bench.ctx.tools.register(blocksTool(() => [
      { type: 'image', attachment: { ...imageRef, name: 'shot.png' } },
      { type: 'file', attachment: fileRef },
    ]))

    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'blocks', arguments: {} })
    const content = result.content as { type: string; text?: string }[]
    expect(content[0]).toEqual({ type: 'text', text: '[image "shot.png" (2x2px, image/png, sha256:abc123de): read-only copy saved at "/host/image.png"]' })
    expect(content[1]?.text).toContain('saved at "/host/data.bin"')
    await client.close()
    await endpoint.close()
  })

  it('degrades to placeholder text when attachments lookups throw', async () => {
    bench = await setup(undefined, {
      attachments: {
        readImage: () => Promise.reject(new Error('no store')),
        imageHostPath: () => {
          throw new Error('no host')
        },
        fileHostPath: () => {
          throw new Error('no host')
        },
      },
    })
    const agent = bench.agent()
    bench.ctx.tools.register(blocksTool(() => [
      { type: 'image', attachment: imageRef },
      { type: 'file', attachment: fileRef },
    ]))

    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    const result = await client.callTool({ name: 'blocks', arguments: {} })
    const content = result.content as { type: string; text: string }[]
    expect(content[0]).toEqual({ type: 'text', text: '[image (2x2px, image/png, sha256:abc123de): bytes unavailable through this bridge]' })
    expect(content[1]?.text).toContain('cannot access a readable path')
    await client.close()
    await endpoint.close()
  })
})

/** Tool whose presentation meta echoes its output, so identical calls still produce distinct completions. */
const serial = defineTool({
  name: 'serial',
  description: 'increments once per call',
  parameters: {},
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
    presentationMeta: (_args, value) => ({ value }),
  },
  async execute() {
    return `call-${++serialCounter}`
  },
})
let serialCounter = 0

describe('AgentToolBridge transcript correlation', () => {
  it('rejects a serverName containing a dot or double underscore', async () => {
    for (const serverName of ['a.b', 'a__b']) {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await expect(ctx.plugin(AgentToolBridge, { serverName })).rejects.toThrow()
      await ctx.fiber.dispose()
    }
  })

  it('fails loud on an invalid serverName given directly', async () => {
    for (const serverName of ['', 'a.b', 'a__b']) {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      expect(() => new AgentToolBridge(ctx, { serverName }))
        .toThrow('must be non-empty and not contain')
      await ctx.fiber.dispose()
    }
  })

  it('rejects a non-positive correlationLimit', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(AgentToolBridge, { correlationLimit: 0 })).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('recognizes names under the agent\'s own endpoint names and ignores everything else', async () => {
    bench = await setup({ exclude: ['blocked'] })
    const agent = bench.agent()
    expect(bench.bridge.bridgedToolName(agent, 'mcp__dsh__ping')).toBeUndefined()
    const { name } = await bench.bridge.openMcpEndpoint(agent)
    expect(bench.bridge.bridgedToolName(agent, `mcp__${name}__ping`)).toBe('ping')
    expect(bench.bridge.bridgedToolName(agent, `${name}_ping`)).toBe('ping')
    expect(bench.bridge.bridgedToolName(agent, `mcp__${name}__blocked`)).toBeUndefined()
    expect(bench.bridge.bridgedToolName(agent, `${name}_blocked`)).toBeUndefined()
    expect(bench.bridge.bridgedToolName(agent, `mcp__${name}__unknown`)).toBeUndefined()
    expect(bench.bridge.bridgedToolName(agent, `mcp__${name}__`)).toBeUndefined()
    expect(bench.bridge.bridgedToolName(agent, 'mcp__dsh__ping')).toBeUndefined()
    expect(bench.bridge.bridgedToolName(agent, 'mcp__other__ping')).toBeUndefined()
    expect(bench.bridge.bridgedToolName(agent, 'ping')).toBeUndefined()
  })

  it('resolves only the endpoint names the agent opened, until the agent is disposed', async () => {
    bench = await setup()
    const first = bench.agent()
    const second = bench.agent()
    const own = await bench.bridge.openMcpEndpoint(first)
    const other = await bench.bridge.openMcpEndpoint(second)
    expect(own.name).not.toBe(other.name)
    expect(bench.bridge.bridgedToolName(first, `mcp__${other.name}__ping`)).toBeUndefined()
    expect(bench.bridge.bridgedToolName(first, `${other.name}_ping`)).toBeUndefined()
    // A closed endpoint's name still resolves so late results correlate.
    await own.close()
    expect(bench.bridge.bridgedToolName(first, `mcp__${own.name}__ping`)).toBe('ping')
    bench.ctx.emit('agent/disposed', { agent: first })
    expect(bench.bridge.bridgedToolName(first, `mcp__${own.name}__ping`)).toBeUndefined()
    await other.close()
  })

  it('uses the configured serverName as the endpoint name stem in recognition', async () => {
    bench = await setup({ serverName: 'bridge-x' })
    const agent = bench.agent()
    const { name } = await bench.bridge.openMcpEndpoint(agent)
    expect(name).toMatch(/^bridge-x-[0-9a-f]{6}$/)
    expect(bench.bridge.bridgedToolName(agent, `mcp__${name}__ping`)).toBe('ping')
    expect(bench.bridge.bridgedToolName(agent, 'mcp__bridge-x__ping')).toBeUndefined()
    expect(bench.bridge.bridgedToolName(agent, 'mcp__dsh__ping')).toBeUndefined()
  })

  it('hands the settled execution meta to a matching take and consumes it', async () => {
    serialCounter = 0
    bench = await setup()
    const agent = bench.agent()
    bench.ctx.tools.register(serial)
    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    await client.callTool({ name: 'serial', arguments: {} })

    const completion = bench.bridge.takeCompletion(agent, 'serial', '{}')
    expect(completion?.name).toBe('serial')
    expect(completion?.meta).toEqual({ value: 'call-1' })
    // A take consumes the entry; nothing is left for a second match.
    expect(bench.bridge.takeCompletion(agent, 'serial', '{}')).toBeUndefined()
    await client.close()
    await endpoint.close()
  })

  it('correlates identical calls first-in-first-out', async () => {
    serialCounter = 0
    bench = await setup()
    const agent = bench.agent()
    bench.ctx.tools.register(serial)
    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    await client.callTool({ name: 'serial', arguments: {} })
    await client.callTool({ name: 'serial', arguments: {} })

    expect(bench.bridge.takeCompletion(agent, 'serial', '{}')?.meta).toEqual({ value: 'call-1' })
    expect(bench.bridge.takeCompletion(agent, 'serial', '{}')?.meta).toEqual({ value: 'call-2' })
    await client.close()
    await endpoint.close()
  })

  it('matches arguments by canonical JSON, not wire order', async () => {
    bench = await setup()
    const agent = bench.agent()
    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    await client.callTool({ name: 'ping', arguments: { a: 1, b: { c: 2, d: 3 }, list: [{ y: 2, x: 1 }] } })

    const completion = bench.bridge.takeCompletion(agent, 'ping', '{"b":{"d":3,"c":2},"a":1,"list":[{"x":1,"y":2}]}')
    expect(completion?.argumentsJson).toBe('{"a":1,"b":{"c":2,"d":3},"list":[{"x":1,"y":2}]}')
    // A meta-less execution still leaves a consumable completion.
    expect(completion?.meta).toBeUndefined()
    expect(bench.bridge.takeCompletion(agent, 'ping', '{"a":1,"b":{"c":2,"d":3}}')).toBeUndefined()
    await client.close()
    await endpoint.close()
  })

  it('refuses a take on mismatched or malformed arguments', async () => {
    bench = await setup()
    const agent = bench.agent()
    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    await client.callTool({ name: 'ping', arguments: { a: 1 } })

    expect(bench.bridge.takeCompletion(agent, 'ping', '{"a":2}')).toBeUndefined()
    expect(bench.bridge.takeCompletion(agent, 'pong', '{"a":1}')).toBeUndefined()
    expect(bench.bridge.takeCompletion(agent, 'ping', 'not json')).toBeUndefined()
    // The settled entry is still there for the matching report.
    expect(bench.bridge.takeCompletion(agent, 'ping', '{"a":1}')).toBeDefined()
    await client.close()
    await endpoint.close()
  })

  it('keeps completions isolated per agent', async () => {
    bench = await setup()
    const first = bench.agent()
    const second = bench.agent()
    const endpoint = await bench.bridge.openMcpEndpoint(first)
    const client = await connect(endpoint)
    await client.callTool({ name: 'ping', arguments: {} })

    expect(bench.bridge.takeCompletion(second, 'ping', '{}')).toBeUndefined()
    expect(bench.bridge.takeCompletion(first, 'ping', '{}')).toBeDefined()
    await client.close()
    await endpoint.close()
  })

  it('drops the oldest completion once the limit is reached', async () => {
    serialCounter = 0
    bench = await setup({ correlationLimit: 2 })
    const agent = bench.agent()
    bench.ctx.tools.register(serial)
    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    await client.callTool({ name: 'serial', arguments: {} })
    await client.callTool({ name: 'serial', arguments: {} })
    await client.callTool({ name: 'serial', arguments: {} })

    expect(bench.bridge.takeCompletion(agent, 'serial', '{}')?.meta).toEqual({ value: 'call-2' })
    expect(bench.bridge.takeCompletion(agent, 'serial', '{}')?.meta).toEqual({ value: 'call-3' })
    expect(bench.bridge.takeCompletion(agent, 'serial', '{}')).toBeUndefined()
    await client.close()
    await endpoint.close()
  })

  it('drops an agent’s completions when the agent is disposed', async () => {
    bench = await setup()
    const agent = bench.agent()
    const endpoint = await bench.bridge.openMcpEndpoint(agent)
    const client = await connect(endpoint)
    await client.callTool({ name: 'ping', arguments: {} })
    await client.close()

    bench.ctx.emit('agent/disposed', { agent })
    expect(bench.bridge.takeCompletion(agent, 'ping', '{}')).toBeUndefined()
  })
})

/**
 * Unit tests for the shared app-server connection: the JSON-RPC line
 * transport's guarded operations, the initialize handshake, the request
 * handlers' request-scoped-versus-connection-scoped failure split, and every
 * way fatal state is reached. Frames are exchanged over in-memory streams, so
 * each case observes exactly what the connection wrote without a child
 * process.
 */

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import { CodexAppServerConnection, type CodexConnectionHandlers } from '../src/connection.ts'
import { CodexRequestRefused, type JsonObject } from '../src/protocol.ts'

/** Client frames written to a mock output stream, decoded in order. */
class FrameLog {
  readonly frames: JsonObject[] = []
  private buffer = ''

  constructor(stream: PassThrough) {
    stream.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line.length > 0) this.frames.push(JSON.parse(line) as JsonObject)
      }
    })
  }

  /** Wait until at least `count` frames have been written. */
  async expectFrames(count: number): Promise<void> {
    await vi.waitFor(() => { expect(this.frames.length).toBeGreaterThanOrEqual(count) })
  }
}

interface Fixture {
  readonly input: PassThrough
  readonly output: PassThrough
  readonly frames: FrameLog
  readonly connection: CodexAppServerConnection
}

const open: Fixture[] = []

/** One connection over in-memory streams, torn down after the case. */
function connect(handlers: Partial<CodexConnectionHandlers> = {}): Fixture {
  const input = new PassThrough()
  const output = new PassThrough()
  const frames = new FrameLog(output)
  const connection = new CodexAppServerConnection(
    input,
    output,
    {
      request: handlers.request ?? (async () => ({})),
      notification: handlers.notification ?? (() => {}),
    },
    'agent-codex',
  )
  const fixture = { input, output, frames, connection }
  open.push(fixture)
  return fixture
}

/** Write one server frame into the connection's input stream. */
function receive(input: PassThrough, frame: JsonObject): void {
  input.write(`${JSON.stringify(frame)}\n`)
}

function respond(input: PassThrough, id: string, result: unknown): void {
  receive(input, { jsonrpc: '2.0', id, result })
}

afterEach(() => {
  for (const fixture of open.splice(0)) {
    fixture.connection.close()
    fixture.input.destroy()
    fixture.output.destroy()
  }
})

describe('CodexAppServerConnection', () => {
  it('completes the initialize handshake and then writes the initialized notification', async () => {
    const { input, frames, connection } = connect()
    connection.start()
    const initializing = connection.initialize(new AbortController().signal)
    await frames.expectFrames(1)
    expect(frames.frames[0]).toMatchObject({
      method: 'initialize',
      params: {
        clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.0.1' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    })
    respond(input, frames.frames[0]!.id as string, { userAgent: 'mock' })
    await initializing
    await frames.expectFrames(2)
    expect(frames.frames[1]).toEqual({ jsonrpc: '2.0', method: 'initialized' })
  })

  it('refuses an initialize response that is not an object', async () => {
    const { input, frames, connection } = connect()
    connection.start()
    const initializing = connection.initialize(new AbortController().signal)
    await frames.expectFrames(1)
    respond(input, frames.frames[0]!.id as string, 'not-an-object')
    await expect(initializing).rejects.toThrow('invalid initialize response')
  })

  it('answers a server request and delivers a notification', async () => {
    const notifications: string[] = []
    const { input, frames, connection } = connect({
      request: async () => ({ decision: 'decline' }),
      notification: (method) => { notifications.push(method) },
    })
    connection.start()
    receive(input, { jsonrpc: '2.0', id: 'srv_1', method: 'item/x/requestApproval', params: {} })
    await frames.expectFrames(1)
    expect(frames.frames[0]).toEqual({ jsonrpc: '2.0', id: 'srv_1', result: { decision: 'decline' } })

    receive(input, { jsonrpc: '2.0', method: 'turn/started', params: {} })
    await vi.waitFor(() => { expect(notifications).toEqual(['turn/started']) })
  })

  it('answers a refusal with a request-scoped error and keeps the connection live', async () => {
    const { input, frames, connection } = connect({
      request: async () => { throw new CodexRequestRefused('agent-codex: no such method') },
    })
    connection.start()
    receive(input, { jsonrpc: '2.0', id: 'srv_1', method: 'item/x', params: {} })
    await frames.expectFrames(1)
    expect(frames.frames[0]).toMatchObject({ id: 'srv_1', error: { code: -32603 } })

    const pending = connection.request('account/read', {})
    await frames.expectFrames(2)
    respond(input, frames.frames[1]!.id as string, { authenticated: true })
    await expect(pending).resolves.toEqual({ authenticated: true })
  })

  it('fails the connection when a server request handler violates the protocol', async () => {
    const { input, connection } = connect({
      request: async () => { throw new Error('router exploded') },
    })
    connection.start()
    receive(input, { jsonrpc: '2.0', id: 'srv_1', method: 'item/x', params: {} })
    await expect(connection.fatal).rejects.toThrow('router exploded')
  })

  it('fails the connection when a notification handler throws', async () => {
    const { input, connection } = connect({
      notification: () => { throw new Error('unfoldable frame') },
    })
    connection.start()
    receive(input, { jsonrpc: '2.0', method: 'turn/started', params: {} })
    await expect(connection.fatal).rejects.toThrow('unfoldable frame')
  })

  it('resolves a request with its result member', async () => {
    const { input, frames, connection } = connect()
    connection.start()
    const pending = connection.request('account/read', {})
    await frames.expectFrames(1)
    respond(input, frames.frames[0]!.id as string, { authenticated: true })
    await expect(pending).resolves.toEqual({ authenticated: true })
  })

  it('rejects a request with the wire error', async () => {
    const { input, frames, connection } = connect()
    connection.start()
    const pending = connection.request('thread/resume', { threadId: 'thread-1' })
    await frames.expectFrames(1)
    receive(input, {
      jsonrpc: '2.0',
      id: frames.frames[0]!.id,
      error: { code: -32_600, message: 'no rollout found for thread id thread-1' },
    })
    await expect(pending).rejects.toBeInstanceOf(JsonRpcResponseError)
  })

  it('races a request against fatal state', async () => {
    const { input, connection } = connect()
    connection.start()
    const pending = connection.request('account/read', {})
    receive(input, { jsonrpc: '2.0', method: 'turn/started', params: {} })
    // The pending request settles when the input stream ends.
    input.end()
    await expect(pending).rejects.toThrow('app-server protocol stream closed')
  })

  it('abandons a request for an already-aborted signal', async () => {
    const { connection } = connect()
    connection.start()
    const aborted = AbortSignal.abort(new Error('caller left'))
    await expect(connection.request('account/read', {}, aborted)).rejects.toThrow('caller left')

    const reasonless = AbortSignal.abort('no error object')
    await expect(connection.request('account/read', {}, reasonless)).rejects
      .toThrow('agent-codex: app-server request aborted: no error object')
  })

  it('abandons a request when the signal aborts mid-flight', async () => {
    const { connection } = connect()
    connection.start()
    const controller = new AbortController()
    const pending = connection.request('account/read', {}, controller.signal)
    controller.abort(new Error('cancelled while waiting'))
    await expect(pending).rejects.toThrow('cancelled while waiting')
  })

  it('writes notifications with and without params and flushes prior writes', async () => {
    const { frames, connection } = connect()
    connection.start()
    connection.notify('initialized')
    connection.notify('account/login/cancel', { loginId: 'login-1' })
    await connection.flush()
    await frames.expectFrames(2)
    expect(frames.frames[0]).toEqual({ jsonrpc: '2.0', method: 'initialized' })
    expect(frames.frames[1]).toEqual({
      jsonrpc: '2.0',
      method: 'account/login/cancel',
      params: { loginId: 'login-1' },
    })
  })

  it('rejects outstanding requests on close and stays idempotent', async () => {
    const { connection } = connect()
    connection.start()
    const pending = connection.request('account/read', {})
    connection.close()
    await expect(pending).rejects.toThrow('JSON-RPC transport closed')
    expect(() => { connection.close() }).not.toThrow()
  })

  it.each([
    ['an input error', (input: PassThrough): void => { input.emit('error', new Error('read failed')) }],
    ['an output error', (_input: PassThrough, output?: PassThrough): void => { output!.emit('error', new Error('write failed')) }],
  ])('fails the connection on %s', async (_label, raise) => {
    const { input, output, connection } = connect()
    connection.start()
    raise(input, output)
    await expect(connection.fatal).rejects.toThrow()
  })

  it('fails the connection when the protocol stream ends', async () => {
    const { input, connection } = connect()
    connection.start()
    input.end()
    await expect(connection.fatal).rejects.toThrow('app-server protocol stream closed')
  })
})

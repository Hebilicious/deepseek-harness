import { createServer, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import OTel from '@deepseek-ai/dsh-otel'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as AgentTelemetry from '../src/index.ts'

interface Capture { path: string; headers: IncomingHttpHeaders; body: Buffer }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try { for (const dispose of cleanup.splice(0).reverse()) await dispose() }
  finally { vi.unstubAllEnvs(); vi.restoreAllMocks() }
})
beforeEach(() => {
  for (const name of [...Object.values(AgentTelemetry.ENVIRONMENT_VARIABLES), 'OTEL_SDK_DISABLED']) vi.stubEnv(name, undefined)
  vi.stubEnv('OTEL_EXPORTER_OTLP_COMPRESSION', undefined)
  vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_COMPRESSION', undefined)
  vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_COMPRESSION', undefined)
})

async function collector(respond = true) {
  const captures: Capture[] = []
  const received = Promise.withResolvers<undefined>()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      captures.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
      received.resolve(undefined)
      if (respond) res.writeHead(200, { 'content-type': String(req.headers['content-type']) }).end(req.headers['content-type'] === 'application/json' ? '{}' : '')
    })
  })
  cleanup.push(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('collector has no port')
  return { captures, received: received.promise, endpoint: `http://127.0.0.1:${address.port}` }
}

function context() {
  const ctx = new Context()
  const ready = ctx.plugin(OTel)
  cleanup.push(async () => { await ready; await ctx.fiber.dispose() })
  return ctx
}

const session = Session.create(SessionId('plugin-session'))
const turn = (type: 'turn/start' | 'turn/end', seq: number): SessionEvent => type === 'turn/start'
  ? { type, seq: SessionSeq(seq), time: 1_800_000_000_000 + seq, data: { turn: 1 } }
  : { type, seq: SessionSeq(seq), time: 1_800_000_000_000 + seq, data: { turn: 1, reason: { kind: 'completed' } } }

describe('agent activity plugin', () => {
  it('creates no channel and observes nothing without an endpoint', async () => {
    const ctx = context()
    const events = vi.spyOn(OTel.prototype, 'createEventReporter')
    const spans = vi.spyOn(OTel.prototype, 'createSpanReporter')
    const fiber = await ctx.plugin(AgentTelemetry, AgentTelemetry.Config({}))
    ctx.emit('session/event', session, turn('turn/start', 0))
    await fiber.dispose()
    expect(events).not.toHaveBeenCalled()
    expect(spans).not.toHaveBeenCalled()
  })

  it('exports logs and spans with explicit headers and resource, and drains them at unload', async () => {
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(AgentTelemetry, AgentTelemetry.Config({
      endpoint: target.endpoint, protocol: 'http/json', headers: 'authorization=Bearer%20test', serviceName: 'dsh',
      resourceAttributes: 'deployment.environment=test', scheduledDelayMillis: 60_000,
    }))
    ctx.emit('session/event', session, turn('turn/start', 0))
    ctx.emit('session/event', session, turn('turn/end', 1))
    ctx.emit('session/disposed', session)
    await fiber.dispose()
    expect(target.captures.map(capture => capture.path).sort()).toEqual(['/v1/logs', '/v1/traces'])
    for (const capture of target.captures) expect(capture.headers).toMatchObject({ authorization: 'Bearer test', 'content-type': 'application/json' })
    const logs = target.captures.find(capture => capture.path === '/v1/logs')?.body.toString() ?? ''
    expect(logs).toContain('"eventName":"dsh.turn_end"')
    expect(logs).toContain('{"key":"service.name","value":{"stringValue":"dsh"}}')
    expect(logs).toContain('{"key":"deployment.environment","value":{"stringValue":"test"}}')
    expect(target.captures.find(capture => capture.path === '/v1/traces')?.body.toString()).toContain('"name":"dsh.turn"')
  })

  it('takes the collector from the launching environment', async () => {
    const target = await collector()
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', target.endpoint)
    vi.stubEnv('OTEL_TRACES_EXPORTER', 'none')
    vi.stubEnv('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json')
    const ctx = context()
    const fiber = await ctx.plugin(AgentTelemetry, AgentTelemetry.Config({ scheduledDelayMillis: 60_000 }))
    ctx.emit('session/event', session, turn('turn/start', 0))
    await fiber.dispose()
    expect(target.captures.map(capture => [capture.path, capture.headers['content-type']])).toEqual([['/v1/logs', 'application/json']])
  })

  it('sends protobuf to a single signal endpoint', async () => {
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(AgentTelemetry, AgentTelemetry.Config({ logsEndpoint: `${target.endpoint}/custom/logs`, scheduledDelayMillis: 60_000 }))
    ctx.emit('session/event', session, turn('turn/start', 0))
    await fiber.dispose()
    expect(target.captures.map(capture => [capture.path, capture.headers['content-type']])).toEqual([['/custom/logs', 'application/x-protobuf']])
    expect(target.captures[0]?.body.includes('dsh.session_start')).toBe(true)
  })

  it('sends only spans when only the traces endpoint is set', async () => {
    const target = await collector()
    const ctx = context()
    const fiber = await ctx.plugin(AgentTelemetry, AgentTelemetry.Config({ tracesEndpoint: `${target.endpoint}/t`, scheduledDelayMillis: 60_000 }))
    ctx.emit('session/event', session, turn('turn/start', 0))
    ctx.emit('session/event', session, turn('turn/end', 1))
    await fiber.dispose()
    expect(target.captures.map(capture => capture.path)).toEqual(['/t'])
  })

  it('reports export failures and a missed drain deadline', async () => {
    const target = await collector(false)
    const ctx = context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const fiber = await ctx.plugin(AgentTelemetry, AgentTelemetry.Config({
      endpoint: target.endpoint, maxExportBatchSize: 1, shutdownTimeoutMillis: 50, timeoutMillis: 60_000,
    }))
    ctx.emit('session/event', session, turn('turn/start', 0))
    ctx.emit('session/event', session, turn('turn/end', 1))
    await target.received
    await fiber.dispose()
    expect(warn).toHaveBeenCalledWith('Agent telemetry shutdown deadline exceeded; pending records may be lost')
    expect(warn).toHaveBeenCalledWith('Agent telemetry log export failed', expect.any(Error))
    expect(warn).toHaveBeenCalledWith('Agent telemetry span export failed', expect.any(Error))
  })

  it.each([
    [{ endpoint: 'http://c.test', maxExportBatchSize: 10, maxQueueSize: 5 }, /maxExportBatchSize must not exceed maxQueueSize/],
    [{ endpoint: 'http://c.test', protocol: 'grpc' }, /unsupported logs protocol/],
  ])('fails loud at load for %j', (fields, message) => {
    const ctx = context()
    expect(() => { AgentTelemetry.apply(ctx, AgentTelemetry.Config(fields)) }).toThrow(message)
  })
})

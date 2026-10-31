import { createServer, type IncomingHttpHeaders, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { ROOT_CONTEXT, trace } from '@opentelemetry/api'
import { EventLogReporter } from '../src/event-log.ts'
import { SpanReporter, type SpanOptions } from '../src/span-log.ts'
import type { OtlpEncoding } from '../src/transport.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try { for (const dispose of cleanup.splice(0).reverse()) await dispose() }
  finally { vi.restoreAllMocks() }
})

async function collector(listener?: RequestListener) {
  const captures: { path: string; headers: IncomingHttpHeaders; body: Buffer }[] = []
  const server = createServer(listener ?? ((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      captures.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
      res.end(req.headers['content-type'] === 'application/json' ? '{}' : '')
    })
  }))
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
  return { captures, base: `http://127.0.0.1:${address.port}` }
}

function spans(url: string, encoding: OtlpEncoding, overrides: Partial<SpanOptions> = {}) {
  const onFailure = vi.fn()
  const reporter = new SpanReporter({
    exporter: { url, timeoutMillis: 1000 }, encoding, resourceAttributes: { 'service.name': 'span-test' },
    scope: { name: 'span-test' }, processor: { scheduledDelayMillis: 60_000 }, onFailure, ...overrides,
  })
  cleanup.push(() => reporter.shutdown())
  return { reporter, onFailure }
}

it.each([
  ['json', 'application/json'],
  ['protobuf', 'application/x-protobuf'],
] as const)('exports ended %s spans with their parent links', async (encoding, contentType) => {
  const target = await collector()
  const { reporter, onFailure } = spans(`${target.base}/v1/traces`, encoding)
  const parent = reporter.tracer.startSpan('parent-span')
  reporter.tracer.startSpan('child-span', {}, trace.setSpan(ROOT_CONTEXT, parent)).end()
  parent.end()
  reporter.tracer.startSpan('open-span')
  await reporter.shutdown()
  expect(onFailure).not.toHaveBeenCalled()
  expect(target.captures).toHaveLength(1)
  expect(target.captures[0]?.headers['content-type']).toBe(contentType)
  const body = target.captures[0]?.body ?? Buffer.alloc(0)
  for (const name of ['parent-span', 'child-span', 'span-test']) expect(body.includes(name)).toBe(true)
  expect(body.includes('open-span')).toBe(false)
  if (encoding === 'json') {
    type Request = { resourceSpans: { scopeSpans: { spans: { name: string; spanId: string; parentSpanId?: string }[] }[] }[] }
    const spans = (JSON.parse(body.toString()) as Request).resourceSpans[0]?.scopeSpans[0]?.spans ?? []
    expect(spans.find(span => span.name === 'child-span')?.parentSpanId).toBe(spans.find(span => span.name === 'parent-span')?.spanId)
  }
})

it('reports a rejected span export and cancels on an aborted shutdown', async () => {
  const target = await collector((req, res) => { req.resume(); req.on('end', () => { res.writeHead(400).end() }) })
  const rejected = spans(`${target.base}/v1/traces`, 'json')
  rejected.reporter.tracer.startSpan('rejected').end()
  await rejected.reporter.shutdown()
  expect(rejected.onFailure).toHaveBeenCalledWith('Span export failed', expect.any(Error))

  const cancelled = spans(`${target.base}/v1/traces`, 'json')
  cancelled.reporter.tracer.startSpan('cancelled').end()
  await cancelled.reporter.shutdown(AbortSignal.abort())
  expect(cancelled.onFailure).toHaveBeenCalled()
})

it('encodes ordinary events as protobuf with the span they belong to', async () => {
  const target = await collector()
  const owner = spans(`${target.base}/v1/traces`, 'json')
  const span = owner.reporter.tracer.startSpan('owner')
  const reporter = new EventLogReporter({
    exporter: { url: `${target.base}/v1/logs`, timeoutMillis: 1000 }, encoding: 'protobuf',
    resourceAttributes: {}, scope: { name: 'event-test' }, processor: { scheduledDelayMillis: 60_000 }, onFailure: vi.fn(),
  })
  reporter.emit({ eventName: 'linked-event', body: 'linked', timestamp: 1_800_000_000_000, spanContext: span.spanContext() })
  await reporter.shutdown()
  const capture = target.captures.find(item => item.path === '/v1/logs')
  expect(capture?.headers['content-type']).toBe('application/x-protobuf')
  expect(capture?.body.includes('linked-event')).toBe(true)
  expect(capture?.body.includes(Buffer.from(span.spanContext().traceId, 'hex'))).toBe(true)
  expect(capture?.body.includes(Buffer.from(span.spanContext().spanId, 'hex'))).toBe(true)
})

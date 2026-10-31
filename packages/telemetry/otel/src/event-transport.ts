/** Cancellable ordinary-event and span HTTP exports, including retry waits and response reads. */
import type { Agent as HttpsAgent } from 'node:https'
import { gzipSync } from 'node:zlib'
import got from 'got'
import type { ExportResult } from '@opentelemetry/core'
import { createOtlpNetworkExportDelegate, type ExporterMetrics, OTLPExporterBase } from '@opentelemetry/otlp-exporter-base'
import { type ISerializer, JsonLogsSerializer, JsonTraceSerializer, ProtobufLogsSerializer, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace'
import { createLogExporterMetrics, createSpanExporterMetrics, type LogExporterOptions, logTransportOptions, type OtlpEncoding } from './transport.ts'

/** Export, flush, and shutdown operations common to the SDK log and span exporters. */
interface CancellableExporter<Item> {
  export(items: Item[], callback: (result: ExportResult) => void): void
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

/**
 * Create a channel-owned exporter whose cancellation releases requests and retry timers.
 * @param options - explicit collector and SDK HTTP settings.
 * @param signal - channel cancellation, shared by current and future batch exports.
 * @param encoding - OTLP/HTTP request body encoding; defaults to `json`.
 * @returns the SDK exporter; shutdown also destroys its owned HTTP agent.
 */
export function createEventLogExporter(options: LogExporterOptions, signal: AbortSignal, encoding: OtlpEncoding = 'json'): LogRecordExporter {
  return createCancellableExporter<ReadableLogRecord>(
    logTransportOptions(options, 'LOGS', encoding), encoding === 'json' ? JsonLogsSerializer : ProtobufLogsSerializer,
    createLogExporterMetrics(options.url), signal)
}

/**
 * Create a channel-owned span exporter whose cancellation releases requests and retry timers.
 * @param options - explicit collector and SDK HTTP settings.
 * @param signal - channel cancellation, shared by current and future batch exports.
 * @param encoding - OTLP/HTTP request body encoding.
 * @returns the SDK exporter; shutdown also destroys its owned HTTP agent.
 */
export function createSpanExporter(options: LogExporterOptions, signal: AbortSignal, encoding: OtlpEncoding): SpanExporter {
  return createCancellableExporter<ReadableSpan>(
    logTransportOptions(options, 'TRACES', encoding), encoding === 'json' ? JsonTraceSerializer : ProtobufTraceSerializer,
    createSpanExporterMetrics(options.url), signal)
}

function createCancellableExporter<Item>(
  config: ReturnType<typeof logTransportOptions>,
  serializer: ISerializer<Item[], unknown>,
  metrics: ExporterMetrics<Item[]>,
  signal: AbortSignal,
): CancellableExporter<Item> {
  let agent: ReturnType<typeof config.agentFactory> | undefined
  const exporter = new OTLPExporterBase(createOtlpNetworkExportDelegate(config, serializer, metrics, {
    async send(data, timeoutMillis) {
      signal.throwIfAborted()
      agent ??= config.agentFactory(new URL(config.url).protocol)
      const selectedAgent = await agent
      const headers = await config.headers()
      signal.throwIfAborted()
      const compressed = config.compression === 'gzip'
      const request = got.post(config.url, {
        body: compressed ? gzipSync(data) : Buffer.from(data),
        headers: { ...headers, ...(compressed ? { 'content-encoding': 'gzip' } : {}),
          ...(config.userAgent === undefined ? {} : { 'user-agent': config.userAgent }) },
        agent: new URL(config.url).protocol === 'https:' ? { https: selectedAgent as HttpsAgent } : { http: selectedAgent },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMillis)]),
        followRedirect: false,
        retry: { limit: 5, methods: ['POST'], statusCodes: [429, 502, 503, 504], errorCodes: [], backoffLimit: 5000 },
        responseType: 'buffer',
      })
      // Match the SDK's OTLP response-body limit, including chunked responses.
      void request.on('downloadProgress', ({ transferred }) => { if (transferred > 4 * 1024 * 1024) request.cancel() })
      const response = await request
      if (response.statusCode >= 300) throw new Error(`OTLP collector returned HTTP ${response.statusCode}`)
      return { status: 'success', data: response.body }
    },
    shutdown() { /* The exporter awaits agent cleanup below. */ },
  }))
  let shutdown: Promise<void> | undefined
  return {
    export: (items, callback) => { exporter.export(items, callback) },
    forceFlush: () => exporter.forceFlush(),
    shutdown() {
      shutdown ??= (async () => {
        try { await exporter.shutdown() }
        finally { (await agent)?.destroy() }
      })()
      return shutdown
    },
  }
}

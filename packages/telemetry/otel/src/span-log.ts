/** Caller-owned span batching over a cancellable HTTP transport. */
import { addAbortListener } from 'node:events'
import type { Attributes, Tracer } from '@opentelemetry/api'
import { ExportResultCode } from '@opentelemetry/core'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, TracerProvider, type BatchSpanProcessorOptions, type SpanExporter } from '@opentelemetry/sdk-trace'
import type { SessionLogOptions } from './session-log.ts'
import { createSpanExporter } from './event-transport.ts'
import type { LogExporterOptions, OtlpEncoding } from './transport.ts'

/** Span transport, resource, scope, and count-batching options. */
export interface SpanOptions {
  /** Full HTTP(S) traces destination and SDK transport settings. */
  exporter: LogExporterOptions
  /** OTLP/HTTP request body encoding. */
  encoding: OtlpEncoding
  resourceAttributes: Attributes
  scope: { name: string; version?: string }
  /** Count batching; exporter self-observability metering is not supported. */
  processor: Omit<BatchSpanProcessorOptions, 'exporter' | 'selfObsMeterProvider'>
  onFailure: SessionLogOptions['onFailure']
}

/**
 * One caller-owned span queue. Its tracer is not registered globally, so
 * callers pass parent contexts explicitly; ended spans are exported in batches.
 */
export class SpanReporter {
  /** Tracer bound to this channel's provider, resource, and scope. */
  readonly tracer: Tracer
  private readonly exporter: SpanExporter
  private readonly provider: TracerProvider
  private readonly cancellation = new AbortController()
  private readonly onFailure: SpanOptions['onFailure']

  /** @param options - explicit transport, resource, scope, queue, and diagnostic settings. */
  constructor(options: SpanOptions) {
    const exporter = createSpanExporter(options.exporter, this.cancellation.signal, options.encoding)
    this.exporter = exporter
    this.onFailure = options.onFailure
    this.provider = new TracerProvider({
      resource: resourceFromAttributes(options.resourceAttributes),
      spanProcessors: [new BatchSpanProcessor({
        ...options.processor,
        exporter: {
          ...exporter,
          export: (spans, callback) => {
            exporter.export(spans, (result) => {
              if (result.code !== ExportResultCode.SUCCESS) options.onFailure('Span export failed', result.error)
              callback(result)
            })
          },
        },
      })],
    })
    this.tracer = this.provider.getTracer(options.scope.name, options.scope.version)
  }

  /**
   * Export ended spans and release the transport, cancelling remaining exports when the caller aborts.
   * Spans still open at shutdown are not exported. A failed final export is
   * passed to `onFailure` and does not reject.
   * @param signal - optional shutdown deadline; abort discards pending exports and cancels retry waits.
   * @returns completion of SDK shutdown and transport cleanup.
   */
  async shutdown(signal?: AbortSignal): Promise<void> {
    const abort = (): void => { this.cancellation.abort(signal?.reason) }
    const listener = signal === undefined ? undefined : addAbortListener(signal, abort)
    if (signal?.aborted) abort()
    try {
      // The SDK batch processor rejects shutdown with the error of its last failed export.
      await this.provider.shutdown().catch((cause: unknown) => {
        this.onFailure('Span channel shutdown failed', new Error('Span channel shutdown failed', { cause }))
      })
    } finally {
      try { await this.exporter.shutdown() }
      finally { listener?.[Symbol.dispose]() }
    }
  }
}

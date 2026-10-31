/** Explicit OTLP HTTP transport settings shared by log and span channels. */
import { createOtlpHttpExportDelegate, createOtlpHttpExporterMetrics, getSharedConfigurationFromEnvironment, httpAgentFactoryFromOptions } from '@opentelemetry/otlp-exporter-base/node-http'
import { type ExporterMetrics, getSharedConfigurationDefaults, mergeOtlpSharedConfigurationWithDefaults, OTLPExporterBase, type OTLPExporterNodeConfigBase } from '@opentelemetry/otlp-exporter-base'
import { JsonLogsSerializer, LogsExporterMetricsHelper, TraceExporterMetricsHelper } from '@opentelemetry/otlp-transformer'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { ReadableSpan } from '@opentelemetry/sdk-trace'

/** `otel.component.type` reported by OTLP HTTP log exporter self-observability metrics. */
const OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE = 'otlp_http_log_exporter'
/** `otel.component.type` reported by OTLP HTTP span exporter self-observability metrics. */
const OTLP_HTTP_SPAN_EXPORTER_COMPONENT_TYPE = 'otlp_http_span_exporter'

/**
 * Collector and SDK HTTP settings accepted by this package's log exporters.
 *
 * `OTLPExporterConfigBase.selfObsMeterProvider` is excluded: every channel here
 * passes no meter provider to the exporter metrics recorder, which stays noop.
 */
export type LogExporterOptions = Omit<OTLPExporterNodeConfigBase, 'selfObsMeterProvider'> & {
  /** Full HTTP(S) logs destination. */
  url: string
}

/**
 * Create an SDK JSON exporter without inheriting another collector's headers or TLS identity.
 * @param options - explicit endpoint, headers, agent, and SDK transport settings.
 * @returns the exporter owned by one independent log pipeline.
 */
export function createLogExporter(options: LogExporterOptions): LogRecordExporter {
  return new OTLPExporterBase(createOtlpHttpExportDelegate(
    logTransportOptions(options), JsonLogsSerializer, OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE, LogsExporterMetricsHelper, undefined))
}

/**
 * Create one log exporter's self-observability metrics; without a meter provider they record nothing.
 * @param url - collector endpoint recorded as the metrics server address and port.
 * @returns the metrics recorder required by an OTLP HTTP log export delegate.
 */
export function createLogExporterMetrics(url: string): ExporterMetrics<ReadableLogRecord[]> {
  return createOtlpHttpExporterMetrics(OTLP_HTTP_LOG_EXPORTER_COMPONENT_TYPE, LogsExporterMetricsHelper, url, undefined)
}

/** OTLP/HTTP request body encoding: `json` is `http/json`, `protobuf` is `http/protobuf`. */
export type OtlpEncoding = 'json' | 'protobuf'

/**
 * Create one span exporter's self-observability metrics; without a meter provider they record nothing.
 * @param url - collector endpoint recorded as the metrics server address and port.
 * @returns the metrics recorder required by an OTLP HTTP span export delegate.
 */
export function createSpanExporterMetrics(url: string): ExporterMetrics<ReadableSpan[]> {
  return createOtlpHttpExporterMetrics(OTLP_HTTP_SPAN_EXPORTER_COMPONENT_TYPE, TraceExporterMetricsHelper, url, undefined)
}

/**
 * Resolve collector-local headers and agents with shared SDK timeout and compression defaults.
 * @param options - explicit endpoint and SDK HTTP settings.
 * @param signal - OTLP signal whose timeout and compression environment variables apply.
 * @param encoding - request body encoding that selects the `Content-Type` header.
 * @returns resolved transport settings without ambient credentials.
 */
export function logTransportOptions(
  options: LogExporterOptions,
  signal: 'LOGS' | 'TRACES' = 'LOGS',
  encoding: OtlpEncoding = 'json',
): Parameters<typeof createOtlpHttpExportDelegate>[0] {
  const shared = mergeOtlpSharedConfigurationWithDefaults(
    options, getSharedConfigurationFromEnvironment(signal), getSharedConfigurationDefaults())
  return {
    ...shared,
    url: options.url,
    headers: async () => ({
      'Content-Type': encoding === 'json' ? 'application/json' : 'application/x-protobuf',
      ...typeof options.headers === 'function' ? await options.headers() : options.headers,
    }),
    // An agent factory owns the returned agent, including its keepAlive setting.
    agentFactory: typeof options.httpAgentOptions === 'function' ? options.httpAgentOptions
      : httpAgentFactoryFromOptions({ keepAlive: options.keepAlive ?? true, ...options.httpAgentOptions }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
  }
}

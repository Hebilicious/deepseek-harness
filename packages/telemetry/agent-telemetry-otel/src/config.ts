/**
 * Configuration of the agent activity exporter and its resolution into
 * per-signal OTLP/HTTP destinations, following the OpenTelemetry exporter
 * environment-variable semantics.
 */
import z from '@deepseek-ai/schemastery'
import type { OtlpEncoding } from '@deepseek-ai/dsh-otel'

/**
 * Raw exporter settings. Each destination field that the configuration omits
 * takes the value of the standard OpenTelemetry environment variable named
 * beside it ({@link withEnvironment}).
 */
export interface Config {
  /** `OTEL_SDK_DISABLED=true`: export nothing. */
  disabled?: boolean
  /** `OTEL_EXPORTER_OTLP_ENDPOINT`: base URL; `/v1/logs` and `/v1/traces` are appended per signal. */
  endpoint?: string
  /** `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`: full logs URL, used as is. */
  logsEndpoint?: string
  /** `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`: full traces URL, used as is. */
  tracesEndpoint?: string
  /** `OTEL_LOGS_EXPORTER`: `otlp` (default) or `none`. */
  logsExporter?: string
  /** `OTEL_TRACES_EXPORTER`: `otlp` (default) or `none`. */
  tracesExporter?: string
  /** `OTEL_EXPORTER_OTLP_PROTOCOL`: `http/protobuf` (default) or `http/json`. */
  protocol?: string
  /** `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`: overrides {@link protocol} for logs. */
  logsProtocol?: string
  /** `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`: overrides {@link protocol} for traces. */
  tracesProtocol?: string
  /** `OTEL_EXPORTER_OTLP_HEADERS`: `key=value` pairs separated by commas, values percent-encoded. */
  headers?: string
  /** `OTEL_EXPORTER_OTLP_LOGS_HEADERS`: merged over {@link headers} for logs. */
  logsHeaders?: string
  /** `OTEL_EXPORTER_OTLP_TRACES_HEADERS`: merged over {@link headers} for traces. */
  tracesHeaders?: string
  /** `OTEL_SERVICE_NAME`: resource `service.name`; wins over {@link resourceAttributes}. */
  serviceName?: string
  /** `OTEL_RESOURCE_ATTRIBUTES`: `key=value` pairs separated by commas, values percent-encoded. */
  resourceAttributes?: string
  /** Maximum records or spans per export; must not exceed maxQueueSize. */
  maxExportBatchSize: number
  /** Maximum queued records or spans per signal; the SDK drops new ones when full. */
  maxQueueSize: number
  /** Delay before exporting a partial batch. */
  scheduledDelayMillis: number
  /** Exporter HTTP deadline, including transient-error retries. */
  timeoutMillis: number
  /** Processor deadline for one batch export. */
  exportTimeoutMillis: number
  /** Drain deadline at unload; expiry cancels pending exports. */
  shutdownTimeoutMillis: number
}

const positiveInteger = () => z.number().step(1).min(1).max(2_147_483_647)

/** Loader validation and defaults; every destination field is optional. */
export const Config: z<Partial<Config>, Config> = z.object({
  disabled: z.boolean(),
  endpoint: z.string(),
  logsEndpoint: z.string(),
  tracesEndpoint: z.string(),
  logsExporter: z.string(),
  tracesExporter: z.string(),
  protocol: z.string(),
  logsProtocol: z.string(),
  tracesProtocol: z.string(),
  headers: z.string(),
  logsHeaders: z.string(),
  tracesHeaders: z.string(),
  serviceName: z.string(),
  resourceAttributes: z.string(),
  maxExportBatchSize: positiveInteger().default(512),
  maxQueueSize: positiveInteger().default(2048),
  scheduledDelayMillis: positiveInteger().default(5000),
  timeoutMillis: positiveInteger().default(10000),
  exportTimeoutMillis: positiveInteger().default(15000),
  shutdownTimeoutMillis: positiveInteger().default(3000),
})

/** Destination fields and the OpenTelemetry environment variables that supply them. */
export const ENVIRONMENT_VARIABLES = {
  endpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
  logsEndpoint: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  tracesEndpoint: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  logsExporter: 'OTEL_LOGS_EXPORTER',
  tracesExporter: 'OTEL_TRACES_EXPORTER',
  protocol: 'OTEL_EXPORTER_OTLP_PROTOCOL',
  logsProtocol: 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  tracesProtocol: 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
  headers: 'OTEL_EXPORTER_OTLP_HEADERS',
  logsHeaders: 'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  tracesHeaders: 'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  serviceName: 'OTEL_SERVICE_NAME',
  resourceAttributes: 'OTEL_RESOURCE_ATTRIBUTES',
} as const satisfies Partial<Record<keyof Config, string>>

/**
 * Fill each destination field the configuration omits from its environment
 * variable; `OTEL_SDK_DISABLED` applies when `disabled` is omitted.
 * @param config - validated configuration; present fields win.
 * @param lookup - reads one environment variable.
 * @returns the configuration with environment values applied.
 */
export function withEnvironment(config: Config, lookup: (name: string) => string | undefined): Config {
  const resolved: Config = Object.assign({}, config, {
    disabled: config.disabled ?? lookup('OTEL_SDK_DISABLED')?.trim().toLowerCase() === 'true',
  })
  for (const [field, name] of Object.entries(ENVIRONMENT_VARIABLES) as [keyof typeof ENVIRONMENT_VARIABLES, string][]) {
    const value = config[field] ?? lookup(name)
    if (value !== undefined) resolved[field] = value
  }
  return resolved
}

/** One signal's resolved destination. */
export interface SignalDestination {
  /** Full HTTP(S) URL receiving this signal's export requests. */
  url: string
  /** Request body encoding. */
  encoding: OtlpEncoding
  /** Collector headers, for example authorization. */
  headers: Record<string, string>
}

/** Destinations with absent signals disabled, and the resource attributes shared by both. */
export interface ResolvedDestinations {
  logs?: SignalDestination
  traces?: SignalDestination
  /** Parsed `OTEL_RESOURCE_ATTRIBUTES` with `service.name` applied. */
  resourceAttributes: Record<string, string>
}

/**
 * Resolve the per-signal destinations. A signal is enabled only when an
 * endpoint applies to it and its exporter is not `none`.
 * @param config - validated raw settings.
 * @param defaultServiceName - `service.name` when neither the service name nor the resource attributes set one.
 * @returns the enabled signals' destinations; an empty result exports nothing.
 * @throws Error when a value is malformed or names an unsupported exporter or protocol.
 */
export function resolveDestinations(config: Config, defaultServiceName: string): ResolvedDestinations {
  const resourceAttributes = parseKeyValueList(config.resourceAttributes, 'resourceAttributes')
  resourceAttributes['service.name'] = nonEmpty(config.serviceName) ?? resourceAttributes['service.name'] ?? defaultServiceName
  if (config.disabled) return { resourceAttributes }
  const shared = parseKeyValueList(config.headers, 'headers')
  const logs = resolveSignal(config.logsExporter, config.logsEndpoint, config.endpoint, 'v1/logs',
    config.logsProtocol ?? config.protocol, { ...shared, ...parseKeyValueList(config.logsHeaders, 'logsHeaders') }, 'logs')
  const traces = resolveSignal(config.tracesExporter, config.tracesEndpoint, config.endpoint, 'v1/traces',
    config.tracesProtocol ?? config.protocol, { ...shared, ...parseKeyValueList(config.tracesHeaders, 'tracesHeaders') }, 'traces')
  return { ...logs && { logs }, ...traces && { traces }, resourceAttributes }
}

function resolveSignal(
  exporter: string | undefined,
  signalEndpoint: string | undefined,
  baseEndpoint: string | undefined,
  path: string,
  protocol: string | undefined,
  headers: Record<string, string>,
  signal: string,
): SignalDestination | undefined {
  switch (nonEmpty(exporter) ?? 'otlp') {
    case 'otlp': break
    case 'none': return undefined
    default: throw new Error(`agent-telemetry-otel: unsupported ${signal} exporter ${JSON.stringify(exporter)}; use otlp or none`)
  }
  const explicit = nonEmpty(signalEndpoint)
  const base = nonEmpty(baseEndpoint)
  const url = explicit ?? (base === undefined ? undefined : `${base}${base.endsWith('/') ? '' : '/'}${path}`)
  if (url === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (cause) {
    throw new Error(`agent-telemetry-otel: ${signal} endpoint must be a valid HTTP(S) URL`, { cause })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`agent-telemetry-otel: ${signal} endpoint must use HTTP or HTTPS`)
  }
  return { url, encoding: resolveEncoding(protocol, signal), headers }
}

function resolveEncoding(protocol: string | undefined, signal: string): OtlpEncoding {
  switch (nonEmpty(protocol) ?? 'http/protobuf') {
    case 'http/protobuf': return 'protobuf'
    case 'http/json': return 'json'
    default: throw new Error(`agent-telemetry-otel: unsupported ${signal} protocol ${JSON.stringify(protocol)}; use http/protobuf or http/json`)
  }
}

/**
 * Parse an OpenTelemetry `key=value,key=value` list with percent-encoded values.
 * @param value - raw list; absent or blank yields an empty record.
 * @param field - config field named in errors; values never appear in errors.
 * @returns the parsed entries; later duplicates win.
 * @throws Error when an entry lacks a key or `=`, or a value is not valid percent-encoding.
 */
export function parseKeyValueList(value: string | undefined, field: string): Record<string, string> {
  const entries: Record<string, string> = {}
  const list = nonEmpty(value)
  if (list === undefined) return entries
  for (const item of list.split(',')) {
    if (item.trim() === '') continue
    const separator = item.indexOf('=')
    const key = separator < 0 ? '' : item.slice(0, separator).trim()
    if (key === '') throw new Error(`agent-telemetry-otel: ${field} entries must have the form key=value`)
    try {
      entries[key] = decodeURIComponent(item.slice(separator + 1).trim())
    } catch (cause) {
      throw new Error(`agent-telemetry-otel: ${field} value of ${JSON.stringify(key)} is not valid percent-encoding`, { cause })
    }
  }
  return entries
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

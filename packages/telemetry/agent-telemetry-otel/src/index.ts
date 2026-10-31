/**
 * Agent activity export over OTLP/HTTP: one `dsh.*` log record per prompt,
 * model request, tool decision, tool result, and turn end, and a span per
 * turn, model request, and tool call, for every live Session.
 *
 * Destinations follow the OpenTelemetry exporter environment variables of the
 * launching process and the Harness home `.env`; a project `.env` cannot set
 * them. Configured fields win. Without an endpoint the plugin creates no
 * channel and observes nothing.
 *
 * @module @deepseek-ai/dsh-agent-telemetry-otel
 */
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { EventLogReporter, SpanReporter } from '@deepseek-ai/dsh-otel'
import type {} from '@deepseek-ai/dsh-session'
import { Config, resolveDestinations, withEnvironment, type SignalDestination } from './config.ts'
import { AgentActivityRecorder } from './recorder.ts'

export { Config, ENVIRONMENT_VARIABLES, parseKeyValueList, resolveDestinations, withEnvironment } from './config.ts'
export type { ResolvedDestinations, SignalDestination } from './config.ts'
export { AgentActivityRecorder } from './recorder.ts'
export type { ActivitySinks, ObservedSession } from './recorder.ts'

/** Cordis plugin name. */
export const name = 'agent-telemetry-otel'
/** Services this plugin requires. */
export const inject = ['otel']

/**
 * Create the configured channels and report every live Session's activity.
 * @param ctx - the plugin context.
 * @param config - validated exporter settings.
 * @throws Error at load when a destination setting is malformed or unsupported.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.maxExportBatchSize > config.maxQueueSize) {
    throw new Error('agent-telemetry-otel: maxExportBatchSize must not exceed maxQueueSize')
  }
  const environment = launchEnvironmentOf(ctx)
  // A project's .env must not redirect the activity of the agent working in it.
  const settings = withEnvironment(config, name => environment.getFrom(name, ['process', 'user-env'])?.value)
  const destinations = resolveDestinations(settings, APP_IDENTITY.product)
  if (destinations.logs === undefined && destinations.traces === undefined) return
  const { version } = createRequire(import.meta.url)('../package.json') as { version: string }
  const resourceAttributes = { 'service.version': APP_IDENTITY.version, ...destinations.resourceAttributes }
  const scope = { name: '@deepseek-ai/dsh-agent-telemetry-otel', version }
  const processor = {
    maxExportBatchSize: config.maxExportBatchSize, maxQueueSize: config.maxQueueSize,
    scheduledDelayMillis: config.scheduledDelayMillis, exportTimeoutMillis: config.exportTimeoutMillis,
  }
  const exporter = (destination: SignalDestination) => ({
    url: destination.url, headers: destination.headers, timeoutMillis: config.timeoutMillis,
  })
  const events: EventLogReporter | undefined = destinations.logs === undefined ? undefined : ctx.otel.createEventReporter({
    exporter: exporter(destinations.logs), encoding: destinations.logs.encoding, resourceAttributes, scope, processor,
    onFailure: (_message, error) => { ctx.logger.warn('Agent telemetry log export failed', error) },
  })
  const spans: SpanReporter | undefined = destinations.traces === undefined ? undefined : ctx.otel.createSpanReporter({
    exporter: exporter(destinations.traces), encoding: destinations.traces.encoding, resourceAttributes, scope, processor,
    onFailure: (_message, error) => { ctx.logger.warn('Agent telemetry span export failed', error) },
  })
  const recorder = new AgentActivityRecorder({ ...events && { events }, ...spans && { tracer: spans.tracer } })
  ctx.effect(() => async () => {
    recorder.closeAll(Date.now())
    const cancellation = new AbortController()
    const timer = setTimeout(() => {
      ctx.logger.warn('Agent telemetry shutdown deadline exceeded; pending records may be lost')
      cancellation.abort(new Error('Agent telemetry shutdown deadline exceeded'))
    }, config.shutdownTimeoutMillis)
    try {
      await Promise.all([events?.shutdown(cancellation.signal), spans?.shutdown(cancellation.signal)])
    } finally {
      clearTimeout(timer)
    }
  })
  ctx.on('session/event', (session, event) => { recorder.observe(session, event) })
  ctx.on('session/disposed', (session) => { recorder.close(session.id, Date.now()) })
}

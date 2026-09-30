/**
 * Concrete agent-loop plugin: creates scoped ReactLoopAgents, publishes them
 * through the agent/session registries, and owns their ordered teardown.
 *
 * @module @deepseek-ai/dsh-agent-loop
 */
import type { Volatile } from '@deepseek-ai/cosmokit'

import { Context, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import { HarnessId } from '@deepseek-ai/dsh-agent'
import { ExternalAgentHost, turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-external'
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { ReactLoopAgent } from './agent.ts'
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from './constants.ts'
import type {} from './runtime-context.ts'

export { turnBoundaryProjectionDefinition }

export { DEFAULT_MAX_PARALLEL_TOOL_CALLS }

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
    /**
     * Launcher-owned exact session identities for configured agents, keyed by
     * the agent's config `id` and set with `ctx.provide()` before any Loader
     * entry mounts (see {@link CONFIGURED_AGENT_IDENTITIES_KEY}). A launcher
     * owns identity because only it knows whether the session already exists,
     * while the `cordis.yml` row keeps the model route as ordinary patchable
     * config. An entry with no matching key keeps its configured identity.
     */
    configuredAgentIdentities?: ConfiguredAgentIdentities
  }
  interface Events {
    /**
     * A declarative agent entry failed before it could publish a live agent.
     * Consumers that buffer work for the configured identity use this
     * transient signal to reject that work instead of waiting forever. Normal
     * factory teardown suppresses failures from the cancelled startup attempt.
     * @param payload.sessionId - exact shared agent/session identity that failed startup.
     * @param payload.error - persistence, setup, or publication failure.
     * @mode emit
     */
    'agent-loop/config-start-failed'(payload: { sessionId: SessionId; error: unknown }): void
  }
}

/**
 * One launcher-selected session identity for a configured agent. `resume`
 * distinguishes rehydrating existing persisted history from creating the
 * session fresh under that exact id, which the two config keys express as
 * `resumeSessionId` and `sessionId`.
 */
export interface LauncherAgentIdentity {
  /** Exact session id to create fresh or resume. */
  id: SessionId
  /** Resume existing persisted history instead of creating the session fresh. */
  resume: boolean
}

/** Launcher-selected identities keyed by the configured agent's `id`. */
export interface ConfiguredAgentIdentities extends Readonly<Record<string, LauncherAgentIdentity>> {}

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, identities)`) to fix
 * configured agents' session identities without a config key, so an overlay
 * repointing the row's model route cannot drop them.
 */
export const CONFIGURED_AGENT_IDENTITIES_KEY = 'configuredAgentIdentities'

/**
 * Apply launcher-owned identities over the configured agents, replacing both
 * identity keys for every entry the launcher named so a config-supplied
 * identity can never survive alongside a launcher-supplied one.
 * @param agents - the configured agent entries.
 * @param identities - launcher identities keyed by configured agent `id`, or `undefined`.
 * @returns the entries with launcher-owned identities applied.
 */
function applyLauncherIdentities(
  agents: Config['agents'],
  identities: ConfiguredAgentIdentities | undefined,
): Config['agents'] {
  if (identities === undefined) return agents
  return agents.map((agent) => {
    const identity = identities[agent.id]
    if (identity === undefined) return agent
    const { sessionId: _sessionId, resumeSessionId: _resumeSessionId, ...rest } = agent
    return identity.resume
      ? { ...rest, resumeSessionId: identity.id }
      : { ...rest, sessionId: identity.id }
  })
}

/** Agent-loop plugin configuration. */
export interface Config {
  /**
   * Maximum parallel-safe calls in flight per agent step. `1` is serial;
   * omission defaults to {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}.
   */
  maxParallelToolCalls: Volatile<number>
  /** Agents created or resumed at plugin startup. */
  agents: (AgentOptions & {
    /** Stable config label used in logs and as the fresh combined-id prefix. */
    id: string
    /** Optional stable identity; remounts resume its materialized history, while first use creates it fresh. */
    sessionId?: SessionId
    /** Optional workspace for a fresh session. */
    cwd?: string
    /** Persisted session to resume instead of creating a fresh session. */
    resumeSessionId?: SessionId
  })[]
}

/** Reject self-contained identity conflicts before any configured agent starts. */
function validateConfiguredAgents(agents: Config['agents']): void {
  const exactIdentities = new Map<SessionId, string>()
  for (const { id, sessionId, resumeSessionId } of agents) {
    const hasResumeId = resumeSessionId !== undefined && resumeSessionId !== ''
    if (sessionId !== undefined && hasResumeId) {
      throw new Error(`agent "${id}": sessionId and resumeSessionId are mutually exclusive`)
    }
    const exactIdentity = hasResumeId ? resumeSessionId : sessionId
    if (exactIdentity === undefined) continue
    const firstId = exactIdentities.get(exactIdentity)
    if (firstId !== undefined) {
      throw new Error(`agents "${firstId}" and "${id}" use duplicate exact session identity "${exactIdentity}"`)
    }
    exactIdentities.set(exactIdentity, id)
  }
}

/**
 * The loop's host: constructs a {@link ReactLoopAgent} for each prepared
 * session inside the shared create/resume/publish transaction, and registers
 * itself as the `ctx.agents` factory. It also exposes the factory-owned
 * ownership queries and the explicit-persistence resume the service's
 * configured-agent paths need.
 */
class LoopAgentHost extends ExternalAgentHost<ReactLoopAgent> {
  /** @param ctx - the agent-loop service's registration context. */
  constructor(ctx: Context) {
    // The loop reads durable `model/selection` through the session
    // controller's own fold, so the foreign-harness fold stays out of its
    // sessions and their projection state.
    super(ctx, 'agent loop', {
      harness: {
        id: HarnessId('dsh'),
        name: 'DSH Loop',
        description: 'DeepSeek Harness runs its own in-process agent loop',
        hostsLoopComposition: true,
      },
      modelSelection: false,
      effectPrefix: 'agentLoop',
    })
  }

  /**
   * @param hostCtx - the factory service's context (scope minting parent).
   * @param id - the shared agent/session identity.
   * @param options - per-agent model and request options.
   * @param session - the prepared, unpublished session.
   * @returns the loop agent for this session.
   */
  protected constructAgent(
    hostCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ): ReactLoopAgent {
    return new ReactLoopAgent(hostCtx, id, options, session)
  }

  /** Whether the factory still owns live lifecycles. */
  isActive(): boolean {
    return this.ownership.isActive()
  }

  /** Resolve `job`, or stop waiting when factory teardown begins. */
  waitWhileActive(job: Promise<void>): Promise<void> {
    return this.ownership.waitWhileActive(job)
  }

  /** Join declarative-start work that begins before any agent exists. */
  trackStartup(job: Promise<void>): void {
    this.ownership.trackStartup(job)
  }

  /**
   * Resume through an explicit persistence handle: the configured-agent
   * restore path resolves persistence before it knows whether the identity
   * exists.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param persistence - mounted persistence backend.
   * @param options - persisted identity and loop options.
   * @returns the published handle.
   */
  resumeThrough(
    ownerCtx: Context,
    persistence: SessionPersistence,
    options: ResumeAgentOptions,
  ): Promise<AgentHandle> {
    return this.resumeWith(ownerCtx, persistence, options)
  }
}

/** Concrete agent factory and driver service. */
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

  /** Runtime schema for declarative agents. */
  static Config: z<{ agents?: Config['agents']; maxParallelToolCalls?: number }, Config> = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS).volatile(),
    agents: z.array(z.object({
      id: z.string().required(),
      sessionId: z.string().min(1),
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
      maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      cwd: z.string(),
      resumeSessionId: z.string(),
    })).default([]),
  }) as z<{ agents?: Config['agents']; maxParallelToolCalls?: number }, Config>

  /** Validated configuration owned by the agent-loop service. */
  readonly config: Config
  /** The shared agent lifecycle transaction, registered as the `ctx.agents` factory. */
  private readonly host: LoopAgentHost

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentLoop')

    this.config = {
      agents: applyLauncherIdentities(config.agents, ctx.get(CONFIGURED_AGENT_IDENTITIES_KEY)),
      maxParallelToolCalls: config.maxParallelToolCalls,
    }
    validateConfiguredAgents(this.config.agents)
    // Register only after every config validation above has passed, so a
    // rejected constructor leaves no projection unit behind. The host owns the
    // transaction, the turn-boundary projection, and the factory slot.
    this.host = new LoopAgentHost(ctx)
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)

    for (const { id, sessionId, cwd, resumeSessionId, ...options } of this.config.agents) {
      const meta = cwd === undefined ? {} : { cwd }
      if (resumeSessionId === undefined || resumeSessionId === '') {
        const configuredId = sessionId ?? brandString<SessionId>(`${id}-session-${randomUUID()}`)
        const persistence = sessionId === undefined ? undefined : ctx.get('sessionPersistence')
        if (persistence === undefined) {
          const startup = this.create(configuredId, options, meta).then(() => undefined, (error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
          })
          this.host.trackStartup(startup)
        } else {
          const startup = this.restoreOrCreateConfigured(ctx, persistence, configuredId, options, meta).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
          })
          this.host.trackStartup(startup)
        }
        continue
      }
      ctx.effect(() => {
        const fiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
          void this.host.resumeThrough(ctx, childCtx.sessionPersistence, {
            resumeSessionId,
            agentOptions: options,
          }).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'resume', resumeSessionId, error)
          })
        })
        return fiber.dispose
      }, `agentLoop.resume(${id})`)
    }
  }

  /** Report a contained declarative-start failure to identity-bound consumers. */
  private reportConfiguredStartupFailure(
    configId: string,
    action: 'restore' | 'resume',
    sessionId: SessionId,
    error: unknown,
  ): void {
    if (!this.host.isActive()) return
    this.ctx.logger.warn(`agent "${configId}": config-driven ${action} of "${sessionId}" failed: ${errorChain(error)}`)
    const args: unknown[] = ['agent-loop/config-start-failed', { sessionId, error }]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((listenerError: unknown) => {
          this.ctx.logger.warn(`agent "${configId}": config-start-failed listener rejected: ${errorChain(listenerError)}`)
        })
      } catch (listenerError: unknown) {
        this.ctx.logger.warn(`agent "${configId}": config-start-failed listener threw: ${errorChain(listenerError)}`)
      }
    }
  }

  /** Restore a materialized exact config identity on remount, or create it on first use. */
  private async restoreOrCreateConfigured(
    ownerCtx: Context,
    persistence: SessionPersistence,
    sessionId: SessionId,
    agentOptions: AgentOptions,
    meta: Pick<SessionHeader, 'cwd'>,
  ): Promise<void> {
    await this.waitForDrainingConfiguredIdentity(ownerCtx, sessionId)
    if (!this.host.isActive()) return
    try {
      await this.host.resumeThrough(ownerCtx, persistence, { resumeSessionId: sessionId, agentOptions })
      return
    } catch (error: unknown) {
      if (!this.host.isActive()) return
      // Only a genuinely absent stored session falls back to first creation;
      // corruption, ownership conflicts, and backend failures stay loud.
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
    }
    await this.create(sessionId, agentOptions, meta)
  }

  /** Wait for a draining same-id lifecycle to finish registry teardown. */
  private async waitForDrainingConfiguredIdentity(ownerCtx: Context, sessionId: SessionId): Promise<void> {
    // Only an id still occupying a registry needs waiting for; a live healthy
    // occupant is a collision the create/resume below will surface itself.
    if (ownerCtx.agents.get(sessionId) === undefined && ownerCtx.sessions.get(sessionId) === undefined) return

    const released = Promise.withResolvers<void>()
    const checkReleased = (): void => {
      if (ownerCtx.agents.get(sessionId) === undefined && ownerCtx.sessions.get(sessionId) === undefined) {
        released.resolve()
      }
    }
    const disposeAgentListener = ownerCtx.on('agent/disposed', () => { checkReleased() })
    const disposeSessionListener = ownerCtx.on('session/disposed', checkReleased)
    try {
      checkReleased()
      await this.host.waitWhileActive(released.promise)
    } finally {
      disposeAgentListener()
      disposeSessionListener()
    }
  }

  /**
   * Create and publish a fresh agent around a caller-supplied session id.
   * @param id - shared agent/session identity.
   * @param options - concrete loop options.
   * @param meta - optional fresh-session workspace metadata.
   * @returns the published running agent.
   */
  async create(id: SessionId, options: AgentOptions = {}, meta: Pick<SessionHeader, 'cwd'> = {}): Promise<Agent> {
    const handle = await this.host.createAgent(this.ctx, { sessionId: id, agentOptions: options, meta })
    return handle.agent
  }

  /**
   * Create an owned agent on a caller-supplied session id. The registered
   * factory is the shared host; this delegate keeps the service's published
   * {@link AgentFactory} surface identical to it.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - identities, optional live parent, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    return this.host.createAgent(ownerCtx, options)
  }

  /**
   * Resume an owned agent from the configured persistence service. The
   * registered factory is the shared host; this delegate keeps the service's
   * published {@link AgentFactory} surface identical to it.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param options - persisted identity, optional live parent, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    return this.host.resume(ownerCtx, options)
  }
}

export default AgentLoop

/**
 * ACP multi-harness driver plugin: one shared ACP process per configured
 * harness, one `ctx.agents` factory per harness, one `ctx.llm` catalog route
 * per harness for the model picker, and the harness-scoped `acp` Remote family
 * (`status`, `login`, `logout`). Every harness is effect-scoped, so unloading
 * the plugin disposes each harness's own process.
 *
 * @module @deepseek-ai/dsh-agent-acp
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessId } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import {
  Remote,
  RemoteError,
  TypertRemoteService,
  type RemoteErrorCode,
} from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { AcpAgentConfig } from './agent.ts'
import { AcpCatalogAdapter } from './catalog.ts'
import {
  acpHarnessEntrySchema,
  DEFAULT_CATALOG_CACHE_MS,
  DEFAULT_CATALOG_FAILURE_CACHE_MS,
  DEFAULT_CLI_TIMEOUT_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_EOF_GRACE_MS,
  resolveHarnessEntries,
  type Config,
  type ResolvedAcpHarnessEntry,
} from './config.ts'
import { AcpAgentHost } from './host.ts'
import { AcpRuntime, type AcpRuntimeOptions } from './runtime.ts'
import type { AcpAccountSnapshot, AcpAuthMethod } from './types.ts'

export { AcpAgent, type AcpAgentConfig } from './agent.ts'
export { AcpCatalogAdapter } from './catalog.ts'
export { AcpClientConnection, type AcpSessionPeer } from './connection.ts'
export {
  acpHarnessEntrySchema,
  resolveHarnessEntries,
  type AcpHarnessEntry,
  type Config,
  type ResolvedAcpHarnessEntry,
} from './config.ts'
export { AcpAgentHost } from './host.ts'
export {
  acpAdvertisedModels,
  acpBlockToContent,
  acpModeOption,
  acpModelOption,
  acpPermissionOutcome,
  acpPrefix,
  acpReasoningOption,
  acpSelectEntries,
  acpToolContent,
  acpTurnEnding,
  ACP_PREFIX,
  AcpProtocolError,
  toAcpPromptBlocks,
  type AcpSelectEntry,
  type AcpSelectOption,
  type AcpSessionAdvert,
} from './protocol.ts'
export { AcpRuntime, type AcpRuntimeOptions } from './runtime.ts'
export {
  acpSessionOf,
  acpSessionProjection,
  type AcpSessionState,
} from './session-state.ts'
export type { AcpAccountSnapshot, AcpAuthMethod, AcpCatalogModel } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The ACP session driver: per-harness agent factories plus the harness-scoped auth Remote. */
    acpHarness: AcpHarness
  }
}

/** One mounted harness: its resolved entry and its own process runtime. */
interface MountedHarness {
  /** Resolved config entry with every deployment default applied. */
  readonly entry: ResolvedAcpHarnessEntry
  /** The ACP runtime owning this harness's process and connection. */
  readonly runtime: AcpRuntime
}

/**
 * The `acpHarness` service (`acp` Remote namespace). Owns one ACP runtime, one
 * agent-factory host, and one catalog adapter per configured harness, plus
 * every auth operation — none of which belong to a session.
 */
export class AcpHarness extends TypertRemoteService {
  static inject = [
    'agents',
    'sessions',
    'sessionProjections',
    'subprocess',
    'llm',
    'typert',
  ]

  /** Inline schema call: the config catalog walks `static Config` statically. */
  static Config: z<Config> = z.object({
    harnesses: z.array(acpHarnessEntrySchema).required(),
    disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
    eofGraceMs: z.number().default(DEFAULT_EOF_GRACE_MS),
    cliTimeoutMs: z.number().default(DEFAULT_CLI_TIMEOUT_MS),
    catalogCacheMs: z.number().default(DEFAULT_CATALOG_CACHE_MS),
    catalogFailureCacheMs: z.number().default(DEFAULT_CATALOG_FAILURE_CACHE_MS),
  })

  /** Mounted harnesses by id, in config order. */
  private readonly mounted = new Map<string, MountedHarness>()

  /**
   * @param ctx - the plugin fiber context.
   * @param config - resolved plugin config; every entry is validated here, once.
   */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'acpHarness', { namespace: 'acp' })
    for (const entry of resolveHarnessEntries(config)) {
      const runtime = new AcpRuntime(ctx, runtimeOptionsFor(entry, config))
      this.mounted.set(entry.id, { entry, runtime })
      // The host constructor owns its registrations: the acpSession
      // projection, shared transaction ownership, and this harness in
      // `ctx.agents`, all effect-scoped so unloading disposes only them.
      new AcpAgentHost(
        ctx, runtime, agentConfigFor(entry),
        entry.processPerSession ? () => new AcpRuntime(ctx, runtimeOptionsFor(entry, config)) : undefined,
      )
      ctx.effect(() => () => runtime.dispose(), `acpHarness(${entry.id}).dispose()`)
      ctx.effect(
        () => ctx.llm.registerAdapter([entry.id], new AcpCatalogAdapter(entry.id, entry.name, runtime)),
        `acpHarness(${entry.id}).catalog()`,
      )
    }
  }

  // ---- harness-scoped auth Remote surface ----

  /**
   * Read one harness's account state: the agent's advertised auth methods
   * plus the harness's own auth-status CLI verdict.
   * @param request - `{harness}` naming a mounted harness.
   * @param signal - caller lifetime.
   * @returns normalized account facts.
   */
  @Remote
  async status(request: { harness: string }, signal: AbortSignal): Promise<AcpAccountSnapshot> {
    const { runtime } = this.require(request.harness)
    try {
      const initialize = runtime.initializeInfo
      const cli = await runtime.authStatus(signal)
      const authMethods: AcpAuthMethod[] = (initialize?.authMethods ?? []).map(method => ({
        id: method.id,
        name: method.name,
        ...method.description === undefined || method.description === null
          ? {}
          : { description: method.description },
      }))
      const agentInfo = initialize?.agentInfo
      return {
        connected: initialize !== undefined,
        authMethods,
        cliLoggedIn: cli.loggedIn,
        cliDetail: cli.detail,
        ...agentInfo === undefined || agentInfo === null
          ? {}
          : {
            agentInfo: {
              name: agentInfo.name,
              ...agentInfo.title === undefined || agentInfo.title === null
                ? {}
                : { title: agentInfo.title },
              version: agentInfo.version,
            },
          },
      }
    } catch (error: unknown) {
      /* v8 ignore next -- authStatus converts every CLI failure into a value, so
         this arm has no producer on the current runtime. */
      throw asRemoteError('acp/auth-failed', error)
    }
  }

  /**
   * Start one harness's browser authentication flow (`devin-browser` on
   * Devin). A harness that has not connected yet is connected first, because
   * only its agent's initialize response names the method to start.
   * @param request - `{harness, methodId}`; the method defaults to the first one the harness advertised.
   * @param signal - caller lifetime.
   */
  @Remote('login')
  async login(request: { harness: string; methodId?: string }, signal: AbortSignal): Promise<void> {
    const { runtime } = this.require(request.harness)
    try {
      // A harness that has not connected yet advertises its auth methods only
      // in its initialize response, so connect before reading them.
      if (runtime.initializeInfo === undefined) await runtime.connect(signal)
    } catch (error: unknown) {
      throw asRemoteError('acp/login-failed', error)
    }
    const methodId = request.methodId ?? runtime.initializeInfo?.authMethods?.[0]?.id
    if (methodId === undefined || methodId.length === 0) {
      throw new RemoteError(
        'gateway/bad-request',
        `harness "${request.harness}" advertises no auth methods`,
        {},
      )
    }
    try {
      await runtime.authenticate(methodId, signal)
    } catch (error: unknown) {
      throw asRemoteError('acp/login-failed', error)
    }
  }

  /**
   * Sign one harness's account out — the ACP `logout` request when the agent
   * advertises it, the harness's auth-logout CLI otherwise.
   * @param request - `{harness}` naming a mounted harness.
   * @param signal - caller lifetime.
   */
  @Remote
  async logout(request: { harness: string }, signal: AbortSignal): Promise<void> {
    const { runtime } = this.require(request.harness)
    try {
      await runtime.logout(signal)
    } catch (error: unknown) {
      throw asRemoteError('acp/login-failed', error)
    }
  }

  /**
   * Resolve one mounted harness by id.
   * @param harness - harness id from the caller.
   * @returns the mounted harness.
   */
  private require(harness: string): MountedHarness {
    const mounted = this.mounted.get(harness)
    if (mounted === undefined) {
      throw new RemoteError(
        'gateway/bad-request',
        `unknown ACP harness ${JSON.stringify(harness)} (mounted: ${[...this.mounted.keys()].join(', ')})`,
        {},
      )
    }
    return mounted
  }
}

/** Resolve one entry's process options, applying the plugin-wide CLI deadline and graces. */
function runtimeOptionsFor(entry: ResolvedAcpHarnessEntry, config: Config): AcpRuntimeOptions {
  return {
    harness: entry.id,
    command: entry.executable,
    args: entry.args,
    cwd: entry.cwd ?? process.cwd(),
    env: entry.env,
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    eofGraceMs: config.eofGraceMs ?? DEFAULT_EOF_GRACE_MS,
    ...entry.catalogArgs === undefined ? {} : { catalogArgs: entry.catalogArgs },
    probeCatalog: entry.probeCatalog,
    authStatusArgs: entry.authStatusArgs,
    authLogoutArgs: entry.authLogoutArgs,
    cliTimeoutMs: config.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
    catalogCacheMs: config.catalogCacheMs ?? DEFAULT_CATALOG_CACHE_MS,
    catalogFailureCacheMs: config.catalogFailureCacheMs ?? DEFAULT_CATALOG_FAILURE_CACHE_MS,
  }
}

/** Bind one entry's identity and deployment defaults to the agents it constructs. */
function agentConfigFor(entry: ResolvedAcpHarnessEntry): AcpAgentConfig {
  return {
    harness: {
      id: HarnessId(entry.id),
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      // The catalog adapter this plugin registers under the same id.
      modelProvider: entry.id,
    },
    sandbox: entry.sandbox,
    approval: entry.approval,
    ...entry.cwd === undefined ? {} : { cwd: entry.cwd },
    ...entry.mode === undefined ? {} : { mode: entry.mode },
    ...entry.model === undefined ? {} : { model: entry.model },
    ...entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort },
  }
}

/** Wrap a runtime failure as a Remote error under one ACP code. */
function asRemoteError(code: RemoteErrorCode, error: unknown): RemoteError {
  return new RemoteError(code, errorChain(error), {})
}

export default AcpHarness

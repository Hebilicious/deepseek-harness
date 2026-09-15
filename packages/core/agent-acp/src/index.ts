/**
 * ACP session driver plugin: one shared `devin acp`-shape process per
 * profile, one `ctx.agents` factory binding every session to its own ACP
 * session, the `devin` catalog route for the model picker, and the
 * connection-global auth Remote the settings panel drives.
 *
 * @module @deepseek-ai/dsh-agent-acp
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
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
import { DevinCatalogAdapter } from './catalog.ts'
import { AcpAgentHost } from './host.ts'
import { ACP_PROVIDER } from './protocol.ts'
import { AcpRuntime, type AcpRuntimeOptions } from './runtime.ts'
import type { DevinAccountSnapshot, DevinAuthMethod } from './types.ts'

export { AcpAgent, type AcpAgentConfig } from './agent.ts'
export { DevinCatalogAdapter } from './catalog.ts'
export { AcpClientConnection, type AcpSessionPeer } from './connection.ts'
export { AcpAgentHost } from './host.ts'
export {
  acpBlockToContent,
  acpModeOption,
  acpModelOption,
  acpPermissionOutcome,
  acpToolContent,
  acpTurnEnding,
  ACP_PREFIX,
  ACP_PROVIDER,
  AcpProtocolError,
  toAcpPromptBlocks,
} from './protocol.ts'
export {
  AcpRuntime,
  type AcpRuntimeOptions,
  type DevinModelEntry,
} from './runtime.ts'
export {
  acpSessionOf,
  acpSessionProjection,
  type AcpSessionState,
} from './session-state.ts'
export type { DevinAccountSnapshot, DevinAuthMethod } from './types.ts'

/** Plugin config; every field optional — `static Config` supplies defaults. */
export interface Config {
  /** Harness executable name or absolute path (default `devin`). */
  executable?: string
  /** Arguments after the executable (default `['acp']`). */
  args?: string[]
  /** Working directory for the harness process itself; sessions carry their own cwd. */
  cwd?: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  env?: Record<string, string>
  /** Filesystem sandbox for sessions that log no `sandbox/mode` override (default `workspace-write`). */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Approval routing for sessions that log no `approval/policy` override (default `ask`). */
  approval?: 'ask' | 'never'
  /** Deployment default for the session's `mode` config option. */
  mode?: string
  /** Deployment default model beneath the session's `model/selection`. */
  model?: string
  /** Grace in milliseconds between managed-range termination tiers (default 5000). */
  disposeGraceMs?: number
  /** Tier-1 window in milliseconds after stdin EOF before escalation (default 2000). */
  eofGraceMs?: number
  /** Model-catalog CLI arguments (default `['models', 'list', '--format', 'json']`). */
  modelsArgs?: string[]
  /** Auth-status CLI arguments (default `['auth', 'status']`). */
  authStatusArgs?: string[]
  /** Auth-logout CLI arguments (default `['auth', 'logout']`). */
  authLogoutArgs?: string[]
}

const DEFAULT_DISPOSE_GRACE_MS = 5000
const DEFAULT_EOF_GRACE_MS = 2000

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The ACP session driver: agent factory host plus connection-global auth Remote. */
    acpHarness: AcpHarness
  }
}

/**
 * The `acpHarness` service (`acp` Remote namespace). Owns the shared `devin
 * acp` process and connection, the agent-factory host, the `devin` catalog
 * adapter, and every auth operation — none of which belong to a session.
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
    executable: z.string().min(1).default('devin'),
    args: z.array(z.string()).default(['acp']),
    cwd: z.string().min(1),
    env: z.dict(z.string()).default({}),
    sandbox: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const)
      .default('workspace-write'),
    approval: z.union(['ask', 'never'] as const).default('ask'),
    mode: z.string().min(1),
    model: z.string().min(1),
    disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
    eofGraceMs: z.number().default(DEFAULT_EOF_GRACE_MS),
    modelsArgs: z.array(z.string()).default(['models', 'list', '--format', 'json']),
    authStatusArgs: z.array(z.string()).default(['auth', 'status']),
    authLogoutArgs: z.array(z.string()).default(['auth', 'logout']),
  })

  private readonly runtime: AcpRuntime

  /**
   * @param ctx - the plugin fiber context.
   * @param config - resolved plugin config.
   */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'acpHarness', { namespace: 'acp' })
    const runtimeOptions: AcpRuntimeOptions = {
      command: config.executable ?? 'devin',
      args: config.args ?? ['acp'],
      cwd: config.cwd ?? process.cwd(),
      env: config.env ?? {},
      disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
      eofGraceMs: config.eofGraceMs ?? DEFAULT_EOF_GRACE_MS,
      modelsArgs: config.modelsArgs ?? ['models', 'list', '--format', 'json'],
      authStatusArgs: config.authStatusArgs ?? ['auth', 'status'],
      authLogoutArgs: config.authLogoutArgs ?? ['auth', 'logout'],
    }
    this.runtime = new AcpRuntime(ctx, runtimeOptions)
    const agentConfig: AcpAgentConfig = {
      sandbox: config.sandbox ?? 'workspace-write',
      approval: config.approval ?? 'ask',
      ...config.cwd === undefined ? {} : { cwd: config.cwd },
      ...config.mode === undefined ? {} : { mode: config.mode },
      ...config.model === undefined ? {} : { model: config.model },
    }
    // The host constructor owns its registrations: the acpSession
    // projection, shared transaction ownership, and `agents.setFactory`.
    new AcpAgentHost(ctx, this.runtime, agentConfig)
    ctx.effect(() => () => this.runtime.dispose(), 'acpHarness.dispose()')
    ctx.effect(
      () => ctx.llm.registerAdapter([ACP_PROVIDER], new DevinCatalogAdapter(this.runtime)),
      'acpHarness.catalog()',
    )
  }

  // ---- connection-global auth Remote surface ----

  /**
   * Read the Devin account state: the agent's advertised auth methods plus
   * the `devin auth status` CLI verdict.
   * @param signal - caller lifetime.
   * @returns normalized account facts.
   */
  @Remote
  async status(signal: AbortSignal): Promise<DevinAccountSnapshot> {
    try {
      const initialize = this.runtime.initializeInfo
      const cli = await this.runtime.authStatus(signal)
      const authMethods: DevinAuthMethod[] = (initialize?.authMethods ?? []).map(method => ({
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
      throw asRemoteError('acp/auth-failed', error)
    }
  }

  /**
   * Start the agent's browser authentication flow (`devin-browser`).
   * @param request - `{methodId}`; defaults to the first advertised method.
   * @param signal - caller lifetime.
   */
  @Remote('login')
  async login(request: { methodId?: string }, signal: AbortSignal): Promise<void> {
    const initialize = this.runtime.initializeInfo
    const methodId = request.methodId ?? initialize?.authMethods?.[0]?.id
    if (methodId === undefined || methodId.length === 0) {
      throw new RemoteError('gateway/bad-request', 'the agent advertises no auth methods', {})
    }
    try {
      await this.runtime.authenticate(methodId, signal)
    } catch (error: unknown) {
      throw asRemoteError('acp/login-failed', error)
    }
  }

  /**
   * Sign the Devin account out through the agent's `logout` method, falling
   * back to the `devin auth logout` CLI when the connection is down.
   * @param signal - caller lifetime.
   */
  @Remote
  async logout(signal: AbortSignal): Promise<void> {
    try {
      if (this.runtime.active !== undefined) await this.runtime.logout(signal)
      else await this.runtime.authLogout(signal)
    } catch (error: unknown) {
      throw asRemoteError('acp/login-failed', error)
    }
  }
}

/** Wrap a runtime failure as a Remote error under one ACP code. */
function asRemoteError(code: RemoteErrorCode, error: unknown): RemoteError {
  const message = error instanceof Error ? error.message : String(error)
  return new RemoteError(code, message, {})
}

export default AcpHarness

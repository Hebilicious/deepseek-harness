/**
 * The Codex `AgentFactory` host for one configured instance: binds that
 * instance's app-server runtime and driver deployment config into every
 * constructed {@link CodexAgent}, registers the instance's harness identity
 * under its id, and registers the durable thread-binding projection the
 * resume path folds.
 *
 * @module @deepseek-ai/dsh-agent-codex/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ExternalAgentHost } from '@deepseek-ai/dsh-agent-external'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CodexAgent, type CodexAgentConfig } from './agent.ts'
import { CODEX_PREFIX, type CodexAppServerRuntime } from './runtime.ts'
import { codexThreadProjection } from './thread-state.ts'

/**
 * One instance's Codex factory host. Construction registers the
 * `codexThread` projection, the shared transaction ownership, and this
 * instance in `ctx.agents` — all effect-scoped to the plugin fiber — then
 * every create/resume runs the shared unpublished-preparation → bind →
 * publish transaction.
 */
export class CodexAgentHost extends ExternalAgentHost<CodexAgent> {
  /**
   * @param ctx - the plugin service's registration context.
   * @param runtime - this instance's app-server runtime.
   * @param config - resolved driver deployment defaults, including the harness identity.
   */
  constructor(
    ctx: Context,
    private readonly codexRuntime: CodexAppServerRuntime,
    private readonly agentConfig: CodexAgentConfig,
  ) {
    super(ctx, `${CODEX_PREFIX}[${agentConfig.harness.id}]`, {
      harness: agentConfig.harness,
      effectPrefix: `codexAppServer.${agentConfig.harness.id}`,
      announceBeforeBind: true,
    })
    ctx.sessionProjections.register(codexThreadProjection)
  }

  /** Construct the driver around this instance's runtime and resolved config. */
  protected override constructAgent(
    hostCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ): CodexAgent {
    return new CodexAgent(hostCtx, id, options, session, this.codexRuntime, this.agentConfig)
  }
}

/**
 * The Codex `AgentFactory` host: binds the shared app-server runtime and the
 * driver deployment config into every constructed {@link CodexAgent}, and
 * registers the durable thread-binding projection the resume path folds.
 *
 * @module @deepseek-ai/dsh-agent-codex/host
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessId, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { ExternalAgentHost } from '@deepseek-ai/dsh-agent-external'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CodexAgent, type CodexAgentConfig } from './agent.ts'
import { CODEX_PREFIX, type CodexAppServerRuntime } from './runtime.ts'
import { codexThreadProjection } from './thread-state.ts'

/**
 * Codex factory host. Construction registers the `codexThread` projection,
 * the shared transaction ownership, and `ctx.agents.setFactory` — all
 * effect-scoped to the plugin fiber — then every create/resume runs the
 * shared unpublished-preparation → bind → publish transaction.
 */
export class CodexAgentHost extends ExternalAgentHost<CodexAgent> {
  /**
   * @param ctx - the plugin service's registration context.
   * @param runtime - the profile's shared app-server runtime.
   * @param config - resolved driver deployment defaults.
   */
  constructor(
    ctx: Context,
    private readonly codexRuntime: CodexAppServerRuntime,
    private readonly agentConfig: CodexAgentConfig,
  ) {
    super(ctx, CODEX_PREFIX, {
      harness: {
        id: HarnessId('codex'),
        name: 'Codex',
        description: 'OpenAI Codex runs the session through codex app-server',
      },
    })
    ctx.sessionProjections.register(codexThreadProjection)
  }

  /** Construct the driver around the shared runtime and resolved config. */
  protected override constructAgent(
    hostCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ): CodexAgent {
    return new CodexAgent(hostCtx, id, options, session, this.codexRuntime, this.agentConfig)
  }
}

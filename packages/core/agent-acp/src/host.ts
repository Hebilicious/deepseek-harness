/**
 * The ACP `AgentFactory` host: binds the shared `devin acp` runtime and the
 * driver deployment config into every constructed {@link AcpAgent}, and
 * registers the durable session-binding projection the resume path folds.
 *
 * @module @deepseek-ai/dsh-agent-acp/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ExternalAgentHost } from '@deepseek-ai/dsh-agent-external'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { AcpAgent, type AcpAgentConfig } from './agent.ts'
import { ACP_PREFIX } from './protocol.ts'
import type { AcpRuntime } from './runtime.ts'
import { acpSessionProjection } from './session-state.ts'

/**
 * ACP factory host. Construction registers the `acpSession` projection, the
 * shared transaction ownership, and `ctx.agents.setFactory` — all
 * effect-scoped to the plugin fiber — then every create/resume runs the
 * shared unpublished-preparation → bind → publish transaction.
 */
export class AcpAgentHost extends ExternalAgentHost<AcpAgent> {
  /**
   * @param ctx - the plugin service's registration context.
   * @param runtime - the profile's shared ACP runtime.
   * @param config - resolved driver deployment defaults.
   */
  constructor(
    ctx: Context,
    private readonly acpRuntime: AcpRuntime,
    private readonly agentConfig: AcpAgentConfig,
  ) {
    super(ctx, ACP_PREFIX)
    ctx.sessionProjections.register(acpSessionProjection)
  }

  /** Construct the driver around the shared runtime and resolved config. */
  protected override constructAgent(
    hostCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ): AcpAgent {
    return new AcpAgent(hostCtx, id, options, session, this.acpRuntime, this.agentConfig)
  }
}

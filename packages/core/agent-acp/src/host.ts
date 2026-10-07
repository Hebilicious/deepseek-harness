/**
 * The ACP `AgentFactory` host: binds one harness's shared ACP runtime and
 * driver deployment config into every constructed {@link AcpAgent}, registers
 * the harness identity the agent registry dispatches by, and registers the
 * durable session-binding projection the resume path folds.
 *
 * @module @deepseek-ai/dsh-agent-acp/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ExternalAgentHost } from '@deepseek-ai/dsh-agent-external'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { AcpAgent, type AcpAgentConfig } from './agent.ts'
import { acpPrefix } from './protocol.ts'
import type { AcpRuntime } from './runtime.ts'
import { acpSessionProjection } from './session-state.ts'

/**
 * One harness's ACP factory host. Construction registers the `acpSession`
 * projection, the shared transaction ownership, and the harness in
 * `ctx.agents` — all effect-scoped to the plugin fiber — then every
 * create/resume runs the shared unpublished-preparation → bind → publish
 * transaction.
 */
export class AcpAgentHost extends ExternalAgentHost<AcpAgent> {
  /**
   * @param ctx - the plugin service's registration context.
   * @param runtime - this harness's shared ACP runtime.
   * @param config - resolved driver deployment defaults, including the harness identity.
   * @param sessionRuntime - builds a private runtime for each agent when the
   *   harness runs one process per session; omitted, agents share `runtime`.
   */
  constructor(
    ctx: Context,
    private readonly acpRuntime: AcpRuntime,
    private readonly agentConfig: AcpAgentConfig,
    private readonly sessionRuntime?: () => AcpRuntime,
  ) {
    super(ctx, acpPrefix(agentConfig.harness.id), {
      harness: agentConfig.harness,
      effectPrefix: `acpHarness.${agentConfig.harness.id}`,
      announceBeforeBind: true,
    })
    ctx.sessionProjections.register(acpSessionProjection)
  }

  /** Construct the driver around its runtime — private per session or this harness's shared one — and resolved config. */
  protected override constructAgent(
    hostCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ): AcpAgent {
    const own = this.sessionRuntime?.()
    return own === undefined
      ? new AcpAgent(hostCtx, id, options, session, this.acpRuntime, this.agentConfig)
      : new AcpAgent(hostCtx, id, options, session, own, this.agentConfig, this.acpRuntime)
  }
}

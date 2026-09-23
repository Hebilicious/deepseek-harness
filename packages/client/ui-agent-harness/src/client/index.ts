/**
 * Agent-harness surface plugin, browser half: one chip on the new-session
 * screen for the harness the next session runs.
 *
 * Which harness runs a session is fixed at creation. The host mounts the
 * harnesses this deployment can run and refuses a create request that names
 * an unmounted one, so the chip reads the catalog once per connection and
 * stages a choice through the Session Controller: the create request the
 * Workspace flow sends carries it, and after that the session's own record is
 * the only answer.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge (the generated Remote namespaces).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the Session Controller client service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the ui-conversation SlotMap merge (the hero seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the slot registry's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { AgentHarnessSeat } from './AgentHarnessSeat.tsx'
import { HarnessBadgeSeat } from './HarnessBadgeSeat.tsx'
import type { HarnessBadgeSeatInjected } from './HarnessBadgeSeat.tsx'
import type { AgentHarnessSeatInjected } from './AgentHarnessSeat.tsx'
import { AgentHarnessSeatController } from './seat-store.ts'
import { en, type AgentHarnessKey, zh } from './locales.ts'

/** Locale namespace owning the agent-harness seat copy. */
export const AGENT_HARNESS_NS = 'agentHarness'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** New-session agent-harness picker copy. */
    'agentHarness': AgentHarnessKey
  }
}

export type { AgentHarnessSeatInjected, AgentHarnessSeatProps } from './AgentHarnessSeat.tsx'
export type { HarnessBadgeSeatInjected, HarnessBadgeSeatProps } from './HarnessBadgeSeat.tsx'
export type { AgentHarnessSeatState } from './seat-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'sessions', 'locale', 'remote', 'remote.session']

/**
 * Mount the new-session harness chip.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new AgentHarnessSeatController(ctx)
  // A wire call that rejects leaves the seat on the catalog it already had.
  const refresh = (): void => {
    void controller.load().catch(() => { /* the seat keeps its previous snapshot */ })
  }

  ctx.effect(
    () => ctx.locale.register(AGENT_HARNESS_NS, { zh, en }),
    'ui-agent-harness: seat dictionaries',
  )
  ctx.effect(
    () => ctx.on('connection/reset', refresh),
    'ui-agent-harness: catalog refresh',
  )

  ctx.slots.inject('conversation.hero.agentHarness', () => ctx.slots.register({
    name: 'conversation.hero.agentHarness',
    locale: AGENT_HARNESS_NS,
    inject: (): AgentHarnessSeatInjected => ({
      hooks: { agentHarnessSeat: controller.store },
      load: () => controller.load(),
      bindable: sessionId => controller.bindable(sessionId),
      // The pick may need to reach the host, so the seat does not wait on it:
      // a failed binding leaves the chip on the harness it already showed.
      select: (sessionId, harness) => {
        void controller.apply(sessionId, harness).catch(() => { /* the chip keeps its state */ })
      },
    }),
  }, AgentHarnessSeat))

  ctx.slots.inject('conversation.session.header.harness', () => ctx.slots.register({
    name: 'conversation.session.header.harness',
    locale: AGENT_HARNESS_NS,
    inject: (): HarnessBadgeSeatInjected => ({
      hooks: { agentHarnessSeat: controller.store },
      load: () => controller.load(),
    }),
  }, HarnessBadgeSeat))

  // The catalog is read before the chip can render: a New Session started from
  // anywhere else in the shell still sends the create request a deployment
  // that mounts several harnesses requires.
  refresh()
}

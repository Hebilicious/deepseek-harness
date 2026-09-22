/**
 * New-session harness controller: the mounted harness catalog plus the choice
 * staged for the next session.
 *
 * The new-session screen has no session, so a pick is staged rather than
 * applied. It reaches a session through the create request the Workspace flow
 * sends (`ctx.sessions.stageHarness`), because a session's harness is fixed
 * when it is created: another harness cannot continue the conversation.
 *
 * The stage is not consumed by that create. A deployment that mounts several
 * harnesses refuses a create that names none, so the choice stays staged until
 * the picker replaces it and every later new session starts from it.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HarnessId } from '@deepseek-ai/dsh-agent/types'
// Type-only: pulls the ctx.remote merge (the generated Remote namespaces).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the Session Controller client service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionHarnessOption } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Seat snapshot. */
export interface AgentHarnessSeatState {
  /** Mounted harnesses in registration order; empty until the catalog arrives. */
  harnesses: readonly SessionHarnessOption[]
  /** Harness staged for the next session, or null while nothing is mounted. */
  current: HarnessId | null
}

const INITIAL: AgentHarnessSeatState = { harnesses: [], current: null }

/** Reads the mounted harnesses and stages the picker's choice. */
export class AgentHarnessSeatController {
  /** Seat snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentHarnessSeatState> = createSnapshotStore(INITIAL)

  /** Only the newest catalog read may publish after overlapping refreshes. */
  private loadGeneration = 0

  /** @param ctx - the browser plugin context (Remote namespace and sessions service). */
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Read the mounted harnesses and stage the choice a new session starts from.
   *
   * A deployment that mounts fewer than two harnesses stages nothing: the host
   * resolves its sole harness for a create request that names none, so those
   * deployments keep the request they sent before this surface existed.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    const result = await this.ctx.remote.session.harnessCatalog()
    if (generation !== this.loadGeneration) return
    if (!result.ok) return
    const harnesses = [...result.value.harnesses]
    const current = this.retainedChoice(harnesses) ?? null
    this.store.set({ harnesses, current })
    // A deployment that mounts fewer than two harnesses stages nothing: the
    // host resolves its sole harness for a create request that names none, so
    // those deployments keep the request they sent before this surface existed.
    if (current === null || harnesses.length < 2) return
    this.ctx.sessions.stageHarness(current)
  }

  /**
   * Stage one harness for the next session.
   * @param harness - mounted harness the picker chose.
   */
  select(harness: HarnessId): void {
    this.store.set({ ...this.store.getSnapshot(), current: harness })
    this.ctx.sessions.stageHarness(harness)
  }

  /**
   * The staged choice while the deployment still mounts it, otherwise the
   * first mounted harness — the catalog's registration order is the only
   * order the host publishes.
   */
  private retainedChoice(harnesses: readonly SessionHarnessOption[]): HarnessId | undefined {
    const previous = this.store.getSnapshot().current
    if (previous !== null && harnesses.some(entry => entry.id === previous)) return previous
    return harnesses[0]?.id
  }
}

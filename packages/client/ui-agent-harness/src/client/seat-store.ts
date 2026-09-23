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
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
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
    // Clearing matters as much as staging: a stage left over from a catalog
    // that no longer mounts that harness would be sent by the next create and
    // refused, with no picker on screen to correct it.
    this.ctx.sessions.stageHarness(current !== null && harnesses.length >= 2 ? current : undefined)
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
   * Apply one pick: a provisional Session on screen takes the harness as its
   * own binding, and every other surface stages it for the next Session.
   * @param sessionId - Session identity on screen, or `undefined` for none yet.
   * @param harness - mounted harness the picker chose.
   * @returns the Session that now runs the harness, when the caller must show
   *   another one than the Session it was looking at.
   */
  async apply(sessionId: SessionId | undefined, harness: HarnessId): Promise<SessionId | undefined> {
    if (sessionId === undefined || !this.bindable(sessionId)) {
      this.select(harness)
      return undefined
    }
    const bound = await this.bind(sessionId, harness)
    return bound === sessionId ? undefined : bound
  }

  /**
   * Whether the Session on screen is still provisional: the Workspace flow
   * publishes it before its owner picks a harness, and the first message ends
   * the window. Read on demand because the chip does not observe that edge.
   * @param sessionId - Session identity on screen, or `undefined` for none yet.
   * @returns true while the chip should offer the mounted harnesses.
   */
  bindable(sessionId: SessionId | undefined): boolean {
    return sessionId !== undefined && this.ctx.sessions.harnessProvisional(sessionId)
  }

  /**
   * Record one harness on the provisional Session on screen, which is the only
   * way a choice reaches a Session the Workspace flow already published.
   * @param sessionId - provisional Session identity.
   * @param harness - mounted harness the picker chose.
   * @returns the Session the choice now lives on.
   */
  async bind(sessionId: SessionId, harness: HarnessId): Promise<SessionId> {
    // A replacement has to land in the Workspace the Session belonged to, or
    // the shell would show it ungrouped with a composer that has no Workspace.
    const bound = await this.ctx.sessions.bindHarness(sessionId, harness, this.workspaceOwning(sessionId))
    // The pick also becomes the choice later Sessions start from: a reader who
    // switched to another harness for this Session asked for that harness.
    this.ctx.sessions.stageHarness(harness)
    this.store.set({ ...this.store.getSnapshot(), current: harness })
    return bound
  }

  /**
   * The Workspace that accounts for a Session, read from the Workspace
   * Controller's own list. A replacement Session has to be published into it,
   * and the list is the only place the browser records that membership.
   * @param sessionId - Session whose Workspace is required.
   * @returns the owning Workspace id, or `undefined` while none accounts for it.
   */
  private workspaceOwning(sessionId: SessionId): WorkspaceId | undefined {
    const workspaces: { list: { getSnapshot(): { items: readonly { workspaceId: WorkspaceId; sessionIds: readonly SessionId[] }[] } } }
      | undefined = this.ctx.get('workspaces')
    return workspaces?.list.getSnapshot().items
      .find(item => item.sessionIds.includes(sessionId))?.workspaceId
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

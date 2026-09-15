/**
 * Shared machinery for agent drivers that run a foreign harness process as
 * the session's agent: durable inbox, turn/step boundary projection,
 * assistant-stream settlement, the create/resume/publish lifecycle
 * transaction, model-selection folding, and managed process teardown.
 *
 * A driver package subclasses {@link ExternalAgent} for its wire protocol and
 * {@link ExternalAgentHost} for its factory — the session shell (durable
 * transcript, approvals, notifications, lifecycle) stays identical to the
 * built-in loop's.
 *
 * @module @deepseek-ai/dsh-agent-external
 */

export { ExternalAgent, HARNESS_DEFAULT_MODEL } from './agent.ts'
export type { ExternalModelSelection, ExternalTurnDrive } from './agent.ts'
export { AssistantStreamAttempt } from './assistant-stream.ts'
export { ExternalAgentHost } from './host.ts'
export { DurableAgentInbox, inboxProjectionDefinition, inboxProjectionSchema } from './inbox.ts'
export { assertAgentOptions, FactoryOwnership, raceAbort, raceAbortCall } from './lifecycle.ts'
export {
  externalModelSelectionProjection,
  type ExternalModelSelectionState,
} from './model-selection.ts'
export { ExternalHarnessProcess } from './process.ts'
export type { ExternalHarnessSpawnRequest } from './process.ts'
export { ExternalTurnProjector } from './projector.ts'
export type { RouteLogState } from './projector.ts'
export { turnBoundaryProjectionDefinition } from './turn-boundary.ts'

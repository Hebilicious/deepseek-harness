/**
 * Shared machinery for agent drivers: the {@link ManagedAgent} session-facing
 * base every driver extends, durable inbox, turn/step boundary projection,
 * assistant-stream settlement, the create/resume/publish lifecycle
 * transaction, model-selection folding, and managed process teardown.
 *
 * A driver for a foreign harness subclasses {@link ExternalAgent} for its wire
 * protocol and {@link ExternalAgentHost} for its factory; the in-process loop
 * extends {@link ManagedAgent} directly and shares the same host. The session
 * shell (durable transcript, approvals, notifications, lifecycle) is identical
 * for every driver.
 *
 * @module @deepseek-ai/dsh-agent-external
 */

export { ExternalAgent, HARNESS_DEFAULT_MODEL } from './agent.ts'
export type { ExternalModelSelection, ExternalTurnDrive } from './agent.ts'
export { ManagedAgent } from './base.ts'
export type { RunningAgentPhase, TurnBodyOutcome } from './base.ts'
export { AssistantStreamAttempt } from './assistant-stream.ts'
export { ExternalAgentHost } from './host.ts'
export type { ExternalAgentHostOptions } from './host.ts'
export { raceAbort } from './lifecycle.ts'
export { ExternalHarnessProcess } from './process.ts'
export type { ExternalHarnessSpawnRequest } from './process.ts'
export { turnBoundaryProjectionDefinition } from './turn-boundary.ts'

/**
 * Shared machinery for agent drivers: the {@link ManagedAgent} session-facing
 * base every driver extends, durable inbox, assistant-stream settlement, the
 * create/resume/publish lifecycle transaction, model-selection folding, and
 * managed process teardown.
 *
 * A driver for a foreign harness subclasses {@link ExternalAgent} for its wire
 * protocol and {@link ExternalAgentHost} for its factory; the in-process loop
 * owns its own phase machine and factory transaction and shares the durable
 * inbox and assistant-stream settlement. The session
 * shell (durable transcript, approvals, notifications, lifecycle) is identical
 * for every driver.
 *
 * @module @deepseek-ai/dsh-agent-external
 */

export { ExternalAgent, HARNESS_DEFAULT_MODEL } from './agent.ts'
export type { ExternalModelSelection, ExternalTurnDrive } from './agent.ts'
export { ManagedAgent } from './base.ts'
export type { ManagedAgentProjections, RunningAgentPhase, TurnBodyOutcome } from './base.ts'
export { AssistantStreamAttempt } from './assistant-stream.ts'
export { ExternalAgentHost } from './host.ts'
export { DurableAgentInbox, inboxProjectionDefinition } from './inbox.ts'
export type { ExternalAgentHostOptions } from './host.ts'
export { raceAbort } from './lifecycle.ts'
export { ExternalHarnessProcess } from './process.ts'
export type { ExternalHarnessSpawnRequest } from './process.ts'

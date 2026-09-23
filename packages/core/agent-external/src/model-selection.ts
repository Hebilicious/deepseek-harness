/**
 * Internal projection folding the durable `model/selection` records the
 * session picker writes. The `SessionEventMap` member merges in only where
 * `dsh-api-session-controller` compiles, so the fold validates the payload
 * structurally at the log boundary instead of narrowing a union member.
 *
 * @module @deepseek-ai/dsh-agent-external/model-selection
 */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ExternalModelSelection } from './agent.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest validated model selection the session recorded, or null. */
    externalModelSelection: ExternalModelSelectionState
  }
}

/** Host fold state: the newest durable selection the agent should drive with. */
export interface ExternalModelSelectionState {
  /** Latest `model/selection` payload, or null when the log holds none. */
  readonly selection: ExternalModelSelection | null
}

// zod's optional field emits `| undefined`, which exactOptionalPropertyTypes
// keeps from satisfying `reasoningEffort?: string`; the erased schema keeps
// the runtime check while the state type keeps the stricter read side.
const externalModelSelectionStateSchema = z.object({
  selection: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).optional(),
  }).nullable(),
}) as unknown as z.ZodType<ExternalModelSelectionState>

/** Structurally narrow one committed `model/selection` payload. */
function readSelection(data: unknown): ExternalModelSelection | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof record.provider !== 'string' || record.provider === ''
    || typeof record.model !== 'string' || record.model === '') return null
  return {
    provider: record.provider,
    model: record.model,
    ...typeof record.reasoningEffort === 'string' && record.reasoningEffort !== ''
      ? { reasoningEffort: record.reasoningEffort }
      : {},
  }
}

/** Fold state for the newest durable `model/selection`; never a wire view. */
export const externalModelSelectionProjection = {
  key: 'externalModelSelection',
  stateVersion: 1,
  stateSchema: externalModelSelectionStateSchema,
  init: (): ExternalModelSelectionState => ({ selection: null }),
  apply(state, event) {
    // The member is merged by dsh-api-session-controller where it compiles;
    // the widened comparison keeps this fold honest in profiles without it.
    const type: string = event.type
    if (type !== 'model/selection') return state
    const selection = readSelection(event.data)
    if (selection === null) {
      throw new Error(`invalid persisted model/selection at session seq ${event.seq}`)
    }
    return state.selection !== null
      && state.selection.provider === selection.provider
      && state.selection.model === selection.model
      && state.selection.reasoningEffort === selection.reasoningEffort
      ? state
      : { selection }
  },
} satisfies ProjectionDefinition<'externalModelSelection', ExternalModelSelectionState>

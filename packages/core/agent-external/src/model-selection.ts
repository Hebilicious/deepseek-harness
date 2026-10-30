/**
 * Internal projection folding the durable `model/selection` records the
 * session picker writes through `Agent.model.select()`. Unlike the in-process
 * loop's `modelSelection` fold, a request header never retires the choice: a
 * foreign harness may report another model than it was sent.
 *
 * @module @deepseek-ai/dsh-agent-external/model-selection
 */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** Host fold state: the newest durable selection the agent should drive with. */
export interface ExternalModelSelectionState {
  /** Latest `model/selection` payload, or null when the log holds none. */
  readonly selection: ModelSelection | null
}

const externalModelSelectionStateSchema: z.ZodType<ExternalModelSelectionState> = z.object({
  selection: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).transform(ReasoningEffortId).exactOptional(),
  }).nullable(),
})

/** Structurally narrow one committed `model/selection` payload; the log is not trusted to match its type. */
function readSelection(data: unknown): ModelSelection | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof record.provider !== 'string' || record.provider === ''
    || typeof record.model !== 'string' || record.model === '') return null
  return {
    provider: record.provider,
    model: record.model,
    ...typeof record.reasoningEffort === 'string' && record.reasoningEffort !== ''
      ? { reasoningEffort: ReasoningEffortId(record.reasoningEffort) }
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
    if (event.type !== 'model/selection') return state
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

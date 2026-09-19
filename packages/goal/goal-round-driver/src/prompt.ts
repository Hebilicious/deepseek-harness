/** Model-visible continuation prompt for one same-session goal round. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GoalView } from '@deepseek-ai/dsh-goal'

/** Completion protocol selected by plugin configuration. */
export interface RoundPromptOptions {
  /**
   * Deployment-supplied protocol text, placed after the shared instruction
   * body and before the closing tag. Absent uses `STANDARD_PROTOCOL`.
   */
  readonly protocol?: string
}

/** Default protocol: leaving the goal active is how a round hands off to the next one. */
export const STANDARD_PROTOCOL =
  'goal, and mark it complete. If work remains, leave the goal active for the next round. Follow '
  + 'the configured goal-tool policy before reporting a blocker.\n'

/**
 * Render the complete goal-round instruction retained in session history.
 * @param goal - exact active goal revision being admitted.
 * @param round - next positive round number.
 * @param options - completion protocol; the default leaves the goal active for the next round.
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export function renderGoalRoundPrompt(
  goal: GoalView,
  round: number,
  options: RoundPromptOptions = {},
): ContentBlock[] {
  return [{
    type: 'text',
    text: '<goal_round>\n'
      + `Objective: ${JSON.stringify(goal.objective)}\n`
      + `Round: ${round}/${goal.maxGoalRounds}\n\n`
      + 'Continue working toward the objective in this same session. Treat the current workspace, '
      + 'tool results, and durable session state as authoritative; inspect them instead of assuming '
      + 'earlier narration is still current. Make concrete progress and verify the result. Before '
      + 'claiming completion, gather evidence that the whole objective is achieved, read the current '
      + (options.protocol ?? STANDARD_PROTOCOL)
      + '</goal_round>',
  }]
}

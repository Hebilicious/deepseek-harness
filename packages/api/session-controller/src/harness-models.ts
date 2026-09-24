/** Which agent harnesses can drive one LLM provider route. */

import type { AgentHarness, HarnessId } from '@deepseek-ai/dsh-agent/types'

/**
 * The harnesses a Session may run while selecting a model from one provider.
 *
 * A harness that declares a `modelProvider` owns that route alone: the route
 * lists its models and serves no model calls. Every other route is sent through
 * the deployment's LLM providers, so it serves exactly the harnesses that
 * declare no `modelProvider`.
 * @param harnesses - the mounted harnesses.
 * @param provider - one LLM provider route id.
 * @returns the ids of the harnesses that can drive `provider`, in registration order.
 */
export function harnessesServing(harnesses: readonly AgentHarness[], provider: string): HarnessId[] {
  const owner = harnesses.find(harness => harness.modelProvider === provider)
  if (owner !== undefined) return [owner.id]
  return harnesses.filter(harness => harness.modelProvider === undefined).map(harness => harness.id)
}

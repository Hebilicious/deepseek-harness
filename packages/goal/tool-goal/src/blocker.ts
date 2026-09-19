/**
 * Vocabulary screen for a model-reported goal blocker.
 *
 * A blocker names a condition of the work. The agent's own capacity is not a
 * condition of the work: compaction is automatic, the session continues, and
 * neither context nor token spend changes what the objective requires. A
 * `blocked_reason` built from capacity vocabulary is therefore refused unless
 * it also names something external to the agent.
 *
 * @module @deepseek-ai/dsh-tool-goal/blocker
 */

/** One vocabulary stem and its word-start match. */
interface Term {
  /** The stem reported in a refusal message. */
  readonly term: string
  /** Matches the stem at a word start, accepting ordinary suffixes such as plurals. */
  readonly pattern: RegExp
}

/** Capacity vocabulary the model may never report as its own blocker. */
const CAPACITY_VOCABULARY = [
  'context', 'token', 'budget', 'compact', 'session', 'exhausted', 'exhaustion',
]

/**
 * Vocabulary for conditions external to the agent: access the environment
 * denies, a credential or decision only a human can supply, or a product
 * requirement that cannot be satisfied. Resource limits such as a quota or
 * spend cap stay outside this list because they are capacity, not a condition
 * of the work.
 */
const EXTERNAL_VOCABULARY = [
  'access', 'deni', 'permission', 'credential', 'secret', 'password', 'login', 'oauth',
  'authentication', 'authenticate', 'authorization', 'authorize', 'certificate',
  'network', 'sandbox', 'firewall', 'proxy', 'server', 'provider', 'account', 'vendor',
  'upstream', 'external', 'remote', 'deploy', 'environment', 'provision', 'licen',
  'approv', 'human', 'user', 'customer', 'stakeholder', 'decision', 'decide', 'choice',
  'choose', 'confirm', 'clarif', 'answer', 'question', 'feedback', 'requir',
  'specification', 'product', 'acceptance', 'policy', 'legal', 'complian', 'regulat',
  'secur', 'audit',
]

/** Compile vocabulary stems into word-start matches. */
function vocabulary(terms: readonly string[]): readonly Term[] {
  return terms.map(term => ({ term, pattern: new RegExp(`\\b${term}\\w*`) }))
}

/** Terms of one vocabulary present in the reason text, in vocabulary order. */
function matched(text: string, terms: readonly Term[]): string[] {
  return terms.filter(item => item.pattern.test(text)).map(item => item.term)
}

const CAPACITY_TERMS = vocabulary(CAPACITY_VOCABULARY)
const EXTERNAL_TERMS = vocabulary(EXTERNAL_VOCABULARY)

/**
 * Identify a `blocked_reason` that reports the agent's own capacity instead of
 * a condition of the work.
 * @param reason - the model-supplied `blocked_reason` text.
 * @returns the matched capacity terms when the wording names capacity and no external condition, otherwise `undefined`.
 */
export function capacityExcuse(reason: string): string[] | undefined {
  const text = reason.toLowerCase()
  const capacity = matched(text, CAPACITY_TERMS)
  if (capacity.length === 0) return undefined
  return matched(text, EXTERNAL_TERMS).length > 0 ? undefined : capacity
}

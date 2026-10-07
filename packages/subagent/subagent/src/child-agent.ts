/**
 * Shared in-process child composition: the delegation-depth budget, the
 * durable session metadata, the resolved child `AgentOptions`, the delegated
 * policy seed, and the scoped setup a child agent needs. Both the one-shot
 * provider driver and the continuation manager compose children this way, so
 * depth accounting, lineage stamping, and delegation policy have one home.
 *
 * @module @deepseek-ai/dsh-subagent/child-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { harnessesServing, harnessOwning } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentOptions, CreateAgentOptions, HarnessId } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'
// Type-only: make `ctx.get('sandboxPolicy')`, `ctx.get('approval')`, and
// `ctx.get('permissionPresets')` resolve to their services when composed — delegation consumes them
// opportunistically (the documented `ctx.get` pattern), never as a hard dep —
// and merge the inherited permission session-event payloads.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
// Type-only: make `ctx.get('agentPresets')` resolve to the preset roster when
// composed — a child inherits its parent's composition opportunistically (the
// documented `ctx.get` pattern), never as a hard dep. A rosterless deployment
// keeps its model-facing rows on the host plane, where the child already sees
// them through the tool registry's global layer.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { delegationDepthOf } from './depth.ts'
import { SubagentError } from './error.ts'

/** Thrown when starting a child would exceed the requested depth cap. */
export class SubagentDepthError extends Error {
  constructor(public readonly attemptedDepth: number, public readonly maxDepth: number) {
    super(`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`)
    this.name = 'SubagentDepthError'
  }
}

/**
 * Resolve the child's delegation depth from its parent and enforce an optional
 * cap. The persisted parent header is the monotone floor, so a resumed parent
 * cannot delegate as if it were top-level.
 * @param parent - the delegating parent agent.
 * @param maxDepth - optional absolute cap the resolved depth must not exceed.
 * @returns the child's non-negative safe-integer depth.
 * @throws {SubagentDepthError} when the resolved depth exceeds `maxDepth`.
 * @throws {RangeError} when the resolved depth leaves the safe-integer range.
 */
export function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range')
  }
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new SubagentDepthError(childDepth, maxDepth)
  }
  return childDepth
}

/**
 * Resolve the parent values inherited by a child. The latest request header
 * owns provider, model, and reasoning effort after request-time selection;
 * creation options remain the fallback before the first request and retain
 * the configured output-token limit.
 * @param parent - delegating parent Agent.
 * @returns detached Agent options for child-option merging.
 */
export function parentAgentOptionsForDelegation(parent: Agent): AgentOptions {
  const requestConfig = parent.session.requestHeader()?.config
  if (requestConfig === undefined) return { ...parent.options }
  const {
    provider: _createdProvider,
    model: _createdModel,
    reasoningEffort: _createdReasoningEffort,
    ...createdOptions
  } = parent.options
  return {
    ...createdOptions,
    provider: requestConfig.provider,
    model: requestConfig.model,
    ...requestConfig.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: requestConfig.reasoningEffort },
  }
}

/**
 * Resolve the child's `AgentOptions`: the parent's provider/model,
 * reasoning-effort, and maxTokens values unless the request overrides them,
 * stamped with the child's own delegation depth. Changing the route without
 * naming an effort clears the parent's route-owned effort so the selected
 * model resolves its own default.
 * @param parent - the delegating parent whose route the child inherits.
 * @param requested - per-child overrides, if any.
 * @param childDepth - the resolved delegation depth to stamp.
 * @returns the resolved options for `ctx.agents.create()`.
 */
export function resolveChildAgentOptions(
  parent: Agent,
  requested: AgentOptions | undefined,
  childDepth: number,
): AgentOptions {
  const parentOptions = parentAgentOptionsForDelegation(parent)
  const parentProvider = parentOptions.provider
  const parentModel = parentOptions.model
  const parentReasoningEffort = parentOptions.reasoningEffort
  const parentMaxTokens = parentOptions.maxTokens
  const resolved: AgentOptions = {
    ...parentProvider !== undefined ? { provider: parentProvider } : {},
    ...parentModel !== undefined ? { model: parentModel } : {},
    ...parentReasoningEffort !== undefined ? { reasoningEffort: parentReasoningEffort } : {},
    ...parentMaxTokens !== undefined ? { maxTokens: parentMaxTokens } : {},
    ...requested,
    subagentDepth: childDepth,
  }
  const routeChanged = resolved.provider !== parentProvider || resolved.model !== parentModel
  if (routeChanged && requested?.reasoningEffort === undefined) delete resolved.reasoningEffort
  return resolved
}

/**
 * Drop route fields a fresh child inherited but never named when an explicit
 * `harness` choice moves the child to a harness other than the parent's
 * recorded owner and the inherited route cannot serve it: an unspecified
 * route lets the chosen harness apply its own default, and a harness with no
 * catalog route of its own (the loop) takes the deployment default model
 * (`ctx.agentDefaultModel`) when that harness serves it. A compatible
 * inherited route still applies, and route fields the request named
 * explicitly stay for `resolveChildHarness` to honor or reject.
 * @param ctx - context the mounted harness list is read from.
 * @param parent - the delegating parent whose route the child inherited.
 * @param requested - the request's explicit `harness` choice, or `undefined`.
 * @param resolved - the child options from `resolveChildAgentOptions`, adjusted in place.
 * @param named - the request's own `agentOptions`, telling named fields from inherited ones.
 */
export function dropCrossHarnessInheritedRoute(
  ctx: Context,
  parent: Agent,
  requested: HarnessId | undefined,
  resolved: AgentOptions,
  named: AgentOptions | undefined,
): void {
  if (requested === undefined) return
  // A harness choice reaches here only after the service resolved it on the agents service.
  const owner = ctx.agents.resolveHarness(harnessOwning(ctx, parent.session), 'create')?.id
  if (requested === owner) return
  const provider = resolved.provider
  const mounted = ctx.agents.harnesses()
  if (provider !== undefined && harnessesServing(mounted, provider).includes(requested)) return
  if (named?.provider === undefined) delete resolved.provider
  if (named?.model === undefined) delete resolved.model
  if (named?.reasoningEffort === undefined) delete resolved.reasoningEffort
  if (named?.maxTokens === undefined) delete resolved.maxTokens
  if (resolved.provider !== undefined) return
  // A harness without its own catalog route (the loop) has no default of its
  // own; the deployment default model applies when that harness serves it.
  const fallback = ctx.get('agentDefaultModel')?.currentSelection()
  if (fallback === undefined || fallback.provider === '' || fallback.model === '') return
  if (!harnessesServing(mounted, fallback.provider).includes(requested)) return
  resolved.provider = fallback.provider
  resolved.model = fallback.model
  if (fallback.reasoningEffort !== undefined && resolved.reasoningEffort === undefined) {
    resolved.reasoningEffort = fallback.reasoningEffort
  }
}

/**
 * The delegation options a resolved child harness must honor or refuse. These
 * are the inputs harness ownership constrains, not the whole start request.
 */
export interface HarnessBoundChildOptions {
  /** The child's fully resolved Agent options, parent inheritance included. */
  readonly agentOptions: AgentOptions | undefined
  /** Per-child persona request, loop-only composition. */
  readonly persona: string | undefined
  /** Per-child tool restriction request, loop-only composition. */
  readonly toolFilter: ToolRestriction | undefined
  /** Structured-output request, loop-only composition. */
  readonly outputSchema: ObjectJsonSchema | undefined
}

/**
 * The harness choice for one fresh child, resolved against the mounted set.
 */
export interface ChildHarnessResolution {
  /**
   * The id to pass to `ctx.agents.create()`: the request's explicit choice or
   * the parent session's recorded owner. `undefined` applies the registry's
   * own resolution (the sole mounted harness, or its loud failure).
   */
  readonly harness: HarnessId | undefined
  /**
   * The harness creation resolves to when it is already known here: `harness`,
   * else the sole mounted harness. `undefined` means the create call itself
   * cannot resolve one and fails before any factory runs.
   */
  readonly effective: HarnessId | undefined
  /**
   * Whether the `effective` harness hosts the loop's scoped composition
   * (`hostsLoopComposition`), which `applyChildComposition` and the
   * structured-output runtime install into. `true` while nothing resolves,
   * because the create call then fails first.
   */
  readonly isLoop: boolean
}

/**
 * Resolve the harness a fresh child runs under and reject delegation options
 * that harness cannot honor. The request's explicit `harness` wins; omission
 * inherits the harness owning the parent's session.
 *
 * `persona`, `toolFilter`, and `outputSchema` install through the loop's
 * scoped services, which only a harness declaring `hostsLoopComposition`
 * consumes — passing them to any other child would silently drop them, so they
 * reject here. The effective harness is the Agent registry's own
 * `resolveHarness` answer for the create call. The
 * resolved provider route is checked with {@link harnessesServing}: a harness
 * that declares a `modelProvider` owns that catalog route alone, and a route
 * with no owner serves only harnesses declaring none.
 * @param ctx - context the mounted harness list is read from.
 * @param parent - the delegating parent whose recorded harness is the fallback.
 * @param requested - the request's explicit `harness` choice, or `undefined`.
 * @param options - the child's resolved agent options and composition requests.
 * @returns the create-call harness id and whether it hosts the loop composition.
 * @throws {SubagentError} `INVALID_REQUEST` naming the dishonored option.
 */
export function resolveChildHarness(
  ctx: Context,
  parent: Agent,
  requested: HarnessId | undefined,
  options: HarnessBoundChildOptions,
): ChildHarnessResolution {
  const harness = requested ?? harnessOwning(ctx, parent.session)
  const mounted = ctx.get('agents')?.harnesses() ?? []
  const resolved = ctx.get('agents')?.resolveHarness(harness, 'create')
  const effective = resolved?.id
  const isLoop = resolved === undefined || resolved.hostsLoopComposition === true
  if (!isLoop) {
    const loopOnly: string[] = []
    if (options.persona !== undefined) loopOnly.push('persona')
    if (options.toolFilter !== undefined) loopOnly.push('toolFilter')
    if (options.outputSchema !== undefined) loopOnly.push('outputSchema')
    if (loopOnly.length > 0) {
      throw new SubagentError(
        `subagent option(s) ${loopOnly.join(', ')} require a harness that hosts the loop composition; `
        + `the child would run under "${effective}"`,
        'INVALID_REQUEST',
      )
    }
  }
  const provider = options.agentOptions?.provider
  if (provider !== undefined && effective !== undefined
    && !harnessesServing(mounted, provider).includes(effective)) {
    throw new SubagentError(
      `provider "${provider}" does not serve agent harness "${effective}"`,
      'INVALID_REQUEST',
    )
  }
  return { harness, effective, isLoop }
}

/**
 * Reject an explicit harness choice on a seeded child: the seed is a prefix of
 * the parent's durable log, which only the harness owning that log can
 * continue. An unrecorded parent resolves through the same sole-mounted
 * fallback `create` would apply to it.
 * @param ctx - context the mounted harness list is read from.
 * @param parent - the delegating parent whose harness owns the seed.
 * @param seed - the parent-log prefix the child is seeded with, if any.
 * @param requested - the request's explicit `harness` choice, or `undefined`.
 * @throws {SubagentError} `INVALID_REQUEST` when the choice cannot own the seed.
 */
export function assertSeededChildHarness(
  ctx: Context,
  parent: Agent,
  seed: readonly SessionEvent[] | undefined,
  requested: HarnessId | undefined,
): void {
  if (seed === undefined || requested === undefined) return
  const owner = ctx.get('agents')?.resolveHarness(harnessOwning(ctx, parent.session), 'create')?.id
  if (requested === owner) return
  throw new SubagentError(
    owner === undefined
      ? `a seeded subagent child cannot verify that harness "${requested}" owns its parent session`
      : `a seeded subagent child must run under its parent session's harness "${owner}", not "${requested}"`,
    'INVALID_REQUEST',
  )
}

/**
 * Build the child session's durable creation metadata: the parent's workspace,
 * its direct lineage, coarse product origin, the recursion budget that must
 * survive persistence, the seed boundary that separates inherited parent
 * history from child work, and the composition the child runs under.
 *
 * The preset is read from the parent's LIVE scope chain rather than from its
 * header, because a parent that switched preset while blank runs on the newer
 * composition and its header still names the older one. Recording it is what
 * makes a child's history reconstructable: without it a cold read of the child
 * resolves the deployment default and rebuilds turns under a tool set the
 * child never had.
 * @param parent - the delegating parent agent.
 * @param childDepth - the resolved delegation depth to persist.
 * @param isSeeded - whether this child inherits a parent-log prefix, including an explicitly empty one.
 * @returns the `meta` for `ctx.agents.create()`.
 */
export function childSessionMeta(
  parent: Agent,
  childDepth: number,
  isSeeded: boolean,
): NonNullable<CreateAgentOptions['meta']> {
  const parentHeader = parent.session.header
  const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
  return {
    ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
    ...agentPreset === undefined ? {} : { agentPreset },
    parentSession: parentHeader.id,
    isSeeded,
    // Navigation classification only; the descriptor remains the authority
    // for mode and continuation capability.
    origin: 'subagent',
    // Durable: the recursion budget must survive persistence and resume.
    delegationDepth: childDepth,
  }
}

/** The scoped composition a child agent's creation window applies. */
export interface ChildComposition {
  /** Per-child persona shadowing the deployment persona. */
  readonly persona?: string | undefined
  /** Per-child tool scoping. */
  readonly toolFilter?: ToolRestriction | undefined
}

/**
 * Model-facing delegation-scope statement for every in-process child. A
 * runtime-context contribution rather than a system-prompt section, so the
 * deployment's system prompt stays uniform across parents and children.
 */
export const SUBAGENT_DELEGATION_CONTEXT
  = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
    + 'widened from inside this session — operations that require approval are rejected automatically. '
    + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
    + 'limitation in your reply so the delegating agent can handle it.'

/**
 * Compose one child inside its creation window: join its parent's preset,
 * register the fixed delegation-scope statement, then apply the child's own
 * shadowing persona section and tool restriction, all owned by the child's
 * scope and therefore invisible to its parent and siblings. Creation and cold
 * resume both pass through here.
 *
 * The join comes first and the child's own registrations second, which is the
 * order the layering already implies — the nearest scope wins a name, and a
 * per-child restriction intersects with everything its chain admits — but
 * stating it here keeps the two steps from being read as independent.
 *
 * The join and the per-child registrations live in ONE call because a child
 * composed without the join is exactly the defect this function exists to
 * prevent: with every model-facing row on the agent plane, a child that joins
 * no preset sees an empty tool registry and none of its parent's prompt
 * sections. Taking the parent as a parameter is what makes that omission
 * unrepresentable at the call sites.
 * @param childCtx - the child agent's scoped creation context.
 * @param parent - the delegating parent whose composition the child joins.
 * @param composition - the per-child persona and tool filter to install.
 */
export function applyChildComposition(
  childCtx: Context,
  parent: Agent,
  composition: ChildComposition,
): void {
  childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
  childCtx.systemPrompt.context({
    name: 'subagent:delegation',
    order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: SUBAGENT_DELEGATION_CONTEXT,
  })
  if (composition.persona !== undefined) {
    childCtx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: composition.persona,
    })
  }
  if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)
}

/** Policy seeded onto a child session's log at the delegation boundary. */
export interface DelegatedPolicyOverrides {
  /**
   * The parent's current preset identity when it runs in Auto or Full access;
   * the child keeps it under the pinned `never` approval policy.
   */
  readonly permissionPreset: 'auto' | 'danger-full-access' | undefined
  /** The parent session's explicit sandbox-mode override, or `undefined` without one. */
  readonly sandboxMode: SandboxMode | undefined
  /**
   * `'never'` whenever the approval capability is composed, `undefined`
   * otherwise: a delegated child acts only within the sandbox scope fixed at
   * delegation, so its asks are rejected deterministically.
   */
  readonly approvalPolicy: 'never' | undefined
}

/**
 * Capture the permission state to seed into one delegation. Call synchronously before
 * the child start's first await: a later parent switch belongs to the
 * parent's future, not to this child. Auto and Full access identities are
 * inherited only through the in-process DSH path so either can replace a stale
 * same-bundle fork value. Only the parent session's explicit sandbox override
 * is captured — never deployment defaults or one-shot grants — and the approval
 * policy is pinned to `'never'` regardless of the parent's own policy.
 * @param parent - the delegating parent agent.
 * @returns the sandbox override (or `undefined` without one) and the approval pin.
 */
export function captureDelegatedPolicyOverrides(parent: Agent): DelegatedPolicyOverrides {
  const preset = parent.ctx.get('permissionPresets')?.current(parent.session)
  return {
    permissionPreset: preset === 'auto' || preset === 'danger-full-access' ? preset : undefined,
    sandboxMode: parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session),
    approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never',
  }
}

/**
 * Append the captured delegation policy onto the child's own log as
 * `source: 'delegation'` events inside the unpublished creation window, so the
 * child's effective policy is reconstructable from its log alone. Appends land
 * after any fork seed, so fresh policy wins stale seed state; later child
 * switches still win over these events.
 * @param childSession - the unpublished child's session.
 * @param overrides - the policy captured at delegation.
 */
export function appendDelegatedPolicyOverrides(
  childSession: Session,
  overrides: DelegatedPolicyOverrides,
): void {
  if (overrides.sandboxMode !== undefined) {
    childSession.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'delegation' })
  }
  if (overrides.approvalPolicy !== undefined) {
    childSession.append('approval/policy', { policy: overrides.approvalPolicy, source: 'delegation' })
  }
  if (overrides.permissionPreset !== undefined) {
    childSession.append('permission/preset', { preset: overrides.permissionPreset })
  }
}

/** Identity and lineage inputs shared by every in-process child creation. */
export interface ChildCreateInputs {
  /** The child's reserved session id. */
  readonly sessionId: SessionId
  /** The delegating parent agent. */
  readonly parent: Agent
  /** The resolved delegation depth. */
  readonly childDepth: number
  /** How many leading seed events came from the parent's log. */
  readonly lineageSeedLength: number
}

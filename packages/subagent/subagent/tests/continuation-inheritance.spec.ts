/**
 * Continuable-child delegation policy: a fresh continuable start seeds the
 * parent's Auto identity, explicit sandbox override, and the pinned
 * `approval/policy: never` onto the child's own log, and a cold
 * resume replays that persisted snapshot instead of re-capturing the parent
 * (the one-shot `subagent-inprocess/tests/inheritance.spec.ts` counterpart).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HarnessId, agentHarnessOf, recordedHarness } from '@deepseek-ai/dsh-agent'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentHarness,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ExternalAgent, ExternalAgentHost, HARNESS_DEFAULT_MODEL } from '@deepseek-ai/dsh-agent-external'
import type { ExternalTurnDrive } from '@deepseek-ai/dsh-agent-external'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, { snapshotSubagentDescriptor } from '../src/index.ts'
import type { SubagentProvider } from '../src/types.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession, seedStoredSession } from './persistence-helpers.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Boot the continuable stack plus both policy services the manager consumes opportunistically. */
async function setup(script: Script) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-continuation-inherit-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

function startSpec(parent: Agent, provider = 'spawn') {
  return {
    provider,
    label: 'child task',
    request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
    signal: new AbortController().signal,
  }
}

/** Wait until a child's Activation is gone, i.e. its handle finished disposal. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 15_000 })
}

function policyEvents(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'sandbox/mode' || event.type === 'approval/policy')
}

function foldedSandboxMode(ctx: Context, id: SessionId, events: readonly SessionEvent[]): unknown {
  return ctx.sessionProjections.stateOf(Session.create(id, events), 'sandboxMode')
}

function foldedApprovalPolicy(ctx: Context, id: SessionId, events: readonly SessionEvent[]): unknown {
  return ctx.approval.overrideOf(Session.create(id, events))
}

describe('continuable policy inheritance', () => {
  it.each(['auto', 'danger-full-access'] as const)(
    'persists the delegated %s identity across cold resume without reading the parent again',
    { timeout: 20_000 },
    async (preset) => {
      const { ctx, parent } = await setup([textResponse('child done'), textResponse('resumed child done')])
      parent.session.append('permission/preset', { preset })
      setSandboxMode(parent.session, 'danger-full-access')
      const current = vi.fn((session: Session) => session === parent.session ? preset : 'custom')
      ctx.provide('permissionPresets', { current } as never)

      const started = await ctx.subagents.startContinuable(startSpec(parent))
      await waitNoActivation(ctx, started.childId)

      const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
      expect(loaded.events.filter(event =>
        event.type === 'sandbox/mode'
        || event.type === 'approval/policy'
        || event.type === 'permission/preset',
      )).toMatchObject([
        { type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
        { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
        { type: 'permission/preset', data: { preset } },
      ])
      expect(current).toHaveBeenCalledExactlyOnceWith(parent.session)
      parent.session.append('permission/preset', { preset: preset === 'auto' ? 'danger-full-access' : 'auto' })
      current.mockImplementation(() => { throw new Error('cold resume must not read parent permission') })
      await queueHostSubagentPrompt(
        ctx.subagents, parent, started.childId,
        [{ type: 'text', text: 'continue please' }], { kind: 'user' }, new AbortController().signal,
      )
      await waitNoActivation(ctx, started.childId)
      const resumed = await loadStoredSession(ctx.sessionPersistence, started.childId)
      expect(resumed.events.filter(event => event.type === 'permission/preset')).toMatchObject([
        { data: { preset } },
      ])
      expect(current).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    { seedPreset: 'auto', preset: 'danger-full-access' },
    { seedPreset: 'danger-full-access', preset: 'auto' },
  ] as const)('captures $preset before child creation and overrides the $seedPreset fork prefix', { timeout: 20_000 }, async ({ seedPreset, preset }) => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('forked child')])
    parent.session.append('permission/preset', { preset: seedPreset })
    setSandboxMode(parent.session, 'danger-full-access')
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    parent.session.append('permission/preset', { preset })
    let currentPreset: 'auto' | 'danger-full-access' = preset
    ctx.provide('permissionPresets', {
      current: (session: Session) => session === parent.session ? currentPreset : 'custom',
    } as never)

    const starting = ctx.subagents.startContinuable(startSpec(parent, 'fork'))
    currentPreset = seedPreset
    parent.session.append('permission/preset', { preset: seedPreset })
    const started = await starting
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.events.filter(event => event.type === 'permission/preset')).toMatchObject([
      { data: { preset: seedPreset } },
      { data: { preset } },
    ])
  })

  it('seeds the parent sandbox override and pins approval to never', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    setSandboxMode(parent.session, 'danger-full-access')
    // No parent approval override: the child pin must not depend on one.
    expect(ctx.approval.overrideOf(parent.session)).toBeUndefined()
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    // The delegation events are appended in the creation window, so they are
    // already the child's effective policy at inbox acceptance.
    if (child === undefined) throw new Error('expected the continuable child to be created')
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('danger-full-access')
    expect(ctx.approval.overrideOf(child.session)).toBe('never')

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    // Durable: a reload folds the same effective policy.
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('danger-full-access')
    expect(foldedApprovalPolicy(ctx, started.childId, loaded.events)).toBe('never')
    expect(ctx.approval.overrideOf(parent.session)).toBeUndefined()
    const runtimeContext = loaded.events.find(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && event.data.source.kind === 'runtime-context',
    )
    const contextText = runtimeContext?.data.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
    expect(contextText).toContain('You are a delegated subagent')
  })

  it('captures policy at delegation before asynchronous child creation', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    setSandboxMode(parent.session, 'read-only')

    const starting = ctx.subagents.startContinuable(startSpec(parent))
    // A parent switch after the synchronous capture belongs to the parent's
    // future, not to this child.
    setSandboxMode(parent.session, 'danger-full-access')
    const started = await starting

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(ctx.sandboxPolicy.overrideOf(parent.session)).toBe('danger-full-access')
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
  })

  it('leaves an unswitched sandbox on the deployment default while still pinning approval', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBeNull()
  })

  it('pins approval after the fork prefix of an unswitched fork child', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('forked child')])
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'fork'))
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.inheritedEventCount).toBeGreaterThan(0)
    expect(policyEvents(loaded.events)).toMatchObject([
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBeNull()
  })

  it('lets a later child-side switch win over the delegation snapshot', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    setSandboxMode(parent.session, 'danger-full-access')
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    if (child === undefined) throw new Error('expected the continuable child to be created')
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('danger-full-access')
    // Last event wins: the child's own runtime switch beats the seeded snapshot.
    setSandboxMode(child.session, 'read-only')
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe('read-only')

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
  })

  it('cold-resumes on the persisted snapshot without re-capturing the parent', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    setSandboxMode(parent.session, 'read-only')
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    // The parent widens AFTER the child was created; the resumed child keeps
    // the delegation-time snapshot from its own log.
    setSandboxMode(parent.session, 'danger-full-access')
    await queueHostSubagentPrompt(
      ctx.subagents,
      parent,
      started.childId,
      [{ type: 'text', text: 'continue please' }],
      { kind: 'user' },
      new AbortController().signal,
    )
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.events.filter(event => event.type === 'sandbox/mode')).toMatchObject([
      { data: { mode: 'read-only', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
    // The approval pin is seeded once at creation, never re-appended on resume.
    expect(loaded.events.filter(event => event.type === 'approval/policy')).toMatchObject([
      { data: { policy: 'never', source: 'delegation' } },
    ])
  })

  it('places inherited events after a fork prefix so fresh policy wins stale seed state', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('forked child')])
    // The stale mode lands inside the completed turn the fork seed replays.
    setSandboxMode(parent.session, 'workspace-write')
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    setSandboxMode(parent.session, 'read-only')

    const started = await ctx.subagents.startContinuable(startSpec(parent, 'fork'))
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(loaded.inheritedEventCount).toBeGreaterThan(0)
    expect(loaded.events.filter(event => event.type === 'sandbox/mode')).toMatchObject([
      { data: { mode: 'workspace-write' } },
      { data: { mode: 'read-only', source: 'delegation' } },
    ])
    expect(foldedSandboxMode(ctx, started.childId, loaded.events)).toBe('read-only')
  })
})

/**
 * Mount a second harness beside the loop's `dsh`, as the shipped web profile
 * does. Every entry point rejects and is recorded: a child of a `dsh` parent
 * that reached this factory was routed to the wrong harness.
 */
function mountForeignHarness(ctx: Context): string[] {
  const calls: string[] = []
  const factory: AgentFactory = {
    createAgent: () => {
      calls.push('create')
      return Promise.reject(new Error('the foreign harness must not create a child of a dsh parent'))
    },
    resume: () => {
      calls.push('resume')
      return Promise.reject(new Error('the foreign harness must not resume a child of a dsh parent'))
    },
  }
  ctx.agents.registerHarness({ id: HarnessId('foreign'), name: 'Foreign', factory })
  return calls
}

/**
 * A foreign-harness agent on the shared external-driver skeleton: every turn
 * claims its inbox batch, commits it as `user/message` rows, and records one
 * canned assistant reply — the smallest Agent the continuable lifecycle can
 * drive honestly (inbox, settlement, persistence, disposal).
 */
class ForeignTestAgent extends ExternalAgent {
  driveTurn(_messages: readonly UserMessage[], drive: ExternalTurnDrive): Promise<TurnEndReason> {
    const selection = this.currentSelection()
    drive.projector.assistantText('foreign harness answer', {
      provider: selection.provider === '' ? 'foreign' : selection.provider,
      model: selection.model === '' ? HARNESS_DEFAULT_MODEL : selection.model,
    })
    return Promise.resolve({ kind: 'completed' })
  }

  /** Pending steering waits for the next turn's claim. */
  steerLive(): Promise<boolean> {
    return Promise.resolve(false)
  }

  /** There is no live harness turn to interrupt. */
  interruptTurn(): Promise<void> {
    return Promise.resolve()
  }

  bind(): Promise<void> {
    return Promise.resolve()
  }

  unbind(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * A working foreign harness on the shared {@link ExternalAgentHost}
 * transaction: session preparation, the durable `agent/harness` record,
 * persistence write ownership, publication, and teardown all run the
 * production path — only the turn body is canned.
 */
class ForeignTestHost extends ExternalAgentHost<ForeignTestAgent> {
  /** The create/resume entry points reached, for routing assertions. */
  readonly calls: string[] = []

  constructor(ctx: Context, harness: AgentHarness) {
    super(ctx, 'foreign test harness', { harness })
  }

  override createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    this.calls.push('create')
    return super.createAgent(ownerCtx, options)
  }

  override resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    this.calls.push('resume')
    return super.resume(ownerCtx, options)
  }

  protected constructAgent(
    hostCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
  ): ForeignTestAgent {
    return new ForeignTestAgent(hostCtx, id, options, session)
  }
}

/**
 * Mount a working foreign harness, as the shipped web profile mounts ACP
 * beside `dsh`. Unlike {@link mountForeignHarness}'s routing sentinel, its
 * agents can create, resume, run turns, and settle, so continuable children
 * under it reach disposal.
 */
async function mountWorkingForeignHarness(
  ctx: Context,
  options: { id?: string; name?: string; modelProvider?: string } = {},
): Promise<ForeignTestHost> {
  let host: ForeignTestHost | undefined
  // The host runs its transaction through service property access, so it is
  // constructed on a fiber injecting everything the driver touches.
  await ctx.inject(['sessionProjections', 'agents', 'sessions'], (hostCtx) => {
    host = new ForeignTestHost(hostCtx, {
      id: HarnessId(options.id ?? 'foreign'),
      name: options.name ?? 'Foreign',
      ...options.modelProvider === undefined ? {} : { modelProvider: options.modelProvider },
    })
  })
  if (host === undefined) throw new Error('foreign test harness did not construct')
  return host
}

/**
 * A continuable provider that accepts `harness` and still contributes a
 * parent prefix: the shipped fork provider refuses the choice outright, so
 * the seed-ownership assertion needs a seeding provider that admits it.
 */
function mountSeedingProvider(ctx: Context): void {
  ctx.subagents.registerProvider({
    name: 'seeding',
    capabilities: {
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
      harness: true,
    },
    inheritsParentContext: true,
    start: () => Promise.reject(new Error('the seeding provider only prepares continuable children')),
    prepareContinuable: () => Promise.resolve({ seed: [] }),
  } satisfies SubagentProvider)
}

/**
 * A live Agent whose session predates the `agent/harness` record, or was
 * created by an out-of-tree caller: registered so delegation sees an exact
 * live parent with no recorded owner.
 */
async function unrecordedParent(ctx: Context, id: SessionId): Promise<Agent> {
  const session = ctx.sessions.create(id, { meta: { cwd: process.cwd() } })
  const parent = {
    id: session.id,
    session,
    status: 'idle',
    options: { provider: 'mock', model: 'mock' },
    ctx,
  } as unknown as Agent
  await ctx.agents.register(parent)
  return parent
}

describe('continuable child harness', () => {
  it('creates and cold-resumes the child under the parent session harness', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('child done'), textResponse('resumed child done')])
    const foreign = mountForeignHarness(ctx)

    const started = await ctx.subagents.startContinuable(startSpec(parent))

    const child = ctx.agents.get(started.childId)
    if (child === undefined) throw new Error('expected the continuable child to be published')
    expect(agentHarnessOf(ctx.sessionProjections, child.session)).toBe('dsh')
    await waitNoActivation(ctx, started.childId)
    const created = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(recordedHarness(created.events)).toBe(HarnessId('dsh'))

    await queueHostSubagentPrompt(
      ctx.subagents,
      parent,
      started.childId,
      [{ type: 'text', text: 'continue please' }],
      { kind: 'user' },
      new AbortController().signal,
    )
    await waitNoActivation(ctx, started.childId)

    const resumed = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(recordedHarness(resumed.events)).toBe(HarnessId('dsh'))
    expect(foreign).toEqual([])
  })

  it('creates a continuable child under the explicitly chosen harness', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([])
    const foreign = mountForeignHarness(ctx)
    const spec = startSpec(parent)

    await expect(ctx.subagents.startContinuable({
      ...spec,
      request: { ...spec.request, harness: HarnessId('foreign') },
    })).rejects.toThrow('the foreign harness must not create a child of a dsh parent')
    // Routing reached the foreign factory: the explicit choice won over the
    // parent's recorded `dsh`.
    expect(foreign).toEqual(['create'])
  })

  it('rejects a harness choice on a seeding provider and loop-only options on a non-loop harness', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([])
    const foreign = mountForeignHarness(ctx)
    const spec = startSpec(parent, 'fork')

    // A fork child is seeded with the parent's log prefix, which only the
    // parent's own harness can continue — the provider refuses the choice.
    await expect(ctx.subagents.startContinuable({
      ...spec,
      request: { ...spec.request, harness: HarnessId('dsh') },
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })

    const spawnSpec = startSpec(parent)
    await expect(ctx.subagents.startContinuable({
      ...spawnSpec,
      request: { ...spawnSpec.request, harness: HarnessId('foreign'), persona: 'reviewer' },
    })).rejects.toThrow('require a harness that hosts the loop composition')
    expect(foreign).toEqual([])
  })

  it('cold-resumes a continuable child under its own recorded harness', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([])
    const foreign = mountForeignHarness(ctx)
    const childId = SessionId('foreign-child')
    // A child log authored by another harness: its own `agent/harness` record,
    // not the parent's `dsh`, owns the resume.
    await seedStoredSession(ctx.sessionPersistence, {
      version: SESSION_FORMAT_VERSION,
      id: childId,
      createdAt: 1,
      isSeeded: false,
      parentSession: parent.id,
    }, [
      { type: 'agent/harness', seq: SessionSeq(0), time: 1, data: { harness: 'foreign' } },
      {
        type: 'subagent/descriptor',
        seq: SessionSeq(1),
        time: 2,
        data: snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'cold child' }),
      },
    ])

    await expect(queueHostSubagentPrompt(
      ctx.subagents,
      parent,
      childId,
      [{ type: 'text', text: 'continue please' }],
      { kind: 'user' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
    // The recorded `foreign` id reached `agents.resume`: the parent's `dsh`
    // was not consulted.
    expect(foreign).toEqual(['resume'])
  })

  it('creates and settles a continuable child under the explicitly chosen foreign harness', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([])
    const foreign = await mountWorkingForeignHarness(ctx)
    // The child can settle before `startContinuable` returns, so capture it at
    // its publication edge.
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })
    const spec = startSpec(parent)

    const started = await ctx.subagents.startContinuable({
      ...spec,
      request: { ...spec.request, harness: HarnessId('foreign') },
    })

    // The explicit choice reached the foreign factory and its session carries
    // the foreign record.
    expect(foreign.calls).toEqual(['create'])
    if (child === undefined) throw new Error('expected the foreign continuable child to be published')
    expect(agentHarnessOf(ctx.sessionProjections, child.session)).toBe('foreign')
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(recordedHarness(loaded.events)).toBe(HarnessId('foreign'))
    const types = loaded.events.map(event => event.type)
    expect(types).toContain('subagent/descriptor')
    expect(types).toContain('turn/end')
    expect(loaded.events.filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.message.content))
      .toContainEqual({ type: 'text', text: 'foreign harness answer' })
    // The loop-only scoped composition never ran: no delegation section was
    // rendered into the child's log.
    expect(loaded.events.some(event => event.type === 'system/message')).toBe(false)
  })

  it('cold-resumes a foreign-recorded child through its own harness and settles it', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([])
    const foreign = await mountWorkingForeignHarness(ctx)
    const childId = SessionId('foreign-child-resume')
    await seedStoredSession(ctx.sessionPersistence, {
      version: SESSION_FORMAT_VERSION,
      id: childId,
      createdAt: 1,
      isSeeded: false,
      parentSession: parent.id,
    }, [
      { type: 'agent/harness', seq: SessionSeq(0), time: 1, data: { harness: 'foreign' } },
      {
        type: 'subagent/descriptor',
        seq: SessionSeq(1),
        time: 2,
        data: snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'cold foreign child' }),
      },
    ])

    await queueHostSubagentPrompt(
      ctx.subagents,
      parent,
      childId,
      [{ type: 'text', text: 'continue please' }],
      { kind: 'user' },
      new AbortController().signal,
    )
    expect(foreign.calls).toEqual(['resume'])
    await waitNoActivation(ctx, childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
    // The record was already durable: resume does not append a second one.
    expect(loaded.events.filter(event => event.type === 'agent/harness')).toHaveLength(1)
    const types = loaded.events.map(event => event.type)
    expect(types).toContain('user/message')
    expect(types).toContain('turn/end')
    expect(types).toContain('assistant/message')
    expect(loaded.events.some(event => event.type === 'subagent/descriptor' && event.seq > SessionSeq(1)))
      .toBe(false)
  })

  it('creates an unrecorded parent\'s child under the sole mounted harness', { timeout: 20_000 }, async () => {
    const { ctx } = await setup([textResponse('child done')])
    // With exactly one mounted harness the host can own the choice.
    const parent = await unrecordedParent(ctx, SessionId('unrecorded-parent'))

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(recordedHarness(loaded.events)).toBe(HarnessId('dsh'))
  })

  it('cold-resumes an unrecorded child under the harness claiming legacy logs', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('resumed legacy answer')])
    const childId = SessionId('legacy-child')
    // A log written before `agent/harness` existed: the in-process loop claims
    // unrecorded resumes.
    await seedStoredSession(ctx.sessionPersistence, {
      version: SESSION_FORMAT_VERSION,
      id: childId,
      createdAt: 1,
      isSeeded: false,
      parentSession: parent.id,
    }, [
      {
        type: 'subagent/descriptor',
        seq: SessionSeq(0),
        time: 1,
        data: snapshotSubagentDescriptor({
          mode: 'continuable', provider: 'spawn', label: 'legacy child',
          agentProvider: 'mock', agentModel: 'mock',
        }),
      },
    ])

    await queueHostSubagentPrompt(
      ctx.subagents,
      parent,
      childId,
      [{ type: 'text', text: 'continue please' }],
      { kind: 'user' },
      new AbortController().signal,
    )
    await waitNoActivation(ctx, childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
    // Resuming backfilled the record so future resumes route by it.
    expect(recordedHarness(loaded.events)).toBe(HarnessId('dsh'))
    const types = loaded.events.map(event => event.type)
    expect(types).toContain('user/message')
    expect(types).toContain('turn/end')
  })

  it('delivers image content to a harness-owned route without consulting the llm registry', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([])
    const foreign = await mountWorkingForeignHarness(ctx, { modelProvider: 'foreign-llm' })
    const resolveModelInfo = vi.spyOn(ctx.llm, 'resolveModelInfo')
    const childId = SessionId('foreign-image-child')
    await seedStoredSession(ctx.sessionPersistence, {
      version: SESSION_FORMAT_VERSION,
      id: childId,
      createdAt: 1,
      isSeeded: false,
      parentSession: parent.id,
    }, [
      { type: 'agent/harness', seq: SessionSeq(0), time: 1, data: { harness: 'foreign' } },
      {
        type: 'subagent/descriptor',
        seq: SessionSeq(1),
        time: 2,
        data: snapshotSubagentDescriptor({
          mode: 'continuable', provider: 'spawn', label: 'image child',
          agentProvider: 'foreign-llm', agentModel: 'foreign-model',
        }),
      },
    ])

    await queueHostSubagentPrompt(ctx.subagents, parent, childId, [
      { type: 'text', text: 'see this' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'att-1' as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
        },
      },
    ], { kind: 'user' }, new AbortController().signal)
    await waitNoActivation(ctx, childId)

    // The route belongs to the mounted harness, so the deployment registry's
    // model table was never asked to adjudicate it.
    expect(resolveModelInfo).not.toHaveBeenCalled()
    expect(foreign.calls).toEqual(['resume'])
    const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
    const delivered = loaded.events.find(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'image'))
    expect(delivered).toBeDefined()
  })

  it('refuses an unrecorded parent through the host instead of inventing a harness', { timeout: 20_000 }, async () => {
    const { ctx } = await setup([textResponse('unused')])
    mountForeignHarness(ctx)
    // The child has no ancestor harness to inherit, so the host owns the
    // decision.
    const parent = await unrecordedParent(ctx, SessionId('unrecorded-parent'))

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toThrow('agent creation needs a harness id (mounted: dsh, foreign)')
  })

  it('runs a seeded child under the harness owning its parent session', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('seeded child done')])
    mountSeedingProvider(ctx)
    const spec = startSpec(parent, 'seeding')

    const started = await ctx.subagents.startContinuable({
      ...spec,
      request: { ...spec.request, harness: HarnessId('dsh') },
    })
    await waitNoActivation(ctx, started.childId)

    // The choice matched the parent's recorded owner, so the seed was allowed
    // and the child ran under `dsh`.
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    expect(recordedHarness(loaded.events)).toBe(HarnessId('dsh'))
  })

  it('refuses a seeded child when no harness can own the unrecorded parent', { timeout: 20_000 }, async () => {
    const { ctx } = await setup([])
    const foreign = mountForeignHarness(ctx)
    mountSeedingProvider(ctx)
    const parent = await unrecordedParent(ctx, SessionId('unrecorded-seed-parent'))
    const spec = startSpec(parent, 'seeding')

    // With two mounted harnesses and no recorded owner, the seed's ownership
    // is unverifiable: the explicit choice cannot paper over it.
    const error = await ctx.subagents.startContinuable({
      ...spec,
      request: { ...spec.request, harness: HarnessId('dsh') },
    }).catch((rejection: unknown) => rejection)
    expect(error).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(String(error)).toContain('cannot verify that harness "dsh" owns its parent session')
    expect(foreign).toEqual([])
  })

  it('refuses a cold resume whose recorded harness is not mounted', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([])
    const childId = SessionId('unmounted-harness-child')
    // A log authored while `foreign` was mounted, replayed after it left.
    await seedStoredSession(ctx.sessionPersistence, {
      version: SESSION_FORMAT_VERSION,
      id: childId,
      createdAt: 1,
      isSeeded: false,
      parentSession: parent.id,
    }, [
      { type: 'agent/harness', seq: SessionSeq(0), time: 1, data: { harness: 'foreign' } },
      {
        type: 'subagent/descriptor',
        seq: SessionSeq(1),
        time: 2,
        data: snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'orphaned child' }),
      },
    ])

    const error = await queueHostSubagentPrompt(
      ctx.subagents,
      parent,
      childId,
      [{ type: 'text', text: 'continue please' }],
      { kind: 'user' },
      new AbortController().signal,
    ).catch((rejection: unknown) => rejection)
    expect(error).toMatchObject({ code: 'NOT_RESUMABLE' })
    expect(String(error)).toContain('runs agent harness "foreign", which is not mounted')
  })
})

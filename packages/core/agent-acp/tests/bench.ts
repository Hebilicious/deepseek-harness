/**
 * Shared bench for the `dsh-agent-acp` specs: a real Cordis context with the
 * session, projection, agent, subprocess, LLM, and typert services, JSONL
 * persistence in a temp root, and `AcpHarness` pointed at the scripted mock
 * `devin acp` child. Tests observe the durable session log, the mock's JSONL
 * request record, and the child's stdout.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { AcpHarnessEntry } from '@deepseek-ai/dsh-agent-acp'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentToolBridge, { type Config as BridgeConfig } from '@deepseek-ai/dsh-agent-tool-bridge'
import { AcpHarness } from '../src/index.ts'

export const mockAgent = fileURLToPath(new URL('./mock-acp-agent.ts', import.meta.url))

/** One request/notification the mock child recorded. */
export interface RecordedCall {
  readonly method: string
  readonly params: unknown
}

/** Read the mock's JSONL request record (initialize, session/*, cli, …). */
export async function recordedCalls(file: string): Promise<RecordedCall[]> {
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  return text.trim() === '' ? [] : text.trim().split('\n').map(line => JSON.parse(line) as RecordedCall)
}

/** Poll until `predicate` holds — subprocess cold-start and exit are asynchronous. */
export async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Poll until `file` exists. */
export async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  await waitFor(() => existsSync(file), timeoutMs)
}

/**
 * Poll the mock's request record until `method` appears. Agent-side record
 * writes trail the wire exchange that settles the caller, so awaiting the
 * agent is not enough to observe one.
 */
export async function waitForCall(file: string, method: string, timeoutMs = 15_000): Promise<RecordedCall[]> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const calls = await recordedCalls(file)
    if (calls.some(call => call.method === method)) return calls
    if (Date.now() > deadline) throw new Error(`mock child never recorded ${method}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** One user-questions request, as the driver maps it from an ACP form schema. */
export interface AskedQuestions {
  questions: readonly {
    id: string
    question: string
    detail: string
    options?: readonly { label: string }[]
  }[]
}

/**
 * Configurable `userQuestions` stand-in. The default answers every asked item
 * with one `beta` selection; a test may replace {@link answers} to exercise
 * multi-select and custom answers, or {@link failure} to reject the ask.
 */
export class FakeQuestions extends Service {
  /** One answer entry per asked question id, by default a single `beta` selection. */
  answers: ((id: string) => { id: string; selected: string[]; custom?: string }) | undefined
  /** When set, {@link ask} rejects with this error. */
  failure: Error | undefined
  /** The last request the driver asked, for assertions on the mapped questions. */
  lastAsk: AskedQuestions | undefined

  constructor(ctx: Context) {
    super(ctx, 'userQuestions')
  }

  async ask(req: AskedQuestions): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> {
    this.lastAsk = req
    if (this.failure !== undefined) throw this.failure
    const answer = this.answers ?? ((id: string) => ({ id, selected: ['beta'] }))
    return { answers: req.questions.map(item => answer(item.id)) }
  }
}

/** Minimal `attachments` stand-in resolving every reference to a host path. */
export class FakeAttachments extends Service {
  /** When true, every host-path lookup throws. */
  failing = false

  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  imageHostPath(ref: { attachmentId: string }): string {
    if (this.failing) throw new Error('attachment store unavailable')
    return `/attachments/${ref.attachmentId}.png`
  }

  fileHostPath(ref: { attachmentId: string }): string {
    if (this.failing) throw new Error('attachment store unavailable')
    return `/attachments/${ref.attachmentId}`
  }
}

/**
 * Configurable `approval` stand-in. The shipped service contains every
 * answerer failure and answers `unavailable`, so only a seam that rejects can
 * exercise the driver's fail-closed arm.
 */
export class FakeApproval extends Service {
  /** Outcome every request resolves with unless {@link failure} is set. */
  outcome: ApprovalOutcome = 'allowed-once'
  /** When set, every request rejects with this error. */
  failure: Error | undefined

  constructor(ctx: Context) {
    super(ctx, 'approval')
  }

  /** No session override; the driver falls back to its deployment config. */
  overrideOf(): undefined {
    return undefined
  }

  async request(): Promise<ApprovalOutcome> {
    if (this.failure !== undefined) throw this.failure
    return this.outcome
  }
}

/** One mounted driver bench. */
export interface Bench {
  readonly ctx: Context
  readonly root: string
  readonly recordFile: string
  /** The fake user-questions service when the bench mounted one. */
  readonly questions?: FakeQuestions
  /** The fake attachment service when the bench mounted one. */
  readonly attachments?: FakeAttachments
  /** The fake approval service when the bench mounted one. */
  readonly approval?: FakeApproval
}

/** Default harness id the bench mounts, so unqualified create/resume calls reach it. */
export const DEFAULT_HARNESS_ID = 'devin'

/** Benches' own switches and config overrides. */
export interface BenchOptions {
  approval?: boolean | 'fake'
  questions?: boolean
  attachments?: boolean
  sandboxPolicy?: boolean
  /** Mount the tool registry and `agentToolBridge` with this config (true = defaults). */
  bridge?: boolean | BridgeConfig
  /** Overrides merged into the default `devin` entry. */
  config?: Partial<AcpHarnessEntry>
  /** Extra harness entries mounted beside the default `devin` entry. */
  harnesses?: AcpHarnessEntry[]
  /** Plugin-level config overrides (termination graces and the CLI deadline). */
  plugin?: Record<string, unknown>
}

/** Mount the full driver bench with `AcpHarness` pointing its default entry at the mock agent. */
export async function setup(
  env: Record<string, string> = {},
  options: BenchOptions = {},
): Promise<Bench> {
  const root = await mkdtemp(join(tmpdir(), 'agent-acp-test-'))
  const recordFile = join(root, 'record.jsonl')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  if (options.approval === true) await ctx.plugin(ApprovalService)
  if (options.approval === 'fake') await ctx.plugin(FakeApproval)
  if (options.questions === true) await ctx.plugin(FakeQuestions)
  if (options.attachments === true) await ctx.plugin(FakeAttachments)
  if (options.sandboxPolicy === true) await ctx.plugin(SandboxPolicy)
  if (options.bridge !== undefined && options.bridge !== false) {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentToolBridge, options.bridge === true ? {} : options.bridge)
  }
  await ctx.plugin(AcpHarness, {
    harnesses: [
      {
        id: DEFAULT_HARNESS_ID,
        name: 'Devin',
        description: 'Devin runs the session through devin acp',
        executable: process.execPath,
        args: [mockAgent, 'acp'],
        catalogArgs: [mockAgent, 'models', 'list', '--format', 'json'],
        authStatusArgs: [mockAgent, 'auth', 'status'],
        authLogoutArgs: [mockAgent, 'auth', 'logout'],
        env: { MOCK_RECORD_FILE: recordFile, ...env },
        ...options.config,
      },
      ...options.harnesses ?? [],
    ],
    ...options.plugin,
  })
  const questions = ctx.get('userQuestions') as FakeQuestions | undefined
  const attachments = ctx.get('attachments') as FakeAttachments | undefined
  const approval = ctx.get('approval') as FakeApproval | undefined
  return {
    ctx,
    root,
    recordFile,
    ...questions === undefined ? {} : { questions },
    ...attachments === undefined ? {} : { attachments },
    ...approval === undefined ? {} : { approval },
  }
}

/** Dispose the bench's fiber and remove its temp root. */
export async function teardown(target: Bench | undefined): Promise<void> {
  await target?.ctx.fiber.dispose()
  if (target !== undefined) await rm(target.root, { recursive: true, force: true })
}

/** Queue one user message on the agent. */
export function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

/** Every durable event the agent's session logged. */
export function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

/** Every durable event of one type. */
export function eventsOf(agent: Agent, type: string): SessionEvent[] {
  return events(agent).filter(event => event.type === type)
}

/** The last `turn/end` reason kind, or undefined before any turn ended. */
export function turnEndKind(agent: Agent): string | undefined {
  const end = events(agent).findLast(event => event.type === 'turn/end')
  const reason = end?.data['reason'] as { kind?: string } | undefined
  return reason?.kind
}

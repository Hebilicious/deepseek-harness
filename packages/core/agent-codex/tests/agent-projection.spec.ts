/**
 * Projection and routing tests for the Codex session driver: one scripted
 * mock `codex app-server --stdio` child per case drives the driver's item
 * projection, approval/question routing, permission overrides, model
 * fallbacks, and turn endings through the real session log. Each case asserts
 * the durable events a session would replay, not driver internals.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentStore, type ImageAttachmentRef, type StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { CodexAppServer } from '../src/index.ts'

const mockServer = fileURLToPath(new URL('./mock-codex-app-server.ts', import.meta.url))

/** How the attachment stand-in behaves. */
type AttachmentBehaviour = 'host' | 'throw'

/**
 * Attachment stand-in: either a host-file-backed store that resolves both
 * reference kinds to fixed paths, or one whose lookups fail.
 */
class AttachmentStub extends AttachmentStore {
  readonly imageLimits = {
    maxImageBytes: 1_024,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 4_096,
    maxImagePixels: 1_024,
    maxImageDimension: 64,
    mediaTypes: ['image/png'] as const,
  }

  constructor(ctx: Context, private readonly behaviour: AttachmentBehaviour) {
    super(ctx)
  }

  async validateImage(): Promise<void> {}

  async saveImage(): Promise<ImageAttachmentRef> {
    throw new Error('this fixture stores no images')
  }

  async readImage(): Promise<StoredImageAttachment> {
    throw new Error('this fixture reads no images')
  }

  override imageHostPath(): string | undefined {
    return this.path('/host/image.png')
  }

  override fileHostPath(): string | undefined {
    return this.path('/host/example.txt')
  }

  private path(resolved: string): string {
    if (this.behaviour === 'throw') throw new Error('attachment store offline')
    return resolved
  }
}

/** Minimal sandbox-policy stand-in: one fixed durable override. */
class SandboxOverride extends Service {
  constructor(ctx: Context, private readonly mode: SandboxMode | undefined) {
    super(ctx, 'sandboxPolicy')
  }

  overrideOf(): SandboxMode | undefined {
    return this.mode
  }
}

/** The durable policy and fixed outcome an approval stand-in answers with. */
interface ApprovalStubConfig {
  readonly policy?: 'ask' | 'never'
  readonly outcome: 'allowed-once' | 'rejected' | 'cancelled'
}

/** Minimal approval stand-in: one fixed durable policy and a fixed outcome. */
class ApprovalStub extends Service {
  /** Tool names the driver asked about, in order. */
  readonly asked: string[] = []

  constructor(ctx: Context, private readonly config: ApprovalStubConfig) {
    super(ctx, 'approval')
  }

  overrideOf(): 'ask' | 'never' | undefined {
    return this.config.policy
  }

  async request(request: { toolName: string }): Promise<string> {
    this.asked.push(request.toolName)
    return this.config.outcome
  }
}

/** How the user-questions stand-in answers one ask. */
type QuestionBehaviour = 'answer' | 'empty' | 'throw'

/** Minimal user-questions stand-in: fixed answers, an empty answer, or a failure. */
class QuestionsStub extends Service {
  constructor(ctx: Context, private readonly behaviour: QuestionBehaviour) {
    super(ctx, 'userQuestions')
  }

  async ask(request: { questions: readonly { id: string }[] }) {
    if (this.behaviour === 'throw') throw new Error('no human at the keyboard')
    return {
      answers: request.questions.map(item => ({
        id: item.id,
        selected: this.behaviour === 'answer' ? ['beta'] : [],
        ...this.behaviour === 'answer' ? { custom: 'beta' } : { custom: '' },
      })),
    }
  }
}

interface Bench {
  readonly ctx: Context
  readonly root: string
  readonly recordFile: string
}

interface BenchOptions {
  /** Mount a fixed sandbox-policy override. */
  readonly sandbox?: SandboxMode
  /** Mount a fixed durable approval policy and outcome. */
  readonly approval?: ApprovalStubConfig
  /** Mount a user-questions stand-in with this answer behaviour. */
  readonly questions?: QuestionBehaviour
  /** Mount an attachment stand-in with this behaviour. */
  readonly attachments?: AttachmentBehaviour
  /** Extra plugin config (model, effort, network access, …). */
  readonly config?: Record<string, unknown>
}

let bench: Bench | undefined

/** Mount the driver bench over the scripted mock child. */
async function setup(env: Record<string, string> = {}, options: BenchOptions = {}): Promise<Bench> {
  const root = await mkdtemp(join(tmpdir(), 'agent-codex-projection-'))
  const recordFile = join(root, 'record.jsonl')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  if (options.sandbox !== undefined) await ctx.plugin(SandboxOverride, options.sandbox)
  if (options.approval !== undefined) await ctx.plugin(ApprovalStub, options.approval)
  if (options.questions !== undefined) await ctx.plugin(QuestionsStub, options.questions)
  if (options.attachments !== undefined) await ctx.plugin(AttachmentStub, options.attachments)
  await ctx.plugin(CodexAppServer, {
    harnesses: [{
      executable: process.execPath,
      args: [mockServer],
      codexHome: root,
      env: { MOCK_CODEX_RECORD_FILE: recordFile, ...env },
      ...options.config,
    }],
  })
  return { ctx, root, recordFile }
}

afterEach(async () => { await teardownBench() })

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

function eventsOf(agent: Agent, type: string): SessionEvent[] {
  return events(agent).filter(event => event.type === type)
}

function turnEndKind(agent: Agent): string | undefined {
  const end = events(agent).findLast(event => event.type === 'turn/end')
  return (end?.data['reason'] as { kind?: string } | undefined)?.kind
}

/** Tool calls the driver projected, in log order. */
function toolCalls(agent: Agent): Array<{ id: string; name: string; args: string }> {
  return eventsOf(agent, 'tool/call').map((event) => {
    const data = event.data as { callId: string; name: string; arguments: string }
    return { id: data.callId, name: data.name, args: data.arguments }
  })
}

/** Tool results the driver committed, in log order. */
function toolResults(agent: Agent): Array<{ id: string; isError: boolean; text: string; meta: unknown }> {
  return eventsOf(agent, 'tool/result').map((event) => {
    const data = event.data as {
      message: { toolCallId: string; isError: boolean; content: Array<{ text?: string }> }
      meta?: unknown
    }
    return {
      id: data.message.toolCallId,
      isError: data.message.isError,
      text: JSON.stringify(data.message.content),
      meta: data.meta,
    }
  })
}

const TEST_TIMEOUT = 30_000

describe('item projection', () => {
  it('projects every tool item kind and settles each result', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'items-tools' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('p1'), agentOptions: {} })
    send(agent, 'run everything')
    await agent.whenIdle()

    expect(toolCalls(agent).map(call => call.name)).toEqual([
      'shell',
      'shell',
      'apply_patch',
      'apply_patch',
      'mcp__fs__read',
      'mcp__unknown__unknown',
      'app.do',
      'plain',
      'collab_spawn',
      'collab_unknown',
      'web_search',
      'web_search',
      'image_generation',
      'update_plan',
      'update_plan',
      'codex_sleep',
    ])
    const results = toolResults(agent)
    expect(results.map(result => result.id)).toEqual([
      'cmd-1',
      'cmd-2',
      'fc-1',
      'fc-2',
      'mcp-1',
      'mcp-2',
      'dyn-1',
      'dyn-2',
      'collab-1',
      'collab-2',
      'ws-1',
      'ws-2',
      'img-1',
      'plan-1',
      'plan-2',
      'sleep-1',
    ])
    // A failed command, file change, MCP call, dynamic call, and collab call
    // report their failure; the diffs ride in the card metadata.
    expect(results.map(result => result.isError)).toEqual([
      true, false, true, false, true, false, true, false, true, true, false, false, false, false, false, false,
    ])
    expect(JSON.stringify(results[2]!.meta)).toContain('a.txt')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('ignores echoed input and folds a delta with no started frame', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'items-misc', MOCK_CODEX_TEXT: 'misc answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('p2'), agentOptions: {} })
    send(agent, 'misc')
    await agent.whenIdle()

    expect(eventsOf(agent, 'tool/call')).toHaveLength(0)
    const assistant = eventsOf(agent, 'assistant/message')
    expect(assistant).toHaveLength(1)
    expect(JSON.stringify(assistant[0]!.data)).toContain('misc answer')
  }, TEST_TIMEOUT)

  it('commits reasoning left unfolded when the turn ends without a message', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'reasoning-only' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('p3'), agentOptions: {} })
    send(agent, 'think only')
    await agent.whenIdle()

    const assistant = eventsOf(agent, 'assistant/message')
    expect(assistant).toHaveLength(1)
    expect(JSON.stringify(assistant[0]!.data)).toContain('only thoughts')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('ends the turn as an error on an invalid terminal turn status', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'bad-status' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('p4'), agentOptions: {} })
    send(agent, 'bad status')
    await agent.whenIdle()
    expect(turnEndKind(agent)).toBe('error')
  }, TEST_TIMEOUT)

  it('reports a max-tokens turn as its own ending', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'max-tokens' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('p5'), agentOptions: {} })
    send(agent, 'too long')
    await agent.whenIdle()
    expect(turnEndKind(agent)).toBe('max-tokens')
  }, TEST_TIMEOUT)

  it('reports a failed turn with its category code', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'fail' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('p6'), agentOptions: {} })
    send(agent, 'fail')
    await agent.whenIdle()

    const end = events(agent).findLast(event => event.type === 'turn/end')
    expect(end?.data['reason']).toMatchObject({
      kind: 'error',
      error: { code: 'CODEX_SERVICE' },
    })
  }, TEST_TIMEOUT)
})

describe('item projection details', () => {
  it('ignores every live progress mirror', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'progress-mirrors' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('d1'), agentOptions: {} })
    send(agent, 'progress')
    await agent.whenIdle()

    expect(toolCalls(agent).map(call => call.name)).toEqual(['shell'])
    expect(toolResults(agent)[0]).toMatchObject({ isError: false })
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('projects items whose optional members are absent', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'odd-items' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('d2'), agentOptions: {} })
    send(agent, 'odd items')
    await agent.whenIdle()

    expect(toolCalls(agent).map(call => call.name)).toEqual([
      'codex_imageView',
      'codex_subAgentActivity',
      'codex_enteredReviewMode',
      'codex_exitedReviewMode',
      'codex_contextCompaction',
      'shell',
      'apply_patch',
      'mcp__unknown__unknown',
      'do',
      'unknown',
      'collab_unknown',
      'web_search',
      'update_plan',
    ])
    const results = toolResults(agent)
    expect(results.map(result => result.isError)).toEqual(new Array(13).fill(false))
    expect(results[0]!.text).toContain('imageView')
    // The assistant message carries no text, so the turn still completes.
    expect(eventsOf(agent, 'assistant/message')).toHaveLength(1)
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('parses the diff hunk shapes a file change may carry', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'diff-shapes' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('d3'), agentOptions: {} })
    send(agent, 'diffs')
    await agent.whenIdle()

    const meta = toolResults(agent)[0]!.meta as { diffs: Array<{ path: string; oldText: string | null; newText: string }> }
    // The fixture diffs are newline-terminated, so each hunk's last line is an
    // empty context line; the malformed patch contributes no hunk, and a hunk
    // with no removal reports no before-text.
    expect(meta.diffs).toEqual([
      { path: 'pure-add.txt', oldText: null, newText: 'added\n' },
      { path: 'no-newline.txt', oldText: 'old\n', newText: 'new\n' },
    ])
  }, TEST_TIMEOUT)

  it('projects a user message carrying image and file attachments', async () => {
    bench = await setup()
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('d4'), agentOptions: {} })
    send(agent, 'attachments')
    agent.followup(createUserMessage({
      content: [
        { type: 'image', attachment: imageRef('sha256:aaaa') },
        { type: 'file', attachment: fileRef() },
      ],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(eventsOf(agent, 'tool/call')).toHaveLength(0)
    // Without an attachment store both blocks degrade to handle text on the
    // wire; the durable message keeps the original blocks.
    // The two queued messages may claim separate turns, so every turn's input
    // is inspected.
    const input = JSON.stringify(await recordedInputs(bench.recordFile))
    expect(input).toContain('image omitted')
    expect(input).toContain('example.txt')
  }, TEST_TIMEOUT)

  it('forwards host-backed attachments as wire paths', async () => {
    bench = await setup({}, { attachments: 'host' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('d7'), agentOptions: {} })
    agent.followup(createUserMessage({
      content: [
        { type: 'image', attachment: imageRef('sha256:dddd') },
        { type: 'file', attachment: fileRef() },
      ],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const input = JSON.stringify(await recordedInputs(bench.recordFile))
    expect(input).toContain('/host/image.png')
    expect(input).toContain('/host/example.txt')
  }, TEST_TIMEOUT)

  it('degrades to handle text when the attachment lookup fails', async () => {
    bench = await setup({}, { attachments: 'throw' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('d8'), agentOptions: {} })
    agent.followup(createUserMessage({
      content: [
        { type: 'image', attachment: imageRef('sha256:eeee') },
        { type: 'file', attachment: fileRef() },
      ],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const input = JSON.stringify(await recordedInputs(bench.recordFile))
    expect(input).toContain('image omitted')
    expect(input).toContain('example.txt')
  }, TEST_TIMEOUT)

  it('injects attachment context outside a turn', async () => {
    bench = await setup()
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('d5'), agentOptions: {} })
    agent.inject(createUserMessage({
      content: [
        { type: 'text', text: 'context' },
        { type: 'file', attachment: fileRef() },
        { type: 'image', attachment: imageRef('sha256:bbbb') },
      ],
      source: { kind: 'user' },
    }))
    await waitForRecordedCall(bench.recordFile, 'thread/inject_items')

    const inject = await recordedCall(bench.recordFile, 'thread/inject_items')
    const text = JSON.stringify(inject.params)
    expect(text).toContain('context')
    expect(text).toContain('example.txt')
    expect(text).toContain('image omitted')
  }, TEST_TIMEOUT)

  it('answers a typed elicitation form', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit-typed' }, { questions: 'answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('d6'), agentOptions: {} })
    send(agent, 'typed form')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'elicitation-outcome')
    expect(outcome.params).toMatchObject({ action: 'accept' })
  }, TEST_TIMEOUT)
})

describe('frame routing and refusal paths', () => {
  it('routes frames that arrive after the turn id is committed', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'late-turn', MOCK_CODEX_TEXT: 'late answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r1'), agentOptions: {} })
    send(agent, 'late')
    await agent.whenIdle()

    expect(JSON.stringify(eventsOf(agent, 'assistant/message'))).toContain('late answer')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('replays item frames buffered before the turn id is committed', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'early-item-first', MOCK_CODEX_TEXT: 'buffered answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r2'), agentOptions: {} })
    send(agent, 'early item')
    await agent.whenIdle()

    expect(JSON.stringify(eventsOf(agent, 'assistant/message'))).toContain('buffered answer')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('ends the turn as an error when the response contradicts the provisional id', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'early-mismatch' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r3'), agentOptions: {} })
    send(agent, 'mismatch')
    await agent.whenIdle()

    expect(turnEndKind(agent)).toBe('error')
    expect(JSON.stringify(events(agent).findLast(event => event.type === 'turn/end')?.data))
      .toContain('did not match the active turn')
  }, TEST_TIMEOUT)

  it('drops a thread notification it does not project', async () => {
    bench = await setup({ MOCK_CODEX_THREAD_NOTIFY: '1', MOCK_CODEX_TEXT: 'renamed' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r4'), agentOptions: {} })
    send(agent, 'rename')
    await agent.whenIdle()

    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('refuses an unsupported server request without failing the connection', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'unsupported-request' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r5'), agentOptions: {} })
    send(agent, 'unsupported')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'unsupported-request')
    expect(JSON.stringify(outcome.params)).toContain('unsupported app-server request')
    // The same connection still serves a later turn.
    send(agent, 'again')
    await agent.whenIdle()
    expect(eventsOf(agent, 'turn/end')).toHaveLength(2)
  }, TEST_TIMEOUT)

  it('reports a server-side interruption as a user abort', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'server-interrupt' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r6'), agentOptions: {} })
    send(agent, 'interrupted')
    await agent.whenIdle()

    const end = events(agent).findLast(event => event.type === 'turn/end')
    expect(end?.data['reason']).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  }, TEST_TIMEOUT)

  it('falls back to the category name when a failed turn carries no error', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'fail-bare' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r7'), agentOptions: {} })
    send(agent, 'fail bare')
    await agent.whenIdle()

    const end = events(agent).findLast(event => event.type === 'turn/end')
    expect(end?.data['reason']).toEqual({
      kind: 'error',
      error: { message: 'Codex turn failed (unknown)', code: 'CODEX_UNKNOWN' },
    })
  }, TEST_TIMEOUT)

  it('routes a file-change approval through the approval seam', async () => {
    bench = await setup(
      { MOCK_CODEX_SCENARIO: 'file-approval' },
      { approval: { outcome: 'allowed-once' } },
    )
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r8'), agentOptions: {} })
    send(agent, 'file approval')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'approval-decision')
    expect(JSON.stringify(outcome.params)).toContain('"accept"')
  }, TEST_TIMEOUT)

  it('asks for approval with a default reason when the request carries none', async () => {
    bench = await setup(
      { MOCK_CODEX_SCENARIO: 'approval-bare' },
      { approval: { outcome: 'rejected' } },
    )
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r9'), agentOptions: {} })
    send(agent, 'no reason')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'approval-decision')
    expect(JSON.stringify(outcome.params)).toContain('"decline"')
  }, TEST_TIMEOUT)

  it('echoes a requested filesystem grant and a default permissions reason', async () => {
    bench = await setup(
      { MOCK_CODEX_SCENARIO: 'permissions-files' },
      { approval: { outcome: 'allowed-once' } },
    )
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r10'), agentOptions: {} })
    send(agent, 'files')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'permissions-outcome')
    expect(outcome.params).toEqual({
      permissions: { fileSystem: { read: ['/work'] } },
      scope: 'turn',
    })
  }, TEST_TIMEOUT)

  it('maps only the well-formed questions of a user-input request', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'user-input-odd' }, { questions: 'answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r11'), agentOptions: {} })
    send(agent, 'odd questions')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'user-input-answers')
    expect(JSON.stringify(outcome.params)).toContain('"choice"')
    expect(JSON.stringify(outcome.params)).toContain('"plain"')
    expect(JSON.stringify(outcome.params)).not.toContain('no-text')
  }, TEST_TIMEOUT)

  it('declines an elicitation that carries no message', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit-nomessage' }, { questions: 'empty' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r12'), agentOptions: {} })
    send(agent, 'no message')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'elicitation-outcome')
    expect(outcome.params).toMatchObject({ action: 'decline' })
  }, TEST_TIMEOUT)

  it.each([
    ['an empty decision list', JSON.stringify([]), '"decline"'],
    ['no usable decision', JSON.stringify(['maybe']), 'no usable approval decision'],
  ])('answers an approval with %s', async (_label, decisions, expected) => {
    bench = await setup(
      { MOCK_CODEX_SCENARIO: 'approval', MOCK_CODEX_DECISIONS: decisions },
      { approval: { outcome: 'rejected' } },
    )
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('r13'), agentOptions: {} })
    send(agent, 'decide')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'approval-decision')
    expect(JSON.stringify(outcome.params)).toContain(expected)
  }, TEST_TIMEOUT)
})

describe('steering and interruption', () => {
  it('leaves a refused steer pending for the next turn', async () => {
    const ready = join(await mkdtemp(join(tmpdir(), 'agent-codex-projection-ready-')), 'ready')
    bench = await setup({ MOCK_CODEX_SCENARIO: 'steer-refused', MOCK_CODEX_READY_FILE: ready })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s1'), agentOptions: {} })
    send(agent, 'start')
    await waitForFile(ready)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'never accepted' }],
      source: { kind: 'user' },
    }))
    await waitForRecordedCall(bench.recordFile, 'turn/steer')
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'never accepted either' }],
      source: { kind: 'user' },
    }))
    // Steer forwards are serialized, so the second request reaching the wire
    // proves the first refusal was consumed before the turn is cancelled.
    const recordFile = bench.recordFile
    await expect.poll(async () =>
      (await recordedCalls(recordFile)).filter(call => call.method === 'turn/steer').length,
    { timeout: 20_000 }).toBe(2)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    // The refused steering was never committed as model-visible input.
    expect(JSON.stringify(eventsOf(agent, 'user/message'))).not.toContain('never accepted')
  }, TEST_TIMEOUT)

  it('drops a steer the aborted turn can no longer take', async () => {
    const ready = await markerPath('steer-ready')
    const gate = await markerPath('steer-gate')
    bench = await setup({
      MOCK_CODEX_SCENARIO: 'steer',
      MOCK_CODEX_READY_FILE: ready,
      MOCK_CODEX_STEER_GATE_FILE: gate,
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s1b'), agentOptions: {} })
    send(agent, 'start')
    await waitForFile(ready)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'in flight steer' }],
      source: { kind: 'user' },
    }))
    await waitForRecordedCall(bench.recordFile, 'turn/steer')
    // Queued behind the in-flight steer, so it reaches the driver only after the
    // abort retired the drive it was steering.
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'late steer' }],
      source: { kind: 'user' },
    }))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await writeFile(gate, 'go')

    const calls = await recordedCalls(bench.recordFile)
    expect(calls.filter(call => call.method === 'turn/steer')).toHaveLength(1)
    expect(JSON.stringify(eventsOf(agent, 'user/message'))).not.toContain('steer')
    expect(turnEndKind(agent)).toBe('aborted')
  }, TEST_TIMEOUT)

  it('interrupts a turn whose id is still provisional', async () => {
    const ready = join(await mkdtemp(join(tmpdir(), 'agent-codex-projection-late-')), 'ready')
    bench = await setup({ MOCK_CODEX_SCENARIO: 'hang', MOCK_CODEX_READY_FILE: ready })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('s2'), agentOptions: {} })
    send(agent, 'hang')
    await waitForFile(ready)
    // Cancelling asks the server to interrupt the committed turn.
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await waitForRecordedCall(bench.recordFile, 'turn/interrupt')
    expect(turnEndKind(agent)).toBe('aborted')
  }, TEST_TIMEOUT)
})

describe('thread binding details', () => {
  it('forwards the session working directory on start and resume', async () => {
    bench = await setup({ MOCK_CODEX_THREAD_ID: 'codex-cwd' })
    const first = await bench.ctx.agents.create({
      sessionId: SessionId('b1'),
      agentOptions: {},
      meta: { cwd: '/work/space' },
    })
    send(first.agent, 'first')
    await first.agent.whenIdle()
    await first.dispose()

    const resumed = await bench.ctx.agents.resume({ resumeSessionId: SessionId('b1') })
    send(resumed.agent, 'second')
    await resumed.agent.whenIdle()
    await resumed.dispose()

    const { readFile } = await import('node:fs/promises')
    const records = (await readFile(bench.recordFile, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { method: string; params: { cwd?: string } })
    const starts = records.filter(record => record.method === 'thread/start')
    const resumes = records.filter(record => record.method === 'thread/resume')
    expect(starts[0]!.params.cwd).toBe('/work/space')
    expect(resumes[0]!.params.cwd).toBe('/work/space')
  }, TEST_TIMEOUT)

  it('refuses a resume that answers with another thread id', async () => {
    bench = await setup({ MOCK_CODEX_THREAD_ID: 'codex-original', MOCK_CODEX_RESUME_THREAD_ID: 'codex-other' })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('b2'), agentOptions: {} })
    send(first.agent, 'first')
    await first.agent.whenIdle()
    await first.dispose()

    await expect(bench.ctx.agents.resume({ resumeSessionId: SessionId('b2') }))
      .rejects.toThrow('resumed thread "codex-other" instead of "codex-original"')
  }, TEST_TIMEOUT)

  it('binds with no route reported and no cwd', async () => {
    bench = await setup({ MOCK_CODEX_NO_ROUTE: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('b3'), agentOptions: {} })
    send(agent, 'no route')
    await agent.whenIdle()

    const header = events(agent).find(event => event.type === 'request/header')
    expect(JSON.stringify(header?.data)).toContain('agent-default')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('warns but still releases the thread when unsubscribe fails', async () => {
    bench = await setup({ MOCK_CODEX_FAIL_UNSUBSCRIBE: '1' })
    const handle = await bench.ctx.agents.create({ sessionId: SessionId('b4'), agentOptions: {} })
    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(bench.ctx.agents.roots()).toHaveLength(0)
  }, TEST_TIMEOUT)
})

describe('permission and approval routing', () => {
  it('maps a durable sandbox override onto the structured turn policy', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'text' }, { sandbox: 'read-only', config: { networkAccess: true } })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('a1'), agentOptions: {} })
    send(agent, 'read only')
    await agent.whenIdle()

    const turn = await recordedTurnStart(bench.recordFile)
    expect(turn.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: true })
    // No approval override is mounted, so the deployment default applies.
    expect(turn.params.approvalPolicy).toBe('on-request')
  }, TEST_TIMEOUT)

  it('maps a workspace-write override with the session directory as its writable root', async () => {
    bench = await setup(
      { MOCK_CODEX_SCENARIO: 'text' },
      { sandbox: 'workspace-write' },
    )
    const { agent } = await bench.ctx.agents.create({
      sessionId: SessionId('a2'),
      agentOptions: {},
      meta: { cwd: '/work/space' },
    })
    send(agent, 'write')
    await agent.whenIdle()

    const turn = await recordedTurnStart(bench.recordFile)
    expect(turn.params.sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/work/space'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })
  }, TEST_TIMEOUT)

  it('maps a full-access override onto the bypass policy', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'text' }, { sandbox: 'danger-full-access' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('a3'), agentOptions: {} })
    send(agent, 'bypass')
    await agent.whenIdle()

    const turn = await recordedTurnStart(bench.recordFile)
    expect(turn.params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
  }, TEST_TIMEOUT)

  it('routes a durable approval policy onto the turn approval member', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'text' }, { approval: { policy: 'never', outcome: 'rejected' } })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('a4'), agentOptions: {} })
    send(agent, 'never ask')
    await agent.whenIdle()

    const turn = await recordedTurnStart(bench.recordFile)
    expect(turn.params.approvalPolicy).toBe('never')
  }, TEST_TIMEOUT)

  it('declines an approval when no approval service is mounted', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'approval' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('a5'), agentOptions: {} })
    send(agent, 'needs approval')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'approval-decision')
    expect(JSON.stringify(outcome)).toContain('"decline"')
  }, TEST_TIMEOUT)

  it('answers a permissions request with a turn-scoped grant only when allowed', async () => {
    bench = await setup(
      { MOCK_CODEX_SCENARIO: 'permissions' },
      { approval: { outcome: 'allowed-once' } },
    )
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('a6'), agentOptions: {} })
    send(agent, 'grant')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'permissions-outcome')
    expect(outcome.params).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    })
  }, TEST_TIMEOUT)

  it('declines a permissions request when no approval service is mounted', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'permissions' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('a7'), agentOptions: {} })
    send(agent, 'grant')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'permissions-outcome')
    expect(outcome.params).toEqual({ permissions: {}, scope: 'turn' })
  }, TEST_TIMEOUT)

  it('falls back to a decision the server offered', async () => {
    bench = await setup(
      { MOCK_CODEX_SCENARIO: 'approval', MOCK_CODEX_DECISIONS: JSON.stringify(['cancel']) },
      { approval: { outcome: 'allowed-once' } },
    )
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('a8'), agentOptions: {} })
    send(agent, 'restricted')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'approval-decision')
    expect(JSON.stringify(outcome)).toContain('"cancel"')
  }, TEST_TIMEOUT)

  it('cancels the approval when the caller cancels it', async () => {
    bench = await setup(
      { MOCK_CODEX_SCENARIO: 'approval' },
      { approval: { outcome: 'cancelled' } },
    )
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('a9'), agentOptions: {} })
    send(agent, 'cancel me')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'approval-decision')
    expect(JSON.stringify(outcome)).toContain('"cancel"')
  }, TEST_TIMEOUT)
})

describe('questions and elicitation', () => {
  it('answers an elicitation form from the user-questions seam', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit' }, { questions: 'answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('q1'), agentOptions: {} })
    send(agent, 'answer')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'elicitation-outcome')
    expect(outcome.params).toEqual({ action: 'accept', content: { choice: 'beta' }, _meta: null })
  }, TEST_TIMEOUT)

  it('declines an elicitation whose ask fails', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit' }, { questions: 'throw' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('q2'), agentOptions: {} })
    send(agent, 'answer')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'elicitation-outcome')
    expect(outcome.params).toMatchObject({ action: 'decline' })
  }, TEST_TIMEOUT)

  it('answers nothing when the question ask fails', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'user-input' }, { questions: 'throw' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('q3'), agentOptions: {} })
    send(agent, 'ask')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'user-input-answers')
    expect(outcome.params).toEqual({ answers: {} })
  }, TEST_TIMEOUT)

  it('accepts a schema-less elicitation answered with free text', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit-plain' }, { questions: 'answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('q4'), agentOptions: {} })
    send(agent, 'answer')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'elicitation-outcome')
    expect(outcome.params).toEqual({ action: 'accept', content: { response: 'beta' }, _meta: null })
  }, TEST_TIMEOUT)

  it('declines a schema-less elicitation the user leaves empty', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit-plain' }, { questions: 'empty' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('q5'), agentOptions: {} })
    send(agent, 'answer')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'elicitation-outcome')
    expect(outcome.params).toMatchObject({ action: 'decline' })
  }, TEST_TIMEOUT)

  it('declines an elicitation form whose fields it cannot map', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit-rich' }, { questions: 'answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('q6'), agentOptions: {} })
    send(agent, 'answer')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'elicitation-outcome')
    expect(outcome.params).toMatchObject({ action: 'decline' })
  }, TEST_TIMEOUT)
})

describe('turn settlement containment', () => {
  it('forwards the deployment model on a resumed thread', async () => {
    bench = await setup({ MOCK_CODEX_THREAD_ID: 'codex-model' }, { config: { model: 'codex-y' } })
    const first = await bench.ctx.agents.create({ sessionId: SessionId('m1'), agentOptions: {} })
    send(first.agent, 'first')
    await first.agent.whenIdle()
    await first.dispose()

    const resumed = await bench.ctx.agents.resume({ resumeSessionId: SessionId('m1') })
    await resumed.dispose()

    const resume = await recordedCall(bench.recordFile, 'thread/resume')
    expect(resume.params).toMatchObject({ threadId: 'codex-model', model: 'codex-y' })
  }, TEST_TIMEOUT)

  it('contains a failing tool-result settlement and keeps the turn outcome', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'tool-open' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('m2'), agentOptions: {} })
    failAppends(agent, 'tool/result')
    send(agent, 'open tool')
    await agent.whenIdle()

    expect(toolCalls(agent)).toHaveLength(1)
    expect(eventsOf(agent, 'tool/result')).toHaveLength(0)
    // Containment keeps the drive's own ending; an escaping append failure
    // would have recorded the settlement error as the turn ending instead.
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('contains a failing interrupted-stream settlement and keeps the turn outcome', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'message-open', MOCK_CODEX_TEXT: 'partial words' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('m3'), agentOptions: {} })
    failAppends(agent, 'assistant/message')
    send(agent, 'stream')
    await agent.whenIdle()

    expect(eventsOf(agent, 'assistant/message')).toHaveLength(0)
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('contains a failing trailing-reasoning settlement and keeps the turn outcome', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'reasoning-only' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('m4'), agentOptions: {} })
    failAppends(agent, 'assistant/message')
    send(agent, 'think only')
    await agent.whenIdle()

    expect(eventsOf(agent, 'assistant/message')).toHaveLength(0)
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('interrupts the retired turn when a cancel lands as its tool result is closed', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'tool-open' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('m5'), agentOptions: {} })
    // The settlement append runs after the drive left the active slot, so this
    // abort addresses the retired turn instead of the live one.
    bench.ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'tool/result') agent.cancel({ kind: 'user' })
    })
    send(agent, 'open tool')
    await agent.whenIdle()
    await waitForRecordedCall(bench.recordFile, 'turn/interrupt')

    const interrupt = await recordedCall(bench.recordFile, 'turn/interrupt')
    expect(interrupt.params).toMatchObject({ turnId: 'turn-1' })
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)
})

describe('turn ids that commit late', () => {
  it('steers into a turn whose id only the response supplies', async () => {
    const started = await markerPath('gate-start')
    const release = await markerPath('gate-release')
    bench = await setup({
      MOCK_CODEX_SCENARIO: 'steer',
      MOCK_CODEX_TURN_START_FILE: started,
      MOCK_CODEX_TURN_START_GATE_FILE: release,
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('g1'), agentOptions: {} })
    send(agent, 'start')
    await waitForFile(started)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'steer early' }],
      source: { kind: 'user' },
    }))
    await writeFile(release, 'go')
    await agent.whenIdle()

    const steer = await recordedCall(bench.recordFile, 'turn/steer')
    expect(steer.params).toMatchObject({ expectedTurnId: 'turn-1' })
    expect(JSON.stringify(eventsOf(agent, 'user/message'))).toContain('steer early')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('leaves a steer pending when its turn fails before the id commits', async () => {
    const started = await markerPath('gate-start')
    const release = await markerPath('gate-release')
    bench = await setup({
      MOCK_CODEX_TURN_START_FILE: started,
      MOCK_CODEX_TURN_START_GATE_FILE: release,
      MOCK_CODEX_TURN_START_GATE_MODE: 'bad-started',
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('g2'), agentOptions: {} })
    send(agent, 'start')
    await waitForFile(started)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'never accepted' }],
      source: { kind: 'user' },
    }))
    await writeFile(release, 'go')
    await agent.whenIdle()

    expect(turnEndKind(agent)).toBe('error')
    expect(JSON.stringify(eventsOf(agent, 'user/message'))).not.toContain('never accepted')
    const calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'turn/steer')).toBe(false)
  }, TEST_TIMEOUT)

  it('abandons a steer when its turn aborts before the id commits', async () => {
    const started = await markerPath('gate-start')
    const gate = await markerPath('gate-hold')
    bench = await setup({
      MOCK_CODEX_TURN_START_FILE: started,
      MOCK_CODEX_TURN_START_GATE_FILE: gate,
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('g3'), agentOptions: {} })
    send(agent, 'start')
    await waitForFile(started)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'abandoned steer' }],
      source: { kind: 'user' },
    }))
    // One microtask beat lets the queued steer reach the wire channel and start
    // waiting for the turn id; the cancel then aborts that wait.
    await Promise.resolve()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    expect(turnEndKind(agent)).toBe('aborted')
    const calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'turn/steer')).toBe(false)
  }, TEST_TIMEOUT)

  it('commits a late turn id so a queued interrupt can address the retired turn', async () => {
    const started = await markerPath('gate-start')
    const release = await markerPath('gate-release')
    bench = await setup({
      MOCK_CODEX_TURN_START_FILE: started,
      MOCK_CODEX_TURN_START_GATE_FILE: release,
      MOCK_CODEX_TURN_START_GATE_MODE: 'late-started',
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('g4'), agentOptions: {} })
    send(agent, 'start')
    await waitForFile(started)
    // The turn has no id yet: the interrupt waits for one to appear.
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await writeFile(release, 'go')

    await waitForRecordedCall(bench.recordFile, 'turn/interrupt')
    const interrupt = await recordedCall(bench.recordFile, 'turn/interrupt')
    expect(interrupt.params).toMatchObject({ turnId: 'turn-1' })
    expect(turnEndKind(agent)).toBe('aborted')
  }, TEST_TIMEOUT)

  it('abandons an interrupt waiting on an id the dead wire never supplies', async () => {
    const started = await markerPath('gate-start')
    const release = await markerPath('gate-release')
    const reaped = await markerPath('reaped')
    bench = await setup({
      MOCK_CODEX_TURN_START_FILE: started,
      MOCK_CODEX_TURN_START_GATE_FILE: release,
      MOCK_CODEX_TURN_START_GATE_MODE: 'close-stdout',
      MOCK_CODEX_FLUSH_ON_EOF: reaped,
      MOCK_CODEX_FLUSH_DELAY_MS: '10',
    })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('g5'), agentOptions: {} })
    send(agent, 'start')
    await waitForFile(started)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    // The server's output ends while the interrupt still waits for a turn id
    // no response ever supplied; the reaped child proves the loss reached the
    // driver and its connection was retired.
    await writeFile(release, 'go')
    await waitForFile(reaped)

    const second = await bench.ctx.agents.create({ sessionId: SessionId('g6'), agentOptions: {} })
    const calls = await recordedCalls(bench.recordFile)
    expect(calls.filter(call => call.method === 'initialize')).toHaveLength(2)
    expect(calls.some(call => call.method === 'turn/interrupt')).toBe(false)
    expect(turnEndKind(agent)).toBe('aborted')
    await second.dispose()
  }, TEST_TIMEOUT)

})

describe('unowned and foreign frames', () => {
  it('ignores a turn/started no live turn owns', async () => {
    const early = await markerPath('early')
    bench = await setup({
      MOCK_CODEX_EARLY_STARTED: '1',
      MOCK_CODEX_EARLY_STARTED_FILE: early,
      MOCK_CODEX_TEXT: 'after early frame',
    })
    const errors: unknown[] = []
    bench.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('u1'), agentOptions: {} })
    // The notification was written before the marker, and this round trip after
    // it, so the client has consumed the frame before the turn starts.
    await waitForFile(early)
    await bench.ctx.codexAppServer.status({ harness: 'codex' }, new AbortController().signal)
    send(agent, 'hi')
    await agent.whenIdle()

    expect(errors).toHaveLength(0)
    expect(JSON.stringify(eventsOf(agent, 'assistant/message'))).toContain('after early frame')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('drops a frame addressed to a turn the driver never committed', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'foreign-frame', MOCK_CODEX_TEXT: 'own answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('u2'), agentOptions: {} })
    send(agent, 'hi')
    await agent.whenIdle()

    const assistant = JSON.stringify(eventsOf(agent, 'assistant/message'))
    expect(assistant).toContain('own answer')
    expect(assistant).not.toContain('foreign text')
    expect(turnEndKind(agent)).toBe('completed')
  }, TEST_TIMEOUT)

  it('fails the turn when two frames name conflicting turn ids', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'early-conflict' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('u3'), agentOptions: {} })
    send(agent, 'conflict')
    await agent.whenIdle()

    expect(turnEndKind(agent)).toBe('error')
    expect(JSON.stringify(events(agent).findLast(event => event.type === 'turn/end')?.data))
      .toContain('referenced conflicting turns')
    expect(eventsOf(agent, 'assistant/message')).toHaveLength(0)
  }, TEST_TIMEOUT)
})

describe('context injection details', () => {
  it('forwards host-backed images and refuses a block kind Codex cannot take', async () => {
    bench = await setup({}, { attachments: 'host' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('i1'), agentOptions: {} })
    agent.inject(createUserMessage({
      content: [
        { type: 'image', attachment: imageRef('sha256:aaaa') },
        { type: 'image', attachment: { ...imageRef('sha256:bbbb'), name: 'shot.png' } },
      ],
      source: { kind: 'user' },
    }))
    await waitForRecordedCall(bench.recordFile, 'thread/inject_items')

    const inject = await recordedCall(bench.recordFile, 'thread/inject_items')
    const text = JSON.stringify(inject.params)
    expect(text).toContain('/host/image.png')
    // An image without a display name still projects as one handle.
    expect(text).toContain('\\"image\\"')
    expect(text).toContain('shot.png')

    // A reasoning block is not a block kind the Codex wire carries: the
    // context stays pending and nothing reaches the thread.
    agent.inject(createUserMessage({
      content: [{ type: 'reasoning', text: 'tool output' }],
      source: { kind: 'user' },
    }))
    await bench.ctx.codexAppServer.status({ harness: 'codex' }, new AbortController().signal)
    const calls = await recordedCalls(bench.recordFile)
    expect(calls.filter(call => call.method === 'thread/inject_items')).toHaveLength(1)
    expect(JSON.stringify(eventsOf(agent, 'user/message'))).not.toContain('tool output')
  }, TEST_TIMEOUT)

  it('keeps context pending when the thread refuses it', async () => {
    bench = await setup({ MOCK_CODEX_FAIL_INJECT: '1' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('i2'), agentOptions: {} })
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'refused context' }],
      source: { kind: 'user' },
    }))
    await waitForRecordedCall(bench.recordFile, 'thread/inject_items')
    await bench.ctx.codexAppServer.status({ harness: 'codex' }, new AbortController().signal)

    expect(JSON.stringify(eventsOf(agent, 'user/message'))).not.toContain('refused context')
  }, TEST_TIMEOUT)

  it('refuses context that reaches a thread released while it was in flight', async () => {
    const release = await markerPath('inject-release')
    bench = await setup({
      MOCK_CODEX_INJECT_GATE_FILE: release,
      MOCK_CODEX_FAIL_INJECT: '1',
    })
    const handle = await bench.ctx.agents.create({ sessionId: SessionId('i3'), agentOptions: {} })
    const { agent } = handle
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'in flight context' }],
      source: { kind: 'user' },
    }))
    await waitForRecordedCall(bench.recordFile, 'thread/inject_items')
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'queued context' }],
      source: { kind: 'user' },
    }))
    // Disposal releases the thread while the first injection is still in
    // flight, so the queued one only runs after the binding is gone.
    await handle.dispose()
    await writeFile(release, 'go')
    await bench.ctx.codexAppServer.status({ harness: 'codex' }, new AbortController().signal)

    const calls = await recordedCalls(bench.recordFile)
    const injects = calls.filter(call => call.method === 'thread/inject_items')
    expect(injects).toHaveLength(1)
    expect(JSON.stringify(injects)).not.toContain('queued context')
    expect(JSON.stringify(eventsOf(agent, 'user/message'))).not.toContain('context')
  }, TEST_TIMEOUT)

  it('fails the turn for an input block Codex cannot forward', async () => {
    bench = await setup()
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('i4'), agentOptions: {} })
    agent.followup(createUserMessage({
      content: [{ type: 'reasoning', text: 'tool output' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(turnEndKind(agent)).toBe('error')
    expect(JSON.stringify(events(agent).findLast(event => event.type === 'turn/end')?.data))
      .toContain('cannot forward')
    const calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'turn/start')).toBe(false)
  }, TEST_TIMEOUT)
})

describe('request mappings with absent members', () => {
  it('grants nothing for a permissions request that names no profile', async () => {
    bench = await setup(
      { MOCK_CODEX_SCENARIO: 'permissions-bare' },
      { approval: { outcome: 'allowed-once' } },
    )
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('n1'), agentOptions: {} })
    send(agent, 'bare permissions')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'permissions-outcome')
    expect(outcome.params).toEqual({ permissions: {}, scope: 'turn' })
  }, TEST_TIMEOUT)

  it('answers nothing for a user-input request without questions', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'user-input-bare' }, { questions: 'answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('n2'), agentOptions: {} })
    send(agent, 'no questions')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'user-input-answers')
    expect(outcome.params).toEqual({ answers: {} })
  }, TEST_TIMEOUT)

  it('declines a form elicitation with an unmappable field and a non-string enum', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit-loose' }, { questions: 'answer' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('n3'), agentOptions: {} })
    send(agent, 'loose form')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'elicitation-outcome')
    expect(outcome.params).toMatchObject({ action: 'decline' })
  }, TEST_TIMEOUT)

  it('declines a schema-less elicitation whose ask fails', async () => {
    bench = await setup({ MOCK_CODEX_SCENARIO: 'elicit-plain' }, { questions: 'throw' })
    const { agent } = await bench.ctx.agents.create({ sessionId: SessionId('n4'), agentOptions: {} })
    send(agent, 'no human')
    await agent.whenIdle()

    const outcome = await recordedCall(bench.recordFile, 'elicitation-outcome')
    expect(outcome.params).toMatchObject({ action: 'decline' })
  }, TEST_TIMEOUT)
})

/** Poll until `file` exists — subprocess cold-start is variable. */
async function waitForFile(file: string): Promise<void> {
  await expect.poll(() => existsSync(file), { timeout: 20_000 }).toBe(true)
}

/** Poll the mock's frame record until it names `method`. */
async function waitForRecordedCall(file: string, method: string): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  await expect.poll(async () => {
    if (!existsSync(file)) return false
    return (await readFile(file, 'utf8')).includes(`"${method}"`)
  }, { timeout: 20_000 }).toBe(true)
}

/** Every `{method, params}` frame the mock child recorded, in order. */
async function recordedCalls(file: string): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  return (await readFile(file, 'utf8')).trim().split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> })
}

/** One marker path under a fresh private temp root, for a gate or readiness file. */
async function markerPath(prefix: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), `agent-codex-${prefix}-`)), 'marker')
}

/**
 * Fault-inject one durable event type for this session: only that type's
 * append throws, so a test can drive the driver's settlement containment while
 * every other event still lands.
 * @returns the restore function.
 */
function failAppends(agent: Agent, type: string): () => void {
  const session = agent.session
  const original = session.append.bind(session)
  session.append = (((eventType: string, ...rest: unknown[]) => {
    if (eventType === type) throw new Error(`durable append refused for ${eventType}`)
    return (original as (...args: unknown[]) => unknown)(eventType, ...rest)
  }) as unknown) as typeof session.append
  return () => { session.append = original }
}

/** One durable image reference for a message block. */
function imageRef(attachmentId: string) {
  return {
    attachmentId: brandString<AttachmentId>(attachmentId),
    mediaType: 'image/png' as const,
    bytes: 12,
    width: 2,
    height: 2,
  }
}

/** One durable file reference for a message block. */
function fileRef() {
  return {
    attachmentId: brandString<AttachmentId>('sha256:cccc'),
    name: 'example.txt',
    bytes: 5,
  }
}

/** Every recorded `turn/start` input array of the bench's child, in order. */
async function recordedInputs(file: string): Promise<unknown[]> {
  const { readFile } = await import('node:fs/promises')
  const records = (await readFile(file, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { method: string; params: { input?: unknown[] } })
  return records.filter(record => record.method === 'turn/start').map(record => record.params.input)
}

/** The recorded `turn/start` params of the bench's child. */
async function recordedTurnStart(file: string): Promise<{ params: Record<string, unknown> }> {
  return recordedCall(file, 'turn/start')
}

/** The first recorded call with `method`. */
async function recordedCall(file: string, method: string): Promise<{ params: Record<string, unknown> }> {
  const { readFile } = await import('node:fs/promises')
  const records = (await readFile(file, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> })
  const match = records.find(record => record.method === method)
  if (match === undefined) throw new Error(`the mock child recorded no ${method}`)
  return { params: match.params }
}

async function teardownBench(): Promise<void> {
  const target = bench
  bench = undefined
  if (target === undefined) return
  await target.ctx.fiber.dispose()
  await rm(target.root, { recursive: true, force: true })
}

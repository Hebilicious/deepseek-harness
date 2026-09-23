/**
 * Lifecycle tests for one instance's app-server runtime, driven directly
 * through a REAL subprocess: the scripted mock `codex app-server --stdio`
 * server. Each case owns one runtime and proves an externally observable fact
 * — the child is reaped, a later connect spawns a fresh one, a throwing
 * consumer cannot fail the shared connection — without reaching into the
 * runtime's private slots.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessSpawnSpec,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { CodexAppServerRuntime } from '../src/index.ts'

const mockServer = fileURLToPath(new URL('./mock-codex-app-server.ts', import.meta.url))

interface RuntimeBench {
  readonly ctx: Context
  readonly root: string
  readonly recordFile: string
  readonly runtime: CodexAppServerRuntime
}

/** Poll until `file` exists — subprocess cold-start is variable. */
async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`mock child never wrote ${file}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

interface RecordedCall {
  readonly method: string
  readonly params?: unknown
}

function recordedCalls(file: string): RecordedCall[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as RecordedCall)
}

/** Poll the mock's frame record until `method` has been recorded `count` times. */
async function waitForCalls(file: string, method: string, count: number, timeoutMs: number): Promise<RecordedCall[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const calls = recordedCalls(file)
    if (calls.filter(call => call.method === method).length >= count) return calls
    if (Date.now() > deadline) throw new Error(`mock child never recorded ${String(count)} × ${method}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const TEST_TIMEOUT = 30_000

let bench: RuntimeBench | undefined

async function setupRuntime(env: Record<string, string> = {}): Promise<RuntimeBench> {
  const root = await mkdtemp(join(tmpdir(), 'agent-codex-runtime-'))
  const recordFile = join(root, 'record.jsonl')
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const runtime = new CodexAppServerRuntime(ctx, {
    command: process.execPath,
    args: [mockServer],
    codexHome: root,
    env: { MOCK_CODEX_RECORD_FILE: recordFile, ...env },
    disposeGraceMs: 5000,
    eofGraceMs: 1000,
  })
  return { ctx, root, recordFile, runtime }
}

afterEach(async () => {
  const target = bench
  bench = undefined
  if (target === undefined) return
  await target.runtime.dispose().catch(() => {})
  await target.ctx.fiber.dispose()
  await rm(target.root, { recursive: true, force: true })
})

describe('agent-codex runtime lifecycle', () => {
  it('reaps a child still handshaking and refuses later connects after disposal', async () => {
    const markers = await mkdtemp(join(tmpdir(), 'agent-codex-runtime-startup-'))
    const initialized = join(markers, 'initialized')
    const exited = join(markers, 'exited')
    const pidFile = join(markers, 'pid')
    bench = await setupRuntime({
      MOCK_CODEX_INITIALIZE_FILE: initialized,
      // The gate file is never written, so the handshake never completes.
      MOCK_CODEX_INITIALIZE_GATE_FILE: join(markers, 'release'),
      MOCK_CODEX_FLUSH_ON_EOF: exited,
      MOCK_CODEX_FLUSH_DELAY_MS: '20',
      MOCK_CODEX_PID_FILE: pidFile,
    })
    const connecting = bench.runtime.connect()
    await waitForFile(initialized, TEST_TIMEOUT - 5000)

    // Disposal starts while the initialize response is still gated: it must
    // reach the child, and the interrupted startup must fail rather than hang.
    const disposing = bench.runtime.dispose()
    await expect(connecting).rejects.toThrow('disposed')
    await disposing

    expect(existsSync(exited)).toBe(true)
    // dispose() resolves at whole-range quiescence, so the child is reaped.
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => { process.kill(pid, 0) }).toThrow()
    await expect(bench.runtime.connect()).rejects.toThrow('runtime is disposed')
  }, TEST_TIMEOUT)

  it('respawns a fresh child after the shared one exits', async () => {
    const pidFile = join(await mkdtemp(join(tmpdir(), 'agent-codex-runtime-pid-')), 'pid')
    bench = await setupRuntime({ MOCK_CODEX_PID_FILE: pidFile })
    const first = await bench.runtime.connect()
    const fatal = first.fatal.catch(() => 'failed')

    process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    // The dead wire must fail every operation racing it instead of hanging.
    await expect(fatal).resolves.toBe('failed')
    await expect(first.request('account/read', {})).rejects.toThrow()

    const second = await bench.runtime.connect()
    expect(second).not.toBe(first)
    const calls = await waitForCalls(bench.recordFile, 'initialize', 2, TEST_TIMEOUT - 5000)
    expect(calls.filter(call => call.method === 'initialize')).toHaveLength(2)
    const account = await bench.runtime.readAccount()
    expect(account.authenticated).toBe(true)
  }, TEST_TIMEOUT)

  it('contains a throwing account listener and keeps the connection live', async () => {
    bench = await setupRuntime({ MOCK_CODEX_ACCOUNT_NOTIFY: '1' })
    const seen: string[] = []
    bench.runtime.onAccountNotification(() => { throw new Error('listener exploded') })
    const detach = bench.runtime.onAccountNotification((method) => { seen.push(method) })
    await bench.runtime.connect()

    await waitForCalls(bench.recordFile, 'initialize', 1, TEST_TIMEOUT - 5000)
    const deadline = Date.now() + TEST_TIMEOUT - 5000
    while (seen.length === 0) {
      if (Date.now() > deadline) throw new Error('account notification never reached the surviving listener')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    detach()

    // The connection still serves work after the listener threw.
    const account = await bench.runtime.readAccount()
    expect(account.authenticated).toBe(true)
    expect(seen).toEqual(['account/updated'])
  }, TEST_TIMEOUT)

  it('refuses server frames no thread owns without failing the connection', async () => {
    bench = await setupRuntime({ MOCK_CODEX_UNKNOWN_FRAMES: '1' })
    await bench.runtime.connect()
    const calls = await waitForCalls(bench.recordFile, 'server-request-error', 2, TEST_TIMEOUT - 5000)
    const refusals = calls.filter(call => call.method === 'server-request-error')
    expect(JSON.stringify(refusals)).toContain('unregistered thread')
    expect(JSON.stringify(refusals)).toContain('unsupported app-server request')

    const account = await bench.runtime.readAccount()
    expect(account.authenticated).toBe(true)
  }, TEST_TIMEOUT)

  it('rejects a second peer for one thread and releases the first on dispose', async () => {
    bench = await setupRuntime()
    await bench.runtime.connect()
    const peerA = {
      notification: () => {},
      failed: () => {},
      request: async () => ({}),
    }
    const peerB = { ...peerA }
    const runtime = bench.runtime
    const detachA = runtime.registerThread('thread-a', peerA)
    expect(() => runtime.registerThread('thread-a', peerB))
      .toThrow('already has a registered peer')

    detachA()
    const detachB = runtime.registerThread('thread-a', peerB)
    // A stale disposer must not release a thread that was rebound since.
    detachA()
    expect(() => runtime.registerThread('thread-a', peerA))
      .toThrow('already has a registered peer')
    detachB()
    expect(() => runtime.registerThread('thread-a', peerA)).not.toThrow()
  }, TEST_TIMEOUT)

  it('abandons a connect for an aborted caller signal', async () => {
    bench = await setupRuntime()
    await expect(bench.runtime.connect(AbortSignal.abort(new Error('caller left'))))
      .rejects.toThrow('caller left')
    // The abandoned startup still owns the child it spawned, so the caller's
    // connection request fails without leaving the runtime unusable.
    const connection = await bench.runtime.connect()
    expect(connection).toBeDefined()
  }, TEST_TIMEOUT)

  it('wraps a non-Error abort reason when a connect is already abandoned', async () => {
    bench = await setupRuntime()
    await expect(bench.runtime.connect(AbortSignal.abort('caller left')))
      .rejects.toThrow('caller left')
  }, TEST_TIMEOUT)

  it('abandons a connect whose signal aborts mid-handshake', async () => {
    const markers = await mkdtemp(join(tmpdir(), 'agent-codex-runtime-abort-'))
    const initialized = join(markers, 'initialized')
    bench = await setupRuntime({
      MOCK_CODEX_INITIALIZE_FILE: initialized,
      MOCK_CODEX_INITIALIZE_GATE_FILE: join(markers, 'release'),
    })
    const controller = new AbortController()
    const connecting = bench.runtime.connect(controller.signal)
    await waitForFile(initialized, TEST_TIMEOUT - 5000)
    controller.abort('no error object')
    await expect(connecting).rejects.toThrow('no error object')
  }, TEST_TIMEOUT)

  it('reaps a child that spawns after disposal already latched', async () => {
    bench = await setupRuntime()
    const connecting = bench.runtime.connect()
    // Same tick as the connect: the process spawn is still in flight, so
    // disposal cannot retire it yet and must refuse it once it arrives.
    const disposing = bench.runtime.dispose()
    await expect(connecting).rejects.toThrow('disposed')
    await disposing
    await expect(bench.runtime.connect()).rejects.toThrow('runtime is disposed')
  }, TEST_TIMEOUT)

  it('disposes without ever connecting', async () => {
    bench = await setupRuntime()
    await expect(bench.runtime.dispose()).resolves.toBeUndefined()
  }, TEST_TIMEOUT)

  it('walks the escalation ladder when the child ignores stdin EOF', async () => {
    const sigtermFile = join(await mkdtemp(join(tmpdir(), 'agent-codex-runtime-eof-')), 'sigterm')
    bench = await setupRuntime({
      MOCK_CODEX_IGNORE_EOF: '1',
      MOCK_CODEX_SIGTERM_FILE: sigtermFile,
      MOCK_CODEX_TRAP_SIGTERM: '1',
    })
    await bench.runtime.connect()
    await bench.runtime.dispose()
    // The trapped SIGTERM forced the SIGKILL tier, which still proves the
    // whole range is empty when dispose resolves.
    await expect(bench.runtime.connect()).rejects.toThrow('runtime is disposed')
  }, TEST_TIMEOUT)

  it.each([
    ['invalid model/list data', { MOCK_CODEX_MODEL_LIST_SHAPE: 'bad-data' }, 'invalid model/list data'],
    ['an invalid model/list cursor', { MOCK_CODEX_MODEL_LIST_SHAPE: 'bad-cursor' }, 'invalid model/list cursor'],
  ])('refuses %s', async (_label, env, message) => {
    bench = await setupRuntime(env)
    await expect(bench.runtime.listCodexModels()).rejects.toThrow(message)
  }, TEST_TIMEOUT)

  it('serves the rate-limit buckets the app-server reports', async () => {
    bench = await setupRuntime({ MOCK_CODEX_RATE_LIMIT_BUCKETS: '1' })
    const limits = await bench.runtime.readRateLimits()
    expect(limits.rateLimitsByLimitId).toMatchObject({ codex: { limitId: 'codex' } })
  }, TEST_TIMEOUT)

  it('contains a peer whose notification handler throws a non-Error', async () => {
    bench = await setupRuntime({ MOCK_CODEX_UNKNOWN_FRAMES: '1' })
    const failures: unknown[] = []
    // The probe fixture addresses `thread-unowned`: its notification must reach
    // this peer, whose non-Error throw stays scoped here.
    const detach = bench.runtime.registerThread('thread-unowned', {
      notification: () => { throw 'peer exploded' },
      failed: (error) => { failures.push(error) },
      request: async () => ({}),
    })
    await bench.runtime.connect()
    const deadline = Date.now() + TEST_TIMEOUT - 5000
    while (failures.length === 0) {
      if (Date.now() > deadline) throw new Error('the peer never received its notification')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    detach()

    expect(failures.map(error => String(error))).toEqual(['Error: peer exploded'])
    const account = await bench.runtime.readAccount()
    expect(account.authenticated).toBe(true)
  }, TEST_TIMEOUT)
})

/** One scripted child handle: a live pipe pair the runtime may write to. */
interface ScriptedHandleOptions {
  /** Settles with the child's outcome, or rejects for a provider failure. */
  readonly done: Promise<SubprocessOutcome>
  /** Bounds the managed-range wait; defaults to an immediately empty range. */
  readonly waitForExit?: (signal?: AbortSignal) => Promise<boolean>
}

/**
 * A subprocess provider whose resolution and spawn outcomes the test scripts,
 * so the runtime's own failure paths run without a child process.
 */
class ScriptedSubprocess extends SubprocessRuntime {
  readonly spawns: SubprocessSpawnSpec[] = []
  private readonly resolutions: Array<Error | undefined>
  private readonly handles: SubprocessHandle[]

  /**
   * @param ctx - the plugin fiber context.
   * @param config - planned resolutions and handles, consumed in order.
   */
  constructor(
    ctx: Context,
    config: { resolutions: Array<Error | undefined>; handles: SubprocessHandle[] },
  ) {
    super(ctx)
    this.resolutions = config.resolutions
    this.handles = config.handles
  }

  /** The fake provider reports a POSIX shell environment; the codex driver never asks. */
  async terminalEnvironment(): Promise<{ platform: 'posix' }> {
    return { platform: 'posix' }
  }

  override async resolveExecutable(command: string): Promise<string> {
    const failure = this.resolutions.shift()
    if (failure !== undefined) throw failure
    return command
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    const handle = this.handles.shift()
    if (handle === undefined) throw new Error('no scripted handle remains')
    return handle
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('this fixture serves no terminal'))
  }
}

/** The open streams of every scripted handle, closed after the case. */
const scriptedStreams: PassThrough[] = []
const scriptedContexts: Context[] = []

/** One scripted child handle over a live pipe pair. */
function scriptedHandle(options: ScriptedHandleOptions): SubprocessHandle {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  scriptedStreams.push(stdin, stdout)
  return {
    stdin,
    stdout,
    stderr: undefined,
    control: undefined,
    collected: {},
    done: options.done,
    terminate: () => {},
    waitForExit: options.waitForExit ?? (async () => true),
  }
}

/** A runtime plus its scripted provider, torn down after the case. */
interface ScriptedBench {
  readonly runtime: CodexAppServerRuntime
  readonly subprocess: ScriptedSubprocess
}

/** A runtime over a scripted provider. */
async function setupScripted(
  config: { resolutions?: Array<Error | undefined>; handles: SubprocessHandle[] },
): Promise<ScriptedBench> {
  const ctx = new Context()
  scriptedContexts.push(ctx)
  await ctx.plugin(ScriptedSubprocess, { resolutions: config.resolutions ?? [], handles: config.handles })
  const runtime = new CodexAppServerRuntime(ctx, {
    command: 'codex-stub',
    args: [],
    codexHome: tmpdir(),
    env: {},
    disposeGraceMs: 50,
    eofGraceMs: 50,
  })
  return { runtime, subprocess: ctx.get('subprocess') as ScriptedSubprocess }
}

describe('agent-codex runtime with scripted spawns', () => {
  afterEach(async () => {
    for (const ctx of scriptedContexts.splice(0)) await ctx.fiber.dispose()
    for (const stream of scriptedStreams.splice(0)) stream.destroy()
  })

  it('retries a spawn failure instead of caching it', async () => {
    // The first resolution fails before any child exists; the memoized startup
    // must not stay poisoned, so the next connect resolves again.
    const { runtime, subprocess } = await setupScripted({
      resolutions: [new Error('codex is not installed')],
      handles: [scriptedHandle({ done: new Promise<SubprocessOutcome>(() => {}) })],
    })
    await expect(runtime.connect()).rejects.toThrow('codex is not installed')
    expect(subprocess.spawns).toHaveLength(0)

    const connecting = runtime.connect()
    await expect.poll(() => subprocess.spawns.length).toBe(1)
    // The scripted child never answers initialize, so the retried connection
    // stays pending until disposal retires the pair it produced.
    const disposing = runtime.dispose()
    await expect(connecting).rejects.toThrow('disposed')
    await disposing
  }, TEST_TIMEOUT)

  it('retires the pair and respawns when the child handle rejects', async () => {
    const { runtime, subprocess } = await setupScripted({
      handles: [
        scriptedHandle({ done: Promise.reject(new Error('provider lost the child')) }),
        scriptedHandle({ done: new Promise<SubprocessOutcome>(() => {}) }),
      ],
    })
    await expect(runtime.connect()).rejects.toThrow('provider lost the child')

    // A second connect must spawn again rather than reuse the dead pair.
    const second = runtime.connect()
    await expect.poll(() => subprocess.spawns.length).toBe(2)
    const disposing = runtime.dispose()
    await expect(second).rejects.toThrow('disposed')
    await disposing
  }, TEST_TIMEOUT)

  it('records a teardown the provider cannot complete', async () => {
    const { runtime } = await setupScripted({
      handles: [scriptedHandle({
        done: new Promise<SubprocessOutcome>(() => {}),
        waitForExit: async () => { throw new Error('provider can no longer observe its range') },
      })],
    })
    const connecting = runtime.connect()
    // Disposal retires the pair while the handshake is still in flight; the
    // failing range wait is recorded, never rethrown at the disposing caller.
    const disposing = runtime.dispose()
    await expect(connecting).rejects.toThrow('disposed')
    await expect(disposing).resolves.toBeUndefined()
  }, TEST_TIMEOUT)
})

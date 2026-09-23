/**
 * Lifecycle tests for the profile-shared {@link AcpRuntime}: memoized connect,
 * mid-handshake disposal, respawn after the child dies, auth verbs, and the
 * CLI catalog. Every child is the scripted mock `devin acp` agent; the
 * runtime is driven directly so process-level facts (pids, exit quiescence)
 * are observable.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { AcpRuntime, isHarnessFailure, type AcpRuntimeOptions } from '../src/runtime.ts'

const mockAgent = fileURLToPath(new URL('./mock-acp-agent.ts', import.meta.url))

interface RuntimeBench {
  readonly ctx: Context
  readonly runtime: AcpRuntime
  readonly root: string
  readonly recordFile: string
}

interface RecordedCall {
  readonly method: string
  readonly params: { argv?: readonly string[] }
}

async function recordedCalls(file: string): Promise<RecordedCall[]> {
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  return text.trim() === '' ? [] : text.trim().split('\n').map(line => JSON.parse(line) as RecordedCall)
}

/** Poll until `predicate` holds — child exit, retirement, and EOF are asynchronous. */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  await waitFor(() => existsSync(file), timeoutMs)
}

/** Whether a pid still names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Mount the subprocess provider and one runtime pointed at the mock agent. */
async function runtimeBench(
  env: Record<string, string> = {},
  options: Partial<AcpRuntimeOptions> = {},
): Promise<RuntimeBench> {
  const root = await mkdtemp(join(tmpdir(), 'agent-acp-runtime-'))
  const recordFile = join(root, 'record.jsonl')
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const runtime = new AcpRuntime(ctx, {
    harness: 'devin',
    command: process.execPath,
    args: [mockAgent, 'acp'],
    cwd: root,
    env: { MOCK_RECORD_FILE: recordFile, ...env },
    disposeGraceMs: 5000,
    eofGraceMs: 2000,
    catalogArgs: [mockAgent, 'models', 'list', '--format', 'json'],
    probeCatalog: true,
    authStatusArgs: [mockAgent, 'auth', 'status'],
    authLogoutArgs: [mockAgent, 'auth', 'logout'],
    catalogCacheMs: 300_000,
    catalogFailureCacheMs: 30_000,
    cliTimeoutMs: 60_000,
    ...options,
  })
  return { ctx, runtime, root, recordFile }
}

let bench: RuntimeBench | undefined
afterEach(async () => {
  await bench?.ctx.fiber.dispose()
  if (bench !== undefined) await rm(bench.root, { recursive: true, force: true })
  bench = undefined
})

describe('AcpRuntime lifecycle', () => {
  it('memoizes one connection, publishes its initialize facts, and disposes idempotently', async () => {
    bench = await runtimeBench()
    expect(bench.runtime.initializeInfo).toBeUndefined()
    expect(bench.runtime.active).toBeUndefined()

    const first = await bench.runtime.connect()
    expect(await bench.runtime.connect()).toBe(first)
    expect(bench.runtime.active).toBe(first)
    expect(bench.runtime.initializeInfo?.protocolVersion).toBeDefined()
    expect(first.closed).toBe(false)
    expect(typeof first.agent.notify).toBe('function')

    await bench.runtime.dispose()
    expect(bench.runtime.active).toBeUndefined()
    expect(bench.runtime.initializeInfo).toBeUndefined()
    expect(first.closed).toBe(true)
    // Idempotent: a second dispose neither throws nor touches the dead child.
    await bench.runtime.dispose()
  }, 30_000)

  it('refuses connect and session registration once disposed', async () => {
    bench = await runtimeBench()
    expect(() => bench?.runtime.registerSession('acp-1', {
      update: () => {},
      requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      elicitation: () => Promise.resolve({ action: 'decline' }),
    })).toThrow('session registration before connect')

    const connection = await bench.runtime.connect()
    const detach = bench.runtime.registerSession('acp-1', {
      update: () => {},
      requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      elicitation: () => Promise.resolve({ action: 'decline' }),
    })
    detach()
    expect(connection.closed).toBe(false)

    await bench.runtime.dispose()
    await expect(bench.runtime.connect()).rejects.toThrow('runtime is disposed')
  }, 30_000)

  it('disposes a child whose handshake is still in flight and refuses later connects', async () => {
    const pidFile = join(tmpdir(), `agent-acp-pid-${String(Date.now())}`)
    bench = await runtimeBench({ MOCK_INITIALIZE_DELAY_MS: '1200', MOCK_PID_FILE: pidFile })
    const connecting = bench.runtime.connect()
    await waitForFile(pidFile)
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(alive(pid)).toBe(true)

    const disposal = bench.runtime.dispose()
    // The in-flight handshake settles after the latch, so it must neither
    // publish an endpoint nor leave its child running.
    await expect(connecting).rejects.toThrow('runtime is disposed')
    await disposal
    expect(alive(pid)).toBe(false)
    expect(bench.runtime.active).toBeUndefined()
    await expect(bench.runtime.connect()).rejects.toThrow('runtime is disposed')
  }, 30_000)

  it('respawns a fresh child after the shared child dies', async () => {
    const pidFile = join(tmpdir(), `agent-acp-pid-${String(Date.now())}-respawn`)
    bench = await runtimeBench({ MOCK_PID_FILE: pidFile })
    const first = await bench.runtime.connect()
    const firstPid = Number(await readFile(pidFile, 'utf8'))

    process.kill(firstPid, 'SIGKILL')
    await expect(first.fatal).rejects.toThrow('ACP connection closed')
    await waitFor(() => bench?.runtime.active === undefined)
    expect(bench.runtime.initializeInfo).toBeUndefined()

    const second = await bench.runtime.connect()
    expect(second).not.toBe(first)
    const secondPid = Number(await readFile(pidFile, 'utf8'))
    expect(secondPid).not.toBe(firstPid)
    expect(bench.runtime.active).toBe(second)
    expect(bench.runtime.initializeInfo).toBeDefined()
    const initializes = (await recordedCalls(bench.recordFile)).filter(call => call.method === 'initialize')
    expect(initializes).toHaveLength(2)
  }, 30_000)
})

describe('AcpRuntime auth', () => {
  it('connects on demand and falls back to the devin CLI when the agent advertises no logout', async () => {
    bench = await runtimeBench()
    expect(bench.runtime.initializeInfo).toBeUndefined()

    await bench.runtime.logout()
    // The connect happened on demand, so "advertises no logout method" is a
    // fact about the agent rather than an assumption made before it answered.
    expect(bench.runtime.initializeInfo).toBeDefined()
    const connection = await bench.runtime.connect()
    await bench.runtime.logout()

    const calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'logout')).toBe(false)
    const logouts = calls.filter(
      call => call.method === 'cli' && call.params.argv?.includes('logout') === true,
    )
    expect(logouts).toHaveLength(2)
    expect(connection.closed).toBe(false)
  }, 30_000)

  it('sends the ACP logout request when the agent advertises it, without a prior connect', async () => {
    bench = await runtimeBench({ MOCK_LOGOUT: '1' })
    expect(bench.runtime.initializeInfo).toBeUndefined()
    await bench.runtime.logout()

    const calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'logout')).toBe(true)
    expect(calls.some(call => call.method === 'cli' && call.params.argv?.includes('logout') === true)).toBe(false)
  }, 30_000)

  it('forwards authenticate to the agent and reports CLI auth state', async () => {
    bench = await runtimeBench({ MOCK_AUTH_DETAIL: 'logged in as mock@example.com' })
    await bench.runtime.authenticate('devin-browser')
    const status = await bench.runtime.authStatus()
    expect(status).toEqual({ loggedIn: true, detail: 'logged in as mock@example.com' })
    expect((await recordedCalls(bench.recordFile)).some(call => call.method === 'authenticate')).toBe(true)
  }, 30_000)

  it('treats an explicitly empty auth verb list as no CLI verb', async () => {
    // A harness whose authentication lives in its ACP methods configures no
    // verb, and nothing may be spawned for a status or logout read.
    bench = await runtimeBench({}, { authStatusArgs: [], authLogoutArgs: [] })
    const status = await bench.runtime.authStatus()
    expect(status.loggedIn).toBe(false)
    expect(status.detail).toContain('reports authorization through its ACP methods')
    await expect(bench.runtime.authLogout()).rejects.toThrow('configures no auth-logout command')
  }, 30_000)

  it('reports a non-zero auth-status exit and an unresolvable command as logged out', async () => {
    bench = await runtimeBench({ MOCK_AUTH_LOGGED_OUT: '1' })
    expect(await bench.runtime.authStatus()).toEqual({ loggedIn: false, detail: 'mock auth detail' })
    await bench.ctx.fiber.dispose()
    bench = await runtimeBench({}, { command: 'dsh-agent-acp-no-such-binary' })
    const missing = await bench.runtime.authStatus()
    expect(missing.loggedIn).toBe(false)
    expect(missing.detail).toContain('dsh-agent-acp-no-such-binary')
    await expect(bench.runtime.authLogout()).rejects.toThrow('not found on PATH')
  }, 30_000)
})

describe('AcpRuntime model catalog', () => {
  it('publishes the newest non-empty session advert and ignores an empty one', async () => {
    bench = await runtimeBench()
    expect(bench.runtime.advertisedModels).toEqual([])

    bench.runtime.recordAdvert([{ id: 'swe-1', name: 'SWE 1' }])
    expect(bench.runtime.advertisedModels).toEqual([{ id: 'swe-1', name: 'SWE 1' }])

    // An empty advert carries no catalog, so it never replaces a known one.
    bench.runtime.recordAdvert([])
    expect(bench.runtime.advertisedModels).toEqual([{ id: 'swe-1', name: 'SWE 1' }])

    bench.runtime.recordAdvert([{ id: 'swe-2', name: 'SWE 2', description: 'standard' }])
    expect(bench.runtime.advertisedModels).toEqual([
      { id: 'swe-2', name: 'SWE 2', description: 'standard' },
    ])
  }, 30_000)

  it('lists nothing from the CLI when the deployment configures no catalog verb', async () => {
    bench = await runtimeBench({})
    await expect(bench.runtime.listCatalogCli()).resolves.toEqual([])
  }, 30_000)

  it('flattens the CLI families and skips variants it cannot name', async () => {
    bench = await runtimeBench({
      MOCK_MODELS_JSON: JSON.stringify({
        families: [
          {
            family_uid: 'family-1',
            variants: [
              { model_uid: 'swe-2', label: 'SWE 2', cost_summary: 'standard' },
              { model_uid: 'swe-1', label: 'SWE 1' },
              { label: 'unnamed family member' },
              { model_uid: 'unlabelled' },
              'not-a-variant',
            ],
          },
          { family_uid: 'family-without-variants' },
          'not-a-family',
        ],
      }),
    })
    expect(await bench.runtime.listCatalogCli()).toEqual([
      { id: 'swe-2', name: 'SWE 2', description: 'standard' },
      { id: 'swe-1', name: 'SWE 1' },
    ])
  }, 30_000)

  it('rejects a catalog response without a families array', async () => {
    bench = await runtimeBench({ MOCK_MODELS_JSON: '{"families":"none"}' })
    await expect(bench.runtime.listCatalogCli()).rejects.toThrow('no families array')
    await bench.ctx.fiber.dispose()
    bench = await runtimeBench({ MOCK_MODELS_JSON: '[]' })
    await expect(bench.runtime.listCatalogCli()).rejects.toThrow('no families array')
    await bench.ctx.fiber.dispose()
    // A payload that is not a JSON object at all carries no families either.
    bench = await runtimeBench({ MOCK_MODELS_JSON: '42' })
    await expect(bench.runtime.listCatalogCli()).rejects.toThrow('no families array')
  }, 30_000)

  it('gives up on a CLI verb that never answers', async () => {
    bench = await runtimeBench({ MOCK_MODELS_HANG: '1' }, { cliTimeoutMs: 300 })
    await expect(bench.runtime.listCatalogCli()).rejects.toThrow('did not answer within 300ms')
    // The deadline is per call, so a later attempt is not poisoned by it.
    await expect(bench.runtime.listCatalogCli()).rejects.toThrow('did not answer within 300ms')
  }, 30_000)

  it('surfaces a CLI failure with its exit code and stderr', async () => {
    bench = await runtimeBench({}, { catalogArgs: [mockAgent, 'bogus'] })
    await expect(bench.runtime.listCatalogCli()).rejects.toThrow('exited 2: unknown subcommand bogus')
    await expect(bench.runtime.listCatalogCli()).rejects.toThrow('agent-acp')
    await bench.ctx.fiber.dispose()
    // A silent non-zero exit reports only the exit code.
    bench = await runtimeBench({ MOCK_MODELS_EXIT: '3' })
    await expect(bench.runtime.listCatalogCli()).rejects.toThrow(/exited 3$/)
  }, 30_000)

  it('remembers a failed read for its own window and rethrows that failure', async () => {
    // A harness that keeps failing (a mis-installed executable the picker sees
    // as a spawn failure) must not be spawned once per picker poll.
    bench = await runtimeBench({ MOCK_MODELS_EXIT: '3' }, { catalogFailureCacheMs: 30_000 })
    const first: unknown = await bench.runtime.catalog().then(() => undefined, (error: unknown) => error)
    expect(String(first)).toContain('exited 3')

    const second: unknown = await bench.runtime.catalog().then(() => undefined, (error: unknown) => error)
    expect(second).toBe(first)
    expect((await recordedCalls(bench.recordFile)).filter(call => call.method === 'cli')).toHaveLength(1)
  }, 30_000)

  it('retries the read once the failure window has passed', async () => {
    bench = await runtimeBench({ MOCK_MODELS_EXIT: '3' }, { catalogFailureCacheMs: 50 })
    await expect(bench.runtime.catalog()).rejects.toThrow(/exited 3$/)
    expect((await recordedCalls(bench.recordFile)).filter(call => call.method === 'cli')).toHaveLength(1)

    await new Promise(resolve => setTimeout(resolve, 120))
    await expect(bench.runtime.catalog()).rejects.toThrow(/exited 3$/)
    expect((await recordedCalls(bench.recordFile)).filter(call => call.method === 'cli')).toHaveLength(2)
  }, 30_000)

  it('lets a session advert win over a remembered failure', async () => {
    bench = await runtimeBench({ MOCK_MODELS_EXIT: '3' }, { catalogFailureCacheMs: 30_000 })
    await expect(bench.runtime.catalog()).rejects.toThrow(/exited 3$/)

    bench.runtime.recordAdvert([{ id: 'swe-1', name: 'SWE 1' }])
    await expect(bench.runtime.catalog()).resolves.toEqual([{ id: 'swe-1', name: 'SWE 1' }])
  }, 30_000)

  it('starts no read for a caller that is already aborted', async () => {
    // A caller that is already cancelled must not leave a read behind that
    // nothing awaits: its rejection would surface as an unhandled rejection
    // and, under installFailLoud, end the process.
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      bench = await runtimeBench({ MOCK_MODELS_EXIT: '3' })
      const controller = new AbortController()
      controller.abort(new Error('caller already aborted'))

      await expect(bench.runtime.catalog(controller.signal)).rejects.toThrow('caller already aborted')
      // Waiting past the CLI's own failure gives a read the aborted caller had
      // started time to reject with nobody awaiting it.
      await new Promise(resolve => setTimeout(resolve, 500))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(rejections).toEqual([])

    // The abort started nothing, so a live caller still gets the real read.
    await expect(bench.runtime.catalog()).rejects.toThrow(/exited 3$/)
  }, 30_000)

  it('returns the probed catalog when closing the probe session fails', async () => {
    bench = await runtimeBench({
      // The CLI lists nothing, so the read falls through to the probe.
      MOCK_MODELS_JSON: JSON.stringify({ families: [] }),
      MOCK_SESSION_MODELS: JSON.stringify([{ modelId: 'opus', name: 'Opus' }]),
      MOCK_CLOSE: '1',
      MOCK_CLOSE_ERROR: '1',
    })
    const warn = vi.spyOn(bench.ctx.logger, 'warn')

    await expect(bench.runtime.catalog()).resolves.toEqual([{ id: 'opus', name: 'Opus' }])
    const warnings = warn.mock.calls.map(call => String(call[0]))
    expect(warnings.some(message => message.includes('agent-acp[devin]') && message.includes('probe session')))
      .toBe(true)
    warn.mockRestore()

    // The failed close neither fails the read nor leaves the next one to open
    // another probe session.
    await expect(bench.runtime.catalog()).resolves.toEqual([{ id: 'opus', name: 'Opus' }])
    const calls = await recordedCalls(bench.recordFile)
    expect(calls.filter(call => call.method === 'session/close')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'session/new')).toHaveLength(1)
  }, 30_000)

  it('ends a probe the harness never answers, and probes again on the next read', async () => {
    // The read is single-flight, so a harness that accepts the connection and
    // never answers `session/new` would otherwise leave this harness's picker
    // route pending for the process lifetime.
    bench = await runtimeBench({
      // The CLI lists nothing, so the read falls through to the probe.
      MOCK_MODELS_JSON: JSON.stringify({ families: [] }),
      MOCK_HANG_SESSION_NEW: '1',
    }, { cliTimeoutMs: 1_500 })
    const started = Date.now()
    await expect(bench.runtime.catalog()).rejects.toThrow(/catalog probe did not answer within 1500ms/)
    expect(Date.now() - started).toBeLessThan(5_000)

    // That deadline is this runtime's own bound, not a harness verdict: the
    // next read probes again rather than answering from a remembered failure.
    const again = Date.now()
    await expect(bench.runtime.catalog()).rejects.toThrow(/catalog probe did not answer within 1500ms/)
    expect(Date.now() - again).toBeGreaterThan(1_000)
  }, 30_000)

  it('retries a probe its own deadline ended, and remembers a harness refusal', async () => {
    bench = await runtimeBench({
      // The CLI lists nothing, so the read falls through to the probe, and the
      // mock holds its initialize response well past the deadline below.
      MOCK_MODELS_JSON: JSON.stringify({ families: [] }),
      MOCK_INITIALIZE_DELAY_MS: '10000',
    }, { cliTimeoutMs: 3_000 })

    await expect(bench.runtime.catalog()).rejects.toThrow('did not answer within 3000ms')

    const again = Date.now()
    await expect(bench.runtime.catalog()).rejects.toThrow('did not answer within 3000ms')
    expect(Date.now() - again).toBeGreaterThan(1_000)
  }, 30_000)
})

describe('catalog failure classification', () => {
  it('tells a harness failure apart from a cancellation and from its own deadline', () => {
    const deadline = new AbortController()
    const timeout = new Error('the catalog probe did not answer within 300ms')
    deadline.abort(timeout)

    // The runtime's own deadline expiring is its own bound, not a verdict.
    expect(isHarnessFailure(deadline.signal, timeout)).toBe(false)
    // A cancel that reached this read from another caller is not either, even
    // once this runtime's deadline has also expired.
    expect(isHarnessFailure(deadline.signal, new DOMException('caller left', 'AbortError'))).toBe(false)
    expect(isHarnessFailure(undefined, new DOMException('caller left', 'TimeoutError'))).toBe(false)
    // Anything that names no cancellation is a fact about the harness.
    expect(isHarnessFailure(deadline.signal, new Error('exited 3'))).toBe(true)
    expect(isHarnessFailure(undefined, new Error('exited 3'))).toBe(true)
    expect(isHarnessFailure(undefined, 'not an error')).toBe(true)
  })
})

describe('AcpClientConnection', () => {
  it('honours caller cancellation and rejects requests after a fatal close', async () => {
    bench = await runtimeBench()
    const connection = await bench.runtime.connect()

    const controller = new AbortController()
    const pending = connection.request('session/new', { cwd: bench.root, mcpServers: [] }, controller.signal)
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow('caller cancelled')

    const preAborted = AbortSignal.abort(new Error('pre-aborted'))
    await expect(connection.request('session/new', { cwd: bench.root, mcpServers: [] }, preAborted))
      .rejects.toThrow('pre-aborted')

    // A non-Error abort reason still rejects with a usable error.
    const stringAbort = AbortSignal.abort('plain string reason')
    await expect(connection.request('session/new', { cwd: bench.root, mcpServers: [] }, stringAbort))
      .rejects.toThrow('plain string reason')

    const created = await connection.request<{ sessionId: string }>(
      'session/new',
      { cwd: bench.root, mcpServers: [] },
    )
    expect(typeof created.sessionId).toBe('string')

    connection.notify('session/cancel', { sessionId: created.sessionId })
    await waitFor(() => !connection.closed, 1000)

    // Closing is idempotent, and a notification on a closed connection is
    // dropped rather than thrown at its caller.
    connection.close()
    connection.close()
    expect(connection.closed).toBe(true)
    connection.notify('session/cancel', { sessionId: created.sessionId })
    await expect(connection.request('session/new', { cwd: bench.root, mcpServers: [] }))
      .rejects.toThrow('closed')

    // A caller abort wins over the already-rejected transport request, whose
    // rejection is still adopted so it cannot surface as unhandled.
    await expect(connection.request(
      'session/new',
      { cwd: bench.root, mcpServers: [] },
      AbortSignal.abort(new Error('aborted while closed')),
    )).rejects.toThrow('aborted while closed')
  }, 30_000)
})

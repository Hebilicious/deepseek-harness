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
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { AcpRuntime, type AcpRuntimeOptions } from '../src/runtime.ts'

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
  it('falls back to the devin CLI for logout without a connection and without the capability', async () => {
    bench = await runtimeBench()

    await bench.runtime.logout()
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

  it('sends the ACP logout request when the agent advertises it', async () => {
    bench = await runtimeBench({ MOCK_LOGOUT: '1' })
    await bench.runtime.connect()
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

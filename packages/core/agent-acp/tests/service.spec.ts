/**
 * `AcpHarness` service tests: which harness identities the constructor mounts,
 * and the Remote surface's error normalization (`status`, `login`, `logout`)
 * including the unknown-harness refusal. Driver-level behavior of those
 * operations lives in the other specs; this one pins the service's own
 * contract.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { AcpHarness } from '../src/index.ts'
import { type Bench, mockAgent, recordedCalls, setup, teardown } from './bench.ts'

let bench: Bench | undefined
afterEach(async () => {
  await teardown(bench)
  bench = undefined
})

const TEST_TIMEOUT = 30_000

/** Mount the services `AcpHarness` injects, without mounting the harness. */
async function mountServices(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TypertRegistry)
  return ctx
}

describe('AcpHarness construction', () => {
  it('mounts every configured entry as its own agent harness', async () => {
    const ctx = await mountServices()
    new AcpHarness(ctx, {
      harnesses: [
        { id: 'devin', name: 'Devin', executable: 'devin' },
        { id: 'grok', name: 'Grok Build', description: 'xAI Grok Build', executable: 'grok' },
      ],
    })
    expect(ctx.agents.harnesses()).toEqual([
      { id: 'devin', name: 'Devin', modelProvider: 'devin' },
      { id: 'grok', name: 'Grok Build', description: 'xAI Grok Build', modelProvider: 'grok' },
    ])
    await ctx.fiber.dispose()
  })

  it('carries a fully supplied config without substituting defaults', async () => {
    const ctx = await mountServices()
    const harness = new AcpHarness(ctx, {
      harnesses: [{
        id: 'grok',
        name: 'Grok Build',
        executable: mockAgent,
        args: ['agent', '--no-leader', 'stdio'],
        cwd: '/tmp',
        env: { MOCK_TEXT: 'configured' },
        sandbox: 'read-only',
        approval: 'never',
        mode: 'plan',
        model: 'grok-4.7',
        reasoningEffort: 'high',
        catalogArgs: ['models', 'list'],
        authStatusArgs: ['auth', 'status'],
        authLogoutArgs: ['auth', 'logout'],
      }],
      disposeGraceMs: 1234,
      eofGraceMs: 567,
      cliTimeoutMs: 890,
    })
    expect(harness.config.harnesses[0]?.id).toBe('grok')
    expect(harness.config.harnesses[0]?.reasoningEffort).toBe('high')
    await ctx.fiber.dispose()
  })
})

describe('AcpHarness Remote surface', () => {
  it('reports an agent title only when the agent advertises one', async () => {
    bench = await setup({ MOCK_AGENT_INFO: JSON.stringify({ name: 'mock-agent', version: '1.2.3' }) })
    await bench.ctx.agents.create({ sessionId: SessionId('r1'), agentOptions: {} })
    const status = await bench.ctx.acpHarness.status({ harness: 'devin' }, new AbortController().signal)
    expect(status.agentInfo).toEqual({ name: 'mock-agent', version: '1.2.3' })
  }, TEST_TIMEOUT)

  it('rejects every operation naming an unmounted harness with the mounted ids', async () => {
    bench = await setup()
    const signal = new AbortController().signal
    const failures = await Promise.all([
      bench.ctx.acpHarness.status({ harness: 'ghost' }, signal).then(() => undefined, (error: unknown) => error),
      bench.ctx.acpHarness.login({ harness: 'ghost', methodId: 'x' }, signal).then(() => undefined, (error: unknown) => error),
      bench.ctx.acpHarness.logout({ harness: 'ghost' }, signal).then(() => undefined, (error: unknown) => error),
    ])
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(RemoteError)
      expect((failure as RemoteError).code).toBe('gateway/bad-request')
      expect((failure as RemoteError).message).toContain('unknown ACP harness "ghost"')
      expect((failure as RemoteError).message).toContain('mounted: devin')
    }
  }, TEST_TIMEOUT)

  it('normalizes a failing logout and login into Remote errors', async () => {
    bench = await setup({}, { config: { authLogoutArgs: [mockAgent, 'bogus'] } })
    const harness = bench.ctx.acpHarness

    // This deployment's CLI fallback fails; the Remote surfaces the CLI's own
    // diagnostic under the ACP code.
    const failure: unknown = await harness.logout({ harness: 'devin' }, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect((failure as RemoteError).code).toBe('acp/login-failed')
    expect((failure as RemoteError).message).toContain('unknown subcommand bogus')

    const loginFailure: unknown = await harness.login({ harness: 'devin' }, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error)
    expect(loginFailure).toBeInstanceOf(RemoteError)
    expect((loginFailure as RemoteError).code).toBe('gateway/bad-request')
    expect((loginFailure as RemoteError).message).toContain('no auth methods')
  }, TEST_TIMEOUT)

  it('normalizes a runtime failure into the ACP login code', async () => {
    bench = await setup()
    const harness = bench.ctx.acpHarness
    await bench.ctx.agents.create({ sessionId: SessionId('r2'), agentOptions: {} })
    // Dispose the fiber so the runtime latches disposed while the service
    // object itself stays callable.
    await bench.ctx.fiber.dispose()

    const failure: unknown = await harness.login(
      { harness: 'devin', methodId: 'devin-browser' },
      new AbortController().signal,
    ).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect((failure as RemoteError).code).toBe('acp/login-failed')
    expect((failure as RemoteError).message).toContain('runtime is disposed')
  }, TEST_TIMEOUT)

  it('normalizes a cancelled authentication into the ACP login code', async () => {
    bench = await setup({
      MOCK_AUTH_METHODS: JSON.stringify([{ id: 'devin-browser', name: 'Log in with browser' }]),
    })
    await bench.ctx.agents.create({ sessionId: SessionId('r3'), agentOptions: {} })

    const failure: unknown = await bench.ctx.acpHarness.login(
      { harness: 'devin', methodId: 'devin-browser' },
      AbortSignal.abort(new Error('caller left')),
    ).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect((failure as RemoteError).code).toBe('acp/login-failed')
    expect((failure as RemoteError).message).toContain('caller left')
  }, TEST_TIMEOUT)

  it('runs the CLI logout verb the fallback selects', async () => {
    bench = await setup()
    await bench.ctx.acpHarness.logout({ harness: 'devin' }, new AbortController().signal)
    const argv = (await recordedCalls(bench.recordFile))
      .filter(call => call.method === 'cli')
      .map(call => (call.params as { argv: readonly string[] }).argv)
    expect(argv.some(entry => entry.includes('logout'))).toBe(true)
  }, TEST_TIMEOUT)

  it('connects a freshly mounted harness so login starts the method its agent advertises', async () => {
    bench = await setup({
      MOCK_AUTH_METHODS: JSON.stringify([{ id: 'devin-browser', name: 'Log in with browser' }]),
    })
    // Nothing connected this harness: the Remote must, because only the
    // agent's initialize response names the method to start.
    await bench.ctx.acpHarness.login({ harness: 'devin' }, new AbortController().signal)

    const calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'initialize')).toBe(true)
    const authenticate = calls.find(call => call.method === 'authenticate')
    expect((authenticate?.params as { methodId: string }).methodId).toBe('devin-browser')
  }, TEST_TIMEOUT)

  it('connects a freshly mounted harness so logout uses the advertised ACP method', async () => {
    // No CLI logout verb is configured, so the refusal this Remote would
    // otherwise raise ("advertises no ACP logout method") is only true once
    // the agent itself has answered.
    bench = await setup({ MOCK_LOGOUT: '1' }, { config: { authLogoutArgs: [] } })
    await bench.ctx.acpHarness.logout({ harness: 'devin' }, new AbortController().signal)

    const calls = await recordedCalls(bench.recordFile)
    expect(calls.some(call => call.method === 'initialize')).toBe(true)
    expect(calls.some(call => call.method === 'logout')).toBe(true)
    expect(calls.some(call => call.method === 'cli')).toBe(false)
  }, TEST_TIMEOUT)

  it('connects a freshly mounted harness before refusing logout for an agent with no method', async () => {
    bench = await setup({}, { config: { authLogoutArgs: [] } })
    const failure: unknown = await bench.ctx.acpHarness.logout({ harness: 'devin' }, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect((failure as RemoteError).code).toBe('acp/login-failed')
    expect((failure as RemoteError).message).toContain('advertises no ACP logout method')
    // The harness connected before the refusal, so the message is a fact about
    // the agent rather than an assumption made before it answered.
    expect((await recordedCalls(bench.recordFile)).some(call => call.method === 'initialize')).toBe(true)
  }, TEST_TIMEOUT)
})

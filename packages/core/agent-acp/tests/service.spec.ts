/**
 * `AcpHarness` service tests: the constructor's config fallbacks, which the
 * Loader's schema normally supplies, and the Remote surface's error
 * normalization (`status`, `login`, `logout`). Driver-level behavior of those
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
  it('falls back to the documented defaults for every omitted config field', async () => {
    const ctx = await mountServices()
    const harness = new AcpHarness(ctx, {})
    expect(harness.config).toEqual({})
    await ctx.fiber.dispose()
  })

  it('carries a fully supplied config without substituting defaults', async () => {
    const ctx = await mountServices()
    const harness = new AcpHarness(ctx, {
      executable: mockAgent,
      args: ['acp', '--model', 'swe-1'],
      cwd: '/tmp',
      env: { MOCK_TEXT: 'configured' },
      sandbox: 'read-only',
      approval: 'never',
      mode: 'plan',
      model: 'swe-1',
      disposeGraceMs: 1234,
      eofGraceMs: 567,
      modelsArgs: ['models', 'list'],
      authStatusArgs: ['auth', 'status'],
      authLogoutArgs: ['auth', 'logout'],
    })
    expect(harness.config.executable).toBe(mockAgent)
    expect(harness.config.mode).toBe('plan')
    expect(harness.config.model).toBe('swe-1')
    await ctx.fiber.dispose()
  })
})

describe('AcpHarness Remote surface', () => {
  it('reports an agent title only when the agent advertises one', async () => {
    bench = await setup({ MOCK_AGENT_INFO: JSON.stringify({ name: 'mock-agent', version: '1.2.3' }) })
    await bench.ctx.agents.create({ sessionId: SessionId('r1'), agentOptions: {} })
    const status = await bench.ctx.acpHarness.status(new AbortController().signal)
    expect(status.agentInfo).toEqual({ name: 'mock-agent', version: '1.2.3' })
  }, TEST_TIMEOUT)

  it('normalizes a failing logout and login into Remote errors', async () => {
    bench = await setup({}, { config: { authLogoutArgs: [mockAgent, 'bogus'] } })
    const harness = bench.ctx.acpHarness

    // This deployment's CLI fallback fails; the Remote surfaces the CLI's own
    // diagnostic under the ACP code.
    const failure: unknown = await harness.logout(new AbortController().signal)
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect((failure as RemoteError).code).toBe('acp/login-failed')
    expect((failure as RemoteError).message).toContain('unknown subcommand bogus')

    const loginFailure: unknown = await harness.login({}, new AbortController().signal)
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

    const failure: unknown = await harness.login({ methodId: 'devin-browser' }, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect((failure as RemoteError).code).toBe('acp/login-failed')
    expect((failure as RemoteError).message).toContain('runtime is disposed')
  }, TEST_TIMEOUT)

  it('runs the CLI logout verb the fallback selects', async () => {
    bench = await setup()
    await bench.ctx.acpHarness.logout(new AbortController().signal)
    const argv = (await recordedCalls(bench.recordFile))
      .filter(call => call.method === 'cli')
      .map(call => (call.params as { argv: readonly string[] }).argv)
    expect(argv.some(entry => entry.includes('logout'))).toBe(true)
  }, TEST_TIMEOUT)
})

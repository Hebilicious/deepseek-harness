/**
 * Keyless tests for the `codexAppServer` plugin surface: the harness-scoped
 * account Remote methods the settings panel drives, the account-notification
 * stream, the plugin's resolved defaults, and the failure wrapping every
 * Remote method applies. The profile runs the scripted
 * mock `codex app-server --stdio` child, so each case observes the real wire
 * exchange and the normalized payload the client receives.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { CodexAppServer } from '../src/index.ts'

const mockServer = fileURLToPath(new URL('./mock-codex-app-server.ts', import.meta.url))

/** Minimal credentials stand-in: one reference resolves, every other does not. */
class FakeCredentials extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  async resolve(reference: string): Promise<{ value: string; source: string } | undefined> {
    return reference === 'MISSING_KEY' ? undefined : { value: 'sk-mock-test-key', source: 'env' }
  }
}

interface Bench {
  readonly ctx: Context
  readonly root: string
}

interface BenchOptions {
  /** Mount the credentials stand-in. */
  readonly credentials?: boolean
  /** Configured credential reference for the unattended api-key login. */
  readonly credentialRef?: string
}

let bench: Bench | undefined

/** Mount the profile's services plus the Codex plugin over the mock child. */
async function setup(env: Record<string, string> = {}, options: BenchOptions = {}): Promise<Bench> {
  const root = await mkdtemp(join(tmpdir(), 'agent-codex-surface-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  if (options.credentials === true) await ctx.plugin(FakeCredentials)
  await ctx.plugin(CodexAppServer, {
    harnesses: [{
      executable: process.execPath,
      args: [mockServer],
      codexHome: root,
      ...options.credentialRef === undefined ? {} : { credentialRef: options.credentialRef },
      env: { MOCK_CODEX_RECORD_FILE: join(root, 'record.jsonl'), ...env },
    }],
  })
  return { ctx, root }
}

afterEach(async () => {
  const target = bench
  bench = undefined
  if (target === undefined) return
  await target.ctx.fiber.dispose()
  await rm(target.root, { recursive: true, force: true })
})

describe('codexAppServer account surface', () => {
  it('reads account state, quota, and drives every login attempt', async () => {
    bench = await setup({ MOCK_CODEX_RATE_LIMIT_BUCKETS: '1' })
    const service = bench.ctx.codexAppServer
    const signal = new AbortController().signal

    expect(await service.status({ harness: 'codex' }, signal)).toEqual({
      authenticated: true,
      requiresOpenaiAuth: true,
      accountType: 'chatgpt',
      email: 'mock@example.com',
      planType: 'pro',
    })

    expect(await service.beginDeviceCode({ harness: 'codex' }, signal)).toEqual({
      loginId: 'login-1',
      verificationUrl: 'https://example.com/device',
      userCode: 'CODE-1234',
    })
    expect(await service.beginBrowser({ harness: 'codex' }, signal)).toEqual({
      loginId: 'login-2',
      authUrl: 'https://example.com/oauth',
    })
    await service.cancelLogin({ harness: 'codex', loginId: 'login-2' }, signal)
    await expect(service.cancelLogin({ harness: 'codex' }, signal))
      .rejects.toThrow('cancelLogin requires a loginId')

    const limits = await service.rateLimits({ harness: 'codex' }, signal)
    expect(limits.rateLimitsByLimitId).toMatchObject({
      codex: { primary: { usedPercent: 42 } },
    })

    await service.logout({ harness: 'codex' }, signal)
    expect(await service.status({ harness: 'codex' }, signal)).toMatchObject({ authenticated: false })
  }, 30_000)

  it('reports an account whose optional identity members are absent', async () => {
    bench = await setup({ MOCK_CODEX_AUTH: 'bare' })
    expect(await bench.ctx.codexAppServer.status({ harness: 'codex' }, new AbortController().signal)).toEqual({
      authenticated: true,
      requiresOpenaiAuth: true,
      accountType: 'apiKey',
    })
  }, 30_000)

  it('streams account notifications until the caller aborts', async () => {
    const started = await setup({ MOCK_CODEX_ACCOUNT_NOTIFY: '1' })
    bench = started
    const controller = new AbortController()
    const received: string[] = []
    const consuming = (async () => {
      for await (const notification of bench.ctx.codexAppServer.events({ harness: 'codex' }, controller.signal)) {
        received.push(notification.method)
      }
    })()

    // The subscription must exist before the connection spawns, because the
    // mock emits the notification right after its initialize response.
    await bench.ctx.codexAppServer.status({ harness: 'codex' }, new AbortController().signal)
    await expect.poll(() => received.length, { timeout: 20_000 }).toBeGreaterThan(0)
    controller.abort()
    await consuming
    expect(received).toEqual(['account/updated'])
  }, 30_000)

  it('wraps a runtime failure as a Remote error', async () => {
    bench = await setup({ MOCK_CODEX_FAIL_INITIALIZE: '1' })
    const signal = new AbortController().signal
    const service = bench.ctx.codexAppServer

    // Each call respawns a child that dies before answering, so the failure
    // surfaces as either the exit report or the closed protocol stream.
    const died = /exited|protocol stream closed/
    await expect(service.status({ harness: 'codex' }, signal)).rejects.toBeInstanceOf(RemoteError)
    await expect(service.beginDeviceCode({ harness: 'codex' }, signal)).rejects.toThrow(died)
    await expect(service.beginBrowser({ harness: 'codex' }, signal)).rejects.toThrow(died)
    await expect(service.cancelLogin({ harness: 'codex', loginId: 'login-1' }, signal)).rejects.toThrow(died)
    await expect(service.logout({ harness: 'codex' }, signal)).rejects.toThrow(died)
    await expect(service.rateLimits({ harness: 'codex' }, signal)).rejects.toThrow(died)
  }, 30_000)

  it.each([
    ['no configuration', {}],
    ['an explicit model and reasoning effort', { model: 'codex-direct', reasoningEffort: 'high' }],
  ])('mounts over %s', async (_label, entry) => {
    // A direct construction receives the raw config, as a programmatic
    // deployment does: unset fields resolve to their documented defaults (the
    // `codex` executable and `~/.codex`), and set ones reach the driver's
    // agent config. This case never spawns a child.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(TypertRegistry)
    try {
      new CodexAppServer(ctx, { harnesses: [entry] })
      const providers = ctx.llm.listProviders()
      expect(providers.map(provider => provider.id)).toContain('codex')
    } finally {
      await Promise.resolve(ctx.fiber.dispose())
    }
  }, 30_000)
})

describe('codexAppServer configured api-key login', () => {
  it('fails loudly when no credential provider is mounted', async () => {
    bench = await setup({ MOCK_CODEX_AUTH: 'out' }, { credentialRef: 'MOCK_OPENAI_KEY' })
    await expect(bench.ctx.agents.create({ sessionId: SessionId('credential-missing'), agentOptions: {} }))
      .rejects.toThrow('apiKey login needs a credential provider')
  }, 30_000)

  it('fails loudly when the configured credential does not resolve', async () => {
    bench = await setup(
      { MOCK_CODEX_AUTH: 'out' },
      { credentials: true, credentialRef: 'MISSING_KEY' },
    )
    await expect(bench.ctx.agents.create({ sessionId: SessionId('credential-unset'), agentOptions: {} }))
      .rejects.toThrow('credential "MISSING_KEY" is not configured')
  }, 30_000)

  it('attempts the configured login once per plugin lifetime', async () => {
    bench = await setup(
      { MOCK_CODEX_AUTH: 'stubborn' },
      { credentials: true, credentialRef: 'MOCK_OPENAI_KEY' },
    )
    await expect(bench.ctx.agents.create({ sessionId: SessionId('stubborn-1'), agentOptions: {} }))
      .rejects.toThrow('not authenticated')
    // The second bind re-enters the configured-key path and must not log in
    // again; the account stays signed out either way.
    await expect(bench.ctx.agents.create({ sessionId: SessionId('stubborn-2'), agentOptions: {} }))
      .rejects.toThrow('not authenticated')
  }, 30_000)
})

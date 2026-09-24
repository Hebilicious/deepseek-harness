/**
 * `CodexAppServer` service tests: which instance identities the constructor
 * mounts, and the Remote surface's harness scoping and error normalization
 * (`status`, `loginDeviceCode`, `loginBrowser`, `cancelLogin`, `logout`,
 * `rateLimits`, `events`), including the unknown-instance refusal. Driver-level
 * behavior of those operations lives in the other specs; this one pins the
 * service's own contract.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { CodexAppServer } from '../src/index.ts'

const mockServer = fileURLToPath(new URL('./mock-codex-app-server.ts', import.meta.url))

let bench: { ctx: Context; root: string } | undefined
afterEach(async () => {
  const target = bench
  bench = undefined
  if (target === undefined) return
  await target.ctx.fiber.dispose()
  await rm(target.root, { recursive: true, force: true })
})

const TEST_TIMEOUT = 30_000

/** Mount the services `CodexAppServer` injects, without mounting the driver. */
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

/** Mount the plugin over one instance pointed at the scripted mock child. */
async function setupDriver(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'agent-codex-service-'))
  const ctx = await mountServices()
  await ctx.plugin(CodexAppServer, {
    harnesses: [{
      executable: process.execPath,
      args: [mockServer],
      codexHome: root,
      env: { MOCK_CODEX_RECORD_FILE: join(root, 'record.jsonl') },
    }],
  })
  bench = { ctx, root }
  return ctx
}

/** Pull one unknown instance's account stream; the generator rejects on its first pull. */
async function eventsFailure(service: CodexAppServer, signal: AbortSignal): Promise<unknown> {
  try {
    for await (const notification of service.events({ harness: 'ghost' }, signal)) void notification
    return undefined
  } catch (error: unknown) {
    return error
  }
}

describe('CodexAppServer construction', () => {
  it('mounts every configured entry as its own agent harness', async () => {
    const ctx = await mountServices()
    new CodexAppServer(ctx, {
      harnesses: [
        { id: 'codex', name: 'Codex', description: 'OpenAI Codex runs the session through codex app-server' },
        { id: 'personal', name: 'Personal Codex' },
      ],
    })
    expect(ctx.agents.harnesses()).toEqual([
      { id: 'codex', name: 'Codex', description: 'OpenAI Codex runs the session through codex app-server', modelProvider: 'codex' },
      { id: 'personal', name: 'Personal Codex', modelProvider: 'personal' },
    ])
    await ctx.fiber.dispose()
  })

  it('carries a fully supplied config without substituting defaults', async () => {
    const ctx = await mountServices()
    const service = new CodexAppServer(ctx, {
      harnesses: [{
        id: 'personal',
        name: 'Personal Codex',
        executable: mockServer,
        args: ['app-server', '--stdio'],
        codexHome: '/tmp/personal-codex',
        env: { CODEX_NOTES: 'personal' },
        sandbox: 'read-only',
        networkAccess: true,
        approval: 'never',
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
        credentialRef: 'OPENAI_API_KEY',
      }],
      disposeGraceMs: 1234,
      eofGraceMs: 567,
    })
    expect(service.config.harnesses[0]?.id).toBe('personal')
    expect(service.config.harnesses[0]?.reasoningEffort).toBe('high')
    expect(service.config.disposeGraceMs).toBe(1234)
    await ctx.fiber.dispose()
  })
})

describe('CodexAppServer Remote surface', () => {
  it('rejects every operation naming an unmounted instance with the mounted ids', async () => {
    const ctx = await setupDriver()
    const service = ctx.codexAppServer
    const signal = new AbortController().signal
    const failures = await Promise.all([
      service.status({ harness: 'ghost' }, signal).then(() => undefined, (error: unknown) => error),
      service.beginDeviceCode({ harness: 'ghost' }, signal).then(() => undefined, (error: unknown) => error),
      service.beginBrowser({ harness: 'ghost' }, signal).then(() => undefined, (error: unknown) => error),
      service.cancelLogin({ harness: 'ghost', loginId: 'login-1' }, signal)
        .then(() => undefined, (error: unknown) => error),
      service.logout({ harness: 'ghost' }, signal).then(() => undefined, (error: unknown) => error),
      service.rateLimits({ harness: 'ghost' }, signal).then(() => undefined, (error: unknown) => error),
      eventsFailure(service, signal),
    ])
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(RemoteError)
      expect((failure as RemoteError).code).toBe('gateway/bad-request')
      expect((failure as RemoteError).message).toContain('unknown Codex harness "ghost"')
      expect((failure as RemoteError).message).toContain('mounted: codex')
    }
  }, TEST_TIMEOUT)

  it('normalizes a disposed runtime into the account code', async () => {
    const ctx = await setupDriver()
    const service = ctx.codexAppServer
    // Dispose the fiber so the runtime latches disposed while the service
    // object itself stays callable.
    await ctx.fiber.dispose()

    const failure: unknown = await service.status({ harness: 'codex' }, new AbortController().signal)
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect((failure as RemoteError).code).toBe('codex/account-failed')
    expect((failure as RemoteError).message).toContain('runtime is disposed')
  }, TEST_TIMEOUT)
})

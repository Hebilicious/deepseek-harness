/**
 * Catalog-route tests: one `ctx.llm` provider per harness id, answering the
 * model picker from what a bound session advertises and falling back to the
 * optional CLI catalog verb. Each case runs the real plugin against the
 * scripted mock ACP child.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessId } from '@deepseek-ai/dsh-agent'
import type { AcpHarnessEntry } from '@deepseek-ai/dsh-agent-acp'
import { SessionId } from '@deepseek-ai/dsh-session'
import { type Bench, mockAgent, recordedCalls, setup, teardown } from './bench.ts'

let bench: Bench | undefined
const scratch: string[] = []

afterEach(async () => {
  await teardown(bench)
  bench = undefined
  for (const root of scratch.splice(0)) await rm(root, { recursive: true, force: true })
})

const TEST_TIMEOUT = 30_000

/** One extra harness entry whose mock child records into its own temp file. */
async function extraEntry(
  id: string,
  name: string,
  env: Record<string, string> = {},
  overrides: Partial<AcpHarnessEntry> = {},
): Promise<AcpHarnessEntry> {
  const root = await mkdtemp(join(tmpdir(), `agent-acp-${id}-`))
  scratch.push(root)
  return {
    id,
    name,
    executable: process.execPath,
    args: [mockAgent, 'acp'],
    env: { MOCK_RECORD_FILE: join(root, 'record.jsonl'), ...env },
    ...overrides,
  }
}

describe('AcpCatalogAdapter', () => {
  it('answers the picker from the session advert, description included', async () => {
    bench = await setup({
      MOCK_SESSION_MODELS: JSON.stringify([
        { modelId: 'grok-4.7', name: 'Grok 4.7', description: 'frontier model' },
        { modelId: 'grok-4.6', name: 'Grok 4.6' },
      ]),
    })
    // The CLI catalog is configured, but the session advert is the harness's
    // own statement and wins over it.
    await bench.ctx.agents.create({ sessionId: SessionId('c1'), agentOptions: {} })

    expect(await bench.ctx.llm.listModels('devin')).toEqual([
      { provider: 'devin', id: 'grok-4.7', name: 'Grok 4.7', description: 'frontier model' },
      { provider: 'devin', id: 'grok-4.6', name: 'Grok 4.6' },
    ])
    expect(await bench.ctx.llm.resolveModelInfo('devin', 'grok-4.6', new AbortController().signal))
      .toMatchObject({ provider: 'devin', id: 'grok-4.6', name: 'Grok 4.6' })
    // An id that dropped out of the advert still resolves to an identity entry.
    expect(await bench.ctx.llm.resolveModelInfo('devin', 'retired', new AbortController().signal))
      .toMatchObject({ provider: 'devin', id: 'retired', name: 'retired' })
  }, TEST_TIMEOUT)

  it('offers the session reasoning-effort option as each model\'s effort menu', async () => {
    bench = await setup({
      MOCK_SESSION_MODELS: JSON.stringify([{ modelId: 'opus', name: 'Opus 5.5' }, { modelId: 'haiku', name: 'Haiku 4.5' }]),
      MOCK_CONFIG_OPTIONS: JSON.stringify([{
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'default',
        options: [{ value: 'default', name: 'Default' }, { value: 'max', name: 'Max' }],
      }]),
    })
    await bench.ctx.agents.create({ sessionId: SessionId('c1r'), agentOptions: {} })

    const reasoning = { efforts: [{ id: 'default', name: 'Default' }, { id: 'max', name: 'Max' }], defaultEffort: 'default' }
    expect(await bench.ctx.llm.resolveModelInfo('devin', 'opus', new AbortController().signal))
      .toMatchObject({ id: 'opus', name: 'Opus 5.5', reasoning })
    expect(await bench.ctx.llm.resolveModelInfo('devin', 'haiku', new AbortController().signal))
      .toMatchObject({ id: 'haiku', reasoning })
  }, TEST_TIMEOUT)

  it('probes one throwaway session so a fresh deployment still lists the harness models', async () => {
    // No session of this harness has bound yet: the picker still needs real
    // entries, so the adapter reads them from a probe session.
    bench = await setup({
      MOCK_SESSION_MODELS: JSON.stringify([
        { modelId: 'grok-4.7', name: 'Grok 4.7' },
        { modelId: 'grok-4.5', name: 'Grok 4.5' },
      ]),
    })

    expect(await bench.ctx.llm.listModels('devin')).toEqual([
      { provider: 'devin', id: 'grok-4.7', name: 'Grok 4.7' },
      { provider: 'devin', id: 'grok-4.5', name: 'Grok 4.5' },
    ])
    // The probe published the catalog, so a second read answers without a new session.
    expect(await bench.ctx.llm.listModels('devin')).toHaveLength(2)
  }, TEST_TIMEOUT)

  it('closes the probe session through whichever capability the agent advertises', async () => {
    bench = await setup({ MOCK_CLOSE: '1', MOCK_SESSION_MODELS: JSON.stringify([{ modelId: 'opus', name: 'Opus' }]) })
    await bench.ctx.llm.listModels('devin')
    const closed = await recordedCalls(bench.recordFile)
    expect(closed.filter(call => call.method === 'session/close')).toHaveLength(1)

    await bench.ctx.fiber.dispose()
    bench = await setup({ MOCK_DELETE: '1', MOCK_SESSION_MODELS: JSON.stringify([{ modelId: 'opus', name: 'Opus' }]) })
    await bench.ctx.llm.listModels('devin')
    const deleted = await recordedCalls(bench.recordFile)
    expect(deleted.filter(call => call.method === 'session/delete')).toHaveLength(1)

    // An agent that advertises neither keeps its probe session: dropping the
    // connection without closing would leave it believing the session is live.
    await bench.ctx.fiber.dispose()
    bench = await setup({ MOCK_SESSION_MODELS: JSON.stringify([{ modelId: 'opus', name: 'Opus' }]) })
    await bench.ctx.llm.listModels('devin')
    const left = await recordedCalls(bench.recordFile)
    expect(left.some(call => call.method === 'session/close' || call.method === 'session/delete')).toBe(false)
  }, TEST_TIMEOUT)

  it('reads the catalog once for repeated callers instead of spawning per read', async () => {
    // A picker that polls must not start a harness CLI per request: the read
    // is single-flight and cached for catalogCacheMs.
    bench = await setup({
      MOCK_MODELS_JSON: JSON.stringify({
        families: [{ family_uid: 'family-1', variants: [{ model_uid: 'swe-2', label: 'SWE 2' }] }],
      }),
    })
    const first = await bench.ctx.llm.listModels('devin')
    expect(first.map(model => model.id)).toEqual(['swe-2'])
    await bench.ctx.llm.listModels('devin')
    await bench.ctx.llm.listModels('devin')
    const calls = await recordedCalls(bench.recordFile)
    expect(calls.filter(call => call.method === 'cli')).toHaveLength(1)

    // A harness with neither a catalog verb nor probing spawns nothing at all,
    // however often the picker asks.
    await bench.ctx.fiber.dispose()
    bench = await setup({}, { harnesses: [await extraEntry('bare', 'Bare harness', {}, { probeCatalog: false })] })
    await expect(bench.ctx.llm.listModels('bare')).resolves.toEqual([])
    await expect(bench.ctx.llm.listModels('bare')).resolves.toEqual([])
    await expect(recordedCalls(bench.recordFile)).resolves.toEqual([])
  }, TEST_TIMEOUT)

  it('refuses a probe whose session/new returns no session id', async () => {
    bench = await setup({ MOCK_MISSING_SESSION_ID: '1' })
    await expect(bench.ctx.llm.listModels('devin')).rejects.toThrow('session/new returned no session id')
  }, TEST_TIMEOUT)

  it('remembers a failed read so a polling picker does not spawn per poll', async () => {
    // A harness the picker cannot read, such as a mis-installed executable,
    // must fail the poll it belongs to rather than start a process per poll.
    bench = await setup({ MOCK_MODELS_EXIT: '3' })
    await expect(bench.ctx.llm.listModels('devin')).rejects.toThrow(/exited 3$/)
    await expect(bench.ctx.llm.listModels('devin')).rejects.toThrow(/exited 3$/)
    const calls = await recordedCalls(bench.recordFile)
    expect(calls.filter(call => call.method === 'cli')).toHaveLength(1)
  }, TEST_TIMEOUT)

  it('keeps the picker route empty when probing is disabled and no session bound', async () => {
    bench = await setup({}, { harnesses: [await extraEntry('bare', 'Bare harness', {}, { probeCatalog: false })] })

    await expect(bench.ctx.llm.listModels('bare')).resolves.toEqual([])
  }, TEST_TIMEOUT)

  it('reads the model config option when the session sends no model state', async () => {
    bench = await setup({
      MOCK_CONFIG_OPTIONS: JSON.stringify([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'opencode/big-pickle',
          options: [
            { value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle', description: 'free tier' },
            { group: 'zen', name: 'OpenCode Zen', options: [{ value: 'opencode/mimo', name: 'MiMo' }] },
          ],
        },
      ]),
    })
    await bench.ctx.agents.create({ sessionId: SessionId('c2'), agentOptions: {} })

    expect(await bench.ctx.llm.listModels('devin')).toEqual([
      { provider: 'devin', id: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle', description: 'free tier' },
      { provider: 'devin', id: 'opencode/mimo', name: 'MiMo' },
    ])
  }, TEST_TIMEOUT)

  it('lists nothing when a session advertises no models and no catalog verb is configured', async () => {
    bench = await setup({}, { harnesses: [await extraEntry('bare', 'Bare harness')] })
    await bench.ctx.agents.create({
      sessionId: SessionId('c3'),
      harness: HarnessId('bare'),
      agentOptions: {},
    })
    await expect(bench.ctx.llm.listModels('bare')).resolves.toEqual([])
  }, TEST_TIMEOUT)

  it('names each route after its harness', async () => {
    bench = await setup({}, {
      harnesses: [await extraEntry('grok', 'Grok Build')],
    })
    const providers = bench.ctx.llm.listProviders()
    expect(providers.find(provider => provider.id === 'grok')).toEqual({ id: 'grok', name: 'Grok Build' })
    expect(providers.some(provider => provider.id === 'devin')).toBe(true)
  }, TEST_TIMEOUT)
})

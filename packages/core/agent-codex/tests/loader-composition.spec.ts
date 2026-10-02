/**
 * REAL-composition proof: a test-only `cordis.yml` boots the Codex driver
 * through the vendored Loader — session store, projections, agent registry,
 * subprocess provider, LLM runtime, JSONL persistence, and the harness
 * plugin — then a created session runs a real prompt against the scripted
 * `codex app-server` child and lands durable assistant output.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentToolBridge from '@deepseek-ai/dsh-agent-tool-bridge'
import { CodexAppServer } from '../src/index.ts'

const mockServer = fileURLToPath(new URL('./mock-codex-app-server.ts', import.meta.url))

/** Quote one value for single-line YAML interpolation. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('agent-codex real Loader composition', () => {
  it('boots the shipped plugin shape and runs a session over the mock child', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-codex-loader-'))
    const recordFile = join(root, 'record.jsonl')
    const configPath = join(root, 'cordis.yml')
    const yml = [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-typert-registry'",
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${yamlString(join(root, 'sessions'))}`,
      "- name: '@deepseek-ai/dsh-agent-codex'",
      '  config:',
      '    harnesses:',
      '      - id: codex',
      '        name: Codex',
      `        executable: ${yamlString(process.execPath)}`,
      `        args: [${yamlString(mockServer)}]`,
      `        codexHome: ${yamlString(root)}`,
      '        env:',
      `          MOCK_CODEX_RECORD_FILE: ${yamlString(recordFile)}`,
      "          MOCK_CODEX_TEXT: 'composed answer'",
      '',
    ]
    await writeFile(configPath, yml.join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
      ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
      ['@deepseek-ai/dsh-agent-codex', CodexAppServer],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const unloaded = [...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const { agent } = await context.agents.create({
      sessionId: SessionId('composed-codex'),
      agentOptions: {},
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'say hi' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const log = agent.session.snapshotEvents()
    const assistant = log.find(event => event.type === 'assistant/message')
    expect(assistant).toBeDefined()
    expect(JSON.stringify(assistant!.data)).toContain('composed answer')
    expect(log.some(event => event.type === 'agent-codex/thread')).toBe(true)

    expect(existsSync(recordFile)).toBe(true)
    const calls = (await readFile(recordFile, 'utf8'))
      .trim().split('\n')
      .map(line => (JSON.parse(line) as { method: string }).method)
    expect(calls).toContain('initialize')
    expect(calls).toContain('thread/start')
    expect(calls).toContain('turn/start')
  }, 30_000)

  it('mounts the tool bridge and hands the endpoint to the thread', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-codex-loader-'))
    const recordFile = join(root, 'record.jsonl')
    const configPath = join(root, 'cordis.yml')
    const yml = [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-typert-registry'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent-tool-bridge'",
      '  config:',
      '    exclude: []',
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${yamlString(join(root, 'sessions'))}`,
      "- name: '@deepseek-ai/dsh-agent-codex'",
      '  config:',
      '    harnesses:',
      '      - id: codex',
      '        name: Codex',
      `        executable: ${yamlString(process.execPath)}`,
      `        args: [${yamlString(mockServer)}]`,
      `        codexHome: ${yamlString(root)}`,
      '        env:',
      `          MOCK_CODEX_RECORD_FILE: ${yamlString(recordFile)}`,
      "          MOCK_CODEX_MCP_PROBE: '1'",
      `          MOCK_CODEX_MCP_CALL: ${yamlString(JSON.stringify({ name: 'bridge_echo', arguments: { text: 'ping' } }))}`,
      '',
    ]
    await writeFile(configPath, yml.join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-agent-tool-bridge', AgentToolBridge],
      ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
      ['@deepseek-ai/dsh-agent-codex', CodexAppServer],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const unloaded = [...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    context.tools.register(defineTool({
      name: 'bridge_echo',
      description: 'echo text back through the bridge',
      parameters: { text: { type: 'string' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        return `pong:${args.text ?? ''}`
      },
    }))

    const { agent } = await context.agents.create({
      sessionId: SessionId('composed-codex-bridge'),
      agentOptions: {},
    })

    const calls = (await readFile(recordFile, 'utf8'))
      .trim().split('\n')
      .map(line => JSON.parse(line) as { method: string; params: unknown })
    const created = calls.find(call => call.method === 'thread/start')
    const config = (created!.params as { config?: Record<string, unknown> }).config ?? {}
    const names = Object.keys(config).flatMap(key => /^mcp_servers\.([^.]+)\.url$/.exec(key)?.[1] ?? [])
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^dsh-[0-9a-f]{6}$/)
    expect(config[`mcp_servers.${names[0]!}.url`]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const headers = config[`mcp_servers.${names[0]!}.http_headers`] as Record<string, string>
    expect(headers['Authorization']).toMatch(/^Bearer /)

    const unauthorized = calls.find(call => call.method === 'mcp-unauthorized')
    expect(unauthorized?.params).toMatchObject({ status: 401 })
    const tools = calls.find(call => call.method === 'mcp-tools')
    const listed = (tools?.params as { result?: { tools?: { name: string }[] } })?.result?.tools
    expect(listed?.map(tool => tool.name)).toEqual(['bridge_echo'])
    const called = calls.find(call => call.method === 'mcp-call')
    expect(called?.params).toMatchObject({
      result: { content: [{ type: 'text', text: 'pong:ping' }] },
    })

    const exposed = agent.session.snapshotEvents()
      .filter(event => event.type === 'agent-tool-bridge/exposed')
    expect(exposed).toHaveLength(1)
    expect(exposed[0]!.data).toEqual({ tools: ['bridge_echo'] })
  }, 30_000)
})

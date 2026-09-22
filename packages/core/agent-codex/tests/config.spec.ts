/**
 * Config tests: the defaults every instance entry receives, and the loud
 * refusals for a list the plugin cannot mount (empty, malformed id, missing
 * name or executable, duplicate id) through both the static schema and the
 * resolver a direct construction reaches.
 */

import { describe, expect, it } from 'vitest'
import { CodexAppServer, defaultCodexHome, resolveHarnessEntries, type Config } from '../src/index.ts'

describe('resolveHarnessEntries', () => {
  it('applies every documented default to a bare entry', () => {
    expect(resolveHarnessEntries({ harnesses: [{}] })).toEqual([{
      id: 'codex',
      name: 'Codex',
      executable: 'codex',
      args: ['app-server'],
      codexHome: defaultCodexHome(),
      env: {},
      sandbox: 'workspace-write',
      networkAccess: false,
      approval: 'ask',
    }])
  })

  it('carries every declared field through', () => {
    expect(resolveHarnessEntries({
      harnesses: [{
        id: 'personal',
        name: 'Personal Codex',
        description: 'OpenAI Codex runs the session through codex app-server',
        executable: '/opt/codex',
        args: ['app-server', '--stdio'],
        codexHome: '/tmp/personal-codex',
        env: { CODEX_HOME_NOTES: 'work' },
        sandbox: 'danger-full-access',
        networkAccess: true,
        approval: 'never',
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
        credentialRef: 'OPENAI_API_KEY',
      }],
      disposeGraceMs: 1,
      eofGraceMs: 2,
    })).toEqual([{
      id: 'personal',
      name: 'Personal Codex',
      description: 'OpenAI Codex runs the session through codex app-server',
      executable: '/opt/codex',
      args: ['app-server', '--stdio'],
      codexHome: '/tmp/personal-codex',
      env: { CODEX_HOME_NOTES: 'work' },
      sandbox: 'danger-full-access',
      networkAccess: true,
      approval: 'never',
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      credentialRef: 'OPENAI_API_KEY',
    }])
  })

  it('treats an empty deployment default as no default', () => {
    // Profile bundles spell "no default" as an empty string, so it must defer
    // to Codex exactly as an omitted field does.
    const resolved = resolveHarnessEntries({
      harnesses: [{ model: '', reasoningEffort: '' }],
    })
    expect(resolved[0]).not.toHaveProperty('model')
    expect(resolved[0]).not.toHaveProperty('reasoningEffort')
    expect(CodexAppServer.Config({ harnesses: [{ model: '' }] }).harnesses[0]?.model).toBe('')
  })

  it('refuses a list with no entries', () => {
    expect(() => resolveHarnessEntries({ harnesses: [] }))
      .toThrow('agent-codex: at least one harness entry is required')
  })

  it('refuses a malformed id, a nameless entry, and an entry with no executable', () => {
    expect(() => resolveHarnessEntries({ harnesses: [{ id: 'Personal' }] }))
      .toThrow('invalid harness id "Personal"')
    expect(() => resolveHarnessEntries({ harnesses: [{ name: '' }] }))
      .toThrow('harness "codex" needs a non-empty name')
    expect(() => resolveHarnessEntries({ harnesses: [{ executable: '' }] }))
      .toThrow('harness "codex" needs a non-empty executable')
  })

  it('refuses a duplicate id because one registry key cannot name two instances', () => {
    expect(() => resolveHarnessEntries({
      harnesses: [
        { id: 'codex', name: 'Codex' },
        { id: 'codex', name: 'Codex again' },
      ],
    })).toThrow('duplicate harness id "codex"')
  })

  it('applies the codex id and name to a second entry that omits both', () => {
    // Two bare entries are one instance mounted twice: the duplicate refusal
    // is what makes an omitted id usable as a default.
    expect(() => resolveHarnessEntries({ harnesses: [{}, {}] }))
      .toThrow('duplicate harness id "codex"')
  })
})

describe('CodexAppServer.Config', () => {
  it('requires the instance list and applies entry defaults', () => {
    expect(() => CodexAppServer.Config({} as Config)).toThrow('harnesses missing required value')
    const resolved = CodexAppServer.Config({ harnesses: [{}] })
    expect(resolved.harnesses[0]?.id).toBe('codex')
    expect(resolved.harnesses[0]?.name).toBe('Codex')
    expect(resolved.harnesses[0]?.args).toEqual(['app-server'])
    expect(resolved.harnesses[0]?.sandbox).toBe('workspace-write')
    expect(resolved.harnesses[0]?.networkAccess).toBe(false)
    expect(resolved.disposeGraceMs).toBe(5000)
    expect(resolved.eofGraceMs).toBe(2000)
  })

  it('rejects an id that is not a lowercase slug', () => {
    expect(() => CodexAppServer.Config({
      harnesses: [{ id: 'Personal Codex' }],
    })).toThrow('expect string to match regexp')
  })
})

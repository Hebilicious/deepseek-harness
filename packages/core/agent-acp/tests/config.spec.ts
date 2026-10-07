/**
 * Config tests: the defaults every harness entry receives, and the loud
 * refusals for a list the plugin cannot mount (empty, malformed id, missing
 * name or executable, duplicate id) through both the static schema and the
 * resolver a direct construction reaches.
 */

import { describe, expect, it } from 'vitest'
import { AcpHarness, resolveHarnessEntries, type Config } from '../src/index.ts'

describe('resolveHarnessEntries', () => {
  it('applies every documented default to a bare entry', () => {
    expect(resolveHarnessEntries({
      harnesses: [{ id: 'devin', name: 'Devin', executable: 'devin' }],
    })).toEqual([{
      id: 'devin',
      name: 'Devin',
      executable: 'devin',
      args: ['acp'],
      env: {},
      sandbox: 'workspace-write',
      approval: 'ask',
      authStatusArgs: ['auth', 'status'],
      authLogoutArgs: ['auth', 'logout'],
      probeCatalog: true,
      processPerSession: false,
    }])
  })

  it('carries every declared field through', () => {
    expect(resolveHarnessEntries({
      harnesses: [{
        id: 'grok',
        name: 'Grok Build',
        description: 'xAI Grok Build runs the session through grok agent',
        executable: '/opt/grok',
        args: ['agent', '--no-leader', 'stdio'],
        cwd: '/tmp/work',
        env: { GROK_HOME: '/tmp/grok' },
        sandbox: 'danger-full-access',
        approval: 'never',
        mode: 'plan',
        model: 'grok-4.7',
        reasoningEffort: 'high',
        catalogArgs: ['models', 'list'],
        processPerSession: true,
        authStatusArgs: ['auth', 'status', '--json'],
        authLogoutArgs: ['auth', 'logout', '--yes'],
      }],
      disposeGraceMs: 1,
      eofGraceMs: 2,
      cliTimeoutMs: 3,
    })).toEqual([{
      id: 'grok',
      name: 'Grok Build',
      description: 'xAI Grok Build runs the session through grok agent',
      executable: '/opt/grok',
      args: ['agent', '--no-leader', 'stdio'],
      cwd: '/tmp/work',
      env: { GROK_HOME: '/tmp/grok' },
      sandbox: 'danger-full-access',
      approval: 'never',
      mode: 'plan',
      model: 'grok-4.7',
      reasoningEffort: 'high',
      catalogArgs: ['models', 'list'],
      authStatusArgs: ['auth', 'status', '--json'],
      authLogoutArgs: ['auth', 'logout', '--yes'],
      probeCatalog: true,
      processPerSession: true,
    }])
  })

  it('treats an empty deployment default as no default', () => {
    // Profile bundles spell "no default" as an empty string, so it must defer
    // to the harness exactly as an omitted field does.
    const resolved = resolveHarnessEntries({
      harnesses: [{
        id: 'devin',
        name: 'Devin',
        executable: 'devin',
        mode: '',
        model: '',
        reasoningEffort: '',
      }],
    })
    expect(resolved[0]).not.toHaveProperty('mode')
    expect(resolved[0]).not.toHaveProperty('model')
    expect(resolved[0]).not.toHaveProperty('reasoningEffort')
    expect(AcpHarness.Config({
      harnesses: [{ id: 'devin', name: 'Devin', executable: 'devin', model: '' }],
    }).harnesses[0]?.model).toBe('')
  })

  it('treats an empty catalog verb as no catalog verb', () => {
    // Schemastery normalizes an omitted string array to `[]`, so both spellings
    // of "no CLI catalog" must resolve to the same entry.
    expect(resolveHarnessEntries({
      harnesses: [{ id: 'devin', name: 'Devin', executable: 'devin', catalogArgs: [] }],
    })[0]).not.toHaveProperty('catalogArgs')
  })

  it('refuses a list with no entries', () => {
    expect(() => resolveHarnessEntries({ harnesses: [] })).toThrow('at least one harness entry is required')
  })

  it('refuses a malformed id, a nameless entry, and an entry with no executable', () => {
    expect(() => resolveHarnessEntries({
      harnesses: [{ id: 'Devin', name: 'Devin', executable: 'devin' }],
    })).toThrow('invalid harness id "Devin"')
    expect(() => resolveHarnessEntries({
      harnesses: [{ id: 'devin', name: '', executable: 'devin' }],
    })).toThrow('needs a non-empty name')
    expect(() => resolveHarnessEntries({
      harnesses: [{ id: 'devin', name: 'Devin', executable: '' }],
    })).toThrow('needs a non-empty executable')
  })

  it('refuses a duplicate id because one registry key cannot name two harnesses', () => {
    expect(() => resolveHarnessEntries({
      harnesses: [
        { id: 'devin', name: 'Devin', executable: 'devin' },
        { id: 'devin', name: 'Devin again', executable: 'devin' },
      ],
    })).toThrow('duplicate harness id "devin"')
  })
})

describe('AcpHarness.Config', () => {
  it('requires the harness list and applies entry defaults', () => {
    expect(() => AcpHarness.Config({} as Config)).toThrow('harnesses missing required value')
    const resolved = AcpHarness.Config({
      harnesses: [{ id: 'devin', name: 'Devin', executable: 'devin' }],
    })
    expect(resolved.harnesses[0]?.args).toEqual(['acp'])
    expect(resolved.harnesses[0]?.sandbox).toBe('workspace-write')
    expect(resolved.disposeGraceMs).toBe(5000)
    // A failed catalog read is remembered for a shorter window than a
    // successful one, so a repaired harness recovers without a restart.
    expect(resolved.catalogCacheMs).toBe(300_000)
    expect(resolved.catalogFailureCacheMs).toBe(30_000)
  })

  it('rejects an id that is not a lowercase slug', () => {
    expect(() => AcpHarness.Config({
      harnesses: [{ id: 'Grok Build', name: 'Grok Build', executable: 'grok' }],
    })).toThrow('expect string to match regexp')
  })
})

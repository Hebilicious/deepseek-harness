/**
 * Multi-instance plugin config: one {@link CodexHarnessEntry} per `codex
 * app-server` instance a deployment mounts, each resolved with its defaults
 * and validated before any app-server process is spawned.
 *
 * @module @deepseek-ai/dsh-agent-codex/config
 */

import z from '@deepseek-ai/schemastery'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { CODEX_PREFIX, defaultCodexHome } from './runtime.ts'

/** One configured Codex instance: how to spawn it and the deployment defaults for its sessions. */
export interface CodexHarnessEntry {
  /** Stable id, unique per plugin instance; also the `ctx.agents` harness id and `ctx.llm` catalog route (default `codex`). */
  id?: string
  /** Human-readable name for a harness picker (default `Codex`). */
  name?: string
  /** One sentence on what runs the session, for a harness picker. */
  description?: string
  /** Codex executable name or absolute path (default `codex`). */
  executable?: string
  /** Arguments after the executable (default `['app-server']`). */
  args?: string[]
  /** `CODEX_HOME` handed to the child; owns auth, config.toml, MCP, hooks (default `~/.codex`). */
  codexHome?: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  env?: Record<string, string>
  /** Filesystem sandbox for sessions that log no `sandbox/mode` override (default `workspace-write`). */
  sandbox?: SandboxMode
  /** `networkAccess` inside the structured `sandboxPolicy` overrides (default `false`). */
  networkAccess?: boolean
  /** Approval routing for sessions that log no `approval/policy` override (default `ask`). */
  approval?: 'ask' | 'never'
  /** Deployment default model beneath the session's `model/selection`. */
  model?: string
  /** Deployment default reasoning effort beneath the session's selection. */
  reasoningEffort?: string
  /** Credential reference (env-var name) resolved for unattended `account/login/start {type:'apiKey'}`. */
  credentialRef?: string
}

/** Plugin config; {@link Config.harnesses} is the only required field. */
export interface Config {
  /** One entry per Codex instance this plugin instance drives; ids must be unique. */
  harnesses: CodexHarnessEntry[]
  /** Grace in milliseconds between managed-range termination tiers (default 5000). */
  disposeGraceMs?: number
  /** Tier-1 window in milliseconds after stdin EOF before escalation (default 2000). */
  eofGraceMs?: number
}

/** One entry with every default applied. */
export interface ResolvedCodexHarnessEntry {
  /** Stable harness id, already validated as a lowercase slug. */
  readonly id: string
  /** Human-readable name for a harness picker. */
  readonly name: string
  /** One sentence on what runs the session, when the deployment declared one. */
  readonly description?: string
  /** Codex executable name or absolute path. */
  readonly executable: string
  /** Arguments after the executable. */
  readonly args: readonly string[]
  /** Explicit `CODEX_HOME` handed to the child; owns auth, config, MCP, hooks. */
  readonly codexHome: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env: Readonly<Record<string, string>>
  /** Filesystem sandbox for sessions that log no `sandbox/mode` override. */
  readonly sandbox: SandboxMode
  /** `networkAccess` member of the structured `sandboxPolicy` overrides. */
  readonly networkAccess: boolean
  /** Approval routing for sessions that log no `approval/policy` override. */
  readonly approval: 'ask' | 'never'
  /** Deployment default model beneath the session's `model/selection`. */
  readonly model?: string
  /** Deployment default reasoning effort beneath the session's selection. */
  readonly reasoningEffort?: string
  /** Credential reference resolved for the unattended api-key login. */
  readonly credentialRef?: string
}

/** Default id of a Codex instance, and the `ctx.agents` harness id and `ctx.llm` route it owns. */
export const DEFAULT_CODEX_HARNESS_ID = 'codex'
/** Default display name of a Codex instance. */
export const DEFAULT_CODEX_HARNESS_NAME = 'Codex'
/** Default Codex executable name. */
export const DEFAULT_CODEX_EXECUTABLE = 'codex'
/** Default arguments after the executable. */
export const DEFAULT_CODEX_ARGS: readonly string[] = ['app-server']
/** Default grace between managed-range termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 5000
/** Default tier-1 window after stdin EOF before termination escalation. */
export const DEFAULT_EOF_GRACE_MS = 2000
/** Ids are lowercase slugs so they are usable as provider routes and registry keys. */
const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** One entry's schema; the defaults here and in {@link resolveHarnessEntries} stay identical. */
export const codexHarnessEntrySchema = z.object({
  id: z.string().pattern(HARNESS_ID_PATTERN).default(DEFAULT_CODEX_HARNESS_ID),
  name: z.string().min(1).default(DEFAULT_CODEX_HARNESS_NAME),
  description: z.string().min(1),
  executable: z.string().min(1).default(DEFAULT_CODEX_EXECUTABLE),
  args: z.array(z.string()).default([...DEFAULT_CODEX_ARGS]),
  codexHome: z.string().min(1),
  env: z.dict(z.string()).default({}),
  sandbox: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const)
    .default('workspace-write'),
  networkAccess: z.boolean().default(false),
  approval: z.union(['ask', 'never'] as const).default('ask'),
  model: z.string(),
  reasoningEffort: z.string(),
  credentialRef: z.string(),
})

/**
 * Validate the configured instance entries and apply every default, once, so
 * the rest of the plugin reads plain values. Fails loud on an empty list, a
 * malformed id, a missing name or executable, or a duplicate id: each would
 * otherwise mount a Codex instance the agent registry or the LLM route table
 * cannot tell apart.
 * @param config - the plugin config, from the Loader or a direct construction.
 * @returns resolved entries in config order.
 */
export function resolveHarnessEntries(config: Config): readonly ResolvedCodexHarnessEntry[] {
  const entries = config.harnesses
  if (entries.length === 0) {
    throw new Error(`${CODEX_PREFIX}: at least one harness entry is required`)
  }
  const mounted = new Set<string>()
  return entries.map((entry) => {
    const id = entry.id ?? DEFAULT_CODEX_HARNESS_ID
    if (typeof id !== 'string' || !HARNESS_ID_PATTERN.test(id)) {
      throw new Error(
        `${CODEX_PREFIX}: invalid harness id ${JSON.stringify(entry.id)}: expected a lowercase slug matching ${String(HARNESS_ID_PATTERN)}`,
      )
    }
    const name = entry.name ?? DEFAULT_CODEX_HARNESS_NAME
    if (typeof name !== 'string' || name === '') {
      throw new Error(`${CODEX_PREFIX}: harness "${id}" needs a non-empty name`)
    }
    const executable = entry.executable ?? DEFAULT_CODEX_EXECUTABLE
    if (typeof executable !== 'string' || executable === '') {
      throw new Error(`${CODEX_PREFIX}: harness "${id}" needs a non-empty executable`)
    }
    if (mounted.has(id)) {
      throw new Error(`${CODEX_PREFIX}: duplicate harness id ${JSON.stringify(id)}`)
    }
    mounted.add(id)
    return {
      id,
      name,
      ...entry.description === undefined ? {} : { description: entry.description },
      executable,
      args: entry.args ?? [...DEFAULT_CODEX_ARGS],
      codexHome: entry.codexHome ?? defaultCodexHome(),
      env: entry.env ?? {},
      sandbox: entry.sandbox ?? 'workspace-write',
      networkAccess: entry.networkAccess ?? false,
      approval: entry.approval ?? 'ask',
      // Profile bundles spell "no default" as an empty string, so it must
      // defer to Codex exactly as an omitted field does.
      ...entry.model === undefined || entry.model === '' ? {} : { model: entry.model },
      ...entry.reasoningEffort === undefined || entry.reasoningEffort === ''
        ? {}
        : { reasoningEffort: entry.reasoningEffort },
      ...entry.credentialRef === undefined ? {} : { credentialRef: entry.credentialRef },
    }
  })
}

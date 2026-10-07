/**
 * Multi-harness plugin config: one {@link AcpHarnessEntry} per ACP harness a
 * deployment drives, each resolved with its defaults and validated before any
 * harness process is spawned.
 *
 * @module @deepseek-ai/dsh-agent-acp/config
 */

import z from '@deepseek-ai/schemastery'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ACP_PREFIX } from './protocol.ts'

/** One configured ACP harness: how to spawn it and the deployment defaults for its sessions. */
export interface AcpHarnessEntry {
  /** Stable id, unique per plugin instance; also the `ctx.agents` harness id and `ctx.llm` catalog route. */
  id: string
  /** Human-readable name for a harness picker. */
  name: string
  /** One sentence on what runs the session, for a harness picker. */
  description?: string
  /** Harness executable name or absolute path. */
  executable: string
  /** Arguments after the executable (default `['acp']`). */
  args?: string[]
  /** Working directory for the harness process itself (default `process.cwd()`); sessions carry their own cwd. */
  cwd?: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  env?: Record<string, string>
  /** Filesystem sandbox for sessions that log no `sandbox/mode` override (default `workspace-write`). */
  sandbox?: SandboxMode
  /** Approval routing for sessions that log no `approval/policy` override (default `ask`). */
  approval?: 'ask' | 'never'
  /** Deployment default for the session's `mode` config option; empty defers to the harness. */
  mode?: string
  /** Deployment default model beneath the session's `model/selection`; empty defers to the harness. */
  model?: string
  /** Deployment default reasoning effort beneath the session's `model/selection`; empty defers to the harness. */
  reasoningEffort?: string
  /**
   * Model-catalog CLI arguments, in the shape the harness's own listing
   * command accepts (Devin: `['models', 'list', '--format', 'json']`).
   * Omitted or empty, the catalog comes from what a session advertises.
   */
  catalogArgs?: string[]
  /**
   * Whether this harness's catalog is read by opening one throwaway session
   * when no session has bound yet (default true), so the model picker offers
   * real models before the first turn. Set false where spawning the harness
   * for the catalog alone is unwanted; the route is then empty until a session
   * binds.
   */
  probeCatalog?: boolean
  /**
   * Spawn one harness process per dsh session instead of one shared process
   * (default false). A harness that keeps MCP servers process-wide (opencode)
   * needs it: in a shared process every session could call every other
   * session's tool-bridge endpoint, running bridged tools as the wrong agent.
   */
  processPerSession?: boolean
  /**
   * Auth-status CLI arguments (default `['auth', 'status']`). An explicitly
   * empty list declares that this harness reports authorization through its
   * ACP methods and has no status verb, so nothing is spawned for it.
   */
  authStatusArgs?: string[]
  /**
   * Auth-logout CLI arguments (default `['auth', 'logout']`). An explicitly
   * empty list declares no logout verb: signing out then requires the agent's
   * ACP logout method, and a deployment without one fails loud.
   */
  authLogoutArgs?: string[]
}

/** Plugin config; {@link Config.harnesses} is the only required field. */
export interface Config {
  /** One entry per ACP harness this plugin instance drives; ids must be unique. */
  harnesses: AcpHarnessEntry[]
  /** Grace in milliseconds between managed-range termination tiers (default 5000). */
  disposeGraceMs?: number
  /** Tier-1 window in milliseconds after stdin EOF before escalation (default 2000). */
  eofGraceMs?: number
  /** Deadline in milliseconds for one CLI verb (default 180000); Devin's catalog refresh runs over the network. */
  cliTimeoutMs?: number
  /**
   * How long one harness's catalog read is reused before the next read
   * (default 300000). One read serves every caller, so a picker that polls
   * never spawns a harness CLI per request.
   */
  catalogCacheMs?: number
  /**
   * How long one harness's failed catalog read is remembered before the next
   * attempt (default 30000). Every caller inside the window receives that
   * read's failure without spawning anything, so a harness that keeps failing
   * (for example an executable missing from PATH) is not respawned per poll.
   */
  catalogFailureCacheMs?: number
}

/** One harness entry with every default except `cwd` applied. */
export interface ResolvedAcpHarnessEntry {
  /** Stable harness id, already validated as a lowercase slug. */
  readonly id: string
  /** Human-readable name for a harness picker. */
  readonly name: string
  /** One sentence on what runs the session, when the deployment declared one. */
  readonly description?: string
  /** Harness executable name or absolute path. */
  readonly executable: string
  /** Arguments after the executable. */
  readonly args: readonly string[]
  /** Working directory for the harness process itself, when the deployment declared one. */
  readonly cwd?: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env: Readonly<Record<string, string>>
  /** Filesystem sandbox for sessions that log no `sandbox/mode` override. */
  readonly sandbox: SandboxMode
  /** Approval routing for sessions that log no `approval/policy` override. */
  readonly approval: 'ask' | 'never'
  /** Deployment default for the session's `mode` config option. */
  readonly mode?: string
  /** Deployment default model beneath the session's `model/selection`. */
  readonly model?: string
  /** Deployment default reasoning effort beneath the session's `model/selection`. */
  readonly reasoningEffort?: string
  /** Model-catalog CLI arguments, or undefined to read only the session advert. */
  readonly catalogArgs?: readonly string[]
  /** Whether a throwaway session may be opened to read the catalog before any session binds. */
  readonly probeCatalog: boolean
  /** Whether every dsh session runs its own harness process. */
  readonly processPerSession: boolean
  /** Auth-status CLI arguments. */
  readonly authStatusArgs: readonly string[]
  /** Auth-logout CLI arguments. */
  readonly authLogoutArgs: readonly string[]
}

/** Default grace between managed-range termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 5000
/** Default tier-1 window after stdin EOF before termination escalation. */
export const DEFAULT_EOF_GRACE_MS = 2000
/** Default deadline for one one-shot CLI verb. */
export const DEFAULT_CLI_TIMEOUT_MS = 180_000
/** Default reuse window for one harness's catalog read. */
export const DEFAULT_CATALOG_CACHE_MS = 300_000
/**
 * Default window remembering one harness's failed catalog read, shorter than
 * {@link DEFAULT_CATALOG_CACHE_MS} so a repaired harness recovers sooner.
 */
export const DEFAULT_CATALOG_FAILURE_CACHE_MS = 30_000
/** Harness ids are lowercase slugs so they are usable as provider routes and registry keys. */
const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]*$/
/** Default arguments after a harness executable. */
export const DEFAULT_HARNESS_ARGS: readonly string[] = ['acp']
/** Default auth-status arguments for a CLI that exposes one. */
export const DEFAULT_AUTH_STATUS_ARGS: readonly string[] = ['auth', 'status']
/** Default auth-logout arguments for a CLI that exposes one. */
export const DEFAULT_AUTH_LOGOUT_ARGS: readonly string[] = ['auth', 'logout']

/** One entry's schema; the defaults here and in {@link resolveHarnessEntries} stay identical. */
export const acpHarnessEntrySchema = z.object({
  id: z.string().pattern(HARNESS_ID_PATTERN).required(),
  name: z.string().min(1).required(),
  description: z.string().min(1),
  executable: z.string().min(1).required(),
  args: z.array(z.string()).default([...DEFAULT_HARNESS_ARGS]),
  cwd: z.string().min(1),
  env: z.dict(z.string()).default({}),
  sandbox: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const)
    .default('workspace-write'),
  approval: z.union(['ask', 'never'] as const).default('ask'),
  mode: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  catalogArgs: z.array(z.string()),
  probeCatalog: z.boolean().default(true),
  processPerSession: z.boolean().default(false),
  authStatusArgs: z.array(z.string()).default([...DEFAULT_AUTH_STATUS_ARGS]),
  authLogoutArgs: z.array(z.string()).default([...DEFAULT_AUTH_LOGOUT_ARGS]),
})

/**
 * Validate the configured harness entries and apply every default, once, so
 * the rest of the plugin reads plain values. Fails loud on an empty list, a
 * malformed id, a missing name, or a duplicate id: each would otherwise mount
 * a harness the agent registry or the LLM route table cannot tell apart.
 * @param config - the plugin config, from the Loader or a direct construction.
 * @returns resolved entries in config order.
 */
export function resolveHarnessEntries(config: Config): readonly ResolvedAcpHarnessEntry[] {
  const entries = config.harnesses
  if (entries.length === 0) {
    throw new Error(`${ACP_PREFIX}: at least one harness entry is required`)
  }
  const mounted = new Set<string>()
  return entries.map((entry) => {
    if (typeof entry.id !== 'string' || !HARNESS_ID_PATTERN.test(entry.id)) {
      throw new Error(
        `${ACP_PREFIX}: invalid harness id ${JSON.stringify(entry.id)}: expected a lowercase slug matching ${String(HARNESS_ID_PATTERN)}`,
      )
    }
    if (typeof entry.name !== 'string' || entry.name === '') {
      throw new Error(`${ACP_PREFIX}: harness "${entry.id}" needs a non-empty name`)
    }
    if (typeof entry.executable !== 'string' || entry.executable === '') {
      throw new Error(`${ACP_PREFIX}: harness "${entry.id}" needs a non-empty executable`)
    }
    if (mounted.has(entry.id)) {
      throw new Error(`${ACP_PREFIX}: duplicate harness id ${JSON.stringify(entry.id)}`)
    }
    mounted.add(entry.id)
    return {
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      executable: entry.executable,
      args: entry.args ?? [...DEFAULT_HARNESS_ARGS],
      ...entry.cwd === undefined ? {} : { cwd: entry.cwd },
      env: entry.env ?? {},
      sandbox: entry.sandbox ?? 'workspace-write',
      approval: entry.approval ?? 'ask',
      ...entry.mode === undefined || entry.mode === '' ? {} : { mode: entry.mode },
      ...entry.model === undefined || entry.model === '' ? {} : { model: entry.model },
      ...entry.reasoningEffort === undefined || entry.reasoningEffort === ''
        ? {}
        : { reasoningEffort: entry.reasoningEffort },
      ...entry.catalogArgs === undefined || entry.catalogArgs.length === 0
        ? {}
        : { catalogArgs: entry.catalogArgs },
      probeCatalog: entry.probeCatalog ?? true,
      processPerSession: entry.processPerSession ?? false,
      authStatusArgs: entry.authStatusArgs ?? [...DEFAULT_AUTH_STATUS_ARGS],
      authLogoutArgs: entry.authLogoutArgs ?? [...DEFAULT_AUTH_LOGOUT_ARGS],
    }
  })
}

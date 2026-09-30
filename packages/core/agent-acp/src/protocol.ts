/**
 * ACP wire helpers for the session driver: stop-reason and tool-content
 * mapping, prompt-block conversion, permission-option selection, and the
 * session advert (config options and advertised models) the driver reads.
 * Config options arrive as unvalidated response data, so each helper reads
 * them defensively; these helpers translate typed frames into the driver's
 * durable vocabulary.
 *
 * @module @deepseek-ai/dsh-agent-acp/protocol
 */

import type {
  ContentBlock as AcpContentBlock,
  PermissionOption,
  RequestPermissionOutcome,
  SessionConfigOption,
  StopReason,
  ToolCallContent,
} from '@agentclientprotocol/sdk'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AcpCatalogModel, AcpCatalogReasoning } from './types.ts'

/** Diagnostic prefix for every error this driver raises. */
export const ACP_PREFIX = 'agent-acp'

/**
 * Diagnostic prefix for one harness's messages, so a process driving several
 * harnesses never reports an unattributable failure.
 * @param harness - the harness id.
 * @returns the prefixed diagnostic tag.
 */
export function acpPrefix(harness: string): string {
  return `${ACP_PREFIX}[${harness}]`
}

/** The session advert fields the driver reads from `session/new` and `session/load`. */
export interface AcpSessionAdvert {
  /** Session model state when the agent sends it; preferred over the config option. */
  readonly models?: unknown
  /** The session's reported configuration options. */
  readonly configOptions?: SessionConfigOption[] | null
}

/** One selectable value of an advertised config option, with groups flattened. */
export interface AcpSelectEntry {
  /** Value the `session/set_config_option` request carries. */
  readonly value: string
  /** Human-readable label. */
  readonly name: string
  /** What the value does, when the agent described it. */
  readonly description?: string
}

/** An advertised select option. */
export type AcpSelectOption = Extract<SessionConfigOption, { type: 'select' }>

/** A wire fact the driver cannot satisfy; fails the turn, not the connection. */
export class AcpProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpProtocolError'
  }
}

/**
 * Map an ACP {@link StopReason} to the durable turn ending. `cancelled` maps
 * to `aborted` with the user cause — the abort listener already resolved the
 * request race, so this arm only reports the cooperative answer.
 * @param reason - the `session/prompt` response's terminal reason.
 * @returns the durable turn ending.
 */
export function acpTurnEnding(reason: StopReason): TurnEndReason {
  switch (reason) {
    case 'end_turn':
      return { kind: 'completed' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', reason: { kind: 'user' } }
    case 'refusal':
      return { kind: 'error', error: { message: 'the agent refused the turn', code: 'REFUSED' } }
    case 'max_turn_requests':
      return { kind: 'error', error: { message: 'the agent hit its turn-request budget', code: 'LIMIT' } }
    default:
      return { kind: 'error', error: { message: `unknown ACP stop reason: ${String(reason)}`, code: 'UNKNOWN' } }
  }
}

/**
 * Translate one `ToolCallContent` to durable result blocks. `diff` becomes a
 * text block carrying the unified diff; `terminal` output embeds as text;
 * content blocks map through {@link acpBlockToContent}.
 * @param content - the tool call's reported content.
 * @param rawOutput - raw ACP tool output text, when the update carried one.
 * @returns durable content blocks and an optional fallback text.
 */
export function acpToolContent(content: readonly ToolCallContent[] | undefined, rawOutput: unknown): {
  blocks: ContentBlock[]
  fallbackText?: string
} {
  const blocks: ContentBlock[] = []
  for (const entry of content ?? []) {
    if (entry.type === 'content') {
      const mapped = acpBlockToContent(entry.content)
      if (mapped !== undefined) blocks.push(mapped)
    } else if (entry.type === 'diff') {
      blocks.push({ type: 'text', text: `--- ${entry.path}\n${entry.newText}` })
    } else {
      blocks.push({ type: 'text', text: `[terminal ${entry.terminalId}]` })
    }
  }
  const fallbackText = blocks.length === 0 && rawOutput !== undefined
    ? safeJson(rawOutput)
    : undefined
  if (fallbackText !== undefined) blocks.push({ type: 'text', text: fallbackText })
  return { blocks }
}

/**
 * The canonical tool name one `tool_call` notification carries in `_meta`,
 * when the harness keeps it there. Devin reports `mcp__<server>__<tool>`
 * under `cognition.ai/toolName` — `cognition.ai/inferenceToolName` is its
 * inference-level alias — while `title` holds display text such as
 * "Calling probe_echo from dsh".
 * @param meta - the notification's `_meta` map.
 * @returns the canonical name, or undefined when the notification carries none.
 */
export function acpMetaToolName(meta: { [key: string]: unknown } | null | undefined): string | undefined {
  const tool = meta?.['cognition.ai/toolName']
  if (typeof tool === 'string' && tool.length > 0) return tool
  const inference = meta?.['cognition.ai/inferenceToolName']
  return typeof inference === 'string' && inference.length > 0 ? inference : undefined
}

/**
 * Map one ACP content block to a durable content block.
 * @param block - one ACP content block.
 * @returns the mapped content block, or `undefined` when the block has no dsh equivalent.
 */
export function acpBlockToContent(block: AcpContentBlock): ContentBlock | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'resource_link':
      return { type: 'text', text: `[${block.name}](${block.uri})` }
    case 'resource':
      return 'text' in block.resource && typeof block.resource.text === 'string'
        ? { type: 'text', text: block.resource.text }
        : { type: 'text', text: `[${block.resource.uri}]` }
    default:
      return undefined
  }
}

/**
 * Convert one DSH user message to ACP prompt blocks. Text stays text; file
 * and image attachments become `resource_link` entries when the host path is
 * known, otherwise deterministic text fallbacks.
 * @param message - one durable user message.
 * @param attachmentHostPath - resolves a file/image attachment to a host path, or undefined.
 * @returns ACP prompt blocks.
 */
export function toAcpPromptBlocks(
  message: { content: readonly ContentBlock[] },
  attachmentHostPath: (attachment: unknown) => string | undefined,
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'file' || block.type === 'image') {
      const attachment = block.attachment
      const hostPath = attachmentHostPath(attachment)
      if (hostPath !== undefined) {
        const name = 'name' in attachment && typeof attachment.name === 'string'
          ? attachment.name
          : hostPath
        blocks.push({ type: 'resource_link', uri: `file://${hostPath}`, name })
      } else {
        const label = 'name' in attachment && typeof attachment.name === 'string'
          ? attachment.name
          : 'attachment'
        blocks.push({ type: 'text', text: `[${block.type}: ${label}]` })
      }
    }
  }
  return blocks
}

/**
 * Pick the ACP permission outcome for a DSH approval decision: a grant picks
 * the first `allow_once` option (falling back to `allow_always`), a rejection
 * the first `reject_*` option, and every other outcome cancels the request.
 * @param options - the options the agent offered.
 * @param outcome - the DSH approval outcome.
 * @returns the ACP permission outcome.
 */
export function acpPermissionOutcome(
  options: readonly PermissionOption[],
  outcome: ApprovalOutcome,
): RequestPermissionOutcome {
  if (outcome === 'allowed-once') {
    const allow = options.find(o => o.kind === 'allow_once')
      ?? options.find(o => o.kind === 'allow_always')
    if (allow !== undefined) {
      return { outcome: 'selected', optionId: allow.optionId }
    }
  } else if (outcome === 'rejected') {
    const reject = options.find(o => o.kind === 'reject_once')
      ?? options.find(o => o.kind === 'reject_always')
    if (reject !== undefined) {
      return { outcome: 'selected', optionId: reject.optionId }
    }
  }
  return { outcome: 'cancelled' }
}

/**
 * Read the advertised `model` select option out of a config-option list.
 * @param options - the session's reported configuration options.
 * @returns the model option, or undefined when the agent advertises none.
 */
export function acpModelOption(options: readonly SessionConfigOption[] | null | undefined):
  | AcpSelectOption
  | undefined {
  return selectOption(options, option => option.id === 'model')
}

/**
 * Read the advertised `mode` select option out of a config-option list.
 * @param options - the session's reported configuration options.
 * @returns the mode option, or undefined when the agent advertises none.
 */
export function acpModeOption(options: readonly SessionConfigOption[] | null | undefined):
  | AcpSelectOption
  | undefined {
  return selectOption(options, option => option.id === 'mode')
}

/**
 * Read the advertised reasoning-effort select option, named `thought_level`
 * by Devin and `reasoning_effort` by Grok Build. The ACP `thought_level`
 * category wins over the id so a harness that renames the option still maps.
 * @param options - the session's reported configuration options.
 * @returns the reasoning-effort option, or undefined when the agent advertises none.
 */
export function acpReasoningOption(options: readonly SessionConfigOption[] | null | undefined):
  | AcpSelectOption
  | undefined {
  return selectOption(
    options,
    option => option.category === 'thought_level'
      || option.id === 'thought_level'
      || option.id === 'reasoning_effort',
  )
}

/**
 * Flatten one advertised select option's values, groups included. Response
 * data is read defensively: an option that carries no array of values offers
 * none rather than failing the turn.
 * @param option - the advertised select option, when one was found.
 * @returns selectable values in advert order.
 */
export function acpSelectEntries(option: AcpSelectOption | undefined): AcpSelectEntry[] {
  return selectEntries(option === undefined ? undefined : option.options)
}

/**
 * Read the model catalog one session advertised. The newer
 * `models.availableModels` list wins when the agent sends one; otherwise the
 * `model` config option's selectable values are the catalog. Both arrive as
 * unvalidated response data. The session's reasoning-effort option, when it
 * offers values, becomes every model's reasoning menu.
 * @param advert - the `session/new` or `session/load` response fields.
 * @returns catalog entries in advert order.
 */
export function acpAdvertisedModels(advert: AcpSessionAdvert): AcpCatalogModel[] {
  const listed = advertisedModelList(advert.models)
  const models = listed.length > 0
    ? listed
    : acpSelectEntries(acpModelOption(advert.configOptions)).map(entry => ({
      id: entry.value,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
    }))
  // ACP advertises one reasoning-effort option per session rather than per
  // model, so every advertised model carries that menu.
  const reasoning = advertisedReasoning(advert.configOptions)
  return reasoning === undefined ? models : models.map(model => ({ ...model, reasoning }))
}

/** The session's reasoning-effort menu, when it advertises one with values. */
function advertisedReasoning(options: readonly SessionConfigOption[] | null | undefined): AcpCatalogReasoning | undefined {
  const option = acpReasoningOption(options)
  const efforts = acpSelectEntries(option).map(entry => ({
    id: brandString<ReasoningEffortId>(entry.value),
    name: entry.name,
    ...entry.description === undefined ? {} : { description: entry.description },
  }))
  if (option === undefined || efforts.length === 0) return undefined
  const current: unknown = option.currentValue
  return {
    efforts,
    ...typeof current === 'string' && current !== '' ? { defaultEffort: brandString<ReasoningEffortId>(current) } : {},
  }
}

/** Find one advertised select option by predicate. */
function selectOption(
  options: readonly SessionConfigOption[] | null | undefined,
  matches: (option: AcpSelectOption) => boolean,
): AcpSelectOption | undefined {
  return options?.find(
    (option): option is AcpSelectOption => option.type === 'select' && matches(option),
  )
}

/** Flatten a select option's value list, accepting flat and grouped wire forms. */
function selectEntries(options: unknown): AcpSelectEntry[] {
  if (!Array.isArray(options)) return []
  const entries: AcpSelectEntry[] = []
  for (const raw of options) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    if (Array.isArray(record.options)) {
      entries.push(...selectEntries(record.options))
      continue
    }
    const { value, name } = record
    if (typeof value !== 'string' || typeof name !== 'string') continue
    const description = typeof record.description === 'string' && record.description !== ''
      ? record.description
      : undefined
    entries.push({ value, name, ...description === undefined ? {} : { description } })
  }
  return entries
}

/** Read the `models.availableModels` list an agent sent, if any. */
function advertisedModelList(models: unknown): AcpCatalogModel[] {
  if (typeof models !== 'object' || models === null) return []
  const available = (models as { availableModels?: unknown }).availableModels
  if (!Array.isArray(available)) return []
  const entries: AcpCatalogModel[] = []
  for (const raw of available) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const { modelId, name } = record
    if (typeof modelId !== 'string' || modelId === '' || typeof name !== 'string' || name === '') continue
    const description = typeof record.description === 'string' && record.description !== ''
      ? record.description
      : undefined
    entries.push({ id: modelId, name, ...description === undefined ? {} : { description } })
  }
  return entries
}

/** Serialize a tool result's raw output, falling back to its string form when it cannot be encoded. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

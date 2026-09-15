/**
 * ACP wire helpers for the session driver: stop-reason and tool-content
 * mapping, prompt-block conversion, and permission-option selection. The SDK
 * validates inbound frames with generated schemas before dispatch; these
 * helpers translate typed frames into the driver's durable vocabulary.
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
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Diagnostic prefix for every error this driver raises. */
export const ACP_PREFIX = 'agent-acp'

/** The `ctx.llm` provider id feeding the picker's Devin catalog. */
export const ACP_PROVIDER = 'devin'

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
 * @returns durable content blocks.
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
    } else if (entry.type === 'terminal') {
      blocks.push({ type: 'text', text: `[terminal ${entry.terminalId}]` })
    }
  }
  const fallbackText = blocks.length === 0 && rawOutput !== undefined
    ? safeJson(rawOutput)
    : undefined
  if (fallbackText !== undefined) blocks.push({ type: 'text', text: fallbackText })
  return { blocks }
}

/** Map one ACP content block to a durable content block; returns undefined for non-text blocks. */
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
  | Extract<SessionConfigOption, { type: 'select' }>
  | undefined {
  return options?.find(
    (option): option is Extract<SessionConfigOption, { type: 'select' }> =>
      option.id === 'model' && option.type === 'select',
  )
}

/**
 * Read the advertised `mode` select option out of a config-option list.
 * @param options - the session's reported configuration options.
 * @returns the mode option, or undefined when the agent advertises none.
 */
export function acpModeOption(options: readonly SessionConfigOption[] | null | undefined):
  | Extract<SessionConfigOption, { type: 'select' }>
  | undefined {
  return options?.find(
    (option): option is Extract<SessionConfigOption, { type: 'select' }> =>
      option.id === 'mode' && option.type === 'select',
  )
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value as JsonValue)
  } catch {
    return String(value)
  }
}

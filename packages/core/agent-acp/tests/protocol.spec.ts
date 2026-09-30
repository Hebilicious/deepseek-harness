/**
 * Unit tests for the ACP wire helpers: stop-reason and tool-content mapping,
 * prompt-block conversion, and permission-option selection. These run without
 * a child process — every input is already SDK-validated wire data.
 */

import { describe, expect, it } from 'vitest'
import type {
  PermissionOption,
  SessionConfigOption,
  ToolCallContent,
} from '@agentclientprotocol/sdk'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  acpAdvertisedModels,
  acpBlockToContent,
  acpMetaToolName,
  acpModeOption,
  acpModelOption,
  acpPermissionOutcome,
  acpReasoningOption,
  acpSelectEntries,
  acpToolContent,
  acpTurnEnding,
  toAcpPromptBlocks,
  type AcpSelectOption,
} from '../src/protocol.ts'

function selectOption(id: string, values: readonly string[]): SessionConfigOption {
  return {
    id,
    name: id,
    type: 'select',
    currentValue: values[0] as string,
    options: values.map(value => ({ value, name: value })),
  }
}

describe('acpTurnEnding', () => {
  it('maps every ACP stop reason to its durable ending', () => {
    expect(acpTurnEnding('end_turn')).toEqual({ kind: 'completed' })
    expect(acpTurnEnding('max_tokens')).toEqual({ kind: 'max-tokens' })
    expect(acpTurnEnding('cancelled')).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect(acpTurnEnding('refusal')).toEqual({
      kind: 'error',
      error: { message: 'the agent refused the turn', code: 'REFUSED' },
    })
    expect(acpTurnEnding('max_turn_requests')).toEqual({
      kind: 'error',
      error: { message: 'the agent hit its turn-request budget', code: 'LIMIT' },
    })
    expect(acpTurnEnding('unknown_reason' as never)).toEqual({
      kind: 'error',
      error: { message: 'unknown ACP stop reason: unknown_reason', code: 'UNKNOWN' },
    })
  })
})

describe('acpToolContent', () => {
  it('maps content, diff, and terminal entries in wire order', () => {
    const content: ToolCallContent[] = [
      { type: 'content', content: { type: 'text', text: 'body' } },
      { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
      { type: 'diff', path: '/tmp/a.txt', oldText: 'before', newText: 'after' },
      { type: 'terminal', terminalId: 'term-1' },
    ]
    expect(acpToolContent(content, undefined).blocks).toEqual([
      { type: 'text', text: 'body' },
      { type: 'text', text: '--- /tmp/a.txt\nafter' },
      { type: 'text', text: '[terminal term-1]' },
    ])
  })

  it('falls back to the raw output only when no entry produced a block', () => {
    expect(acpToolContent([], { exitCode: 0 }).blocks).toEqual([{ type: 'text', text: '{"exitCode":0}' }])
    expect(acpToolContent(undefined, undefined).blocks).toEqual([])
    // A raw output JSON.stringify cannot encode still yields text.
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(acpToolContent(undefined, circular).blocks[0]).toEqual({ type: 'text', text: '[object Object]' })
    expect(acpToolContent([{ type: 'content', content: { type: 'text', text: 'kept' } }], { ignored: true }).blocks)
      .toEqual([{ type: 'text', text: 'kept' }])
  })
})

describe('acpMetaToolName', () => {
  it('prefers toolName and falls back to inferenceToolName', () => {
    expect(acpMetaToolName({
      'cognition.ai/toolName': 'mcp__dsh__subagent',
      'cognition.ai/inferenceToolName': 'mcp__dsh__other',
    })).toBe('mcp__dsh__subagent')
    expect(acpMetaToolName({ 'cognition.ai/inferenceToolName': 'mcp__dsh__subagent' }))
      .toBe('mcp__dsh__subagent')
  })

  it('reads nothing from absent or non-string fields', () => {
    expect(acpMetaToolName(undefined)).toBeUndefined()
    expect(acpMetaToolName(null)).toBeUndefined()
    expect(acpMetaToolName({})).toBeUndefined()
    expect(acpMetaToolName({ 'cognition.ai/toolName': 7 })).toBeUndefined()
    expect(acpMetaToolName({ 'cognition.ai/toolName': '' })).toBeUndefined()
  })
})

describe('acpBlockToContent', () => {
  it('maps text, resource links, and embedded resources', () => {
    expect(acpBlockToContent({ type: 'text', text: 'hi' })).toEqual({ type: 'text', text: 'hi' })
    expect(acpBlockToContent({ type: 'resource_link', uri: 'file:///tmp/a.txt', name: 'a.txt' }))
      .toEqual({ type: 'text', text: '[a.txt](file:///tmp/a.txt)' })
    expect(acpBlockToContent({
      type: 'resource',
      resource: { uri: 'file:///tmp/a.txt', text: 'contents' },
    })).toEqual({ type: 'text', text: 'contents' })
    expect(acpBlockToContent({
      type: 'resource',
      resource: { uri: 'file:///tmp/a.bin', blob: 'AAAA' },
    })).toEqual({ type: 'text', text: '[file:///tmp/a.bin]' })
  })

  it('drops blocks with no durable representation', () => {
    expect(acpBlockToContent({ type: 'image', data: 'AAAA', mimeType: 'image/png' })).toBeUndefined()
  })
})

describe('toAcpPromptBlocks', () => {
  const message = (content: Parameters<typeof createUserMessage>[0]['content']) =>
    createUserMessage({ content, source: { kind: 'user' } })

  it('keeps text and resolves attachments to resource links', () => {
    const file = message([
      { type: 'text', text: 'look at this' },
      { type: 'file', attachment: { attachmentId: AttachmentId('file-1'), name: 'notes.txt', bytes: 4 } },
      { type: 'image', attachment: { attachmentId: AttachmentId('img-1'), mediaType: 'image/png', bytes: 9, width: 2, height: 2 } },
    ])
    const blocks = toAcpPromptBlocks(file, attachment =>
      `/attachments/${(attachment as { attachmentId: string }).attachmentId}`)
    expect(blocks).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'resource_link', uri: 'file:///attachments/file-1', name: 'notes.txt' },
      { type: 'resource_link', uri: 'file:///attachments/img-1', name: '/attachments/img-1' },
    ])
  })

  it('degrades to text handles when the host path is unknown', () => {
    const file = message([
      { type: 'file', attachment: { attachmentId: AttachmentId('file-2'), name: 'notes.txt', bytes: 4 } },
      { type: 'image', attachment: { attachmentId: AttachmentId('img-2'), mediaType: 'image/png', bytes: 9, width: 2, height: 2 } },
    ])
    expect(toAcpPromptBlocks(file, () => undefined)).toEqual([
      { type: 'text', text: '[file: notes.txt]' },
      { type: 'text', text: '[image: attachment]' },
    ])
  })

  it('skips blocks ACP cannot carry', () => {
    const tool = message([{ type: 'tool-call', id: 'call-1' as never, name: 'read', arguments: '{}' }])
    expect(toAcpPromptBlocks(tool, () => undefined)).toEqual([])
  })
})

describe('acpPermissionOutcome', () => {
  const options: PermissionOption[] = [
    { optionId: 'once', name: 'Once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'no', name: 'No', kind: 'reject_once' },
    { optionId: 'never', name: 'Never', kind: 'reject_always' },
  ]

  it('selects the first matching allow or reject option', () => {
    expect(acpPermissionOutcome(options, 'allowed-once')).toEqual({ outcome: 'selected', optionId: 'once' })
    expect(acpPermissionOutcome(options, 'rejected')).toEqual({ outcome: 'selected', optionId: 'no' })
    expect(acpPermissionOutcome(
      [{ optionId: 'always', name: 'Always', kind: 'allow_always' }],
      'allowed-once',
    )).toEqual({ outcome: 'selected', optionId: 'always' })
    expect(acpPermissionOutcome(
      [{ optionId: 'never', name: 'Never', kind: 'reject_always' }],
      'rejected',
    )).toEqual({ outcome: 'selected', optionId: 'never' })
  })

  it('cancels when the agent offered no matching option or the outcome withdrew', () => {
    expect(acpPermissionOutcome([], 'allowed-once')).toEqual({ outcome: 'cancelled' })
    expect(acpPermissionOutcome([], 'rejected')).toEqual({ outcome: 'cancelled' })
    expect(acpPermissionOutcome(options, 'cancelled')).toEqual({ outcome: 'cancelled' })
    expect(acpPermissionOutcome(options, 'unavailable')).toEqual({ outcome: 'cancelled' })
  })
})

describe('config-option readers', () => {
  it('finds the advertised model, mode, and reasoning-effort select options', () => {
    const options = [selectOption('model', ['swe-2']), selectOption('mode', ['ask'])]
    expect(acpModelOption(options)?.currentValue).toBe('swe-2')
    expect(acpModeOption(options)?.currentValue).toBe('ask')
    expect(acpReasoningOption([selectOption('reasoning_effort', ['high'])])?.id).toBe('reasoning_effort')
    expect(acpReasoningOption([selectOption('thought_level', ['max'])])?.id).toBe('thought_level')
    // A harness that renames the option still maps through the ACP category.
    expect(acpReasoningOption([{ ...selectOption('effort', ['high']), category: 'thought_level' }])?.id)
      .toBe('effort')
    expect(acpReasoningOption([selectOption('mode', ['ask'])])).toBeUndefined()
    expect(acpModelOption(undefined)).toBeUndefined()
    expect(acpModelOption(null)).toBeUndefined()
    expect(acpModeOption([selectOption('other', ['x'])])).toBeUndefined()
    expect(acpModelOption([{
      id: 'model',
      name: 'Model',
      type: 'boolean',
      currentValue: true,
    }])).toBeUndefined()
  })
})

describe('acpAdvertisedModels', () => {
  it('prefers the session model state and skips entries it cannot name', () => {
    expect(acpAdvertisedModels({
      models: {
        currentModelId: 'swe-2',
        availableModels: [
          null,
          'not-a-model',
          { name: 'no id' },
          { modelId: '', name: 'empty id' },
          { modelId: 'swe-3' },
          { modelId: 'swe-3', name: '' },
          { modelId: 'swe-2', name: 'SWE 2', description: 'standard' },
          { modelId: 'swe-1', name: 'SWE 1' },
        ],
      },
      configOptions: [selectOption('model', ['ignored'])],
    })).toEqual([
      { id: 'swe-2', name: 'SWE 2', description: 'standard' },
      { id: 'swe-1', name: 'SWE 1' },
    ])
  })

  it('falls back to the model option when the session sends no usable model state', () => {
    expect(acpAdvertisedModels({
      models: { currentModelId: 'swe-1' },
      configOptions: [selectOption('model', ['swe-1'])],
    })).toEqual([{ id: 'swe-1', name: 'swe-1' }])
    expect(acpAdvertisedModels({ configOptions: [selectOption('model', ['swe-1'])] }))
      .toEqual([{ id: 'swe-1', name: 'swe-1' }])
    // A model state that is not an object, and a session with neither source.
    expect(acpAdvertisedModels({ models: 'none', configOptions: [] })).toEqual([])
    expect(acpAdvertisedModels({ models: {}, configOptions: [selectOption('mode', ['ask'])] })).toEqual([])
    expect(acpAdvertisedModels({})).toEqual([])
  })
})

describe('acpAdvertisedModels reasoning', () => {
  it('gives every advertised model the session reasoning-effort menu', () => {
    const effort: SessionConfigOption = {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }, { value: 'high', name: 'High', description: 'More thinking' }],
    }
    const reasoning = {
      efforts: [{ id: 'default', name: 'Default' }, { id: 'high', name: 'High', description: 'More thinking' }],
      defaultEffort: 'default',
    }
    expect(acpAdvertisedModels({ configOptions: [selectOption('model', ['opus', 'sonnet']), effort] })).toEqual([
      { id: 'opus', name: 'opus', reasoning },
      { id: 'sonnet', name: 'sonnet', reasoning },
    ])
    // An unset current value names no default, and an option with no values is no menu.
    expect(acpAdvertisedModels({ configOptions: [selectOption('model', ['opus']), { ...effort, currentValue: '' }] }))
      .toEqual([{ id: 'opus', name: 'opus', reasoning: { efforts: reasoning.efforts } }])
    expect(acpAdvertisedModels({ configOptions: [selectOption('model', ['opus']), { ...effort, options: [] }] }))
      .toEqual([{ id: 'opus', name: 'opus' }])
  })
})

describe('acpSelectEntries', () => {
  it('flattens flat and grouped values and skips entries that carry no value', () => {
    const grouped = {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'a',
      options: [
        { value: 'a', name: 'A', description: 'first' },
        { value: 'b', name: 'B', description: '' },
        null,
        'not-a-value',
        { value: 7, name: 'seven' },
        { value: 'c' },
        { group: 'g', name: 'G', options: [{ value: 'd', name: 'D', description: 'grouped' }] },
      ],
    } as unknown as AcpSelectOption
    expect(acpSelectEntries(grouped)).toEqual([
      { value: 'a', name: 'A', description: 'first' },
      { value: 'b', name: 'B' },
      { value: 'd', name: 'D', description: 'grouped' },
    ])
  })

  it('reads an option with no value list, and no option at all, as offering none', () => {
    expect(acpSelectEntries(undefined)).toEqual([])
    expect(acpSelectEntries({
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'a',
      options: 'not-a-list',
    } as unknown as AcpSelectOption)).toEqual([])
  })
})

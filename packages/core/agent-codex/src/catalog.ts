/**
 * The `codex` LLM-adapter route: a catalog-only provider whose `listModels`
 * and `resolveModel` answer from the shared app-server's `model/list`, so the
 * session model picker enumerates real Codex models and their reasoning
 * efforts. The route serves no stream — Codex sessions drive turns through
 * the app-server, never through `ctx.llm` calls.
 *
 * @module @deepseek-ai/dsh-agent-codex/catalog
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ModelModality,
  type ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { CODEX_PREFIX, type CodexAppServerRuntime } from './runtime.ts'
import { codexString, type JsonObject } from './protocol.ts'
import { CODEX_PROVIDER } from './agent.ts'

/** Modalities Codex advertises that map onto the picker's vocabulary. */
const KNOWN_MODALITIES = new Set<string>(['text', 'image'])

/**
 * Model-catalog adapter over the profile's shared app-server connection.
 * Registered for the `codex` provider id so `ctx.llm.listProviders()` /
 * `listModels()` / `resolveModelInfo()` enumerate the harness's own catalog.
 */
export class CodexCatalogAdapter extends LlmAdapter {
  /** @param runtime - the profile's shared app-server runtime. */
  constructor(private readonly runtime: CodexAppServerRuntime) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Codex' }
  }

  /**
   * Enumerate the app-server's visible catalog.
   * @param _provider - the `codex` route this adapter owns.
   * @returns model entries in server-preferred order.
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const entries = await this.runtime.listCodexModels()
    return entries.map(entry => toModelInfo(entry))
  }

  /**
   * Resolve one exact model's metadata, including its reasoning-effort menu.
   * The catalog is advisory: an unlisted id still resolves to an identity
   * entry so a picker-stored selection keeps working when the model drops
   * out of the listing.
   * @param provider - the `codex` route.
   * @param model - exact model id.
   * @param signal - cancellation for the catalog read.
   * @returns the resolved model info.
   */
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entries = await this.runtime.listCodexModels(signal)
    const entry = entries.find(candidate => optionalString(candidate.model) === model
      || optionalString(candidate.id) === model)
    if (entry === undefined) return { provider, id: model, name: model }
    const info = toModelInfo(entry)
    return { ...info, ...reasoningInfo(entry) }
  }

  /**
   * Reject every stream request: the `codex` route is a catalog entry, not an
   * LLM endpoint. Reaching here means a composition mounted the route where a
   * request-driving consumer could resolve it — a loud failure, never a
   * silent fallback.
   */
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error(
      `${CODEX_PREFIX}: provider "${CODEX_PROVIDER}" is a catalog entry for Codex-driven sessions and serves no model calls`,
    )
  }
}

/** Map one `model/list` entry to the picker's model shape. */
function toModelInfo(entry: JsonObject): LlmModelInfo {
  const id = codexString(entry.model ?? entry.id, 'model/list entry id', CODEX_PREFIX)
  const inputModalities = Array.isArray(entry.inputModalities)
    ? entry.inputModalities.flatMap(modality => KNOWN_MODALITIES.has(String(modality))
      ? [modality as ModelModality]
      : [])
    : undefined
  return {
    provider: CODEX_PROVIDER,
    id,
    name: optionalString(entry.displayName) ?? id,
    ...optionalString(entry.description) === undefined ? {} : { description: entry.description as string },
    ...inputModalities === undefined ? {} : { inputModalities },
  }
}

/** The `reasoning` member of a resolved model, when the entry advertises efforts. */
function reasoningInfo(entry: JsonObject): Pick<LlmResolvedModelInfo, 'reasoning'> {
  const efforts = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts.flatMap((raw) => {
      const option = raw !== null && typeof raw === 'object' ? raw as JsonObject : undefined
      const effort = option === undefined ? undefined : optionalString(option.reasoningEffort)
      if (option === undefined || effort === undefined) return []
      const description = optionalString(option.description)
      return [{
        id: brandString<ReasoningEffortId>(effort),
        name: effort,
        ...description === undefined ? {} : { description },
      }]
    })
    : []
  if (efforts.length === 0) return {}
  const defaultEffort = optionalString(entry.defaultReasoningEffort)
  return {
    reasoning: {
      efforts,
      ...defaultEffort === undefined ? {} : { defaultEffort: brandString<ReasoningEffortId>(defaultEffort) },
    },
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

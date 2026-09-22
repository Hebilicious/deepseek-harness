/**
 * The `devin` LLM-adapter route: a catalog-only provider whose `listModels`
 * and `resolveModel` answer from `devin models list --format json`, so the
 * session model picker enumerates real Devin models. The route serves no
 * stream — ACP sessions drive turns through `session/prompt`, never through
 * `ctx.llm` calls.
 *
 * @module @deepseek-ai/dsh-agent-acp/catalog
 */

import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ACP_PREFIX, ACP_PROVIDER } from './protocol.ts'
import type { AcpRuntime, DevinModelEntry } from './runtime.ts'

/**
 * Model-catalog adapter over the profile's Devin CLI. Registered for the
 * `devin` provider id so `ctx.llm.listProviders()` / `listModels()` /
 * `resolveModelInfo()` enumerate the harness's own catalog.
 */
export class DevinCatalogAdapter extends LlmAdapter {
  /** @param runtime - the profile's shared ACP runtime. */
  constructor(private readonly runtime: AcpRuntime) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Devin' }
  }

  /**
   * Enumerate the Devin model catalog.
   * @param _provider - the `devin` route this adapter owns.
   * @returns model entries in CLI order.
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const entries = await this.runtime.listDevinModels()
    return entries.map(entry => toModelInfo(entry))
  }

  /**
   * Resolve one exact model's metadata. The catalog is advisory: an unlisted
   * id still resolves to an identity entry so a picker-stored selection keeps
   * working when the model drops out of the listing.
   * @param provider - the `devin` route.
   * @param model - exact model id.
   * @param signal - cancellation for the catalog read.
   * @returns the resolved model info.
   */
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entries = await this.runtime.listDevinModels(signal)
    const entry = entries.find(candidate => candidate.id === model)
    return entry === undefined
      ? { provider, id: model, name: model }
      : toModelInfo(entry)
  }

  /**
   * Reject every stream request: the `devin` route is a catalog entry, not an
   * LLM endpoint. Reaching here means a composition mounted the route where a
   * request-driving consumer could resolve it — a loud failure, never a
   * silent fallback.
   */
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error(
      `${ACP_PREFIX}: provider "${ACP_PROVIDER}" is a catalog entry for Devin-driven sessions and serves no model calls`,
    )
  }
}

/** Map one `devin models list` variant to the picker's model shape. */
function toModelInfo(entry: DevinModelEntry): LlmModelInfo {
  return {
    provider: ACP_PROVIDER,
    id: entry.id,
    name: entry.name,
    ...entry.description === undefined ? {} : { description: entry.description },
  }
}

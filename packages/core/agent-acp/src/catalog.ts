/**
 * One harness's LLM-adapter route: a catalog-only provider whose `listModels`
 * and `resolveModel` answer from what that harness's sessions advertise,
 * falling back to the optional CLI catalog verb, so the session model picker
 * enumerates real harness models. The route serves no stream — ACP sessions
 * drive turns through `session/prompt`, never through `ctx.llm` calls.
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
import { acpPrefix } from './protocol.ts'
import type { AcpRuntime } from './runtime.ts'
import type { AcpCatalogModel } from './types.ts'

/**
 * Model-catalog adapter over one harness. Registered for that harness's id so
 * `ctx.llm.listProviders()` / `listModels()` / `resolveModelInfo()` enumerate
 * the harness's own catalog.
 */
export class AcpCatalogAdapter extends LlmAdapter {
  /**
   * @param provider - the harness id this adapter owns as a route.
   * @param displayName - the harness's human-readable name for the picker.
   * @param runtime - that harness's shared ACP runtime.
   */
  constructor(
    private readonly provider: string,
    private readonly displayName: string,
    private readonly runtime: AcpRuntime,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.displayName }
  }

  /**
   * Enumerate the harness's model catalog: the advert of its most recently
   * bound session when there is one, otherwise the configured CLI verb.
   * @param _provider - the harness route this adapter owns.
   * @returns model entries in advert or CLI order.
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const entries = await this.catalog()
    return entries.map(entry => this.toModelInfo(entry))
  }

  /**
   * Resolve one exact model's metadata. The catalog is advisory: an unlisted
   * id still resolves to an identity entry so a picker-stored selection keeps
   * working when the model drops out of the listing.
   * @param provider - the harness route.
   * @param model - exact model id.
   * @param signal - cancellation for the catalog read.
   * @returns the resolved model info.
   */
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entry = (await this.catalog(signal)).find(candidate => candidate.id === model)
    if (entry === undefined) return { provider, id: model, name: model }
    return {
      ...this.toModelInfo(entry),
      ...entry.reasoning === undefined ? {} : { reasoning: entry.reasoning },
    }
  }

  /**
   * Reject every stream request: a harness route is a catalog entry, not an
   * LLM endpoint. Reaching here means a composition mounted the route where a
   * request-driving consumer could resolve it — a loud failure, never a
   * silent fallback.
   */
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error(
      `${acpPrefix(this.provider)}: provider "${this.provider}" is a catalog entry for ACP-driven sessions and serves no model calls`,
    )
  }

  /** Read the harness catalog: a bound session's advert, the CLI verb, or one probe session. */
  private async catalog(signal?: AbortSignal): Promise<readonly AcpCatalogModel[]> {
    return this.runtime.catalog(signal)
  }

  /** Map one harness catalog entry to the picker's model shape. */
  private toModelInfo(entry: AcpCatalogModel): LlmModelInfo {
    return {
      provider: this.provider,
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
    }
  }
}

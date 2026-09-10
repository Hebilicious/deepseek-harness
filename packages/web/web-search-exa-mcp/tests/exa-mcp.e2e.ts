import { describe, expect, it } from 'vitest'
import { EXA_MCP_DEFAULT_ENDPOINT, ExaMcpSearchProvider } from '@deepseek-ai/dsh-web-search-exa-mcp'

/**
 * Real-endpoint smoke for the Exa MCP search provider. This provider needs no
 * credential, so the suite runs by default instead of self-skipping on a key;
 * `DSH_EXA_MCP_E2E=0` takes the third-party endpoint back out of a run without
 * reverting this file.
 */
const maybe = process.env.DSH_EXA_MCP_E2E === '0' ? describe.skip : describe

maybe('ExaMcpSearchProvider real endpoint', () => {
  it('returns sources for a live query', async () => {
    const provider = new ExaMcpSearchProvider({ apiKey: '', endpoint: EXA_MCP_DEFAULT_ENDPOINT })
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 3 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 30_000)

  it('honors a configured Exa API key without changing the result contract', async () => {
    const apiKey = process.env.EXA_API_KEY
    if (apiKey === undefined || apiKey.length === 0) return
    const provider = new ExaMcpSearchProvider({ apiKey, endpoint: EXA_MCP_DEFAULT_ENDPOINT })
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 2 })
    expect(result.sources.length).toBeGreaterThan(0)
  }, 30_000)
})

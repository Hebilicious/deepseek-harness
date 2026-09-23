/**
 * One bounded read of an HTTP reply body, shared by the two fetches this
 * package makes against a caller-supplied URL: the endpoint model listing and
 * the model-directory snapshot. Neither is parseable when truncated, so both
 * refuse an oversized reply instead of truncating it, and both hold the ceiling
 * on the bytes actually read because a server that under-declares its length
 * (or streams) tells the caller nothing up front.
 *
 * @module dsh-llm-pi-ai/bounded-body
 */

/** A reply body that outgrew its caller's ceiling. */
export class OversizedBodyError extends Error {}

/**
 * Read a reply body, refusing one that outgrows `maxBytes`. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound.
 * @param response - the reply whose body to read.
 * @param url - request URL, named in the refusal.
 * @param maxBytes - ceiling on the bytes read from the body.
 * @returns the decoded body.
 * @throws OversizedBodyError when the reply exceeds `maxBytes`.
 */
export async function readBounded(response: Response, url: string, maxBytes: number): Promise<string> {
  const oversized = (): OversizedBodyError =>
    new OversizedBodyError(`${url} answered with more than ${maxBytes} bytes`)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

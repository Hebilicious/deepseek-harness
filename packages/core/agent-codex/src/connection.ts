/**
 * Shared `codex app-server --stdio` JSON-RPC endpoint: owns the line
 * transport, the initialize/initialized handshake, the fatal-failure race
 * every request joins, and dispatch to the caller's server-request and
 * notification handlers. Thread/turn association and product policy live in
 * the callers.
 *
 * @module @deepseek-ai/dsh-agent-codex/connection
 */

import type { Readable, Writable } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { codexObject, CodexRequestRefused, type JsonObject } from './protocol.ts'

/** Caller-implemented dispatch surface for server-initiated frames. */
export interface CodexConnectionHandlers {
  /**
   * Answer one server→client request. A rejection becomes a `-32603` error
   * response; handlers that detect a protocol violation also call
   * {@link CodexConnectionHandlers.fatal} before throwing.
   * @param method - the wire method name.
   * @param params - the decoded params object.
   * @returns the response `result` payload.
   */
  request(method: string, params: JsonObject): Promise<unknown>
  /**
   * Consume one server→client notification. Throwing fails the connection —
   * notifications carry no response channel, so a malformed one is a
   * protocol violation.
   * @param method - the wire method name.
   * @param params - the decoded params object.
   */
  notification(method: string, params: JsonObject): void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal, prefix: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${prefix}: app-server request aborted: ${String(signal.reason)}`)
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal, prefix: string): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal, prefix)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal, prefix)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One app-server stdio connection. Deliberately exposes no product methods:
 * callers name each supported method at their own layer so the protocol
 * surface stays auditable.
 */
export class CodexAppServerConnection {
  private readonly transport: JsonRpcLineTransport
  private readonly fatalPromise = Promise.withResolvers<never>()
  private closed = false

  /**
   * @param input - child stdout (server frames inbound).
   * @param output - child stdin (client frames outbound).
   * @param handlers - server-request/notification dispatch and the fatal sink.
   * @param prefix - diagnostic prefix for connection-raised errors.
   */
  constructor(
    private readonly input: Readable,
    output: Writable,
    private readonly handlers: CodexConnectionHandlers,
    private readonly prefix: string,
  ) {
    this.transport = new JsonRpcLineTransport(input, output)
    // Fatal protocol state can arrive after the current guarded operation has
    // already settled. Keep the shared rejection observed without inserting
    // another promise-adoption hop into active races.
    void this.fatalPromise.promise.catch(() => {})
    this.transport.onRequest(async (method, params) => {
      try {
        return await this.handlers.request(method, params)
      } catch (error: unknown) {
        const normalized = thrown(error)
        // A CodexRequestRefused stays request-scoped: it answers this one
        // request with an error response while the connection stays live for
        // other threads. Every other failure is a protocol violation.
        if (!(normalized instanceof CodexRequestRefused)) this.fail(normalized)
        throw normalized
      }
    })
    this.transport.onNotification((method, params) => {
      try {
        this.handlers.notification(method, params)
      } catch (error: unknown) {
        this.fail(thrown(error))
      }
    })
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    // Pipe errors can race protocol closure and process teardown. Retain both
    // error listeners for the lifetime of the streams so no late EPIPE or
    // read failure becomes an unhandled EventEmitter error.
    output.on('error', this.onOutputError)
  }

  /** Rejects when the connection enters fatal state; never resolves. */
  get fatal(): Promise<never> {
    return this.fatalPromise.promise
  }

  /** Start reading app-server frames. */
  start(): void {
    this.transport.start()
  }

  /**
   * Send one request raced against the fatal signal and the caller's
   * cancellation.
   * @param method - the JSON-RPC method name.
   * @param params - the params object.
   * @param signal - optional abandonment signal.
   * @returns the decoded `result` member.
   */
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    const pending = Promise.race([this.fatalPromise.promise, this.transport.request(method, params, signal)])
    return signal === undefined ? pending : raceAbort(pending, signal, this.prefix)
  }

  /**
   * Send one notification. Write failures surface on the fatal signal the
   * next guarded operation observes.
   * @param method - the JSON-RPC method name.
   * @param params - the optional params object.
   */
  notify(method: string, params?: object): void {
    this.transport.notify(method, params)
  }

  /** Wait for prior frame write callbacks. */
  flush(): Promise<void> {
    return this.transport.flush()
  }

  /**
   * Perform the required app-server initialize/initialized handshake.
   * @param signal - unpublished-start cancellation.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    codexObject(await this.request('initialize', {
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    }, signal), 'initialize response', this.prefix)
    this.transport.notify('initialized')
    await raceAbort(this.transport.flush(), signal, this.prefix)
  }

  /** Detach JSON-RPC listeners and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

  private fail(error: Error): void {
    this.fatalPromise.reject(error)
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    this.fail(new Error(`${this.prefix}: app-server protocol stream closed`))
  }
}

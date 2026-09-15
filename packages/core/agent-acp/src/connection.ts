/**
 * Shared `devin acp` (or any ACP server) stdio connection: one
 * SDK-managed JSON-RPC endpoint that routes session-scoped notifications and
 * client requests to the registered {@link AcpSessionPeer} by `sessionId`.
 * Capability advertisement is fixed at `clientCapabilities: {}` so the agent
 * self-serves its own filesystem and terminal work.
 *
 * @module @deepseek-ai/dsh-agent-acp/connection
 */

import {
  client as createAcpClient,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import type { Readable, Writable } from 'node:stream'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import { ACP_PREFIX } from './protocol.ts'

/** Session-scoped dispatch surface one bound {@link AcpAgent} implements. */
export interface AcpSessionPeer {
  /**
   * Consume one `session/update` notification for the bound ACP session.
   * @param notification - the typed update payload.
   */
  update(notification: SessionNotification['update']): void
  /**
   * Answer one `session/request_permission` request for the bound session.
   * @param params - the permission request.
   * @returns the chosen outcome.
   */
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
  /**
   * Answer one `elicitation/create` request scoped to the bound session.
   * @param params - the elicitation request.
   * @returns the elicitation response.
   */
  elicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse>
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * One ACP stdio connection plus its session-peer routing table. The ACP SDK
 * owns schema validation and request/response correlation; this class owns
 * the fixed `initialize` handshake, sessionId dispatch, and the fatal
 * observation every caller joins.
 */
export class AcpClientConnection {
  private readonly connection: ClientConnection
  private readonly fatalPromise = Promise.withResolvers<never>()
  private terminated = false

  private constructor(
    connection: ClientConnection,
    private readonly peers: Map<string, AcpSessionPeer>,
  ) {
    this.connection = connection
    // Fatal connection state can settle after the current guarded operation.
    // Keep the shared rejection observed without another adoption hop.
    void this.fatalPromise.promise.catch(() => {})
    this.connection.closed.then(
      () => { this.fail(new Error(`${ACP_PREFIX}: ACP connection closed`)) },
      (error: unknown) => { this.fail(thrown(error)) },
    )
  }

  /**
   * Build the client app over the child's stdio and run `initialize`. Handler
   * registration is complete before the stream opens so no inbound frame can
   * arrive unhandled.
   * @param input - child stdout (agent frames inbound).
   * @param output - child stdin (client frames outbound).
   * @param signal - startup cancellation.
   * @returns the live connection and the agent's initialize response.
   */
  static async open(
    input: Readable,
    output: Writable,
    signal: AbortSignal,
  ): Promise<{ connection: AcpClientConnection; initialize: InitializeResponse }> {
    const peers = new Map<string, AcpSessionPeer>()
    const app = createAcpClient({ name: 'deepseek-harness' })
      .onNotification(methods.client.session.update, ({ params }) => {
        peers.get(params.sessionId)?.update(params.update)
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        const peer = peers.get(params.sessionId)
        if (peer === undefined) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        return peer.requestPermission(params)
      })
      .onRequest(methods.client.elicitation.create, ({ params }) => {
        const sessionId = 'sessionId' in params && typeof params.sessionId === 'string'
          ? params.sessionId
          : undefined
        const peer = sessionId === undefined ? undefined : peers.get(sessionId)
        if (peer === undefined) return Promise.resolve({ action: 'decline' })
        return peer.elicitation(params)
      })
    const connection = app.connect(ndJsonStream(
      NodeWritable.toWeb(output) as WritableStream<Uint8Array>,
      NodeReadable.toWeb(input) as ReadableStream<Uint8Array>,
    ))
    const initialize = await raceAbort(
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'deepseek-harness', version: '0.0.0' },
        // Advertise NO optional client capabilities (no fs, no terminal): the
        // agent self-serves in its own process.
        clientCapabilities: {},
      }),
      signal,
    )
    const self = new AcpClientConnection(connection, peers)
    return { connection: self, initialize }
  }

  /** Rejects when the connection enters fatal state; never resolves. */
  get fatal(): Promise<never> {
    return this.fatalPromise.promise
  }

  /** The agent-side request/notify context. */
  get agent(): ClientConnection['agent'] {
    return this.connection.agent
  }

  /** Whether the connection has entered closed or fatal state. */
  get closed(): boolean {
    return this.terminated
  }

  /**
   * Register the peer that owns one ACP session id.
   * @param sessionId - the agent-issued session id.
   * @param peer - dispatch surface for that session's updates and requests.
   * @returns the disposer that detaches the peer.
   */
  registerPeer(sessionId: string, peer: AcpSessionPeer): () => void {
    this.peers.set(sessionId, peer)
    return () => {
      if (this.peers.get(sessionId) === peer) this.peers.delete(sessionId)
    }
  }

  /**
   * Send one request raced against the fatal signal and the caller's
   * cancellation.
   * @param method - the JSON-RPC method name.
   * @param params - the params object.
   * @param signal - optional abandonment signal.
   * @returns the decoded result.
   */
  request<Response>(method: string, params: object, signal?: AbortSignal): Promise<Response> {
    const pending = Promise.race([
      this.fatalPromise.promise,
      this.connection.agent.request<Response>(method, params, signal === undefined ? undefined : { cancellationSignal: signal }),
    ])
    return signal === undefined ? pending : raceAbort(pending, signal)
  }

  /**
   * Send one notification. Write failures surface on the fatal signal the
   * next guarded operation observes.
   * @param method - the JSON-RPC method name.
   * @param params - the optional params object.
   */
  notify(method: string, params?: object): void {
    void this.connection.agent.notify(method, params).catch(() => {})
  }

  /** Close the connection and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.terminated) return
    this.terminated = true
    this.connection.close()
  }

  private fail(error: Error): void {
    this.terminated = true
    this.fatalPromise.reject(error)
  }
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => {
    rejectAbort(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * The `agentToolBridge` service: projects the tools visible in one Agent's
 * scope onto transports external agent harnesses can call. `openMcpEndpoint`
 * serves the bridged view over an authenticated loopback MCP Streamable HTTP
 * listener for harnesses that configure MCP servers by URL — the ACP driver
 * carries it as a `session/new`/`session/load` `mcpServers` entry and Codex
 * as `mcp_servers.*` config overrides on `thread/start`/`thread/resume`.
 *
 * Every bridged call runs `ctx.tools.execute` under the Agent's own identity,
 * so the shared pre-policy, approval, guards, and post-policy pipeline applies
 * unchanged and the `exclude` list is re-enforced at call time, not only in
 * the exposed list. The bridge appends no `tool/call` or `tool/result`
 * records — the external driver logs the harness's own tool calls; it
 * appends one log-only `agent-tool-bridge/exposed` event per opened endpoint,
 * recording the tool list the harness may see.
 *
 * Harnesses report bridged calls under `mcp__<serverName>__<tool>` names, so
 * the bridge also retains each settled execution's presentation `meta` for
 * the driver's transcript correlation: {@link bridgedToolName} maps a
 * harness-reported name back to the dsh tool and {@link takeCompletion}
 * hands over the matching execution's `meta` — present only when the tool
 * declares `presentationMeta`, which is how a bridged call logs the card
 * payload an in-process call produces.
 *
 * @module @deepseek-ai/dsh-agent-tool-bridge
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain, fileHandleText, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type ContentBlock as McpContentBlock,
  type JsonSchemaType,
  type McpHttpHandler,
} from '@modelcontextprotocol/server'
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
  type NodeIncomingMessageLike,
  type NodeMcpRequestHandler,
} from '@modelcontextprotocol/node'
import type {
  BridgedCompletion,
  BridgedTool,
  BridgedToolResult,
  BridgeMcpEndpoint,
  BridgeToolCall,
  Config,
} from './types.ts'

export type {
  BridgedCompletion,
  BridgedTool,
  BridgedToolResult,
  BridgeMcpEndpoint,
  BridgeToolCall,
  Config,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The tool bridge external agent harnesses reach dsh tools through. */
    agentToolBridge: AgentToolBridge
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The tool names one `agentToolBridge` endpoint exposed to an external
     * harness. Appended when the endpoint's credential is committed; the list
     * is the agent's bridged view at that moment and later `tools/list`
     * answers may differ as registrations change. A bind that rolls back
     * after the credential was committed still records the event — a live
     * credential existed, so the audit record does — and presence does not
     * imply the harness received the URL. Log-only: the bridge adds no
     * model-visible surface content of its own.
     */
    'agent-tool-bridge/exposed': {
      /** The exposed tool names, in catalog order. */
      tools: string[]
    }
  }
}

/** One live endpoint: its credential and the request handler serving it. */
interface Endpoint {
  /** The agent whose tool scope this endpoint serves. */
  readonly agent: Agent
  /** The endpoint's bearer credential as sent in Authorization, compared constant-time per request. */
  readonly credential: Buffer
  /** The endpoint's MCP protocol handler (fresh `McpServer` per request). */
  readonly handler: McpHttpHandler
  /** The endpoint's handler adapted to `node:http`. */
  readonly nodeHandler: NodeMcpRequestHandler
  /**
   * Aborted on close: `handler.close()` reaches only modern-era exchanges,
   * so the endpoint's own signal carries close-time cancellation to the
   * legacy-era `tools/call` current harnesses speak.
   */
  readonly controller: AbortController
  /** Set on close; makes endpoint teardown idempotent. */
  closed: boolean
}

/** Whether `host` names a loopback interface the listener may bind. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/** Extract the bearer token of an Authorization header, or undefined. */
function bearerToken(header: string | undefined): Buffer | undefined {
  if (header === undefined || !header.startsWith('Bearer ')) return undefined
  return Buffer.from(header.slice('Bearer '.length))
}

/**
 * Canonical JSON of one call-arguments value: object keys serialize in sorted
 * order recursively, so key order never splits an otherwise identical call
 * into two correlation entries.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * The `agentToolBridge` service (`ctx.agentToolBridge`). Owns one shared
 * loopback HTTP listener; every {@link openMcpEndpoint} call attaches one
 * bearer-credentialed endpoint to it. The listener binds lazily on the first
 * opened endpoint and closes with the service.
 */
export class AgentToolBridge extends Service {
  static inject = ['tools']

  /** Inline schema call: the config catalog walks `static Config` statically. */
  static Config: z<Config> = z.object({
    exclude: z.array(z.string()).default([]),
    host: z.string().default('127.0.0.1'),
    port: z.natural().max(65535).default(0),
    serverName: z.string().min(1).pattern(/^(?!.*__)[^.]+$/).default('dsh'),
    correlationLimit: z.natural().min(1).default(100),
  })

  private readonly exclude: ReadonlySet<string>
  /** The `mcp__<serverName>__` prefix harnesses report bridged tools under. */
  private readonly bridgedPrefix: string
  private readonly correlationLimit: number
  private readonly endpoints = new Set<Endpoint>()
  /**
   * Settled bridged executions per agent, oldest first. {@link takeCompletion}
   * consumes the oldest entry matching name and canonical arguments; entries
   * the harness never reports age out through {@link correlationLimit} and
   * the whole queue drops on `agent/disposed`.
   */
  private readonly completions = new Map<Agent, BridgedCompletion[]>()
  /** The SDK's loopback guards: DNS-rebinding (Host) and cross-origin (Origin) request checks. */
  private readonly hostGuard = localhostHostValidation()
  private readonly originGuard = localhostOriginValidation()
  private server: Server | undefined
  private listening: Promise<void> | undefined
  /** The bound socket's URL-ready host and port once {@link ensureListening} has settled. */
  private boundAddress: { host: string; port: number } | undefined

  /**
   * @param ctx - the plugin fiber context.
   * @param config - resolved plugin config; only loopback hosts are accepted
   *   because the bearer credential is the endpoint's whole request check.
   */
  constructor(ctx: Context, public config: Config = {}) {
    super(ctx, 'agentToolBridge')
    const host = config.host ?? '127.0.0.1'
    if (!isLoopbackHost(host)) {
      throw new Error(`agentToolBridge: host "${host}" is not a loopback interface`)
    }
    const serverName = config.serverName ?? 'dsh'
    /* The schema rejects these at load; the constructor re-checks because
       serverName joins harness-visible tool names and Codex config keys. */
    if (serverName.length === 0 || serverName.includes('.') || serverName.includes('__')) {
      throw new Error(`agentToolBridge: serverName "${serverName}" must be non-empty and not contain '.' or '__'`)
    }
    this.bridgedPrefix = `mcp__${serverName}__`
    this.correlationLimit = config.correlationLimit ?? 100
    this.exclude = new Set(config.exclude ?? [])
    ctx.on('agent/disposed', ({ agent }) => {
      this.completions.delete(agent)
      /* v8 ignore start -- handler.close() has no failure mode a spec can reach deterministically */
      void this.closeAgentEndpoints(agent).catch((error: unknown) => {
        this.ctx.logger.warn(`agentToolBridge: endpoint teardown failed: ${errorChain(error)}`)
      })
      /* v8 ignore stop */
    })
    ctx.effect(() => async () => {
      const server = this.server
      const endpoints = [...this.endpoints]
      this.endpoints.clear()
      this.server = undefined
      this.listening = undefined
      this.boundAddress = undefined
      for (const endpoint of endpoints) {
        try {
          await this.closeEndpoint(endpoint)
        /* v8 ignore start -- handler.close() has no failure mode a spec can reach deterministically */
        } catch (error: unknown) {
          this.ctx.logger.warn(`agentToolBridge: endpoint close failed: ${errorChain(error)}`)
        }
        /* v8 ignore stop */
      }
      if (server !== undefined) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            /* v8 ignore next -- closeAllConnections drained the sockets; close() fails only on an already-dead server */
            if (error !== undefined) reject(error)
            else resolve()
          })
        })
      }
    }, 'agentToolBridge.close()')
  }

  /**
   * The tools this agent may call through the bridge: its scope's visible
   * tools minus the configured `exclude` names, in catalog order.
   */
  private tools(agent: Agent): BridgedTool[] {
    return this.ctx.tools.schemas(agent)
      .filter(schema => !this.exclude.has(schema.name))
      .map(schema => ({
        name: schema.name,
        description: schema.description,
        inputSchema: schema.parameters,
      }))
  }

  /**
   * Run one tool through the shared policy pipeline as `agent`. A name outside
   * {@link tools} — unknown to the scope or excluded — is refused as an error
   * result without reaching the registry, so exclusion cannot be bypassed by
   * calling a withheld name directly.
   */
  private async call(agent: Agent, request: BridgeToolCall): Promise<BridgedToolResult> {
    /* v8 ignore start -- the per-request McpServer registers only the live
       bridged set, so refusal fires only when a registration disappears
       between server construction and dispatch inside one request */
    if (this.exclude.has(request.name) || this.ctx.tools.get(request.name, agent) === undefined) {
      return {
        content: [{ type: 'text', text: `Error: unknown tool "${request.name}"` }],
        isError: true,
      }
    }
    /* v8 ignore stop */
    const result = await this.ctx.tools.execute({
      callId: ToolCallId(`bridge-${randomUUID()}`),
      name: request.name,
      arguments: request.arguments,
      agent,
      signal: request.signal,
    })
    const pending = this.completions.get(agent) ?? []
    if (pending.length >= this.correlationLimit) pending.shift()
    pending.push({
      name: request.name,
      argumentsJson: canonicalJson(request.arguments),
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    })
    this.completions.set(agent, pending)
    return {
      content: result.content,
      isError: result.isError,
    }
  }

  /**
   * Expose `agent`'s bridged tools on the shared loopback listener under a
   * fresh bearer credential, and record `agent-tool-bridge/exposed` on the
   * agent's session. The endpoint answers `tools/list` from the agent's live
   * scope on every request and routes `tools/call` through the shared policy
   * pipeline with the request's abort signal fused with the endpoint's.
   * `close()` revokes the credential and aborts in-flight calls; the agent's
   * `agent/disposed` and the service's disposal close it implicitly.
   * @param agent - the agent the endpoint serves.
   * @returns the URL and headers a client connects with, plus `close()`.
   */
  async openMcpEndpoint(agent: Agent): Promise<BridgeMcpEndpoint> {
    await this.ensureListening()
    const credential = randomBytes(32).toString('base64url')
    const controller = new AbortController()
    const handler = createMcpHandler(() => this.mcpServer(agent, controller.signal), {
      onerror: (error) => {
        this.ctx.logger.warn(`agentToolBridge: MCP request failed: ${errorChain(error)}`)
      },
    })
    const endpoint: Endpoint = {
      agent,
      credential: Buffer.from(credential),
      handler,
      nodeHandler: toNodeHandler(handler),
      controller,
      closed: false,
    }
    this.endpoints.add(endpoint)
    try {
      agent.session.append('agent-tool-bridge/exposed', {
        tools: this.tools(agent).map(tool => tool.name),
      })
    } catch (error: unknown) {
      try {
        await this.closeEndpoint(endpoint)
      /* v8 ignore start -- a never-served endpoint's close has nothing in flight to fail */
      } catch (closeError: unknown) {
        // The append failure is the error the opener sees; a rollback close
        // failure is logged, not substituted for it.
        this.ctx.logger.warn(`agentToolBridge: rollback close failed: ${errorChain(closeError)}`)
      }
      /* v8 ignore stop */
      throw error
    }
    const bound = this.boundAddress
    /* v8 ignore next -- ensureListening resolved, so the listener is bound */
    if (bound === undefined) throw new Error('agentToolBridge: listener is not bound')
    return {
      name: this.config.serverName ?? 'dsh',
      url: `http://${bound.host}:${bound.port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${credential}` }],
      close: () => this.closeEndpoint(endpoint),
    }
  }

  /**
   * Resolve a harness-reported tool name to the agent's bridged dsh tool:
   * `mcp__<serverName>__<tool>` where `<tool>` is currently bridged for
   * `agent`. Excluded, unscoped, and unrecognized names return undefined, so
   * the caller logs them exactly as the harness reported.
   * @param agent - the agent the harness is driving.
   * @param reported - the tool name the harness reported for the call.
   * @returns the dsh tool name, or undefined when the call is not bridged.
   */
  bridgedToolName(agent: Agent, reported: string): string | undefined {
    if (!reported.startsWith(this.bridgedPrefix)) return undefined
    const name = reported.slice(this.bridgedPrefix.length)
    if (name.length === 0 || this.exclude.has(name)) return undefined
    return this.ctx.tools.get(name, agent) === undefined ? undefined : name
  }

  /**
   * Consume the oldest settled bridged execution for `agent` whose dsh tool
   * name and arguments match, so a harness-reported `tool/result` can carry
   * the execution's `meta`. Arguments compare as canonical JSON — object key
   * order is irrelevant — and identical calls correlate first-in-first-out.
   * @param agent - the agent the harness is driving.
   * @param tool - the dsh tool name {@link bridgedToolName} resolved.
   * @param argumentsJson - the serialized arguments the harness reported.
   * @returns the settled completion, or undefined when none matches.
   */
  takeCompletion(agent: Agent, tool: string, argumentsJson: string): BridgedCompletion | undefined {
    const pending = this.completions.get(agent)
    if (pending === undefined) return undefined
    let canonical: string
    try {
      canonical = canonicalJson(JSON.parse(argumentsJson))
    } catch {
      return undefined
    }
    const index = pending
      .findIndex(entry => entry.name === tool && entry.argumentsJson === canonical)
    if (index === -1) return undefined
    const [completion] = pending.splice(index, 1)
    if (pending.length === 0) this.completions.delete(agent)
    return completion
  }

  /** Build the per-request `McpServer` serving `agent`'s current bridged set. */
  private mcpServer(agent: Agent, endpointSignal: AbortSignal): McpServer {
    const mcp = new McpServer(
      { name: this.config.serverName ?? 'dsh', version: '0.0.0' },
      { capabilities: { tools: {} } },
    )
    for (const tool of this.tools(agent)) {
      mcp.registerTool(tool.name, {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
      }, async (args, callContext): Promise<CallToolResult> => {
        const signal = AbortSignal.any([callContext.mcpReq.signal, endpointSignal])
        const result = await this.call(agent, {
          name: tool.name,
          arguments: args,
          signal,
        })
        return {
          content: await this.mcpContent(result.content, signal),
          isError: result.isError,
        }
      })
    }
    return mcp
  }

  /**
   * Project dsh content blocks onto MCP content: text and reasoning carry
   * over, an image resolves its stored bytes through the attachment service,
   * a file becomes its stable handle text, and anything else serializes
   * losslessly so no content is silently dropped.
   */
  private async mcpContent(
    content: readonly ContentBlock[],
    signal: AbortSignal,
  ): Promise<McpContentBlock[]> {
    const blocks: McpContentBlock[] = []
    for (const block of content) {
      switch (block.type) {
        case 'text':
        case 'reasoning':
          blocks.push({ type: 'text', text: block.text })
          break
        case 'image':
          blocks.push(await this.mcpImage(block.attachment, signal))
          break
        case 'file':
          blocks.push({ type: 'text', text: this.fileText(block.attachment) })
          break
        default:
          blocks.push({ type: 'text', text: JSON.stringify(block) })
      }
    }
    return blocks
  }

  /**
   * Read one image attachment's verified bytes for MCP `image` content. When
   * the attachment service is absent or the read fails, the block degrades to
   * handle text naming the image and its read-only path when resolvable.
   */
  private async mcpImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<McpContentBlock> {
    const attachments = this.ctx.get('attachments')
    if (attachments !== undefined) {
      try {
        const stored = await attachments.readImage(ref, signal)
        return {
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        }
      } catch {
        // Byte reads verify content integrity, so a failure degrades to the
        // same handle text a missing service would produce.
      }
    }
    return { type: 'text', text: this.imageText(ref) }
  }

  /** Handle text for an image whose bytes did not cross the transport. */
  private imageText(ref: ImageAttachmentRef): string {
    const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
    const identity = `image ${ref.name === undefined ? '' : `${JSON.stringify(ref.name)} `}(${ref.width}x${ref.height}px, ${ref.mediaType}, sha256:${digest})`
    let path: string | undefined
    try {
      path = this.ctx.get('attachments')?.imageHostPath(ref)
    } catch {
      // The host path is best-effort context for the handle text; an
      // unreadable reference degrades to the bytes-unavailable wording.
      path = undefined
    }
    return path === undefined
      ? `[${identity}: bytes unavailable through this bridge]`
      : `[${identity}: read-only copy saved at ${JSON.stringify(path)}]`
  }

  /** The model-facing handle text for one file attachment. */
  private fileText(ref: Parameters<typeof fileHandleText>[0]): string {
    let path: string | undefined
    try {
      path = this.ctx.get('attachments')?.fileHostPath(ref)
    } catch {
      // Same best-effort rule as imageText: the file's handle text carries no
      // path when the store cannot resolve one.
      path = undefined
    }
    return fileHandleText(ref, path)
  }

  /** Bind the shared listener once; concurrent openers share the attempt. */
  private async ensureListening(): Promise<void> {
    if (this.boundAddress !== undefined) return
    if (this.listening === undefined) {
      const starting = this.listen()
      this.listening = starting
      // The field is only assigned under the `undefined` check, so this catch
      // can never clear a newer attempt — it re-opens the bind for retries.
      void starting.catch(() => { this.listening = undefined })
    }
    await this.listening
  }

  /** Create the shared HTTP server and bind it to the configured loopback socket. */
  private async listen(): Promise<void> {
    const server = createServer((request, response) => {
      /* v8 ignore start -- toNodeHandler converts handler failures into a 500
         response itself; this catch only sees socket-level write failures */
      this.serve(request, response).catch((error: unknown) => {
        this.ctx.logger.warn(`agentToolBridge: request failed: ${errorChain(error)}`)
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
      /* v8 ignore stop */
    })
    const bound = Promise.withResolvers<void>()
    const onListenError = (error: Error): void => { bound.reject(error) }
    server.once('error', onListenError)
    server.listen(this.config.port ?? 0, this.config.host ?? '127.0.0.1', () => {
      server.removeListener('error', onListenError)
      /* v8 ignore next 4 -- a bound loopback listener reports no later error a spec can force */
      server.on('error', (error) => {
        this.ctx.logger.warn(`agentToolBridge: listener error: ${errorChain(error)}`)
      })
      bound.resolve()
    })
    await bound.promise
    const address = server.address()
    /* v8 ignore start -- a TCP listener that resolved its listen callback always reports an AddressInfo */
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('agentToolBridge: listener has no TCP address')
    }
    /* v8 ignore stop */
    this.server = server
    this.boundAddress = {
      // The endpoint URL embeds this host verbatim; IPv6 literals need
      // brackets and `localhost` resolves to whichever loopback it bound.
      host: address.address.includes(':') ? `[${address.address}]` : address.address,
      port: address.port,
    }
  }

  /** Check Host/Origin, authenticate one request, and dispatch to its endpoint's handler. */
  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Loopback binding is the exposure control; the SDK guards reject
    // DNS-rebinding Host headers and cross-origin browser posts before the
    // bearer check, which remains the request's real authentication.
    if (!this.hostGuard(request, response) || !this.originGuard(request, response)) return
    const endpoint = this.authorize(request.headers.authorization)
    if (endpoint === undefined) {
      response.writeHead(401, { 'www-authenticate': 'Bearer realm="dsh-agent-tool-bridge"' })
      response.end()
      return
    }
    await endpoint.nodeHandler(request as NodeIncomingMessageLike, response)
  }

  /** Resolve the live endpoint a bearer token opens, or undefined. */
  private authorize(header: string | undefined): Endpoint | undefined {
    const presented = bearerToken(header)
    if (presented === undefined) return undefined
    for (const endpoint of this.endpoints) {
      if (presented.length === endpoint.credential.length && timingSafeEqual(presented, endpoint.credential)) {
        return endpoint
      }
    }
    return undefined
  }

  /** Revoke and tear down one endpoint; idempotent. */
  private async closeEndpoint(endpoint: Endpoint): Promise<void> {
    if (endpoint.closed) return
    endpoint.closed = true
    this.endpoints.delete(endpoint)
    endpoint.controller.abort()
    await endpoint.handler.close()
  }

  /** Revoke every endpoint serving `agent`. */
  private async closeAgentEndpoints(agent: Agent): Promise<void> {
    for (const endpoint of [...this.endpoints]) {
      if (endpoint.agent === agent) await this.closeEndpoint(endpoint)
    }
  }
}

export default AgentToolBridge

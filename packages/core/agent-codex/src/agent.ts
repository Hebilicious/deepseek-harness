/**
 * Codex session driver: one {@link ExternalAgent} bound to one Codex thread on
 * its instance's app-server connection. Owns the thread lifecycle
 * (start/resume/unsubscribe), turn driving (`turn/start` → `turn/completed`),
 * live steering and injection, item→session-event projection, approval /
 * question routing into the DSH seams, and the `agentToolBridge` MCP endpoint
 * that exposes the session's dsh tools to the thread.
 *
 * @module @deepseek-ai/dsh-agent-codex/agent
 */

import type {
  AgentCancelCause,
  AgentHarness,
  AgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { AssistantStreamAttempt } from '@deepseek-ai/dsh-agent-external'
import {
  ExternalAgent,
  type ExternalTurnDrive,
  HARNESS_DEFAULT_MODEL,
  raceAbort,
} from '@deepseek-ai/dsh-agent-external'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  errorChain,
  fileHandleText,
  textOnlyImageText,
  type ContentBlock,
  type ToolCallId,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-agent-tool-bridge'
import type { BridgeMcpEndpoint } from '@deepseek-ai/dsh-agent-tool-bridge/types'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import type { Session, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CodexAppServerConnection } from './connection.ts'
import {
  CODEX_TERMINAL_TURN_STATUSES,
  CodexRequestRefused,
  codexObject,
  codexString,
  codexTurnFailureInfo,
  type JsonObject,
} from './protocol.ts'
import { CODEX_PREFIX, type CodexAppServerRuntime, type CodexThreadPeer } from './runtime.ts'
import { codexThreadOf } from './thread-state.ts'

/** Per-driver deployment defaults the session's durable knobs override. */
export interface CodexAgentConfig {
  /** Identity this instance's host registered in `ctx.agents`; its id is also the catalog route. */
  readonly harness: AgentHarness
  /** Filesystem sandbox when the session logs no `sandbox/mode` override. */
  readonly sandbox: SandboxMode
  /** Approval routing when the session logs no `approval/policy` override. */
  readonly approval: 'ask' | 'never'
  /** `networkAccess` member of the structured `sandboxPolicy` overrides. */
  readonly networkAccess: boolean
  /** Deployment default model, beneath the session's `model/selection`. */
  readonly model?: string
  /** Deployment default reasoning effort, beneath the session's selection. */
  readonly reasoningEffort?: string
  /** API-key login for unattended deployments, invoked at most once per bind while signed out. */
  readonly loginWithApiKey?: () => Promise<void>
}

/** One agentMessage item's open assistant stream bookkeeping. */
interface TrackedMessage {
  readonly attempt: AssistantStreamAttempt
  /** Block index of this attempt's text block. */
  readonly textIndex: number
  /** Item-text characters earlier settled attempts of this item committed. */
  readonly prefix: number
  /** Delta characters streamed into this attempt's text block. */
  emitted: number
}

/** One in-flight harness turn's driver-side tracking state. */
interface ActiveTurn {
  readonly drive: ExternalTurnDrive
  /** Resolves with the decoded `turn/completed` `turn` member. */
  readonly completion: PromiseWithResolvers<JsonObject>
  /** Resolves when `turn/started` or the `turn/start` response commits the id; never settles otherwise. */
  readonly turnIdReady: PromiseWithResolvers<string>
  /** Committed Codex turn id once `turn/started` or the `turn/start` response supplied it. */
  turnId?: string
  /** Provisional id observed on a notification before commitment. */
  pendingTurnId?: string
  /** Turn-scoped notifications buffered while the turn id is still provisional. */
  readonly early: Array<{ method: string; params: JsonObject }>
  /** Reasoning item texts completed since the last assistant message. */
  readonly pendingReasoning: string[]
  /** Open assistant streams keyed by agentMessage item id. */
  readonly attempts: Map<string, TrackedMessage>
  /** Item ids that already have a `tool/call` committed and await their result. */
  readonly openToolItems: Set<string>
  /** Set once the terminal frame settled `completion`, or the drive ended. */
  settled: boolean
  /** The effective model this turn was started with, recorded on the committed message. */
  model: string
}

/** The resolved model/effort carried on Codex calls; empty members omit the field. */
interface CodexRoute {
  readonly provider: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** Bind-time thread settings shared by `thread/start` and `thread/resume`. */
interface ThreadRequest {
  readonly cwd: string | undefined
  readonly permission: { sandbox: SandboxMode; approvalPolicy: 'on-request' | 'never' }
  readonly selection: CodexRoute
  /** `config` overrides carrying the tool-bridge MCP server, when the bridge is mounted. */
  readonly config: JsonObject | undefined
}

/**
 * The `thread/start` and `thread/resume` members that carry the same bind-time
 * settings; the request-specific members stay at each call site.
 * @param request - resolved bind-time thread settings.
 * @returns the shared wire params.
 */
function threadRequestParams(request: ThreadRequest): JsonObject {
  return {
    ...request.cwd === undefined ? {} : { cwd: request.cwd },
    sandbox: request.permission.sandbox,
    approvalPolicy: request.permission.approvalPolicy,
    ...request.selection.model === undefined ? {} : { model: request.selection.model },
    ...request.config === undefined ? {} : { config: request.config },
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read one optional wire string array. Codex sends `reasoning.summary` and
 * `reasoning.content` as string arrays; a non-array member stands in for the
 * empty array so a partial item folds no reasoning text.
 * @param value - decoded frame member.
 * @returns the string entries in wire order.
 */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Whether a `thread/resume` rejection means the recorded thread has no
 * rollout on disk. Codex 0.153.4 answers `-32600 no rollout found for thread
 * id ...` for a valid id it never stored, while a malformed recorded id draws
 * `-32600 invalid session id: ...`; the message is therefore part of the
 * match, and every other refusal stays fatal to the bind.
 * @param error - the rejection from `thread/resume`.
 * @returns `true` only for the missing-rollout refusal.
 */
function isMissingRollout(error: unknown): boolean {
  return error instanceof JsonRpcResponseError
    && error.code === -32600
    && /no rollout found/i.test(error.message)
}

/**
 * Agent whose turns run on a Codex app-server thread. The instance's
 * {@link CodexAppServerRuntime} owns the process and connection; this class
 * owns exactly one thread on it.
 */
export class CodexAgent extends ExternalAgent implements CodexThreadPeer {
  private threadId: string | undefined
  private detachThread: (() => void) | undefined
  private connection: CodexAppServerConnection | undefined
  /** This agent's tool-bridge endpoint while the Codex thread is bound. */
  private bridgeEndpoint: BridgeMcpEndpoint | undefined
  private active: ActiveTurn | undefined
  /** Last turn retired by settlement, still able to supply its id to a late `turn/started`. */
  private retired: ActiveTurn | undefined
  /** Model/effort reported by `thread/start` or `thread/resume`. */
  private boundRoute: { model?: string; reasoningEffort?: string } = {}

  constructor(
    hostCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    private readonly runtime: CodexAppServerRuntime,
    private readonly driverConfig: CodexAgentConfig,
  ) {
    super(hostCtx, id, options, session)
  }

  // ---- ExternalAgent harness surface ----

  /**
   * Join the instance's app-server, prove the account is authenticated,
   * then resume the recorded thread or start a fresh durable one. Runs
   * unpublished: any rejection rolls the whole create/resume back.
   * @param signal - fused caller/lifecycle cancellation.
   */
  async bind(signal: AbortSignal): Promise<void> {
    const connection = await this.runtime.connect(signal)
    this.connection = connection
    const account = await this.runtime.readAccount(signal)
    if (!account.authenticated && account.requiresOpenaiAuth) {
      if (this.driverConfig.loginWithApiKey !== undefined) await this.driverConfig.loginWithApiKey()
      const after = await this.runtime.readAccount(signal)
      if (!after.authenticated && after.requiresOpenaiAuth) {
        throw new Error(
          `${CODEX_PREFIX}: Codex is not authenticated; sign in through the settings panel or run \`codex login\``,
        )
      }
    }
    const request = {
      cwd: this.session.header.cwd,
      permission: this.effectivePermissions(),
      selection: this.effectiveSelection(),
      config: await this.openToolBridge(),
    }
    try {
      const recorded = codexThreadOf(this.ctx.sessionProjections, this.session)
      // The durable binding is appended at bind time, so a session that was
      // created and never prompted owns a thread with no rollout on disk; that
      // thread cannot be resumed and is replaced by a fresh one.
      const resumed = recorded === undefined
        ? undefined
        : await this.resumeThread(connection, recorded, request, signal)
      const threadId = resumed ?? await this.startThread(connection, request, signal)
      this.detachThread = this.runtime.registerThread(threadId, this)
    } catch (error: unknown) {
      // A rolled-back bind never announces the agent, so no agent/disposed
      // arrives to revoke the endpoint; close it here.
      await this.closeBridgeEndpoint()
      throw error
    }
  }

  /**
   * Open this agent's tool-bridge endpoint when the deployment mounts the
   * `agentToolBridge` service, and shape it as the `config` overrides both
   * `thread/start` and `thread/resume` accept: one `mcp_servers.<name>` entry
   * whose `http_headers` carry the endpoint's bearer credential. Codex
   * resolves config overrides per thread request, so the fresh credential a
   * rebind mints reaches a resumed thread — `thread/resume` carries no
   * `dynamicTools` member, so the endpoint rides the `config` override both
   * requests accept rather than `thread/start.dynamicTools`.
   * @returns the `config` member for the thread requests, or undefined.
   */
  private async openToolBridge(): Promise<JsonObject | undefined> {
    const bridge = this.ctx.get('agentToolBridge')
    if (bridge === undefined) return undefined
    const endpoint = await bridge.openMcpEndpoint(this)
    this.bridgeEndpoint = endpoint
    const headers: JsonObject = {}
    for (const { name, value } of endpoint.headers) headers[name] = value
    return {
      [`mcp_servers.${endpoint.name}.url`]: endpoint.url,
      [`mcp_servers.${endpoint.name}.http_headers`]: headers,
    }
  }

  /**
   * Revoke this agent's tool-bridge endpoint when one is open. A close
   * failure is warned rather than thrown: the endpoint is already lost, and
   * the caller's own outcome — a clean unbind or the bind error being rolled
   * back — must still report.
   */
  private async closeBridgeEndpoint(): Promise<void> {
    const endpoint = this.bridgeEndpoint
    this.bridgeEndpoint = undefined
    if (endpoint === undefined) return
    try {
      await endpoint.close()
    } catch (error: unknown) {
      this.ctx.logger.warn(`${CODEX_PREFIX}: tool-bridge endpoint close failed: ${errorChain(error)}`)
    }
  }

  /**
   * Start a fresh durable thread and append its identity once, at bind time.
   * @returns the started thread id.
   */
  private async startThread(
    connection: CodexAppServerConnection,
    request: ThreadRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const response = codexObject(
      await connection.request('thread/start', {
        ...threadRequestParams(request),
        ephemeral: false,
      }, signal),
      'thread/start response',
      CODEX_PREFIX,
    )
    const thread = codexObject(response.thread, 'thread/start thread', CODEX_PREFIX)
    const threadId = codexString(thread.id, 'thread/start thread id', CODEX_PREFIX)
    if (thread.ephemeral === true) {
      throw new Error(`${CODEX_PREFIX}: app-server created an ephemeral thread for a durable session`)
    }
    this.threadId = threadId
    this.session.append('agent-codex/thread', { threadId })
    this.captureRoute(response)
    return threadId
  }

  /**
   * Rejoin the durable thread recorded by a previous bind.
   * @returns the resumed thread id, or `undefined` when its rollout is gone
   * and the caller must start a fresh thread instead.
   */
  private async resumeThread(
    connection: CodexAppServerConnection,
    existing: string,
    request: ThreadRequest,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    let response: JsonObject
    try {
      response = codexObject(
        await connection.request('thread/resume', {
          threadId: existing,
          excludeTurns: true,
          ...threadRequestParams(request),
        }, signal),
        'thread/resume response',
        CODEX_PREFIX,
      )
    } catch (error: unknown) {
      // A caller abort is not a missing thread, and any other refusal (auth,
      // malformed recorded id, service failure) is a real failure the caller
      // must see rather than silently re-binding a fresh thread.
      if (signal.aborted || !isMissingRollout(error)) throw error
      this.ctx.logger.warn(`${CODEX_PREFIX}: thread "${existing}" has no rollout; starting a fresh thread`)
      return undefined
    }
    const thread = codexObject(response.thread, 'thread/resume thread', CODEX_PREFIX)
    const resumed = codexString(thread.id, 'thread/resume thread id', CODEX_PREFIX)
    if (resumed !== existing) {
      throw new Error(`${CODEX_PREFIX}: app-server resumed thread "${resumed}" instead of "${existing}"`)
    }
    this.threadId = existing
    this.captureRoute(response)
    return existing
  }

  /**
   * Release the thread: `thread/unsubscribe` while the shared process is
   * still live, then detach from the router. Best-effort — a dead connection
   * already released every thread it carried.
   */
  async unbind(): Promise<void> {
    const detach = this.detachThread
    const connection = this.connection
    const threadId = this.threadId
    if (detach !== undefined && connection !== undefined && threadId !== undefined) {
      try {
        await connection.request('thread/unsubscribe', { threadId })
      } catch (error: unknown) {
        this.ctx.logger.warn(`${CODEX_PREFIX}: thread/unsubscribe for "${threadId}" failed: ${errorChain(error)}`)
      }
    }
    await this.closeBridgeEndpoint()
    detach?.()
    this.detachThread = undefined
    this.connection = undefined
  }

  /**
   * Drive one Codex turn: `turn/start`, stream notifications into the
   * projector, and resolve the `turn/completed` status to a durable ending.
   * @param messages - the claimed user input, already committed durably.
   * @param drive - turn boundary, abort signal, and bound projector.
   * @returns the durable turn ending.
   */
  protected async driveTurn(
    messages: readonly UserMessage[],
    drive: ExternalTurnDrive,
  ): Promise<TurnEndReason> {
    const connection = this.connection
    const threadId = this.threadId
    /* v8 ignore next -- the host binds before any turn can be driven */
    if (connection === undefined || threadId === undefined) {
      throw new Error(`${CODEX_PREFIX}: turn without a bound thread`)
    }
    const selection = this.effectiveSelection()
    // Codex owns the model choice whenever no route resolved one; the durable
    // the route marker records that instead of logging an empty model.
    const model = selection.model ?? HARNESS_DEFAULT_MODEL
    drive.projector.noteRoute({
      provider: selection.provider,
      model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    })
    const input = this.toCodexInput(messages)
    const active: ActiveTurn = {
      drive,
      completion: Promise.withResolvers<JsonObject>(),
      turnIdReady: Promise.withResolvers<string>(),
      early: [],
      pendingReasoning: [],
      attempts: new Map(),
      openToolItems: new Set(),
      settled: false,
      model,
    }
    this.active = active
    this.retired = undefined
    // A notification the projector cannot fold rejects the completion through
    // `failed` — possibly while `turn/start` is still in flight, before the
    // race below observes it. Keep that rejection observed either way.
    void active.completion.promise.catch(() => {})
    try {
      const permission = this.effectivePermissions()
      const response = codexObject(
        await connection.request('turn/start', {
          threadId,
          input,
          ...this.clientMessageId(messages),
          approvalPolicy: permission.approvalPolicy,
          sandboxPolicy: permission.sandboxPolicy,
          ...selection.model === undefined ? {} : { model: selection.model },
          ...selection.reasoningEffort === undefined ? {} : { effort: selection.reasoningEffort },
        }, drive.signal),
        'turn/start response',
        CODEX_PREFIX,
      )
      const started = codexObject(response.turn, 'turn/start turn', CODEX_PREFIX)
      this.commitTurnId(active, codexString(started.id, 'turn/start turn id', CODEX_PREFIX))
      // `completion` resolves only on `turn/completed`; a dead child settles
      // the turn through the connection's fatal signal instead.
      const terminal = await raceAbort(
        Promise.race([active.completion.promise, connection.fatal]),
        drive.signal,
        this.id,
      )
      return this.turnEnding(terminal, drive)
    } finally {
      /* v8 ignore else -- the base runs one turn body at a time, so no later
         turn can have replaced this.active before this turn retires. */
      if (this.active === active) {
        this.active = undefined
        this.retired = active
      }
      active.settled = true
      // Tool items left open by an interrupted or failed turn still settle:
      // a dangling `tool/call` never gets its result.
      for (const itemId of active.openToolItems) {
        try {
          drive.projector.toolResult(
            itemId,
            [{ type: 'text', text: 'tool item ended without a completion' }],
            { isError: true, error: { name: 'CodexError', code: 'ITEM_INCOMPLETE' } },
          )
        } catch (error: unknown) {
          this.ctx.logger.warn(`${CODEX_PREFIX}: tool result settlement failed: ${errorChain(error)}`)
        }
      }
      active.openToolItems.clear()
      // Attempts left open by an aborted or failed turn still settle: an
      // attempt with visible content commits its interrupted prefix as an
      // assistant/message; an empty one records the bare attempt. An attempt
      // a tool-call advertisement already settled needs nothing further.
      for (const { attempt } of active.attempts.values()) {
        if (attempt.ended) continue
        try {
          if (attempt.interruptedBlocks().length > 0) {
            attempt.push({
              type: 'finish',
              reason: { kind: 'aborted', failure: { message: 'turn ended mid-stream', code: 'ABORTED' } },
            })
            drive.projector.commitAssistant(attempt, {
              provider: this.driverConfig.harness.id,
              model: active.model,
            }, { interrupted: true })
          } else {
            drive.projector.commitAttempt(attempt)
          }
        } catch (error: unknown) {
          this.ctx.logger.warn(`${CODEX_PREFIX}: assistant settlement failed: ${errorChain(error)}`)
        }
      }
      active.attempts.clear()
      // Reasoning items left unfolded by a turn that ended without a closing
      // agentMessage still commit as one reasoning-only assistant message.
      if (active.pendingReasoning.length > 0) {
        try {
          const attempt = drive.projector.beginAssistant()
          active.pendingReasoning.forEach((text, index) => {
            attempt.push({ type: 'block-start', index, blockType: 'reasoning' })
            attempt.push({ type: 'reasoning-delta', index, text })
            attempt.push({ type: 'block-end', index, block: { type: 'reasoning', text } })
          })
          attempt.push({ type: 'finish', reason: { kind: 'stop' } })
          drive.projector.commitAssistant(attempt, {
            provider: this.driverConfig.harness.id,
            model: active.model,
          })
        } catch (error: unknown) {
          this.ctx.logger.warn(`${CODEX_PREFIX}: trailing reasoning settlement failed: ${errorChain(error)}`)
        }
      }
    }
  }

  /**
   * Steer the live Codex turn (`turn/steer` with the expected-turn
   * precondition). A steer landing while `turn/start` is still in flight
   * waits out the id commitment; a server refusal or a turn that settles
   * first leaves the message pending for the next turn.
   */
  protected async steerLive(message: UserMessage, drive: ExternalTurnDrive): Promise<boolean> {
    const connection = this.connection
    const threadId = this.threadId
    const active = this.active
    if (connection === undefined || threadId === undefined || active === undefined
      || active.drive !== drive) {
      return false
    }
    const turnId = await this.awaitTurnId(active, connection, drive.signal)
    if (turnId === undefined || this.active !== active) return false
    const input = this.toCodexInput([message])
    try {
      await connection.request('turn/steer', {
        threadId,
        input,
        clientUserMessageId: message.id,
        expectedTurnId: turnId,
      }, drive.signal)
      return true
    } catch (error: unknown) {
      if (drive.signal.aborted) return false
      this.ctx.logger.warn(`${CODEX_PREFIX}: turn/steer refused: ${errorChain(error)}`)
      return false
    }
  }

  /**
   * Deliver context to the thread's model-visible history outside the claim
   * boundary (`thread/inject_items`). Codex accepts a raw Responses-API user
   * message item.
   */
  protected override async injectHarness(message: UserMessage): Promise<boolean> {
    const connection = this.connection
    const threadId = this.threadId
    if (connection === undefined || threadId === undefined) return false
    const parts: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
      else if (block.type === 'file') {
        parts.push(fileHandleText(block.attachment, this.attachmentHostPath(block)))
      } else if (block.type === 'image') {
        const path = this.attachmentHostPath(block)
        parts.push(path === undefined
          ? textOnlyImageText(block.attachment)
          : fileHandleText({ attachmentId: block.attachment.attachmentId, name: block.attachment.name ?? 'image', bytes: block.attachment.bytes }, path))
      }
    }
    const text = parts.join('\n')
    if (text.length === 0) return false
    try {
      await connection.request('thread/inject_items', {
        threadId,
        items: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        }],
      })
      return true
    } catch (error: unknown) {
      this.ctx.logger.warn(`${CODEX_PREFIX}: thread/inject_items refused: ${errorChain(error)}`)
      return false
    }
  }

  /**
   * Interrupt the live Codex turn (`turn/interrupt`). Best-effort: local
   * settlement stays authoritative when the child no longer answers. An
   * interrupt landing while `turn/start` is still in flight waits out the
   * id commitment — the aborted request no longer supplies it, but the
   * server's `turn/started` does.
   */
  protected async interruptTurn(drive: ExternalTurnDrive): Promise<void> {
    const connection = this.connection
    const threadId = this.threadId
    const owner = this.active?.drive === drive ? this.active : this.retired
    /* v8 ignore if -- a live drive's abort listener always resolves to the
       active or the just-retired turn, and unbind clears the binding only after
       driver quiescence, so neither refusal arm can run */
    if (connection === undefined || threadId === undefined || owner?.drive !== drive) return
    const turnId = await this.awaitTurnId(owner, connection)
    if (turnId === undefined) return
    await connection.request('turn/interrupt', { threadId, turnId })
  }

  /**
   * The committed turn id, the latched provisional id, or the id awaited
   * while `turn/start` is in flight; `undefined` once the turn settles or
   * the connection dies first. `signal` bounds only the wait: the drive's
   * abort makes a pending steer moot, while `interruptTurn` — invoked by
   * that abort — passes none so the wait can still complete.
   */
  private awaitTurnId(
    active: ActiveTurn,
    connection: CodexAppServerConnection,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const known = active.turnId ?? active.pendingTurnId
    if (known !== undefined) return Promise.resolve(known)
    const pending = Promise.race<string | undefined>([
      active.turnIdReady.promise,
      active.completion.promise.then(() => undefined, () => undefined),
      // The connection's fatal promise only ever rejects, so its loss resolves
      // this wait without a fulfilling arm.
      connection.fatal.catch(() => undefined),
    ])
    if (signal === undefined) return pending
    return raceAbort(pending, signal, this.id).then(
      id => id,
      (error: unknown) => {
        /* v8 ignore else -- raceAbort rejects only after this signal aborted,
           so the propagate arm cannot run */
        if (signal.aborted) return undefined
        /* v8 ignore next -- see the arm above: no non-abort rejection exists */
        throw error
      },
    )
  }

  // ---- CodexThreadPeer (thread-scoped dispatch from the shared router) ----

  /**
   * Report a failure raised while consuming this thread's notification. The
   * failure ends this thread's live turn and reaches the agent's error
   * channel; the shared connection keeps serving every other thread.
   * @param error - the failure this agent's notification dispatch raised.
   */
  failed(error: Error): void {
    const active = this.active
    // A live turn that has not seen its terminal frame owns the failure:
    // rejecting the completion ends the turn as an error, which reports once
    // at the turn/step boundary. A settled turn has no drive left to fail.
    if (active !== undefined && !active.settled) {
      active.settled = true
      active.completion.reject(error)
      return
    }
    /* v8 ignore next -- the host registers the turnBoundary unit for every
       agent session this runtime serves, so the optional read always resolves */
    const turn = this.hostCtx.sessionProjections.stateOf(this.session, 'turnBoundary')?.lastTurn ?? 0
    this.dispatch.emit('agent/error', { turn, step: 0, error })
  }

  /**
   * Consume one notification addressed to this agent's thread. Turn-scoped
   * methods validate against the live drive; thread-scoped ones update
   * bookkeeping. A throw is scoped to this thread: the router reports it
   * through {@link failed} and keeps the shared connection alive.
   */
  notification(method: string, params: JsonObject): void {
    const active = this.active
    switch (method) {
      case 'turn/started': {
        // A `turn/started` landing after local settlement still commits the
        // retired turn's id so a queued `turn/interrupt` can address it.
        const target = active ?? this.retired
        if (target === undefined) return
        const turn = codexObject(params.turn, 'turn/started turn', CODEX_PREFIX)
        this.commitTurnId(target, codexString(turn.id, 'turn/started turn id', CODEX_PREFIX))
        return
      }
      case 'turn/completed':
        this.routeTurnFrame(active, method, params, () => {
          const turn = codexObject(params.turn, 'turn/completed turn', CODEX_PREFIX)
          return codexString(turn.id, 'turn/completed turn id', CODEX_PREFIX)
        })
        return
      case 'turn/diff/updated':
      case 'turn/plan/updated':
      case 'turn/moderation/metadata':
        // Live progress mirrors; the completed items carry the durable content.
        return
      case 'item/started':
      case 'item/completed':
      case 'item/agentMessage/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'item/fileChange/patchUpdated':
      case 'item/mcpToolCall/progress':
      case 'item/autoApprovalReview/started':
      case 'item/autoApprovalReview/completed':
        this.routeTurnFrame(active, method, params, () =>
          codexString(params.turnId, `${method} turn id`, CODEX_PREFIX))
        return
      default:
        // Thread-scoped lifecycle and unrelated notifications need no
        // projection: the session transcript is event-driven, and Codex
        // lifecycle notices (name/status/archive) have no DSH counterpart.
        return
    }
  }

  /**
   * Answer one server→client request for this agent's thread: approvals route
   * to the DSH approval seam and interactive input to the user-questions seam.
   * `item/tool/call` stays refused: bridged tools reach the thread as an MCP
   * server, so no `dynamicTools` are ever declared for it to invoke.
   */
  async request(method: string, params: JsonObject): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.decideApproval(params, 'shell')
      case 'item/fileChange/requestApproval':
        return this.decideApproval(params, 'apply_patch')
      case 'item/permissions/requestApproval':
        return this.decidePermissions(params)
      case 'item/tool/requestUserInput':
        return this.answerUserInput(params)
      case 'mcpServer/elicitation/request':
        return this.answerElicitation(params)
      default:
        throw new CodexRequestRefused(
          `${CODEX_PREFIX}: unsupported app-server request ${JSON.stringify(method)}`,
        )
    }
  }

  // ---- turn association ----

  /**
   * Route one turn-scoped notification. A committed turn id drops foreign
   * frames; a provisional one latches the first observed id and buffers the
   * frame for replay at `commitTurnId`; a conflicting provisional id is a
   * protocol violation.
   */
  private routeTurnFrame(
    active: ActiveTurn | undefined,
    method: string,
    params: JsonObject,
    turnIdOf: () => string,
  ): void {
    if (active === undefined) return
    const frameTurnId = turnIdOf()
    if (active.turnId !== undefined) {
      if (frameTurnId === active.turnId) this.dispatchTurnFrame(active, method, params)
      return
    }
    if (active.pendingTurnId !== undefined && active.pendingTurnId !== frameTurnId) {
      throw new Error(`${CODEX_PREFIX}: app-server referenced conflicting turns`)
    }
    active.pendingTurnId = frameTurnId
    active.early.push({ method, params })
  }

  /** Commit the turn id from `turn/started` or the `turn/start` response, then replay buffered frames. */
  private commitTurnId(active: ActiveTurn, id: string): void {
    if (active.pendingTurnId !== undefined && active.pendingTurnId !== id) {
      throw new Error(`${CODEX_PREFIX}: turn/start response did not match the active turn`)
    }
    if (active.turnId === id) return
    active.turnId = id
    active.turnIdReady.resolve(id)
    // A retired turn has no live projection to replay buffered frames into.
    if (active !== this.active) return
    for (const frame of active.early.splice(0)) {
      this.dispatchTurnFrame(active, frame.method, frame.params)
    }
  }

  /** Route one committed turn-scoped frame to its projection or settlement. */
  private dispatchTurnFrame(active: ActiveTurn, method: string, params: JsonObject): void {
    if (method === 'turn/completed') {
      const turn = codexObject(params.turn, 'turn/completed turn', CODEX_PREFIX)
      if (!CODEX_TERMINAL_TURN_STATUSES.includes(turn.status as never)) {
        throw new Error(`${CODEX_PREFIX}: app-server returned invalid terminal turn status ${String(turn.status)}`)
      }
      active.settled = true
      active.completion.resolve(turn)
      return
    }
    this.itemFrame(active, method, params)
  }

  /** Route one committed item-scoped notification to its projection. */
  private itemFrame(active: ActiveTurn, method: string, params: JsonObject): void {
    switch (method) {
      case 'item/started':
        this.itemStarted(active, codexObject(params.item, 'item/started item', CODEX_PREFIX))
        return
      case 'item/completed':
        this.itemCompleted(active, codexObject(params.item, 'item/completed item', CODEX_PREFIX))
        return
      case 'item/agentMessage/delta': {
        const itemId = codexString(params.itemId, 'agentMessage delta item id', CODEX_PREFIX)
        const delta = codexString(params.delta, 'agentMessage delta', CODEX_PREFIX)
        const tracked = this.ensureAttempt(active, itemId)
        tracked.attempt.push({ type: 'text-delta', index: tracked.textIndex, text: delta })
        tracked.emitted += delta.length
        return
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        // Reasoning items complete as whole items; deltas only feed live
        // rendering, and the completed fold carries the full text.
        return
      }
      default:
        // Progress mirrors (command output deltas, patch updates, MCP
        // progress, auto-review) are live-only; completed items carry the
        // durable content.
        return
    }
  }

  // ---- item projection ----

  /**
   * Open the assistant stream for one agentMessage item, folding buffered
   * reasoning first. An entry whose attempt a tool-call advertisement already
   * settled is replaced: the item's deltas continue on a fresh attempt whose
   * `prefix` skips the text the settled attempt committed.
   */
  private ensureAttempt(
    active: ActiveTurn,
    itemId: string,
  ): TrackedMessage {
    const tracked = active.attempts.get(itemId)
    if (tracked !== undefined && !tracked.attempt.ended) return tracked
    const attempt = active.drive.projector.beginAssistant()
    let index = 0
    for (const text of active.pendingReasoning.splice(0)) {
      attempt.push({ type: 'block-start', index, blockType: 'reasoning' })
      attempt.push({ type: 'reasoning-delta', index, text })
      attempt.push({ type: 'block-end', index, block: { type: 'reasoning', text } })
      index += 1
    }
    attempt.push({ type: 'block-start', index, blockType: 'text' })
    const entry: TrackedMessage = {
      attempt,
      textIndex: index,
      prefix: tracked === undefined ? 0 : tracked.prefix + tracked.emitted,
      emitted: 0,
    }
    active.attempts.set(itemId, entry)
    return entry
  }

  /**
   * `item/started`: open assistant streams for text items; commit `tool/call`
   * for tool items. An item joins `openToolItems` only once its `tool/call`
   * committed, so a failed projection cannot settle a result for a call that
   * never logged.
   */
  private itemStarted(active: ActiveTurn, item: JsonObject): void {
    const type = item.type
    const id = codexString(item.id, `${String(type)} item id`, CODEX_PREFIX)
    switch (type) {
      case 'agentMessage':
        this.ensureAttempt(active, id)
        return
      case 'userMessage':
      case 'hookPrompt':
        // Echoes of already-durable user input and Codex-internal prompt
        // fragments carry nothing new to project.
        return
      case 'commandExecution': {
        const command = optionalString(item.command) ?? ''
        active.drive.projector.toolCall(id, 'shell', JSON.stringify({
          command,
          ...optionalString(item.cwd) === undefined ? {} : { cwd: item.cwd },
        }))
        active.openToolItems.add(id)
        return
      }
      case 'fileChange': {
        active.drive.projector.toolCall(id, 'apply_patch', JSON.stringify({
          changes: item.changes ?? [],
        }))
        active.openToolItems.add(id)
        return
      }
      case 'mcpToolCall': {
        const server = optionalString(item.server) ?? 'unknown'
        const tool = optionalString(item.tool) ?? 'unknown'
        active.drive.projector.toolCall(id, `mcp__${server}__${tool}`, JSON.stringify(item.arguments ?? {}))
        active.openToolItems.add(id)
        return
      }
      case 'dynamicToolCall': {
        const tool = optionalString(item.tool) ?? 'unknown'
        const namespace = optionalString(item.namespace)
        active.drive.projector.toolCall(
          id,
          namespace === undefined ? tool : `${namespace}.${tool}`,
          JSON.stringify(item.arguments ?? {}),
        )
        active.openToolItems.add(id)
        return
      }
      case 'collabAgentToolCall': {
        const tool = optionalString(item.tool) ?? 'unknown'
        active.drive.projector.toolCall(id, `collab_${tool}`, JSON.stringify({
          ...optionalString(item.prompt) === undefined ? {} : { prompt: item.prompt },
          ...optionalString(item.model) === undefined ? {} : { model: item.model },
        }))
        active.openToolItems.add(id)
        return
      }
      case 'webSearch': {
        active.drive.projector.toolCall(id, 'web_search', JSON.stringify({
          ...optionalString(item.query) === undefined ? {} : { query: item.query },
        }))
        active.openToolItems.add(id)
        return
      }
      case 'imageGeneration': {
        active.drive.projector.toolCall(id, 'image_generation', '{}')
        active.openToolItems.add(id)
        return
      }
      case 'plan': {
        active.drive.projector.toolCall(id, 'update_plan', JSON.stringify({
          ...optionalString(item.text) === undefined ? {} : { plan: item.text },
        }))
        active.openToolItems.add(id)
        return
      }
      case 'reasoning':
      case 'functionCallOutput':
        // Reasoning folds into the next assistant message at completion; a
        // bare functionCallOutput pairs with a call the app-server already
        // reported through its tool item.
        return
      default:
        // Merge-extensible item union: unrecognized items fall back to a
        // generic tool card so nothing model-visible goes unlogged.
        active.drive.projector.toolCall(id, `codex_${String(type)}`, JSON.stringify(item))
        active.openToolItems.add(id)
    }
  }

  /** `item/completed`: settle streams, fold reasoning, and commit `tool/result` pairs. */
  private itemCompleted(active: ActiveTurn, item: JsonObject): void {
    const type = item.type
    const id = codexString(item.id, `${String(type)} item id`, CODEX_PREFIX)
    switch (type) {
      case 'agentMessage': {
        const text = optionalString(item.text) ?? ''
        // A completion without a streamed `item/started` still opens an
        // attempt so completed reasoning items fold into the same message.
        const tracked = this.ensureAttempt(active, id)
        // The completion's text is the whole item's; a mid-stream tool-call
        // advertisement already committed the `prefix` share, so this attempt
        // claims only the remainder. A continuation that adds nothing at all
        // settles as a bare attempt rather than an empty assistant/message.
        const remainder = text.slice(tracked.prefix)
        const silent = tracked.prefix > 0
          && remainder === ''
          && tracked.attempt.blocks().every(block => block.type === 'text' && block.text === '')
        if (silent) {
          active.drive.projector.commitAttempt(tracked.attempt)
        } else {
          tracked.attempt.push({
            type: 'block-end',
            index: tracked.textIndex,
            block: { type: 'text', text: remainder },
          })
          tracked.attempt.push({ type: 'finish', reason: { kind: 'stop' } })
          active.drive.projector.commitAssistant(tracked.attempt, {
            provider: this.driverConfig.harness.id,
            model: active.model,
          })
        }
        active.attempts.delete(id)
        return
      }
      case 'reasoning': {
        const parts = [
          ...stringList(item.summary),
          ...stringList(item.content),
        ]
        const combined = parts.join('\n')
        if (combined.length > 0) active.pendingReasoning.push(combined)
        return
      }
      case 'commandExecution': {
        if (!active.openToolItems.delete(id)) return
        const status = optionalString(item.status) ?? 'completed'
        const output = optionalString(item.aggregatedOutput) ?? ''
        active.drive.projector.toolResult(id, [{ type: 'text', text: output }], {
          isError: status !== 'completed',
          ...status === 'completed' ? {} : { error: { name: 'CodexError', code: 'COMMAND_EXECUTION' } },
          meta: this.commandMeta(item),
        })
        return
      }
      case 'fileChange': {
        if (!active.openToolItems.delete(id)) return
        const status = optionalString(item.status) ?? 'completed'
        const changes = Array.isArray(item.changes) ? item.changes : []
        active.drive.projector.toolResult(id, [{ type: 'text', text: this.fileChangeText(changes, status) }], {
          isError: status !== 'completed',
          ...status === 'completed' ? {} : { error: { name: 'CodexError', code: 'FILE_CHANGE' } },
          meta: { diffs: this.fileDiffs(changes) } as unknown as JsonValue,
        })
        return
      }
      case 'mcpToolCall': {
        if (!active.openToolItems.delete(id)) return
        const status = optionalString(item.status) ?? 'completed'
        const error = item.error !== null && typeof item.error === 'object'
          ? optionalString((item.error as JsonObject).message)
          : undefined
        active.drive.projector.toolResult(id, this.mcpResultContent(item), {
          isError: status !== 'completed' || error !== undefined,
          ...status !== 'completed' || error !== undefined
            ? { error: { name: 'CodexError', code: 'MCP_TOOL_CALL' } }
            : {},
        })
        return
      }
      case 'dynamicToolCall': {
        if (!active.openToolItems.delete(id)) return
        const status = optionalString(item.status) ?? 'completed'
        const success = item.success !== false
        active.drive.projector.toolResult(id, this.dynamicToolContent(item), {
          isError: status !== 'completed' || !success,
          ...status !== 'completed' || !success
            ? { error: { name: 'CodexError', code: 'DYNAMIC_TOOL_CALL' } }
            : {},
        })
        return
      }
      case 'collabAgentToolCall':
      case 'webSearch':
      case 'imageGeneration':
      case 'plan': {
        if (!active.openToolItems.delete(id)) return
        const failed = item.status !== undefined && item.status !== 'completed'
          || item.failure !== null && item.failure !== undefined
        active.drive.projector.toolResult(id, [{ type: 'text', text: this.genericItemResult(item) }], {
          isError: failed,
          ...failed ? { error: { name: 'CodexError', code: 'ITEM_FAILED' } } : {},
        })
        return
      }
      default: {
        if (!active.openToolItems.delete(id)) return
        active.drive.projector.toolResult(id, [{ type: 'text', text: JSON.stringify(item) }], {})
      }
    }
  }

  // ---- approvals and questions ----

  /**
   * Route one Codex approval request through the DSH approval seam and map
   * the outcome onto the request's decision vocabulary.
   */
  private async decideApproval(params: JsonObject, toolName: string): Promise<unknown> {
    const active = this.active
    const approval = this.ctx.get('approval')
    if (approval === undefined || active === undefined) {
      return { decision: 'decline' }
    }
    const itemId = optionalString(params.itemId)
    const reason = optionalString(params.reason)
      ?? optionalString(params.command)
      ?? 'Codex requested approval'
    const outcome = await approval.request({
      agent: this,
      toolName,
      ...itemId === undefined ? {} : { callId: brandString<ToolCallId>(itemId) },
      reason,
      signal: active.drive.signal,
    })
    const decision = outcome === 'allowed-once'
      ? 'accept'
      : outcome === 'cancelled' ? 'cancel' : 'decline'
    return { decision: this.pickAvailableDecision(params, decision) }
  }

  /**
   * Route a permissions-grant request through the approval seam: an
   * allowed-once grant echoes the requested profile back scoped to the turn;
   * anything else grants nothing.
   */
  private async decidePermissions(params: JsonObject): Promise<unknown> {
    const active = this.active
    const approval = this.ctx.get('approval')
    if (approval === undefined || active === undefined) {
      return { permissions: {}, scope: 'turn' }
    }
    const reason = optionalString(params.reason) ?? 'Codex requested additional permissions'
    const outcome = await approval.request({
      agent: this,
      toolName: 'permissions',
      reason,
      signal: active.drive.signal,
    })
    if (outcome !== 'allowed-once') return { permissions: {}, scope: 'turn' }
    const requested = params.permissions !== null && typeof params.permissions === 'object'
      ? params.permissions as JsonObject
      : {}
    return {
      permissions: {
        ...requested.network === undefined || requested.network === null
          ? {}
          : { network: requested.network },
        ...requested.fileSystem === undefined || requested.fileSystem === null
          ? {}
          : { fileSystem: requested.fileSystem },
      },
      scope: 'turn',
    }
  }

  /**
   * Route a tool user-input request through the user-questions seam. Each
   * Codex question becomes one single- or multi-select question; an
   * unavailable answerer or a cancelled ask answers nothing.
   */
  private async answerUserInput(params: JsonObject): Promise<unknown> {
    const active = this.active
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined || active === undefined) return { answers: {} }
    const asked = Array.isArray(params.questions) ? params.questions : []
    const mapped = asked.flatMap((raw) => {
      const question = raw !== null && typeof raw === 'object' ? raw as JsonObject : undefined
      const id = question !== undefined ? optionalString(question.id) : undefined
      const text = question !== undefined ? optionalString(question.question) : undefined
      if (question === undefined || id === undefined || text === undefined) return []
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option) => {
          const record = option !== null && typeof option === 'object' ? option as JsonObject : undefined
          if (record === undefined) return []
          const label = optionalString(record.label)
          if (label === undefined) return []
          const description = optionalString(record.description)
          return [{ label, ...description === undefined ? {} : { description } }]
        })
        : undefined
      const header = optionalString(question.header)
      return [{
        id,
        question: text,
        ...header === undefined ? {} : { header },
        ...options !== undefined && options.length > 0 ? { options } : {},
      }]
    })
    if (mapped.length === 0) return { answers: {} }
    try {
      const answer = await questions.ask({
        questions: mapped,
        agent: this,
        signal: active.drive.signal,
      })
      const answers: JsonObject = {}
      for (const item of answer.answers) {
        const selected = [...item.selected, ...item.custom === undefined ? [] : [item.custom]]
        answers[item.id] = { answers: selected }
      }
      return { answers }
    } catch (error: unknown) {
      this.ctx.logger.warn(`${CODEX_PREFIX}: user input request declined: ${errorChain(error)}`)
      return { answers: {} }
    }
  }

  /**
   * Route an MCP elicitation through the user-questions seam when the form
   * schema is a flat object of string/enum/boolean fields; richer forms
   * decline rather than fabricate content.
   */
  private async answerElicitation(params: JsonObject): Promise<unknown> {
    const decline = { action: 'decline', content: null, _meta: null }
    const active = this.active
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined || active === undefined) return decline
    const message = optionalString(params.message) ?? 'Codex requested input'
    const schema = params.requestedSchema !== null && typeof params.requestedSchema === 'object'
      ? params.requestedSchema as JsonObject
      : undefined
    const properties = schema !== undefined && schema.properties !== null && typeof schema.properties === 'object'
      ? schema.properties as JsonObject
      : undefined
    if (schema === undefined || properties === undefined) {
      // Schema-less elicitations ask a single free-text question.
      try {
        const answer = await questions.ask({
          questions: [{ id: 'response', question: message }],
          agent: this,
          signal: active.drive.signal,
        })
        const custom = answer.answers[0]?.custom
        return custom === undefined || custom === ''
          ? decline
          : { action: 'accept', content: { response: custom }, _meta: null }
      } catch {
        return decline
      }
    }
    const fields = Object.entries(properties)
    const mapped = fields.flatMap(([key, raw]) => {
      const field = raw !== null && typeof raw === 'object' ? raw as JsonObject : undefined
      if (field === undefined) return []
      const type = field.type
      const enumValues = Array.isArray(field.enum)
        ? field.enum.flatMap(value => typeof value === 'string' ? [value] : [])
        : undefined
      if (type !== 'string' && type !== 'boolean' && type !== 'number' && enumValues === undefined) return []
      return [{
        id: key,
        question: optionalString(field.title) ?? optionalString(field.description) ?? key,
        ...enumValues !== undefined && enumValues.length > 0
          ? { options: enumValues.map(value => ({ label: value })) }
          : {},
      }]
    })
    if (mapped.length !== fields.length || mapped.length === 0) return decline
    try {
      const answer = await questions.ask({
        questions: [{ id: '__elicitation__', question: message, header: 'MCP input' }, ...mapped],
        agent: this,
        signal: active.drive.signal,
      })
      const content: JsonObject = {}
      for (const item of answer.answers) {
        if (item.id === '__elicitation__') continue
        const value = item.custom ?? item.selected[0]
        if (value !== undefined) content[item.id] = value
      }
      return { action: 'accept', content, _meta: null }
    } catch {
      return decline
    }
  }

  /** Prefer `cancel`/`decline` from the server's advertised decision list when ours is unavailable. */
  private pickAvailableDecision(params: JsonObject, preferred: string): string {
    const available = params.availableDecisions
    if (!Array.isArray(available) || available.length === 0) return preferred
    if (available.includes(preferred)) return preferred
    for (const fallback of ['decline', 'cancel', 'accept']) {
      if (available.includes(fallback)) return fallback
    }
    throw new CodexRequestRefused(`${CODEX_PREFIX}: app-server offered no usable approval decision`)
  }

  // ---- helpers ----

  /** The thread-bound route captured from a start/resume response. */
  private captureRoute(response: JsonObject): void {
    const model = optionalString(response.model)
    const effort = optionalString(response.reasoningEffort)
    this.boundRoute = {
      ...model === undefined ? {} : { model },
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
  }

  /**
   * The route Codex calls for the next turn: a session-level `model/selection`
   * for the `codex` provider wins, then the deployment's configured default,
   * then the route Codex reported at bind, then Codex's own settings.
   */
  private effectiveSelection(): CodexRoute {
    const selected = this.currentSelection()
    const picked = selected.provider === this.driverConfig.harness.id ? selected : undefined
    const model = picked?.model !== undefined && picked.model !== ''
      ? picked.model
      : this.driverConfig.model ?? this.boundRoute.model
    const effort = picked?.reasoningEffort
      ?? this.driverConfig.reasoningEffort ?? this.boundRoute.reasoningEffort
    return {
      provider: this.driverConfig.harness.id,
      ...model === undefined ? {} : { model },
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
  }

  /**
   * The session's effective permission pair for the next call: the durable
   * `sandbox/mode` and `approval/policy` overrides read through their owning
   * services, falling back to the driver config when either service or
   * override is absent.
   */
  private effectivePermissions(): {
    sandbox: SandboxMode
    approvalPolicy: 'on-request' | 'never'
    sandboxPolicy: JsonObject
  } {
    const sandbox = this.ctx.get('sandboxPolicy')?.overrideOf(this.session) ?? this.driverConfig.sandbox
    const policy = this.ctx.get('approval')?.overrideOf(this.session) ?? this.driverConfig.approval
    return {
      sandbox,
      approvalPolicy: policy === 'never' ? 'never' : 'on-request',
      sandboxPolicy: this.sandboxPolicyWire(sandbox),
    }
  }

  /** The structured `turn/start` `sandboxPolicy` member for one DSH sandbox mode. */
  private sandboxPolicyWire(sandbox: SandboxMode): JsonObject {
    switch (sandbox) {
      case 'read-only':
        return { type: 'readOnly', networkAccess: this.driverConfig.networkAccess }
      case 'workspace-write':
        return {
          type: 'workspaceWrite',
          writableRoots: this.session.header.cwd === undefined ? [] : [this.session.header.cwd],
          networkAccess: this.driverConfig.networkAccess,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        }
      case 'danger-full-access':
        return { type: 'dangerFullAccess' }
    }
  }

  /** `clientUserMessageId` mirrors the last claimed message's durable id. */
  private clientMessageId(messages: readonly UserMessage[]): JsonObject {
    const last = messages[messages.length - 1]
    /* v8 ignore next -- the base opens no turn for an empty claim, so a driven
       turn always carries at least one message; the empty arm is type-required */
    return last === undefined ? {} : { clientUserMessageId: last.id }
  }

  /**
   * The host path one attachment resolves to for the host-resident Codex
   * process. An unmounted store or an unreadable reference degrades to the
   * handle-text fallback rather than rejecting the turn.
   */
  private attachmentHostPath(block: UserMessage['content'][number]): string | undefined {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) return undefined
    try {
      if (block.type === 'image') return attachments.imageHostPath(block.attachment)
      /* v8 ignore else -- injectHarness filters to image and file blocks before
         this call, and toCodexInput throws for every other kind */
      if (block.type === 'file') return attachments.fileHostPath(block.attachment)
      /* v8 ignore next -- see the arm above: no other block kind reaches here */
      return undefined
    } catch (error: unknown) {
      this.ctx.logger.warn(`${CODEX_PREFIX}: attachment host path unavailable: ${errorChain(error)}`)
      return undefined
    }
  }

  /**
   * Project the claimed user input to Codex `UserInput` entries: text blocks
   * carry through, images resolve to `localImage` through the attachment
   * store, and files project to their deterministic handle text.
   */
  private toCodexInput(messages: readonly UserMessage[]): Array<JsonObject & { type: string }> {
    const input: Array<JsonObject & { type: string }> = []
    for (const message of messages) {
      for (const block of message.content) {
        switch (block.type) {
          case 'text':
            input.push({ type: 'text', text: block.text, text_elements: [] })
            break
          case 'image': {
            const path = this.attachmentHostPath(block)
            if (path !== undefined) input.push({ type: 'localImage', path })
            else input.push({ type: 'text', text: textOnlyImageText(block.attachment), text_elements: [] })
            break
          }
          case 'file': {
            input.push({
              type: 'text',
              text: fileHandleText(block.attachment, this.attachmentHostPath(block)),
              text_elements: [],
            })
            break
          }
          default:
            throw new Error(
              `${CODEX_PREFIX}: Codex sessions cannot forward ${JSON.stringify(block.type)} input blocks`,
            )
        }
      }
    }
    return input
  }

  /** Map the terminal `turn/completed` turn object to the durable ending. */
  private turnEnding(turn: JsonObject, drive: ExternalTurnDrive): TurnEndReason {
    switch (turn.status) {
      case 'completed':
        return { kind: 'completed' }
      case 'interrupted': {
        let reason: AgentCancelCause = { kind: 'user' }
        /* v8 ignore if -- the drive's raceAbort rejects as soon as its signal
           aborts, so a server-reported interruption only reaches a live drive */
        if (drive.signal.aborted) reason = drive.signal.reason as AgentCancelCause
        return { kind: 'aborted', reason }
      }
      case 'failed': {
        const info = codexTurnFailureInfo(turn)
        if (info.maxTokens === true) return { kind: 'max-tokens' }
        const error = turn.error !== null && typeof turn.error === 'object'
          ? turn.error as JsonObject
          : undefined
        const message = error !== undefined ? optionalString(error.message) : undefined
        return {
          kind: 'error',
          error: {
            message: message ?? `Codex turn failed (${info.category})`,
            code: `CODEX_${info.category.toUpperCase().replaceAll('-', '_')}`,
          },
        }
      }
      /* v8 ignore next -- closed-union guard: dispatchTurnFrame validated the
         terminal status against CODEX_TERMINAL_TURN_STATUSES before settling */
      default:
        throw new Error(`${CODEX_PREFIX}: app-server returned invalid terminal turn status ${String(turn.status)}`)
    }
  }

  /** `tool/result.meta` for a completed command execution: the card payload. */
  private commandMeta(item: JsonObject): JsonValue {
    return {
      command: optionalString(item.command) ?? '',
      ...optionalString(item.cwd) === undefined ? {} : { cwd: item.cwd as string },
      ...typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {},
      ...typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {},
    }
  }

  /** Model-facing result text for a file change item. */
  private fileChangeText(changes: readonly unknown[], status: string): string {
    const paths = changes.flatMap((change) => {
      const record = change !== null && typeof change === 'object' ? change as JsonObject : undefined
      const path = record !== undefined ? optionalString(record.path) : undefined
      return path === undefined ? [] : [path]
    })
    const summary = paths.length === 0 ? 'file change' : `file change: ${paths.join(', ')}`
    return status === 'completed' ? summary : `${summary} (${status})`
  }

  /**
   * `tool/result.meta` diff hunks in the `dsh-tool-fs` card shape
   * (`{diffs: FileDiff[]}`) so the existing file-change card renders Codex
   * patches without a new presenter.
   */
  private fileDiffs(changes: readonly unknown[]): Array<{ path: string; oldText: string | null; newText: string }> {
    const diffs: Array<{ path: string; oldText: string | null; newText: string }> = []
    for (const change of changes) {
      const record = change !== null && typeof change === 'object' ? change as JsonObject : undefined
      const path = record !== undefined ? optionalString(record.path) : undefined
      const diff = record !== undefined ? optionalString(record.diff) : undefined
      if (path === undefined || diff === undefined) continue
      for (const hunk of parseUnifiedDiff(diff)) {
        diffs.push({ path, oldText: hunk.oldText, newText: hunk.newText })
      }
    }
    return diffs
  }

  /** Content blocks for an MCP tool result: text items carry through; others serialize. */
  private mcpResultContent(item: JsonObject): ContentBlock[] {
    const result = item.result !== null && typeof item.result === 'object'
      ? item.result as JsonObject
      : undefined
    const content = result !== undefined && Array.isArray(result.content) ? result.content : []
    const blocks: ContentBlock[] = []
    for (const entry of content) {
      const record = entry !== null && typeof entry === 'object' ? entry as JsonObject : undefined
      if (record?.type === 'text' && typeof record.text === 'string') {
        blocks.push({ type: 'text', text: record.text })
      } else {
        blocks.push({ type: 'text', text: JSON.stringify(entry) })
      }
    }
    const error = item.error !== null && typeof item.error === 'object'
      ? optionalString((item.error as JsonObject).message)
      : undefined
    if (error !== undefined) blocks.push({ type: 'text', text: error })
    return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks
  }

  /** Content blocks for a dynamic tool result. */
  private dynamicToolContent(item: JsonObject): ContentBlock[] {
    const items = Array.isArray(item.contentItems) ? item.contentItems : []
    const blocks: ContentBlock[] = []
    for (const entry of items) {
      const record = entry !== null && typeof entry === 'object' ? entry as JsonObject : undefined
      if (record?.type === 'inputText' && typeof record.text === 'string') {
        blocks.push({ type: 'text', text: record.text })
      } else {
        blocks.push({ type: 'text', text: JSON.stringify(entry) })
      }
    }
    return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks
  }

  /** Model-facing result text for generically projected items. */
  private genericItemResult(item: JsonObject): string {
    const failure = item.failure !== null && typeof item.failure === 'object'
      ? item.failure as JsonObject
      : undefined
    if (failure !== undefined) {
      const message = optionalString(failure.message)
      if (message !== undefined) return message
    }
    const result = optionalString(item.result)
    if (result !== undefined) return result
    const status = optionalString(item.status)
    return status === undefined ? JSON.stringify(item) : status
  }
}

/** One parsed unified-diff hunk, in the {@link FileDiff} card shape. */
interface ParsedHunk {
  readonly oldText: string | null
  readonly newText: string
}

/**
 * Parse one unified diff into per-hunk before/after text. Context lines land
 * on both sides; `\ No newline` markers annotate the patch and never enter
 * content. Malformed hunks are skipped rather than failing the projection.
 * @param diff - the unified diff text Codex reported for one file change.
 * @returns the parsed hunks in patch order; malformed hunks are omitted.
 */
export function parseUnifiedDiff(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = []
  let oldLines: string[] | undefined
  let newLines: string[] | undefined
  let sawRemoval = false
  const flush = (): void => {
    if (oldLines === undefined || newLines === undefined) return
    hunks.push({ oldText: sawRemoval ? oldLines.join('\n') : null, newText: newLines.join('\n') })
    oldLines = undefined
    newLines = undefined
    sawRemoval = false
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      flush()
      oldLines = []
      newLines = []
      continue
    }
    if (oldLines === undefined || newLines === undefined) continue
    if (line.startsWith('\\')) continue
    const text = line.slice(1)
    if (line.startsWith('-')) {
      oldLines.push(text)
      sawRemoval = true
    } else if (line.startsWith('+')) {
      newLines.push(text)
    } else {
      oldLines.push(text)
      newLines.push(text)
    }
  }
  flush()
  return hunks
}

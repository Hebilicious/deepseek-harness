/**
 * ACP session driver: one {@link ExternalAgent} bound to one ACP session on
 * its harness's shared ACP connection. Owns the session lifecycle
 * (`session/new`/`session/load`), turn driving (`session/prompt` → its
 * response), session-update → durable-event projection, and approval /
 * elicitation routing into the DSH seams.
 *
 * @module @deepseek-ai/dsh-agent-acp/agent
 */

import type {
  AgentHarness,
  AgentOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import type { AssistantStreamAttempt } from '@deepseek-ai/dsh-agent-external'
import {
  ExternalAgent,
  HARNESS_DEFAULT_MODEL,
  raceAbort,
  type ExternalTurnDrive,
} from '@deepseek-ai/dsh-agent-external'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentCancelCause, Session, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock as AcpContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationSchema,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  StopReason,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import type { AcpClientConnection, AcpSessionPeer } from './connection.ts'
import {
  acpAdvertisedModels,
  acpBlockToContent,
  acpModeOption,
  acpModelOption,
  acpPermissionOutcome,
  acpPrefix,
  acpReasoningOption,
  acpSelectEntries,
  acpToolContent,
  acpTurnEnding,
  AcpProtocolError,
  toAcpPromptBlocks,
  type AcpSelectOption,
  type AcpSessionAdvert,
} from './protocol.ts'
import { acpSessionOf } from './session-state.ts'
import type { AcpRuntime } from './runtime.ts'

/** Deployment-level defaults the plugin resolves once per agent. */
export interface AcpAgentConfig {
  /** Harness that owns this agent: its id routes model selections, its name labels diagnostics. */
  readonly harness: AgentHarness
  /** Workspace fallback when the session header carries no `cwd`. */
  readonly cwd?: string
  /** Filesystem sandbox when the session logs no `sandbox/mode` override. */
  readonly sandbox: SandboxMode
  /** Approval routing when the session logs no `approval/policy` override. */
  readonly approval: 'ask' | 'never'
  /** Deployment default mode value for the session's `mode` config option. */
  readonly mode?: string
  /** Deployment default model value for the session's `model` config option. */
  readonly model?: string
  /** Deployment default reasoning effort for the session's reasoning-effort config option. */
  readonly reasoningEffort?: string
}

/** One assistant stream's block bookkeeping for a single ACP messageId. */
interface StreamLane {
  readonly attempt: AssistantStreamAttempt
  /** Index of the open text block, or -1 before the first text delta. */
  textIndex: number
  /** Index of the open reasoning block, or -1 before the first thought delta. */
  reasoningIndex: number
  /** Next free block index this attempt allocates. */
  nextIndex: number
}

/** One live turn's mutable projection state. */
interface ActiveTurn {
  readonly drive: ExternalTurnDrive
  /** Assistant stream attempts keyed by ACP messageId; one anonymous lane when absent. */
  readonly attempts: Map<string, StreamLane>
  /** Open ACP tool calls awaiting their terminal update. */
  readonly openToolCalls: Set<string>
  /**
   * Announced tool calls whose `tool/call` is not committed yet, in
   * announcement order: an agent may announce a call before its input has
   * streamed (Claude Code sends `{}` and refines it with `tool_call_update`).
   */
  readonly pendingToolCalls: Map<string, { readonly name: string; input: unknown }>
  /** Tool calls committed in the current durable step. */
  stepToolCalls: number
  /**
   * The model sent on this turn, recorded on the committed assistant message.
   * Config selection may replace the preliminary value before the first commit.
   */
  model: string
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Agent whose turns run on an ACP session. The shared {@link AcpRuntime} owns
 * the process and connection; this class owns exactly one ACP session on it.
 */
export class AcpAgent extends ExternalAgent implements AcpSessionPeer {
  private acpSessionId: string | undefined
  private detachSession: (() => void) | undefined
  /** Stops re-applying the session mode when a permission change lands. */
  private stopModeSync: (() => void) | undefined
  /**
   * The latest mode write a permission change queued. Writes run one at a
   * time and a turn waits for them, so each compares against the mode the
   * harness last reported instead of sending it twice.
   */
  private modeSync: Promise<void> = Promise.resolve()
  private connection: AcpClientConnection | undefined
  private active: ActiveTurn | undefined
  /**
   * The turn collecting harness output that arrived with no user message, when
   * that turn is the live one. Distinct from a `session/prompt` turn so a
   * prompt's updates are not queued behind it.
   */
  private adopted: ActiveTurn | undefined
  /** Projectable updates that arrived before the adopted turn's projector existed. */
  private readonly outOfBand: SessionNotification['update'][] = []
  /** Resolves when an adopted turn should drain {@link outOfBand} again. */
  private outOfBandWait = Promise.withResolvers<void>()
  /** Whether {@link outOfBand} or an open adopted turn still owes a driver turn. */
  private unprompted = false
  /** The session's reported config options (model/mode mirrors). */
  private configOptions: readonly SessionConfigOption[] = []
  /** Whether `session/close` is advertised for this agent. */
  private closeSupported = false
  /** Constraint warnings already logged for this session, so a per-turn re-resolution logs each once. */
  private readonly warned = new Set<string>()

  constructor(
    hostCtx: Context,
    id: SessionId,
    options: AgentOptions,
    session: Session,
    private readonly runtime: AcpRuntime,
    private readonly driverConfig: AcpAgentConfig,
  ) {
    super(hostCtx, id, options, session)
  }

  /** Diagnostic tag naming this agent's harness in every message it raises. */
  private get prefix(): string {
    return acpPrefix(this.driverConfig.harness.id)
  }

  // ---- ExternalAgent harness surface ----

  /**
   * Join this harness's shared connection, then create a fresh ACP session or
   * load the recorded one. Runs unpublished: any rejection rolls the whole
   * create/resume back.
   * @param signal - fused caller/lifecycle cancellation.
   */
  async bind(signal: AbortSignal): Promise<void> {
    await this.attach(signal)
    // The harness asks for every tool call its mode does not cover, and a
    // `never` policy rejects each ask, so a permission change made mid-turn
    // reaches the harness now rather than at the next turn.
    this.stopModeSync = this.ctx.on('session/event', (session, event) => {
      const type: string = event.type
      if (session !== this.session || (type !== 'approval/policy' && type !== 'sandbox/mode')) return
      this.modeSync = this.modeSync.then(() => this.syncMode())
    })
  }

  /**
   * Join this harness's shared connection, create or load the ACP session,
   * and register this agent as its peer.
   * @param signal - fused caller/lifecycle cancellation.
   * @returns the live connection and the bound ACP session id.
   */
  private async attach(signal: AbortSignal): Promise<{ connection: AcpClientConnection; sessionId: string }> {
    const connection = await this.runtime.connect(signal)
    this.connection = connection
    const capabilities = this.runtime.initializeInfo?.agentCapabilities
    this.closeSupported = capabilities?.sessionCapabilities?.close !== undefined
    const cwd = this.session.header.cwd ?? this.driverConfig.cwd ?? process.cwd()
    const existing = acpSessionOf(this.ctx.sessionProjections, this.session)
    const sessionId = existing === undefined
      ? await this.startSession(connection, cwd, signal)
      : await this.loadSession(connection, existing, cwd, signal, capabilities?.loadSession === true)
    this.acpSessionId = sessionId
    this.detachSession = this.runtime.registerSession(sessionId, this)
    return { connection, sessionId }
  }

  /**
   * The live connection and ACP session for the next turn. When the harness
   * process or its connection died since the last turn, the runtime spawns a
   * new process and the recorded ACP session is loaded on it, so a follow-up
   * message continues the conversation instead of failing on the dead
   * connection. Recovery follows the {@link loadSession} rules: it needs
   * `loadSession`, and a failed load fails the turn.
   * @param signal - the turn's abort signal.
   * @returns the live connection and the bound ACP session id.
   */
  private async liveSession(signal: AbortSignal): Promise<{ connection: AcpClientConnection; sessionId: string }> {
    const connection = this.connection
    const sessionId = this.acpSessionId
    // A recovery whose load failed left no peer registered, so the next turn
    // attaches again rather than prompting a session the process never loaded.
    if (connection !== undefined && !connection.closed && sessionId !== undefined && this.detachSession !== undefined) {
      return { connection, sessionId }
    }
    this.ctx.logger.info(`${this.prefix}: the ACP connection closed; loading the session on a new harness process`)
    this.detachSession?.()
    this.detachSession = undefined
    return await this.attach(signal)
  }

  /**
   * Apply the session mode the current permission knobs choose, when the
   * harness advertises it and runs another one. A failure is logged: the next
   * turn applies the mode again.
   */
  private async syncMode(): Promise<void> {
    const connection = this.connection
    const sessionId = this.acpSessionId
    const modeOption = acpModeOption(this.configOptions)
    const mode = this.chooseMode(modeOption)
    if (connection === undefined || sessionId === undefined || mode === undefined || mode === modeOption?.currentValue) return
    try {
      const response = await connection.request<{ configOptions?: SessionConfigOption[] }>(
        'session/set_config_option',
        { sessionId, configId: 'mode', value: mode },
      )
      this.configOptions = response.configOptions ?? this.configOptions
    } catch (error: unknown) {
      this.ctx.logger.warn(`${this.prefix}: mode "${mode}" was not applied after a permission change: ${errorChain(error)}`)
    }
  }

  /**
   * Load the recorded ACP session. An agent may store a session only once it
   * receives a prompt (Claude Code does), so a restarted harness no longer
   * knows a session that no turn reached; nothing was delivered to it, so a
   * fresh ACP session replaces it. A session that ran a turn keeps the failure.
   * @param connection - the harness's shared connection.
   * @param existing - the recorded ACP session id.
   * @param cwd - the session working directory.
   * @param signal - fused caller/lifecycle cancellation.
   * @param loadable - whether the agent advertises `loadSession`.
   * @returns the ACP session id this session is now bound to.
   */
  private async loadSession(
    connection: AcpClientConnection,
    existing: string,
    cwd: string,
    signal: AbortSignal,
    loadable: boolean,
  ): Promise<string> {
    if (!loadable) {
      throw new AcpProtocolError(
        `${this.prefix}: session "${existing}" cannot resume: the agent does not advertise loadSession`,
      )
    }
    let response: AcpSessionAdvert
    try {
      // session/load replays history as session/update notifications; the peer
      // registers only after the response so replayed frames never double-commit.
      response = await connection.request<AcpSessionAdvert>(
        'session/load',
        { sessionId: existing, cwd, mcpServers: [] },
        signal,
      )
    } catch (error: unknown) {
      if (!isResourceNotFound(error) || this.ranTurn()) throw error
      this.ctx.logger.info(`${this.prefix}: session "${existing}" ran no turn and is gone; starting a new one`)
      return await this.startSession(connection, cwd, signal)
    }
    this.adoptAdvert(response)
    return existing
  }

  /**
   * Create a fresh ACP session and record it as this session's binding.
   * @param connection - the harness's shared connection.
   * @param cwd - the session working directory.
   * @param signal - fused caller/lifecycle cancellation.
   * @returns the new ACP session id.
   */
  private async startSession(connection: AcpClientConnection, cwd: string, signal: AbortSignal): Promise<string> {
    const response = await connection.request<AcpSessionAdvert & { sessionId?: string }>(
      'session/new',
      { cwd, mcpServers: [] },
      signal,
    )
    const sessionId = response.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AcpProtocolError(`${this.prefix}: session/new returned no session id`)
    }
    this.session.append('agent-acp/session', { sessionId })
    this.adoptAdvert(response)
    return sessionId
  }

  /**
   * Whether a turn may have reached the harness, so it holds history a fresh
   * session would lose. The host registers the turn-boundary fold; without it
   * the answer is yes.
   */
  private ranTurn(): boolean {
    return this.ctx.sessionProjections.stateOf(this.session, 'turnBoundary')?.lastTurn !== 0
  }

  /**
   * Adopt the config options and model catalog one session response carried,
   * and publish the catalog to the shared runtime so this harness's picker
   * route answers from what the harness itself advertises.
   */
  private adoptAdvert(advert: AcpSessionAdvert): void {
    this.configOptions = advert.configOptions ?? []
    this.runtime.recordAdvert(acpAdvertisedModels(advert))
  }

  /**
   * Release the ACP session: `session/close` when the agent advertises it,
   * then detach from the router. Best-effort — a dead connection already
   * released every session it carried.
   */
  async unbind(): Promise<void> {
    const detach = this.detachSession
    const connection = this.connection
    const sessionId = this.acpSessionId
    if (detach !== undefined && connection !== undefined && sessionId !== undefined && this.closeSupported) {
      try {
        await connection.request('session/close', { sessionId })
      } catch (error: unknown) {
        this.ctx.logger.warn(`${this.prefix}: session/close for "${sessionId}" failed: ${errorChain(error)}`)
      }
    }
    this.stopModeSync?.()
    this.stopModeSync = undefined
    detach?.()
    this.detachSession = undefined
    this.connection = undefined
  }

  /**
   * Drive one ACP turn: apply the session's model/mode selection, send
   * `session/prompt`, and resolve the response's stop reason to a durable
   * ending. Updates stream through the peer's {@link update}.
   * @param messages - the claimed user input, already committed durably.
   * @param drive - turn boundary, abort signal, and bound projector.
   * @returns the durable turn ending.
   */
  protected async driveTurn(
    messages: readonly UserMessage[],
    drive: ExternalTurnDrive,
  ): Promise<TurnEndReason> {
    const selection = this.currentSelection()
    // Only selections routed to this harness drive this agent; a
    // foreign-provider selection is not a value this harness's `model` option
    // can carry.
    const picked = selection.provider === this.driverConfig.harness.id ? selection.model : ''
    const chosen = picked !== '' ? picked : this.driverConfig.model
    const chosenEffort = picked !== '' && selection.reasoningEffort !== undefined
      ? selection.reasoningEffort
      : this.driverConfig.reasoningEffort
    // Reserve the turn before the first await. Updates that arrive during
    // config selection belong to this prompt, including a harness cycle that
    // overlaps the next session/prompt.
    const active: ActiveTurn = {
      drive,
      attempts: new Map(),
      openToolCalls: new Set(),
      pendingToolCalls: new Map(),
      stepToolCalls: 0,
      model: chosen ?? HARNESS_DEFAULT_MODEL,
    }
    this.active = active
    this.unprompted = false
    this.drainOutOfBand(active)
    let ending: TurnEndReason = { kind: 'error', error: { message: 'turn ended without a response', code: 'NO_RESPONSE' } }
    try {
      const { connection, sessionId } = await this.liveSession(drive.signal)
      await this.applyConfigSelection(connection, sessionId, chosen, chosenEffort, drive.signal)
      // Post-apply `currentValue` is the agent's own report of what will run;
      // when no model option exists the harness's model is opaque to DSH.
      const reported = acpModelOption(this.configOptions)?.currentValue
      const model = typeof reported === 'string' && reported !== ''
        ? reported
        : chosen ?? HARNESS_DEFAULT_MODEL
      active.model = model
      drive.projector.noteRoute({
        provider: this.driverConfig.harness.id,
        model,
        ...picked !== '' && selection.reasoningEffort !== undefined
          ? { reasoningEffort: selection.reasoningEffort }
          : {},
      })
      const prompt: AcpContentBlock[] = messages.flatMap(
        message => toAcpPromptBlocks(message, attachment => this.attachmentHostPath(attachment)),
      )
      const response = await raceAbort(
        connection.request<{ stopReason?: StopReason }>(
          'session/prompt',
          { sessionId, prompt },
          drive.signal,
        ),
        drive.signal,
        this.id,
      )
      ending = acpTurnEnding(response.stopReason ?? 'end_turn')
      return ending
    } finally {
      this.active = undefined
      this.settleActive(active, ending)
    }
  }

  /** ACP has no mid-turn steering channel; the message stays queued for the next turn. */
  protected steerLive(_message: UserMessage, _drive: ExternalTurnDrive): Promise<boolean> {
    return Promise.resolve(false)
  }

  /**
   * Interrupt the live ACP turn after its abort fired: `session/cancel`, and
   * the in-flight `session/prompt` resolves `cancelled` cooperatively.
   */
  protected interruptTurn(_drive: ExternalTurnDrive): Promise<void> {
    const connection = this.connection
    const sessionId = this.acpSessionId
    /* v8 ignore next -- unbind clears this pair only after driver quiescence,
       so no live turn's abort can observe it unset. */
    if (connection === undefined || sessionId === undefined) return Promise.resolve()
    connection.notify('session/cancel', { sessionId })
    return Promise.resolve()
  }

  // ---- AcpSessionPeer dispatch ----

  /**
   * Whether a harness cycle is waiting to be projected and no prompt turn is
   * collecting it. The driver then opens a turn with no user message.
   * @returns whether {@link driveUnpromptedTurn} must run.
   */
  protected override hasUnpromptedHarnessWork(): boolean {
    return this.unprompted
  }

  /**
   * Queue input. A waking send preempts an adopted harness cycle; a quiet
   * inject stays queued until that cycle's own end marker.
   * @param message - the user message to queue.
   * @param target - which inbox lane receives it.
   * @param wakeup - whether the driver should run.
   */
  override send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    super.send(message, target, wakeup)
    if (wakeup && this.unprompted) this.pokeOutOfBand()
  }

  /**
   * Project one harness cycle that started after `session/prompt` returned.
   * The Claude Code adapter emits that cycle — a task notification (a finished
   * background command, a Monitor line, or a scheduled wakeup) or a peer,
   * coordinator, observer, or observer-activity message — as ordinary
   * `session/update`s, and closes it with a `usage_update` whose
   * `_meta._claude/origin.kind` names that origin. A waking follow-up or steer
   * ends the cycle first. A quiet inject stays queued for the next turn.
   * Output that arrives while a prompt is reserved stays on that prompt's turn.
   * @param drive - the open turn, its abort signal, and its projector.
   * @returns the durable turn ending. Abort settles the partial output as interrupted.
   */
  protected override async driveUnpromptedTurn(drive: ExternalTurnDrive): Promise<TurnEndReason> {
    const reported = acpModelOption(this.configOptions)?.currentValue
    const model = typeof reported === 'string' && reported !== '' ? reported : HARNESS_DEFAULT_MODEL
    drive.projector.noteRoute({ provider: this.driverConfig.harness.id, model })
    const active: ActiveTurn = {
      drive,
      attempts: new Map(),
      openToolCalls: new Set(),
      pendingToolCalls: new Map(),
      stepToolCalls: 0,
      model,
    }
    this.adopted = active
    this.active = active
    const finish = (): TurnEndReason => drive.signal.aborted
      ? { kind: 'aborted', reason: drive.signal.reason as AgentCancelCause }
      : { kind: 'completed' }
    try {
      while (!drive.signal.aborted) {
        if (this.drainOutOfBand(active)) break
        if (this.inbox.nextTurn.length > 0 || this.hasWakingStepInput()) break
        await raceAbort(this.outOfBandWait.promise, drive.signal, this.id)
      }
      return finish()
    } finally {
      this.active = undefined
      this.adopted = undefined
      this.settleActive(active, finish())
      this.unprompted = this.outOfBand.length > 0
    }
  }

  /**
   * Consume one `session/update` for the bound session. Replaying history
   * during `session/load` never reaches here: the peer registers only after
   * the load response. A prompt turn projects immediately. A cycle that
   * arrives with no prompt open is queued until {@link driveUnpromptedTurn}
   * collects it; a terminal `usage_update` for an autonomous origin closes
   * that turn. Any other update with no prompt open is ignored, except
   * `config_option_update`, which refreshes the session's known options.
   * @param update - one ACP session update notification to project.
   */
  update(update: SessionNotification['update']): void {
    if (update.sessionUpdate === 'config_option_update') {
      this.configOptions = update.configOptions
      return
    }
    if (this.active !== undefined && this.adopted === undefined) {
      this.projectUpdate(this.active, update)
      return
    }
    if (isAutonomousCycleEnd(update)) {
      if (this.adopted === undefined && this.outOfBand.length === 0 && !this.unprompted) return
      this.outOfBand.push(update)
      this.unprompted = true
      this.pokeOutOfBand()
      this.wakeIdleDriver()
      return
    }
    if (!isProjectedUpdate(update)) return
    if (this.adopted !== undefined) {
      this.projectUpdate(this.adopted, update)
      return
    }
    this.outOfBand.push(update)
    this.unprompted = true
    this.pokeOutOfBand()
    this.wakeIdleDriver()
  }

  /**
   * Project the updates queued before this turn's projector existed.
   * @param active - the adopted turn.
   * @returns whether a terminal autonomous `usage_update` was in the batch.
   */
  private drainOutOfBand(active: ActiveTurn): boolean {
    let ended = false
    const batch = this.outOfBand.splice(0)
    for (const update of batch) {
      if (isAutonomousCycleEnd(update)) ended = true
      else this.projectUpdate(active, update)
    }
    return ended
  }

  /** Wake the adopted turn's wait. Replaces the promise so the next wait is fresh. */
  private pokeOutOfBand(): void {
    const current = this.outOfBandWait
    this.outOfBandWait = Promise.withResolvers()
    current.resolve()
  }

  /**
   * Project one session update into the open turn. `usage_update` and other
   * unprojected kinds are ignored; the caller decides which of those close a turn.
   * @param active - the prompt turn or the adopted turn.
   * @param update - one ACP session update.
   */
  private projectUpdate(active: ActiveTurn, update: SessionNotification['update']): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        this.commitPendingToolCalls(active)
        this.advanceAfterTools(active)
        const lane = this.ensureAttempt(active, optionalString(update.messageId) ?? 'default')
        const text = this.chunkText(update.content)
        if (text.length === 0) return
        if (lane.textIndex === -1) {
          lane.textIndex = lane.nextIndex++
          lane.attempt.push({ type: 'block-start', index: lane.textIndex, blockType: 'text' })
        }
        lane.attempt.push({ type: 'text-delta', index: lane.textIndex, text })
        return
      }
      case 'agent_thought_chunk': {
        this.commitPendingToolCalls(active)
        this.advanceAfterTools(active)
        const lane = this.ensureAttempt(active, optionalString(update.messageId) ?? 'default')
        const text = this.chunkText(update.content)
        if (text.length === 0) return
        if (lane.reasoningIndex === -1) {
          lane.reasoningIndex = lane.nextIndex++
          lane.attempt.push({ type: 'block-start', index: lane.reasoningIndex, blockType: 'reasoning' })
        }
        lane.attempt.push({ type: 'reasoning-delta', index: lane.reasoningIndex, text })
        return
      }
      case 'tool_call': {
        const callId = update.toolCallId
        if (callId.length === 0) return
        // A call after every earlier call has its result opens a new model
        // response; text streamed before this call belongs before it in the
        // log, and a call announced earlier has finished streaming its input.
        this.advanceAfterTools(active)
        this.commitText(active)
        this.commitPendingToolCalls(active)
        const name = optionalString(update.name) ?? optionalString(update.title) ?? 'tool'
        active.pendingToolCalls.set(callId, { name, input: update.rawInput })
        if (hasInput(update.rawInput)) this.commitToolCall(active, callId)
        return
      }
      case 'tool_call_update': {
        this.toolUpdate(active, update)
        return
      }
      case 'plan': {
        this.commitPendingToolCalls(active)
        this.advanceAfterTools(active)
        const lines = update.entries.flatMap((entry) => {
          const content = optionalString(entry.content)
          return content === undefined ? [] : [`- [${entry.status}] ${content}`]
        })
        if (lines.length === 0) return
        const lane = this.ensureAttempt(active, 'plan')
        if (lane.textIndex === -1) {
          lane.textIndex = lane.nextIndex++
          lane.attempt.push({ type: 'block-start', index: lane.textIndex, blockType: 'text' })
        }
        lane.attempt.push({ type: 'text-delta', index: lane.textIndex, text: `${lines.join('\n')}\n` })
        return
      }
      default:
        return
    }
  }

  /**
   * Answer one `session/request_permission` through the DSH approval seam.
   * The request arrives while a prompt or an adopted harness cycle is in
   * flight, so the durable turn is open and the audit pair can commit.
   * With no live turn, or no approval service, the outcome is cancelled.
   */
  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const active = this.active
    const approval = this.ctx.get('approval')
    if (active === undefined || approval === undefined) return { outcome: { outcome: 'cancelled' } }
    const toolCall = params.toolCall
    // The approval record names the call, so the call is committed first.
    const pending = active.pendingToolCalls.get(toolCall.toolCallId)
    if (pending !== undefined) {
      if (hasInput(toolCall.rawInput)) pending.input = toolCall.rawInput
      this.commitToolCall(active, toolCall.toolCallId)
    }
    const toolName = optionalString(toolCall.name) ?? optionalString(toolCall.title) ?? 'tool'
    const reason = optionalString(toolCall.title) ?? toolName
    try {
      const outcome = await approval.request({
        agent: this,
        toolName,
        callId: brandString<ToolCallId>(toolCall.toolCallId),
        reason,
        signal: active.drive.signal,
      })
      return { outcome: acpPermissionOutcome(params.options, outcome) }
    } catch (error: unknown) {
      this.ctx.logger.warn(`${this.prefix}: permission request failed closed: ${errorChain(error)}`)
      return { outcome: { outcome: 'cancelled' } }
    }
  }

  /**
   * Answer one `elicitation/create` through the user-questions seam for flat
   * form schemas of string/enum/boolean fields; richer modes and schemas
   * decline rather than fabricate content.
   */
  async elicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const decline: CreateElicitationResponse = { action: 'decline' }
    const active = this.active
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined || active === undefined) return decline
    if (params.mode !== 'form') return decline
    const properties = (params.requestedSchema as ElicitationSchema).properties
    if (properties === undefined || Object.keys(properties).length === 0) return decline
    const mapped = Object.entries(properties).flatMap(([key, property]) => {
      const description = optionalString(property.description)
      const enumValues = property.type === 'string' && Array.isArray(property.enum)
        ? property.enum
        : undefined
      const options = enumValues?.flatMap((raw) => {
        const label = optionalString(raw)
        return label === undefined ? [] : [{ label }]
      })
      const question = description ?? key
      return [{
        id: key,
        question,
        detail: params.message,
        ...options === undefined || options.length === 0 ? {} : { options },
      }]
    })
    try {
      const answer = await questions.ask({
        questions: mapped,
        agent: this,
        signal: active.drive.signal,
      })
      const content: Record<string, string | string[]> = {}
      for (const item of answer.answers) {
        const selected = [...item.selected, ...item.custom === undefined ? [] : [item.custom]]
        if (selected.length === 1) content[item.id] = selected[0] as string
        else if (selected.length > 1) content[item.id] = selected
      }
      return { action: 'accept', content }
    } catch (error: unknown) {
      this.ctx.logger.warn(`${this.prefix}: elicitation declined: ${errorChain(error)}`)
      return decline
    }
  }

  // ---- internals ----

  /**
   * Apply the session's config-option selections before the prompt: the
   * `model` option carries the durable `model/selection` or deployment
   * default, the reasoning-effort option carries the selection's effort, and
   * the `mode` option carries the DSH permission knobs — each only when the
   * session advertised the option and the value differs. A requested value the
   * harness cannot carry is logged with the value that will run instead, never
   * dropped silently.
   * @param chosenModel - the resolved model value, or undefined to leave the
   *   agent's `model` option untouched.
   * @param chosenEffort - the resolved reasoning-effort value, or undefined to
   *   leave the agent's reasoning-effort option untouched.
   */
  private async applyConfigSelection(
    connection: AcpClientConnection,
    sessionId: string,
    chosenModel: string | undefined,
    chosenEffort: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    await this.modeSync
    const updates: { configId: string; value: string }[] = []
    const modelOption = acpModelOption(this.configOptions)
    if (chosenModel !== undefined && modelOption === undefined) {
      this.warnOnce(
        `model:${chosenModel}:unadvertised`,
        `${this.prefix}: model "${chosenModel}" was not applied: the session advertises no model option`,
      )
    } else if (modelOption !== undefined && chosenModel !== undefined && chosenModel !== modelOption.currentValue) {
      if (this.optionValues(modelOption).has(chosenModel)) {
        updates.push({ configId: 'model', value: chosenModel })
      } else {
        this.warnOnce(
          `model:${chosenModel}:${modelOption.currentValue}`,
          `${this.prefix}: model "${chosenModel}" was not applied: the session does not advertise it; the session runs model "${modelOption.currentValue}"`,
        )
      }
    }
    const effortOption = acpReasoningOption(this.configOptions)
    if (chosenEffort !== undefined && effortOption === undefined) {
      this.warnOnce(
        `effort:${chosenEffort}:unadvertised`,
        `${this.prefix}: reasoning effort "${chosenEffort}" was not applied: the session advertises no reasoning-effort option`,
      )
    } else if (effortOption !== undefined && chosenEffort !== undefined && chosenEffort !== effortOption.currentValue) {
      if (this.optionValues(effortOption).has(chosenEffort)) {
        updates.push({ configId: effortOption.id, value: chosenEffort })
      } else {
        this.warnOnce(
          `effort:${chosenEffort}:${effortOption.currentValue}`,
          `${this.prefix}: reasoning effort "${chosenEffort}" was not applied: the session does not advertise it; the session runs reasoning effort "${effortOption.currentValue}"`,
        )
      }
    }
    const modeOption = acpModeOption(this.configOptions)
    const mode = this.chooseMode(modeOption)
    if (mode === undefined) {
      // A read-only session reports its own limitation below, which names the
      // same request and effective mode; warning twice would say one thing.
      if (!this.readOnlySandbox()) this.warnModeNotApplied(modeOption)
    } else if (mode !== modeOption?.currentValue) {
      updates.push({ configId: 'mode', value: mode })
    }
    for (const update of updates) {
      const response = await connection.request<{ configOptions?: SessionConfigOption[] }>(
        'session/set_config_option',
        { sessionId, configId: update.configId, value: update.value },
        signal,
      )
      this.configOptions = response.configOptions ?? this.configOptions
    }
    // An ACP mode expresses approval behavior, not filesystem scope: no mode
    // proves the harness confines its own tools to reading, so a read-only
    // session always reports the mode it actually runs.
    if (this.readOnlySandbox()) {
      const inEffect = acpModeOption(this.configOptions)?.currentValue
      this.warnOnce(
        `read-only:${inEffect ?? 'unadvertised'}`,
        inEffect === undefined
          ? `${this.prefix}: the session's read-only sandbox is not enforceable by the harness: the session advertises no mode option`
          : `${this.prefix}: the session's read-only sandbox is not enforceable by the harness; the session runs mode "${inEffect}"`,
      )
    }
  }

  /**
   * The advertised session mode value for the current DSH permission knobs: a
   * `never` approval policy maps to the auto-approve mode (`bypass`), a
   * read-only sandbox to the closest non-editing mode (`ask`), and `ask` over
   * a writable sandbox to a tool-executing mode. Real Devin advertises
   * `accept-edits`, `smart`, `ask`, `plan`, and `bypass`; opencode and
   * mimocode advertise `build` and `plan`; the Claude Code adapter advertises
   * `default`, `acceptEdits`, `plan`, `auto`, and `bypassPermissions`. The deployment config `mode`
   * overrides, and a request no advertised value satisfies returns undefined
   * so {@link warnModeNotApplied} names it.
   */
  private chooseMode(modeOption: AcpSelectOption | undefined): string | undefined {
    const values = new Set(modeOption === undefined ? [] : acpSelectEntries(modeOption).map(entry => entry.value))
    if (this.driverConfig.mode !== undefined) {
      return values.has(this.driverConfig.mode) ? this.driverConfig.mode : undefined
    }
    const pick = (candidates: readonly string[]): string | undefined =>
      candidates.find(candidate => values.has(candidate))
    const approval = this.ctx.get('approval')?.overrideOf(this.session) ?? this.driverConfig.approval
    if (approval === 'never') return pick(['bypass', 'bypassPermissions', 'smart'])
    if (this.readOnlySandbox()) return pick(['ask', 'plan'])
    return pick(['accept-edits', 'acceptEdits', 'build', 'smart'])
  }

  /**
   * Report a requested mode that no advertised value satisfies, naming both
   * the request and the mode in effect, once per distinct pair.
   */
  private warnModeNotApplied(modeOption: AcpSelectOption | undefined): void {
    const requested = this.driverConfig.mode === undefined
      ? `approval policy "${this.ctx.get('approval')?.overrideOf(this.session) ?? this.driverConfig.approval}"`
      : `mode "${this.driverConfig.mode}"`
    const inEffect = modeOption?.currentValue
    this.warnOnce(
      `mode:${requested}:${inEffect ?? 'unadvertised'}`,
      inEffect === undefined
        ? `${this.prefix}: the session's ${requested} was not applied: the session advertises no mode option`
        : `${this.prefix}: the session's ${requested} was not applied: the session does not advertise a mode for it; the session runs mode "${inEffect}"`,
    )
  }

  /** Whether the session's effective DSH sandbox is `read-only`. */
  private readOnlySandbox(): boolean {
    return (this.ctx.get('sandboxPolicy')?.overrideOf(this.session) ?? this.driverConfig.sandbox) === 'read-only'
  }

  /** Emit one constraint warning per distinct message; a driver re-resolves its config every turn. */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.ctx.logger.warn(message)
  }

  /** Every selectable value an advertised option offers, flat or grouped. */
  private optionValues(option: AcpSelectOption): Set<string> {
    return new Set(acpSelectEntries(option).map(entry => entry.value))
  }

  /**
   * Settle a turn's leftover state: open tool calls close as error results,
   * and open assistant lanes commit — interrupted on an aborted or failed
   * ending, complete on a clean stop.
   */
  private settleActive(active: ActiveTurn, ending: TurnEndReason): void {
    this.commitPendingToolCalls(active)
    for (const callId of active.openToolCalls) {
      try {
        active.drive.projector.toolResult(
          callId,
          [{ type: 'text', text: 'tool call ended without a terminal update' }],
          { isError: true, error: { name: 'AcpToolIncomplete', code: 'INCOMPLETE' } },
        )
      } catch (error: unknown) {
        /* v8 ignore next -- containment arm: the projector rejects only when the
           durable append itself fails, which already fails the session. */
        this.ctx.logger.warn(`${this.prefix}: tool result settlement failed: ${errorChain(error)}`)
      }
    }
    active.openToolCalls.clear()
    const interrupted = ending.kind !== 'completed'
    for (const lane of active.attempts.values()) {
      try {
        if (lane.nextIndex > 0) {
          lane.attempt.push({
            type: 'finish',
            reason: interrupted
              ? { kind: 'aborted', failure: { message: 'turn ended mid-stream', code: 'ABORTED' } }
              : { kind: 'stop' },
          })
          active.drive.projector.commitAssistant(lane.attempt, {
            provider: this.driverConfig.harness.id,
            model: active.model,
          }, interrupted ? { interrupted: true } : {})
        } else {
          active.drive.projector.commitAttempt(lane.attempt)
        }
      } catch (error: unknown) {
        /* v8 ignore next -- containment arm: the projector rejects only when the
           durable append itself fails, which already fails the session. */
        this.ctx.logger.warn(`${this.prefix}: assistant stream settlement failed: ${errorChain(error)}`)
      }
    }
    active.attempts.clear()
  }

  /**
   * Fold one terminal `tool_call_update` into a durable `tool/result`.
   * Non-terminal updates only update the open record's bookkeeping.
   */
  private toolUpdate(active: ActiveTurn, update: ToolCallUpdate): void {
    const callId = update.toolCallId
    if (callId.length === 0) return
    const status = update.status
    const terminal = status === 'completed' || status === 'failed'
    const pending = active.pendingToolCalls.get(callId)
    if (pending !== undefined && hasInput(update.rawInput)) pending.input = update.rawInput
    if (pending !== undefined && (terminal || hasInput(update.rawInput))) this.commitToolCall(active, callId)
    if (!terminal) return
    // Text the agent streamed while the call ran precedes its result.
    this.commitText(active)
    active.openToolCalls.delete(callId)
    const { blocks } = acpToolContent(update.content ?? undefined, update.rawOutput)
    active.drive.projector.toolResult(
      callId,
      blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks,
      status === 'failed'
        ? { isError: true, error: { name: 'AcpToolFailed', code: 'FAILED' } }
        : {},
    )
  }

  /**
   * Commit one announced tool call with the latest input the agent reported.
   * @param active - the live turn.
   * @param callId - an id in {@link ActiveTurn.pendingToolCalls}.
   */
  private commitToolCall(active: ActiveTurn, callId: string): void {
    const pending = active.pendingToolCalls.get(callId)
    /* v8 ignore next -- every caller reads the entry before committing it */
    if (pending === undefined) return
    active.pendingToolCalls.delete(callId)
    active.openToolCalls.add(callId)
    active.stepToolCalls += 1
    active.drive.projector.toolCall(callId, pending.name, pending.input === undefined ? '{}' : JSON.stringify(pending.input))
  }

  /**
   * Open the next durable step when the agent starts a new model response:
   * the current step committed tool calls and every one of them has its
   * result. Its streams settle first so nothing crosses the step boundary.
   */
  private advanceAfterTools(active: ActiveTurn): void {
    if (active.stepToolCalls === 0 || active.openToolCalls.size > 0 || active.pendingToolCalls.size > 0) return
    this.commitText(active)
    for (const [messageId, lane] of active.attempts) {
      active.drive.projector.commitAttempt(lane.attempt)
      active.attempts.delete(messageId)
    }
    active.drive.nextStep()
    active.stepToolCalls = 0
  }

  /** Commit every announced tool call the agent has moved past, in announcement order. */
  private commitPendingToolCalls(active: ActiveTurn): void {
    for (const callId of [...active.pendingToolCalls.keys()]) this.commitToolCall(active, callId)
  }

  /**
   * Commit every assistant lane that streamed content, so the log keeps the
   * order the agent produced text and tool calls in. A later chunk with the
   * same message id opens a new lane.
   */
  private commitText(active: ActiveTurn): void {
    for (const [messageId, lane] of active.attempts) {
      if (lane.nextIndex === 0) continue
      lane.attempt.push({ type: 'finish', reason: { kind: 'stop' } })
      active.drive.projector.commitAssistant(lane.attempt, { provider: this.driverConfig.harness.id, model: active.model })
      active.attempts.delete(messageId)
    }
  }

  /** Open or fetch the assistant stream lane for one ACP message id. */
  private ensureAttempt(active: ActiveTurn, messageId: string): StreamLane {
    let lane = active.attempts.get(messageId)
    if (lane === undefined) {
      lane = {
        attempt: active.drive.projector.beginAssistant(),
        textIndex: -1,
        reasoningIndex: -1,
        nextIndex: 0,
      }
      active.attempts.set(messageId, lane)
    }
    return lane
  }

  private chunkText(content: AcpContentBlock): string {
    const mapped = acpBlockToContent(content)
    return mapped?.type === 'text' ? mapped.text : ''
  }

  /**
   * Resolve one file/image attachment to its host path through the optional
   * attachment service; resolution failures degrade to a text handle instead
   * of rejecting the turn.
   */
  private attachmentHostPath(attachment: unknown): string | undefined {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) return undefined
    try {
      if (typeof attachment === 'object' && attachment !== null && 'mediaType' in attachment) {
        return attachments.imageHostPath(attachment as never)
      }
      return attachments.fileHostPath(attachment as never)
    } catch (error: unknown) {
      this.ctx.logger.warn(`${this.prefix}: attachment path resolution failed: ${errorChain(error)}`)
      return undefined
    }
  }
}

/**
 * Origins the Claude Code adapter stamps on a `usage_update` when the cycle
 * was not the user's prompt. `task-notification` covers a finished background
 * command, a Monitor line, and a scheduled wakeup (`subkind` `scheduled-trigger`).
 * Background subagent output that the adapter holds inside `session/prompt`
 * is not one of these cycles.
 */
const AUTONOMOUS_ORIGIN_KINDS = new Set([
  'task-notification',
  'peer',
  'coordinator',
  'observer',
  'observer-activity',
])

/** Whether this update is the terminal marker of one autonomous harness cycle. */
function isAutonomousCycleEnd(update: SessionNotification['update']): boolean {
  if (update.sessionUpdate !== 'usage_update') return false
  const origin = update._meta?.['_claude/origin']
  if (typeof origin !== 'object' || origin === null || !('kind' in origin)) return false
  const kind = origin.kind
  return typeof kind === 'string' && AUTONOMOUS_ORIGIN_KINDS.has(kind)
}

/** Whether the driver projects this update into the open turn. */
function isProjectedUpdate(update: SessionNotification['update']): boolean {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
    case 'plan':
      return true
    default:
      return false
  }
}

/** Whether an agent-reported tool input carries anything: `{}` is the placeholder of a still-streaming call. */
function hasInput(value: unknown): boolean {
  if (value === undefined || value === null) return false
  return typeof value !== 'object' || Object.keys(value).length > 0
}

/** JSON-RPC code ACP agents answer for an unknown session (`RequestError.resourceNotFound`). */
const RESOURCE_NOT_FOUND = -32002

/** Whether a request failed because the agent does not know the requested resource. */
function isResourceNotFound(error: unknown): boolean {
  return error instanceof RequestError && error.code === RESOURCE_NOT_FOUND
}

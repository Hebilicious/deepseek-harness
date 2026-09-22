/**
 * Codex app-server protocol vocabulary shared by the session driver and the
 * one-shot subagent provider: permission-mode thread params, wire validators,
 * and terminal-turn failure classification. Product policy (unattended
 * answers, item projection) stays in each caller.
 *
 * @module @deepseek-ai/dsh-agent-codex/protocol
 */

/** Untyped JSON object as it arrives off the wire. */
export type JsonObject = Record<string, unknown>

/** Native non-interactive Codex permission mode selectable per deployment. */
export type CodexPermissionMode =
  | 'never'
  | 'approve-for-me'
  | 'dangerously-bypass-approvals-and-sandbox'

/** Every {@link CodexPermissionMode}, for config-schema enumeration. */
export const CODEX_PERMISSION_MODES = [
  'never',
  'approve-for-me',
  'dangerously-bypass-approvals-and-sandbox',
] as const satisfies readonly CodexPermissionMode[]

/** Safe default for unattended Codex runs. */
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'never'

/** Native non-interactive Codex modes mapped to official `thread/start`/`thread/resume` fields. */
export const THREAD_PERMISSION_PARAMS: Readonly<Record<CodexPermissionMode, JsonObject>> = {
  never: { approvalPolicy: 'never' },
  'approve-for-me': {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  },
  'dangerously-bypass-approvals-and-sandbox': {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  },
}

/** Product facts a caller reports after a Codex turn rejects or ends non-completed. */
export interface CodexWireFailureFacts {
  readonly stage: 'turn-start' | 'turn'
  readonly category:
    | 'limit'
    | 'access-policy'
    | 'service'
    | 'transport'
    | 'product-error'
    | 'invalid-result'
    | 'unknown'
  readonly httpStatus?: number | undefined
}

/** Parsed terminal-turn failure detail before the caller fixes its stage. */
export interface CodexTurnFailureInfo {
  readonly category: CodexWireFailureFacts['category']
  readonly httpStatus?: number | undefined
  /** True when `codexErrorInfo` reported a context-window overflow. */
  readonly maxTokens?: true
  /** True when the failure is the Codex sandbox refusing execution. */
  readonly sandboxFailure?: true
}

/**
 * Require a plain JSON object at a wire boundary.
 * @param value - decoded frame member.
 * @param label - field description interpolated into the error.
 * @param prefix - calling package's diagnostic prefix.
 * @returns the value as a mutable-record view.
 */
export function codexObject(value: unknown, label: string, prefix: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${prefix}: app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

/**
 * Require a non-empty string at a wire boundary.
 * @param value - decoded frame member.
 * @param label - field description interpolated into the error.
 * @param prefix - calling package's diagnostic prefix.
 * @returns the validated string.
 */
export function codexString(value: unknown, label: string, prefix: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${prefix}: app-server returned invalid ${label}`)
  }
  return value
}

function numericHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 65_535
    ? value
    : undefined
}

function objectFailureInfo(value: JsonObject): CodexTurnFailureInfo {
  const keys = Object.keys(value)
  const category = keys[0]
  if (keys.length !== 1 || category === undefined) {
    return { category: 'unknown' }
  }
  const detail = value[category]
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    return { category: 'unknown' }
  }
  const fields = detail as JsonObject
  switch (category) {
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
    {
      const httpStatus = numericHttpStatus(fields.httpStatusCode)
      return httpStatus === undefined
        ? { category: 'transport' }
        : { category: 'transport', httpStatus }
    }
    case 'activeTurnNotSteerable':
      return { category: 'product-error' }
    default:
      return { category: 'unknown' }
  }
}

/**
 * Classify one terminal `turn` object (`turn/completed` payload member).
 * Non-`failed` statuses classify `unknown`; callers pair the result with
 * their own stage.
 * @param turn - decoded `turn/completed` `turn` member.
 * @returns the category, optional HTTP status, and recognized limit flags.
 */
export function codexTurnFailureInfo(turn: JsonObject): CodexTurnFailureInfo {
  if (turn.status !== 'failed') return { category: 'unknown' }
  const error = turn.error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) {
    return { category: 'unknown' }
  }
  const info = (error as JsonObject).codexErrorInfo
  if (typeof info === 'string') {
    switch (info) {
      case 'contextWindowExceeded':
        return { category: 'limit', maxTokens: true }
      case 'sessionBudgetExceeded':
      case 'usageLimitExceeded':
        return { category: 'limit' }
      case 'serverOverloaded':
      case 'internalServerError':
        return { category: 'service' }
      case 'cyberPolicy':
      case 'misalignmentPolicyViolation':
      case 'unauthorized':
        return { category: 'access-policy' }
      case 'badRequest':
      case 'threadRollbackFailed':
      case 'other':
        return { category: 'product-error' }
      case 'sandboxError':
        return { category: 'access-policy', sandboxFailure: true }
      default:
        return { category: 'unknown' }
    }
  }
  return info !== null && typeof info === 'object' && !Array.isArray(info)
    ? objectFailureInfo(info as JsonObject)
    : { category: 'unknown' }
}

/**
 * Read the `threadId` member of a notification or request payload without
 * raising: routing needs a soft miss, not a protocol failure.
 * @param params - decoded frame params.
 * @returns the thread id, or `undefined` when the payload carries none.
 */
export function codexThreadIdOf(params: JsonObject): string | undefined {
  return typeof params.threadId === 'string' && params.threadId.length > 0
    ? params.threadId
    : undefined
}

/** The terminal status strings a `turn/completed` turn may report. */
export const CODEX_TERMINAL_TURN_STATUSES = ['completed', 'interrupted', 'failed'] as const

/**
 * A server-request rejection that stays request-scoped: the transport turns
 * it into a `-32603` error response without poisoning the shared connection.
 * Any other thrown Error is a protocol violation and fails the connection.
 */
export class CodexRequestRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexRequestRefused'
  }
}

# Agent Note: Recover unanswered assistant tool calls

Status: implemented

English | [中文](2026-09-21-unanswered-tool-call-recovery.zh.md)

## Problem

A step commits its assistant message before it runs the tool calls inside it. When tool scheduling failed after that commit, the turn closed with `turn/end { kind: 'error' }` and left the committed call without a `tool/result`.

That history is not representable by a strict provider: the DeepSeek Messages serializer refuses an assistant tool call whose result is absent from the user turn that follows it with `INVALID_REQUEST` ("tool calls need immediate results"), so every later request on that route failed and the session stayed unusable there. Crash repair (`interruptedTurnClosers`) closes calls only inside an open final turn, so a call left in a *closed* turn survived every later resume. Sessions reached that state through a scheduler failure and then failed each model switch to a strict route.

## Decision

The writer closes the calls it abandons, and the derived history exposes no call that nothing answers.

`toolCallRecovery(call, seq)` in `packages/core/session/src/repair.ts` builds the payload and surface placement for one unanswered call, and both producers share it: `interruptedTurnClosers` for a crash-orphaned open turn, and `executeToolCalls` (`packages/core/agent-loop/src/tool-calls.ts`) for a terminal scheduler failure. A call whose `tool/call` was recorded receives `TOOL_OUTCOME_UNKNOWN` and the text that tells the model to verify external state before retrying; a call that never reached dispatch receives `TOOL_NOT_STARTED`. Both keep the canonical `interrupted-tool-result-<callId>-<seq>` message identity that the session-format migrations recognize.

On a terminal failure, `executeToolCalls` records the recovery result for every uncommitted call of the failing group and for every call that never started, then rethrows the scheduler failure. Cancellation already closes undispatched calls with `ABORTED_BEFORE_DISPATCH` results ([decision](2026-08-10-cancelled-stream-prefix-finalize.md)); this extends the same closure to a failure that leaves the step. A refused recovery append must not replace that failure, so the append is contained and the failure surfaces unchanged.

`Session.deriveMessages()` omits an assistant tool call that no user turn answers, and omits the message when the call was its only content. The rule mirrors the protocol requirement, so a history written by an earlier build repairs itself on the next request instead of refusing to run. The durable log keeps the call, and the human transcript still shows it.

## Alternatives considered

**Leave the refusal and tell the user to start a new session.** Rejected: the refusal repeats on every attempt, the durable history is intact apart from one missing result, and the affected sessions cannot be repaired by hand from the GUI.

**Rewrite the durable log to insert the missing result.** Rejected: seq values are contiguous positions, so an insertion renumbers every later event and every `sourceEventSeqs` and compaction range that cites one. A committed generation is also never moved or overwritten.

**Repair through a durable message-projection event.** Rejected: rewriting a recorded assistant message would need a new projected event type, a registered pure projection, and catalog regeneration for a repair the derivation already performs deterministically from the same log.

**Synthesize the result inside a provider serializer.** Rejected: the protocol rule is not provider-specific (Anthropic Messages enforces it too), and a model-visible result that no session event records would break the logged-history rule for one route only.

## Consequences

A session whose history contains an unanswered call runs again on every route without touching durable data. The model does not see that call in such a legacy history; the human transcript still shows it, and a failure recorded by this build carries an explicit recovery result instead. A scheduler failure still ends its turn with the original error code.

The recovery result is model-visible, so it participates in snapshots and in the request the next step builds; the derivation rule removes nothing from a history whose calls are all answered.

## Verification

`packages/core/session/tests/unanswered-tool-calls.spec.ts` pins the derivation: an unanswered call is dropped while the rest of its message survives, a message that held only the call disappears, an answered call stays, a call answered by a later user turn returns, and a detached replay of the same log derives the same history.

`packages/core/agent-loop/tests/tool-calls.spec.ts` pins the writer: a failing exclusive group closes its recorded call with `TOOL_OUTCOME_UNKNOWN` and the never-started call with `TOOL_NOT_STARTED`, a failing parallel group closes its unstarted sibling, the derived history has no unanswered call afterwards, and a refused recovery append still reports the scheduler failure.

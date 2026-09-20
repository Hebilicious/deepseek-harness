# Agent Note: Deployment-supplied prompt policy text

Status: implemented

English | [中文](2026-09-19-no-self-capacity-blockers.zh.md)

## Problem

An agent can invent a budget from the wording of the harness itself. The compaction checkpoint said an earlier span of the conversation was condensed "to free up context", which names a quantity that just changed, so a model can read the freed room as an allowance it must spend carefully and stop once the allowance looks small. The goal policy listed difficulty, uncertainty, and useful remaining work as insufficient blockers without saying what is sufficient, and the goal-round prompt ended its completion protocol with "If work remains, leave the goal active for the next round", which reads as permission to end a round with a status report. Observed rounds blocked on "my context is limited" and "I need a fresh session so I am handing off here", and reported the size of a pending full-file refactor instead of starting it.

Execution accepted any non-empty `blocked_reason` once the configured round count had passed, so nothing in the runtime contradicted the excuse at the moment the model produced it, and the round-count floor only delayed it.

## Decision

Three validated string fields carry the model-visible policy, and each defaults to empty, so a default deployment keeps today's prompt text, tool schema, executor behavior, and recorded sessions byte for byte. Anything that changes model-visible text is passed as text: no boolean selects between package-authored wordings.

### Goal tool policy and capacity screening

[`dsh-tool-goal`](../../../../packages/goal/tool-goal/README.md) carries `blockedReasonPolicy?: string`, appended verbatim to the `tool:goal` system-prompt section. Supplying text also enables the capacity screen, because a policy the runtime does not enforce is documentation rather than policy: `src/blocker.ts` holds the capacity vocabulary (context, token, budget, compact, session, exhausted, exhaustion) and the external-condition vocabulary (environment-denied access, credentials and human decisions, product requirements), and `update_goal` with `action: blocked` refuses a reason that names capacity without naming an external condition, with `GOAL_TOOL_BLOCK_REASON_CAPACITY`, in any round and under either authority, before the round-count gate.

The two halves stay independent and the README states it: the text tells the model what the deployment permits, the vocabulary is what execution checks. A policy that permits nothing the vocabulary accepts leaves the model unable to block, and a policy that permits more than the vocabulary accepts is refused by execution.

### Checkpoint framing

[`dsh-compaction-basic`](../../../../packages/compaction/compaction-basic/README.md) carries `checkpointNotice?: string`, appended to every checkpoint preamble. The framing tags are package-owned, so configuration rejects a notice containing `<compacted-summary>` or `</compacted-summary>` rather than letting a deployment break the replay contract that merges prior checkpoints. `frameSummary` takes the notice as an optional argument, so the default call site renders the unchanged preamble.

### Goal-round prompt

[`dsh-goal-round-driver`](../../../../packages/goal/goal-round-driver/README.md) carries `roundProtocol?: string`, which replaces the package's default completion protocol in the rendered `<goal_round>` block; empty or absent renders `STANDARD_PROTOCOL`. The package's invariant companion takes the same `roundProtocol` and validates each goal-sourced message against the configured text, so the check stays exact for a deployment's own wording instead of accepting anything. A session recorded under one protocol fails the invariant when the driver is configured with another, which is the cost of owning the wording.

### Where the settings are composed

`tool-goal` and `compaction-basic` are agent-preset rows, so a preset supplies their text; the web bundle disables their host rows for that reason. `goal-round-driver` stays on the host plane with the goal service, where Gateway remotes resolve the goal domain, so its row is composed at the profile level rather than by a preset.

## Testing

Unit tests cover the defaults and supplied text in all three packages: the default path keeps the existing guidance, preamble, round prompt, and acceptance of any non-empty reason; a supplied policy is appended verbatim and screens the executor's rejection and external-condition allowance; a supplied notice lands on the replacement checkpoint; a supplied protocol is queued to the model and validated by the invariant, which rejects the default text once another protocol is configured. Config validation covers a non-string value and a notice carrying framing tags, and the capacity vocabulary is asserted directly for capacity-only, capacity-with-external-term, and no-capacity-term reasons. Because every default is empty, the recorded-session corpus and the tool catalog keep their committed model-visible text; only the generated configuration catalog gains the three fields.

## Alternatives considered

- **Booleans selecting package-authored text** — rejected: a toggle hides the wording from the deployment, and the stricter wording is a deployment's decision about how its model should behave, not a defect in the default.
- **Appending the round protocol instead of replacing it** — rejected: a deployment that wants different wording would keep the package's protocol text, including the hand-off sentence it is trying to remove, and would have to reproduce the rest of the instruction to control the result.
- **Letting the invariant accept any goal-sourced message** — rejected: with configuration-supplied text the invariant can still compare exactly, and dropping the comparison would remove the only check that a continuation message is a rendered prompt rather than forged content.
- **Making the capacity screen unconditional** — rejected by the same reasoning as the text: a deployment that states no policy should not have one enforced, and an unconditional screen would change default behavior and every recorded executor snapshot.
- **Moving `goal-round-driver` into the presets so presets own the round prompt** — rejected: the recorded [host-plane decision](../../../notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.md) keeps the goal service and its session driver where Gateway remotes resolve them, and presets that omit the row would silently lose automatic continuation.
- **Shipping the stricter text as the new default** — rejected: every recorded-session system prompt, tool schema, and goal-round fixture would change for every deployment, which is a default policy change rather than a configuration surface.

## Consequences

- Default deployments are unaffected in behavior, tokens, and recorded output; the fields exist and are inert until a deployment supplies text.
- A deployment that supplies text owns its wording; the generated catalogs and the recorded-session corpus pin only the defaults, so nothing in this repository can review what that deployment's model reads.
- The capacity screen is lexical and follows the supplied policy: a reason that mentions capacity beside an external-sounding phrase passes, and a genuine blocker phrased only in capacity terms is refused until it is restated.
- The round-prompt invariant is configuration-relative: a session recorded under one protocol fails under another, so a deployment that changes its protocol affects replay of its own earlier sessions.

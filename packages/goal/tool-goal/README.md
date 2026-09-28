---
description: "The model-facing goal tools for users and maintainers choosing, composing, or debugging get_goal, create_goal, and update_goal."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-goal

English | [中文](README.zh.md)

## Summary

`dsh-tool-goal` lets a model read persisted goals and infer and create a long-running goal from a direct human request. Creating, editing, pausing, or resuming requires that direct request in a top-level agent turn; completing or blocking also works in an autonomous goal round. Updates require the exact id and revision from a prior read. `resume` rearms active-but-disarmed or blocked goals, while users resume durable paused goals through Web or `/goal resume`. Autonomous blocking requires the same condition for a configurable threshold of three consecutive rounds by default, and a deployment-supplied policy text can add permitted-reason rules that the executor enforces.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-tool-goal` beside the goal service when the model should create and update persisted goals itself. The tools are the model-facing half of the goal surface; the `/goal` command is the human-facing half, and the continuation driver uses the same tools to complete or block goals at the end of autonomous rounds.

### Tools

All three tools return the same compact JSON — `{ goal: null }` when no goal is current, otherwise the goal's id, revision, objective, phase, rounds started, round cap, optional blocker reason, and whether continuation is armed — matching what Native callers already render.

| Tool | What it does |
|---|---|
| `get_goal()` | Reads the current goal, or `null` when none is current |
| `create_goal(objective, max_goal_rounds?)` | Creates one goal from a direct top-level human turn |
| `update_goal(goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?)` | `edit`, `pause`, `resume`, `complete`, or `blocked` on the exact goal revision |

Call `get_goal` before `update_goal` and copy the exact `goal_id` and `revision`; all calls are exclusive, so a model-ordered batch observes earlier mutations and their new revisions. Replacements belong only to `edit`; `blocked_reason` is required only for `blocked` and is persisted with the stable code `model-reported`. Strict-schema empty-string and zero fillers count as omitted, while meaningful values remain limited to their action.

### Configure it

```yaml
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
  config:
    blockedAfterConsecutiveRounds: 3
    blockedReasonPolicy: |
      A blocked_reason must name a condition external to you that is reproducible from the workspace: access the
      environment denies, a credential or decision only a human can supply, or a product requirement that cannot
      be satisfied. Your own capacity is never a blocker, and neither are context or token budget, session length,
      difficulty, change size, remaining work, or a request for a fresh session. If the only obstacle is the size
      of a change, start it and shrink the first step.
```

`blockedAfterConsecutiveRounds` must be a positive safe integer. It supplies both the hard lower bound on model self-blocking and the number named in model guidance. `blockedReasonPolicy` is the policy text appended to that guidance, and supplying it also turns on the capacity screen: the executor refuses a reason the policy does not permit. An empty or absent value appends nothing and screens nothing. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-goal) is the exhaustive source for every accepted field.

### Authority rules

The tools execute only for the exact live calling agent inside its active driver with an open turn. `create`, `edit`, `pause`, and `resume` additionally require a direct human message in a runtime-root agent's current turn — a subagent or a non-human producer cannot create or edit goals. `resume` rejects a durable paused goal before the goal service runs; that state belongs to the user-facing resume path. `complete` and `blocked` also accept the exact current goal round: a goal-sourced round may complete the goal immediately, but a blocked call is mechanically rejected until the configured number of consecutive rounds has passed — the model judges whether the same condition actually persisted and must describe it in `blocked_reason`. A direct human request may stop a goal immediately.

An autonomous round that successfully reports `complete` or `blocked` also ends the physical turn after that step, and the model receives a closing instruction to write the final message to the user. Direct-human mutations never trigger that stop: the assistant may acknowledge the change and the loop keeps concurrent human steering available.

With `blockedReasonPolicy`, a `blocked_reason` that names the agent's own capacity — context, tokens, budget, compaction, session length, exhaustion, or a fresh session — is rejected with `GOAL_TOOL_BLOCK_REASON_CAPACITY` unless the same text also names a condition external to the agent. The screen is vocabulary-based: it proves what the wording names, not whether the obstacle is real, so semantic judgment stays with the model, and a policy that permits nothing the screen accepts leaves the model unable to block. Without the setting, any non-empty reason is accepted.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tools enforce authority and render output; the observable contract is covered in [Use this package](#use-this-package).

### Design

- **Authority at execution.** Every call resolves the exact live agent, its inherited `AgentRegistry` initiator, running status, and an open turn; `create`, `edit`, `pause`, and `resume` additionally require an accepted `{ kind: 'user' }` message or steering event in a runtime-root agent's current turn. A durable paused goal fails the `resume` action with `GOAL_TOOL_RESUME_PAUSED`; the user-facing command or Web control owns that transition. Durable fork lineage does not demote a resumed root; live subagent ownership does.
- **Host attestation of human input.** `{ kind: 'user' }` is assigned by `Agent.followup()` and `steer()` when their caller omits a source, so plugins, schedulers, and other non-human producers must pass their own source rather than inheriting human authority.
- **System-prompt guidance with the configured threshold.** The package registers one `tool:goal` system-prompt section whose fixed text interpolates `blockedAfterConsecutiveRounds`; the same value is the hard lower bound enforced at execution. `blockedReasonPolicy` is appended verbatim to that text.
- **Capacity screening before the round threshold.** With `blockedReasonPolicy`, `blocked_reason` is matched against a capacity vocabulary and against external-condition vocabulary; a reason that names capacity without naming an external condition fails with `GOAL_TOOL_BLOCK_REASON_CAPACITY` before the round-count gate, so a self-capacity excuse is corrected in the round that reports it.
- **Wrap-up context for terminal rounds.** A successful autonomous `complete` or `blocked` defers a closing `<goal_complete>` or `<goal_blocked>` instruction so the model addresses the user once before the turn ends; direct-human mutations never defer this context.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: tool registration, config, system-prompt section, result rendering |
| [`src/authority.ts`](src/authority.ts) | Execution-time authority checks and goal-round acceptance |
| [`src/blocker.ts`](src/blocker.ts) | Capacity and external-condition vocabulary for `blocked_reason` |
| [`src/wrapup.ts`](src/wrapup.ts) | Closing-message instruction for terminal autonomous updates |
| — | No runtime invariant companion is published; this model-facing adapter owns no independent state or event protocol; accepted mutations are checked by the goal domain and authority behavior is package-tested. |

### Tool output

All three tools share one canonical output: the compact JSON `{ goal: null }` or `{ goal: { id, revision, objective, phase, roundsStarted, maxGoalRounds, blockedReason? }, activation }`. `activation` in a result is a live observation and never becomes replay authority. UI clients receive pure generic cards — read for `get_goal`, other for mutations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The tools are the model-facing half of the goal surface; read these pages for the state they mutate and the policy they defer to.

- [Goal service](../goal/README.md) — the goal state and lifecycle the tools mutate.
- [Goal group map](../README.md) — the goal packages and how they compose.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-goal) — the exact schemas the model receives.
- [Goal-tool Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-model-facing-goal-tools.md) — the authority split and UX decisions.
- [No self-capacity blockers Agent Note](../../../.agents/notes/implemented/feature/2026-09-19-no-self-capacity-blockers.md) — the permitted blocker reasons and the capacity screen.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

A fixed goal policy allows inferring goal intent in any language, explains rearming after resume/fork, and limits completion/blocking claims; creation scope and read-before-update refs live in the tool definitions. `blockedReasonPolicy` continues that policy with the deployment's own permitted-reason rules. Durable paused resume is rejected at execution with `GOAL_TOOL_RESUME_PAUSED`; the user-facing goal control owns that transition. The configured threshold is interpolated into that guidance.

##### Goal policy

```markdown
create_goal may infer goal intent from a direct human request in any language. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least 3 consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.
```

##### Permitted blocker reasons (blockedReasonPolicy)

```markdown
A blocked_reason must name a condition external to you that is reproducible from the workspace: access the environment denies, a credential or decision only a human can supply, or a product requirement that cannot be satisfied. Your own capacity is never a blocker, and neither are context or token budget, session length, difficulty, change size, remaining work, or a request for a fresh session. If the only obstacle is the size of a change, start it and shrink the first step.
```

#### Token effect

Small fixed input cost on every request where this plugin's prompt registration is in scope.

#### KV Cache effect

Prefix-stable while the plugin scope, configured threshold, and guidance text are unchanged. Activation, disposal, or configuration changes may invalidate reuse from this prompt section.

### Tool schemas and results

#### What the model sees

The generated [`get_goal`, `create_goal`, and `update_goal` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-goal). Successful results are compact JSON. A mutation appends the goal domain's durable `goal/change` event without queuing model context. `activation` in a result is a live observation and never becomes replay authority.

#### Token effect

Fixed schema cost plus one compact result per call. The durable mutation adds no separate model-visible context.

#### KV Cache effect

Schemas are prefix-stable while their definitions and visibility are unchanged. Calls and results append after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the goal tools are a poor fit or need special care. They are current package constraints, not a task backlog.

- **Semantic intent remains model judgment** — execution can prove that the current turn contains a direct human message, not whether the request is substantial enough to merit a goal.
- **Same-condition blocking remains model judgment** — the runtime enforces distinct admitted-round count, not semantic equivalence of obstacles; an independent evaluator is deferred.
- **Capacity screening follows the supplied policy and is vocabulary-based** — without `blockedReasonPolicy` a deployment accepts any non-empty reason. When text is supplied, the screen proves that a rejected reason's wording names capacity without naming an external condition; a reason that mentions capacity beside an external-sounding phrase passes, and a genuine blocker phrased with capacity vocabulary can be refused until the model re-reports it in external terms. The policy text and the vocabulary are independent: the text is documentation for the model, the vocabulary is what execution enforces.
- **No scheduling or direct human rendering** — these tools mutate state only; the same-session driver and `dsh-command-goal` are independent consumers of the same domain.
- **Goal-round authority requires a driver** — the autonomous `complete`/`blocked` path is dormant unless a continuation driver admits goal-sourced user turns; mounting this tool package alone does not create them.
- **Prompt registration is independent of filtering** — a scope may hide the tools while retaining their guidance unless the deployment scopes both registrations together.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open question: whether the goal-policy section should be independently scoped from the tool registrations, so a scope cannot hide the tools while keeping the guidance.

</details>

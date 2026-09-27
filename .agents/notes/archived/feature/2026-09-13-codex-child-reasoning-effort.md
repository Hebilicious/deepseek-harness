# Agent Note: Codex child reasoning effort

Status: implemented
Archived: 2026-09-24

English | [中文](2026-09-13-codex-child-reasoning-effort.zh.md)

## Problem

The [Codex subagent provider](../../../../packages/subagent/subagent-codex/README.md) could fix a child's model, permission mode, environment, and disposal grace, but not its reasoning effort. Effort therefore came from whatever Codex resolved for itself: the user's `~/.codex/config.toml`, overridden by the delegated project's `.codex/config.toml`, as `thread/start` reports in `reasoningEffort`.

That left a delegation wanting a different effort than the interactive Codex session with only bad options. Pointing the provider row at a second `CODEX_HOME` makes the child read different configuration, but that home needs its own authentication, and its `auth-locks` directory sits beside a different copy of the account token. Setting the effort in the shared `~/.codex/config.toml` changes every interactive Codex session instead.

The [product subagent backends](2026-08-04-claude-code-and-codex-subagent-backends.md) note owns the provider's existing shape: one fresh process, thread, and turn per run, with native Codex configuration authoritative. The [credential records and authorization flows](../architecture/2026-08-13-credential-records-and-authorization-flows.md) note owns why the harness does not read another tool's credential file.

## Decision

`@deepseek-ai/dsh-subagent-codex` accepts an optional non-empty `reasoningEffort` and sends it as the `effort` field of the run's single `turn/start`. Model and thread fields stay where they were: `thread/start` carries `cwd`, `ephemeral`, the optional `model`, and the selected permission mode.

The field is the pinned protocol's own per-turn override, described by the generated schema as "Override the reasoning effort for this turn and subsequent turns". One run is one turn in one thread, so a per-turn override is exactly the provider instance's scope, and no second Codex home is needed to state it. Omission sends no field, which leaves Codex's own resolution in force.

The value is a free-form non-empty string, matching the protocol's `ReasoningEffort` (a non-empty reasoning effort value advertised by the model) and the existing `model` field. The provider does not discover effort levels, rewrite spellings, or fall back.

## Alternatives considered

- **A second `CODEX_HOME` per effort.** It works today and was the interim setup, but the child then owns separate Codex state and separate authentication. Sharing the account token by symlinking `auth.json` gives two homes one file with two `auth-locks` directories, so concurrent refreshes have no mutual exclusion; copying it creates a second refresh lineage that can invalidate the first.
- **Setting `config.model_reasoning_effort` on `thread/start`.** The protocol accepts arbitrary config overrides there and reports the resolved value back in `ThreadStartResponse.reasoningEffort`, which is observable. It is a raw configuration escape hatch rather than a typed field, and a renamed config key would silently do nothing.
- **Requiring an effort to be one of a fixed set.** The protocol does not constrain it, the model advertises its own levels, and the provider does not discover models; a fixed list would reject newer levels and still not verify that a model honors them.
- **Leaving the effort to native configuration only.** It keeps the provider smaller, but a delegation cannot then differ from the interactive Codex session, which is the whole point of the setting.

## Consequences

A Profile row pins the child's effort without touching `~/.codex/config.toml`, the delegated project's Codex configuration, or a second Codex home. The provider reports a `turn/start` failure under the same coarse categories as before, and the effort rides the same validated text-only turn.

Because the protocol accepts any non-empty string, a misspelled level reaches Codex unvalidated. The provider does not detect what the server did with it, so the README states the values the target model advertises rather than pretending to check them.

## Testing

The provider suite pins the config schema (a non-empty value is accepted, an empty one is rejected) and runs one full delegated start with `reasoningEffort: 'max'` against the fake app-server, asserting the `turn/start` payload carries `effort: 'max'` while `thread/start` carries none. The existing exact-payload wire test continues to assert that an unconfigured wire sends no `effort` field.

A pair of live probes against the pinned 0.153.4 app-server established the mechanism before implementation: `turn/start` accepts `effort` under `experimentalApi: false`, and `thread/start` reports the effort Codex resolved from native configuration, which is what a configured value overrides.

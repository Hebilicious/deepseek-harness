# Agent Note: Model picker filter and pinned models

Status: implemented

English | [中文](2026-09-16-model-picker-search-and-pins.zh.md)

## Problem

The composer's model menu lists every model the loaded catalog advertises, grouped by provider. A deployment with several providers and dozens of ids makes finding one model a scrolling exercise, and a user who alternates between a few models re-finds them on every switch. The `/model` popup can rank its rows through the command palette; the composer seat had no such ranking and no shortcut at all.

## Decision

The seat's `model` pane gains a filter field and a per-row favourite toggle. The filter is component-local state: it is present only while the menu is open, cleared on open, close, and back, and matches a row when the typed text is a case-insensitive substring of the model's display name, its provider-owned id, or its provider name. Catalog descriptions do not participate, because the list renders names. A filter that matches nothing reports the typed text; Escape clears a non-empty filter before the pane's existing back-out and close steps. The field takes focus on entry, so typing filters immediately, and Arrow Up/Down leave it for the rows; `moveFocus` now enters a list that holds no focus at its near end instead of the second row.

The model pane keeps one size while filtering. The card hangs off the composer trigger, so a width or height that followed the visible rows would move those rows out from under the pointer on every keystroke; the pane therefore takes a fixed 360px card, and only its row list yields to that height while the field, the load strips, and the empty message keep their own size in the column layout. The field follows the client's other catalog filters: a 36px box whose 10px radius matches the rows, with the icon inset and the text column clear of the native clear button.

Every model row is one option button plus a sibling favourite button, since a button cannot nest inside the option button; a pin click therefore never selects the model. A pinned model is repeated in a Pinned section above the provider groups, in the order it was pinned and labelled with its provider under the name, while its provider group keeps the complete list of what that provider serves. The provider label is part of the pinned row's accessible name (`option.providerAria`), because content order alone would run the two labels together. Pins the catalog no longer serves simply do not render; the stored key survives for a provider that comes back.

Pin state is the one browser-wide fact this plugin owns. [`apply`](../../../../packages/client/ui-model-selection/src/client/index.ts) creates a single `createModelPinsStore()` instance and hands it to every session's seat through the inject `hooks` compartment, which the renderer binds as `useModelPins`; writes go through the `togglePin` face verb. Pins are not derived from a session, so they stay outside Session projections, following [the projection-ownership decision](../../implemented/architecture/2026-08-25-session-observations-and-projection-owned-client-state.md). [`pins.ts`](../../../../packages/client/ui-model-selection/src/client/pins.ts) owns the durable format (a `{ pinned: string[] }` JSON object under the `dsh.model-pins` localStorage key) and validates it on read, instead of `createSnapshotStore`'s own `persist` option, which installs whatever JSON the browser holds. Storage failures disable persistence only: the in-memory list stays authoritative for the page, matching the store engine's contract.

The favourite glyphs (`IconStarOutline16`, `IconStarFill16`) live in [ui-primitives](../../../../packages/client/ui-primitives/src/icons/index.tsx) with the rest of the `ic_ds_*` set. The `/model` popup, its own ranked surface, gains neither affordance.

## Alternatives considered

**Moving a pinned model out of its provider group.** A group would then no longer list what its provider serves, and a pinned model would be invisible to anyone scanning providers. Repeating the row keeps both properties and makes the Pinned section a shortcut rather than a relocation.

**Per-session pins through the slot's declared store seat.** The seat is session-scoped, so the framework materializes one store instance per session scope and the persist key gains the session suffix: "pinned" would mean a different list in every conversation, which is not what a favourite is.

**Reusing the store engine's `persist` option for the pin list.** It deletes the read/write pair, but its rehydration path accepts any JSON under the key, so a hand-edited or older entry could put a non-list into render state and break the composer. The owning module validates at the durable boundary instead.

**A host-side settings document for pins.** It would travel across browsers and profiles, at the cost of a settings namespace, an RPC round trip, and its own migration for a presentational shortcut. Deferred; the package README records per-browser pins as a known limitation.

**A separate client package for the pin list.** The list is read by one seat and written by one verb; a package boundary would add a manifest, boot row, and store plumbing for a few dozen lines.

## Consequences

Pins are per browser: another browser, profile, or device starts unpinned, and nothing in a session, the model selection, or the session log carries them. The plugin's published runtime invariant is unchanged (no `./invariant` companion): the pin store is plugin-private, and the existing HMR-safety spec still covers the registration it disposes.

New copy is locale-owned in the `model` namespace: `search.label`, `search.placeholder`, `group.pinned`, `option.providerAria`, `pin.add`, `pin.remove`, and `empty.search`. Nothing here is model-visible, so no session event or recorded-session snapshot changes; the site's `/model` popup and the selection contract are untouched.

Coverage: [`model-select.client.spec.tsx`](../../../../packages/client/ui-model-selection/tests/model-select.client.spec.tsx) drives filtering (name, id, provider, no match, Escape, ArrowDown entry), pin order, filtering of the pinned section, the accessible provider label, and that the toggle does not select; [`pins.client.spec.ts`](../../../../packages/client/ui-model-selection/tests/pins.client.spec.ts) covers the durable format's malformed, foreign, and refusing-storage paths; [`browser-plugin.client.spec.ts`](../../../../packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts) proves one pin store is shared across sessions. The assembled browser is pinned by [`model-picker-filter.e2e.ts`](../../../../apps/web/tests/model-picker-filter.e2e.ts), whose goldens record the filtered rows and the pinned section above the intact provider groups for a catalog the Host really serves. Sticky-heading behavior and the toggle's hover treatment remain demonstrated by the recorded GUI artifact rather than asserted.

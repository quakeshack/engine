---
name: event-bus-docs-sync
description: Use when an eventBus event is added, renamed, removed or its arguments change (publish/emit/subscribe). The event must be in the typed map and in docs/events.md (engine) or the game's own docs/events.md; the Arguments and description columns are checked by nothing.
---

# Event bus docs sync

`event-bus.instructions.md` states the policy: engine-published events are documented in
`docs/events.md`; a game module's own events go in that module's own
`source/game/<mod>/docs/events.md` (see `id1`/`hellwave` for examples), linked from
`docs/events.md`'s "Game Events" section rather than duplicated into it. Nothing mechanically
enforces this — the files are hand-maintained tables, so they drift every time an event is
added, renamed, or has its argument list changed without a matching edit.

## Engine events and game events are both checked

An engine event lives in three places that have to agree: `EngineEventMap` and `engineEventTable` in
`source/shared/EngineEvents.ts`, and a row in `docs/events.md`. `publish` and `subscribe` are typed by the map, so
`npm run typecheck` fails for a name or argument it does not know, and `test/common/event-map-docs.test.ts` fails when
the table and the document name different events. The *Arguments* column and the description are still yours to keep
right.

A game's own events are declared in the game's `Events.ts` (an interface of name to argument tuple, plus a list of the
names), published and subscribed through its `serverEvents(engine)`/`clientEvents(engine)` helper, and the game's own
test (`test/core/events-docs.test.ts` in id1) fails when its `docs/events.md` names other events. A new game event is
added to the interface, to the name list (or, for a client event, to `clientEvent` and `Id1ClientEventArguments`), and
to the document; the compiler and the test tell you which one you forgot.

## Fast path

0. **For an engine event, start at `source/shared/EngineEvents.ts`:** add or change the tuple in `EngineEventMap`, add the
   name to `engineEventTable` with its flags (`clientGame`: reaches the client game's buses, `serverGame`: the server
   game's bus, `crossesWorker`: the server worker forwards it and its arguments must be structured-cloneable). The
   compiler tells you every call site.
1. Identify the event name(s) touched by the current change (`eventBus.publish(...)`,
   `eventBus.emit(...)`, or a new `.subscribe('some.event', ...)` call that implies a
   producer elsewhere).
2. Identify which doc owns it: if the publishing code lives under `source/engine/`, it's
   `docs/events.md`. If it lives under `source/game/<mod>/`, it's
   `source/game/<mod>/docs/events.md` — create that file (mirroring the format in
   `source/game/id1/docs/events.md`) if the module doesn't have one yet, and add a link to it
   from `docs/events.md`'s "Game Events" section.
3. Check the owning doc for a matching row:
   ```bash
   grep -n "<event.name>" docs/events.md source/game/*/docs/events.md
   ```
4. **If missing:** add a row to the relevant `###` section table (`| event.name | args |
   description |`). If no section fits (e.g. a new `nav.*` family in the engine doc), add a
   new `###` heading following the existing pattern — don't bury unrelated events under an
   existing section just to avoid adding a heading.
5. **If the event already exists but the payload changed:** update the `Arguments` column
   to match, not just the description.
6. Remember both engine buses carry the same event set — `ClientEngineAPI.eventBus` and
   `ClientEngineAPI.moduleEventBus` differ only in per-connection vs. module lifetime (see
   `event-bus.instructions.md`), not in which events exist. Document the event once; don't
   duplicate an entry per bus.
7. If the event is published by `source/game/id1/`, remember that's a separate git submodule
   (`game.git`) — the doc edit needs its own commit inside `source/game/id1`, not the outer
   engine repo commit (see the `submodule-aware-commit` skill).

## What this skill does NOT do

- Does not audit the entire file for pre-existing drift as a side effect of an unrelated
  change — only check the event(s) the current task actually touches. A full-file audit is
  a separate, explicit task (compare `grep -rhoE "eventBus\.(publish|emit)\(['\"][a-zA-Z0-9_.\-]+" source --include='*.ts'`
  output against the doc's rows) if the user asks for one.
- Does not change event-bus behavior. The *Arguments* and description columns are the only part nothing checks.

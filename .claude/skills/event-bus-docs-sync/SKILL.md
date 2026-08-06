---
name: event-bus-docs-sync
description: Use whenever a task adds, renames, removes, or changes the arguments of an eventBus event — a new eventBus.publish()/emit() call, a new subscribe() for an event not seen before, or an edit to an existing event's payload. event-bus.instructions.md requires every event to be documented, in docs/events.md for engine events or source/game/<mod>/docs/events.md for that game's own events, but nothing else enforces it, so these docs drift silently. Check it every time an event changes, not just when asked to update docs.
---

# Event bus docs sync

`event-bus.instructions.md` states the policy: engine-published events are documented in
`docs/events.md`; a game module's own events go in that module's own
`source/game/<mod>/docs/events.md` (see `id1`/`hellwave` for examples), linked from
`docs/events.md`'s "Game Events" section rather than duplicated into it. Nothing mechanically
enforces this — the files are hand-maintained tables, so they drift every time an event is
added, renamed, or has its argument list changed without a matching edit. A prior audit found
real drift: `docs/events.md` had no `### Game` or `### Nav` section at all, so every `game.*`
and `nav.*` event was completely undocumented despite being actively published. Treat that as
evidence this needs an active check, not a one-time cleanup.

## Fast path

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
- Does not change event-bus behavior or add validation code — this is purely a
  documentation-sync check, not a request to build a schema/lint enforcement mechanism.

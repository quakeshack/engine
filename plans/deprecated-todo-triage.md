# Deprecated markers & TODO/FIXME triage

**Status:** Tier 1, Tier 2b/2c, and Tier 3 are done (see below). Tier 4's `GL.Bind` item is done
(see `plans/gl-bind-render-texture-refactor.md`). Tier 2a (`EntityIndex`) and the rest of Tier 4
are still open. **2026-08-24: fresh full re-sweep (Tier 5) found two real bugs (Tier 5a) plus a
new appendix covering all 79 TODO/FIXME comments currently in `source/`** — see below.

## Context

A sweep of `source/` for `@deprecated`/`DEPRECATED` and `TODO`/`FIXME` turned up 14 deprecated
markers and 84 TODO/FIXME comments. Most are small and independent of each other. This doc
triages them into tiers so we can pick off high-value work without turning it into one giant
PR. `CL.ts`/`V.ts` cleanup (the `cshift` deprecation, self-reference style, etc.) was scoped
separately per `plans/cl-ts-structure-cleanup.md` (now ✅ done — verified 2026-08-24) and is
excluded here.

## Tier 1 — Dead code, safe to delete now ✅ done

Verified zero call sites outside their own declaration:

1. **`Pmove.ts:2193-2198`** — `Pmove.DIST_EPSILON`, `Pmove.STOP_EPSILON`, `Pmove.STEPSIZE` static
   aliases, each tagged `@deprecated import ... instead`. No callers anywhere. Deleted the three
   aliases.
2. **`Draw.ts:397`** — `LoadPicFromFileDeferred`, tagged `@deprecated not implemented yet`. Zero
   callers, and the body is a stub. Deleted the method.
3. **`MiscHelpers.ts:172`** — `Flag<EnumMap>` class, tagged `@deprecated Please do not use.`. Zero
   usages anywhere in `source/`. Deleted the class (this file lives in the `id1` submodule — the
   change was made in the submodule's own working tree, needs its own commit there).
4. **`Host.ts:266`** — `Host.dedicated` cvar was tagged `@deprecated`, but it's not actually
   removable: no engine code reads it (confirmed), yet it exists specifically so game code — which
   cannot import `registry` directly per the architecture rules — can still query dedicated-server
   status by cvar name. The `@deprecated` tag was misleading; replaced it with a comment explaining
   why the cvar must stay.

Verified via `npx tsc --noEmit`, `eslint --fix`, and the full `npm test` suite (1275 tests) —
all green.

## Tier 2 — Half-finished migrations (real work, not just deletion)

### 2a. `EntityIndex` — the most impactful finding

`source/game/id1/helper/EntityIndex.ts` defines **two** classes:

- `EntityIndex` (exported default, wired into `GameAPI.ts:275` as `readonly entityIndex = new
  EntityIndex()`) — every method (`reindexEntity`, `freeEntity`,
  `findAllEntitiesByFieldAndValue`) has an **empty body**. It's a no-op.
- `EntityIndexWIP` — a complete, correct `Map<string, Set<BaseEntity>>`-backed implementation of
  the exact same interface, tagged `// TODO: implement properly, this is a work in progress`, but
  never imported or instantiated anywhere.

Meanwhile `GameAPIs.ts:644` has `// TODO: optimize lookups by using maps for fields such as
classname, target, targetname`, and both `FindByFieldAndValue` (deprecated) and
`FindAllByFieldAndValue` still do an O(n) linear scan over every edict — exactly the problem
`EntityIndexWIP` already solves. Right now the engine pays the cost of maintaining the index
(`reindexEntity`/`freeEntity` are called from `BaseEntity.ts:727` and the `@indexed`-style field
setter in `MiscHelpers.ts:525-526`) but gets zero benefit from it, since the live class is the
no-op and nothing calls `findAllEntitiesByFieldAndValue` at all.

**Plan:**
- Replace the no-op `EntityIndex` body with `EntityIndexWIP`'s implementation; delete
  `EntityIndexWIP`.
- Wire `GameAPIs.FindAllByFieldAndValue` (and by extension the deprecated
  `FindByFieldAndValue`) to consult `SV.server`'s game entity index for common indexed fields
  (`classname`, `target`, `targetname`) instead of the linear scan, falling back to the scan for
  fields that aren't indexed.
- Add unit tests — there are currently **zero** tests for `EntityIndex` despite it now becoming
  load-bearing. Cover: reindex on field change, free removes from all buckets, lookup by value,
  lookup for a never-indexed field returns `[]`.
- This closes one `@deprecated`, one `FIXME`, and one `TODO` in a single, well-scoped change.

### 2b. `.texnum` deprecated getter (`GL.ts:633`) ✅ done

Of the 4 remaining call sites:

- `SpriteSPRLoader.ts`/`SpriteModel.ts`/`SpriteModelRenderer.ts` were storing the raw handle in a
  redundant `texturenum: WebGLTexture | null` field even though the same frame object already
  carried the full `GLTexture` in its `glt` field (which was otherwise write-only — never read).
  Deleted `texturenum` entirely; `SpriteModelRenderer` now calls `frame.glt.bind(...)`, matching
  the pattern `AliasModelRenderer` already uses (`skin.texturenum!.bind(...)`, a differently-named
  but equivalent field holding a full `GLTexture`).
- `Draw.ts:77` had the one genuine remaining need for the raw `WebGLTexture` handle
  (`gl.framebufferTexture2D(...)`), which isn't expressible through `.bind()`. Added
  `GLTexture.attachToFramebuffer(attachmentPoint)` to encapsulate it instead of exposing the raw
  handle. `Draw.BeginTexture` now calls `texture.attachToFramebuffer(gl.COLOR_ATTACHMENT0)`.
- Deleted the `.texnum` getter — zero remaining callers.

Verified via the full `npm test` suite (renderer + common suites) and `tsc --noEmit`.

### 2c. `nav_save_waypoints` cvar (`Navigation.ts:429`) ✅ done

Confirmed nothing in `Navigation.ts` ever reads `.value` on this cvar (waypoints are
unconditionally excluded from nav-file serialization per the comment at `Navigation.ts:740`,
"waypoints are build-only debug data and are intentionally not serialized" — this happens
regardless of the cvar). Removed the cvar registration and its static field declaration. Also
removed the now-meaningless `Navigation.nav_save_waypoints = { value: ... }` mock setup from all
13 call sites in `test/physics/navigation.test.mjs` (including the one that set `value: 1` — that
test, "does not persist extracted waypoints into nav files", still validates real behavior and
was kept, just without the dead cvar mock).

Note: a dedicated-server config that still sets `nav_save_waypoints` will now get an "Unknown
command" console print on load instead of being silently accepted — a minor, acceptable trade-off
for removing an inert cvar.

Verified via `npm run test:physics` (254 tests, all passing) and `tsc --noEmit`.

## Tier 3 — Correctness-risk FIXMEs (worth a real look, not just cleanup) ✅ done

These were marked FIXME by whoever wrote them, specifically because they suspected a bug, not
just because the code was ugly. Each one got a full read-through against the original vanilla
Quake C semantics (this engine's collision/physics/shutdown code is a close port of WinQuake's
`sv_phys.c`/`sv_world.c`/`host_cmd.c`) before deciding whether to change behavior or just
document why the code is already correct.

1. **`Host.ts:381` (`ShutdownServer`) — real bug, fixed.** The client-message-flush loop's retry
   branch (`NET.GetMessage(...); count++;`) was ported verbatim from vanilla's UDP driver, where
   `CanSendMessage` returning false means "reliable window full, pumping GetMessage will drain an
   ack and unblock it shortly." None of this engine's actual transports (`WebSocketDriver`,
   `WebRTCDriver`, `LoopDriver`) have that semantics — their `CanSendMessage` only ever returns
   false when the connection has already finished closing, a state pumping `GetMessage` can never
   change. The `do...while(count !== 0)` loop would therefore retry every shutdown-time client
   whose connection happened to already be dead, for the full 3-second timeout, accomplishing
   nothing. Confirmed experimentally: with a `Sys.FloatTime` mock that doesn't advance (simulating
   how little wall-clock time this busy loop actually needs to spin), the pre-fix code ran for
   3-7 seconds of pure CPU spin until `Array.push` overflowed the JS max array length — i.e. this
   was an effectively-infinite loop, not just an occasional 3-second stall. Fixed by skipping
   clients whose `netconnection.state` is `QSocket.STATE_DISCONNECTED`/`STATE_DISCONNECTING`
   instead of counting them as still-pending. Added `test/common/host-shutdown.test.mjs` (5 tests)
   covering the fix; verified the new regression test actually fails (hard, via the array-overflow
   crash above) against the pre-fix code.
2. **`ServerArea.ts:175` (`hullForEntity`) — correct as-is, FIXME replaced with rationale.** This
   is a verbatim port of vanilla Quake's `SV_HullForBox`, which also mutates a single shared
   static `box_hull`/`box_planes` pair rather than allocating fresh ones per call — for the same
   reason (this runs once per candidate entity for every trace against a non-BSP entity, a very
   hot path). Traced every caller: `hullForEntity`'s result is always consumed synchronously and
   fully copied out (`recursiveHullCheck` copies plane `normal`/`dist` values into the returned
   `CollisionTrace`, never aliases them) before control returns to anything that could call back
   in and mutate the shared state again. No async gaps, no re-entrancy path found. Replaced the
   FIXME with a comment documenting why it's safe and what invariant a future change must
   preserve.
3. **`ServerPhysics.ts:477` (pusher moved-list restore) — correct as-is, FIXME replaced with
   rationale.** Compared against vanilla's `SV_Push`, which restores this same list in *reverse*
   order (`for (p=pushed_p-1 ; p>=pushed ; p--)`) while this port iterates forward. Traced through
   why: each entry's restore is independent (each just re-applies its own captured
   pre-move `origin`/`angles` and relinks itself into the area tree; relinking one entity doesn't
   read or affect any other entity's state), so the direction of iteration cannot change the
   outcome. Replaced the FIXME with a comment explaining the order-independence and the
   already-faithful match to vanilla's `touchTriggers` flag usage (`true` for the entity that
   caused the block, `false` for the rest — verified this was already correct).
4. **`NetworkDrivers.ts` WebRTC/WebSocket error logging — real (minor) bug, fixed, plus one more
   instance found in passing.** The signaling `WebSocket.onerror` and the two `RTCDataChannel.onerror`
   handlers (`:1390`, `:2001`, and a third at `:2138` in `#SetupOobChannelHandlers` with the
   identical pattern, not originally flagged but fixed for consistency) all interpolated the raw
   event object into a log message, producing `[object Event]`/`[object RTCErrorEvent]` with an
   `eslint-disable` to silence the linter about it. Fixed by: for the WebSocket case, the DOM spec
   deliberately withholds detail on `Event` objects, so the message now just notes that the
   `onclose` handler (which fires immediately after and already prints the real code/reason) has
   the actual diagnostic info; for both `RTCDataChannel.onerror` cases, `RTCErrorEvent.error` (an
   `RTCError extends DOMException`) actually carries `.message` and a WebRTC-specific
   `.errorDetail`, so those are now logged directly instead of being discarded.

Verified via the full `npm test` suite (1280 tests, all passing — 5 new) and `tsc --noEmit`.

## Tier 4 — Needs a design decision before work starts

- ~~**`GL.ts:95` `GL.Bind`**~~ ✅ done. Turned out to affect `GL.Bind3D`/`BindArray`/`BindCube` too
  (same problem, just untagged) — all four static methods bound raw `WebGLTexture` handles owned
  by render-target/effect code (`R.ts` lightmaps, `PostProcess.ts` scene/ping-pong buffers,
  `ShadowMap.ts` depth textures, `BloomEffect.ts`/`BlurEffect.ts` buffers, `BrushModelRenderer.ts`
  fog light probes) with no owning class. Added four thin wrapper classes to `GL.ts`
  (`GLRenderTexture`, `GLVolumeTexture`, `GLTextureArray`, `GLCubeTexture`) sharing one bind-cache
  implementation, migrated every one of the ~104 call sites across 12 files (plus the
  `apply(inputTexture)` contract shared by all `PostProcessEffect` subclasses), and deleted all
  four static methods. Full design and phase-by-phase history in
  `plans/gl-bind-render-texture-refactor.md`. Verified via `tsc --noEmit`, `eslint`, and the full
  `npm test` suite (1280 tests passing) after every phase.
- **`Cvar.ts:23,110,203`** — three related TODOs: `onChange`/`onPreChange` hooks, `Cvar.FLAG.DEFERRED`
  support, and min/max clamping. These are cvar-system feature gaps rather than bugs. Worth
  bundling into one small design pass since they touch the same class, but should be scoped
  deliberately rather than picked up opportunistically (other code may start depending on
  ordering/timing of change hooks once they exist).
- **`MenuItem.ts:893` (`FIXME: what's 96?`) and `Keys.ts:8-10` (`TODO: 96`, `110`, `121`)** — three
  unidentified/unnamed keycodes recur in both files. Likely the same underlying gap (numpad or
  international keys never mapped in the `K` enum). Worth resolving once, in one pass, rather than
  separately.

## Tier 5 — 2026-08-24 fresh full re-sweep

A complete re-grep of `source/` (`grep -rn "TODO\|FIXME"`, all `.ts`/`.mjs`/`.js`) turned up 79
current occurrences across 40 files (down from the original 84 — Tier 1/3 deletions account for
the difference). Every one was read in context and checked against actual call sites, not just
re-listed. Two real bugs surfaced that the original comment wording undersold; both are cheap,
scoped fixes.

### 5a. Correctness/integrity bugs — worth fixing now, not just cataloging

1. **`server/Com.ts:155` (`WriteFile`) — real bug, not stale.** The FIXME reads "len is actually
   required, needs to be async" and looks at a glance like a leftover from before the method was
   made `async` (it already is, and `_len` already has the `_`-prefix-for-unused convention
   applied — easy to misread as resolved). It isn't. The base/browser implementation
   (`common/Com.ts:296`) genuinely uses `len` to truncate `data` to exactly `len` bytes
   (`new Uint8Array(len)` + a copy loop) before persisting. The dedicated-server override ignores
   `_len` entirely and does `Uint8Array.from(data)` — the *whole* array, not just the first `len`
   bytes. The one real caller, `ClientDemos.stopRecording()` (`ClientDemos.ts:252`), always passes
   an oversized buffer: `this.demofile` is grown in 16KB chunks (`ClientDemos.ts:56,222`,
   `new ArrayBuffer(currentFile.byteLength + 16384)` / `new ArrayBuffer(16384)`) and `this.demoofs`
   is the actual bytes used, always ≤ the buffer's real length. **Every demo recorded while running
   as a dedicated server gets written with up to ~16KB of trailing zero-padding past the intended
   end of the file** — the browser/listen-server path doesn't have this bug, only the dedicated
   path does. Fix: truncate to `_len` the same way the base implementation does (e.g.
   `Uint8Array.from(data).subarray(0, _len)` or a copy loop), rename `_len` back to `len`, drop the
   FIXME.
2. **`Host.ts:2064,2073` (`eb_topics`/`eb_publish`) — real gap, not cosmetic.** Both TODOs read "do
   not allow this command when server is having cheats disabled," which undersells it — this isn't
   a nice-to-have, it's a gap relative to an existing, consistently-applied pattern. Every other
   debug/admin command in the same file (`God_f`, `Noclip_f`, `Fly_f`, all `Host.ts:829-940`) is a
   `HostConsoleCommand` subclass that calls `this.cheat()` (`Host.ts:154` — gates on
   `SV.cheats.value`, prints "Cheats are not enabled on this server." otherwise) before doing
   anything. `eb_topics`/`eb_publish` are plain anonymous `ConsoleCommand` subclasses (not
   `HostConsoleCommand`) and skip the gate entirely, despite the TODO already naming the fix.
   `eb_publish` lets any caller fire *any* registered event-bus topic with arbitrary string args on
   demand — including real lifecycle events like `server.shutting-down`, `server.spawning`,
   `server.client.connected/disconnected`, `host.crash` (confirmed via
   `grep -rn "eventBus.publish('server\.\|'host\."`). Whatever is subscribed to those topics reacts
   as if the real event happened. Fix: change both classes to extend `HostConsoleCommand` and add
   `if (this.forward() || this.cheat()) { return; }` at the top of `run()`, matching `God_f`'s
   shape exactly.

### 5b. Engine/game boundary violations (per `source-directories.instructions.md`)

These aren't about game code importing the engine (the documented direction) — they're the engine
carrying game-specific knowledge it shouldn't, the mirror-image violation of the same boundary.

1. **`ServerArea.ts:349`** — `if ((entity.flags & Defs.flags.FL_ITEM) !== 0) { // TODO: should be
   a feature flag for the game }` hardcodes a bounding-box nudge specifically for `id1`'s item
   entities directly into engine-side area-tree linking. A different game module with no concept
   of `FL_ITEM` (or a different pickup-radius convention) inherits this nudge unconditionally.
2. **`game/id1/entity/Weapons.ts:90`** — `// FIXME: move "use in c code" precache commands back to
   the engine` — the inverse problem: `ric1.wav`/`ric2.wav`/`ric3.wav`/`tink1.wav` are precached by
   game code but actually played by engine-side collision/ricochet code (per the comments "used in
   c code" on lines 95-98), so the precache list and the actual usage live in different modules
   that must be kept in sync by hand.

Both are long-standing, low-urgency architecture debt (not bugs — nothing breaks with a single
game module installed) but exactly the kind of thing worth fixing before a second game module
makes the coupling actually bite.

### 5c. Confirmed stale — safe to delete outright

1. **`GameAPIs.ts:637`** — `return ent; // FIXME: turn it into yield` on the `@deprecated`
   `FindByFieldAndValue`. The generator version already exists as a separate method
   (`FindAllByFieldAndValue`, line 650) — this FIXME describes work that's already done under a
   different name. Delete the comment; the actual cleanup (removing `FindByFieldAndValue` once
   callers migrate) is already Tier 2a's job.
2. **`GameAPIs.ts:773`** (`DispatchBeamEvent`) — `// FIXME: unhappy about this` on a method already
   tagged `@deprecated use client events instead` one line above. Whatever was unhappy-making
   stops mattering once the deprecated path is removed; the FIXME adds nothing the `@deprecated`
   tag doesn't already say. Already covered by this doc's existing non-goal below (needs the
   caller survey first).

### 5d. Already covered by other in-repo plans (no new tracking needed here)

- **`Navigation.ts:1519`** (`#relinkEdict` — `// TODO: adjust the nav graph accordingly`, an empty
  stub called on a 1s-debounced timer every time a pusher relinks) — this *is* the gap
  `plans/nav-dynamic-mover-awareness.md` was written to close. Nothing to add here.
- **`ClientEntities.ts:756`** (`#thinkTempEntities` — `// TODO: rework`) and, more loosely,
  **`ClientEntities.ts:120`** (`ClientEdict { // TODO: extends Protocol.EntityState }`) — the beam
  hand-rolled stepping logic this TODO points at is called out by name in
  `plans/client-entity-architecture.md` (problem #8, "the beam code in `#thinkTempEntities`...
  hand-rolls its own stepping logic") as exactly what `ClientAnimationSequence` (phase 4, not
  started) is meant to replace.
- Other general `CL.ts`/`V.ts` hygiene (self-reference style, dead code, alias cleanup) was
  `plans/cl-ts-structure-cleanup.md`'s scope, now ✅ done — see that plan's own findings. That
  plan never mentioned `ClientDemos.ts` specifically though (checked directly), so
  `ClientDemos.ts:149` below is *not* covered by it — moved to 5e.

### 5e. New, genuinely open, not yet tracked anywhere

Small, independent, low-to-medium value — good boy-scout-rule pickups when next touching the file,
not urgent enough to justify dedicated work on their own:

- **`ClientEntities.ts:911`** — `#emitProjectiles(): void { // TODO: implement }` is an empty stub
  called unconditionally every frame (`emit()`, line 934) and does nothing. It pairs with an
  orphaned protocol value: `Protocol.svc.nails = 43` (`network/Protocol.ts:95`) is defined but
  never written by the server and never read by the client (confirmed via grep — no
  `svc.nails`/`case ... nails` anywhere). This is NetQuake's old bandwidth-saving "nails" fast-path
  never implemented in this port, quietly dead on both ends. Either implement it or delete the
  stub call + method + the unused protocol constant and say so.
- **`Cvar.ts:110`** — confirmed the `DEFERRED` flag is actively misleading right now, not just an
  API gap: `Cvar.Command_f` (line 176) already prints "New value will be applied on the next map."
  for any cvar with this flag, but `set()` applies the value immediately regardless of the flag.
  Still bundled with the other Tier 4 `Cvar.ts` items as agreed, but worth knowing this one has a
  small user-facing wrongness today, not just a missing feature.
- **`MenuItem.ts:893`/`Keys.ts:8`** (the `96` half of the Tier 4 keycode question) — resolved by
  investigation: `96` is `` '`'.charCodeAt(0) ``, the console-toggle key, already correctly excluded
  from console input consumption at `Key.ts:151` (`keys.delete('`'.charCodeAt(0))`). The fix is
  just giving `K` a named `BACKQUOTE = 96` entry and using it at `MenuItem.ts:893` instead of the
  magic number — no behavior change. `Keys.ts:9,10` (`110`/`121`) have no other reference anywhere
  in `source/` (checked via grep) — no named key ever needed them since printable ASCII already
  passes through unnamed. Recommend just deleting those two placeholder comments unless the
  original author remembers an intended keycode; nothing currently depends on them.
- **`Draw.ts:257`** — `Draw.#fbo = gl.createFramebuffer(); // TODO: cleanup` — no matching
  `deleteFramebuffer` found anywhere in `Draw.ts`. Minor since there's only ever one `Draw.#fbo`
  for the process lifetime (not leaked per-frame), but inconsistent with this repo's own "always
  clean up WebGL resources" rule if `Draw` is ever torn down/re-initialized (e.g. context loss
  recovery).
- **`WorkerFramework.ts:61`** — `class WorkerCOM extends COM { // TODO: implement the COM stuff
  here for workers to share files etc. }` is a real empty-body gap, not cosmetic — any worker that
  needs filesystem access today gets nothing from this class.
- **`Console.ts:163,168`** — `PrintWarning`/`PrintError` TODOs to also emit `console.warn`/
  `console.error` (currently both just call `Con.Print` with a color). Small, self-contained,
  legitimate DX improvement (make engine warnings/errors visible in the browser/node console
  filter tools, not just the in-game console).
- **`ClientDemos.ts:149`** (`startPlayback()`, demo-file-not-found path) — `// TODO:
  SCR.disabled_for_loading = false;`. Traced: `SCR.disabled_for_loading` is real, still live
  (`SCR.ts:44`), set `true` by `BeginLoadingPlaque()` (`SCR.ts:334`, called from two spots in
  `Host.ts`) and cleared by `EndLoadingPlaque()` (`SCR.ts:346`, called from
  `ClientConnection.ts:297`/`Host.ts:223`). `startPlayback()` requires the client already be
  `disconnected` (`ClientDemos.ts:139`), so this exact call can't be the one that *set* the flag —
  but if a prior loading sequence left it `true` and the client disconnected before
  `EndLoadingPlaque()` ran, then `playdemo` fails on a bad filename, the screen stays disabled with
  no path back. Worse: `SCR.disabled_time` (`SCR.ts:45`, meant as a 60s safety-net expiry) is
  **write-only** — set at `SCR.ts:342`, never read anywhere in `source/` (confirmed via grep) — so
  there's no fallback timeout clearing it either. Not confirmed as *currently reachable* in
  practice (would need tracing every disconnect path for whether it always reaches
  `EndLoadingPlaque()` first), but the TODO's fix is simple and low-risk regardless: add the
  `SCR.disabled_for_loading = false;` line back in.

### 5f. Low-value / vague — confirmed still low priority, no new information

Spot-checked, nothing changed the original doc's judgment that these aren't worth dedicated work:
`R.ts:2437` (fog cvar cheat-flag ordering), `R.ts:2643` (Particle Class), `SCR.ts:218` (fov cvar
ownership), `V.ts:375`/`CL.ts:398` (bare `// TODO: Client`, no further detail — confirmed **not**
addressed by `cl-ts-structure-cleanup.md`, which is otherwise done; still just an unresolved,
low-information note), `Host.ts:307,348,364,456,628,809,1098,1790,2006`
(a grab-bag of "move this to X"/"consolidate"/"add loss stat"/"reimplement reconnect" notes — real
but small, pick up opportunistically), `Com.ts:226,268` (shareware-check feature-flag, `cmdline`
string→Cvar type nit), `W.ts:148,232` (lump-type parameter typing), `ServerMovement.ts:197` (chase
ping-pong steering, forward-looking), `Edict.ts:20` (`BaseEntity` interface/implementation split),
`ServerPhysics.ts:615` (watertype/waterlevel correctness note — same *flavor* as the Tier 3 FIXMEs
but lower stakes; worth the same vanilla-comparison treatment if `ServerPhysics.ts` is touched
again, not urgent on its own), `Pmove.ts:1106,1108,1236,1973` (hardcoded `viewheight`/ladder
placeholder values, config surface gap), `ClientMessages.ts:82`, `ClientServerCommandHandlers.ts:
589,700` (the latter paired with the identical pattern at `game/id1/client/HUD.ts:420` — both are
the same "no real console-color API" gap, worth fixing once together if ever picked up),
`ClientEntities.ts:795`, `Mod.ts:45`, `moveTypes` enum naming
(`shared/Defs.ts:95`), and the `game/id1`/`game/hellwave` entity-level TODOs (`Misc.ts:217`,
`Player.ts:667,777`, `Weapons.ts:154,422,491`, `BaseMonster.ts:343`, `props/Misc.ts:22`,
`monster/BaseMonster.ts:343`, `hellwave/entity/Misc.ts:1-3`, `hellwave/entity/Player.ts:413`,
`hellwave/GameManager.ts:747`, `HUD.ts:1099`) — game-logic polish, owned by whoever next touches
that specific entity, not engine-wide concerns. Note `id1` is a submodule (per
`.claude/skills/submodule-aware-commit/SKILL.md`) — any of those need their own commit inside it.

## Non-goals for this pass

- Not touching the `CL.ts`/`V.ts` hygiene pass (`plans/cl-ts-structure-cleanup.md`, now ✅ done) —
  was separately scoped, not part of this doc's tiers.
- Not attempting `GameAPIs.ts` deprecated `DispatchTempEntityEvent`/`DispatchBeamEvent` migration
  ("use client events instead") in this pass — needs a survey of all game-side callers first
  (id1 + hellwave) to confirm the client-event equivalents cover every current use, which is a
  bigger, separate effort.
- Not chasing every single cosmetic TODO (e.g. `R.ts:2643` particle class, `SCR.fov` cvar
  ownership) — low value relative to effort; pick up opportunistically when next touching those
  files (boy-scout rule), not as dedicated work.

## Suggested order of attack

1. ~~Tier 1 deletions~~ ✅ done.
2. **Tier 5a bugs — highest-value remaining items, both small and scoped.** The dedicated-server
   demo-truncation bug (`server/Com.ts:155`) and the missing cheat-gate on `eb_topics`/`eb_publish`
   (`Host.ts:2064,2073`) are each a few lines, each fixes a real (if narrow) problem, and neither
   needs a design discussion first.
3. **`EntityIndex` fix (Tier 2a) — still open, next-highest-value item.** Closes a real
   performance gap and a stale TODO/FIXME/deprecated triad at once.
4. ~~NetworkDrivers error-logging fix~~ ✅ done (as part of Tier 3).
5. ~~Everything else in Tier 2/3~~ ✅ done.
6. ~~`GL.Bind`/`Bind3D`/`BindArray`/`BindCube` (Tier 4)~~ ✅ done.
7. Tier 5c stale-comment deletions (`GameAPIs.ts:637,773`) — trivial, bundle with whichever of the
   above touches that file.
8. Tier 5b boundary fixes (`ServerArea.ts:349`, `Weapons.ts:90`) — worth doing before a second game
   module exists, not urgent before that.
9. Remaining Tier 4 items (`Cvar.ts` feature gaps; the `96`/`110`/`121` keycode question, now
   mostly resolved per Tier 5e — just needs the `K.BACKQUOTE` rename + deleting the two dead
   placeholders) only after a short discussion on direction — still open.
10. Tier 5e/5f items — boy-scout-rule pickups, no dedicated work needed.

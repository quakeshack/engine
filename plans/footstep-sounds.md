# Implement material-based footstep sounds (Quake II / Half-Life style)

**Status:** Not started (checked 2026-09-21). There is no step accumulator, surface query,
footstep table or `excludeClient` option anywhere in `source/`. The premises below still hold:
`_playerJumpFeedback` is still the closest precedent, and `QSMatLoader` still returns early on the
dedicated server. Line references are as of writing (2026-08-22) and were not re-verified one by
one.

## Context

There is no footstep system today. The closest existing precedent is
`Player._playerJumpFeedback()` ([Player.ts:1635](../source/game/id1/entity/Player.ts#L1635)),
called every frame from `playerPreThink`: it checks `FL_ONGROUND`/`waterlevel` and calls
`this.startSound(channel.CHAN_BODY, 'player/plyrjmp8.wav')` ([Player.ts:1658](../source/game/id1/entity/Player.ts#L1658)),
which is entirely server-authoritative — `startSound` → `ServerEngineAPI.StartSound`
([GameAPIs.ts:419](../source/engine/common/GameAPIs.ts#L419)) →
`SV.messages.startSound` ([ServerMessages.ts:165](../source/engine/server/ServerMessages.ts#L165)),
which PHS-filters recipients (`ServerMessages.ts:228-246`) but has **no way to exclude the
originating client** — the jumping player currently hears their own jump sound only after a
full round trip, same as everyone else.

Three gaps stand between that precedent and a real footstep system:

1. **No step-event detection.** Nothing currently measures "the player has moved N units
   since the last step while grounded."
2. **No surface/material data reachable from a trace.** Collision hulls are purely
   geometric — `Clipnode = { planenum, children }` and `Hull` carry no texture reference at
   all ([BSP.ts:9-38](../source/engine/common/model/BSP.ts#L9-L38)). Even the brush-based
   hull-0 path (`BrushSide.texinfo`, [BSP.ts:535-541](../source/engine/common/model/BSP.ts#L535-L541))
   discards texinfo by the time it reaches a `Trace`/`GameTrace` result — those only ever
   carry `plane{normal,dist}` ([Pmove.ts:153-180](../source/engine/common/Pmove.ts#L153-L180),
   [GameAPIs.ts:36-52](../source/engine/common/GameAPIs.ts#L36-L52)). Legacy Q1 BSPs
   without brush data fall back to a pure clipnode walk with zero face data
   ([ServerCollision.ts:500-506](../source/engine/server/physics/ServerCollision.ts#L500-L506)), so
   plumbing texture through the collision/movement trace wouldn't even work for those maps.
3. **No server-usable material table.** The only material system, `QSMatLoader`
   ([QSMatLoader.ts:44-56](../source/engine/common/model/QSMatLoader.ts#L44-L56)), returns
   early on the dedicated server (`registry.isDedicatedServer`) — it's a client-only PBR
   render override and cannot be reused as-is.

One reusable asset already exists: `R.RecursiveLightPoint`
([R.ts:608-734](../source/engine/client/R.ts#L608-L734)) walks `worldmodel.nodes[0]` down
by plane sign, then does a point-in-texinfo-UV test over `node.facesIter()`
([R.ts:647-663](../source/engine/client/R.ts#L647-L663)) to find the exact face under a
point. It resolves `worldmodel.texinfo[surf.texinfo]` for light sampling, but the same
traversal resolves a texture just as well — and, unlike hull-0 brush collision, it works
uniformly on every BSP format because it walks the render node/face tree, not the collision
clip hull. It's currently bound to `CL.state.worldmodel`
([R.ts:613](../source/engine/client/R.ts#L613)), i.e. client-only.

The movement code itself is already shared: `PmovePlayer`
([Pmove.ts:819](../source/engine/common/Pmove.ts#L819)) is one class whose `move()`
([Pmove.ts:943](../source/engine/common/Pmove.ts#L943)) is called identically from
client-side prediction (`CL.ts:578`, inside `PredictUsercmd`) and from the server
(`ServerClientPhysics.ts:131/135/137`). Ground-contact edge detection already exists at
`_categorizePosition()` ([Pmove.ts:1117-1174](../source/engine/common/Pmove.ts#L1117-L1174)),
setting `PMF.ON_GROUND` the frame a grounded trace first succeeds
(`Pmove.ts:1154-1167`) — exactly the point a step accumulator belongs.

## Goals

- Footstep sounds that vary by the surface material the player is standing on, playing
  automatically while walking/running on the ground.
- The local player's own footsteps should not feel delayed by network round-trip time.
- Reuse the existing shared-Pmove and server-authoritative-sound architecture; no new
  parallel movement or replication system.

## Non-goals (this pass)

- Per-material particle/decal/dust effects on footstep (the surface-query utility added here
  would enable it later, but it's not implemented now).
- A full `surfaceparm`-style material DSL — a flat texture-name/prefix → sound-set table is
  enough.
- Retroactively correcting a mispredicted client-side footstep after a server correction
  (see risk note in Phase 3).

## Design

### A. Step-event detection — shared, in `Pmove.ts`

Add an accumulator to `PmovePlayer`, updated at the same edge-detection point as the
existing `ON_GROUND` transition (`Pmove.ts:1154-1167`): track horizontal distance traveled
since the last step while `PMF.ON_GROUND` is set, and expose a per-`move()`-call transient
flag (e.g. `stepEvent: boolean`, cleared at the top of `move()`) once the accumulator crosses
a configurable threshold (add to `this._pmove.configuration`, alongside the existing
`groundCheckDepth`/`landingCooldown` knobs). Reset the accumulator whenever `onground`
becomes `null` (leaving the ground) so a jump doesn't carry over partial step distance into
the next landing.

Because this lives inside `move()`, both consumers get it automatically from the same
inputs:

- `ServerClientPhysics.ts:131/135/137` already reads `pmove.onground`/`velocity`/`origin`
  back after `move()` (`ServerClientPhysics.ts:145-164`) — read `pmove.stepEvent` the same
  way, for the server-authoritative trigger.
- `CL.ts:578`'s prediction loop already re-runs the identical `move()` for the local player
  every frame — this is what makes client-side echoing (Phase 3) possible with zero added
  detection latency.

### B. Surface identification — new shared utility, not the collision trace

Do **not** thread texinfo through `BrushTrace`/`Trace`/`GameTrace`. That path is a hot,
heavily-shared trace used by movement and AI, only carries texture data for brush-based maps
via hull 0, and doesn't exist at all for legacy Q1 clipnode hulls.

Instead, extract the `RecursiveLightPoint` traversal pattern into a new shared,
model-parameterized function (proposed: `source/engine/common/model/SurfaceQuery.ts`, or a
static method on `BrushModel`) that takes a `BrushModel` + point instead of reading
`CL.state.worldmodel`, and returns the hit `Face`/texinfo/texture name instead of a light
sample. `R.LightPoint` keeps its current call site but delegates to the shared traversal;
a new server-side call site (in the footstep trigger, Component D) uses the same function
against `SV.server.worldmodel`.

This is a point query run **once per detected footstep**, not per frame — the codebase
already runs comparable point traces against hull 0 every AI tick
(`Navigation.ts:812,826`), so the added cost is negligible.

### C. Texture → footstep sound table

Content-owned, not engine-owned (mirrors how sounds are precached in game entity code, not
engine code): a small table in `source/game/id1/` mapping texture name (or prefix — note
stock id1 textures don't follow a strict material-prefix convention the way Half-Life's
`textures.wad` does, so prefix matching needs a sensible generic fallback, e.g. "dirt/stone")
to a set of footstep sounds. Precache the referenced sounds the same way other player sounds
are precached today.

### D. Server-authoritative trigger

Add `_playerStepFeedback()` next to `_playerJumpFeedback()`
([Player.ts:1635](../source/game/id1/entity/Player.ts#L1635)), called from
`playerPreThink`/`playerPostThink` alongside it. Guard structure mirrors the existing method
(skip when `MOVETYPE_NOCLIP`, not `FL_ONGROUND`, mid-waterjump, etc. — see
`Player.ts:1636-1651`). On `pmove.stepEvent` (via whatever field the server-side physics
entity exposes it through, per Component A), run the Component B surface query at the
player's feet, look up the sound via Component C, and call
`this.startSound(channel.CHAN_BODY, sound)` — identical pattern to the jump/water sound
calls at `Player.ts:1643` and `Player.ts:1658`.

This alone (Phase 1/2) is a complete, shippable footstep system with the same latency
profile the existing jump sound already has.

### E. Client-side prediction (the network-lag question)

**Recommendation: yes, predict it locally, as a local-only echo layered on top of D, not a
replacement for it.**

Today, `_playerJumpFeedback`-style feedback is 100% server-authoritative, so even the
jumping player hears their own jump sound only after a full round trip
(`ServerMessages.startSound` PHS-filters recipients but has no "exclude sender" concept —
`ServerMessages.ts:228-246`). That's tolerable for a single discrete cue like a jump.
Footsteps are different: they're continuous, rhythmic, and read as tightly bound to visible
leg motion the player is already seeing via client-side prediction — a 100–300ms mismatch
between the visual step and its sound is far more noticeable than for jump.

Because Component A's `stepEvent` flag comes out of the same shared `PmovePlayer.move()`
that `CL.ts:578` already re-runs every frame for local prediction, the client can detect its
own steps with zero added latency beyond simulation itself. On `stepEvent`, run the same
Component B/C lookup client-side and call `Sound.LocalSound(footstepSfx)`
([Sound.ts:614-616](../source/engine/client/Sound.ts#L614-L616)) — this already bypasses
the network entirely (`entchannel = -1`, per the JSDoc at `Sound.ts:481`), exactly like a UI
sound.

This creates a new problem: the local player would then hear the footstep **twice** — once
instantly (local prediction) and again ~RTT later, because the server's authoritative
broadcast (Component D) reaches the originating client too, same as jump sound does today.
Fix: add an opt-in `excludeClient` (or equivalent) parameter threaded through
`ServerEngineAPI.StartSound` ([GameAPIs.ts:419](../source/engine/common/GameAPIs.ts#L419))
→ `SV.messages.startSound` ([ServerMessages.ts:165](../source/engine/server/ServerMessages.ts#L165)),
skipping that one client in the recipient loop (`ServerMessages.ts:228-246`). Keep it
opt-in/default-off so every other existing `StartSound` call site (jump, pain, weapons,
doors, ...) is unaffected — only the footstep call passes it.

Scope boundary: only ever predict-and-echo footsteps for the **local** player. Other
players' entities in `CL.ts` are interpolated, not predicted, and must keep hearing (and
having others hear) their footsteps exclusively through the normal server-replicated path —
there's no local-echo problem for them because the local client was never simulating their
movement in the first place.

**Accepted risk:** like all client-side prediction, a locally-echoed footstep can
occasionally misfire — a server correction can invalidate a step the client predicted,
producing a rare extra or missing footstep audible only to the local player. This is
cosmetic-only and the same category of glitch already accepted for predicted movement
itself; no retroactive prediction-rewind for audio is planned.

### F. Monster/NPC footsteps — reuses B/C, no accumulator, no prediction

Checked: monsters do **not** already have footstep sounds. Their walk/run animation
callbacks (e.g. `ogre_walk`'s per-frame `walkSpeeds`
[Ogre.ts:82-93](../source/game/id1/entity/monster/Ogre.ts#L82-L93)) call `idleSound()`/
`dragSound()` at specific `frameIndex` values, but those are voice/drag cues, not footsteps.
The non-goal in an earlier draft of this plan ("monsters already have their own movement
sounds where relevant") overstated this and has been removed — monster footsteps are in
scope.

Monster movement is structurally simpler than the player's for this feature, because it is
already **discrete per animation frame** rather than continuous per physics tick:

- `AI.walk(dist)`/`AI.run(dist)` ([AI.ts:730-733](../source/game/id1/helper/AI.ts#L730-L733),
  [AI.ts:772](../source/game/id1/helper/AI.ts#L772)) is called once per animation frame
  from each monster's `_defineSequence` callback, with a per-frame authored distance (e.g.
  Ogre's `walkSpeeds = [3, 2, 2, 2, ...]`).
- That flows into `BaseEntity.walkMove()` ([BaseEntity.ts:630-632](../source/game/id1/entity/BaseEntity.ts#L630-L632))
  → `ServerEdict.walkMove()` ([Edict.ts:654-656](../source/engine/server/Edict.ts#L654-L656))
  → `ServerMovement.walkMove()`/`movestep()` ([ServerMovement.ts:74-177](../source/engine/server/physics/ServerMovement.ts#L74-L177)),
  which is entirely server-side — monsters are never client-predicted, only interpolated
  ([CL.ts](../source/engine/client/CL.ts) has no monster-prediction path), so there is
  **no Component E equivalent needed**: no double-hearing problem, no `excludeClient`
  plumbing, no local echo. Server-authoritative is the *only* mode, same latency profile
  every other monster sound already has.
- There is already a precedent for firing a sound conditionally on a specific `frameIndex`
  within a walk/run sequence — that's exactly what `idleSound()`/`dragSound()` do today. The
  natural anchor for a footstep is the same: the frame(s) in each monster's walk/run
  `_defineSequence` where the animator intended a foot-to-ground contact (typically 1-2 per
  cycle), not a continuous distance accumulator like Pmove's. This avoids adding any new
  state to `BaseMonster`/`AI` at all.

Proposed shape: a `footstepSound()` helper (on `BaseMonster` or `AI`, next to the existing
`idleSound()`) that runs the Component B surface query at the monster's feet
(`entity.origin` + `entity.mins[2]`) and the Component C table lookup, then
`this.startSound(channel.CHAN_BODY, sound)` — identical call shape to Component D, just
invoked from a different call site (an animation `frameIndex` check instead of a
`pmove.stepEvent` flag). Wiring it into each monster's walk/run sequences is a per-monster,
mechanical edit (one or two `if (frameIndex === N) { this.footstepSound(); }` lines per
sequence, mirroring the existing `dragSound()` pattern) — do this for a handful of common
ground monsters first (Soldier, Ogre, Knight, Zombie, Demon) rather than all of them in one
pass; `FL_SWIM`/`FL_FLY` monsters (Fish, Wizard) and Boss get no footsteps at all, same as a
flying/swimming player wouldn't trigger Component A.

## Material infrastructure — flat table vs. extending QSMat (open fork)

The user raised whether `QSMatLoader`/`.qsmat.json` should be extended to carry footstep
material data instead of adding a new flat table. Checked `QSMatLoader.ts` and
`Materials.ts` in detail — three findings bear on this:

1. **QSMat is opt-in per map, not universal.** It only runs when a map's worldspawn declares
   a `_qs_mat` key pointing at one or more `.qsmat.json` files
   ([QSMatLoader.ts:60-68](../source/engine/common/model/QSMatLoader.ts#L60-L68)). Most
   maps — including every stock id1 map — have no such file. A footstep system needs a
   material answer for *every* texture in *every* map, qsmat or not, so whatever backs it
   needs a universal fallback regardless of this decision.
2. **QSMat is hard-gated off the dedicated server.** `QSMatLoader.load()` returns
   immediately when `registry.isDedicatedServer`
   ([QSMatLoader.ts:54-56](../source/engine/common/model/QSMatLoader.ts#L54-L56)), and the
   rest of the method is inherently client-only: it calls `GLTexture.FromImageFile()`
   ([QSMatLoader.ts:111](../source/engine/common/model/QSMatLoader.ts#L111)) and mutates
   `loadmodel.textures[txIndex]` with GL-backed `PBRMaterial` instances. Footstep lookups
   need to run authoritatively on the server (Component D). Reusing qsmat as-is is a
   non-starter; reusing it *at all* means splitting `MaterialDefinition` parsing (JSON, no GL
   calls, safe on dedicated server) out from `MaterialFile` texture loading (client-only),
   which today are one undifferentiated method.
3. **`MaterialFlags` (the only existing "material typing" concept) is purely a render enum**
   ([Materials.ts:37-44](../source/engine/client/renderer/Materials.ts#L37-L44)) —
   `MF_TRANSPARENT`/`MF_SKY`/`MF_TURBULENT`/`MF_SKIP`/`MF_FULLBRIGHT`. There is no existing
   gameplay-material axis (footstep, physics friction, damage type, ...) anywhere in the
   material system to extend — it would be new either way.

**Recommendation:** keep Component C's flat texture-name/prefix → sound-set table as the
*only* mechanism for Phase 2, and do not touch `QSMatLoader` in this pass. It is the only
option that trivially covers every id1 texture with zero per-map authoring burden, matching
this plan's non-goal of avoiding a full material DSL. Revisit qsmat only as a later,
optional per-map *override* layer on top of the flat table (e.g. an optional
`footstep?: string` field on `MaterialDefinition`, consulted first, falling back to the flat
table when absent or when no qsmat file exists) — worth doing once a custom map actually
wants texture-specific footsteps that don't map cleanly onto the generic prefix fallback, not
before. Doing that later requires the `MaterialDefinition`/texture-loading split described in
finding 2 regardless of when it happens, so there's no cost to deferring it.

## Phasing

Each phase is independently shippable; stopping after any phase still leaves a working,
useful increment.

1. **Phase 1 — generic server-authoritative footstep, no material.** Components A + D only,
   with C reduced to a single fixed sound. Fast to ship, matches the existing jump-sound
   precedent exactly, no new plumbing beyond the Pmove accumulator.
2. **Phase 2 — material identification.** Add Component B (extract the shared surface-query
   utility from `RecursiveLightPoint`) and the real Component C texture→sound table; wire
   into Phase 1's trigger.
3. **Phase 3 — client-side predicted local echo.** Component E: `excludeClient` on the
   `StartSound` path, plus the `CL.ts` local-playback hook for the local player only.
4. **Phase 4 — monster/NPC footsteps.** Component F: `footstepSound()` helper reusing
   Components B + C, wired into a handful of ground monsters' walk/run `_defineSequence`
   callbacks at the appropriate `frameIndex`. Independent of Phase 3 (no prediction concerns)
   — can ship right after Phase 2, or in parallel with Phase 3, since it only depends on
   Components B and C.

## Testing

- **Pmove step accumulator** (Phase 1): extend the existing `Pmove`/`ServerClientPhysics`
  test coverage under `test/physics/` — assert `stepEvent` fires once per threshold distance
  while grounded, resets on leaving the ground, and does not fire while airborne, underwater
  above waist, or `MOVETYPE_NOCLIP`.
- **Surface query utility** (Phase 2): new test against a synthetic BSP fixture (reuse
  `createBrushWorldModel`/`createRoomHullFromBounds`-style fixtures per
  `unit-tests.instructions.md`), asserting the correct face/texture is returned for points on
  known faces, and a sane fallback for points that miss every face (e.g. over a gap).
- **Material table lookup** (Phase 2): table returns the expected sound set for known texture
  names/prefixes and the generic fallback otherwise.
- **`_playerStepFeedback` gating** (Phase 1/2): game-side test in
  `source/game/id1/test/` mirroring the guard structure already covered (implicitly or
  explicitly) for `_playerJumpFeedback` — grounded-only, skipped mid-waterjump/noclip/underwater.
- **`ServerMessages.startSound` exclusion** (Phase 3): the excluded client's `expedited_message`
  receives no `svc.sound` for that call while other in-PHS clients still do, and the
  unconditional `svc.stopsound` broadcast (`ServerMessages.ts:239-242`) is unaffected.
- **`footstepSound()` gating** (Phase 4): per-monster test asserting the sound fires only on
  the intended `frameIndex` values within a walk/run sequence, and not for `FL_SWIM`/`FL_FLY`
  monsters that never call it.
- Run `npm run test:physics`, `npm run test:common`, and `npm run test:game` after each
  phase; `npx eslint --fix` on every touched file.

## Open questions

- Exact step-distance threshold and per-surface volume/attenuation — propose starting from
  the same `channel.CHAN_BODY` / attenuation values `_playerJumpFeedback` already uses and
  tuning by feel, rather than deriving a number up front.
- Whether the Phase 2 texture→sound table should key on exact texture name or prefix
  matching (or both, prefix as fallback) — needs a look at the actual id1 texture names in
  use before committing to a convention.
- Whether to extend `MaterialDefinition` with an optional `footstep` field later (see
  "Material infrastructure" fork above) once a custom map wants qsmat-level footstep
  overrides — deferred, not decided against.
- Which specific `frameIndex` values count as a foot-strike per monster walk/run sequence
  (Phase 4) — needs a frame-by-frame look at each monster's `.mdl`/QC data, one entity at a
  time, rather than guessing from frame count alone.

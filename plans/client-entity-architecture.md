# `ClientEdict` / client-only entities: from network mirror to a general client-entity system

## Status

🚧 In progress — phases 1–3 done. Phase 1 (vocabulary fixes: `isStatic()` → `isClientOwned()`,
`nextthink` → `lerpEndTime`, `static_entities`/`allocateClientEntity()` docstrings) and phase 2
(`ClientEdict.markFree()` + `BaseClientEdictHandler.remove()`, with unit tests in
`test/client/client-entities.test.mjs` and `test/common/client-edict.test.mjs`) are landed. Full
test suite (1286 tests) and `tsc --noEmit` both clean relative to these changes (one pre-existing
`tsc` error in `source/game/hellwave/entity/Items.ts` predated this work; it turned out to be a
real bug and was fixed in [game-module-contract.md](game-module-contract.md) Phase 1, and
`npm run typecheck` is clean as of 2026-09-21).

Phase 3 (`ClientEntityPhysics`) landed 2026-09-26, per the recommended answers to open questions
1, 2, and 6 (one sealed `ClientEdict` shape with opt-in helpers; a composed per-handler physics
helper, not a static utility or base-class method; full `physicsToss()` orchestration sharing
deferred, not folded into this plan): `clipVelocity`/`GROUND_ANGLE_THRESHOLD`/`VELOCITY_EPSILON`
moved to `source/shared/PhysicsMath.ts` (`ServerPhysics`/`ServerClientPhysics` repointed at it,
its own `clipVelocity` instance method removed, its direct unit test moved to
`test/shared/physics-math.test.mjs`); `ClientEngineAPI.CL.gravity` added
(`GameAPIs.ts`, reads `CL.pmove.movevars.gravity`, deliberately not multiplied by
`movevars.entgravity` -- that field is the local player's own `Pmove` scale, not a per-entity
one); and `source/shared/ClientEntityPhysics.ts` added (gravity integration + `engine.Traceline()`
collision + the shared `clipVelocity`, always moving via `ClientEdict.setOrigin()`). Along the
way, found and fixed a real latent bug this phase's own repeated-`setOrigin()`-per-frame usage
would otherwise have hit: `ClientEdict.linkEdict()` never cleared `this.leafs` before
repopulating it, so any entity calling `setOrigin()` more than once would accumulate every leaf
it had ever occupied instead of reflecting only its current one -- harmless today since
`svc_spawnstatic` is the only existing caller and calls it exactly once per entity, but exactly
the kind of stale-PVS-culling footgun problem #5 warned about, now fixed with a regression test
in `test/client/client-entities.test.mjs`. New tests: `test/shared/physics-math.test.mjs`,
`test/client/client-entity-physics.test.mjs` (gravity read from `CL.gravity` not hardcoded,
free-flight movement, floor-bounce reflection via the shared formula, full stop, all-solid
short-circuit, leaf recompute across a BSP boundary). Full suite is 1303 tests, `npm run
typecheck` clean, `eslint` clean.

Phases 4–6 (sequencing, save/load, real consumer) not started.

Originally written after a request to assess `source/shared/ClientEdict.ts` and
`source/engine/client/ClientEntities.ts` and to plan how to make client-only entities (today:
static light props; planned: debris, shell casings, gibs, ...) as convenient to write as
server-side game entities. Extended with a client-side analog of the server's state machine
(sequencing) and with save/load support for dynamically-spawned client-only entities, per
follow-up discussion.

## Context

`ClientEdict` (`source/engine/client/ClientEntities.ts:120`) is one class that currently serves
**three different lifecycles**, distinguished only by `num` and by which array
`ClientEntities` puts them in:

1. **Server-mirrored entities** (`num >= 0`, stored in `ClientEntities.entities[]`). Position/
   angles/velocity arrive over the wire every server frame; `updatePosition()`
   (`ClientEntities.ts:418`) and the `lerp` getters (`ClientEntities.ts:225-256`) interpolate
   between the last two snapshots for smooth rendering. Never physically simulated client-side
   (except player prediction, which is a separate system — `CL.PredictMove`).
2. **Static, spawn-once decorations** (`num === -1`, `svc_spawnstatic`, parsed in
   `parseStaticEntity()` in `ClientServerCommandHandlers.ts:319` and allocated via
   `allocateClientEntity()`). Frame/effects/origin are set exactly once at signon and never
   change again — this is what flame lights (`TorchLightEntity` in
   `source/game/id1/entity/Misc.ts:242`, via `makeStatic()` in
   `source/engine/server/Edict.ts:688`) use today.
3. **Client-only simulated entities** (also `num === -1`, also via `allocateClientEntity()` —
   same array, same allocator, same sentinel). Per the docstring on
   `allocateClientEntity()` (`ClientEntities.ts:676`), this is meant for "client-side effects
   (debris, gibs, projectiles etc.)" but nothing actually uses this path today — no client-only
   entity has ever needed to move, expire, or collide.

The extensibility point is `BaseClientEdictHandler` (`source/shared/ClientEdict.ts`), a 3-method
strategy object (`spawn`/`emit`/`think`) resolved by classname via
`ClientGameAPI.GetClientEdictHandler()`. Real usage today is light: `DefaultClientEdictHandler`
(`ClientLegacy.ts`, procedural effects driven by `modelFlags`/`effect` bits), `FireballEdictHandler`
(`Misc.ts:319`, a dlight + two rocket trails), `PlayerClientEntity` (`Player.ts:202`, powerup
dlights), and `Boss` reusing Fireball's handler. That's a good time to fix the shape — three call
sites is cheap to migrate, thirty would not be.

Compare this to server-side `BaseEntity` (`source/game/id1/entity/BaseEntity.ts`): a purpose-built
base class with `@serializable` fields, a state machine (`_defineState`/`_defineSequence`),
scheduled thinks with automatic removal, and composed helper objects (`Sub`, `AI`, `DamageHandler`,
all `EntityWrapper<T>`). `ClientEdict` has none of that — which is the "not the same convenience"
the assessment was asked to explain.

Save/load already has a working precedent for exactly this kind of "purely cosmetic, purely
client-side" state: `R.SerializeParticles()`/`DeserializeParticles()` (`R.ts:2588,2618`). Particles
are captured with a *relative* `die` time (`p.die - CL.state.time`, re-added to the new
`CL.state.time` on load) and round-tripped through `Host.Savegame_f`/`Loadgame_f`
(`Host.ts:1213,1329`) → `ClientLifecycle.resumeGame()` (`ClientLifecycle.ts:80`) →
`CL.state.loadClientData` → the signon-complete handler
(`ClientServerCommandHandlers.ts:255-262`). So "client-only" does not mean "not save-game state" in
this codebase — it already means the opposite for particles, and the same is true for any future
debris/shell-casing entity that's spawned procedurally (weapon fire, impacts) rather than from map
data. That distinction matters: `svc_spawnstatic` entities are *not* saved and don't need to be —
`SV.SpawnServer(mapname)` on load re-runs map entity spawn, which re-emits `makeStatic()` and thus
re-populates `static_entities` from scratch during the fresh signon. A dynamically-spawned
client-only entity has no such second source of truth — if it isn't captured explicitly, it's just
gone after a load, unlike its particle-based cousins.

## Problems found

1. **One class, three lifecycles.** `ClientEdict` carries netcode-only fields
   (`msg_origins`/`msg_angles`/`msg_velocity`, `dlightbits`, `dlightframe`, `updatecount`, the
   `lerp` getters) that mean nothing for a static or client-only entity, and carries nothing that a
   future physically-simulated entity actually needs (gravity accumulator, bounce count, spin,
   die time). `Object.seal(this)` (`ClientEntities.ts:259`) is otherwise a good call — it forces
   all per-entity extensibility through the handler, not through ad hoc fields on the edict — but
   it means there is currently no natural home for "client-only entity" state at all.
2. **"Static" is overloaded three ways.** `ClientEntities.static_entities` holds both true
   spawn-once decorations *and* (per its own docstring) future moving/expiring debris.
   `ClientEdict.isStatic()` (`ClientEntities.ts:262`) doesn't mean "spawned via `svc_spawnstatic`"
   — it means "`num === -1`", i.e. "not a server-tracked slot," which is also true of temp
   entities and future client-only entities. A debris entity would sit in an array literally named
   `static_entities` despite being the one thing in the system that moves under its own steam.
3. **`nextthink` doesn't gate `think()`.** On `ClientEdict` it's purely the end of the current
   lerp window (`ClientEntities.ts:160`, consumed by `updatePosition()` and the `lerp` getters).
   `ClientEntities.#thinkEntities()` (`ClientEntities.ts:799`) calls `think()` on every non-free
   entity unconditionally every frame — including edicts pre-allocated as placeholders by
   `getEntity()` (`ClientEntities.ts:711`) that the server has never actually referenced. Anyone
   coming from the server-side convention (`nextthink` gates `think`) will misread this field.
4. **No physics helper for client-only entities — and the obvious first fix (hardcode gravity)
   is itself wrong.** Server entities get generic toss/bounce movement via
   `ServerPhysics.physicsToss()` (`source/engine/server/physics/ServerPhysics.ts:672`, used for
   `MOVETYPE_TOSS`/`MOVETYPE_BOUNCE`/`MOVETYPE_FLY`); client-only entities get nothing analogous,
   despite `ClientEdict` already carrying a `velocity` field and
   `ClientEngineAPI.Traceline(start, end, { includeEntities })`
   (`source/engine/common/GameAPIs.ts:1040`) already existing as a collision primitive. A
   hand-rolled client version — including the first sketch in this plan's own earlier draft — reaches
   for a hardcoded `800` for gravity. That's wrong twice over: it's not `sv_gravity`'s actual value
   if a mod changes it, and the codebase already has an authoritative, network-synced, non-hardcoded
   source for exactly this number (`movevars.gravity`/`entgravity`, shared via the `Pmove`/
   `MoveVars` classes — see Design). (The particle system in `R.ts` does simple gravity integration
   already, but with no collision — not reusable for something that needs to land and rest on
   geometry — and even it reads `CL.cls.serverInfo.sv_gravity` rather than hardcoding, `R.ts:1435`.)
5. **Moving a client-only entity has a silent visibility footgun.** `static_entities` is only
   rendered when `vis.areRevealed(clent.leafs)` passes (`ClientEntities.ts:872`), and `leafs` is
   only recomputed by `linkEdict()`/`setOrigin()` (`ClientEntities.ts:322,382`). A handler that
   moves an entity by mutating `clientEdict.origin` directly instead of calling `setOrigin()`
   (exactly the shape a hand-rolled physics `think()` would naturally write) will leave `leafs`
   stale and the entity will silently stop being culled correctly — likely disappearing once it
   leaves its spawn leaf. This is exactly what a shared physics helper should get right so
   individual handlers don't each have to know it.
6. **No lifetime/expiry API.** `ClientEdict.free` is a plain mutable field and is never set `true`
   anywhere client-side today (confirmed by grep) — correct for entities that live for the whole
   map, wrong for anything with a lifetime. There's no equivalent of the server's
   `_scheduleThink`/`remove()`. A handler that needs to expire would have to reach into
   `this.clientEdict.free = true` directly, which is also a boundary violation per this repo's
   "public field is not an invitation to reach in" rule — `ClientEdict` should own that
   transition.
7. **No composition point for cross-cutting client-only behavior.** Server entities compose
   `EntityWrapper<T>` components (`Sub`, `AI`, `DamageHandler`) to share behavior across many
   entity classes without inheritance. `BaseClientEdictHandler` gives exactly `spawn/emit/think`
   and nothing else — a future "bounce off the world, leave a decal, fade out, then free" behavior
   would otherwise get copy-pasted into every debris-like handler.
8. **No animation/behavior sequencing for client-only entities.** The server's
   `_defineState`/`_defineSequence` pattern (typed state keys, per-frame callbacks) has no client
   analog. Ambient looping (flame flicker) doesn't need one — that's already handled generically by
   the renderer's model frame-group animation (`AliasModelRenderer.ts:248-315`, driven by
   `syncbase`, no per-entity script involved) — but a triggered, one-shot, multi-frame effect (e.g.
   an explosion that spawns a dlight on frame 2 and smoke on frame 5, then frees itself) has no
   declarative way to be written today; it would be hand-rolled with ad hoc counters, the same way
   the beam code in `#thinkTempEntities` (`ClientEntities.ts:726`) already hand-rolls its own
   stepping logic.
9. **Client-only entities are invisible to save/load.** `Host.Savegame_f`/`Loadgame_f`
   (`Host.ts:1131,1228`) already round-trip particle state end-to-end (see Context above), but
   nothing captures `ClientEntities`' own `static_entities`/future simulated entities. That's
   correct for `svc_spawnstatic` decorations (map respawn regenerates them) but wrong for anything
   spawned procedurally client-side — it would simply vanish on load, unlike the particles it was
   flying alongside a moment before saving.

## Goals

- Make client-only simulated entities (debris, shell casings, gibs) genuinely convenient to write:
  gravity + collision + expiry available as shared, opt-in building blocks instead of hand-rolled
  per handler.
- Client-side physics reads authoritative gravity/bounce constants from the same shared source the
  server already uses (`movevars`, `PhysicsMath`) instead of hardcoding or re-deriving them.
- Fix the misleading vocabulary found above (`isStatic`, `static_entities`, `nextthink`) so it
  matches what the code actually does, before more call sites accrete around the current names.
- Give `BaseClientEdictHandler` a real (encapsulated) way to end an entity's life, instead of
  reaching into `ClientEdict.free` directly.
- Give handlers a declarative way to write triggered, one-shot, multi-frame behavior, mirroring
  `_defineSequence`'s ergonomics without carrying over the server machinery that doesn't apply
  client-side (see Design).
- Dynamically-spawned client-only entities survive save/load the same way particles already do —
  no regression relative to what the particle system already guarantees today.
- Keep it additive: existing entities (`DefaultClientEdictHandler`, `FireballEdictHandler`,
  `PlayerClientEntity`) keep working unchanged.

## Non-goals

- **No client-side prediction/reconciliation for client-only entities.** They're purely cosmetic;
  nothing about them needs to be acked by the server or reconciled against authoritative state.
  (This is independent of save/load — see Goals above — cosmetic and "not worth saving" are not
  the same thing, as the particle system already demonstrates.)
- **No splitting `ClientEdict` into per-lifecycle subclasses right now.** A `ServerMirroredEdict` /
  `StaticEdict` / `SimulatedEdict` hierarchy would ripple through every renderer that treats
  `ClientEdict` as one shape (`BrushModelRenderer`, `AliasModelRenderer`, `SpriteModelRenderer`,
  `MeshModelRenderer`, `ShadowMap`, `Materials`, `Pmove`, `R.ts` — 13 files import the type today).
  That's a lot of blast radius to take on for a need that doesn't have a concrete consumer yet.
  Revisit only once real usage shows the single-shape model is actually load-bearing pain, not
  hypothetically so.
- **No on-wire protocol changes.** `svc_spawnstatic` parsing and the server's `makeStatic()` stay
  exactly as they are.
- **No changes to how `entities[]` (server-mirrored, `num >= 0`) are updated/interpolated.**

## Design

### Keep one `ClientEdict` shape; add opt-in helpers instead of splitting it

Rather than fork `ClientEdict` into subclasses (see Non-goals), keep the single sealed shape and
add the missing capabilities as small, separately-testable pieces that a handler opts into. This
matches the existing "extensibility lives in the handler, not the edict" split, and keeps the
change additive and low-risk given how little currently depends on this code.

### Vocabulary fixes (do first, mechanical, low risk)

- Rename `ClientEdict.isStatic()` → `isClientOwned()` (or `isServerless()`) and update its two call
  sites (`linkEdict`, `setOrigin`) and JSDoc. It means "not a server-tracked entity slot," which is
  also true of temp entities and future client-only entities, not just `svc_spawnstatic` ones.
- Split the docstring on `static_entities` and `allocateClientEntity()` to be explicit that the
  array holds two different intents (spawn-once decorations, and — once phase 3 lands — timed
  simulated entities), or introduce a second array (`sim_entities`) once phase 3 actually has a
  consumer. Don't rename the array pre-emptively without a consumer to validate the split.
- Rename `ClientEdict.nextthink` → `lerpEndTime` (or similar) to stop it reading as a think
  scheduler. Update the ~6 internal references in `ClientEntities.ts`.

### Lifetime: encapsulate `free`

Add to `ClientEdict`:

```typescript
/** Marks the entity as free for the allocator to recycle; stops it thinking, emitting, or rendering. */
markFree(): void {
  this.free = true;
}
```

And to `BaseClientEdictHandler`:

```typescript
/** Ends this entity's life. Safe to call from think()/emit(). */
protected remove(): void {
  this.clientEdict.markFree();
}
```

`free` itself can stay a plain field (renderer/allocator code already reads it directly, and nothing
outside `ClientEdict`/`ClientEntities` should be setting it) — the fix is giving handlers a method
instead of reaching in.

### Physics

#### Gravity is already CL/SV-shared data — use it, don't hardcode it

There's a direct precedent already living in `source/engine/common/`: `Pmove`/`MoveVars`
(`Pmove.ts:86,2192`) is one class, instantiated on both sides (`SV.pmove = new Pmove()` in
`Server.ts:240` with a live cvar-backed `PlayerMoveCvars`; `CL.pmove` populated over the wire by
`parsePmovevars()` in `ClientServerCommandHandlers.ts:269-282`), so `movevars.gravity`/`entgravity`
already means the same authoritative number on both ends — server's `addGravity()`
(`ServerPhysics.ts:303-309`) computes `entGravity * SV.gravity!.value`, the exact same formula
`Pmove` itself uses internally (`Pmove.ts:1021`, `movevars.gravity * movevars.entgravity`). Nothing
client-only should ever hardcode `800`; it should read this value.

`ClientEngineAPI.CL` (`GameAPIs.ts:1129-1189`) already exposes a handful of curated getters
(`time`, `gametime`, `frametime`, ...) for exactly this kind of read. Add one more:

```typescript
// GameAPIs.ts, inside static readonly CL = { ... }
get gravity(): number {
  return CL.pmove.movevars.gravity;
},
```

#### Shared math: hoist `clipVelocity` and the toss constants, don't reimplement them

`ServerPhysics.clipVelocity()` (`ServerPhysics.ts:177-191`, the bounce/reflect formula) and
`addGravity()` are pure `Vector`-in-`Vector`-out math with no `ServerEdict` coupling at all —
`clipVelocity` doesn't even reference `this`. Same for the constants it's built on,
`GROUND_ANGLE_THRESHOLD` and `VELOCITY_EPSILON` (currently `source/engine/server/physics/Defs.ts:
5,16` — server-only today, despite being pure numbers). Per this repo's own directive that
`source/shared/` is for "engine-agnostic code... math utilities," these move there once, e.g.
`source/shared/PhysicsMath.ts`, and both `ServerPhysics` and the new client physics helper import
the same implementation instead of the client version reinventing (and inevitably drifting from)
the bounce formula.

#### The per-entity step: a small composed component, mirroring `EntityWrapper`

Follows the same "helper object, not inheritance" shape as server-side `Sub`/`AI`/`DamageHandler`.
Unlike `EntityWrapper<T>` (which uses a `WeakRef` because a server edict can be recycled
independently of its wrapper), a client handler already owns its `ClientEdict` 1:1 for the whole
edict's lifetime (created together in `loadHandler()`), so no `WeakRef` indirection is needed —
a direct reference is fine and simpler.

```typescript
// source/shared/ClientEntityPhysics.ts
export class ClientEntityPhysics {
  #clientEdict: ClientEdict;
  #engine: ClientEngineAPI;

  constructor(clientEdict: ClientEdict, engine: ClientEngineAPI) { ... }

  /**
   * Integrates gravity (from engine.CL.gravity, scaled by an optional per-entity multiplier
   * matching entgravity's role) + velocity for one frame, collides via engine.Traceline(), and
   * clips the resulting velocity with shared/PhysicsMath.clipVelocity() -- the same formula
   * ServerPhysics.physicsToss() uses. Always moves through clientEdict.setOrigin() (never raw
   * .origin mutation) so BSP leafs stay in sync with PVS culling. Returns the trace result so
   * callers can react to impacts (e.g. play a bounce sound, spawn a decal, come to rest).
   */
  step(frametime: number, options?: { gravityMultiplier?: number; bounce?: number }): GameTrace;
}
```

A debris handler would then look like:

```typescript
export class DebrisEdictHandler extends BaseClientEdictHandler {
  #physics = new ClientEntityPhysics(this.clientEdict, this.engine);
  #dieTime = this.engine.CL.time + 5.0;

  override think(): void {
    if (this.engine.CL.time >= this.#dieTime) {
      this.remove();
      return;
    }
    this.#physics.step(this.engine.CL.frametime, { bounce: 0.4 });
  }
}
```

No engine-level "scheduled expiry" system is being added (see Non-goals) — expiry stays fully
handler-driven, exactly like `think()`/`emit()` already are for every other handler. This avoids
inventing a second scheduling mechanism next to the netcode's own `lerpEndTime`.

#### Optional follow-up: share the full toss/bounce orchestration, not just its math

The pattern above (hoist the math, keep per-side orchestration) is the safe minimum. The more
ambitious version — and the one that actually matches "CL/SV shared physics code" — goes one step
further: `Pmove` isn't just shared *math*, it's the *entire* movement algorithm, with each side
differing only in how it feeds `Pmove` a `PlayerCollisionWorld`
(`common/collision/CollisionContracts.ts`) — a small structural interface, not a subclass
relationship. `ServerPhysics.physicsToss()`'s actual step (gravity → `pushEntity`/trace → clip
velocity against the hit plane → ground-rest check) could be lifted the same way into e.g.
`source/engine/common/physics/TossPhysics.ts`, parameterized over a minimal structural state
(`{ origin, velocity, avelocity, angles }`, satisfied by both `ServerEdict`'s entity and
`ClientEdict` without either needing to change shape) and a single trace-fn matching the raw
internal trace shape both sides already produce (`{ fraction, allsolid, plane }`, not the heavier
public `GameTrace`) — so the server pays no extra allocation on its hot per-tick physics loop.
`ServerPhysics.physicsToss()` would become a thin adapter around it (still owning the
server-only concerns the shared core has no business knowing about: water transitions, ground
entity object references, sound events, `runThink`); the new client helper becomes an equally thin
adapter.

This is deliberately **not** folded into the phasing below as committed scope — it means touching
`ServerPhysics.ts`, a hot, working, already-tested server code path, for a plan whose actual driver
is client-side debris. Flagged as an explicit open question instead: worth doing now while the
shape is fresh, or safer as a follow-up once the client side has a real, browser-verified consumer
to prove the abstraction against on that end too?

### Sequencing: a lightweight, self-timed analog of `_defineState`/`_defineSequence`

Same "keep the pattern, drop the machinery that doesn't apply here" approach as physics. The parts
of the server state machine worth keeping: a typed state-key union so typos are compile errors, and
`_defineSequence`'s collapsing of "N numbered frames, same duration, same callback" into one
declaration. The parts worth dropping: `ScheduledThink`/`nextthink` coupling (client `think()`
already runs every frame — the sequence just needs to remember when it entered the current state
and compare against its own duration) and, especially, the server's function-serialization via
`toString()`/`new Function()` for `ScheduledThink.callback` — already flagged in this repo's own
porting guide as "a security concern... fragile... unnecessary." A client sequence's current state
is just a string key from a statically-declared, typed table; persisting `(state, enteredAt)` is
enough to resume it exactly, with no eval-adjacent reconstruction involved.

```typescript
// source/shared/ClientAnimationSequence.ts
interface ClientSequenceState<S extends string> {
  readonly keyframe: string | number;
  readonly duration: number;      // seconds until auto-advance
  readonly next: S | null;        // null = terminal, stays here until the handler acts
  readonly onEnter?: () => void;
}

export class ClientAnimationSequence<S extends string> {
  constructor(clientEdict: ClientEdict, states: Readonly<Record<S, ClientSequenceState<S>>>, initial: S) { ... }

  /** Call once per think(); advances to `next` once `duration` has elapsed since entering the current state. */
  tick(currentTime: number): void;

  get current(): S;

  /** Jumps directly to a state without waiting out a duration — used to resume from saved data. */
  setState(state: S, enteredAt: number): void;

  /** Flat, JSON-safe snapshot for BaseClientEdictHandler.serialize() to fold in — see save/load below. */
  serialize(): { state: S; enteredAt: number };
}
```

Example: an explosion effect that spawns a dlight on entry, adds smoke midway, and frees itself at
the end — declaratively, instead of the ad hoc frame-counting the beam code in
`#thinkTempEntities` (`ClientEntities.ts:726`) currently hand-rolls:

```typescript
export class ExplosionEdictHandler extends BaseClientEdictHandler {
  #sequence = new ClientAnimationSequence(this.clientEdict, {
    flash:  { keyframe: 's1', duration: 0.1, next: 'smoke', onEnter: () => this.engine.AllocDlight(...) },
    smoke:  { keyframe: 's2', duration: 0.4, next: 'fade' },
    fade:   { keyframe: 's3', duration: 0.3, next: null },
  }, 'flash');

  override think(): void {
    this.#sequence.tick(this.engine.CL.time);
    if (this.#sequence.current === 'fade' /* and its duration has elapsed */) {
      this.remove();
    }
  }
}
```

### Save/load: mirror `R.SerializeParticles()`, don't invent a second mechanism

The precedent in Context above already solves this shape of problem for particles; client-only
entities should plug into the exact same pipeline rather than get a parallel one.

**Telling persistent entities apart from map-baked ones.** Both `svc_spawnstatic` parsing and any
future debris spawner currently go through the same `allocateClientEntity()`
(`ClientEntities.ts:681`) with no way to tell them apart afterwards. Add one `persistent = false`
field to `ClientEdict` (small, additive — doesn't require splitting `static_entities` into two
arrays, so it doesn't force a decision on open question 3 below), set via two thin named allocators
instead of the single generic one:

```typescript
// ClientEntities.ts
allocateStaticEntity(classname: string): ClientEdict {
  return this.allocateClientEntity(classname); // persistent stays false: signon regenerates these
}

allocateSimulatedEntity(classname: string): ClientEdict {
  const ent = this.allocateClientEntity(classname);
  ent.persistent = true;
  return ent;
}
```

`parseStaticEntity()` (`ClientServerCommandHandlers.ts:320`) switches to
`allocateStaticEntity()`; future debris/shell-casing code uses `allocateSimulatedEntity()`. This
also directly resolves problem #2 (the "static" naming overload) at the call-site level — the
intent is explicit in the method name used, not inferred from context.

**What gets captured.** `ClientEntities.serialize()` walks `static_entities`, skips anything with
`persistent === false` or `free === true`, and for the rest captures `classname` + `origin` +
`angles` + `velocity` (the universal fields every client-only entity already has) plus one opaque,
flat, JSON-safe blob from the owning handler:

```typescript
// BaseClientEdictHandler — both optional, default no-ops
serialize(): Record<string, string | number | boolean> | null { return null; }
deserialize(_data: Record<string, string | number | boolean>): void {}
```

A debris handler folds its physics/sequence extras in:

```typescript
override serialize() {
  return { dieTime: this.#dieTime - this.engine.CL.time, ...this.#sequence.serialize() };
}
```

`ClientEntities.deserialize()` re-creates each entry via `allocateSimulatedEntity(classname)` +
`setOrigin()`/angles/velocity + `spawn()`, then hands the blob to the handler's `deserialize()` —
same relative-time-on-save, absolute-time-on-restore trick `SerializeParticles()` already uses for
`die`.

**Wiring, mirroring the particle path exactly:**

- `SavegameState` (`Host.ts:65`) gains `readonly clientEntities: SerializedClientEntity[]`, next to
  `particles`.
- `Host.Savegame_f` (`Host.ts:1213`) gains `clientEntities: CL.state.clientEntities.serialize()`.
- `ClientLifecycle.resumeGame()` (`ClientLifecycle.ts:80`) and `ClientLoadData`
  (`ClientState.ts:30`) gain a third tuple slot, same as `particles` does today.
- The signon-complete handler (`ClientServerCommandHandlers.ts:255-262`) gains
  `CL.state.clientEntities.deserialize(CL.state.loadClientData[2])` next to
  `R.DeserializeParticles(...)`.
- `Def.gamestateVersion` (`Def.ts:148`, currently `2`) bumps to `3` — this changes the save file
  shape, and the existing version check (`Host.ts:1264`) already refuses to load mismatched
  versions, so this is exactly what that check is for.

## Phasing

1. ✅ **Vocabulary fixes** — `isStatic()` → `isClientOwned()`, `nextthink` → `lerpEndTime`, doc
   updates on `static_entities`/`allocateClientEntity()`. Mechanical, ~6 call sites (plus 2 more
   found during implementation: `ShadowMap.ts`'s shadow-caster check, `V.ts`'s viewmodel lerp
   heuristic), no behavior change. Full test suite (1286 tests) green.
2. ✅ **`markFree()` / `remove()`** — added both; no existing handler calls `remove()` yet (none
   needed it before phase 3's debris-like entities exist), but it's now available and tested.
   Unit tests added: `ClientEdict.markFree()` sets `free`; `BaseClientEdictHandler.remove()` calls
   it; `ClientEntities.getEntities()` stops yielding an entity once `remove()` is called on it.
3. ✅ **`ClientEntityPhysics`** — hoisted `clipVelocity`/`GROUND_ANGLE_THRESHOLD`/
   `VELOCITY_EPSILON` into `source/shared/PhysicsMath.ts` and repointed `ServerPhysics`/
   `ServerClientPhysics` at the shared copy (full server physics suite stayed green); added
   `ClientEngineAPI.CL.gravity`; built `ClientEntityPhysics` (gravity integration +
   `Traceline`-based collision + the shared `clipVelocity`), unit-tested in isolation with a mock
   `ClientEngineAPI` (gravity read from `CL.gravity` not hardcoded, position after a step, a floor
   bounce reducing velocity via the shared formula, all-solid short-circuit, and a regression test
   confirming `setOrigin()` — not raw `.origin` mutation — is what moves the entity, including a
   fix to a latent `ClientEdict.linkEdict()` leaf-accumulation bug this phase's repeated-call usage
   surfaced). See Status for details.
4. **`ClientAnimationSequence`** — `tick()`/`setState()`/`serialize()`, unit-tested standalone
   (advance-on-duration, terminal state stops advancing, `setState()` resumes mid-sequence without
   replaying `onEnter` side effects it already fired before a save).
5. **Save/load** — `ClientEdict.persistent` + `allocateStaticEntity()`/`allocateSimulatedEntity()`,
   `ClientEntities.serialize()`/`deserialize()`, the `SavegameState`/`ClientLifecycle`/signon-handler
   wiring, and the `Def.gamestateVersion` bump. This phase has no real consumer to test against
   until phase 6 exists, but the round-trip itself (serialize → deserialize → same classname/
   origin/velocity/handler blob) is fully testable against a synthetic handler, same as phases 2–4.
6. **One real consumer, as a smoke test** — pick the smallest concrete case (shell casings are the
   simplest: spawn on weapon fire, short lifetime, a couple of bounces, no rotation needed) and
   port it end-to-end using phases 2–5, including a save-mid-flight/load round trip, verified in a
   real browser per this repo's usual workflow for client-visible changes. This is what proves the
   new API is actually convenient, not just theoretically so — don't skip it in favor of shipping
   infrastructure nobody has used yet.

## Testing

- `test/client/client-entities.test.mjs` already has the mock-registry pattern
  (`withMockClientEntitiesRegistry`) to extend for `markFree()`/`remove()` tests.
- `test/physics/server-physics.test.mjs`'s existing `clipVelocity` coverage moves with the function
  to a new `test/shared/physics-math.test.mjs` (or gets duplicated as a thin re-export check) —
  either way, one implementation, one set of assertions, imported by both suites so a regression in
  the bounce formula fails both the server and (once phase 3 is done) client physics tests.
- New `test/client/client-entity-physics.test.mjs` for the physics helper: straight-line gravity
  fall with no obstruction (asserting the fall rate matches `CL.gravity`, not a hardcoded number),
  bounce off a horizontal plane (reflect + damp via the shared `clipVelocity`), full stop below a
  velocity threshold, and — importantly — a test asserting `leafs` changes after `step()` moves the
  entity across a leaf boundary (regression test for problem #5 above).
- New `test/client/client-animation-sequence.test.mjs`: auto-advance after `duration`, terminal
  state (`next: null`) stops advancing, `setState()` resumes at an arbitrary point without
  re-firing `onEnter`.
- New coverage (in `client-entities.test.mjs` or a new `client-entities-savegame.test.mjs`) for the
  serialize/deserialize round trip: a persistent entity survives with matching classname/origin/
  velocity/handler blob and relative-time fields re-anchored to the new `CL.state.time`; a
  non-persistent (static) entity is correctly excluded; a `free` entity is correctly excluded.
- Existing tests for `DefaultClientEdictHandler`/`FireballEdictHandler`/`PlayerClientEntity` must
  keep passing unmodified — nothing about their behavior changes in this plan.

## Open questions

1. ✅ **Fork A confirmation** — resolved 2026-09-26: keep `ClientEdict` as one sealed shape with
   opt-in helpers, not subclasses (recommended option).
2. ✅ **Fork B confirmation** — resolved 2026-09-26: composed per-handler `ClientEntityPhysics`
   helper, not a static utility or a `BaseClientEdictHandler` method (recommended option).
3. **`static_entities` array** — resolved differently than originally framed: rather than splitting
   the array, add one `persistent` field plus two named allocators (see Save/load design above), so
   the array stays one pool but save/load, and any future code, can tell entries apart by intent
   without inferring it from context. Agree this is enough, or do you want the array itself split
   (e.g. so `#emitEntities`'s static-entity loop and a future "step all simulated entities' physics"
   loop don't have to filter the same array by different criteria)?
4. **Handler-state blob shape** — recommendation is a flat `Record<string, string | number |
   boolean>` per handler (mirroring `SerializedParticle`'s flat shape), explicitly *not* the
   tagged-union `SerializedData`/`SerializedValue` machinery `BaseEntity` uses server-side. That
   machinery exists to handle entity references, vectors, and nested objects generically across
   ~200 field types; a client-only cosmetic handler's extra state (a die time, a sequence key) is
   never going to need that generality. Agree, or do you expect handler state complex enough
   (nested objects, entity references) to need the heavier format?
5. **Phase 6 target** — is shell casings actually the right first real consumer, or is there a more
   pressing one (e.g. rocket debris, gib physics) that should drive the API instead?
6. ✅ **Full toss/bounce orchestration sharing** — resolved 2026-09-26: not now (recommended
   option). Phase 3 hoisted only `clipVelocity` + the gravity/ground constants, per the design's
   "safe minimum" framing; `ServerPhysics.physicsToss()` itself was left untouched. Revisit the
   full `common/physics/TossPhysics.ts` orchestration-sharing idea later, once the client side has
   a real, browser-verified consumer (phase 6) to prove the abstraction against on that end too.

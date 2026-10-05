# Nav-mesh awareness of moving platforms and activatable geometry (doors, switches)

## Status

🧭 Planning — not started. Written after an assessment of the existing `Navigation.ts`/`AI.ts`/
`Subs.ts` architecture (requested to determine feasibility of monster-aware moving platforms),
extended into a design after follow-up discussion about switch-gated doors and platform waiting.

## Context

QuakeShack already has a real offline-built nav graph with runtime A* — this is not a "walkmove
chase" system alone. `Navigation.ts` (`source/engine/server/Navigation.ts`) samples the static
worldspawn BSP into `Waypoint`s (line 93), merges them into graph `Node`s (line 174) with
`NeighborLink`s (`[id, cost, temporaryCostAdjustment]`, line 23), runs A* (`findPath`, line 1728),
and caches the built graph to a `maps/<mapname>.nav` file. Monster AI (`QuakeEntityAI.thinkNavigation`,
`source/game/id1/helper/AI.ts:354`) periodically calls `ServerEngineAPI.NavigateAsync` (`GameAPIs.ts:841`)
and feeds the returned waypoints into the classic `moveToGoal` chase-step function
(`ServerMovement.ts:179`) as steering bias — the graph doesn't replace movement, it biases it.

**The physics layer already handles riding movers correctly, for any entity.** `pushMove()`
(`ServerPhysics.ts:358`) carries whatever is standing on a pusher via a structural check —
`FL_ONGROUND` + matching `groundentity` (lines 400-402) — with no player/monster distinction. If a
monster steps onto a platform today it already gets carried, exactly like a player. The reason
"monsters never ride lifts" in practice is entirely a path-planning/AI-decision gap, not a physics
one.

**The gap is that the nav mesh is built as if every mover were absent and every door permanently
open.** `#extractWalkableSurfaces()` (`Navigation.ts:993`) samples only `this.worldmodel!.faces`
and explicitly skips brush-submodel faces (line 1023) — a platform's riding surface is never
sampled, a plat shaft has no waypoints at any height a platform might occupy, and a closed door
doesn't block anything because the static trace (`traceStaticWorld`, `ServerCollision.ts:486`)
never touches brush-model entities in the first place — only `SV.collision.move()` (the live,
area-tree-aware trace used by actual gameplay movement) does.

This wasn't left unconsidered — there's scaffolding for exactly this, abandoned partway:

- `NeighborLink`'s third slot, `temporaryCostAdjustment` (`Navigation.ts:23`), is summed into A*
  cost (line 1776) but is always written `0` and never mutated anywhere else in the file.
- `Navigation.relinkEdict()` already fires on every mover relink (wired from
  `ServerArea.linkEdict()`, `ServerArea.ts:337`, which runs every tick a pusher moves), debounced
  per-edict (lines 1501-1508), and calls a private `#relinkEdict()` whose entire body is
  `// TODO: adjust the nav graph accordingly` (line 1514).
- `AI.ts` has a commented-out call to `this._engine.EvaluateTraversalBetween(...)` (lines 415-424)
  — a method that doesn't exist anywhere in the engine today.

**One existing precedent needs to be corrected, not extended.** `#buildDoorLinks()`
(`Navigation.ts:1594`) finds movers by matching `classname === 'func_door'` directly in engine
code — an engine-side assumption about game logic, which is exactly what this plan is meant to
avoid repeating. `#buildTeleporterLinks()` (line 1540) has the same shape via
`FindAllByFieldAndValue('classname', 'trigger_teleport')`.

**The runtime path-request path adds a real constraint.** `findPathAsync()` (`Navigation.ts:1709`)
runs across a worker-thread boundary (`NavigationWorker.ts`) via the event bus
(`nav.path.request`/`nav.path.response`). The worker's own `Navigation` instance loads only bare
`Node` id/origin/neighbor data (`load()`, line 220, explicitly does not deserialize
`WalkableSurface`/`Waypoint` data) and has zero live access to entity state. Any dynamic mover/gate
state that should affect a path result has to be pushed across as an explicit incremental message
— there's no shared memory, and the existing event-bus bridge for `nav.path.request`/`response` is
the model to extend, not replace.

**Quake's `target`/`targetname` linkage is the precondition/effect data this needs, already
present in every map.** A `func_button` with `target = "door1"` and a door with
`targetname = "door1"` already encodes "activating this unlocks that" — no new inference required,
just reading a relationship that's already in the entity data. `Subs.ts`'s `useTargets()`
(line 302) already walks this via `this._engine.FindAllByFieldAndValue`, and
`#buildTeleporterLinks`/`#buildDoorLinks` already use the same engine call for a different purpose.

Established engine/game boundary: `ServerEngineAPI` (`GameAPIs.ts:385`) is the sanctioned mechanism
surface — `Navigate`/`NavigateAsync`, `FindAllByFieldAndValue`, `Traceline`, `GetPVS`, etc. Game
code (`AI.ts`, `Subs.ts`, monster entities) always calls through it or through `BaseEntity`/
`ServerEdict` wrappers, never importing engine internals directly. New mechanism here should follow
that same shape: the engine exposes generic structural detection and state-change notifications;
game code owns classification (what kind of gate/activator something is) and all policy (whether,
when, and how a monster uses that path).

## Goals

- The nav graph geometrically accounts for movers: plat shafts, train paths, and the areas behind
  doors are sampled as real graph regions instead of being silently absent.
- The graph can represent "activate X to unlock edge Y," discovered from existing
  `target`/`targetname` map data — covering both explicit switches and auto-triggered doors/plat
  call-pads under one mechanism.
- Monsters can wait near a mover/gate until it becomes traversable, then proceed.
- All of this is opt-in per monster class/mod. Default `id1` behavior is unchanged — monsters never
  attempt to ride a mover or activate a switch unless a mod (e.g. `hellwave`) explicitly opts a
  monster class in.
- The engine exposes only generic mechanism (movetype/solid structural detection, the
  `target`/`targetname` graph, state-change events). All classification of "this is a door," "this
  is a switch," "this switch may not be used by monsters" lives in game code, via an interface
  defined in `source/shared/` per this repo's engine/game boundary convention.

## Non-goals (this pass)

- No general STRIPS/GOAP planner. A small, fixed set of edge kinds — plain move, gated move,
  activate-and-wait — rather than arbitrary composable actions.
- No multi-monster coordination or contention handling for a shared switch or platform. Two
  monsters redundantly triggering the same button is acceptable.
- No adaptive/learned action-edge costs. Costs are static estimates computed at graph-build time;
  no runtime feedback loop that adjusts them based on observed wait times.
- No support for movers without discrete rest states — only `Sub.calcMove`-driven plat/train/door
  style movers with known `pos1`/`pos2` (or a `path_corner` chain) are in scope.
- Player pathing is untouched — players never consult the nav graph.

## Design

### A. Generic mover/gate detection and classification (engine mechanism + game classification)

Replace `#buildDoorLinks`'s classname match with structural detection: `movetype === MoveType.PUSH
&& solid === Solid.BSP` is already how the engine recognizes a pusher elsewhere
(`ServerPhysics.ts:495`), with no classname involved.

Structural detection alone can't tell the engine a mover's *rest states* or whether monsters are
even allowed to use it — that's classification, and per the goals above it belongs in game code.
Define a marker interface in `source/shared/` (mirroring the `SerializableEntity`/
`Symbol.hasInstance` pattern already used for cross-boundary runtime capability checks — see
`typescript-port.instructions.md`), tentatively `NavGate`:

```typescript
interface NavGate {
  getNavRestStates(): readonly NavRestState[]; // known stop positions/angles, from map data
  isNavTraversable(): boolean;                 // current live state
  readonly monsterUsable: boolean;              // game-side opt-out, e.g. locked/key doors
}
```

`PlatformEntity`, `TrainEntity`, and door entities implement it directly — this is a small,
explicit addition to `Platforms.ts`/`Doors.ts` (they already know `pos1`/`pos2` at spawn time), not
something the engine infers by observing motion. Explicit beats empirical here: empirical inference
from observed `Sub.calcMove` legs can't know about a door that's never been triggered before the
mesh is built, and inference is fuzzier for no real savings in code size.

A companion `NavActivator` interface covers buttons/triggers:

```typescript
interface NavActivator {
  readonly navHintOrigin: Vector;   // where a monster should stand to trigger this
  readonly targetGateNames: readonly string[]; // targetname(s) this affects, from `target`
}
```

The engine's job stays purely structural: find entities implementing these interfaces (via
`instanceof`, same as any other runtime capability marker in this codebase — see
`SerializableEntity`), and walk their already-existing `target`/`targetname` fields. It never
branches on `classname`.

### B. Encoding conditional edges + activation edges in the graph

Two new edge concepts, both keyed to a `NavGate`'s entity id:

- **Gated edge** — a plain move edge with an attached `gateId` and required state. Invalid
  entirely (not just costlier) when the gate isn't in that state. This is a real boolean-valid
  flag, distinct from `temporaryCostAdjustment` — a closed door blocks a path outright, it doesn't
  just make it slower.
- **Action edge** — represents "detour to the activator's hint point, trigger it, wait for the
  effect." Cost is a static estimate (distance to hint point at monster walk speed + a fixed
  trigger/travel delay baked in at build time — see non-goals). Touch-triggered gates (auto doors,
  platform call-pads) use the same shape with the activator being the gate itself or its existing
  companion trigger volume (e.g. `PlatformTriggerEntity`) — so 2.1.1 (auto door) and 2.1.2
  (switch-gated door) are the same mechanism, differing only in whether the action edge's
  "activator" is reached by touch or by an explicit interaction.

Rest-state sampling (Phase 1 below) uses `NavGate.getNavRestStates()` to place waypoints/nodes at
positions a mover occupies at rest (plat top/bottom, door open/closed swept volume), so a plat
shaft or a doorway is a real graph region instead of empty space, even before gating is wired up.

### C. Runtime state propagation, including across the worker boundary

Fill in the abandoned scaffolding rather than inventing a parallel mechanism: `#relinkEdict()`
(`Navigation.ts:1514`) becomes the point where a `NavGate`'s state change updates the validity of
its gated edges and the (currently dead) `temporaryCostAdjustment` gets a real write path for
action-edge costs. A generic event — not classname-scoped — fires when a `NavGate`'s
`isNavTraversable()` changes (a natural place: wherever `Sub._think()` snaps to a final position,
`Subs.ts:187`), and `Navigation` subscribes to it.

Because `findPathAsync` executes in the worker thread with only the bare graph loaded, every gate
state change has to cross via `postMessage`, extending the existing `nav.path.request`/
`nav.path.response` bridge with a small delta message (`gateId`, new validity/cost) rather than a
full graph reload. This is the piece with no existing shortcut — the bridge pattern exists, but the
delta protocol itself is new code.

### D. AI-side execution (policy, strictly opt-in)

A path result needs to carry more than `Vector[]` once it can include action steps. A discriminated
union works cleanly here:

```typescript
type PathStep =
  | { type: 'move'; origin: Vector }
  | { type: 'activate'; origin: Vector; activatorEntityId: number }
  | { type: 'wait'; origin: Vector; gateEntityId: number };
```

`QuakeEntityAI.thinkNavigation`/`run()` (`AI.ts:354`, `772`) gain new think states to execute
`activate`/`wait` steps — genuinely new state-machine logic, not a small tweak. This is also where
"opt-in" actually lives: add a capabilities flag (e.g. `navCapabilities: { canRideMovers,
canActivateGates, canWaitForGates }`) to `BaseMonster`/`EntityAI`, defaulting every flag `false`, so
`id1` monsters are byte-for-byte unchanged unless a mod sets them. `NavigateAsync`/`findPathAsync`
take the requesting monster's capabilities as a filter parameter so the same built graph serves
different valid paths to different monsters — building separate graph variants per capability set
doesn't scale and isn't needed if filtering happens at request time.

Per `event-bus.instructions.md`, any new event introduced here (gate state change, worker delta)
needs an entry in `docs/events.md` (or `source/game/<mod>/docs/events.md` if the event turns out to
be game-owned rather than engine-owned) — flagging this now so it isn't missed during
implementation, per the `event-bus-docs-sync` skill.

## Phasing

1. **Cleanup** — replace `#buildDoorLinks`/`#buildTeleporterLinks`'s classname matching with
   structural `MoveType.PUSH`/`Solid.BSP` detection plus the new `NavGate`/`NavActivator`
   interfaces (empty/unused by anything yet). No behavior change, addresses the "clean up func_door
   to match our new way of thinking" ask on its own, safe to land and test independently of
   everything below.
2. **Geometric awareness** — sample `NavGate.getNavRestStates()` positions into the graph so plat
   shafts and door openings become real regions. No gating yet (mesh still treats every gate as
   traversable), so a path can still route a monster into a currently-closed door — this phase only
   fixes "the graph pretends movers don't exist," not "the graph respects their current state."
3. **Gating** — live-state validity on gated edges, `#relinkEdict` filled in, worker delta sync.
   Paths now correctly avoid a currently-closed gate.
4. **Activation edges** — `NavActivator`/`target`/`targetname` discovery, action-edge insertion,
   the richer `PathStep` result type.
5. **AI execution** — new `QuakeEntityAI` think states for `activate`/`wait`, `navCapabilities`
   flags wired into `BaseMonster`, request-time capability filtering in `NavigateAsync`.
6. **Opt-in adoption + tooling** — flip capabilities on for a first real monster (likely in
   `hellwave`, per the original ask), extend the existing `nav_debug_graph`/`nav_debug_path` cvars
   to visualize gates and action edges for tuning.

## Testing

- Unit coverage for rest-state sampling (`getNavRestStates()` → correct waypoints/nodes appear for
  a synthetic plat/door fixture), gate validity toggling (edge flips valid/invalid on state-change
  event), `target`/`targetname` → action-edge discovery (including the `monsterUsable: false`
  opt-out), the worker delta protocol (a gate-state message updates the worker's copy without a
  full reload), and the new `QuakeEntityAI` think states (`activate` reaches and triggers the
  entity, `wait` blocks until `isNavTraversable()` flips, then resumes).
- New synthetic map fixtures alongside the existing `test/physics/fixtures.mjs` helpers
  (`createBoxBrushModel`, etc.) for a minimal switch-gated door and a minimal platform, so graph
  tests don't depend on a real `.bsp` asset.
- Regression: existing `Navigation.ts`/`AI.ts` test suites must stay green throughout — this is
  additive machinery behind new interfaces and opt-in flags, not a rewrite of path-request behavior
  for monsters that don't use it.

## Open questions

1. **Rest-state discovery — explicit interface vs. empirical inference.** Recommendation above is
   an explicit `NavGate.getNavRestStates()` implemented by `PlatformEntity`/`TrainEntity`/door
   entities. Agree, or is empirical inference (watching `Sub.calcMove` legs over the entity's
   actual runtime lifetime) worth the fuzziness to avoid touching `Platforms.ts`/`Doors.ts` at all?
2. **Interface location.** Proposed home is `source/shared/NavGate.ts` (engine-agnostic contract,
   engine type-checks against it without importing game code, game entity classes implement it),
   matching `source-directories.instructions.md`'s "data structures declared in the engine can be
   re-exported here" plus the `SerializableEntity` marker precedent. Agree with this split, or
   should the interface live engine-side with game code importing it instead?
3. **Capability filtering: request-time vs. build-time graph variants.** Recommendation is a
   capability bitmask/flags object passed into `NavigateAsync`/`findPathAsync`, filtering which
   edge kinds are eligible per request, against one shared built graph. Agree, or is there a reason
   to prefer separate graphs per capability set (e.g. performance, if per-request filtering turns
   out too expensive in the worker)?
4. **Action-edge cost estimation.** Fixed heuristic (walk distance + a flat trigger/travel delay
   constant) computed at build time, per the non-goals — no adaptive/observed-cost feedback in this
   pass. Confirm this is fine to defer, or is inaccurate cost estimation (e.g. a monster
   consistently preferring a "shorter" path that's actually slower once wait time is counted) likely
   to be visible enough to need better numbers sooner?
5. **Contention.** Two monsters both pathing through the same action edge concurrently is accepted
   as fine for v1 (the second monster's `wait` step just resolves immediately if the gate's already
   open by the time it arrives). Confirm, or does this need explicit handling (e.g. claiming/
   reserving an activator) even for a first pass?
6. **Scope of "activatable."** v1 as scoped covers explicit switches/buttons and auto-touch
   doors/platform call-pads only. Deliberately excluded: key/item-gated locked doors and anything a
   mapper intends monsters to never open (matching original Quake's assumption) — handled via
   `NavGate.monsterUsable = false`, which the game side sets per entity/classname as needed. Confirm
   this boundary, or should key-gated doors be in scope from the start (e.g. if a monster carrying
   or "aware of" a key should be able to use it)?

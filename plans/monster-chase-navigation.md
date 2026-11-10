# Monster chase navigation: where a chasing monster goes, and how it gets there

## Status

🚧 Phase 1 done (2026-11-10), Phase 2 next. All decisions made with the developer on 2026-11-10. Corner sticking
was measured before any code changed (see "Measured" below).

## Context

Playtesting id1 turned up two AI bugs. Their QuakeC deviations (pain without a run state, infighting
without `T_Damage`'s rules) are fixed in `source/game/id1` (`QuakeEntityAI.reactToDamage`,
`BaseMonster.provoke`/`retaliatesAgainst`). The rest of the "enemies don't see the player while
following a path" report is in the waypoint logic layered on top of the QC chase. The developer
calls that logic botched and wants it reworked.

### How chasing works today

`QuakeEntityAI.thinkNavigation()` (`source/game/id1/helper/AI.ts`) runs on every think while a
walking monster has an enemy:

1. **Destination.** It paths to `GameAI._sightEntityLastOrigin`, one position shared by all monsters
   (the "hive mind", commit `d8d2b95`). `foundTarget` writes it for any target, monsters included.
   `thinkNavigation` refreshes it from a visible enemy at most every 10 s (`nextKnownOriginTime`).
   An infight therefore redirects every monster chasing the player to the brawl. A monster that sees
   the player keeps walking to where it saw them up to 10 s ago.
2. **Requests.** It calls `NavigateAsync(origin, lastOrigin)` when `nextPathUpdateTime` has passed,
   then waits 10–15 s. It replans early only on a new enemy, on the 10 s sight refresh, and when the
   monster moved more than 64 units since its last think. That last check compares the monster with
   itself frame to frame, so it fires on teleports only. Several requests can be in flight. Whichever
   answer arrives last wins, even if the enemy changed or the answer is older. The answer is dropped
   only when the monster's edict is free.
3. **Advancing.** It drops `path[0]` once the monster is within 45 units on the XY plane (`32 * 1.41`).
   `path[0]` is the monster's own position at request time (`findPath` makes the start position the
   first point). Nothing notices a waypoint the monster has already walked past, so it turns back to
   it. Nothing notices a monster that stopped making progress (a waypoint it can't reach, a closed
   door). It stays stuck until the next replan, 10–15 s later. The XY-only check also accepts a
   waypoint on the floor above or below. A commented-out `EvaluateTraversalBetween` call (an engine
   method that never existed) was meant to catch obstructed links.
4. **Steering.** `run()` passes `path[0]` to `moveToGoal(dist, target)` whenever a path exists, even
   with the enemy in plain view. `ServerMovement.moveToGoal` (`source/engine/server/physics/ServerMovement.ts`)
   keeps the old `ideal_yaw` 75% of the time. It re-aims at the target only on a 25% roll or when
   blocked, then picks one of eight 45° directions in `newChaseDir`. Monsters zigzag, overshoot
   waypoints by more than 45 units and turn back. The `TODO` at `ServerMovement.ts:200` calls this
   "chase ping-pong".
5. **Who navigates.** Only walking monsters; `FL_FLY`/`FL_SWIM` return early. `hellwave` depends on
   this heavily: its monsters spawn away from the players and get `hunt()`ed toward them.

### What the engine gives the AI

- `Navigation` (`source/engine/server/Navigation.ts`) builds a graph from the static world BSP. A
  sample walker of 32×32×64 (`NAV_MONSTER_MINS/MAXS`) is placed on walkable faces, samples are merged
  into `Node`s 24 units apart, and nodes are linked when `#evaluateTraversalBetween` passes. The graph
  is cached as `maps/<map>.nav` (format `NAV_FILE_VERSION = 3`; another version is rebuilt on load).
  39 meshes ship in `data/` (35 id1, 4 hellwave).
- A* runs in `NavigationWorker.ts`. The worker loads only node ids, origins and links (0.9 MB of heap,
  `docs/server-worker.md`). It has no world, no collision and no entity state. Requests and answers
  travel as `nav.path.request`/`nav.path.response` on the event bus. The thread that serves the
  server never loads the graph, unless it just built it.
- `findPath` takes the node nearest to the start and the node nearest to the goal, within 512 units,
  **without any reachability check**. A start beside a thin wall can get the node behind the wall, and
  the first leg is then unwalkable. Path points are node origins (stand origins, 24 units above the
  floor), with the exact start and goal positions at either end.
- **Every path is for the 32-wide walker.** Shambler, Ogre, Fiend, Vore and Dog are 64 wide
  (`_size` ±32), so they get paths through gaps they don't fit through.
- `ServerEngineAPI.NavigateAsync(start, end)` is the game-facing call (`Navigate` is the deprecated
  synchronous one). `hellwave` also uses it for player hints (`GameManager.showNavigationBuyzoneHint`,
  `showLastEnemyHint`).
- `nav_debug_path 1` draws every returned path, which is enough to watch the rework in a playtest.

### Measured before any change: corners and unwalkable links (2026-11-10)

The developer remembered that monsters following paths got stuck on corners, so this was measured before Phase 1
with `scripts/simulate-monster-chase.mts`. The script steps a monster along `findPath` paths on a real map with the
server's own `ServerMovement` (`movestep`, `stepDirection`, `newChaseDir`), world collision only, 10 AI frames a
second and the knight's or ogre's run speeds. "Stuck" means less than 16 units of progress in 2 s.

**Corners cost little arrival but a lot of turning in place, and aiming at the waypoint removes it.** On paths
with no drop or climb taller than a step that a hull can sweep through, small monsters (knight):

| map | today's steering | aim at the waypoint | frames without movement (today → aim) |
|---|---|---|---|
| e1m1 | 95.3% arrive | 100% | 4.6% → 0.3% |
| e1m2 | 97.1% | 100% | 4.1% → 0.1% |
| e1m3 | 93.5% | 97.6% | 6.2% → 1.4% |
| e1m4 | 98.0% | 100% | 4.4% → 0.2% |
| e1m5 | 95.6% | 100% | 5.3% → 0.3% |
| e1m6 | 100% | 100% | 5.4% → 0.6% |
| e1m7 | 98.8% | 99.4% | 3.5% → 0.2% |

Today's monster keeps its old heading 75% of the time, picks one of eight 45° directions when blocked, and
`stepDirection` reports success while it only turns (it puts the monster back when facing more than 45° away). At
a corner it turns back and forth in place, 3.5–6.2% of all frames, which is what a player sees as a monster stuck
at a corner, and now and then it doesn't get loose (0–6.5% of paths). Aiming at the waypoint every frame, with QC's
`newChaseDir` only when the step fails, cuts the turning in place by 4–20 times. Large monsters on the few paths
that fit them: e1m4 95.8% → 100%, e1m7 86.7% → 91.1% (45 paths).

Two more ideas were measured and dropped because they changed nothing: skipping waypoints the monster has already
passed, and sliding along the wall that blocks a step. How close a waypoint counts as reached matters for large
monsters only: within 24 units is best (e1m7 ogre: 78.9% at 24, 77.2% at 32 and 45, 55.3% at 16, 51.8% at 12);
small monsters arrive the same from 16 to 45.

A first run of these measurements had a harness bug: a monster stopped moving once its last waypoint counted as
reached, so a 45-unit reach left it short of the 32-unit arrival. It made today's steering look far worse
(63–84%) than it is. The numbers above are from the fixed harness, which keeps heading for the goal like the
game's chase does after its path ran out.

**What still strands monsters is the graph, not steering.** 2.0–3.3% of graph links can't be walked by a monster at
all (6000 sampled links per map, walked in 8-unit `movestep`s):

| map | unwalkable links | drops (taller than a step) | level links | climbs |
|---|---|---|---|---|
| e1m1 | 2.8% | 149 of 265 | 15 of 5614 | 4 of 121 |
| e1m3 | 3.3% | 118 of 231 | 70 of 5623 | 10 of 146 |
| e1m5 | 2.7% | 41 of 125 | 112 of 5782 | 9 of 93 |
| e1m7 | 2.0% | 61 of 103 | 42 of 5841 | 18 of 56 |

- **Drops**: the builder allows dropping up to 256 units (`NAV_TRAVERSAL_DROP_LIMIT`, "AI can fall/step off
  ledges"), but `movestep` never steps off a ledge taller than 18 units (QC's `checkBottom`), so the monster
  waits at the edge. A* charges nothing extra for a drop. Over all random e1m1 paths 52% of the monsters fail at
  a drop.
- **Gaps**: the builder samples the floor along the link's centerline. `checkBottom` refuses a step that leaves
  a corner of the box over more than 36 units of air. A 24-wide gap in e1m1's floor near (1140, 1028, −280) is
  walkable for a player, linked in the graph, and impassable for a monster in both directions.
- Over all random paths, small monsters arrive on e1m1 37% of the time (today's steering 37.3%, aiming 37.7%)
  and on e1m3 66–68%. Removing the ledge links from the graph lifts e1m1 to 86.3% and e1m3 to 85.7% (aiming;
  today's steering 81.7% and 82.0%). Stepping off ledges instead (a simulated drop with the floor found below)
  reaches 57.0% and 85.0%.
- Replanning when stuck doesn't help with any of these: the new path uses the same kind of link.
- Large monsters (ogre) on walkable paths not checked for their size arrive 72–79% of the time with aiming
  (66–74% today; e1m1, e1m3, e1m7). The rest are routed through gaps narrower than 64 units: only 1–45 of 88–244
  paths per map fit a 64-wide box all the way, which is design D's problem.

### Decisions made with the developer (2026-11-10)

1. **Destination: own memory plus the hive mind.** Each monster remembers where it last saw *its own*
   enemy and paths there. The shared point is written for player targets only. It seeds a monster
   that never saw its enemy itself (woken by another monster, `hunt()`, `use()`).
2. **A visible enemy is charged directly, with the path as fallback.** Like QC, a monster charges
   straight at an enemy it can see. It uses the path when the enemy is on another level (height
   difference) or when charging made no progress for about a second.
3. **Steering is fixed in the engine.** `moveToGoal` with a target point first steps straight toward
   it, then falls back to QC's `newChaseDir`. Only nav callers pass a target, so plain QC chasing is
   unchanged.
4. **Engine-side path quality is in scope.** Start and goal nodes must be reachable, and big monsters
   get paths they fit through.
5. **The server thread loads a node index to pick reachable nodes** (design C). Rejected: BSP collision
   in the worker (a second copy of the world, against `plans/server-model-memory.md`), and checking
   the first leg after the answer and retrying (a round trip of latency each time).
6. **Big monsters get `fitsLarge` flags on the one graph** (design D). Rejected: a second graph per
   hull (double build time, `.nav` size and worker memory).
7. **Monster paths avoid drop links** (design D), as QC monsters never walk off ledges; a monster whose
   enemy can only be reached by dropping waits at the edge. A mod may opt in later through the
   `NavigateAsync` options; that option and the drop movement are not part of this pass. Rejected:
   monsters dropping down (a QC behavior change, 57% arrivals in the simulation) and small drops only.

## Goals

- A monster chasing an enemy it can see closes in on it, the way QC monsters do.
- A monster chasing an enemy it can't see walks a sensible path to where it last saw it (or where the
  hive mind says the player was), and gets there.
- Paths are current: answers to an old request or for an old enemy are dropped, and a target that
  moved away gets a new path within about a second.
- A stuck monster notices it within about a second and recovers (replans, or charges directly).
- Monsters follow waypoints without zigzagging, overshooting or turning back.
- Paths start and end at nodes reachable from the actual positions, and fit the monster's hull.
- No QC behavior changes when navigation is off (`nav_enabled 0`) or no `.nav` exists.

## Non-goals (this pass)

- Flying and swimming monsters (the graph is for walkers).
- Monsters stepping off ledges, and the `NavigateAsync` option a mod would use for it (decision 7).
- Movers, doors and switches as path conditions (`plans/nav-dynamic-mover-awareness.md`).
- Group tactics: flanking, spreading out, several monsters coordinating a route.
- Changing how monsters *notice* the player (`findTarget`, sight entity). That is QC and stays QC.
- Path smoothing (no skipping waypoints, no string pulling, no splines): measured, it adds nothing to arrivals.

## Design

### A. Engine: `moveToGoal` steers toward a target point (`ServerMovement.ts`)

When `moveToGoal` gets a `target`:

1. If `closeEnough` to the goal entity, stop (as today).
2. Set `ideal_yaw` to the exact yaw from the monster to `target` and try `stepDirection` along it.
   `stepDirection` already turns at `yaw_speed` and refuses to move while facing more than 45° away,
   so a sharp turn spends a frame or two turning in place, as in QC.
3. If that step fails, fall back to `newChaseDir(target)` as today.

Without a `target` the QC 75/25 behavior stays untouched, `Math.random` calls included. Resolves the
`TODO` at line 200. This is the "aim" policy of `scripts/simulate-monster-chase.mts`, measured above.

### B. Game: a `ChaseNavigator` component (`source/game/id1/helper/ChaseNavigator.ts`, new)

All waypoint logic leaves `QuakeEntityAI` and moves into one `@serializableObject` class that
`QuakeEntityAI` owns, as it owns `EnemyMetadata`. It covers:

- **Enemy memory** (decision 1): `lastKnownOrigin` and `lastSeenTime` for the current enemy. Updated
  on every `run()` frame in which the enemy is visible; `foundTarget` seeds it. A monster that never
  saw its enemy (`hunt()`, `use()`, woken by the sight entity) takes the hive-mind point when the
  target is a player, else the target's current origin. `GameAI._sightEntityLastOrigin` is written
  only for player targets.
- **Mode per frame** (decision 2): `direct` when the enemy is visible and on the same level
  (|Δz| below a step-and-a-bit, about 48 units), otherwise `path`. A `direct` mode with no progress
  (distance to the enemy not shrinking for 1 s while not attacking) switches to `path` for 3 s.
- **Requests**: at most one in flight, tagged with a sequence number. An answer is dropped when its
  sequence number is stale, the monster is dead or freed, or the enemy changed in between. A replan
  is wanted when the enemy changed; when the remembered position moved more than 64 units from the
  path's end; when the path ran out with the enemy still not reached; and when stuck. It is sent at
  most once a second per monster, with a random 0–0.3 s stagger so a woken room doesn't request in the
  same frame. The in-flight state is not serialized: a loaded game has no request in flight and
  simply replans.
- **Advancing**: `path[0]` (the request's start) is dropped when the answer arrives. A waypoint
  counts as reached within 24 units on the XY plane and 48 vertically.
- **Stuck detection**: when the distance to the current waypoint hasn't shrunk by 8 units within
  1 s, the monster replans. If the replan returns the same first waypoint, it drops it and goes for
  the next one. This catches what is left after D: a door that closed, another monster in the way.
  It does not rescue an unwalkable link (measured), which is why D walks every link.
- **Output**: `run()` asks the navigator for the steering target (`null` for direct, else the current
  waypoint) and passes it to `moveToGoal`.

`thinkNavigation` and the dead `_oldKnownOrigin`/`nextKnownOriginTime`/`nextPathUpdateTime` fields
go away. `EnemyMetadata.lastKnownOrigin` moves into the navigator. These are saved fields, so the
serialized field list of `QuakeEntityAI` changes; an old save loads with an empty navigator and
replans.

### C. Engine: reachable start and goal nodes (`Navigation.ts`, `NavigationWorker.ts`)

The worker can't trace, so the server thread picks the nodes:

- The server thread loads a node index (ids and origins plus the octree, without links and
  surfaces) next to the worker's full graph (decision 5). It is built in the same `Navigation.load`
  pass in an index-only mode, about 0.5 MB per map.
- `findPathAsync` takes up to 8 nearest nodes for the start and for the goal from the octree. It picks
  the nearest one whose leg from the position is clear, by `traceStaticWorld` with the walker's box.
  It sends both node ids in `nav.path.request`. The worker runs A* between those nodes and keeps
  appending the exact start and goal positions. No reachable node within 512 units answers `null`
  without asking the worker.
- The `nav.path.request` arguments change, so `docs/events.md` and `EngineEvents.ts` change with it
  (`event-bus-docs-sync`).

### D. Engine: links a monster can walk, per hull (`Navigation.ts`, `ServerEngineAPI.ts`, `GameInterfaces.ts`)

This merges the big-monster flags (decision 6) with the measured graph defects: a link is only offered to a hull
when a monster of that hull can walk it with the movement rules monsters use.

- At build time each link that passes `#evaluateTraversalBetween` is walked in 8-unit steps with
  monster movement rules: a step up of at most 18 units, a step down of at most 18 units, and
  `checkBottom`'s corner check. The step and floor checks are shared with `ServerMovement`
  (extracted so the builder runs them against `traceStaticWorld`) rather than copied, so the graph
  and the movement can't drift apart again. It is walked once with the small box and once with the
  64-wide box (±32 XY, −24…64 Z, Quake's hull 2).
- Each link gets flags: `walkableSmall`, `walkableLarge`, and `drop` (a ledge taller than a step
  somewhere along it). A drop link is never walkable, and monster paths don't use it (decision 7).
  Links walkable by neither and not a drop are kept for player hints (`hellwave`), so a request
  without options sees today's graph.
- The `.nav` format becomes version 4, The `.nav` format becomes version 4,
  which rebuilds old meshes on load, and the 39 shipped meshes are regenerated
  (`nav_build_process 1` per map).
- A* takes a hull class and skips links that don't fit it. Node selection (C) traces with the
  matching box.
- `NavigateAsync(start, end, options?)` gets an optional `{ mins, maxs }`. The engine picks the
  smallest nav hull that encloses it; without options it uses the small walker as today, so
  `hellwave`'s player hints don't change. `ChaseNavigator` passes the monster's `mins`/`maxs`.
- A node whose origin is too close to a wall for the large box would make 64-wide corridors that
  aren't centered on nodes look blocked. Phase 4 starts by **measuring** how many links of
  e1m1–e1m7 lose large clearance before deciding whether nodes need a nudged large-hull origin.
- Walking every link costs build time (about 180k links on e1m1, ~40 per node). Phase 4 measures the
  build time on e1m1 before and after; if it more than doubles, links longer than 64 units are walked
  only when their straight sweep isn't clear.

## Phasing

Each phase ships on its own and leaves tests and lint green.

1. **Phase 1, engine steering (A).** `moveToGoal` with a target. `server-movement.test.ts`: a monster
   given a target off its current heading moves toward it on the first step, and the targetless path
   is unchanged. Small, and lands first because B relies on it.
2. **Phase 2, game navigator (B).** `ChaseNavigator`, per-monster memory, direct/path modes, request
   tagging and throttling, advancing, stuck detection. Uses today's `NavigateAsync`. Fixes most of what
   players see. Playtest in id1 (e1m1, e1m2) and hellwave.
3. **Phase 3, reachable nodes (C).** Engine-only; the game API is unchanged.
4. **Phase 4, walkable links per hull (D).** Measure first (large-hull clearance, build time), then
   link walking with shared movement rules, format v4, the API option, regenerated meshes, and
   `ChaseNavigator` passing its size. After Phase 2 this phase fixes
   the most stranded monsters (the tables above), so it may be worth doing before Phase 3.

## Documentation

- **New `docs/navigation.md`** (Phase 3, extended in Phase 4): how the graph is built and cached, the
  worker split, node selection, hull classes, `NavigateAsync` and its options, `nav_*` cvars, and the
  `.nav` versioning and regeneration. Engine-level and game-agnostic. Listed in `docs/README.md`.
- **`docs/events.md`** (Phase 3): the new `nav.path.request` arguments.
- **`docs/game-module-contract.md`** if it lists engine API calls (Phase 4): the `NavigateAsync` option.
- **id1 `README.md`** (Phase 2): a short section on how monsters chase (QC sighting, own memory and
  hive mind, direct versus path), pointing to `docs/navigation.md`.
- **JSDoc** on `moveToGoal` (Phase 1), `ChaseNavigator` (Phase 2), `findPathAsync`/`findPath`
  (Phase 3), `NavigateAsync` (Phase 4).
- `README.md` feature list: no change, "Navigation meshes for smarter NPCs" already covers it.

## Testing

- **`scripts/simulate-monster-chase.mts`** is the acceptance measure for every phase: the tables under
  "Measured" are the baseline, and each phase records its new numbers in "What actually shipped". Run it
  with `node --import tsx scripts/simulate-monster-chase.mts e1m1 300 1` (switches in its header).

- **Phase 1**: `test/physics/server-movement.test.ts`, steering toward a target point, and the
  targetless QC path still consuming `Math.random` as before.
- **Phase 2**: `source/game/id1/test/helper/chase-navigator.test.ts` (new), on a fake engine whose
  `NavigateAsync` resolves when the test says so: a stale answer is dropped, an answer for a changed
  enemy is dropped, a waypoint on another floor is not taken as reached, the stuck timer replans, direct mode charges a
  visible enemy on the same level, and an enemy one floor up uses the path. A serialization test with
  `serializableFieldsOf` for the new saved fields.
- **Phase 3**: `test/physics/navigation.test.ts`, a start beside a thin wall gets the node on its own
  side. The existing `test_e1m1.nav` regression keeps passing.
- **Phase 4**: `navigation.test.ts`, a 48-wide corridor has links for the small walker but not for
  the large hull, and a large-hull request routes around it. The `Navigation.load (outdated meshes)`
  test covers version 4.
- **Playtests** (the developer's, no automated equivalent): e1m1/e1m2 with `nav_debug_path 1`, the
  scenarios from the original report (a patrolling knight, an ogre losing sight around a corner, a
  shambler in a doorway) and a hellwave round. A browser pass runs only with the developer's go-ahead
  (GPU heat), one run at a time.

## Open questions

None. Decisions 1–7 are recorded under Context.

## What shipped

### What actually shipped in Phase 1

- `ServerMovement.moveToGoal` (`source/engine/server/physics/ServerMovement.ts`) with a `target` steps along the
  exact yaw to it and falls back to `newChaseDir(target)` only when that step fails. Without a target it is QC's
  chase as before, `Math.random` calls included. The `TODO` about chase ping-pong is gone.
- Not in the design: `moveToGoal` now returns what its JSDoc always claimed, true when the entity moved or turned
  toward a new direction. It used to return true only when `newChaseDir` ran and false after a successful step;
  no caller read it. `newChaseDir` returns whether one of its directions worked, for that.
- JSDoc on `ServerMovement.moveToGoal`, `ServerMovement.newChaseDir` and `ServerEdict.moveToGoal`. No other docs.
- Tests (`test/physics/server-movement.test.ts`): heading straight for a target point off the current heading,
  the chase direction toward the target point when blocked, QC's roll without a target, and the new return values.
  The ten `ServerMovement` tests in `test/physics/collision-regressions.test.ts` were copies of tests in
  `server-movement.test.ts` (one of them pinned the old target behavior) and were removed.
- `scripts/simulate-monster-chase.mts` (new) has a policy calling the shipped `moveToGoal(dist, waypoint)`: it
  matches the measured "aim" policy frame for frame on e1m1–e1m3, so the "Measured" tables are Phase 1's numbers.
- In the game, id1 still counts a waypoint as reached within 45 units on the XY plane until Phase 2. Measured with
  the shipped steering, that costs little: e1m1 small monsters 98.9% instead of 100%, ogres 68% instead of 72%.


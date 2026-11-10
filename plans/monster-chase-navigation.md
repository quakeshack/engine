# Monster chase navigation: where a chasing monster goes, and how it gets there

## Status

🚧 Phases 1, 2, 4 and 5 done (2026-11-10), smoke-tested by the developer in a running game (2026-11-11); Phase 3 open. Decisions 1–10 made
with the developer on 2026-11-10. Corner sticking was measured before any code changed (see "Measured" below).

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
2. **A visible enemy is charged directly, with the path as fallback.** Narrowed in Phase 2 by measurement: only
   within 256 units (see What shipped in Phase 2). Like QC, a monster charges
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
- Movers and switches as path conditions, monsters riding lifts or pressing buttons (`plans/nav-dynamic-mover-awareness.md`).
  Doors that cut monster links while closed are Phase 5, the first slice of that plan.
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

### E. Doors cut links while closed (Phase 5)

Every doorway is linked as if its door were open: the builder traces the static world only, and a door is a brush
entity. In id1 a plain door spawns a trigger field that opens it for any living actor, monsters included
(`TriggerFieldEntity.touch`, as in QuakeC), so monsters walk through those, after a short wait. Doors without a
trigger field (`Doors.ts`: shootable doors, doors with a `targetname`, key doors) open only when shot, fired, or
touched by a player with the key; the door's own `touch` is player-only. A monster routed through one of those while
it is closed walks into it, gets stuck, replans, and gets the same path again. For a player (`hellwave`'s hints) a
shootable or plain door is passable, a key door only with the key, a fired door only once fired.

This is the gating part (phase 3) of `plans/nav-dynamic-mover-awareness.md`, cut down to doors that stay where they
are: no rest-state sampling, no activation edges, no monsters pressing buttons or riding lifts.

- **Build: which links a door cuts.** For each door, the builder sweeps the hull boxes along every link near the
  door's closed position against the door's own brush model (`ServerCollision` traces a single entity's model), and
  records the links it blocks. The worker can't trace, so the records go into the `.nav` file, keyed by the door's
  model name (`*12`, stable for one map build): format v5.
- **Which entities are doors** is game knowledge. The mover plan replaces `#buildDoorLinks`'s `func_door` match with
  structural detection (`MOVETYPE_PUSH` and `SOLID_BSP`) plus a game-side marker; Phase 5 needs at least the
  structural part, so it takes that cleanup on.
- **Runtime: the game reports, the engine relays.** The game tells the engine whether a door blocks monsters and
  whether it blocks players (`ServerEngineAPI`, open question 1). The server thread publishes the change to the worker
  (a new event, `docs/events.md`), which sets or clears a blocked bit on that door's links; the flags byte from
  Phase 4 has bits free (`BLOCKED_MONSTERS`, `BLOCKED_PLAYERS`), and A* already checks the flags of every link.
- **On `nav.load`** (map start, a loaded game) the server thread sends every door's current state, so the worker
  never searches with stale doors.
- **`ChaseNavigator`** replans when a door on its current path closes, instead of waiting for its stuck timer.

Decided with the developer (2026-11-10), the recommended defaults:

8. **The game reports door state with one engine call per change** (`SetNavigationBlocked(edict, monsters, players)`
   on `ServerEngineAPI`), from the door's own state changes. The engine doesn't poll and stays game-agnostic.
9. **A door that is opening or closing is blocked until it is fully open.** A plain door a monster opens itself is
   never blocked for monsters.
10. **Anything the game reports as a door counts**, rotating and secret doors included. The builder records the links
    of every pusher (`MOVETYPE_PUSH`, `SOLID_BSP`) at the position the map builds it in (its model at origin zero, which
    is where a mapper draws a door closed); movers the game never reports never block anything.

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
5. **Phase 5, doors cut links while closed (E).** Added with the developer on 2026-11-10 after Phase 4. Measure first
   (links per door on e1m1–e1m7, build time), then link-to-door records in the `.nav` file, the state event to the
   worker, the game reporting door state, and `ChaseNavigator` replanning when a door on its path closes.

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

None. Decisions 1–7 are recorded under Context, 8–10 under design E.

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

### What actually shipped in Phase 2

- `ChaseNavigator` (`source/game/id1/helper/ChaseNavigator.ts`, new), a serialized component of `QuakeEntityAI`:
  `remember(origin)`, `reset()`, `steer(enemy, visible)`, as designed in B: one counted request at a time, tagged,
  answers dropped when stale, after an enemy change or a death; at most one request a second plus up to 0.3 s of
  stagger; replans when the enemy changed, the remembered position moved more than 64 units from where the path
  leads, the path ran out short of it, or the monster is stuck; a waypoint is reached within 24 units on the plane
  and 48 vertically; a stuck waypoint is skipped when the new path starts with it again; no path → ask again in 3 s.
  `thinkNavigation`, `_oldKnownOrigin`, `_path` and `EnemyMetadata`'s path fields are gone (the dead freed-enemy
  check stays as `_dropFreedEnemy`); the commented-out `EvaluateTraversalBetween` call is gone too.
- Deviations from the design, each measured with `scripts/simulate-monster-chase.mts`, which got a policy that drives
  the real `ChaseNavigator` (async frames, requests answered by `findPath`, an enemy that counts as visible when a
  line from the monster's eyes reaches it):
  - **Charging aims at the enemy's position** (`moveToGoal` with the enemy as target) instead of QuakeC's chase:
    with QuakeC's chase, 8% of e1m1 knights stalled for 2 s or more while charging (they got loose later); aimed,
    none did.
  - **Charging only within 256 units** (`CHARGE_DISTANCE`), which narrows decision 2. Charging at any distance
    stranded up to 7% more knights than following the path (e1m5 95.6%, e1m6 96.8%, e1m7 92.4% against 100%, 100%
    and 99.4%): a straight line
    that looks clear over a long distance runs into ledges and gaps, and after the 3 s on the path the monster
    charged into them again. Measured on e1m3/e1m5/e1m6/e1m7: never charging 98.4/100/100/99.4%, charging within
    256 units 98.4/100/100/98.8%, within 256 plus only on the same step height and staying on the path until it ends
    no better. Closer than 96 units `steer` leaves the chase to QuakeC's `movetogoal`, which stops when close enough.
  - **Stuck means no headway**: how far the monster moved toward its target since it last made 8 units of it, not
    whether the distance shrank, so an enemy running away doesn't count against the monster. A gap of more than
    0.5 s between run frames (an attack, a pain animation) restarts the timer.
  - **The hive-mind point is written only when a monster sees a player**: on run frames with the player in view,
    and when `findTarget` spots the player itself. `foundTarget` no longer writes it (that is how infighting
    redirected every chaser), and `use()` doesn't either.
  - **Memory is seeded in `foundTarget`** with the target's position (seen, hurt by it, sent after it by `hunt()`
    or `use()`); only a monster woken by another one, that can't see the player, takes the hive-mind point.
- Results on drop-free paths that fit the hull, knights (before Phase 1 → Phase 1 → Phase 2): e1m1 95.3 → 100 →
  100%, e1m2 97.1 → 100 → 100%, e1m3 93.5 → 97.6 → 98.4%, e1m4 98.0 → 100 → 100%, e1m5 95.6 → 100 → 100%,
  e1m6 100 → 100 → 100%, e1m7 98.8 → 99.4 → 98.8%. Over all random paths drops still cap e1m1 at 37% and e1m3 at
  68%, which is why Phase 4 (walkable links, no drops) should come before Phase 3.
- Tests: `source/game/id1/test/helper/chase-navigator.test.ts` (new: charging close and far, a floor up, waypoints
  reached and not, stale answers, the request throttle, stuck replans and skipping, headway against a fleeing enemy,
  pauses, flyers, the saved fields and a save/load round trip), `ai.test.ts` (infighting leaves the hive-mind point
  alone; a monster woken by another heads where the player was last seen). `createInertEdict` answers `isFree()`.
- Docs: id1 `README.md` (feature bullet, helper table, file tree), JSDoc on `ChaseNavigator`, `GameAI`.
- Smoke-tested by the developer in a running game on 2026-11-11, together with Phases 4 and 5: looks good.

### What actually shipped in Phase 4

- Measured first, on e1m1 (4,460 nodes, 179,507 links): the 64-wide box starts in solid at 47.8% of node origins, so
  nodes needed large-hull origins (design D's open measurement). Walking every link with `movestep` for one hull costs
  about as much as the whole build (71–114 s against 80 s).
- `GroundSupport.check` (`source/engine/server/physics/GroundSupport.ts`, new) is QuakeC's `checkBottom` against a
  `GroundProbe`; `ServerMovement.checkBottom` probes the live world through it, the builder the static world
  (`Navigation.#hasGroundSupport` was a copy). The builder's existing 8-unit walk (`#evaluateTraversalBetween`) is
  `movestep`'s step already, so the small hull didn't need a second walk: the walk now also checks `GroundSupport`
  at every step and notes drops taller than a step.
- Every node gets a `largeOrigin`: its origin, or the nearest spot up to 16 units away on the plane where the 64-wide
  box stands with ground under it; 3,863 of 4,460 on e1m1.
- Links carry flags: `DROP`, `WALKABLE_SMALL`, `WALKABLE_LARGE`. `NAV_FILE_VERSION` 4 adds the flags byte per link and
  the large-hull origin per node. The 11 meshes in git were regenerated (`nav_build_process 1`); the 28 other local
  meshes rebuild on first load.
- `findPath`/`findPathAsync` take a `NavigationHull` (`PLAYER`, `SMALL`, `LARGE`); `nav.path.request` got it as a fourth
  argument. `NavigateAsync(start, end, box?)` and `Navigate` take an optional `{ mins, maxs }` (`Navigation.hullFor`
  picks the smallest enclosing hull); without one it is the player's path, so `hellwave`'s hints didn't change.
  `ChaseNavigator` passes its monster's box. Start and goal nodes for a monster hull are the nearest ones with a link
  of that hull.
- Deviations from the design:
  - **Build time**: walking everything as designed took 275 s on e1m1 (3.4×). Three cuts brought it to 117 s
    (1.47× of 80 s, under the 2× limit): the ground along a link is checked once per node pair (the walk back reuses
    it when the first walk had no drop), the large hull is walked once per pair (without a drop, the way back is
    the same steps), and only on links up to 96 units (longer links cost extra and run beside shorter ones; that
    halved the large walks). On the dedicated server the 11 maps built in 49–193 s.
  - **Teleporters**: monster paths skip player-only teleporters (spawnflag 1) and teleporters with a `targetname`
    (they work only once fired). The developer found monsters walking into e1m2's player-only teleporters around
    (−390, 258, 320); the graph had linked every `trigger_teleport` for everyone since before this plan.
- Results (`HULL_PATHS=1 POLICIES=phase2`, 300 random node pairs; each monster asks for its own hull):

| map | small: no path | small arrive (ChaseNavigator) | large: no path | large arrive (ChaseNavigator) |
|---|---|---|---|---|
| e1m1 | 183 of 300 | 98.3% (was 38.3% over all player paths) | 213 of 300 | 88.7% (was 27.8%) |
| e1m3 | 56 of 300 | 89.3% (was 66–68%) | 159 of 300 | 95.3% |

  "No path" is honest: on e1m1 the node groups that split for monsters are joined only by drop links, all one way
  (the ledges around (320–640, 1920–3008) and the drops to z −384), and Quake monsters never step off a ledge. Those
  pairs used to get a path and strand the monster at the edge. Even players' paths don't connect whole maps (e1m1's
  largest strongly connected part is 62% of the nodes), since lifts and doors aren't in the graph.
- Tests (`test/physics/navigation.test.ts`): a world of solid boxes traced exactly; a 48-wide corridor the small hull
  takes and the large hull goes around, large-hull waypoints where the box stands, a 24-wide gap players cross and
  monsters don't, a drop monsters don't take, teleporters (normal, player-only, fired), `hullFor`. The `.nav` reader
  in the tests reads v4 and checks it ends at the end of the file. `chase-navigator.test.ts`: the request carries the
  monster's box.
- Docs: `docs/navigation.md` (new: graph, flags, hulls, paths, worker, `.nav` files and regeneration, cvars), the
  `nav.path.request` row in `docs/events.md`, `docs/README.md`, id1 `README.md`.
- The developer's e1m2 report (monsters walking into player-only teleporters) led to the teleporter fix; smoke-tested
  in a running game on 2026-11-11, with Phase 5. `data/id1/Makefile` still calls
  `../../dedicated.mjs`, which no longer exists (the bundle is `dist/dedicated/dedicated.mjs`); it is gitignored.

### What actually shipped in Phase 5

- Measured first, on e1m1–e1m7: 6–52 movers per map (doors, plats, trains) cut 6.8–24.5% of all links where the map
  draws them (8,722–25,638 links), found in 0.2–1.3 s per map. Hundreds to a few thousand links per door, as every link
  up to 128 units long through a doorway counts. The largest, 5,346 on e1m1, is a bridge (`*8`, a 16-unit slab at floor
  level): the drop links through it. That showed "blocked" has to mean "where the map draws it", not "closed": a bridge
  or a `START_OPEN` door blocks there too, just the other way round.
- Engine: `ServerCollision.traceModelAtRest(modelIndex, …)` traces one brush model at origin zero (brush data, or the
  clip hull `EntityHulls.forBrushModel` picks, now shared with `forEntity`). The builder records per mover (`MOVETYPE_PUSH`,
  `SOLID_BSP`, a `*N` model) the links whose walker box, lifted by a step, or large box between large-hull origins runs
  into it; `NAV_FILE_VERSION` 5 stores them (model name, node id and link index per link) and drops the relink list.
  `ServerEngineAPI.SetNavigationBlocked(edict, monsters, players)` reaches `Navigation.setMoverBlocked`, which the
  server thread keeps and passes on as `nav.mover.blocked` (new event, `docs/events.md`), and sends again after every
  `nav.load`. The worker sets `BLOCKED_MONSTERS`/`BLOCKED_PLAYERS` on the links from every mover that cuts them (double
  doors), and A* leaves them out for monster hulls or the player. Blocked bits are never saved.
- Removed: `Navigation.relinkEdict` (its body was `// TODO: adjust the nav graph accordingly`; game reports replace it),
  the relink skip list and timers, and the call from `ServerArea.linkEdict` that ran on every mover relink.
- id1: `BaseDoorEntity._reportNavigation()` reports on every state change, after the doors are linked (only then is the
  trigger field known), and after `deserialize`. A door blocks while it is at its drawn position or moving
  (`_isOutOfTheWay`: `STATE_TOP`, or `STATE_BOTTOM` for `START_OPEN`; a secret door at rest at `_dest2`). Monsters pass
  doors with a trigger field; players those and shootable ones; key, `targetname` and secret doors block both. A door
  that starts blocking monsters sets `GameAI._navigationChangeTime`, and `ChaseNavigator` asks again when its path is
  older (`_pathTime`, saved, the time the path was asked for). Hellwave reuses id1's doors.
- Correction to the first draft of design E: monsters do open doors in id1 (the trigger field takes any living actor,
  as in QuakeC); only doors without one stop them.
- Not done: plats and trains are recorded but no game reports them, so they block nobody (the mover plan's riding and
  waiting). A door with an `origin` key is drawn somewhere else than its model at origin zero; id1 doors have none.
- Tests: `navigation.test.ts` (the corridor world with a door: unreported blocks nobody, monster-only block reroutes
  monsters but not players, opening restores the path, a double door stays shut until both leaves open, the worker's
  loaded graph blocks the same links, a rebuild resends the states after `nav.load`), `doors.test.ts` (plain, fired,
  shootable, `START_OPEN`, restored and secret doors report the right blocks; a closing door bumps the change time),
  `chase-navigator.test.ts` (a door change replans). Each was checked to fail with its fix reverted.
- Docs: `docs/navigation.md` (movers, `SetNavigationBlocked`, v5), `docs/events.md`, id1 `README.md`.
- Smoke-tested by the developer in a running game on 2026-11-11: looks good.

### Next

- Phase 3 (reachable start and goal nodes, design C), engine-only.
- The 28 meshes not in git (e2–e4, dm3, the Hellwave maps) are older formats and rebuild on first load.
- Plats and trains are recorded in the meshes but nothing reports them: the next slice of
  `plans/nav-dynamic-mover-awareness.md`.

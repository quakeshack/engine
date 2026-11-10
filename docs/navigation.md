# Navigation

How the engine finds walking paths for game code: the graph built from a map, what each link offers to whom, the
worker that searches it, and the `.nav` files it is cached in. The game-facing call is
`ServerEngineAPI.NavigateAsync`; everything else is engine-internal (`source/engine/server/Navigation.ts`,
`NavigationWorker.ts`).

## The graph

`Navigation.build()` reads the static world BSP only: no entities except teleporters and doors (below).

1. **Waypoints.** Every upward face no steeper than a player can walk is sampled with the *walker*, a box of
   32×32×64 (Quake's hull 1: `mins` −16 −16 −24, `maxs` 16 16 40). A sample is kept where the walker stands without
   touching solid and has ground under its whole box (`GroundSupport`, below). Samples are stand origins, 24 units above
   the floor.
2. **Nodes.** Waypoints closer than 24 units on the plane and within a step (18 units) in height merge into a node.
3. **Large-hull origins.** For every node the builder looks for where a 64-wide monster (Quake's hull 2: −32 −32 −24 to
   32 32 64) stands: the node's origin, or the nearest spot up to 16 units away on the plane. A node beside a wall is
   16 units from it, which the walker needs and the large box doesn't. Nodes without one (narrow places) take no
   large-hull path.
4. **Links.** Every pair of nodes up to 128 units apart is walked both ways in 8-unit steps, the way a monster's
   `movestep` moves: each step finds the floor below a step up, climbing more than a step fails, and the walker must
   fit at every step. Dropping off a ledge (up to 256 units) is allowed, because a player can fall. Each link gets
   flags:

| Flag | Meaning |
|---|---|
| `DROP` | Somewhere along it the floor drops by more than a step. Players take it, monsters don't step off ledges. |
| `BLOCKED_MONSTERS`, `BLOCKED_PLAYERS` | A mover the game reported stands across it (set in the worker at runtime, never saved). |
| `WALKABLE_SMALL` | A monster of the walker's size walks it: no drop, and ground under its whole box at every step. |
| `WALKABLE_LARGE` | A 64-wide monster also walks it, between the two nodes' large-hull origins. Only links up to 96 units are checked for it, which halves the build time; longer links cost extra anyway, and shorter ones run beside them. |

A link with neither walking flag and no `DROP` is one only the walker's centerline passes: a gap in the floor the box
spans, for example. Players still get it.

**Monsters and the graph share their rules.** `GroundSupport.check` (`server/physics/GroundSupport.ts`) is QuakeC's
`checkBottom`: ground under the middle of the box and under all four bottom corners, none more than a step below the
middle. `ServerMovement.checkBottom` calls it on the live world, the builder on the static world. Change the rule there
and both follow.

**Teleporters** add a node at the trigger, one-way links to it from the nodes around it and from it to the node at the
destination, free of cost. Players take every teleporter. Monster paths take one only when it teleports monsters: not
when it is player-only (Quake's `trigger_teleport` spawnflag 1), and not when it has a `targetname`, since then it only
works once it was fired. The large hull takes it when the node at the other end has a large-hull origin.

**Movers** (doors, plats, trains: brush entities with `MOVETYPE_PUSH` and `SOLID_BSP`) aren't in the static world, so
every doorway is linked as if its door were open. The builder records, per mover, the links its model cuts where the
map draws it (traced with `ServerCollision.traceModelAtRest`: the walker's box lifted by a step, so a door-floor the
walker steps onto doesn't count, and the large box between large-hull origins). Mappers draw a door closed, so
these are the links the door closes. A bridge drawn in place cuts the drops through it the same way.

**Build time** grows with the number of links (about 40 per node). e1m1 has 4,460 nodes and 179,507 links and builds in
about two minutes in Node.js (`scripts/` and `plans/monster-chase-navigation.md` have the measurements).

## Paths

`findPath(start, goal, hull)` runs A* between the node nearest to the start and the node nearest to the goal (within 512
units) and returns the start, the node origins and the goal. The `NavigationHull` decides what the path may use:

| Hull | Links | Path points |
|---|---|---|
| `PLAYER` | every link, drops included | node origins |
| `SMALL` | `WALKABLE_SMALL` only | node origins |
| `LARGE` | `WALKABLE_LARGE` only | large-hull origins |

The start and goal nodes for a monster hull are the nearest ones with a link of that hull. Nothing checks yet that the
start or goal can reach its node in a straight line (a node behind a thin wall can win).

### From game code

```ts
// a player's path, drops included (a hint for the player, say)
const path = await engine.NavigateAsync(start, goal);
// a walking monster's: the engine picks the smallest hull whose box encloses mins and maxs
const monsterPath = await engine.NavigateAsync(monster.origin, goal, { mins: monster.mins, maxs: monster.maxs });
```

A box that fits the walker gets `SMALL`, anything wider or taller `LARGE`. `NavigateAsync` resolves to `null` when there
is no path or `nav_enabled` is 0. `Navigate` is the deprecated synchronous variant; it only answers on the thread that
holds the graph.

## Doors and other movers

Whether a mover blocks anyone is the game's call: only it knows that a monster opens a plain door by walking into its
trigger field but not a door fired by a button. It reports every change:

```ts
// while the door stands where the map draws it, or moves: monsters can't pass it, players can (they shoot it open)
engine.SetNavigationBlocked(door.edict, true, false);
```

Monster paths then leave out the mover's links, player paths too when `players` is true. A mover never reported blocks
nobody, so a game that doesn't report gets every doorway as open. Two movers on the same links (double doors) block
until both say they don't. Report again after a saved game restored the mover: the map spawns first, and navigation
knows the mover as it spawned.

The server thread keeps the reports and passes each one to the worker as `nav.mover.blocked`. Reports from spawning,
before the worker exists, and all of them again after every `nav.load` (a rebuilt mesh), so the worker never searches
with stale doors.

In id1, as an example: a door blocks while it is at its drawn position or moving (a `START_OPEN` door is out of the
way at spawn and blocks once fired); a door with a trigger field blocks nobody, a shootable door blocks monsters only,
a door with a key or a `targetname` and a secret door block both. A door that starts blocking monsters makes chasing
monsters ask for a new path.

## Worker

The server thread doesn't keep the graph. On map load it publishes `nav.load`; `NavigationWorker` loads the `.nav` file
(node ids, origins, large-hull origins, links and their flags, the links each mover cuts; no world, no collision) and answers every
`nav.path.request` with a `nav.path.response` (`docs/events.md`). Answers arrive a frame or more later and are not
restored by a saved game.

## `.nav` files

The graph is cached as `maps/<map>.nav` through `COM.WriteGeneratedFile`: in the browser in the generated-files cache
(`docs/asset-layer.md`), on a dedicated server under `data/<game>/maps/`. A mesh is rebuilt when it was written for
another map build (checksum), another walker size, or another file format version (`NAV_FILE_VERSION`: 4 added link
flags and large-hull origins, 5 the links each mover cuts). The worker reports such a mesh with `nav.build`, and the server thread rebuilds it, once
per map, which stalls the server for the length of a build.

Change the version whenever the layout of the file or what the builder decides changes, and regenerate the shipped
meshes so players don't wait for a rebuild:

```bash
npm run dedicated:build
node dist/dedicated/dedicated.mjs -noserver -basedir id1 -game id1 +nav_build_process 1 +map e1m1
```

One map per run: `nav_build_process 1` builds the mesh, saves it and quits.

## Console variables

| Variable | Default | |
|---|---|---|
| `nav_enabled` | 1 | 0 answers every path request with `null`. |
| `nav_debug_path` | 0 | Cheat. Draws every path the worker returns, for 10 seconds. |
| `nav_debug_graph` | 0 | Draws a dot at every node, in another color near a ledge. |
| `nav_debug_waypoints` | 0 | Draws the waypoints, only right after a build (files don't keep them). |
| `nav_build_process` | 0 | Dedicated server only: build the mesh of the map, save it and quit. |

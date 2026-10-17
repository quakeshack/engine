# BSP flat layout: one collision core, typed arrays, no copies, then shared memory

**Status:** Decisions made 2026-10-16 (see "Decisions"). Phases 0 to 2 are done (2026-10-17); Phase 3 waits for a look at the numbers and a go-ahead. Follows from the "Parked: SharedArrayBuffer" note in `plans/engine-architecture-modernization.md` (its
"revisit when" condition is a typed-array BSP layout) and from `plans/server-model-memory.md`.

## Decisions

Made with the developer on 2026-10-16:

1. **Sky is solid for player movement and not solid for entity traces, on purpose.** A player must not fall or step through sky.
   A projectile must enter the sky leaf so that the game can see `CONTENT_SKY` there and remove it silently (a solid hit would
   spawn sparks or an explosion). The unified traversal therefore takes this as a parameter (a flag on the trace), it does not
   pick one behavior. Both behaviors are pinned by tests in Phase 0.
2. **Stop after Phase 1 and look at the numbers** before Phase 2.
3. **Cold callers get a temporary read-only view** in Phase 2 instead of a one-go rewrite; the view is deleted once unused.
4. **Who parses in Phase 4, and the SAB policy, are postponed to Phase 4.** The work is the cleanup of the structures first;
   shared memory is a maybe afterwards.

## Context

The BSP is an object graph, and the collision code around it carries its own copies of the same data. What exists today:

- [`BrushModel`](../source/engine/common/model/BSP.ts) holds `planes: Plane[]`, `nodes: Node[]`, `leafs: Node[]`,
  `clipnodes: Clipnode[]`, `hulls: Hull[]`, `faces: Face[]`, `vertexes: Vector[]`, `edges: number[][]`, `marksurfaces: number[]`.
  A `Node` (used for nodes and leafs alike) has about 20 fields and four `Vector`s (`mins`, `maxs`, `baseMins`, `baseMaxs`),
  a `children: [Node, Node]` array, `ambient_level`, `cmds: number[][]` and `turbulentChains`. Measured earlier: an id1 BSP
  costs about 13x its file size on the heap with `loadRenderData: false`.
- **Hull 0 is a second copy of the node tree** ([BSP29Loader.ts:1517](../source/engine/common/model/loaders/BSP29Loader.ts#L1517)),
  rebuilt as `{ planenum, children }` objects.
- **Pmove has its own mirror of the model types.** `Pmove.ts` declares `Plane` (`signBits`), `ClipNode` (`planeNum`), `Hull`
  (`clipMins`, `firstClipNode`) and `BoxHull` next to the model's `Plane` (`signbits`), `Clipnode` (`planenum`) and `Hull`
  (`clip_mins`, `firstclipnode`). `Hull.fromModelHull` copies the whole clipnode and plane arrays and `.slice()`s the allowed
  mask, once per realm and per brush entity model (cached by model name in `#modelHullsCache`). It was a stopgap, written when
  Pmove's shapes were meant to become the shape of the model. That never happened.
- **There are at least three hull traversals.** `Pmove.Hull.pointContents` and `Hull.check`, `ServerLegacyHullCollision`
  (`hullPointContents`, `recursiveHullCheck`, which allocates a `Vector` per recursion level), and the point-in-leaf walk in
  `BSP.ts`. They are not identical: Pmove's `check` treats `CONTENT_SKY` like solid, the server's `classifyHullLeaf` only treats
  `CONTENT_SOLID` that way. Track E made server and client player movement bit-identical by testing, not by sharing code.
- **Mutable state lives inside the geometry.** `Node.visframe`, `markvisframe`, `skychain`, `waterchain`, `cmds`,
  `turbulentChains` belong to the renderer; `Brush._brushTraceCheck` is a counter that `BrushTrace` writes during a trace. The
  `baseMins`/`baseMaxs` copies exist only so the renderer can expand leaf bounds and restore them
  (`Node.resetRenderState`). None of this can be shared between threads as it stands.
- **Format limits are baked into the loader.** `BSP29Loader` reads clipnode and node children as `int16` and face counts as
  `uint16`. BSP2 and BSP38 have their own loaders that fill the same objects.

Who depends on the shape (checked 2026-10-16): the collision and visibility members (`planes`, `nodes`, `leafs`, `clipnodes`,
`hulls`, `visdata`, `phsdata`, `brushes`, `brushsides`, `leafbrushes`) are read by 4 to 13 engine files each, almost all under
`common/`, `server/` and the renderer. **No file under `source/game/` imports `Pmove`, the model classes or `Hull`**; games
reach collision through the engine APIs. The shape can therefore change without a game-side contract change. 30 test files
mention hulls, clipnodes or `BrushModel`; their fixtures (`test/physics/fixtures.mjs`) build models by hand.

## Goals

- One representation of collision geometry, immutable after load, in typed arrays with 32-bit indices, used by the model, Pmove,
  the server and the client. No copy between them.
- One implementation of hull `pointContents` and the line trace, with a scratch pool instead of per-call allocation.
- Remove redundant data: the hull-0 object tree, Pmove's mirrored types, `baseMins`/`baseMaxs`, per-plane `Vector`s, `parent`
  pointers where an index array does.
- Mutable per-realm state (render marks, trace dedup counters) lives outside the geometry, so the geometry can be shared.
- The same layout holds BSP29, BSP2 and BSP38, so bigger maps need no new code path in the hot loops.
- Then, and only then: share the buffers between the page and the server worker where the browser is cross-origin isolated, with
  a clone as the fallback.

## Non-goals

- A new BSP file format or new lumps. BSP2 (32-bit) and BSP38 already carry the larger limits; this plan makes the engine's
  representation unable to be the bottleneck, it does not add a format.
- Limits that are not geometry: protocol field widths (model and entity indices), `MAX_EDICTS`, lightmap atlas size, texture
  counts. Decision 3 of the umbrella plan keeps the protocol out of scope. Phase 0 inventories them so "higher everything" has a
  list, nothing more.
- Game code changes (none are needed, see above).
- Alias/mesh model storage (`plans/server-model-memory.md` owns it) and renderer-only data (display lists, lightmaps).
- Changing collision results. Every phase is bit-identical against the Track E determinism tests and the existing trace tests,
  except where Phase 0 finds a divergence the developer decides to resolve (Decision 1).

## Design

### A. The collision core (Phase 1)

New files under `source/engine/common/collision/`:

- `PlaneTable`: `normals: Float32Array` (3 per plane), `dists: Float32Array`, `types: Uint8Array`, `signbits: Uint8Array`.
  Float32 on purpose: the file stores float32 and today's `Vector` is a `Float32Array`, so distances come out bit-identical.
  `distance(index, x, y, z)` replaces `plane.type < 3 ? point[type] - dist : normal.dot(point) - dist`.
- `ClipTree`: `planeNums: Int32Array`, `children: Int32Array` (two per node, negative values are contents, as now).
- `Hull`: `{ planes: PlaneTable, tree: ClipTree, first, last, allowed: Uint8Array | null, clipMins, clipMaxs }`, one name and one
  camelCase spelling. `allowed` is held by reference (immutable), never sliced.
- **One traversal**: `pointContents(hull, point, num)` and `recursiveCheck(hull, ..., trace)`, with the depth-indexed scratch
  vectors Pmove already has (`Hull._midPool`) and a trace sink interface that both `Pmove.Trace` and `CollisionTrace`
  satisfy. Hot-path rules from `typescript-port.instructions.md` apply: locals narrowed at the use site, no helper whose only
  purpose is narrowing, no reflection.
- **Hull 0** is not a second object tree. It is a `ClipTree` built once from the node arrays with leaf indices replaced by their
  contents (two `Int32Array`s), which is cheap and is the only copy left.
- **`BoxHull`** keeps its constant six-node `ClipTree` (shared by all box hulls) and owns only a six-entry `PlaneTable` whose
  `dists` change in `setSize`. That table is the one mutable thing and is never shared.
- Pmove stops copying: `PhysEnt.hulls` references the model's hulls; `Hull.fromModelHull`, Pmove's `Plane`/`ClipNode`/`Hull`
  types and `#modelHullsCache` are deleted. `EntityHulls`, `ServerCollision` and `ClientCollision` use the same `Hull`.
- `BrushTrace` keeps its brush-based algorithm. Its plane access moves to `PlaneTable` indices and its `_brushTraceCheck`
  counter moves out of `Brush` (see B).

### B. Tree, leafs and visibility (Phase 2)

- `NodeTable`: `planeNum`, `children` (leaves encoded `-1 - leaf`, the file convention), `bounds: Float32Array` (6 per node),
  `firstFace`, `numFaces`, `parent: Int32Array`.
- `LeafTable`: `contents`, `cluster`, `visofs`, `area`, `firstMarkSurface`, `numMarkSurfaces`, `firstLeafBrush`,
  `numLeafBrushes`, `bounds`, `ambient: Uint8Array` (4 per leaf).
- **Renderer state leaves the geometry.** `visframe`, `markvisframe`, `skychain`, `waterchain` become `Int32Array`s owned by the
  renderer, `cmds` and `turbulentChains` become renderer-owned side structures, the expanded leaf bounds become a renderer-owned
  `Float32Array` (so `baseMins`/`baseMaxs` and `resetRenderState` disappear). `BrushTrace`'s dedup counter becomes a
  per-trace-context `Uint32Array` sized to the brush count.
- `Visibility`, point-in-leaf, PVS/PHS lookups and `BrushTrace` read indices directly. Cold callers (the loaders, debug tools,
  navigation, diagnostics) get a thin read-only view class (`nodes.at(i)`), allocated on demand, so they migrate without a
  rewrite. Hot paths do not use it.
- Loaders (BSP29, BSP2, BSP38) fill the tables directly from the lump bytes, without the intermediate objects. Bounds checks
  stay: a corrupted child index still throws `CorruptedResourceError`.

### C. Faces, vertexes, texinfo (Phase 3)

`faces`, `vertexes`, `edges`, `surfedges`, `texinfo`, `marksurfaces` become tables the same way. 12 engine files read `faces`
(renderer, lightmaps, decals, navigation, loaders), so this is its own phase. The server only needs them for the navigation
build, so Phase 2 already gives the server almost everything it needs. `loadRenderData: false` then skips the face tables
entirely instead of building objects it never reads.

### D. Sharing between realms (Phase 4)

The geometry is immutable and in plain buffers, so a loaded map is a small set of `ArrayBuffer`s plus scalars.

- Parse once, hand the buffers to the other realm: `SharedArrayBuffer` when `crossOriginIsolated`, a structured clone otherwise.
  Both give the receiver the same typed-array classes, so there is one code path after the hand-off.
- **Open for the plan to settle:** who parses. The server worker is the natural owner (it has no GL); the page then only needs
  the collision core and visibility for prediction and PVS, while its renderer tables come from its own parse of the render-only
  lumps. That split needs the Phase 2/3 boundary to be clean.
- Gate on feature detection and a test that runs both paths. Cross-origin subresources under `require-corp`, iframe embedding
  and the Vite dev server (no headers) are the real cost; see the umbrella plan's parked note.

## Phasing

Each phase ends with `npm test`, `npm run typecheck` and `npx eslint --fix` green, the game playable, and a stop for a go-ahead.

### Phase 0: measure and pin (no behavior change)

- Heap breakdown of a large map by structure (`Vector`, `Node`, `Plane`, `Clipnode`, arrays), using the model-memory tooling,
  so the savings are claimed from numbers. Include the Hellwave server worker snapshot that `server-model-memory.md` still owes.
- Inventory of non-geometry limits (list only, see Non-goals).
- Characterization tests for the divergences between the traversals: sky as solid versus not, the early-out
  `trace.fraction <= p1f`, the "backup past 0" loop, and the allowed-mask behavior. Decide each one with the developer
  (Decision 1) before unifying.
- Confirm the safety net: `test/physics/pmove-determinism.test.ts`, `brushtrace.test.mjs`, `collision-regressions.test.mjs`,
  `entity-hulls.test.ts`, the BSP loader tests. Add a loader test that compares the new tables with the old objects for the
  fixture maps, so Phase 1 and 2 can be checked against the pre-change structures.

#### Phase 0: what shipped (2026-10-16)

`npm test` 2568 pass, `npm run typecheck` 0 errors, eslint clean on the new files. New: `scripts/measure-bsp-memory.mts` (heap by
structure, dev tool, `scripts/*.mts` is now in the lint project list) and `test/physics/hull-traversal.test.ts` (13 tests).

**Heap by structure**, server-style load (`loadRenderData: false`), forced GC between steps, groups dropped in the printed
order. Run: `node --expose-gc --import tsx scripts/measure-bsp-memory.mts <map.bsp> ...`.

| | hw_village | hw_e1m2 | lqdm3 |
| :-- | --: | --: | --: |
| file | 23.9 MB | 8.9 MB | 2.5 MB |
| heap after load | 1049 MB | 186 MB | 40 MB |
| **lightgrid (BSPX octree objects)** | **1020 MB** | **156 MB** | 0.4 MB |
| nodes + leafs | 7.8 | 9.2 | 11.7 |
| faces | 7.6 | 8.0 | 9.4 |
| planes | 3.5 | 2.7 | 5.7 |
| clipnodes | 1.3 | 1.0 | 1.0 |
| hulls (hull 0 tree and wrappers) | 0.9 | 1.1 | 1.4 |
| vertexes, edges + surfedges, texinfo | 3.1 | 3.7 | 6.0 |
| brushes + sides + leafbrushes | 0.6 | 1.4 | 2.7 |
| visdata + phsdata + offsets | 0.9 | 0.3 | 1.3 |
| **Pmove's private hull copies** | **10.0** | **4.3** | **5.9** |

The rows from the lightgrid down are MB of heap that group keeps alive. What this says:

- **The lightgrid is the biggest single cost by far, and the server never reads it.** `BSPXLoader.#loadLightgridOctree` builds
  `{ stylecount, styles: [{ stylenum, rgb: [r, g, b] }] }` per grid point and ignores `loadRenderData`; only
  `client/renderer/lighting/LightSampler.ts` reads it. On `hw_village` that is 1020 of 1049 MB, in the server worker and again in
  the page. It very likely explains the unexplained 750 MB Hellwave server worker in `plans/server-model-memory.md` (verify with
  the worker heap snapshot that plan still owes). Two fixes, independent of the rest of this plan: do not load it when
  `loadRenderData` is false (server: about 1 GB gone on this map), and give it a flat layout for the client (a `Uint8Array` over
  the lump with an offset table instead of an object per point), which is a Phase 3 item. The first is a small, safe change and is
  proposed to be done before Phase 1.
- Without the lightgrid the structures cost about 29 MB for 24 MB of file on `hw_village`, so the object-graph cost is real but
  small next to it. Per element: a node or leaf about 1.3 KB (disk: 24 to 28 bytes), a plane about 250 B (disk 20, flat 17), a clipnode
  about 110 B (disk 8, flat 8), a face about 1.3 KB.
- **Pmove's copy is not small and not per model:** 4 to 10 MB per realm, because `Hull.fromModelHull` runs once per hull
  (three of them) and copies the plane array each time. Phase 1 removes it entirely.

**Done right after Phase 0 (2026-10-16):** the three render-only BSPX lumps (lightgrid, deluxemap, face normals) are no longer
loaded when `loadRenderData` is false (`BSPXLoader.load` takes the flag). `hw_village` on a server: 1049 MB -> 25 MB heap,
`hw_e1m2` 186 MB -> 30 MB. The lump directory is kept. Tests: `bspx-loader.test.ts`, `bsp38-loader.test.ts`.

**The lightgrid on the client: done (2026-10-16).** The lump is 15.5 MB for 3.27 M grid points on `hw_village` (4.7 bytes per
point) but was parsed into about 320 bytes of objects per point. `common/model/Lightgrid.ts` keeps the point data as the lump
stores it (a copy, so the BSP file is not retained), decodes the octree nodes and leaf headers into typed arrays, and builds one
offset per row of points (a point is `1 + 4 x stylecount` bytes wide, so it is not directly addressable); a lookup scans at most
one row. `LightSampler` reads points through `Lightgrid.findPoint` without allocating. Measured: `hw_village` 1020 MB -> 15.6 MB
heap, parse 24 ms (it was seconds of allocation); `hw_e1m2` 156 MB -> 2.8 MB, parse 6 ms; about 14 to 20 million lookups per
second in a full sweep. Over every grid point of both maps the number of points with data matches the old parser (3,100,539 and
359,115). `findPoint` also stops after 64 octree levels now, where a corrupt, cyclic octree used to hang the sampler. Tests:
`test/common/lightgrid.test.ts` (parse errors, octree walk, random grids against the encoded data), the sampler and BSPX loader
tests. The dense alternative (first style stored per point) was not needed. Checked live by the developer on `hw_village` in the browser: it plays smoothly and the page's memory profile reads 484 MB.

**The traversals** (`hull-traversal.test.ts`). `Pmove.Hull` and `ServerLegacyHullCollision` agree on contents and on every field
of the trace for 20 random trees x 200 points and 20 x 150 segments (more than 300 of them hit something), so unifying them does
not change results outside the differences below. Differences, all pinned:

- **Sky** (Decision 1): Pmove stops at sky like at a wall and reports `startsolid` inside it; the server goes into the sky leaf and
  reports `inwater` (not an impact). The unified traversal takes a flag for this.
- The server returns early when `trace.fraction <= p1f`; Pmove has no such check.
- The server's world `pointContents` folds the six `CONTENT_CURRENT_*` values into `CONTENT_WATER`; Pmove reports them as they are.
- Both treat a masked-out clipnode as empty. Pmove copies the mask, the server reads the model's own.
- Cosmetic: the server allocates a `Vector` per recursion level and replaces `plane.normal`/`endpos` objects; Pmove uses a pool and
  `set`.

**Limits that are not geometry** (inventory only, see Non-goals): the entity `modelindex` is written as a byte
(`ServerMessages.ts`), so 256 models per server; `Pmove.MAX_PHYSENTS = 32`; lightmap atlas `LIGHTMAP_BLOCK_SIZE = 2048` (one
atlas, 2048 x 2048); `MAX_CLIP_PLANES = 5`; BSP38 world coordinates are limited to +-65536 (`#MAX_WORLD_COORD`); the BSP38 loader reads
leaf brushes, brush sides, marksurfaces and edges as `uint16`, which caps a Quake II map at 65535 of each. The BSP29 loader's
`int16` children and `uint16` face and marksurface counts are the format's own limit; BSP2 lifts them and loads into the same
objects.

Not done from the Phase 0 list: the loader comparison test for the new tables (there are no new tables yet, it is written with
Phase 1), and the Hellwave server worker heap snapshot (needs a real browser or a worker run; the BSP numbers above point at the
lightgrid first).

### Phase 1: the collision core

`PlaneTable`, `ClipTree`, `Hull`, the single traversal; the loaders fill them next to the old fields; Pmove, `ServerCollision`,
`EntityHulls`, `ClientCollision` switch over; the old hull types, `fromModelHull` and the cache go. Done when there is exactly
one traversal implementation, Pmove copies nothing, and the determinism and trace tests pass unchanged.

#### Phase 1: what shipped (2026-10-17)

`npm test` 2596 pass, `npm run typecheck` 0 errors, eslint clean on the touched files. Done-when holds: one traversal
implementation, Pmove copies nothing, the determinism and trace tests pass unchanged.

- **`source/engine/common/collision/Hull.ts`**: `PlaneTable` (normals as `Float32Array`, distances as `Float64Array` so a box
  hull can hold non-float32 distances exactly, types and sign bits as `Uint8Array`), `ClipTree` (`Int32Array`s), `Hull` and `BoxHull`.
  `Hull.pointContents(point, num)` and `Hull.trace(trace, start, end, skyBlocks)` are the only implementations of the point and
  line queries; `skyBlocks` is Decision 1 (`true` for player movement, `false` for entity movement). Mid points come from a
  depth-indexed pool, the server's per-level allocation is gone.
- **Gone**: Pmove's `Plane`-based `ClipNode`, `Hull`, `BoxHull`, `Hull.fromModelHull` and `#modelHullsCache`; the model's `Clipnode`
  and `Hull` interfaces; the server's `recursiveHullCheck`, `hullPointContents` and `ServerCollision`'s wrappers of them; the box
  hull `EntityHulls` kept for itself (it uses `BoxHull.setBounds`, no vectors). `ServerLegacyHullCollision.ts` keeps only the world
  `pointContents` that counts the current volumes as water.
- **The model**: `BrushModel.hulls` are `Hull`s over the model's `planeTable` and `clipTree` (new fields; `planes: Plane[]` stays
  until Phase 2 because nodes, faces and the brush trace use it). Hulls 1 and 2 share both with the world; hull 0 is a tree of
  its own built from the nodes (two `Int32Array`s instead of an object per node); the hulls of an inline model share the same
  data and only start at a node of their own. `PhysEnt.hulls` is the model's array, not a copy. Fields are camelCase now
  (`clipMins`, `firstClipNode`).
- **Not changed on purpose**: `planeTable` holds the planes of the plane lump only; the planes a BRUSHLIST adds go to `planes[]`
  and the brush trace, hulls never refer to them.

**Verified against the old code, not only by new tests.** The same 14000 seeded cases (40 random trees with sky, solid, water,
current and open leafs and some masks; 8000 point queries and 6000 segments, each for player and entity movement; 2463 of the
segments hit something and 1846 are told apart by sky and currents) were run through the old Pmove and server traversals in a
worktree of the previous commit and through `Hull`: the output is byte-identical, and `hull-traversal.test.ts` keeps the sha256
of it (`d3dcf60e...`), so the equality is checked on every run.

**Numbers** (`scripts/measure-bsp-memory.mts`, server-style load, heap kept alive by each group):

| | before | after |
| :-- | --: | --: |
| Pmove's copy of the hulls, hw_village / hw_e1m2 / lqdm3 | 10.0 / 4.3 / 5.9 MB | 0.0 MB |
| hulls + clipnodes + plane table, hw_village | 2.2 MB (objects) | 0.4 MB |
| 200000 traces + 200000 point queries on hw_e1m2 hull 1 (median of 10) | 696 ms | 394 ms |

That settles open question 3: the typed layout is faster in the hot loop (1.75x here; most random start points are inside
solid, so the sample is short traversals, and the results are identical: 284 hits, same contents sum). A listen server saves the
Pmove copy in both realms.

Found while doing it:

- `Hull.trace` stops at `trace.fraction <= p1f` (the server had it, Pmove did not). It never triggers for a fresh trace, and
  `hull-traversal.test.ts` pins the case where a trace already hit something nearer.
- The "backup past 0" message is `console.debug` for both now (Pmove used `console.warn`, the server `console.debug`).
- **A bug in the brush trace that predates this plan** showed up while testing Phase 1 in `hw_village`: a player flush against a
  wall of two stacked brushes, the lower one a step high, was lifted onto the lower brush when walking along the wall. Cause: a
  box that exactly touches the side of a brush (`d1 = 0`) is treated by `_clipBoxToBrush` as keeping the other faces of the
  brush in play (the tangent rule from the clip_4 fix), so a straight down trace hit the top of the lower brush. Found with a
  scripted walk that is identical on the commit before Phase 1 (the Phase 1 changes are byte-identical in movement on 12 maps)
  and fixed separately: a purely vertical move no longer uses that rule. It also stops a wall contact from dropping the ground
  under the player. Tests: `brushtrace.test.mjs`.
- `WorkerServerController` "follows what the worker reports" failed once in a full run under load and passed alone and in the
  next full run; it is a timing test and not related.

### Phase 2: tree, leafs, visibility

`NodeTable`, `LeafTable`, renderer-owned state, per-trace dedup counters, index-based hot paths, the cold-caller view, loader
rewrite. Done when `BrushModel` has no `Node` objects for the world and no mutable render field, and a frame renders the same
(screenshot pair, `browser-ui-verification`).

#### Phase 2: what shipped (2026-10-17)

`npm test` 2602 pass, `npm run typecheck` 0 errors, eslint clean on the touched files (the pre-existing findings in a few
`.mjs` tests are unchanged). Done-when holds: `BrushModel` has no `Node` objects (the `Node` class is gone) and no mutable render
field.

- **`common/model/BspTree.ts`**: `NodeTable` (plane, two children, parent, bounds, first face and face count per node) and
  `LeafTable` (contents, cluster, visofs, area, parent, bounds, marksurfaces, leaf brushes, ambient levels per leaf), typed
  arrays, one entry per element. A child is a node index, or `~leaf` when negative (the BSP files' convention, which the
  BSP29/BSP2/BSP38 loaders now write straight from the lumps). They are filled once by the loader and not changed after it.
  The loaders check every plane and child index and throw `CorruptedResourceError` instead of leaving a lookup to read a
  neighbour. `linkParents` walks from the world root only, as the old code did: the inline models hang from nodes nothing
  refers to and share leaf 0 with the world.
- **`common/model/WorldRenderState.ts`**: what the renderer keeps per view of a map: `markframes` (nodes first, then the leafs),
  `visframes`, `skychains`, `waterchains`, the draw chains and turbulent chains per leaf, and the leaf bounds as the display
  list builder grew them (which is why `baseMins`/`baseMaxs` and `resetRenderState` are gone). A scoped view gets its own,
  made on first use (`WorldRenderState.of`), so the client's view no longer writes into the shared map.
- **Consumers on indices**: `BrushModel.getLeafIndexForPoint`, `getPvsByLeaf(leaf)`, `getPhsByLeaf(leaf)`, `leafsConnected`;
  `Visibility` (renderer), `BrushModelRenderer`, `Sky`, `ShadowMap`, `Fog`, `DynamicLights.MarkLights`,
  `LightSampler.RecursiveLightPoint`, `TransparentPass` (a leaf item is its index), `BrushTrace` (the world traversal and the
  position test), `ServerArea.findTouchedLeafs`, `ClientEntities` linking, `Sound`, `Edict`, the engine APIs. The cold-caller
  view the plan sketched was not needed: every caller was converted, `tsc` listed them.
- **Tests**: `test/support/bspTree.ts` builds a tree for a model from a short description (`setBspTree`, `createTreeModel`,
  `createSingleLeafWorld`, `createRenderedWorld`); the fixtures, the client, sound, visibility, fog, light, shadow and loader
  tests use it. New: `bsp-tree.test.ts`. Two tests under `source/game/id1/test/` use the helper too (that is the id1
  submodule, committed there).

**Verified against the old code**: for 8 maps (the id1 test maps and three Hellwave maps, `hw_village` among them) every leaf
(contents, cluster, area, visofs, marksurfaces, leaf brushes, ambient, bounds), every node (plane, children, parent,
faces, bounds) and the leaf, PVS, PHS and fat PVS/PHS rows at 3000 random points per map hash to the same value before and after.
Scripted player walks on 12 maps (the brush path and the hull path) are byte-identical to the commit before. The first run
found that linking parents for every node would have changed the parent of a shared leaf, which the test above now covers.

**Numbers** (`scripts/measure-bsp-memory.mts`, server-style load):

| | before | after |
| :-- | --: | --: |
| nodes + leafs, hw_village / hw_e1m2 / lqdm3 | 7.8 / 9.2 / 11.7 MB | 0.3 / 0.4 / 0.5 MB |
| heap after load, hw_village / hw_e1m2 / lqdm3 | 23.3 / 28.1 / 38.0 MB | 15.8 / 19.3 / 26.7 MB |
| 60000 `boxTrace` + `testPosition` on hw_village | 367 ms | 260 ms |

**Real browser** (Chromium with software GL, the capture scripts of `docs/browser-verification.md`, `hw_e1m2` in Hellwave, a production
build of the commit before and of the working tree, two captures of each): all nine views (spawn, lights with particles and a
decal, chase, bloom, fog, under the sky, above the water, in the water, spawn again) match the old build beyond the noise between
captures of one build, and `r_speeds` is identical in every view. Not verified: pointer lock and mouse look (no change here, and
headless Chromium cannot test them), Firefox, `hw_village` itself in a browser. The capture script of the repo could not enter the
map on its own for a Hellwave page (its console helper looks for the echo of the typed command in the last six lines, which
`map` pushes out); the run used a copy with a simpler helper, the script in the repo is unchanged.

Not done, and why: the `Brush._brushTraceCheck` dedup counter still lives on the brush objects. Brushes stay objects (they are
not in this plan's tables), and the counter only matters once a brush array is shared between threads, which is Phase 4; it moves
to a per-realm scratch array there.

### Phase 3: faces, vertexes, texinfo

As in C. Done when `loadRenderData: false` allocates no face objects.

### Phase 4: shared buffers

As in D. Done when a listen server holds one copy of the geometry (heap measurement in both threads) and the fallback path is
tested.

## Testing

- Per phase: the safety net above, plus tests for each new table class (construction, bounds, contents encoding), the single
  traversal against the old implementations on fixture maps (same contents and same `Trace` for seeded random lines), and
  loader round trips for BSP29, BSP2 and BSP38.
- Fixtures: `test/physics/fixtures.mjs` (`createAxisPlane`, `createBoxBrushModel`, `createBrushWorldModel`,
  `createRoomHullFromBounds`) are rewritten once to build the new tables; `.mjs` tests are not type-checked, so each caller is
  searched by hand. New tests are `.test.ts`.
- New fixtures or top-level files need the Dockerfile `COPY` check; a new `test/` subdirectory needs the glob check.
- A real browser run (headless Chromium here) for Phases 2 to 4: render of a map before and after, movement and prediction on
  it, a listen server. Pointer lock stays a live check by the developer.
- Measurements recorded in this plan after each phase: heap per structure, load time of a large map, and the frame time of a
  movement-heavy scene (the traversal is the hot loop).

## Open questions

Decided on 2026-10-16: sky handling, scope of the first deliverable and the cold-caller view (see "Decisions"). Still open:

1. **Who parses in Phase 4** (server worker or page), and whether the page keeps a second parse of the render-only lumps.
2. **SAB policy.** Recommended: feature-detect with a clone fallback. Requiring isolation would simplify the code and break the
   dev server and third-party hosts. Both wait for Phase 4.
3. ~~**Hot-path cost.**~~ Settled by Phase 1: 1.75x faster than the objects, see "Phase 1: what shipped".

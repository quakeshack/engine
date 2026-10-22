# Server model memory: stop holding what the server never reads

Hellwave precaches every monster for every map, and the server worker's JS heap sits at ~750 MB (main thread ~910 MB). This plan finds out what actually holds that memory and shrinks it, starting with the cheapest change that needs no game-side API.

## Context

### What the server does with a model today

- `ServerEngineAPI.PrecacheModel()` pushes a `ForNameAsync(name, true, ModelScope.server)` promise into `server.models`. Nothing is ever released until the next `SpawnServer` calls `mod.ClearAll(ModelScope.server)`.
- The server realm already loads with `loadRenderData: false` (`createServerWorker.ts`, `DedicatedHost.ts`, `WorkerFramework.ts`). No GL textures, no render commands, no skin layers. So the "render data" is not the problem.
- What the server reads from a model, by consumer:
  - `Edict.setModel()`: `mins`/`maxs` only (computed once in `AliasMDLLoader` from the frame bboxes).
  - `ServerArea`/`ServerCollision`: `modelindex` → model for brush models (`SOLID_BSP`) and, only for `SOLID_MESH` entities, the alias/mesh triangles and per-frame poses (`AliasCollisionState`, `MeshCollisionState`, `ServerCollisionSupport.ts`).
  - `SOLID_MESH` users in id1: `Misc.ts:870`, `monster/OldOne.ts:237`, `monster/Boss.ts:225`. Hellwave has none.
- Everything else in an `AliasModel` (`frames[].v`, `_triangles`, `_stverts`, `skins`) is dead weight on the server for every other entity.

### Measured (scratchpad script, `node --expose-gc`, forced GC before/after each load)

| What | File size | Heap after load | Factor |
|---|---|---|---|
| all 61 id1 `.mdl` (pak0), `loadRenderData: false` | 2.7 MB | 58.9 MB | ~22x |
| per pose vertex (4 bytes on disk) | 4 B | ~292 B | ~73x |
| id1 BSP (e2m1..e2m4), `loadRenderData: false` | ~1.3 MB | ~16-17 MB | ~13x |

Why alias models blow up: `AliasMDLLoader.#loadAllFrames` allocates, per vertex per frame, an `{ v: Vector, lightnormalindex }` object. `Vector` extends `Float32Array`, so every vertex is a typed-array object plus a wrapper plus an array slot. The worst id1 models (zombie, boss, player) cost 8-10 MB each; the on-disk file is ~190 kB.

The client pays the same price: `AliasModelRenderer` only reads `frame.cmdofs` (GPU buffer offsets), never `frame.v`, yet the main thread keeps every pose vertex object after uploading to the GPU.

### What is not yet explained

id1's *entire* model set is ~59 MB. 746 MB cannot be explained by id1 monsters alone, so before trusting any estimate we need attribution from the real Hellwave server worker. Candidates, none confirmed:

1. Hellwave/addon models that are far denser than id1's (100k+ pose vertices each).
2. Uncollected garbage: the DevTools VM-instance list shows total JS heap including garbage V8 has not collected yet, and `+391 kB/s` is an allocation rate, not necessarily a leak. A forced GC may drop the number a lot.
3. World BSPs (~16 MB each for id1-sized maps; Hellwave maps are bigger), entity/edict `Vector` churn, `ServerCollisionSupport`'s per-model triangle index caches.
4. A real leak across map loads (models surviving `ClearAll`, promises kept in `server.models`).

### Decisions already made

- 2026-10-09: order of attack is Phase 0 (measure), then Phase 1 (compact alias poses). Phase 2 (opt-in polygons / `PrecacheModel` options) is decided afterwards from the measured numbers, not up front.
- 2026-10-09 (later the same day): the developer likes the `PrecacheModel` opt-in and asked to pick up the mesh collision optimization, so **Phase 2 was done first**, ahead of Phases 0 and 1. Phase 0 is still needed (see "What actually shipped in Phase 2"), Phase 1 now mainly benefits the client and the models that opt in.
- 2026-10-09: `SharedArrayBuffer` is parked, not part of this plan; see "Parked: SharedArrayBuffer" in `plans/engine-architecture-modernization.md`. Consequence here: Phase 1's typed-array layout should be plain `Uint8Array`/`Uint16Array` over an `ArrayBuffer`, no per-model objects, so it stays SAB-compatible.

## Goals

- Know, per category (alias models, BSP, edicts, caches, garbage), what the server worker holds on a Hellwave map, and have a repeatable way to re-measure.
- Cut alias-model heap cost by an order of magnitude on both server and client, without changing what any game observes.
- Keep `SOLID_MESH` collision working and bit-identical.

## Non-goals (this pass)

- No change to how maps are chosen or what Hellwave precaches. (Lazy per-wave precaching is a game decision, noted under open questions.)
- No renderer changes beyond dropping data it never reads.
- No change to the network protocol or savegames.

## Design

### A. Attribution first (Phase 0)

Make the number trustworthy before optimizing:

1. Turn the scratchpad measurement into `scripts/measure-model-memory.mts` (dev tool, not wired into `package.json` test scripts): loads every `.mdl` / `.bsp` of a game dir with server settings and prints per-model heap cost and the blow-up factor. Reusable as a regression guard for Phase 1.
2. On the real server worker: take two heap snapshots (DevTools, "Collect garbage" first) on a Hellwave map, one right after load and one after a few minutes. Record retained size by constructor (`Vector`, `Object`, `Array`, `AliasModel`...) in this plan. Settles garbage-vs-retained and leak-vs-footprint.
3. Optional: a server-side `mod_memory` console command listing the models in `serverKnown` with an estimated size. Only if step 2 shows the models are the dominant cost.

### B. Compact alias pose storage (Phase 1, the main saving)

Replace the per-vertex objects with flat typed arrays owned by `AliasModel`:

- One `Uint8Array` `poseData` holding all poses as the file stores them (`x, y, z, lightnormalindex` per vertex, 4 bytes), plus a per-frame `poseOffset` into it. A frame keeps `bboxmin`, `bboxmax`, `name`, `cmdofs?`, and `poseOffset` instead of `v: AliasPoseVertex[]`. Grouped frames get the same per entry.
- `_triangles` becomes a flat `Uint16Array`/`Uint32Array` of vertex indices (+ a `facesfront` bit array only when render data is loaded). `getCollisionTriangleVertexIndices` keeps its signature.
- `getCollisionVertex(frame, i)` reads `poseData[frame.poseOffset + i*4 ..]` and applies scale/origin; same result, same return type.
- `_stverts` is consumed by `#buildRenderCommands` only; do not store it on the model when `loadRenderData` is false, and drop it after the render commands are built when true.
- Server skins: `loadRenderData: false` produces `{ texturenum: null, luminanceTexture: null }` objects per skin, which carry nothing. Keep the array length (skin count) but skip the objects.
- Update `ServerCollisionSupport.getAliasTriangleSpatialIndex`'s cache key (it compares `model._triangles` and `model.frames` by identity) to the new fields, and `accumulateAliasVertexBounds`.
- `createScopedView()` is `Object.assign` of own fields, so the typed arrays are shared between scopes, not copied. No extra work.

Expected: ~292 B/pose vertex → ~4 B (+ per-frame overhead). id1's 59 MB → ~3-4 MB. Hellwave models scale the same way.

### C. Server detail levels (Phase 2, only if Phase 0/1 numbers justify it)

The request was to free model data after processing, or make polygons opt-in. After Phase 1 the remaining server cost of an alias model is roughly its file size, so this is a smaller win (id1: ~3 MB of ~59 MB saved), but it removes all per-model cost for monsters that never need mesh collision. If wanted:

- `ModelLoadContext` gains a detail level, `bounds` (mins/maxs, frame count/names, no poses or triangles) vs. `full`. The server loads at `bounds` by default.
- `ServerEngineAPI.PrecacheModel(name, options?)` gets `{ meshCollision: true }`. A game whose entity uses `SOLID_MESH` asks for it when precaching. `Mod` keys the cache by (name, detail); a `full` request after a `bounds` load reloads from the file (it is already in the pak).
- Failure mode to design against: a `SOLID_MESH` entity whose model was loaded at `bounds` must not silently lose collision. `Edict.setModel`/`ServerCollision._getEntityCollisionState` should `console.assert` and print a one-time warning naming the model and the missing option, then fall back to the hull state.
- This touches the game contract (`GameInterfaces.ts`, docs) and id1's three `SOLID_MESH` entities, so it needs the developer's go-ahead (see open questions).

### D. World BSP on the server (Phase 3, optional)

A server never reads faces' lightmap data, texinfo, textures, or vertexes for drawing (`BSP29Loader` with `loadRenderData: false` still builds them: ~13x blow-up, ~16 MB per id1-sized map). It does need planes, clipnodes, nodes/leafs, visdata/phs, submodels, entities, and the data for `SOLID_MESH`/area/nav queries. Audit what the server realm reads from `BrushModel` (`lightdata`, `faces`, `marksurfaces`, `texinfo`, ...), then skip loading or free the rest under `!loadRenderData`. Higher risk than A-C (BSP data is shared with `Pmove`, nav, fog volumes, `AreaPortals`); only do it if Phase 0 shows BSPs are a significant share.

## Phasing

0. **Attribution.** Measurement script, heap snapshots of the real Hellwave server worker, results recorded in this plan. Stop and decide with real numbers.
1. **Compact alias poses.** Section B, with the tests below. Re-run the measurement script; record before/after here.
2. **Server detail levels.** Section C, if still wanted after Phase 1. Needs the open-question answers first.
3. **BSP trimming.** Section D, if Phase 0 says it matters.

## Testing

- `test/common/alias-model.test.mjs`, `test/common/alias-mdl-loader.test.mjs`, `test/physics/server-collision.test.mjs`, `test/common/model-cache.test.ts` touch the alias data shapes; `.mjs` tests are not type-checked, so search them by hand for `frames[...].v`, `_triangles`, `_stverts`, `lightnormalindex` after the change.
- New: a loader test that loads a small `.mdl` fixture and asserts the compact data decodes to the same scaled vertices and triangle indices as before (capture the old values as the expected data first), including a grouped-frame model.
- New: `SOLID_MESH` collision regression on an alias model through `ServerCollisionSupport` with the compact storage, same traces, same results.
- Heap guard: a test that loads an alias fixture and asserts `heapUsed` growth stays under a generous multiple of the file size is flaky; use the measurement script instead and record numbers here.
- Real browser pass (`browser-ui-verification`): alias models still render and animate (monsters, weapons, viewmodel, player skin colors). The client change in Phase 1 (dropping `frame.v` after upload) is UI-facing, so unit tests are not enough. Check one grouped-frame model and one `SOLID_MESH` entity (id1's boss/oldone) in a live game.
- If a Dockerfile `COPY` is needed for a new fixture, follow `dockerfile-fixture-sync`; the `scripts/` tool is not part of `npm test` and needs none.

## Open questions

1. **Order of attack.** Recommendation: Phase 0 then Phase 1, and decide on Phase 2 with the numbers. Compaction fixes server and client with no game-facing API and no silent-failure mode; opt-in polygons needs a `PrecacheModel` options change plus id1 edits and can quietly break `SOLID_MESH` entities if a game forgets the flag.
2. **If Phase 2 happens: API shape.** `PrecacheModel(name, { meshCollision: true })` (explicit, my recommendation) vs. lazy upgrade when an entity sets `SOLID_MESH` (no game change, but the trace path is synchronous and model loading is async, so it cannot upgrade in time).
3. **Hellwave precaching.** Precaching every monster per map is a game-side choice; per-wave lazy precache would cut model count but can stall a running server when a new monster type first spawns. Out of scope here, flagging for the Hellwave side.
4. **Diagnostics.** Is a permanent `mod_memory` console command wanted, or is the `scripts/` tool plus heap snapshots enough?

## What actually shipped in Phase 2 (2026-10-09)

Server detail levels, as designed in section C, with these specifics and deviations:

- **Option type.** `ModelLoadOptions { collisionGeometry }` in `common/model/ModelLoadContext.ts` (not a `bounds`/`full` enum; there are only two levels and a boolean cannot be misspelled). `ModelLoader.load`, `ModelLoaderRegistry.load`, `Mod.LoadModelFromBuffer`, `LoadModelAsync` and `ForNameAsync` take it as an optional last parameter.
- **What a plain server load no longer keeps for an alias model:** the per-vertex poses (`frames[].v`), `_triangles`, `_stverts`, and the skin flood fill and layer building (nothing used them without a renderer). It keeps `mins`/`maxs`, the frame list with bounding boxes and names, the counts and the checksum. `AliasModel.hasCollisionGeometry` (a getter, true when triangles are kept) tells the two apart; `BaseModel.hasCollisionGeometry` is `true` for every other type.
- **A realm with a renderer (`loadRenderData: true`) always keeps everything**, because the loader builds the GPU buffers from the poses. This also keeps the in-thread server, which shares the page's `Mod`, from handing the client a stripped model.
- **Cache.** A cached model without the geometry a load asks for is loaded again from the file. A stripped load and a geometry load of the same name have separate pending promises, and `Mod.RegisterModel` never replaces a model with geometry by one without, so the two may finish in either order. Replacing a model drops its client and server scoped views.
- **API.** `ServerEngineAPI.PrecacheModel(name, { meshCollision: true })`. Precaching an already precached name with the option replaces its `models[]` entry with the upgraded load, so the order of calls does not matter.
- **Failure mode.** A `SOLID_MESH` entity whose alias model has no geometry is traced as its bounding box (`HullCollisionState`) and `ServerCollision` prints one warning per model naming the entity class and the missing option. Not an `console.assert`, because it must be visible in a production build too.
- **Game side (id1).** `BaseEntity.setModel` passes `{ meshCollision: this.solid === SOLID_MESH }` when it precaches during loading (covers `misc_model`, so `solid` must be set before `setModel`), and `monster_boss` and `monster_oldone` precache their models with `{ meshCollision: true }`. Hellwave has no `SOLID_MESH` entities and needed no change. The id1 change is uncommitted inside the submodule.
- **Docs.** "Current behavior worth knowing" in `docs/game-module-contract.md`.

**Measured** (`node --expose-gc`, all 61 id1 `.mdl`, `loadRenderData: false`, GC before and after): plain load **0.9 MB** (was 58.9 MB), a load that asks for collision geometry 58.6 MB, as before. That is what a server holds for id1's whole model set when only boss and oldone ask for geometry: about 3 MB of the 59 MB. Alias models are no longer a candidate for the 746 MB on Hellwave unless something asks for geometry, so **Phase 0 is now the next step**: it has to show what the rest is (BSPs, edicts, garbage, a leak).

**Tests.** `test/common/alias-collision-geometry.test.ts` (new: loader with and without geometry on a synthetic `.mdl` with a frame group, cache upgrade, both finishing orders, `PrecacheModel`), and a fallback-and-warn-once test in `test/physics/server-collision.test.mjs`. `npm test` (1814) and `npm run test:game` (440) pass, `npm run typecheck` is clean.

**Not verified.** No live game run: nothing here loaded the real boss or oldone into a running server (the available id1 data has no e1m7 or end map), and no browser pass. The client path changed slightly (skin layers are built through `#buildSkinLayers`, same calls in the same order), so alias model rendering needs a real browser check per `browser-ui-verification` before this is called done. Mesh (`.obj`) models are unchanged: their vertex data is already typed arrays.

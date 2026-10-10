# Half-Life 1 studio models (`IDST` v10 `.mdl`)

## Status

📝 Draft, nothing implemented. Written 2026-10-03 after reading the model loading/rendering code
paths listed under Context. No code was changed. Phase 0 still has to settle the forks listed in
"Open questions" before Phase 1 starts.

### Decisions so far (2026-10-03, from the maintainer)

- **Stock GoldSrc only.** No FTE (or other engine) extensions to the format: v10 `IDST`/`IDSQ`,
  Valve's own conventions for companion files (`<name>T.mdl`, sequence-group files named by the
  path stored in the seqgroup table). FTE is a cross-check for the maths, not a feature list.
- **QuakeShack protocol may be bumped** (currently `Protocol.version = 42`, so the next is 43).
- **Collision: entity-set AABBs for now.** No hitbox or triangle collision in this plan; a
  physics-engine interpretation of hitboxes is a possible future extension.
- **Animation state must let the game restart a sequence and resume it mid-way** (e.g. after a
  save game load). This rules out the "piggy-back on `frame`" option (see E).
- **Skinning: whatever is easiest, performs well and runs everywhere** → CPU skinning first (see D).
- **Two fixes stand on their own and ship outside this plan**, ahead of it: making
  `R.DrawViewModel` renderer-agnostic (it hardcodes the alias program), and the `SOLID_MESH` hull
  fallback in `ServerCollision` (an unsupported model currently makes the entity untraceable).
- **Prerequisite: finish the `ClientEdict` work** in
  [client-entity-architecture.md](client-entity-architecture.md) before starting Phase 3 or the
  entity-state part of Phase 5. Phases 0-2 (loader, animator) touch neither and can start earlier.
- **Savegame clock (verified):** saves store `SV.server.time` (`Host.ts:1201`) and loads restore it
  (`Host.ts:1321`); `gameAPI.time` just mirrors it each frame. So `animtime` is stored as an
  absolute server time. Map changes reset the clock to 1.0 (`Server.ts:673`), so a game that carries
  an entity across levels must re-base `animtime` itself.

**Verification caveat.** The structural description of the studio format below comes from general
knowledge of the GoldSrc format and has *not* been checked against a spec in this session. Per
`LLM.md`, treat every struct layout and field name as a lead. The reference to check against is
FTE's implementation, `/home/cr/Work/private/fteqw/engine/gl/gl_hlmdl.c` (1825 lines; bone setup in
`HL_SetupBones`, loader in `Mod_LoadHLModel`) and its struct header next to it. Phase 1 starts by
reading those two files and writing the byte layout down in the JSDoc of the loader.

FTE's header struct names most of the scalar fields `unknown`, so it cannot confirm them: the five
`vec3`s after `name`/`filesize` are, from memory of Valve's `studio.h`, eye position, hull min/max
and view bbmin/bbmax, which FTE does not label. Phase 0 needs a second reference for the header
(Valve's `studio.h`, or another open implementation), and for the bone limit (GoldSrc: 128 bones;
FTE allows 256). The companion-file rules below are likewise from memory of Valve's tools, not
read from source in this session.

## Context

### Short answer

Yes, it is feasible, and the engine is already structured for it: model formats are pluggable
(loader registry keyed on extension + magic, renderer registry keyed on model class). What makes it
more than "add a loader" is that studio models are **skeletal**, and nothing in the engine animates
a skeleton today:

| | Alias `.mdl` (Quake) | `MeshModel` (OBJ) | Studio `.mdl` (HL1) |
|---|---|---|---|
| Animation | Per-frame vertex positions, GPU lerps two frame buffers | none | Bones, RLE-compressed per-bone channels, sequences, blending, bone controllers |
| Skinning | none | none | Every vertex has one bone index |
| Selection state on the entity | `frame`, `skinnum` | `frame` | sequence, frame (float), blend[2], controller[4], body, skin |
| Textures | Quake palette, in file | external | Own 256-colour palette *per texture*, in file (or in a companion `<name>T.mdl`) |

### What exists today (verified in source)

- **Detection.** `ModelLoader.canLoad()` requires a matching extension *and* a matching 4-byte
  magic ([ModelLoader.ts](../source/engine/common/model/ModelLoader.ts)). Quake alias models are
  `IDPO`, studio models are `IDST` (`0x54534449` little-endian), both `.mdl`, so they do not
  collide. [Mod.ts:109-114](../source/engine/common/Mod.ts#L109-L114) registers the loaders.
- **Loading is async and may fetch other files.** `ModelLoader.load()` returns a `Promise`, which
  is what we need for the companion files (`<name>T.mdl` textures, `<name>01.mdl` sequence groups).
- **Model classes** extend [BaseModel.ts](../source/engine/common/model/BaseModel.ts);
  `ModelType` ([Mod.ts:22](../source/engine/common/Mod.ts#L22)) is `brush | sprite | alias | mesh`.
- **Renderers** are strategies registered per model class
  ([R.ts:2529-2532](../source/engine/client/R.ts#L2529-L2532),
  [ModelRendererRegistry.ts](../source/engine/client/renderer/models/ModelRendererRegistry.ts)).
  [AliasModelRenderer.ts](../source/engine/client/renderer/models/AliasModelRenderer.ts) is the template
  for lighting uniforms, the player/normal shader choice, the transparent pass, and
  `renderShadow()`.
- **Dedicated server.** `AliasMDLLoader` skips GL texture creation when `registry.isDedicatedServer`
  ([AliasMDLLoader.ts:362](../source/engine/common/model/loaders/AliasMDLLoader.ts#L362)); the
  studio loader must do the same, because the server loads every precached model for
  `Edict.setModel()` bounds ([Edict.ts:612-650](../source/engine/server/Edict.ts#L612)).
- **Palette-aware texture helpers exist.** `buildAliasSkinLayers(skin, w, h, palette,
  transparentColor, fullbrightColorStart)` ([AliasMDLLoader.ts](../source/engine/common/model/loaders/AliasMDLLoader.ts))
  already takes an arbitrary palette and a transparent index, which is what studio masked
  textures (index 255) need.
- **Entity animation state is one number.** `ClientEdict` carries `frame`, `skinnum`, `colormap`
  and a lerp window for `frame`
  ([ClientEntities.ts:140-144](../source/engine/client/ClientEntities.ts#L140),
  [:250-258](../source/engine/client/ClientEntities.ts#L250)). `Protocol.EntityState` has the same
  fields, and the update flag enum `u` ([Protocol.ts:7-24](../source/engine/network/Protocol.ts#L7))
  already uses all 16 bits (`msg.writeUint16(bits)`). `Protocol.version` is already 42.
- **Games already have a delta-compressed per-class field channel.** `SV.server.clientEntityFields`
  (declared by the game, up to 32 fields per classname, bitmask + serialized values) ends up in
  `ClientEdict.extended`
  ([ServerMessages.ts:621](../source/engine/server/ServerMessages.ts#L621),
  [ClientServerCommandHandlers.ts:588](../source/engine/client/ClientServerCommandHandlers.ts#L588)).
  It needs no protocol change, but it is untyped, per-classname, and invisible to engine code that
  has no classname (baselines, static entities, the viewmodel).
- **Collision gap.** `ServerCollision._getEntityCollisionState` returns `null` for a `SOLID_MESH`
  entity whose model is neither mesh nor alias
  ([ServerCollision.ts:100-108](../source/engine/server/physics/ServerCollision.ts#L100)), meaning
  untraceable. A studio model on a `SOLID_MESH` entity needs a `HullCollisionState` fallback there.
- **No uniform buffers and no float textures** are used anywhere in `source/engine` (grepped
  `UNIFORM_BUFFER`, `RGBA32F`). Skinning with a bone-matrix array will be the first.

### Coordinate system

GoldSrc and Quake share axes (X forward, Y left, Z up) and unit scale, so no mesh conversion is
needed. Studio animation rotations are Euler angles in radians per bone, converted to quaternions
for blending (FTE does this in `QuaternionGLAngle`).

## Goals

1. Load HL1 studio models (`IDST`, version 10) through the existing loader registry, on both the
   client and the dedicated server.
2. Render them animated, lit, textured and shadowed in the existing pipeline, inside the opaque and
   transparent passes.
3. Make sequences, blending, bone controllers and body groups drivable from game code through the
   public engine API (game code never imports engine internals), including restarting and resuming
   a sequence.
4. Server-side: `setModel()` bounds work, precache works, no GL dependency.
5. Keep the animation maths in a GL-free class so it is unit-testable and later reusable on the
   server (hitboxes, attachments).

## Non-goals

- **Half-Life maps (`BSP30`), WADs (`WAD3`), HL sounds, sprites.** Separate formats, separate plans.
  Studio models work inside ordinary Quake BSP maps.
- **Shipping Half-Life assets.** We cannot commit Valve's models. Tests use synthetic models built
  in code; real-model verification uses files the developer supplies locally.
- **GoldSrc gameplay.** No HL entity set, no HL weapon logic.
- **Source-engine (`IDST` v44+/`MDL` v48) and Xash extended studio formats.** v10 only; the loader
  rejects other versions with a clear error. Revisit if there is demand.
- **Replacing the alias path.** Quake `IDPO` models keep working untouched.
- **Hitbox-accurate or triangle collision.** Entities use AABBs for now (see F).

## Design

### A. Data model: `StudioModel`

New `source/engine/common/model/StudioModel.ts`, `extends BaseModel`, `ModelType.studio = 4`.
Immutable, parsed data only (so `createScopedView()` can share it):

- header scalars: `eyePosition`, hull `min/max`, view `bbmin/bbmax` (names to be confirmed against a
  second reference in Phase 0), flags; `BaseModel.mins/maxs` are seeded from one of the boxes, but
  the entity-set AABB wins (see F);
- `bones[]` (name, parent, bone-controller indices, default pos/rot, scale-per-channel),
  `boneControllers[]` (bone, type, start, end, index, rest),
- `sequences[]` (name, fps, flags/loop, frame count, blend count/type/range, motion fields,
  events, entry/exit node, group index, and the **decoded** per-bone animation data),
- `bodyParts[]` → `subModels[]` → `meshes[]` (triangle strips/fans converted to a plain triangle
  list at load time, per-vertex bone index, per-vertex normal, texture coordinates, skin ref),
- `textures[]` (name, flags, w×h, 8-bit pixels + palette, GL textures created client-side only),
- `skinFamilies` (skin ref table), `attachments[]`, `hitboxes[]` (parsed now even if unused, it is
  cheap and avoids a second loader pass later).

All offsets in the file are untrusted (models arrive from servers and CDNs). The loader
bounds-checks every table and offset against the buffer and throws `CorruptedResourceError`
([Errors.ts](../source/engine/common/Errors.ts)) instead of reading past the end, with fuzz-style
unit tests (truncated file, offset past EOF, bone parent cycle, huge counts).

### B. Loader: `StudioMDLLoader`

New `source/engine/common/model/loaders/StudioMDLLoader.ts`; magic `0x54534449`, extension
`.mdl`, registered next to `AliasMDLLoader`.

- **Version check**: 10 only.
- **Texture companion** (native GoldSrc: an empty texture table means the textures live in
  `<basename>T.mdl`). Loaded via `COM.LoadFile` inside the async `load()`. Phase 0 confirms the
  exact trigger (`textureindex == 0` in Valve's tools, `numtextures == 0` in FTE) and how
  `COM.LoadFile` treats filename case.
- **Sequence-group companions** (native: `numseqgroups > 1`, files are `IDSQ`). Use the path stored
  in each seqgroup entry, falling back to `<basename>01.mdl`, `02`, … only if it is empty. A missing
  companion fails the load with `MissingResourceError` (eager, not at first render).
- **Texture decode**: per-texture embedded palette through `translateIndexToRGBA(...,
  palette, transparentColor)`; flags map to render state (see D). Dedicated server skips pixel work.
- **Geometry flattening**: strips/fans → indexed triangle list per mesh, per-vertex
  `{position, normal, uv, bone}`. Done once at load time, not per frame.

### C. Animation core: `StudioAnimator` (GL-free)

New `source/engine/common/model/StudioAnimation.ts` (static class, per the "no standalone
functions" rule). Inputs: `StudioModel`, `StudioPose` request `{sequence, frame (float), blend[2],
controller[4], mouth, time}`. Output: `Float32Array` of per-bone 3×4 matrices
(`boneMatrix[i] = parent * local`).

- decode of the RLE per-bone/per-channel animation values (the format's compressed
  `mstudioanim` runs), done lazily per sequence and cached on the model;
- frame interpolation inside a sequence (loop vs. clamp), sequence-to-sequence blending, the
  two-axis "blend" parameter for blended sequences, bone controllers (including the wrap-around
  rule for rotation controllers);
- Euler→quaternion, quaternion slerp between frames, then matrix build.

Cross-sequence *transitions* (HL's entry/exit node table) are a game-logic concern in GoldSrc;
we expose "blend from previous sequence over N seconds" (a client-side lerp state, like the
existing `ClientEdict` frame lerp) and skip node graphs.

### D. Rendering: `StudioModelRenderer`

New `source/engine/client/renderer/StudioModelRenderer.ts`, registered in
[R.ts](../source/engine/client/R.ts) beside the others, plus new shaders `studio.vert/frag` and
`shadow-studio(-point).vert/frag`.

- **Skinning: CPU first, behind the renderer interface.** HL models are rigid-skinned (one bone
  per vertex) and small (a few thousand vertices), so transforming vertices in JS into a streaming
  buffer is cheap, needs no new GL feature (no UBO, no float texture), works on every WebGL2 device,
  and keeps the shader surface at the existing alias-style program. The same skinned buffer serves
  the shadow pass, so no skinned shadow shader pair is needed. Cache the skinned result per entity
  per frame (shadow passes revisit the same entity), and skip it for culled entities. Revisit a GPU
  path (UBO: 128 bones × 48 B = 6 KB, within the 16 KB WebGL2 minimum; a plain uniform array does
  not fit the 256-vector minimum) only if profiling with many animated entities demands it; the
  renderer's `prepareModel`/`render` boundary keeps that swap local.
- **Meshes** are drawn per (selected body submodel × mesh), grouped by texture to minimize binds.
  `body` selects one submodel per body part (`(body / base) % numModels`, per the format).
- **Lighting** reuses `R._CalculateLightValues()` and the alias fragment lighting math. Per
  `shaders.instructions.md` there is no `#include`: the shared routines get **hand-duplicated** into
  `studio.frag`; run the `shader-chunks` skill when this lands, and write the
  list of duplicated routines in the plan's "What shipped" section.
- **Texture flags**: `FULLBRIGHT` → luminance layer (existing `tLuminance`); `MASKED` → alpha
  from index 255; `ADDITIVE` → transparent pass with additive blend; `FLATSHADE` → ignore normals;
  `CHROME` → sphere-map UVs computed in the vertex shader from the bone-transformed normal.
  Chrome and additive are Phase 4 polish; Phase 3 renders them as plain diffuse.
- **Culling**: bounding sphere from the model's view bounds (not per-pose), same `Camera.CullBox` path.
- **Shadows**: `renderShadow()` draws the CPU-skinned buffer with the existing shadow programs.
- **Viewmodel / player colour remap** (HL's `Remap` texture naming): out of scope for now.

### E. Entity state, protocol, game API

A studio entity needs more selection state than `frame` + `skinnum`. Following GoldSrc's own
`entity_state_t`: `sequence`, `animtime`, `framerate`, `body`, `skin`, `controller[4]`,
`blending[2]`. The client derives the playback position as
`(renderTime - animtime) * framerate * sequence.fps`, then loops or clamps per the sequence flags.
That makes the two required behaviours trivial:

- **Restart** a sequence (even the same one): the game sets `animtime = now`; the changed value is
  what gets sent.
- **Resume mid-sequence** (save game load, late join): the game sets `animtime = now - elapsed`.
  Savegames store `sequence` plus elapsed time (or `animtime` relative to the saved server time;
  check how `sv.time` is restored before deciding).

Transport options (decision for Phase 0; the piggy-back option from the first draft is dropped, it
cannot restart or resume):

1. **Engine-typed state + protocol bump (recommended).** Add a studio block to `Protocol.EntityState`
   and `ClientEdict`, delta-compressed, gated by one new bit. All 16 bits of `u` are used, so widen
   the flag word (`writeUint16` → `writeUint32`, or a "more flags" byte) as part of the version bump
   to 43. The server reads the fields from optional members of the game entity, so existing games
   that never set them send nothing. Works for baselines, static entities and the viewmodel, and
   gives the renderer a typed contract. Costs: protocol/doc/test updates
   (`test/common/protocol.test.mjs`, `docs/`), demo compatibility.
2. **Game-declared extended fields (existing channel, no engine protocol change).** The game
   declares `sequence`, `animtime`, … in `clientEntityFields` for its classes and the renderer reads
   `ClientEdict.extended`. Zero wire work, but the field names become an implicit engine contract,
   values are untyped, it is per-classname, and it does not reach entities without one. Reasonable
   as a stopgap or for game-specific extras; not as the engine's studio contract.
3. **Hybrid.** Option 1 for the standard studio block, option 2 stays available to games for
   anything else.

Interaction with [client-entity-architecture.md](client-entity-architecture.md): decided, that
plan's `ClientEdict` work finishes first. The new studio fields and their savegame serialization
(`ClientSerialization.ts`) are then added on top of the finished structure, wire encoding last.

Game-facing API (additions to the public engine API, JSDoc'd, mirrored in
`source/shared/GameInterfaces.ts` and `docs/game-module-contract.md`). **All additive and
optional**; `BaseEntity` members for the studio state are optional so existing games still satisfy
the interface:

- `engine.GetStudioSequences(model)` / `FindSequence(model, name)` → resolves sequence names the
  way `ParsedQC.frames` does for alias models, so game code is not hardcoding indices;
- optional entity fields `sequence`, `animtime`, `framerate`, `body`, `blending`, `controller`;
- `ViewmodelConfig` gains optional `sequence`, `animtime`, `framerate`, `body` (alias models keep
  using `frame`);
- animation events (muzzle flash, footstep sound) exposed as data on the sequence; firing them is a
  game decision.

### F. Collision and bounds

- Studio entities are plain AABB entities: the game sets the size (`setSize`/`setModel` bounds),
  the area tree and `SV_Move` need no changes.
- `BaseModel.mins/maxs` are seeded from the header so `Edict.setModel()` has sensible defaults;
  the game overrides them as needed.
- `ServerCollision._getEntityCollisionState` must fall back to `HullCollisionState` for a
  `SOLID_MESH` entity whose model it cannot trace instead of returning `null`. This is independent
  of this plan and ships separately (see Decisions); studio models just rely on it.
- Non-goal for now: triangle or hitbox collision. A future extension may hand hitboxes (parsed at
  load time anyway) to a physics engine; it must go through the existing trace API.

## Phasing

Stop at each boundary for a go-ahead and record what shipped here (`plan-first-workflow`).

**Prerequisites (outside this plan):** `ClientEdict` work from client-entity-architecture
finished; `R.DrawViewModel` made renderer-agnostic; `SOLID_MESH` hull fallback.

**Phase 0: decisions and spike.** Answer the Open questions; read FTE's `gl_hlmdl.c` and write the
byte layout into the loader's JSDoc; obtain one or two permissively-licensed or developer-owned
studio models for local verification. *Exit: forks decided, layout documented.*

**Phase 1: format and loader (server-safe).** `StudioModel`, `StudioMDLLoader`, `ModelType.studio`,
registration, companion-file loading, bounds checking, bounds → `mins/maxs`, dedicated-server path
without GL. A dev command `modelinfo <name>` printing bones/sequences/bodyparts for verification.
*Tests: synthetic model builder fixture, truncation/corruption cases, version rejection, companion
files, dedicated mode.* *Exit: a server can precache and `setModel()` a studio model.*

**Phase 2: animation core.** `StudioAnimator` with RLE decode, interpolation, blending,
controllers, matrix output. *Tests: hand-computed 2-bone fixtures (rest pose, single-frame
rotation, mid-frame slerp, loop wrap, controller clamp/wrap, blend weights), and a
cross-check of one real model's pose against FTE's output if Phase 0 produced one.* *Exit: poses
match the reference.*

**Phase 3: rendering.** Renderer + shaders, CPU skinning, driven by the entity state from E (a
temporary client-only state is fine until the wire format lands). Make `R.DrawViewModel`
renderer-agnostic (can ship earlier, independently). Add
`viewseq`/`viewbody` console commands next to `viewframe` in
[Host.ts](../source/engine/common/Host.ts#L1890) for a model viewer. *Verification: real
browser, per `browser-ui-verification` (visual comparison against FTE's render of the same model
and pose). Headless can verify rendering, not input.* *Exit: an animated model is visible, lit,
and shadowed.*

**Phase 4: render polish.** Chrome, additive, flatshade, masked correctness, transparency pass,
player colour remap if wanted, LOD for far entities (skip bone recompute when culled).

**Phase 5: game integration.** Entity state transport per E (protocol 43), game API for
sequences/body, `ViewmodelConfig` studio fields, savegame state (restart/resume must round-trip),
attachment points, animation events.

## Testing

- Engine tests under `test/common/` (loader, animator) and `test/renderer/` (renderer/GL-mocked
  pieces), files named per `unit-tests.instructions.md`: `studio-mdl-loader.test.mjs`,
  `studio-animation.test.mjs`, `studio-model-renderer.test.mjs`. All in existing directories,
  so no new test-glob depth (`test-glob-coverage` not triggered unless that changes).
- The synthetic model builder lives in a non-`.test.` helper next to the tests, so no binary
  fixture and no Dockerfile `COPY` is required (`dockerfile-fixture-sync` not triggered). If a
  real model fixture is ever committed, re-check that skill.
- `npm run typecheck`, `npx eslint --fix` on every touched file; remember `.mjs` tests are not
  type-checked, so search them by hand if a signature changes.
- Shaders: no automated check; browser verification is the gate for Phases 3-4.
- `docs/events.md` untouched unless a phase adds an `eventBus` event (`event-bus-docs-sync`).

## Open questions

Settled (see Decisions): v10 only and no FTE extensions, protocol bump allowed, AABB collision,
restart/resume required, CPU skinning first, `ClientEdict` work finishes first, `animtime` is
absolute server time.

1. **Transport (E).** Option 1 (typed engine state, protocol 43) vs. option 3 (hybrid). Recommended:
   1. Also: widen the flag word or add a "more flags" byte?
2. **Where should the GL-free animator live?** `source/engine/common/model/` (recommended: it is
   model-format code and the server will want it) vs. `source/shared/` (if games should import it
   directly, e.g. for client-side prediction of attachment points).
3. **Test assets.** Is there a model you can legally use for local verification and, if so, may a
   tiny one be committed to `data/` (would then need the Dockerfile `COPY` and `.dockerignore`
   check)? Otherwise synthetic-only.
4. **Sequence transitions and events.** Engine-provided blend-from-previous (client lerp state) or
   leave to game code entirely?
5. **Filename case.** How does `COM.LoadFile` handle `T.mdl` vs. `t.mdl` on case-sensitive hosts?

## Risks

- **Duplicated lighting code in `studio.frag`** (no `#include`); a missed copy is a silent
  rendering bug. CPU skinning avoids the extra skinned shadow shaders.
- **CPU skinning cost** with many animated entities; mitigated by skipping culled entities and
  caching the skinned buffer per (sequence, frame, blend, controllers). GPU skinning is the escape
  hatch.
- **Protocol bump** touches baselines, deltas, demos and docs; keep it to one phase.
- **Format edge cases** (sequence groups, negative strip counts for fans, 0-offset textures,
  controller wrap) are where hand-written loaders break; the FTE source is the oracle, which is
  why Phase 0 and Phase 2 insist on cross-checking against it.

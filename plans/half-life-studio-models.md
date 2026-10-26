# Half-Life 1 studio models (`IDST` v10 `.mdl`)

## Status

📝 Draft, nothing implemented. Written 2026-10-03 after reading the model loading/rendering code
paths listed under Context. No code was changed. Phase 0 still has to settle the forks listed in
"Open questions" before Phase 1 starts.

**Re-checked against the source on 2026-10-23** (branch `feature/animated-image-sprites`). Every
"verified in source" claim, line reference and file path below was read again and corrected.
Changes since the first draft that affect this plan:

- The `ClientEdict` prerequisite is done:
  [client-entity-architecture.md](client-entity-architecture.md) is ✅, all phases.
- The `SOLID_MESH` "untraceable" gap was not real. The callers already fall back to a hull (see F),
  so that prerequisite is gone.
- The protocol is at 43 now (image sprites, Phase 4), so this plan's bump takes 44.
- Shaders have `#include` chunks now (`shader-chunks` skill, `docs/shader-chunks.md`), so nothing
  gets hand-duplicated into `studio.frag` any more (D).
- Loaders get a `ModelLoadContext` (`files`, `loadRenderData`) and no longer call `COM` or check
  `isDedicatedServer` (B).
- [animated-image-sprites.md](animated-image-sprites.md) shipped. It sets precedents for sequence
  APIs (`GetSpriteSequenceIndex`/`GetSpriteSequenceDuration`), adds `ClientEdict.animationStartTime`,
  adds `ModelPrecacheFlags`, and covers Half-Life SPR v2 sprites (E, Non-goals).
- [server-model-memory.md](server-model-memory.md) showed that per-vertex objects blow up server
  memory about 22x for alias models. The studio loader stores flat typed arrays from the start (A).
- All tests are TypeScript (`.test.ts`) and type-checked (Testing).

### Decisions so far (2026-10-03, from the maintainer)

- **Stock GoldSrc only.** No FTE (or other engine) extensions to the format: v10 `IDST`/`IDSQ`,
  Valve's own conventions for companion files (`<name>T.mdl`, sequence-group files named by the
  path stored in the seqgroup table). FTE is a cross-check for the maths, not a feature list.
- **QuakeShack protocol may be bumped.** When this was written the protocol was at 42 and the bump
  would have been 43. The sprite plan took 43 first (`Protocol.ts:3`), so this plan's bump is 44.
- **Collision: entity-set AABBs for now.** No hitbox or triangle collision in this plan; a
  physics-engine interpretation of hitboxes is a possible future extension.
- **Animation state must let the game restart a sequence and resume it mid-way** (e.g. after a
  save game load). This rules out the "piggy-back on `frame`" option (see E).
- **Skinning: whatever is easiest, performs well and runs everywhere** → CPU skinning first (see D).
- **Two fixes stand on their own and ship outside this plan**, ahead of it: making
  `R.DrawViewModel` renderer-agnostic, and the `SOLID_MESH` hull fallback in `ServerCollision`.
  Status 2026-10-23: `R.DrawViewModel` draws through the renderer registry now, but it still
  uploads the narrow viewmodel projection only to the `alias` program
  ([R.ts:136-153](../source/engine/client/R.ts#L136-L153)), so a studio (or mesh) viewmodel would
  draw with the world projection. This one is still open. The hull fallback is not needed: see F.

### Decisions (2026-10-23, from the maintainer)

- **Generic sequence queries, not one pair per format.** Both engine APIs get
  `GetSequenceIndex(modelName, name)` and `GetSequenceDuration(modelName, sequence)`, which answer
  for sprites and studio models alike. That way a game can swap a sprite for a studio model, or the
  other way round, without changing its lookups. They replace the sprite plan's
  `GetSpriteSequenceIndex`/`GetSpriteSequenceDuration`, which no game calls yet (only the engine,
  `docs/sprites.md`, `docs/game-module-contract.md` and `test/common/sprite-sequence-queries.test.ts`).
  So the sprite methods are renamed outright, with no aliases kept. The rename can ship on its own,
  ahead of this plan (E).
- **`sequence` is the one field that selects a sequence, for every sequenced format** (option (c)
  of the former open question 5). Sprites switch to it too: `sequence` picks the sequence and
  `animtime` starts it, the same fields with the same meaning as for studio models. Where this
  breaks the current sprite behavior, the sprite logic is upgraded to the new model, and no
  compatibility shim is kept. What that means in detail is in "Sequences shared with sprites" (E)
  and Phase S.
- **Prerequisite: finish the `ClientEdict` work** in
  [client-entity-architecture.md](client-entity-architecture.md) before starting Phase 3 or the
  entity-state part of Phase 5. ✅ Met: that plan is done, all phases.
- **Savegame clock (verified, re-checked 2026-10-23):** saves store `sv.server.time`
  ([ServerSavegame.ts:72](../source/engine/server/ServerSavegame.ts#L72)) and loads restore it
  ([ServerSavegame.ts:136](../source/engine/server/ServerSavegame.ts#L136)); `gameAPI.time` just
  mirrors it each frame ([ServerHost.ts:683](../source/engine/server/ServerHost.ts#L683)). So
  `animtime` is stored as an absolute server time. Map changes reset the clock to 1.0
  ([Server.ts:831](../source/engine/server/Server.ts#L831)), so a game that carries an entity
  across levels must re-base `animtime` itself.

**Verification caveat.** The structural description of the studio format below comes from general
knowledge of the GoldSrc format and has *not* been checked against a spec in this session. Per
`LLM.md`, treat every struct layout and field name as a lead. The reference to check against is
FTE's implementation, `/home/cr/Work/private/fteqw/engine/gl/gl_hlmdl.c` (1825 lines; bone setup in
`HL_SetupBones`, controllers in `HL_CalcBoneAdj`, loader in `Mod_LoadHLModel`) and its struct header
next to it, `model_hl.h`. Phase 1 starts by
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

### What exists today (verified in source, re-checked 2026-10-23)

- **Detection.** `ModelLoader.canLoad()` requires a matching extension *and* a matching 4-byte
  magic ([ModelLoader.ts:43-49](../source/engine/common/model/ModelLoader.ts#L43-L49)). Quake alias models are
  `IDPO`, studio models are `IDST` (`0x54534449` little-endian), both `.mdl`, so they do not
  collide. [Mod.ts:133-140](../source/engine/common/Mod.ts#L133-L140) registers the loaders.
- **Loading is async and may fetch other files.** `ModelLoader.load()` returns a `Promise`, which
  is what we need for the companion files (`<name>T.mdl` textures, `<name>01.mdl` sequence groups).
  A loader reads files through its `ModelLoadContext.files` (`LoadFile`, `LoadTextFile`,
  `LoadOptionalTextFile`), not through `COM` directly
  ([ModelLoadContext.ts](../source/engine/common/model/ModelLoadContext.ts)). `COM` lower-cases every
  file name ([Com.ts:448](../source/engine/common/Com.ts#L448), `docs/asset-layer.md`).
- **Model classes** extend [BaseModel.ts](../source/engine/common/model/BaseModel.ts);
  `ModelType` ([Mod.ts:17-22](../source/engine/common/Mod.ts#L17-L22)) is `brush | sprite | alias | mesh`.
- **Renderers** are strategies registered per model class
  ([R.ts:354-357](../source/engine/client/R.ts#L354-L357),
  [ModelRendererRegistry.ts](../source/engine/client/renderer/models/ModelRendererRegistry.ts)).
  [AliasModelRenderer.ts](../source/engine/client/renderer/models/AliasModelRenderer.ts) is the template
  for lighting uniforms, the player/normal shader choice, the transparent pass, and
  `renderShadow()`. [MeshModelRenderer.ts](../source/engine/client/renderer/models/MeshModelRenderer.ts)
  is the template for drawing an already-posed vertex buffer (`mesh` program, shadows through
  `shadow-brush`/`shadow-point`), which is what a CPU-skinned studio pose is.
- **Server realm.** A realm that does not draw (dedicated server, server worker) loads with
  `context.loadRenderData === false`. `AliasMDLLoader` skips its skin layers then
  ([AliasMDLLoader.ts:498-506](../source/engine/common/model/loaders/AliasMDLLoader.ts#L498-L506)).
  The studio loader must do the same, because the server loads every precached model for
  `Edict.setModel()` bounds ([Edict.ts:617-655](../source/engine/server/Edict.ts#L617-L655)).
  [server-model-memory.md](server-model-memory.md) measured about a 22x blow-up for alias models
  stored as per-vertex objects, which is why the alias data was flattened.
- **Palette-aware texture helpers exist.** `buildAliasSkinLayers(skin, w, h, palette,
  transparentColor, fullbrightColorStart)`
  ([AliasMDLLoader.ts:77](../source/engine/common/model/loaders/AliasMDLLoader.ts#L77)) and
  `translateIndexToRGBA` ([W.ts:428](../source/engine/common/W.ts#L428)) already take an arbitrary
  palette and a transparent index, which is what studio masked textures (index 255) need.
- **Entity animation state is one number.** `ClientEdict` carries `frame`, `skinnum`, `colormap`
  and a lerp window for `frame`
  ([ClientEntities.ts:155-165](../source/engine/client/ClientEntities.ts#L155-L165),
  [:285-291](../source/engine/client/ClientEntities.ts#L285-L291)). Since the sprite plan,
  `model` and `frame` are accessors that stamp `animationStartTime` with the client time when
  their value changes ([:160](../source/engine/client/ClientEntities.ts#L160),
  [:326-353](../source/engine/client/ClientEntities.ts#L326-L353)). That clock is client-side and
  starts over for a client that joins late, so it cannot stand in for a server-driven `animtime`.
  `Protocol.EntityState` ([Protocol.ts:195](../source/engine/network/Protocol.ts#L195)) and the
  server's `ServerEntityState` have the same fields. The update flag enum `u`
  ([Protocol.ts:8-25](../source/engine/network/Protocol.ts#L8-L25)) already uses all 16 bits
  (`msg.writeUint16(bits)`, [ServerMessages.ts:569](../source/engine/server/ServerMessages.ts#L569)),
  and `frame` goes on the wire as a byte. `Protocol.version` is 43.
- **Games already have a delta-compressed per-class field channel.** `SV.server.clientEntityFields`
  (declared by the game, up to 32 fields per classname, bitmask + serialized values) ends up in
  `ClientEdict.extended`
  ([ServerMessages.ts:627](../source/engine/server/ServerMessages.ts#L627),
  [ClientServerCommandHandlers.ts:576](../source/engine/client/ClientServerCommandHandlers.ts#L576)).
  It needs no protocol change, but it is untyped, per-classname, and invisible to engine code that
  has no classname (baselines, static entities, the viewmodel).
- **Collision: no gap after all.** `ServerCollision._getEntityCollisionState` does return `null` for
  a `SOLID_MESH` entity whose model is neither mesh nor alias
  ([ServerCollision.ts:115-135](../source/engine/server/physics/ServerCollision.ts#L115-L135)), but
  every tracing caller falls back with `?? this._getHullFallbackState(...)`: `clipMoveToEntity`
  ([:719](../source/engine/server/physics/ServerCollision.ts#L719)) and `_traceTouch`
  ([:830](../source/engine/server/physics/ServerCollision.ts#L830)). `clipMoveToMesh` returns an
  empty trace for anything that is not a mesh, which is correct. The first draft read this wrong.
- **Sequence APIs have a precedent.** The sprite plan added
  `GetSpriteSequenceIndex(modelName, name)` and `GetSpriteSequenceDuration(modelName, frame)` to both
  engine APIs ([ServerEngineAPI.ts:518-531](../source/engine/server/ServerEngineAPI.ts#L518-L531),
  `source/shared/GameInterfaces.ts`), plus `ModelPrecacheFlags`
  ([source/shared/ModelPrecacheFlags.ts](../source/shared/ModelPrecacheFlags.ts)), a flags byte
  per model in `serverdata`.
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

- **Half-Life maps (`BSP30`), WADs (`WAD3`), HL sounds.** Separate formats, separate plans.
  Studio models work inside ordinary Quake BSP maps. Half-Life sprites (SPR v2) already shipped with
  [animated-image-sprites.md](animated-image-sprites.md) (Phase 6).
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

Store vertices, normals, UVs, bone indices and decoded animation values in flat typed arrays,
not one object per vertex or per key. The server realm keeps a model for every precache, and
per-vertex objects are what made alias models cost about 22x their file size there
([server-model-memory.md](server-model-memory.md)).

All offsets in the file are untrusted (models arrive from servers and CDNs). The loader
bounds-checks every table and offset against the buffer and throws `CorruptedResourceError`
([Errors.ts](../source/engine/common/Errors.ts)) instead of reading past the end, with fuzz-style
unit tests (truncated file, offset past EOF, bone parent cycle, huge counts).

### B. Loader: `StudioMDLLoader`

New `source/engine/common/model/loaders/StudioMDLLoader.ts`; magic `0x54534449`, extension
`.mdl`, registered next to `AliasMDLLoader`.

- **Version check**: 10 only.
- **Texture companion** (native GoldSrc: an empty texture table means the textures live in
  `<basename>T.mdl`). Loaded via `this.context.files.LoadFile` inside the async `load()`. Phase 0
  confirms the exact trigger (`textureindex == 0` in Valve's tools, `numtextures == 0` in FTE,
  `gl_hlmdl.c:346`). Filename case is settled: `COM` lower-cases every name, so the companion
  resolves as `<basename>t.mdl` and content must be stored in lower case.
- **Sequence-group companions** (native: `numseqgroups > 1`, files are `IDSQ`). Use the path stored
  in each seqgroup entry, falling back to `<basename>01.mdl`, `02`, … only if it is empty. A missing
  companion fails the load with `MissingResourceError` (eager, not at first render).
- **Texture decode**: per-texture embedded palette through `translateIndexToRGBA(...,
  palette, transparentColor)`; flags map to render state (see D). With
  `context.loadRenderData === false` (server realm), skip pixel work and the companion texture file
  entirely, and keep no mesh geometry unless a later phase needs it on the server.
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

New `source/engine/client/renderer/models/StudioModelRenderer.ts`, registered in
[R.ts](../source/engine/client/R.ts) beside the others, plus new shaders `studio.vert/frag`.
No new shadow programs: the CPU-skinned buffer is already posed, so shadows go through
`shadow-brush`/`shadow-point` the way `MeshModelRenderer.renderShadow()` does.

- **Skinning: CPU first, behind the renderer interface.** HL models are rigid-skinned (one bone
  per vertex) and small (a few thousand vertices), so transforming vertices in JS into a streaming
  buffer is cheap, needs no new GL feature (no UBO, no float texture), works on every WebGL2 device,
  and keeps the shader surface at an existing-style program. The same skinned buffer serves
  the shadow pass, so no skinned shadow shader pair is needed. Cache the skinned result per entity
  per frame (shadow passes revisit the same entity), and skip it for culled entities. Revisit a GPU
  path (UBO: 128 bones × 48 B = 6 KB, within the 16 KB WebGL2 minimum; a plain uniform array does
  not fit the 256-vector minimum) only if profiling with many animated entities demands it; the
  renderer's `prepareModel`/`render` boundary keeps that swap local.
- **Meshes** are drawn per (selected body submodel × mesh), grouped by texture to minimize binds.
  `body` selects one submodel per body part (`(body / base) % numModels`, per the format).
- **Lighting** reuses `EntityLighting.CalculateLightValues()`
  ([EntityLighting.ts:40](../source/engine/client/renderer/lighting/EntityLighting.ts#L40)) and
  the shared shader chunks: `studio.vert` includes `entity-vertex.glsl`, `entity-varyings-out.glsl`
  and `fog-vertex.glsl`, and `studio.frag` includes `entity-lighting.glsl` and `fog-fragment.glsl`,
  the way `alias.*`/`mesh.*` do. Nothing is pasted in. A routine that `alias.frag` has and
  `studio.frag` also needs (luminance layer, alpha test) becomes a chunk first. Follow the
  `shader-chunks` skill, and check with `test/renderer/shader-library.test.ts`. If `mesh.frag` plus
  a fullbright layer and an alpha test turns out to be all `studio.frag` is, consider extending
  `mesh` instead of adding a program.
- **Texture flags**: `FULLBRIGHT` → luminance layer (existing `tLuminance`); `MASKED` → alpha
  from index 255; `ADDITIVE` → transparent pass with additive blend; `FLATSHADE` → ignore normals;
  `CHROME` → sphere-map UVs computed in the vertex shader from the bone-transformed normal.
  Chrome and additive are Phase 4 polish; Phase 3 renders them as plain diffuse.
- **Culling**: bounding box from the model's view bounds (not per-pose), the same
  `Camera.CullBox` path as the alias and mesh renderers
  ([Camera.ts:141](../source/engine/client/renderer/scene/Camera.ts#L141)).
- **Shadows**: `renderShadow()` draws the CPU-skinned buffer with `shadow-brush`/`shadow-point`.
- **Viewmodel**: needs the open `R.DrawViewModel` fix first (Decisions). It must hand the narrow
  projection to whichever program the renderer binds, not only to `alias`.
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
  Savegames restore `sv.server.time` (see Decisions), so an absolute `animtime` saved with the
  entity stays correct across save and load without any re-basing. Only a level change, which
  resets the clock, needs the game to re-base it.

#### Sequences shared with sprites (decided 2026-10-23)

`sequence`, `animtime` and `framerate` are not studio-only. They are the selection state of every
model that has sequences, today image sprites and later studio models. The studio-only extras
(`body`, `controller[4]`, `blending[2]`) stay a separate block. What changes for sprites:

| | Today (sprite plan) | After the upgrade |
|---|---|---|
| Image sprites (GIF, PNG/APNG, WebP, Aseprite) | `frame` picks the sequence | `sequence` picks it; `frame` no longer selects anything |
| Quake/Half-Life SPR (v1, v2) | `frame` picks an SPR frame or group | unchanged: `frame` is the image index, as in Quake and GoldSrc |
| Start of a `phase: spawn` sequence | `ClientEdict.animationStartTime`, stamped on the client when `model`/`frame` change; a late joiner starts over | `animtime`. The server sends it, so late joiners and savegames see the same point in the sequence. A client-only entity gets it stamped on the client when its `model` or `sequence` changes. `animationStartTime` is removed |
| Playback speed | the sidecar's `fps` | the sidecar's `fps` × `framerate` (default 1) |
| Game API | `GetSpriteSequenceIndex`/`GetSpriteSequenceDuration(modelName, frame)` | `GetSequenceIndex`/`GetSequenceDuration(modelName, sequence)` |

SPR keeps `frame` because it is not a sequence selector there. id1 steps `frame` through
`progs/s_explod.spr` with a state machine (`Weapons.ts`, `s_explode1`...), exactly like Quake's
QuakeC. Moving that to `sequence` would change a game's logic for an engine change. An SPR has no
named sequences: `GetSequenceIndex` returns −1 for it, and `GetSequenceDuration(spr, n)` answers
for the SPR frame or group that `frame = n` selects. The `SpriteModel` decides which field
selects its entry, so the renderer does not branch per format.

No game code has to change. Nothing in id1 or hellwave sets `frame` to pick an image-sprite
sequence (`gfx/fire.gif` in id1's `Misc.ts` plays the default sequence 0), and nothing calls the
`GetSpriteSequence*` methods. What changes is the engine (`ClientEdict`, `SpriteModelRenderer`,
`SpriteSidecar`, the engine APIs), `docs/sprites.md` (the `phase`, `sequences` and query rows,
and the `this.frame = ...` example), `docs/client-entities.md`, and the sprite tests. The HUD
`SpritePlayback.play(sequence)` already uses this vocabulary and stays as it is.

The studio renderer reads `animtime` the same way, so restart and resume work for every client.

Transport options (decision for Phase 0; the piggy-back option from the first draft is dropped, it
cannot restart or resume):

1. **Engine-typed state + protocol bump (recommended).** Add a sequence block (`sequence`,
   `animtime`, `framerate`, shared with sprites) and a studio block to `Protocol.EntityState`,
   `ServerEntityState` and `ClientEdict`, delta-compressed, each gated by one new bit. All 16 bits of
   `u` are used, so widen the flag word (`writeUint16` → `writeUint32`, or a "more flags" byte) as
   part of the version bump to 44. The server reads the fields from optional members of the game
   entity, so existing games that never set them send nothing. Works for baselines, static entities
   and the viewmodel, and gives the renderer a typed contract. Costs: protocol/doc/test updates
   (`test/common/protocol.test.ts`, `test/common/msg.test.ts`, `docs/`), demo compatibility.
2. **Game-declared extended fields (existing channel, no engine protocol change).** The game
   declares `sequence`, `animtime`, … in `clientEntityFields` for its classes and the renderer reads
   `ClientEdict.extended`. Zero wire work, but the field names become an implicit engine contract,
   values are untyped, it is per-classname, and it does not reach entities without one. Reasonable
   as a stopgap or for game-specific extras; not as the engine's studio contract.
3. **Hybrid.** Option 1 for the standard studio block, option 2 stays available to games for
   anything else.

Interaction with [client-entity-architecture.md](client-entity-architecture.md): that plan's
`ClientEdict` work is finished. The new studio fields go on top of it. Client-owned persistent
entities save through `ClientEntities.serialize()` (`SerializedClientEntity`,
[ClientEntities.ts:47](../source/engine/client/ClientEntities.ts#L47)), and server entities save
through `ServerSavegame.ts`. The wire encoding comes last.

Game-facing API (additions to the public engine API, JSDoc'd, mirrored in
`source/shared/GameInterfaces.ts` and `docs/game-module-contract.md`). **All additive and
optional**; `BaseEntity` members for the studio state are optional so existing games still satisfy
the interface:

- generic sequence lookups on both `ServerEngineAPI` and `ClientEngineAPI` (decided 2026-10-23):
  `GetSequenceIndex(modelName, name): number` (−1 when the model has no such sequence) and
  `GetSequenceDuration(modelName, sequence): number` (0 for a model without sequences). They
  answer for sprites and studio models alike, replacing `GetSpriteSequenceIndex` and
  `GetSpriteSequenceDuration`. Each model class answers for itself (a `BaseModel` method that
  sprite and studio models override), so the API does not branch per format and a future
  sequenced format plugs in the same way. This resolves names the way `ParsedQC.frames` does for
  alias models, so game code does not hardcode indices. (The first draft had
  `GetStudioSequences(model)` and `FindSequence(model, name)`.)
- optional entity fields `sequence`, `animtime`, `framerate`, `body`, `blending`, `controller`;
- `ViewmodelConfig` ([GameInterfaces.ts:84](../source/shared/GameInterfaces.ts#L84), today
  `visible`, `model`, `frame`) gains optional `sequence`, `animtime`, `framerate`, `body` (alias
  models keep using `frame`);
- animation events (muzzle flash, footstep sound) exposed as data on the sequence; firing them is a
  game decision.

### F. Collision and bounds

- Studio entities are plain AABB entities: the game sets the size (`setSize`/`setModel` bounds),
  the area tree and `SV_Move` need no changes.
- `BaseModel.mins/maxs` are seeded from the header so `Edict.setModel()` has sensible defaults;
  the game overrides them as needed.
- A `SOLID_MESH` entity whose model the collision code cannot trace already falls back to
  `HullCollisionState` at every tracing call site (see Context, re-checked 2026-10-23), so a studio
  model on such an entity traces as its box with no change. A unit test pins this in Phase 1
  (`test/physics/`, a `SOLID_MESH` entity with a studio model traces as its hull).
- Non-goal for now: triangle or hitbox collision. A future extension may hand hitboxes (parsed at
  load time anyway) to a physics engine; it must go through the existing trace API.

## Phasing

Stop at each boundary for a go-ahead and record what shipped here (`plan-first-workflow`).

**Prerequisites (outside this plan):** `ClientEdict` work from client-entity-architecture
finished (✅); `R.DrawViewModel` hands its projection to any renderer's program (open, needed by
Phase 3's viewmodel only); `SOLID_MESH` hull fallback (✅, already there).

**Phase S: sequence state for sprites (proposed: ships ahead of Phase 1, independent of the
studio format).** Rename the queries to `GetSequenceIndex`/`GetSequenceDuration` on both engine
APIs, `GameInterfaces.ts` and `docs/game-module-contract.md`. Add `sequence`, `animtime` and
`framerate` to `ClientEdict`, the optional game-entity members, the sequence block on the wire
(protocol 44, flag word widened), baselines, static entities, both savegame paths and client-owned
entities. Switch image sprites from `frame` to `sequence`/`animtime`, remove
`animationStartTime`, and update `docs/sprites.md`, `docs/client-entities.md` and the sprite tests.
*Tests: protocol round trip of the block, a late joiner sees the server's `animtime`, a save and
load resumes mid-sequence, SPR `frame` stepping unchanged, the renamed queries.* *Verification:
real browser (`browser-ui-verification`): id1's explosion (SPR via `frame`), `gfx/fire.gif`
(default sequence), and one sidecar sequence restarted and resumed.* *Exit: sprites run on the
shared sequence state and nothing visible changed for existing content.* This phase does the
transport work for E early. Phase 5 then only adds the studio block, with a second bump unless the
widened flag word leaves room for it in 44.

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
temporary client-only state is fine until the wire format lands). Finish making
`R.DrawViewModel` renderer-agnostic (can ship earlier, independently). Add
`viewseq`/`viewbody` console commands next to `viewframe` in
[ClientHost.ts:272](../source/engine/client/ClientHost.ts#L272) (`Viewframe_f`; the target entity
is described in `ServerController.ts`) for a model viewer. *Verification: real
browser, per `browser-ui-verification` (visual comparison against FTE's render of the same model
and pose). Headless can verify rendering, not input.* *Exit: an animated model is visible, lit,
and shadowed.*

**Phase 4: render polish.** Chrome, additive, flatshade, masked correctness, transparency pass,
player colour remap if wanted, LOD for far entities (skip bone recompute when culled).

**Phase 5: game integration.** Studio block transport per E (the sequence block shipped in
Phase S), game API for body, `ViewmodelConfig` studio fields, savegame state (restart/resume must round-trip),
attachment points, animation events.

## Testing

- Engine tests under `test/common/` (loader, animator) and `test/renderer/` (renderer/GL-mocked
  pieces), files named per `unit-tests.instructions.md`: `studio-mdl-loader.test.ts`,
  `studio-animation.test.ts`, `studio-model-renderer.test.ts`. All are TypeScript and
  type-checked by `npm run typecheck`. They sit in existing directories, so no new test-glob depth
  (`test/common/test-globs.test.ts` would catch it if that changed). Load the
  `writing-engine-tests` skill first, for the fixture factories and the GL mocks.
- The synthetic model builder lives in `test/support/` (a typed builder, like the other factories
  there), so no binary fixture and no Dockerfile `COPY` is required (`dockerfile-fixture-sync` not
  triggered). If a real model fixture is ever committed, re-check that skill.
- `npm run typecheck`, `npx eslint --fix` on every touched file.
- Shaders: `test/renderer/shader-library.test.ts` expands every program and, with `glslangValidator`
  on `PATH`, compiles and links it (`shader-chunks` skill). It checks the link, not the look, so
  browser verification is still the gate for Phases 3-4.
- `docs/events.md` untouched unless a phase adds an `eventBus` event (`event-bus-docs-sync`).

## Open questions

Settled (see Decisions): v10 only and no FTE extensions, protocol bump allowed (now to 44), AABB
collision (no hull-fallback work needed), restart/resume required, CPU skinning first, `ClientEdict`
work finished, `animtime` is absolute server time, filename case (`COM` lower-cases every name),
generic `GetSequenceIndex`/`GetSequenceDuration` for every format with sequences, `sequence` and
`animtime` select and start a sequence for sprites too (SPR keeps `frame`).

1. **Transport (E).** Option 1 (typed engine state, protocol 44) vs. option 3 (hybrid). Recommended:
   1. The sequence block must be engine-typed in any case, because sprites appear on entities
      without a classname (static entities, client-only entities). Still open: widen the flag
      word or add a "more flags" byte? And should Phase S ship ahead as proposed?
2. **Where should the GL-free animator live?** `source/engine/common/model/` (recommended: it is
   model-format code and the server will want it) vs. `source/shared/` (if games should import it
   directly, e.g. for client-side prediction of attachment points).
3. **Test assets.** Is there a model you can legally use for local verification and, if so, may a
   tiny one be committed to `data/` (would then need the Dockerfile `COPY` and `.dockerignore`
   check)? Otherwise synthetic-only.
4. **Sequence transitions and events.** Engine-provided blend-from-previous (client lerp state) or
   leave to game code entirely?
5. ~~Which entity field selects the sequence?~~ Decided 2026-10-23: `sequence` for every sequenced
   format, sprites upgraded (see Decisions and E).

## Risks

- **Shared shader chunks.** `studio.*` includes the same chunks as `alias.*`/`mesh.*`, so moving a
  routine out of `alias.frag` into a chunk for studio's sake changes the alias program too. That
  needs the `shader-chunks` before/after screenshot pair. CPU skinning avoids extra skinned shadow
  shaders.
- **CPU skinning cost** with many animated entities; mitigated by skipping culled entities and
  caching the skinned buffer per (sequence, frame, blend, controllers). GPU skinning is the escape
  hatch.
- **Protocol bump** touches baselines, deltas, demos and docs; keep it to one phase.
- **Sprite regression in Phase S.** Shipped sprite behavior changes under content that works today
  (`phase: spawn` timing, sidecar `sequences`). The browser check of id1's explosion, `fire.gif`
  and a sidecar sequence is the gate, and the sprite tests are rewritten, not deleted.
- **Format edge cases** (sequence groups, negative strip counts for fans, 0-offset textures,
  controller wrap) are where hand-written loaders break; the FTE source is the oracle, which is
  why Phase 0 and Phase 2 insist on cross-checking against it.

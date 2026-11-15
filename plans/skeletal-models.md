# Skeletal models: IQM, tags and attachments

## Status

📝 Draft, nothing implemented, no open questions left (all settled 2026-11-13; quaternion handling
added 2026-11-14, decisions 19–21). Phase 0 done on 2026-11-15 (results below). Next: Phase 1.
Reworked on 2026-11-12 from `plans/half-life-studio-models.md` (renamed to this file). The
format-neutral decisions of that plan carry over. **The focus is IQM.** Half-Life studio models are
parked: the core only has to leave room for them (Later: Half-Life studio models).

### Phase 0 results (2026-11-15)

Done (no FTE needed):

- **Gun on the back, confirmed.** Frame 1 of `player.mdl.blend` rendered from the side (headless
  Blender 5.3, workbench): the player holds the axe and the built-in gun is slung diagonally across the
  back. `playergun` sits at about (−4, 7, 19) and `playeraxe` at about (9.5, −1, 3) in frame 1. Hellwave's
  "last gun on the back" comes from the rig, no `tag_holster` needed (K). Frame 60 is a lying pose
  (death), the groups are far from their frame-1 places there, as expected.
- **Palette ranges.** Quake's shirt is palette row 1 (indices 16–31) and pants is row 6 (96–111): the
  engine's skin translation ([AliasMDLLoader.ts:469-492](../source/engine/common/model/loaders/AliasMDLLoader.ts#L469-L492))
  writes `(index & 15) * 17` into a mask channel for each. The `--colormap` exporter option (J) splits on
  those two rows.
- **DarkPlaces masks** (`gl_rmain.c` `R_SkinFrame_LoadExternal`, `shader_glsl.h`, `cl_main.c`, read from
  `DarkPlacesEngine/darkplaces` master): the companion textures are `<skin basename>_pants` and
  `<skin basename>_shirt`, loaded beside the base texture, greyscale. The shader **adds** them:
  `color.rgb += pants.rgb * Color_Pants + shirt.rgb * Color_Shirt`, so the base texture must have the
  colorable pixels removed (DarkPlaces' own comment: "original texture without pants/shirt/glow").
  Colors come from 16-entry tables indexed by the nibbles of the colors byte: shirt = high nibble, pants
  = low nibble (`CL_SetEntityColormapColors`). Table entry `i` is palette row `i` at column `0x0C`
  (`0x04` for rows 8–13), scaled by 1/255. This differs from our `player.frag`, which **mixes** by mask
  and scales by intensity, so the IQM path needs its own composition (Phase 4), not a copy of
  `player.frag`. The `--colormap` exporter option must therefore write a base texture with those pixels
  blanked, not just two extra masks.
- **DarkPlaces `.skin` files** (`Mod_LoadSkinFiles`): `<model name with extension>_<n>.skin`, for example
  `models/x.iqm_0.skin`, n from 0 up to 255, stops at the first missing number, and the number of files
  becomes the skin count. One mapping per line, `meshname,texture` (the comma is its own token), plus
  `replace meshname texture`. Lines starting with `tag_` are accepted and ignored. Parsed with the
  QuakeC tokenizer, so `//` comments work. FTE also tries the name without the extension (B).
- **DarkPlaces `setattachment`** (`cl_main.c` `CL_UpdateNetworkEntity`): the child's matrix is
  `parentMatrix × tagMatrix × childLocalMatrix`. `tagindex` is **1-based** on the wire, 0 means "attach to
  the entity origin"; an invalid index falls back to the parent's origin. The parent is updated first
  (recursion limit), so chains work. The child **inherits the parent's exterior-model and view-model
  flags**, and it is skipped when the parent is missing or inactive: the same visibility rule as decision
  15. The parent matrix is the render matrix, which already holds interpolation and the predicted
  origin. Pitch is negated for alias-type models only (IQM is one in DarkPlaces), per entity on its own
  angles, which is the per-renderer convention H already asks for.

- **Throwaway IQM export, checked without FTE** (decided 2026-11-15: no FTE binary on this machine, and
  a GPU run was not worth it). A spike exporter wrote `player.iqm` (v2, 25 joints, 143 frames, 10 channels
  quantized to `ushort`) and an independent Python reader decoded it the way FTE's
  `Mod_ParseIQMMeshModel` does, skinned all vertices on the CPU and compared them with Blender's evaluated
  mesh at frames 1, 20, 60, 100 and 143: **max error 0.012 units** (16-bit quantization), mean 0.001. The
  union of the per-frame bounds equals the `player.mdl` header's min and max exactly
  (−44.176, −34.474, −35.065 to 39.220, 30.344, 48.474), so **the IQM needs no axis or unit conversion**
  and uses the MDL's coordinate system. This is the acceptance check Phase 3 repeats in TypeScript.
  FTE's own parser (2026-07-13 build, dedicated server) also accepts the file: with `player.iqm` overlaid
  on twelve item models in `lq_e1m1` the server logs no load error, while a truncated copy logs
  `size (156252 != 100000)` and `Unable to load`. That is an acceptance check only, the server prints no
  bounds or counts. The look (winding, shading) is checked in FTE's GL client at the Phase 1 exit.
  The scripts are throwaway and not committed; Phase 1 writes the real exporter and its tests.
- **The `$frame` lines of `qcsrc/player.qc` name exactly 143 frames** and group into 20 prefixes
  (`axrun`, `stand`, `deathc`, …), which matches the scene range, so `--frames` (J) works on them.
- **Traps the spike found** (all go into Phase 1):
  - The mesh object has a non-uniform **world scale of 1.2702 on X**. The exporter must bake the mesh's
    world matrix into positions, and use its inverse transpose for normals, or the model is 27% too thin.
  - The mesh is flat-shaded in Blender (`use_smooth` false), so one vertex per corner gives 2,133 IQM
    vertices for 539 source vertices, against 801 in the MDL (which carries one normal per vertex, so it
    looks smooth). The exporter needs a normals mode (smooth by default for these models) and the
    comparison with the MDL's look is a Phase 4 screenshot check.
  - Top-4 weight pruning dropped nothing for the player (3 influences at most), as the survey said.
  - **Winding is unverified.** FTE copies IQM triangle indices verbatim and the exporter wrote Blender's
    counter-clockwise order, which agrees with the exported normals for 99.9% of triangles, but only a
    render shows whether the format's front face is counter-clockwise. Phase 2/4 pins it with the first
    drawn model.
  - IQM tools store rotations with `w <= 0`; FTE's v2 path reads `w` explicitly and does not depend on
    it, and neither must our loader (the shortest-path `slerpInto` handles either sign).
  - `ofs_adjacency` can be 0. Our loader must not require it.

Phase 0 is complete apart from this plan's go-ahead to start Phase 1.

### Decisions (2026-11-12, from the maintainer)

1. **IQM first.** It is the first skeletal format. Half-Life `IDST` v10 follows later as a second
   loader on the same core.
2. **Tags and attachments are part of this plan**, as a later phase, so the plan is feature
   complete. Attachment is a **general entity feature**, not a player-only weapon slot. It works for
   networked entities and for client-only entities (muzzle flash sprites, effects).
3. **IQM view weapons** are a later phase, after the world-model path works.
4. **Hellwave shows the gun on the back while the axe is in use** (the last gun used, for now).
5. **The Blender exporter is a general tool in `quakeshack/tools`** (the `qs-tools` repository),
   not part of a game.

### Decisions (2026-11-13, from the maintainer)

6. **Adopt existing standards before inventing our own.** Where another Quake-family engine already
   has a convention (DarkPlaces, FTE, Quake 3), use it. First case: player colors on truecolor
   skins use `_shirt`/`_pants` mask textures (B).
7. **The entity update flag word becomes 32 bits** in the first protocol bump of this plan. The
   two extra bytes per updated entity are acceptable (E).
8. **id1's `weaponConfig` gets an optional player-held model field** (K).
9. **A small IQM made from LibreQuake assets may be committed to `data/`** for end-to-end tests,
   with the Dockerfile `COPY` (`dockerfile-fixture-sync`) (Testing).

### Decisions (2026-11-13, second round: the former open questions)

10. **One `ModelType.skeletal`** with per-format subclasses (A).
11. **IQM v2 only**, v1 is skipped (B).
12. **Materials resolve like OBJ materials, with `.qsmat` support** (B).
13. **`sequence = -1` means "no sequence"** and is the default, so `frame` drives the model until
    the game picks a sequence (E).
14. **Attachments behave like DarkPlaces' `setattachment`**: while attached, the child's own `origin`
    and `angles` are an offset in tag space (H).
15. **An attached child is visible exactly when its parent is**, for now (H).
16. **Protocol versions are bumped as needed.** Server and client are always released together, so
    there is no compatibility to keep and no coordination between phases: a phase that changes the
    wire bumps the version (E).
17. **The exporter supports what the LibreQuake files need now**: Blender 5.x (the survey used 5.3),
    and only the rig features those files use (J).
18. **Focus on IQM.** Half-Life studio models stay in mind but get no work in this pass.

### Decisions (2026-11-14, from the maintainer)

19. **Rotations stay quaternions internally.** Poses, tags and attachment chains interpolate and
    compose as quaternions. Euler angles appear only where they already are the interface: an
    entity's own `angles`, and the game API (`GetEntityTag`'s `outAngles`). No Euler round trip
    inside the animation, tag or attachment code (C, G, H).
20. **One home for quaternion maths**: allocation-free static helpers on `Quaternion` in
    `source/shared/Vector.ts`, working on flat arrays with offsets. The existing object methods
    (`Quaternion.slerp`, …) delegate to them, so there is one implementation (C).
21. **One quaternion layout: `[w, x, y, z]`**, the order `Quaternion` already uses. Every flat array
    that holds rotations uses it too. Formats that store another order (IQM: `x, y, z, w`) are
    reordered once, in their loader (B, C).

### Decisions carried over from the Half-Life plan (2026-10-03 and 2026-10-23)

- **The protocol may be bumped** (see decision 16). It is still at 43 (`Protocol.ts:3`).
- **Collision: entity AABBs.** No hitbox or triangle collision in this plan (F).
- **Restart and resume.** A game must be able to restart a sequence and resume it partway through
  (after a savegame load, for a late joiner). `animtime` is an absolute server time (E).
- **Skinning: whatever is easiest, performs well and runs everywhere**, so CPU skinning first (D).
- **Generic sequence queries.** `GetSequenceIndex(modelName, name)` and
  `GetSequenceDuration(modelName, sequence)` on both engine APIs, answering for every sequenced
  format. They replace `GetSpriteSequenceIndex`/`GetSpriteSequenceDuration` without aliases (E).
- **`sequence` selects a sequence for every sequenced format**, sprites included; Quake and
  Half-Life SPR keep `frame` (E, Phase S).
- **`R.DrawViewModel` must become renderer-agnostic.** Still open on 2026-11-12: it binds the
  `alias` program and uploads the narrow projection only to it
  ([R.ts:141-143](../source/engine/client/R.ts#L141-L143)). Needed by Phase 8.

## Context

### Why IQM first (measured 2026-11-12)

The LibreQuake sources (`/home/cr/Work/quakeshack/LibreQuake/lq1/progs/src/*.blend`, BSD-3 for
models, textures and sounds per `docs/README-IMPORTANT-LICENCE-INFO`) were opened in headless
Blender 5.3. Every monster and the player is rigged, and every rig blends several bones per vertex:

| Model | Bones | Most bones influencing one vertex |
|---|---|---|
| player | 25 | 3 |
| soldier, knight, enforcer, demon, dog, zombie, spawn, ogre, hknight | 30–70 | 4–8 |
| wizard, oldone | 45, 100 | 11, 13 |
| shambler | 468 | 7 |
| `v_axe`, `v_nail2` | 2 | 2 |
| flames, `h_shams`, most `v_*` | shape keys, no rig | – |

- **Half-Life studio models allow one bone per vertex.** Every rig above would have to be reworked
  or would show stiff joints. IQM allows four, so the exporter keeps the four strongest weights and
  rescales them to sum to one.
- **The `.blend` files are the source.** IQM is written straight from Blender. Half-Life needs SMD
  export plus Valve's `studiomdl`.
- **IQM joints are named,** so they are tags as they are, and MD3 is not needed for tags.
- **Most of the Half-Life plan's core does not depend on the format**: the GL-free animator, CPU
  skinning, sequence state and queries, the protocol changes.
- **Shape-key models stay MDL.** IQM has no morph targets.

### The LibreQuake player rig (measured 2026-11-12)

- One armature (`Armature`) with 25 bones, one mesh (`player`, 539 vertices, 775 faces), one
  action keyed over 0–144 and a scene range of 1–143 (143 frames, the same count as `player.mdl`), skin `player.mdl.0.png`. No timeline markers, so frame names come from
  elsewhere (the `$frame` lines in LibreQuake's `qcsrc`, see J).
- Three bones exist for equipment only: `playergun` and `playeraxe` are **root bones** keyed per
  frame, and `flash` is a child of `playergun`. They have no constraints.
- Vertex groups: 59 vertices on `playergun` only (the built-in gun), 29 on `playeraxe` only, 29 on
  `flash` only (a mesh muzzle flash). Each piece can be cut out by its group alone.
- `playergun` has a world scale of 0.8 in every sampled frame. Tags must be rigid, so the exporter
  orthonormalizes them and the scale goes into the attached weapon model (G).
- In frame 1 (an axe frame) `playergun` sits at about (−4, 7, 19), behind and above the torso. It
  looks like the gun is slung on the back during axe frames. **Not checked visually yet** (Phase 0).
  If so, Hellwave's "gun on the back" comes from the rig for free (K).
- Rest-pose bounds: the built-in gun spans y −51…−19 (about 32 units), barrel along −Y.

World models (`g_shot`, `g_nail`, `g_rock`, …) have no rig. The barrel lies along +X, about 32–46
units long, floating at z 23–37 (the pickup pose, since pickups rotate around their origin). Each
weapon needs a grip transform before it can be held (J).

### What exists today (verified in source 2026-11-12)

- **Loaders** are picked by extension plus magic
  ([ModelLoader.ts](../source/engine/common/model/ModelLoader.ts)) and registered in
  [Mod.ts:134-140](../source/engine/common/Mod.ts#L134-L140) (BSP38, BSP2, BSP29, alias MDL, SPR,
  image sprites, OBJ). `ModelType` is `brush | sprite | alias | mesh`
  ([Mod.ts:17-22](../source/engine/common/Mod.ts#L17-L22)). Loaders read files through
  `ModelLoadContext.files` and skip render data when `context.loadRenderData` is false (server
  realm). [server-model-memory.md](server-model-memory.md) measured about a 22x memory blow-up for
  per-vertex objects, so new model data is stored in flat typed arrays.
- **`MeshModel` has unused stubs** `animations`, `bones` and `submeshes` "for future IQM or glTF
  support" ([MeshModel.ts:80-92](../source/engine/common/model/MeshModel.ts#L80-L92)). This plan
  gives IQM its own class (A), so Phase 2 removes the stubs if nothing reads them.
- **Renderers** are strategies per model class
  ([ModelRendererRegistry.ts](../source/engine/client/renderer/models/ModelRendererRegistry.ts)).
  [MeshModelRenderer.ts](../source/engine/client/renderer/models/MeshModelRenderer.ts) draws an
  already-posed buffer and shadows it through `shadow-brush`/`shadow-point`, which is what a
  CPU-skinned pose needs.
  [AliasModelRenderer.ts](../source/engine/client/renderer/models/AliasModelRenderer.ts) is the
  template for lighting, the player (colormap) shader choice and the transparent pass. It turns frame
  interpolation off while `EF_MUZZLEFLASH` is set (lines 158, 225, 275).
- **Interpolation is computed when read.** `ClientEdict.lerp.frame` returns
  `[previous, next, fraction]`, and `lerp.origin`/`lerp.angles` are getters evaluated against
  `renderTime` on every access
  ([ClientEntities.ts:287-320](../source/engine/client/ClientEntities.ts#L287-L320)). A tag has to
  be sampled with the same `[previous, next, fraction]` as the vertices, or the weapon drifts off the
  hand.
- **Visible entities** are gathered in `ClientEntities.emit()` into `visedicts`. The view entity is
  skipped unless the chase camera is on
  ([ClientEntities.ts:1145](../source/engine/client/ClientEntities.ts#L1145)), and the local player
  uses its predicted origin (:1130-1136). An attached child has to follow both rules.
- **Entity state on the wire**: `Protocol.EntityState` has `frame`, `modelindex`, `colormap`,
  `skinnum`, `effects`, `alpha`, `origin`, `angles`
  ([Protocol.ts:195](../source/engine/network/Protocol.ts#L195)). The update flag word `u` uses all
  16 bits ([Protocol.ts:8-25](../source/engine/network/Protocol.ts#L8-L25)). Games also have the
  untyped per-classname `clientEntityFields` channel (`ClientEdict.extended`).
- **Phase S of the old plan has not shipped**: `GetSpriteSequenceIndex`/`GetSpriteSequenceDuration`
  are still on both APIs ([ServerEngineAPI.ts:519-532](../source/engine/server/ServerEngineAPI.ts#L519-L532),
  [ClientEngineAPI.ts:501-513](../source/engine/client/ClientEngineAPI.ts#L501-L513)), and
  `ClientEdict.animationStartTime` still exists
  ([ClientEntities.ts:160](../source/engine/client/ClientEntities.ts#L160)).
- **Nothing attaches or follows.** No tag API, no attachment field, no `MOVETYPE_FOLLOW`.
- **Muzzle flash**: `EF_MUZZLEFLASH` makes a dynamic light 20 units forward and 16 up from the
  entity origin ([ClientLegacy.ts:31-42](../source/engine/client/ClientLegacy.ts#L31-L42)). The
  server clears the bit after one frame
  ([ServerMessages.ts:996](../source/engine/server/ServerMessages.ts#L996)).
- **Effects available to games**: `ClientEngineAPI.AllocDlight`, `AllocEntity` (client-only
  entities, persistent or static), `RocketTrail`, `PlaceDecal`
  ([ClientEngineAPI.ts:429-476](../source/engine/client/ClientEngineAPI.ts#L429-L476)). Sprites
  support additive blending and camera-facing or fixed orientation
  ([SpriteTypes.ts](../source/engine/common/model/sprite/SpriteTypes.ts)). `Particles.ts` only has
  Quake's fixed effects (explosions, trails, splashes); no game-defined particles.
- **id1's weapon table** maps each weapon to `ammoSlot`, `viewModel`, `items`, `priority`
  ([id1 Weapons.ts:76-85](../source/game/id1/entity/Weapons.ts#L76-L85)). `Player.weaponmodel` is
  the view model's name. Hellwave builds on id1's entities.

### The IQM format (checked against FTE's structs)

FTE's [com_mesh.c:7862-7990](/home/cr/Work/private/fteqw/engine/common/com_mesh.c) defines (read
2026-11-12): magic `INTERQUAKEMODEL\0`, versions 1 and 2. The header holds counts and offsets for
text, meshes, vertex arrays, triangles (plus adjacency), joints, poses, anims, frames (with
`num_framechannels`), per-frame bounds, comment and extensions. Joints v2: name, parent, translate,
rotate (quaternion), scale. Poses v2: parent, channel mask, 10 channel offsets and scales. Frames
are `ushort` channel values. Anims: name, first frame, frame count, frame rate, flags (`IQM_LOOP`).
Vertex arrays are typed (position, texcoord, normal, tangent, blend indexes, blend weights, color,
custom) with a component format. Bounds: per-frame min/max, `xyradius`, `radius`. Meshes name a
material by string; textures are not in the file.

References: FTE `Mod_ParseIQMMeshModel` ([com_mesh.c:8364](/home/cr/Work/private/fteqw/engine/common/com_mesh.c)),
`Mod_GetTag` (:5284), and `setattachment` in `server/pr_cmds.c` and `client/pr_csqc.c` (the
DarkPlaces `DP_GFX_QUAKE3MODELTAGS` extension). The layout above is the source for Phase 2. The
loader's JSDoc records it with these references.

### Coordinate system

Quake: X forward, Y left, Z up, which is also Blender's Z-up frame. The LibreQuake models are
modeled in Quake units (the player's rest bounds match a Quake player). Phase 0 confirms that the
exported IQM needs no axis or unit conversion by loading it in FTE next to the MDL.

## Goals

1. Load IQM v2 models through the loader registry, on the client and the dedicated server.
2. Render them animated, lit, textured, colormapped (player colors) and shadowed in the existing
   passes, with CPU skinning.
3. Keep Quake-style frame-driven game code working: `frame` picks a pose and interpolates as it does
   for alias models. Named sequences go through the shared sequence state (Phase S).
4. Tags: any model can expose named, per-frame transforms, queryable on server and client.
5. Attachments: any entity, networked or client-only, can be attached to a tag of another entity.
6. A general Blender-to-IQM exporter in `qs-tools`, including the steps attachments need (cut out
   vertex groups, write tags, export a weapon in grip space).
7. Hellwave: weapons in the players' hands, the last gun on the back during melee, muzzle flashes at
   the barrel.
8. Later: IQM view weapons.

## Non-goals (this pass)

- **Replacing MDL.** Alias models keep working unchanged; shape-key models stay MDL.
- **IQM v1.** Current exporters write v2.
- **Half-Life studio models.** Parked; the core leaves room for them.
- **GPU skinning**, unless profiling demands it (D).
- **Splitting the player into legs, torso and head** (Quake 3 style). The LibreQuake animations
  cover the whole body.
- **Hitbox or triangle collision.**
- **Effects on attached models** (glows, sparks, fumes). They get their own plan; this plan only
  makes sure they are possible (L).
- **Half-Life maps, WADs, sounds, Source-engine models.** As in the old plan.
- **Shipping Valve assets.** Tests use synthetic models; real Half-Life models stay local.

## Design

### A. Data model: `SkeletalModel` and per-format subclasses

New abstract `source/engine/common/model/SkeletalModel.ts`, `extends BaseModel`,
`ModelType.skeletal = 4`. It holds what every skeletal format shares, in flat typed arrays, and is
immutable after loading (so `createScopedView()` shares it):

- joints: names, parent indices (parents before children, checked at load), inverse bind matrices;
- skinned mesh data (client only): positions, normals, texture coordinates, 4 blend indexes and 4
  weights per vertex, triangle indices, mesh ranges with a material each;
- materials (name, textures created client-side);
- sequences: name, first frame, frame count, frame rate, loop flag;
- per-frame bounds and their union.

Subclasses fill it in and answer `samplePose(selection, outLocalJointPoses)`. `IQMModel` (B) is the
only one in this pass. The split exists so that a later format (a Half-Life `StudioModel`) can add
its own extras on its subclass and reuse the renderer and tags; nothing is built for it now.

### B. Loader: `IQMLoader`

New `source/engine/common/model/loaders/IQMLoader.ts`, extension `.iqm`, magic `INTERQUAKEMODEL`.

- **Version 2 only**, a clear error for anything else (decided 2026-11-13).
- **Untrusted input.** Every count and offset is bounds-checked against the buffer before reading.
  Failures throw `CorruptedResourceError`. Fuzz-style tests: truncated file, offset past the end,
  joint parent after child or a cycle, huge counts, blend index past the joint count.
- **Frames** are decoded once into local joint poses (translation, rotation quaternion, scale) per
  frame, as a flat `Float32Array`. Player: 25 joints × 143 frames × 10 floats = 35,750 floats.
  Layout per joint: translation `x, y, z`, rotation `w, x, y, z`, scale `x, y, z` (decision 21).
  IQM stores rotations as `x, y, z, w` (w is channel 6, FTE `com_mesh.c:8702-8705`), so the loader
  reorders them and normalizes them here, once. A fixture with a known non-symmetric rotation pins
  the order: a swapped w still decodes to a valid rotation, only the wrong one.
- **Server realm** (`loadRenderData === false`): keep joints, decoded frames, sequences and bounds
  (needed for tags and `setModel()` bounds), drop vertex arrays and materials.
- **Materials**: a mesh's material string resolves to a texture the way OBJ/`MeshModel` materials do
  today, and a `.qsmat` for that material applies when present (`docs/qsmat-format.md`, decided
  2026-11-13). Phase 2 reads the OBJ path and reuses it rather than writing a second resolver.
- **Player colors**: for a colormapped entity, shirt and pants masks come from companion textures
  `<material>_shirt` and `<material>_pants` (DarkPlaces' convention, which FTE also loads in
  `gl_shader.c`), recolored in the shader the way the alias player program does (decided
  2026-11-13). Phase 0 reads how DarkPlaces applies the masks and copies its behavior.
- **Skins** (`skinnum`), following decision 6: DarkPlaces' `.skin` files, `<model>_<n>.skin` per
  skin number (FTE also accepts the name without the `.iqm` extension, `com_mesh.c:3358`). Each
  maps mesh names to textures. Without one, skin 0 is the materials in the file. Phase 0 reads
  DarkPlaces' parser for the exact syntax.

### C. Animation core: `SkeletalAnimation` (GL-free)

New `source/engine/common/model/SkeletalAnimation.ts`, a static class. Input: the model, a pose
selection `{frameA, frameB, blend}` (from `lerp.frame` or from sequence playback). Output: model-space
joint matrices (3×4) and skinning matrices (joint × inverse bind) in caller-owned `Float32Array`s.

- interpolation: translation and scale lerp, rotation through `Quaternion.slerpInto` (below);
- parent-before-child composition in one pass, as 3×4 matrices: IQM joints may carry non-uniform
  scale, which translation-plus-quaternion composition cannot represent;
- no allocation per call: scratch buffers per model.

It lives in `common/model/` (it is format code, and the server uses it for tags). If games ever need
pose maths themselves, it moves to `source/shared/`.

**Quaternion helpers** (decisions 19–21). `Quaternion` in
[Vector.ts:37-202](../source/shared/Vector.ts#L37-L202) already has a tested shortest-path `slerp`
with an nlerp fallback above a dot of 0.9995, `normalize`, `multiply`, and conversions to and from
Euler angles. Every one of them allocates or works on `Quaternion` objects (an `Array` subclass), and
`slerp` creates three objects per call. At 25–468 joints per entity per frame that is too much
garbage. Phase 3 adds static helpers that read and write flat arrays at an offset, all `[w, x, y, z]`:

- `slerpInto(out, outOffset, from, fromOffset, to, toOffset, t)`: shortest path, nlerp fallback;
  expects normalized input (the loader normalizes once) and does not normalize its inputs again;
- `multiplyInto(...)`, `normalizeAt(...)`, `toMatrix3x4Into(...)` (rotation, translation and scale
  into a 3×4 matrix);
- `fromModelAnglesInto(out, outOffset, angles)`: an entity's angles in the convention its renderer
  uses. `Vector.toRotationMatrix()` (which every model renderer uses) negates pitch, Quake's model
  convention, while `Vector.toQuaternion()` does not (it matches `angleVectors`, the view
  convention). The helper follows `toRotationMatrix()`, and a test pins that both give the same
  matrix for a pitched, yawed and rolled entity.

The object methods (`Quaternion.slerp`, `multiply`, `normalize`) become thin wrappers over these,
so there is one implementation and the existing tests in `test/common/vector.test.ts` keep covering
it. While there, `toRotationMatrix()`'s JSDoc says "[roll, pitch, yaw]" but the code reads
`[pitch, yaw, roll]`; the JSDoc gets fixed.

Skinning and tags use the same `slerpInto`, so tags and vertices interpolate identically (Risks).

### D. Rendering: `SkeletalModelRenderer`

New `source/engine/client/renderer/models/SkeletalModelRenderer.ts`, registered beside the others.

- **CPU skinning** with up to four weights into a streamed vertex buffer per entity. The result is
  cached per entity per frame, so the shadow and reflection passes reuse it, and culled entities are
  never skinned. The largest LibreQuake mesh is the shambler (4,849 vertices); the rest are 130–580.
  GPU skinning only if `r_speeds`/`r_bench` show it is needed (`docs/frame-profiling.md`). The
  shambler's 468 bones would not fit a uniform array; the exporter writes deforming bones and tags
  only, which may shrink that.
- **Program**: start from `mesh` and add what is missing (luminance layer, alpha test, colormap) as
  shader chunks (`shader-chunks` skill, before/after screenshots when a chunk moves out of
  `alias.frag`). A separate `skeletal` program only if `mesh` cannot take it.
- **Lighting** through `EntityLighting.CalculateLightValues()`, as the alias and mesh renderers do.
- **Culling** with the union of the per-frame bounds, through the same `Camera.CullBox` path.
- **Shadows** through `shadow-brush`/`shadow-point` with the skinned buffer, like `MeshModelRenderer`.
- **`EF_MUZZLEFLASH`** turns interpolation off, as for alias models.

### E. Entity state, protocol, game API

**Frame-driven first, no protocol change.** For IQM, `frame` is a global frame index and
`lerp.frame` interpolates it. The exporter writes frames in the MDL's order (J), so frame-driven code
like id1's player and monsters works unchanged with an `.iqm` in place of the `.mdl`. Phases 2–4
need no wire changes.

**Sequence state (Phase S)** is unchanged from the old plan: `sequence`, `animtime` and `framerate`
are the selection state of every sequenced model (image sprites and IQM). The
client plays back at `(renderTime − animtime) × framerate × sequence.fps`, looping or clamping per
the loop flag. Restart: the game sets `animtime = now`. Resume: `animtime = now − elapsed`. Saves store
`sv.server.time` and restore it, so an absolute `animtime` survives save and load. A level change
resets the clock to 1.0, so a game that carries an entity across levels re-bases it. On sprites,
`sequence` replaces `frame` as the selector for image sprites. SPR keeps `frame` because it is the
image index there. `animationStartTime` is removed. No game code has to change (nothing in id1 or
Hellwave picks an image-sprite sequence through `frame` or calls the `GetSpriteSequence*` methods).

Transport: an engine-typed sequence block on `Protocol.EntityState`, `ServerEntityState` and
`ClientEdict`, gated by one new bit. The flag word grows from 16 to 32 bits (`writeUint16` →
`writeUint32` in `ServerMessages.ts`, the matching read on the client; decided 2026-11-13). The
first phase that needs a new bit (S or 6) widens the word; every phase that changes the wire bumps
`Protocol.ts`'s version on its own (decision 16). Engine-typed
because sprites and attachments also appear on entities without a classname (statics, client-only
entities), which `clientEntityFields` cannot reach.

**Which field wins** for a sequenced IQM model: `sequence` when it is 0 or more, `frame` when it is
−1, the default (decided 2026-11-13). The sequence block is sent only when it differs from the
default, so frame-driven entities cost nothing extra on the wire.

**Game API** (additive, JSDoc'd, mirrored in `source/shared/GameInterfaces.ts` and
`docs/game-module-contract.md`): `GetSequenceIndex`, `GetSequenceDuration` (Phase S); optional
entity fields `sequence`, `animtime`, `framerate`; tag and attachment calls (G, H).

### F. Collision and bounds

Skeletal entities are AABB entities. `setModel()` takes the union of the per-frame bounds as the
default, and the game overrides it with `setSize`. A `SOLID_MESH` entity whose model cannot be
traced already falls back to its hull at every trace call
(`_getEntityCollisionState` at
[ServerCollision.ts:115](../source/engine/server/physics/ServerCollision.ts#L115), with
`?? this._getHullFallbackState(...)` at :749 and :860, checked 2026-11-12); a test pins that for a
skeletal model.

### G. Tags

A tag is a named, rigid transform (origin and rotation quaternion) per frame, in model space.

- `BaseModel.getTagIndex(name): number` (−1 when missing) and
  `BaseModel.sampleTag(index, frameA, frameB, blend, out): boolean` (writes origin `x, y, z` and
  rotation `w, x, y, z` into a caller-owned 7-float array). The base class has no tags.
  `SkeletalModel` answers from its joints (each joint is a tag; translation lerps, rotation through
  `Quaternion.slerpInto`, the same call skinning uses). Alias models have none.
- **Available on both realms**, since the server keeps joints and frames (B). The server does not
  need tags yet; the API is there for later (projectile origins, hit effects).
- **Rigid**: tags carry no scale; the model-space rotation is a normalized quaternion, so there are
  no axes to orthonormalize. Scale belongs in the attached model
  (the 0.8 on `playergun` is baked into the `p_*` weapon models by the exporter, J).
- **Engine use**: the `EF_MUZZLEFLASH` light moves to `tag_flash` when the entity, or a child attached
  to it, has one, and keeps today's fixed offset otherwise.
- **Game API**: `GetTagIndex(modelName, tagName)` on both engine APIs. The client API also gets
  `GetEntityTag(entity, tagName, outOrigin, outAngles): boolean`, which answers for the current render
  time with interpolation and attachment chains applied. Effects need this (L). `outAngles` is the
  one place a tag rotation becomes Euler angles, because game code works in angles (decision 19).

### H. Attachments

An entity can be attached to a tag of another entity, the way DarkPlaces' `setattachment` works.

- **State**: `attachment = { parent: entity number, tag: tag index }` on `ServerEntityState`,
  `Protocol.EntityState` and `ClientEdict`, plus one flag bit (E's widened word). `parent = 0` means
  none.
- **Local offset, as in DarkPlaces** (decided 2026-11-13): while attached, the child's own `origin`
  and `angles` are its transform in tag space. That is how a game shifts a holstered gun without a
  new tag. FTE's DarkPlaces-compatible `CL_RotateAroundTag` (`client/cl_ents.c:2285`, read
  2026-11-13) composes it as parent origin and angles × tag × child offset, and builds the parent's
  axes with `AngleVectorsMesh` for alias models (Quake's inverted model pitch). Our composition must
  use the same angle convention the parent's renderer uses, or attachments tilt the wrong way when
  the parent pitches; a test pins it. Phase 0 checks DarkPlaces' own code for the same details.
- **Server API** (game entity, through `ServerEdict`): `setAttachment(parent, tagName)` and
  `clearAttachment()`. The engine stores the tag name, resolves the index against the parent's
  current model, and resolves it again when the parent's model changes. An unknown tag attaches to
  the parent's origin and logs once in developer mode.
- **Server rules**: an attached child is `SOLID_NOT` and does not move by itself (asserted in
  developer mode). It is sent whenever its parent is sent, whatever its own origin, so PVS and
  culling follow the parent. Freeing the parent detaches the child, and its last world position is
  kept, so a dropped weapon stays where it was.
- **Client resolution**, in quaternions (decision 19): after `emit()` collects `visedicts`, one pass
  resolves attached entities, parents first: the parent's interpolated origin and rotation (the
  predicted origin for the local player; the rotation from `Quaternion.fromModelAnglesInto`, or the
  parent's own resolved rotation when the parent is itself attached), times the parent's tag sampled
  with the parent's `lerp.frame`, times the child's local offset (its `origin`, and its `angles`
  converted once). The resolved origin and rotation quaternion are stored on the child for the
  frame. Chains are allowed (a flash sprite on a weapon on a player), with a depth limit and cycle
  detection.
- **Renderers read a rotation, not angles.** Today every model renderer builds its orientation with
  `entity.lerp.angles.toRotationMatrix()` (alias, mesh, brush), and the sprite renderer uses
  `entity.angles.angleVectors()`. A new `ClientEdict.lerp.rotationMatrix` returns that 3×3 matrix:
  from `lerp.angles` for a free entity, from the resolved quaternion for an attached one. The
  renderers, the shadow passes and reflections switch to it, so an attached child's rotation is never
  turned back into angles. `lerp.angles` of an attached child is not used for drawing; the two
  "is it rotated at all" checks (`ShadowMap.computeTopDownFootprint`,
  `BrushModelRenderer.getEntityScreenBounds`) get an attached-entity case.
- **Visibility always follows the parent** (decided 2026-11-13, as FTE does by giving the child the
  parent's key for visibility checks): a child is drawn only if its parent is, with no PVS check of
  its own. In particular, a child of the view entity is hidden in first person and shown with the
  chase camera.
- **Client-only entities** (`AllocEntity`) get the same `setAttachment(parent, tagName)` on
  `ClientEdict`, so a game's client code can attach sprites and effects without network traffic.

### I. View weapons as IQM (later phase)

- `R.DrawViewModel` becomes renderer-agnostic: the narrow projection goes to whichever program the
  model's renderer binds, not only to `alias`.
- `ViewmodelConfig` ([GameInterfaces.ts:84-91](../source/shared/GameInterfaces.ts#L84-L91):
  `visible`, `model`, `frame`) gains optional `sequence`, `animtime`, `framerate`.
- **Tags on the view model**: `GetEntityTag` works on the view entity, so a first-person flash can
  sit at the barrel. Entities attached to the view model are drawn in the view model pass, with its
  depth range and projection (and the sprite program receives that projection too).
- Until then (MDL view weapons, no tags), a game can use a per-weapon muzzle offset of its own.

### J. Blender exporter (`qs-tools/blender/`)

A general command-line tool in the `qs-tools` repository, run as
`blender -b <file.blend> --python export_iqm.py -- <options>`. Written by us rather than taken from
the IQM repository's add-on: we need frame order, weight pruning, cutting out parts and tag baking
anyway, and we control which Blender versions it supports.

**Scope** (decided 2026-11-13): what the LibreQuake files need now. Blender 5.x only, armature
deformation with vertex groups, one action per file, image-texture materials. Anything else (shape
keys, several actions, constraints, other Blender versions) is reported as unsupported, not
exported half-way.

- **Export**: deforming bones plus named tag bones; vertices with the 4 strongest weights rescaled to
  sum to 1 (reports how many vertices lost weight and the largest weight dropped); one frame per scene
  frame, in the MDL's order; materials from the mesh's material slots with the image written next to
  the model. Rotations are written as the IQM format demands (`x, y, z, w`), reordered from
  Blender's `w, x, y, z`; the Python reader test checks a known rotation.
- **Sequence names**: from a frame-name list (`--frames <file>`), for example the `$frame` lines of a
  QuakeC source, grouped by name prefix into anims (`axrun1`…`axrun6` → `axrun`). Without a list,
  one anim for the whole range.
- **Cut out parts**: `--strip-groups playergun,playeraxe,flash` deletes vertices that belong only to
  those groups.
- **Tags**: `--tag playergun=tag_weapon --tag playeraxe=tag_axe --tag flash=tag_flash` renames
  bones in the output, orthonormalized.
- **Colormap masks**: `--colormap` splits a Quake-palette skin into base, `_shirt` and `_pants`
  textures by palette range (Quake's shirt and pants ranges are confirmed against the engine's alias
  colormap code in Phase 0).
- **Attachable model** (`export_attachment.py`): a mesh plus a grip transform, so that its origin and
  axes are the tag's space. The grip comes from a JSON file per weapon (translation, rotation, scale)
  or from a fitting scene: link the `g_*` mesh into the player file, parent it to `playergun`,
  adjust it by eye, and the script reads the relative transform. Optional tags (`tag_flash`) are
  written as joints of a static model.
- **Inspect**: `--info` prints rigs, influences, frame ranges and vertex groups (the survey in
  Context, as a tool).
- **Tests** in `qs-tools`: a Python reader checks header, counts and offsets of the IQM written from a
  scene that the test builds in Blender.

### K. Hellwave integration

- **Assets** (Hellwave's own, id1 untouched): `progs/player.iqm` exported from `player.mdl.blend`
  with the equipment cut out and the tags kept; `progs/p_*.iqm` for each weapon from its `g_*.blend`
  with a grip transform; skins and colormap masks. Derived from BSD-3 assets, with attribution in
  Hellwave.
- **Weapon table**: each weapon in id1's `weaponConfig` gains an optional player-held model next to
  `viewModel` (decided 2026-11-13). id1 is a submodule (`submodule-aware-commit`). id1 itself
  leaves the field empty until it ships its own models.
- **Per player, two attached entities**: a gun slot on `tag_weapon` and a melee slot on `tag_axe`.
  While the axe is in use, the gun slot keeps the last gun, and the rig carries it on the back (to be
  confirmed in Phase 0; otherwise a `tag_holster` is added in Blender). Without the axe, the melee
  slot is `EF_NODRAW`. Death and gibbing detach and drop the gun.
- **Muzzle flash**: when the player fires (today `EF_MUZZLEFLASH` on the player), Hellwave's client
  code creates a short-lived additive sprite with `AllocEntity()`, attached to the gun's `tag_flash`,
  with a random roll, for about 50 ms. How the client notices the shot (watching the effect bit on
  the gun entity's client class, or a client event) is settled in that phase. The LibreQuake mesh
  flash is not exported.

### L. Effects on attached models (follow-up plan)

Glows, sparks or a poisoned axe giving off fumes get their own plan (`plans/entity-effects.md`).
This plan makes sure they are possible:

- **Positions**: `GetEntityTag` gives effects a point on the weapon, interpolated and through
  attachment chains. Two tags (`tag_blade_base`, `tag_blade_tip`) give a segment to emit along. CPU
  skinning keeps the posed vertices in memory, so emitting from random points on the surface is cheap
  if the effects plan wants it.
- **Separate entities**: the weapon is its own entity, so per-entity effects (tint, glow, alpha,
  flags in `clientEntityFields`) apply to the weapon alone, not to the player.
- **Client-only attachments**: an effect sprite can hang on a tag with no network traffic.

What the effects plan has to add: a data-driven particle system (textured, additive or alpha,
size/color/alpha over lifetime, gravity and drag, optional collision) usable from game code, and
per-entity render effects (emissive glow feeding bloom, rim or shell pass, tint). Neither exists
today.

### Later: Half-Life studio models (parked)

Not part of this pass (decision 18). The research is in the old plan,
`plans/half-life-studio-models.md` at commit `6f2f78a`, and gets a plan of its own when the work
starts. Decided back then: stock GoldSrc only (v10 `IDST`/`IDSQ`, Valve's companion-file
conventions), FTE as a cross-check for the maths. What the IQM core keeps in mind so it does not
have to be reworked:

- `SkeletalModel` holds nothing IQM-specific; format extras (body parts, controllers, blends) would
  live on a subclass (A).
- One joint per vertex with weight 1 is a special case of the 4-weight skinning path (D).
- Half-Life attachments (bone plus offset) would become more tags, so G and H need no changes.
- Extra per-entity state (`body`, controllers, blending) would be its own typed block on the wire,
  next to the sequence block (E).
- `.mdl` is also the alias model extension; loaders are picked by magic (`IDST` vs `IDPO`), which
  `ModelLoader` already supports.

## Phasing

Stop at each boundary for a go-ahead and record what shipped here (`plan-first-workflow`).
Engine phases leave `npm test`, `npm run typecheck` and ESLint green.

**Phase 0: spike and reference checks.** A throwaway export of `player.mdl.blend` to IQM, loaded in
FTE next to the MDL: axes, units, frame order and weight pruning look right. Check the axe frames in
Blender (gun on the back?). Read in DarkPlaces: how `_shirt`/`_pants` masks are applied, the `.skin`
file syntax, and `setattachment`'s offset and angle conventions. Confirm Quake's shirt and pants
palette ranges against the engine's alias colormap code. *Exit: one IQM confirmed in FTE, the
DarkPlaces conventions recorded here.*

**Phase 1: exporter MVP (`qs-tools`).** `export_iqm.py` with mesh, skeleton, weights, frames in MDL
order, materials, frame-name list, `--info`; its tests; README. *Exit: LibreQuake player and one
monster export and load in FTE.*

**Phase 2: format and loader (server-safe).** `SkeletalModel`, `IQMModel`, `IQMLoader`,
`ModelType.skeletal`, registration, bounds, server path without render data, `MeshModel` stubs
removed if unused, a `modelinfo <name>` command (joints, frames, sequences, tags, materials). *Exit:
the dedicated server precaches an IQM and `setModel()` sizes it.*

**Phase 3: animation core.** `SkeletalAnimation`. *Tests against hand-computed 2–3 joint fixtures
(rest pose, one rotation, halfway interpolation, shortest-path rotation, parent chain) and one
LibreQuake frame against FTE's pose.* Also the `Quaternion` flat-array helpers with the object methods
delegating to them, the `fromModelAnglesInto` versus `toRotationMatrix()` test, and the
`toRotationMatrix()` JSDoc fix (C). *Exit: poses match, `vector.test.ts` still passes.*

**Phase 4: rendering.** `SkeletalModelRenderer`, CPU skinning, shader chunks, colormap masks,
shadows, culling, frame interpolation. *Real browser pass (`browser-ui-verification`): an IQM
monster and the IQM player in id1 animate, light, shadow and show player colors like the MDL;
`r_speeds` with a Hellwave wave of IQM monsters.* *Exit: IQM entities look right and cost what was
measured.*

**Phase S: sequence state for sprites and sequenced models.** As in the old plan: the query rename,
`sequence`/`animtime`/`framerate` on all entity paths, a protocol bump (with the widened flag word
if Phase 6 has not widened it),
savegames, image sprites move from `frame` to `sequence`, `animationStartTime` removed, docs and
sprite tests rewritten. IQM sequences are selected through it. *Browser: id1's explosion (SPR via
`frame`), `gfx/fire.gif`, one sidecar sequence restarted and resumed, one IQM sequence.* Can ship
any time after Phase 2, independent of tags.

**Phase 5: tags.** `getTagIndex`/`sampleTag` on both realms, tag orthonormalization, `GetTagIndex`
and `GetEntityTag` on the engine APIs, `EF_MUZZLEFLASH` light at `tag_flash`. *Tests: tag sampled
at a fraction matches the joint pose at that fraction; missing tags; server realm.* *Exit: a console
command can print a moving tag.*

**Phase 6: attachments.** State, wire bit and protocol bump, server API and
rules, client resolution pass in quaternions, `lerp.rotationMatrix` and the renderers moved to it,
client-only attachments, chains, visibility and prediction rules.
*Tests: protocol round trip, chain order and cycles, parent freed, child hidden with the view entity,
interpolated child matches parent tag.* *Browser: an entity attached to a monster's tag stays on it
while it animates, with shadows, in third person.* *Exit: general attachments work.*

**Phase 7: exporter features for attachments, Hellwave integration.** Cutting out parts, tag
renaming, colormap masks, `export_attachment.py` with grip files; Hellwave player and weapons, gun
and melee slots, muzzle flash sprites. Hellwave is its own repository (`submodule-aware-commit`).
*Browser: co-op with two players in chase cam, weapon switches, axe with the gun on the back, flashes
at the barrel.* *Exit: Hellwave players carry their weapons.*

**Phase 8: IQM view weapons.** `R.DrawViewModel` renderer-agnostic (can ship earlier on its own),
`ViewmodelConfig` sequence fields, view model tags and attached entities in the view model pass.
`v_axe` and `v_nail2` are rigged; the shape-key view weapons stay MDL until reworked in Blender.

**Phase 9: polish, as measured.** GPU skinning if Phase 4's numbers ask for it; skipping pose updates
for far entities.

Half-Life studio models are not a phase of this plan (Later: Half-Life studio models).

## Documentation

| Doc | Change | Phase |
|---|---|---|
| `docs/skeletal-models.md` (new) | IQM support, frame vs sequence, materials and colormap masks, limits | 2, extended in 4, S, 5, 6 |
| `docs/skeletal-models.md` | Tags and attachments for game authors, with a weapon example labeled as one | 5, 6 |
| `docs/README.md` | Table of contents entry | 2 |
| `README.md` | Feature list: IQM models; then tags and attachments | 4, 6 |
| `docs/game-module-contract.md` | Sequence queries, tag and attachment APIs | S, 5, 6 |
| `docs/client-entities.md` | Sequence state, `animationStartTime` removed, client-only attachments | S, 6 |
| `docs/sprites.md` | `sequence` instead of `frame` for image sprites, renamed queries | S |
| `docs/shader-chunks.md` | Only if new chunks change the documented set | 4 |
| `docs/events.md` | No events planned; `event-bus-docs-sync` if one appears | – |
| `qs-tools` README | Exporter usage, options, the LibreQuake player and weapon recipes | 1, 7 |
| Hellwave `docs/` | Player-held weapons, how to add a weapon model | 7 |
| JSDoc | `SkeletalModel`, `IQMLoader` (byte layout and FTE references), `SkeletalAnimation`, tag and attachment APIs, `ViewmodelConfig` | with each phase |
| JSDoc | `Quaternion`: the `[w, x, y, z]` layout as the engine-wide rule, the flat-array helpers, model versus view angle convention | 3 |

## Testing

- Load the `writing-engine-tests` skill first. Engine tests under `test/common/`
  (`iqm-loader.test.ts`, `skeletal-animation.test.ts`, `model-tags.test.ts`,
  `entity-attachments.test.ts`, protocol round trips in the existing protocol tests) and
  `test/renderer/` (`skeletal-model-renderer.test.ts` with the GL mocks).
- A typed synthetic IQM builder in `test/support/` for the unit tests. In addition, a small
  IQM made from LibreQuake assets is committed to `data/` for an end-to-end test (decided
  2026-11-13: loader, animation and tags on a real export). That triggers `dockerfile-fixture-sync`
  (Dockerfile `COPY`, `.dockerignore`), and the BSD-3 attribution goes next to the file.
- Shaders: `test/renderer/shader-library.test.ts` compiles and links every program; browser passes
  are the gate for how things look (Phases 4, 6, 7, 8).
- Exporter: Python tests in `qs-tools` that build a scene in Blender, export it and read the result
  back.
- Performance: `r_speeds`/`r_bench` numbers before and after Phase 4 with many skinned entities,
  recorded here.

## Open questions

None. All settled on 2026-11-13 (decisions 6–18). Phase 0 still reads DarkPlaces for the details
of conventions already chosen (masks, `.skin` syntax, `setattachment` angles); if one of them turns
out not to fit, that comes back here as a question.

## Risks

- **Blender API churn.** Actions moved to layered actions with slots in recent versions (the
  2026-11-12 survey read no F-curves the old way). The exporter evaluates poses per frame instead of
  reading F-curves, and its tests pin the supported versions.
- **Weight pruning** to four influences can bend joints differently. The exporter reports what it
  dropped. LibreQuake's worst case is 13 influences (oldone), 8 for most monsters.
- **Weapon fit** is art work per weapon. Long weapons may cut into the body in some frames. The
  fitting scene makes this visible before export.
- **Tag and vertex interpolation must match.** One `lerp.frame` and one `Quaternion.slerpInto` feed
  both; a test pins it.
- **Quaternion component order.** A rotation read as `x, y, z, w` where `w, x, y, z` is meant still
  decodes to a valid rotation, so nothing fails loudly: bones just bend wrong. The order is
  `[w, x, y, z]` everywhere (decision 21), the IQM loader is the only place that reorders, and a
  fixture with a known rotation pins it. The exporter has the same trap in reverse (Blender's
  `mathutils.Quaternion` is `w, x, y, z`, the IQM file is `x, y, z, w`).
- **Moving renderers to `lerp.rotationMatrix`** touches every model renderer and the shadow passes.
  For free entities it must give exactly today's `toRotationMatrix()` result; a test pins that, and
  Phase 6's browser pass covers alias, brush and mesh entities.
- **CPU skinning cost** with large hordes: measured in Phase 4, GPU skinning is the way out.
- **Shared shader chunks**: moving a routine out of `alias.frag` changes the alias program too and
  needs the before/after screenshots.
- **Protocol bumps** touch baselines, deltas, demos and docs; each phase that bumps updates all of
  them and the protocol round-trip tests.
- **Sprite regression in Phase S**: gated by the browser check of existing sprite content.
- **Attachment angle convention**: a mismatch with the parent renderer's pitch handling tilts every
  attached model; a test with a pitched parent pins it (H).

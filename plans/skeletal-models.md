# Skeletal models: IQM, tags and attachments

## Status

✅ Phases 0 to 7d are done (2026-11-15 and 2026-11-16, results below), and the branch `skeletal-models` is ready to merge into `main` apart from the checks under
"Before the merge". The protocol is at 45. Phase 8 (IQM view weapons) has its engine half; its assets, the games' side and a browser pass are open. Not started: Phase 9 (polish, only as measured). All questions were settled on 2026-11-13; quaternion handling
was added on 2026-11-14 (decisions 19–21).
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

### Phase 1 results (2026-11-15)

Shipped in `qs-tools/blender/` (the `qs-tools` repository, commit `8c489f3`): `export_iqm.py`,
`iqm_format.py` (a complete IQM v2 reader and writer with no Blender dependency, in numpy),
`tests/test_iqm_format.py` (32 tests), `tests/test_export_iqm.py` (35 tests, scenes built in headless
Blender and compared frame by frame with Blender's own evaluated mesh), `run-tests.sh`, `README.md`.

- **Options**: `--info`, `--frames`, `--loop`, `--normals blender|smooth|flat`, `--material-prefix`,
  `--textures-dir`, frame range and frame rate, `--armature`/`--mesh`. The material string is the prefix
  plus the stem of the Base Color image (the PNG is written next to the model). Rotations are reordered
  once, in the writer and the reader; a test pins the byte order, and mutation checks confirmed that the
  tests fail for a wrong quaternion order, a missing world-matrix bake, a plain-matrix normal transform,
  a missing mirror winding flip and a missing V flip.
- **Real assets**, checked against Blender at every 7th frame: the **player** (25 joints, 143 frames, 794
  vertices from 539 with smooth normals, 103 KB) is within 0.015 units, which is the 16-bit pose
  quantization. The **soldier** (31 joints, 114 frames, 613 vertices from 449, 89 KB, IK baked) is within
  0.022 units on the vertices that keep all their weights. 35 of its 449 vertices have more than four
  influences (up to 9); the dropped weight is at most 6.1%, and those vertices move by at most 0.58
  units in the worst frame. The `$frame` lines of `qcsrc/monsters/grunt.qc` name exactly the soldier's
  114 frames (`stand`, `death`, `run`, `prowl`, … after stripping digits and a trailing underscore).
- **FTE's GL client** (`modelviewer`, 2026-07-13 build) shows both exports textured, solid, smoothly
  shaded and posed like the MDL from the same camera: no axis or winding problem (**the open winding
  question of Phase 0 is closed: counter-clockwise, indices as Blender writes them**). It lists our
  animation names and loop flags (`axrun (6 poses, looped)`, `stand (8 poses, looped)`) and the material
  `progs/soldier.mdl.0`. The player IQM shows the plain skin where FTE tints the MDL with default player
  colors: the colormap masks are Phase 7 (exporter) and Phase 4 (renderer).
- **Findings for later phases**:
  - The player's equipment (built-in gun, axe, flash) is still in the exported mesh. Cutting it out is
    Phase 7 (`--strip-groups`).
  - The dog has per-frame shape keys at 0 (import leftovers) and `Copy Rotation` constraints on its
    legs; both export fine.
  - Frame names are a property of the animation list, not the MDL frames: anims group runs of frames by
    name and a name that repeats later is an error (the exporter would otherwise write two sequences
    with the same name).
  - Material names with dots (`player.mdl.0`) survive; how the engine maps them to files is Phase 2/4.
  - FTE reads at most 256 joints and treats every IQM as having one skin; DarkPlaces' `.skin` files stay
    our skin mechanism.

### Phase 2 results (2026-11-15)

Shipped: `ModelType.skeletal = 4`; `SkeletalModel` (abstract) and `IQMModel`
(`common/model/`); `IQMLoader` (`common/model/loaders/`), registered in `Mod.Init`; `modelinfo <model>`
(`common/model/ModelInfoCommand.ts`, registered in `Host.InitCommands`, so the client and the dedicated server both have it);
`docs/skeletal-models.md` and its entry in `docs/README.md`; the unused `MeshModel` stubs (`animations`, `bones`, `submeshes`,
`animated`) are gone, and its type is `ModelType.mesh` instead of the literal 3. `ModelLoader.canLoad` no longer throws a `RangeError`
on a file shorter than four bytes (every loader had that; the registry now reports "no loader" instead).

- **Tests** (`npm run typecheck` zero, ESLint clean): `test/common/iqm-loader.test.ts` (42), `test/common/model-info.test.ts` (5), a
  sizing test in `test/physics/server-edict.test.ts`, and `test/support/iqmBuilder.ts`, an IQM writer written from FTE's struct
  definitions and independent of the loader. Mutation checks (rotation order, scale channel offset, weight renormalization, the pose cap,
  parent order, the bounds union, ignoring `loadRenderData`) each fail at least one test. The corrupted-file tests refuse every
  truncation, every offset past the end and every huge count with `CorruptedResourceError`, never a `RangeError`.
- **Exit met**: the server realm (`loadRenderData: false`) loads the real player through `Mod`, and `Edict.setModel()` sizes an entity
  from it: (−44.18, −34.47, −35.06) to (39.22, 30.34, 48.47), the bounds of `player.mdl`'s header.
- **Real fixture**: `test/fixtures/skeletal/player.iqm` (103 KB, the exporter's output, BSD 3-clause with the notice next to it).
  The loader's poses match the independent Python reader to 1e-4 at four (frame, joint) pairs, including a scale of 0.8 and a rotation of w
  and x, and every rotation in all 143 frames is a unit quaternion.

Differences from the plan, and why:

- **The fixture is in `test/fixtures/skeletal/`, not `data/`** (decision 9 said `data/`): the Dockerfile already copies `test/`, so
  there is no `COPY` line and no `.dockerignore` change to forget.
- **Textures are not resolved yet.** The loader keeps material names (`progs/player.mdl.0`) and the meshes that use them; creating
  textures, `.qsmat` files and `.skin` files belong to Phase 4, where a renderer can show whether they are right (OBJ models have
  no `.qsmat` hook either: `.qsmat.json` files are only referenced from a map's worldspawn today, so decision 12 needs a
  per-model convention, which Phase 4 has to choose).
- **Inverse bind matrices are not stored.** They are products of the rest pose and need the matrix helpers Phase 3 adds to `Quaternion`
  (`toMatrix3x4Into`); Phase 3 computes them once at load. `SkeletalModel` has no `samplePose` yet for the same reason.
- **Bounds without bounds**: a file that has frames but no bounds array gets the bind pose's bounds (with a console note) instead of
  being refused, since third-party exporters differ here.
- **Limits** against corrupted headers: 4096 joints, 65,536 frames and 8 million pose numbers (the shambler, 468 bones × 94 frames, uses a
  twentieth of that).

### Phase 3 results (2026-11-15)

Shipped: `SkeletalAnimation` (`common/model/SkeletalAnimation.ts`);
`SkeletalModel.inverseBindMatrices`, filled by `IQMLoader` at load; the flat-array helpers on `Quaternion` in `source/shared/Vector.ts`;
the "Posing a model" section of `docs/skeletal-models.md`.

- **API**: `SkeletalAnimation.computePose(model, frameA, frameB, blend, outJointMatrices, outSkinningMatrices | null)` writes 3×4 row-major
  matrices (`MATRIX_FLOATS` = 12 per joint) into caller-owned arrays and allocates nothing. Helpers: `multiplyMatrix3x4Into`,
  `invertMatrix3x4Into` (general affine, so uneven scale and shear invert), `writeIdentity`, `computeInverseBindMatrices`.
  Frames are clamped to the model and the blend to 0..1 (a frame number comes off the wire). One pose of the player (25 joints) costs
  3.5 µs, measured with a plain loop in Node, which puts CPU skinning's pose half far below the vertex half (794 vertices × 4 weights).
- **`Quaternion`** gained `slerpInto`, `multiplyInto`, `normalizeAt`, `toMatrix3x4Into`, `fromModelAnglesInto` and `fromViewAnglesInto`
  (all `[w, x, y, z]`, flat arrays with offsets); `slerp`, `multiply`, `normalize` and `toQuaternion()` delegate, so there is one
  implementation. `toRotationMatrix()`'s JSDoc is fixed: it says `[pitch, yaw, roll]`, the negated pitch and that its rows are the
  entity's axes.
- **The convention claims were checked, not assumed.** A test pins that `fromModelAnglesInto` is the transpose of `toRotationMatrix()` for
  eight pitched, yawed and rolled angle sets, and another that `toQuaternion()` still matches `angleVectors()` (forward, minus right, up) and
  differs from the model convention for any pitch. Phase 6 builds on the first.
- **Acceptance against an independent reference**: `test/fixtures/skeletal/player-pose-reference.json` (joint matrices and every seventh
  vertex of eight poses, five whole frames and three fractions) comes from `qs-tools`' reader and skinning with the interpolation written
  again in float64 (`make-player-pose-reference.py`). The engine matches it to **8e-6** (joint matrices) and **5e-5** (vertices). A second test
  checks that the posed vertices stay inside the per-frame bounds that the file itself records.
- **Tests**: `test/common/skeletal-animation.test.ts` (20) and 13 added to `test/common/vector.test.ts`. Mutation checks each fail at least
  one test: no shortest-path flip, skinning matrices multiplied in the wrong order, scale applied along the wrong axis, pitch not negated,
  an unclamped frame, a dropped matrix entry, and a linear blend in place of the slerp. Typecheck zero, ESLint clean, `npm test` green.

Differences from the plan, and why:

- **Not "against FTE's pose".** FTE has no pose dump (its dedicated server prints no bounds or counts, Phase 0), so the reference is
  `qs-tools`' reader, which Phase 0 and 1 checked against Blender's evaluated mesh. That is the stronger check anyway: it ties the engine to
  what the artist sees.
- **No `samplePose` on the subclasses.** `SkeletalAnimation` reads `framePoses` directly; the plan's `samplePose(selection, out)` is left for the
  day a second format needs another way to decode poses (Half-Life), since nothing needs the indirection now.
- **A pose selection is three arguments (`frameA`, `frameB`, `blend`), not an object**, to keep the call allocation-free.
- **`toMatrix3x4Into` takes the rotation, translation and scale as three arrays with offsets**, so a pose (one array) can be passed three times
  with different offsets, and `Quaternion` stays free of the pose layout.
- **Trap: import cycle at module evaluation.** `SkeletalModel` imports `Mod` (for `ModelType`), which imports the loaders, which import
  `SkeletalAnimation`. A static scratch buffer sized with `SkeletalModel.POSE_FLOATS` threw "Cannot access 'SkeletalModel' before
  initialization". `SkeletalAnimation` has its own `LOCAL_POSE_FLOATS` and asserts that it equals `POSE_FLOATS` in `computePose`.
- **A zero-scale joint** in a rest pose has no inverse bind matrix: it gets the identity and the loader logs it in developer mode, rather than
  filling vertices with NaN.
- **No tag code yet.** `sampleTag` and orthonormalization are Phase 5; `computePose(..., null)` is the call they will use.

### Phase 4 results (2026-11-15)

Shipped: `SkeletalModelRenderer` (`client/renderer/models/`, registered for `IQMModel` in
`R.Init`), the `skeletal` program (`skeletal.vert`/`.frag`), `SkeletalAnimation.skinMeshInto`, `SkeletalMaterialLoader`, `PlayerColors`,
`ModelLoadContext.textures`, `GL.CreateProgram` accepting `null` for an empty texture unit, and the "Drawing", "Textures" and "Texture
units" sections of `docs/skeletal-models.md` (plus a README line and the `docs/shader-chunks.md` tables).

- **Pipeline**: per visible entity the renderer picks the two frames from `lerp.frame` (plain `frame` when `r_interpolation` is off or
  `EF_MUZZLEFLASH` is set, like the alias renderer), poses and skins on the CPU, and draws one range of triangles per material. Skinning is
  cached per entity and pose (main pass and shadow passes share it; a culled entity is never skinned). GL objects belong to the model's mesh
  data (shared by scoped views) and are freed when it is collected (`FinalizationRegistry`) or by `cleanupModel`. Shadows reuse
  `shadow-brush`/`shadow-point`. Winding: IQM is counter-clockwise and the engine culls the front face, so the index buffer is turned round
  like the OBJ path does; **confirmed by the browser pass** (the model draws solid, not inside out).
- **Textures**: material `progs/player.mdl.0` is looked up as `.png`, then `.jpg`; when found, DarkPlaces' companions `_glow`, `_shirt` and
  `_pants` are looked for in the same format. Player colors are **added** as DarkPlaces does (`base + shirt × color + pants × color`), with
  the palette rows `PlayerColors` extracted from the alias renderer (the alias player uses it now too, with identical numbers).
- **Cost measured in Node (warm)**: pose of the player 2.3 µs, skinning its 794 vertices 16 µs. Browser numbers (`r_speeds`, a horde) not taken.
- **Tests**: `skeletal-model-renderer.test.ts` (24, a GL recording context), `skeletal-material-loader.test.ts` (8), `player-colors.test.ts`
  (3), `skinMeshInto` cases in `skeletal-animation.test.ts` (now 24), one more in `shader-programs.test.ts`. Mutation checks (winding,
  culling, cache keyed without the blend or without the mesh, byte offset of a range, `gl_nocolors`, uncleared colors, muzzle flash blending,
  shadow draw count) each fail at least one test; one survivor (an entity getting another model in the same frame) got its own test.
  Typecheck zero, ESLint clean, `npm test` green (3,219 tests).

**Browser passes** (`browser-ui-verification`, headless Chromium on software GL, so nothing about frame time or a real GPU).

*First pass* (`player.iqm` injected as a temporary entity next to `soldier.mdl` on `start`): load, animation across frames, textures, player
colors, dynamic light and `r_speeds` counters were fine, and it found a bug. **A translucent skeletal entity turned the world black** (252
`GL_INVALID_OPERATION: Mismatch between texture format and sampler type` in 4 seconds). Cause: a program's sampler gets the unit of its index,
`skeletal` had `tShadowBlockerMap` on unit 8, and `brush` reads unit 8 as `tNormal` (a plain `sampler2D`) but binds it only for a world with
a deluxemap. The shadow textures have a compare mode, so the dummy left on unit 8 failed the brush draw. Fix: the shadow samplers of
`skeletal` sit on units 10 to 14 like `brush`'s own, units 4 to 9 stay empty (`null` in the texture list); a test pins them against `brush`'s.

*Second pass, in the game* (a temporary local edit of id1, not committed and reverted: the player and `monster_army` use `progs/player.iqm`
and `progs/soldier.iqm`, exported from LibreQuake with the Phase 1 exporter, with throwaway shirt and pants masks cut from the player's palette
skin; e1m1, the default worker server, files served through Playwright context routes):
- **Fix confirmed**: 0 GL errors and 0 warnings over 6 to 8 seconds with translucent ghost and real IQM entities, with and without dynamic
  lights, shadows on. The world stays intact.
- **In game, OK**: real soldiers draw as the IQM (solid, textured, lit, not inside out, not upside down), through stand, attack and death
  frames; the IQM player in chase view runs (frames 12 to 16) and `color 4 13` against `color 13 4` swaps the shirt and pants tints; the IQMs
  are lit by dynamic lights and cast top-down shadows (visible at `r_shadow_darkness 0.1`, almost invisible at the default, as for the MDLs) and
  point-light shadows; with `r_interpolation 1` the uploaded vertices differ with the blend (30.8 units between blend 0 and 1 of one pair), with
  it off they equal the second pose; `r_speeds` with three soldiers: 3294 alias polys (886 per soldier), 15 entities. No stretched limbs or flipped
  normals. Companion probes: the expected 404s only (`_glow`, and `_shirt`/`_pants` of the soldier).
- **Content, not renderer**: the LibreQuake soldier skin is a gray-armored, skull-faced soldier with red legs, not the brown pak0 one, and the
  LibreQuake player holds a thin blade where pak0's holds a big axe.
- **Existing bug found**: the `player` program (colored MDL players) had `tShadowBlockerMap` on unit 7, which is `brush`'s `tSpecular`, the same
  trap. A colored MDL player entity made **every world draw fail (about 9,400 errors per 3 seconds) and the world stayed black after the entity
  was gone**. The soldier and player IQMs with a colormap caused none. This is not new with the skeletal work (`ShaderPrograms.ts` had that
  layout before), but it can hit multiplayer: remote players are colored. Fixed in the commit after Phase 4 by moving `tPlayer` behind the
  shadow samplers, so the shadow units are the alias program's, and by a test for every program (no 2D shadow sampler on unit 7 or 8 outside
  `brush`). **That fix is not confirmed in a browser.**

*Maintainer smoke test* (2026-11-15, id1 with the swapped files in a real browser): the game looks right, entity 1 reports the `.iqm`, and
`modelinfo progs/player.iqm` prints the expected rig (25 joints, 20 sequences, 143 frames, 794 vertices, bounds equal to the header of
`player.mdl`). The fix for the colored MDL player was not part of that test.

Not checked, so open: the axe frames and the frames of other animations of the IQM player, shadows from a translucent entity (none are cast),
pointer lock and mouse look (not possible in that harness), the glow layer (no asset has one), a pixel comparison of the alias player
against `HEAD` (unit-tested only; the colored MDL player was only drawn to count errors), and frame time or a horde on a real GPU. The exit
criteria "an IQM monster and the IQM player in id1 animate, light, shadow and show player colors like the MDL" is met with the swapped files;
"`r_speeds` with a wave of IQM monsters" is not (counts only, no timing).

Differences from the plan, and why:

- **Textures are made by the loader, not the renderer**, through a new `ModelLoadContext.textures` (like `spriteImages`): they are ready when the
  model is precached, so nothing flashes the checkerboard, and a test can hand the loader a fake source. `FromImageFile(name, true)` is silent
  on a miss now (its other users call it for optional files, `gfx/conback.png`).
- **No `.qsmat` per model and no `.skin` files** (decisions 12 and B): nothing in this phase needs them, and a per-model material file is one more
  probe per model. They come with the first asset that needs an alpha flag, a normal map or a second skin (Phase 7 at the latest). `skinnum` is
  ignored for now. The texture's alpha channel is ignored too (no alpha test); the `alias` convention that alpha means "fullbright" is not carried over.
- **A `skeletal` program, not an extended `mesh`**: `mesh` serves OBJ models and has no layers to spare, and the new program adds nothing to the
  alias, mesh or player programs, so no shared chunk moved and no before/after screenshots were needed. It uses the `entity-vertex` and
  `entity-lighting` chunks as they are.
- **`glow` is additive after lighting** (DarkPlaces) rather than the alias `luminance` mask that only feeds bloom.
- **`R.PrepareModels` is unchanged**: GL objects are created on the first draw, so a model that is never visible costs none.
- **The probing cost** (up to four small 404s per material and model, once per page load) is accepted for the DarkPlaces naming; an explicit
  material file would avoid it.

### Phase S results (2026-11-15)

Shipped: protocol 44, `ClientEdict.sequence`/`animtime`/`framerate` (`animationStartTime` is gone), the
sequence block on the wire and in static entities, `GetSequenceIndex`/`GetSequenceDuration` on both engine APIs (the sprite queries are gone, no
aliases), image sprites played by `sequence`, skeletal models played by `sequence`, saves of client-only entities, docs.

- **Wire**: the entity update flag word is 32 bits (`writeUint32`/`readUint32`), `u.sequence` is bit 16, and the block after it is a byte of
  `Protocol.sequenceField` bits followed by only the fields it names (`sequence` as a signed short, `animtime` and `framerate` as floats).
  `svc_spawnstatic` carries the same block after `solid`, with an empty mask for the usual decoration. A game that declares none of the members
  sends nothing extra (the defaults are -1, `null`, 1). Player entities are sent by the ordinary entity deltas too, so they carry it as well.
- **Queries**: `BaseModel.sequenceIndex(name)`/`sequenceDuration(sequence)` (-1 and 0 by default), overridden by `SpriteModel` and `SkeletalModel`; the APIs
  just call them, so a future format plugs in without a branch. A `.spr` keeps `frame` (`SpriteModel.selectsBySequence` is false for it), its
  `GetSequenceDuration(n)` answers for the frame `n`.
- **Skeletal playback** (`SkeletalAnimation.samplePlayback`, GL-free): `(renderTime - animtime) * framerate * rate` frames in; a loop wraps and
  blends across the seam, another sequence stops on its last frame, `framerate` 0 holds the first, a clock a hair before the start holds the first,
  `r_interpolation 0` shows the current frame, an unknown sequence falls back to `frame`. Duration: `Infinity` for a loop, `frames / rate` otherwise.
- **Tests**: 51 more (3,220 to 3,271) and several rewritten, across `protocol`, `server-messages`, `server-edict` (`makeStatic`), `client-server-command-handlers` (writer to parser
  round trips, static entities), `client-edict-animation`, `client-entities-savegame`, `sprite-model-renderer`, `sequence queries`, `skeletal-animation`
  and `skeletal-model-renderer`. Mutation checks (framerate missing from the delta, animtime and framerate read swapped, a loop that does not wrap, an
  unguarded negative clock, the sprite ignoring `sequence`, `framerate` ignored) each fail a test.

**Browser pass** (`browser-ui-verification`, headless Chromium on software GL, built from the working tree; the temporary id1 edits described below
in place; e1m1, e1m2 for statics; once with the server in the page's worker and once with a client connected to a scratch dedicated server):
- **Boot and protocol**: no protocol, load or GL errors (`getError` after every draw: 0 in about 1.95 million draws on the worker page, 0 in about
  546,000 on the dedicated-connected page). Only the expected 404s of companion textures and three files id1 never had.
- **Server-driven IQM sequence**: standing soldiers read `sequence` 9 (`prowl`, 24 frames at 10 fps, looping), `animtime` 1 (the server game time the hack
  set, the same over minutes, not the client clock) and `framerate` 1. The uploaded skinned vertices repeat every 2.38 to 2.40 s, expected 24 / 10 = 2.4 s.
  The pose follows the sequence position (correlation 0.746) and not the server `frame`, which kept cycling with its own 0.8 s period (correlation 0.004).
- **Frame-driven entities unchanged**: dogs (frames 69 to 77, lerp pairs and the wrap), soldiers that are not standing and the IQM player run on `frame`
  with `sequence` -1.
- **Quake `.spr` by `frame`**: the rocket explosion showed frames 0 to 4 with `sequence` -1 and ended (about 4 samples per second, so a frame may have
  been missed).
- **Image sprites by `sequence`**, read from the streamed quad (`explosion1.gif`, phase `spawn`, two sequences): -1 and 0 identical; 1 plays the second;
  `frame` alone changes nothing; `animtime = time` restarts at the first image; a start 0.3 s back is a finished one-shot; `framerate` 0 holds, 2 is twice as
  fast, 0.5 half. `army.gif` (phase `random`): -1, 0 and an out-of-range number identical, `frame` ignored.
- **Client stamp rule**: a client-only entity stamps on a new model or sequence and not on the same one; a soldier whose sequence changed was stamped and then
  took the server's `animtime`.
- **Late join**: a second client that joined 10 minutes later read the same soldier with `sequence` 9 and `animtime` 1, and its poses matched the first
  client's at equal sequence phases (rms 0.016 median, 0.052 at most, against 2.5 median for unrelated phases). Never two clients on screen at once.
- **Statics**: e1m2's 24 statics (torches and flames) parse with the right models, frame, skin and alpha, none at the origin.
- **Cost**: the soldier's pass `SKELETAL MODELS` took 0.22 ms of CPU for one soldier in view (software GL, so no frame-time claim).

Not checked: two clients on screen at once, pointer lock and mouse look, real-GPU timing. Seen on the side and not part of this work: id1's player does not
leave its standing animation when moving exactly along one axis (`_stateAssertStanding` in `Player.ts` tests `velocity[0] !== 0 && velocity[1] !== 0`), and
`cmd noclip` from a page that has both a local worker server and a dedicated connection is forwarded as the literal text `cmd noclip`.

Differences from the plan, and why:

- **`animtime` is optional on the wire, and the client stamps it for every entity.** The plan said a server entity takes `animtime` from the server only
  and the client stamps client-only entities. That would have broken the explosion example of `docs/sprites.md` (a sprite that plays once from the
  moment the game gives it a model, in a game that never heard of `animtime`): it would start at time 0 and hold its last image. So `animtime` is sent
  only when the game sets one (a field mask, and `null` means "not set"), the client stamps it when the model or the sequence changes as
  `animationStartTime` did, and a value from the server replaces the stamp. A game that sets `animtime` gets the exact late-join and resume behavior; one
  that does not keeps what it had (a late joiner restarts the sprite, as before).
- **Server savegames are the game's**: the engine saves no entity members, a game's `@serializable` fields are. Client-only entities save `sequence`,
  `animtime` and `framerate` (old saves load with the defaults).
- **Games have to declare the members to use them.** id1 and Hellwave do not yet: nothing in them selects an image-sprite sequence (Hellwave's flames set
  a model only), so no game code had to change for sprites. For IQM sequences id1's `BaseEntity` needs `sequence`, `animtime: number | null = null`,
  `framerate`; that edit is in the working tree of the id1 submodule (with a temporary soldier hack and the model swaps), not committed.
- **`ViewmodelConfig` is Phase 8's**, not here.

### Phase 5 results (2026-11-15)

Shipped: `BaseModel.getTagIndex`/`sampleTag` (no tags by default) with the skeletal answers, `SkeletalAnimation.sampleJointInto`,
`GetTagIndex` on both engine APIs, `GetEntityTag` on the client API (`EntityTags`), the muzzle flash light on `tag_flash`, the `entitytag` console command, the
`Quaternion` conversions they need, and the "Tags" section of `docs/skeletal-models.md`.

- **Model side**: every joint is a tag. `sampleJointInto` composes the joint with its parents from the root exactly as `computePose` does (the frame
  clamping is one shared helper, so a tag is where the vertices are: a test checks them against `computePose` at a fraction between two frames, and against
  the independent float64 reference of the player for every joint of eight poses), then makes the axes orthonormal (Gram-Schmidt: the first axis keeps its
  direction, a rig's scale and shear go, a bone scaled to nothing gives the identity) and writes origin `x, y, z` and rotation `w, x, y, z`. The server answers
  the same, since it keeps joints and frames.
- **Client side**: `EntityTags.resolve` applies the entity's smoothed origin and angles (the model convention, `Quaternion.fromModelAnglesInto`) to the tag of
  the pose from `SkeletalPoseSelection.select`, which is the code that used to be private to the renderer and now serves both, so the tag follows the same
  sequence or `lerp.frame` and the same blend as the vertices. Rotations stay quaternions; `Quaternion.toModelAnglesInto` is the one place they become angles.
  A positive pitch lifts a tag 10 units ahead (the model convention), pinned against `Vector.toRotationMatrix()`.
- **Muzzle flash**: with `EF_MUZZLEFLASH` the dynamic light sits on the entity's own `tag_flash`; without one it is where it always was. A child attached to the
  entity is Phase 6.
- **`entitytag <entity number> [tag]`** prints where the tag is and its angles, or lists the model's tags. Run again while the entity moves, the numbers move.
- **Tests**: 47 more (3,271 to 3,318): `model-tags` (20), `entity-tags` (17), muzzle flash cases in `client-legacy`, the two conversions in `vector`, and an import
  order test. Mutation checks (a tag that ignores its parents, no orthonormalization, the view pitch convention in `EntityTags` and in the angles, the
  composition order, a pose that ignores sequences, a muzzle flash that ignores the tag) each fail a test; the composition order needed its own test (a pitched
  entity and a turned tag, which do not commute).

**Browser pass** (`browser-ui-verification`, headless Chromium on software GL, e1m1, id1 with the swapped soldier and player; the console typed for real):
- **The exit criterion**: `entitytag 93` lists the soldier's 31 joints and `entitytag 93 Arm.R.006` / `Bone.006` printed different origins and angles on each call as the `prowl`
  animation ran (for example `Arm.R.006` z -195.6, -198.6, -194.9). `nowhere`, an entity that does not exist, a dog (`progs/dog.mdl has no tags`), the BSP and no arguments
  (usage) all print a message and do not crash.
- **Tag against drawn vertices**: captured in the same call as `GetEntityTag`, three instants. The distance from a tag to the nearest skinned vertex is 1.0 to 1.4 for hands
  and foot joints and 0.5 to 1.1 for the gun tip on the soldier (49 units tall), and 2.7 for the player's `head`, 1.1 for `R.hand`, 0.09 for `flash`. IK helper joints sit
  6 to 10 units outside the mesh, as pole targets do. The world position was checked by projecting the tags onto a paused frame (`Camera.WorldToScreen`) and drawing markers:
  they land on heads, hands, gun tips and feet of the soldiers and the player.
- **Turn**: with the yaw of one soldier overridden to 270, 0, 90 and 180 the `Arm.R.006` offset kept its length (9.35) and height and turned by exactly 90 degrees per step,
  and the tag's yaw with it. Two walking soldiers in the same pose at 106.3 degrees apart in yaw had tag offsets 106.4 degrees apart.
- **Muzzle flash**: the player's shotgun flash is at (0, 20, 16) from its origin at yaw 90, the fallback; a soldier with `EF_MUZZLEFLASH` has it at (0, -20, 16) at yaw 270,
  also the fallback, since no real model has a `tag_flash`. With one joint renamed to `tag_flash` in the page's copy of the model the light moved onto the tag, 0.00 units
  from `GetEntityTag` over six samples, and back to the fallback when renamed back.
- **API**: `GetEntityTag` fills the vectors for a real tag and leaves them untouched (777 and 888 before) for an unknown tag, a model without it and a dog; `GetTagIndex` gives
  the joint index and -1 for a missing name, `tag_flash` and an alias model.
- **Rest**: soldiers and the IQM player animate, `color 4 13` still tints, the rocket explosion `.spr` plays, `r_speeds` showed 3684 alias polys with the skeletal pass at
  about 0.58 ms CPU; 0 GL errors over every run, no pageerrors.
- **Seen on the side**: the soldier's joints keep their Blender names (`Bone.006`, `Arm.R.006`, ...), only the player's are `head` and `R.hand`; the soldier's `R` bones
  are on its left side (the asset names them mirrored; the vertices agree with the tags). Tag lookup is case sensitive.

Not checked: pointer lock and mouse look, real-GPU rendering, the predicted origin of the local player in first person, and a real `tag_flash` (none exists until Phase 7).

Differences from the plan, and why:

- **`ModelType` moved into `common/model/ModelType.ts`** (re-exported by `Mod.ts`, nothing else changed). `SkeletalModel` imported `Mod` for the enum, `Mod` imports the
  loaders, and `IQMModel extends SkeletalModel` was evaluated before `SkeletalModel` had finished whenever something imported `SkeletalModel` first, which `EntityTags`
  did through `ClientEngineAPI`: five unrelated test files failed with "Cannot access 'SkeletalModel' before initialization". This is the second time that trap
  bit (see Phase 3); a test whose first import is `SkeletalModel` now pins the order.
- **No real model has a `tag_flash` yet.** The LibreQuake player's rig names the equipment bones `playergun`, `flash` and `playeraxe`; the exporter's `--tag` renaming is
  Phase 7. Until then the muzzle flash light is only tested on a synthetic model.
- **`GetEntityTag` reads `lerp.origin` and `lerp.angles`**, which is what the renderer uses, so for the local player in first person (the view model is not an
  entity with tags) and with the predicted origin it is not checked.

### Phase 6 results (2026-11-15)

Shipped: protocol 45 with `u.attachment` (bit 17: parent `uint16`, tag index signed short), `ServerEdict.setAttachment`/`clearAttachment`
and their rules, `ClientEdict.setAttachment`/`clearAttachment`, `AttachmentTransform` (the one composition, used by both realms), `ServerAttachments`,
`EntityAttachments` (client resolution), `lerp.rotationMatrix`/`lerp.localOrigin`/`worldOrigin`, the renderers moved to them, savegame records, the muzzle flash on a
child's `tag_flash`, docs ("Attachments" in `docs/skeletal-models.md`, `game-module-contract.md`, `client-entities.md`, README).

- **Server**: the state is on the edict (symbol-keyed record: `#private` members make `Readonly<ServerEdict>`, which is what games get, unassignable). The tag
  is looked up by name in the parent's current model **each time it is sent**, so a parent that changes model is followed with no re-resolution step; a missing tag logs once.
  `isInPXS` answers for the root of the chain, which covers PVS, PHS and the sent set; `traversePVS` also always sends what hangs on the client's own edict (a
  player in noclip inside a wall has no leaves; the browser pass found that). `ED.Free(parent)` releases each child at its world transform (parent's pose by `frame`, or by
  `sequence` from `animtime`, unblended) and relinks it, a loop is refused at `setAttachment`, savegames carry `[parent, tagName]` as an optional third element.
- **Client**: `ClientEntities.emit` defers attached entities, then puts one on screen when its parent was (`emitSerial`), repeating up to eight rounds, so any
  numbering and any chain work and a loop never draws. The resolved transform is stored on the child. `lerp.origin` is the resolved origin, `lerp.localOrigin` the own one,
  `lerp.rotationMatrix` the renderers' `uAngles` (for a free entity exactly `angles.toRotationMatrix()`). Culling, sorting and the sprite quad read `worldOrigin`.
  The handler's `emit` runs **before** the resolve (a spinning pickup's angles are part of its offset), and lights and trails use the origin of the last resolve.
- **Tests**: 56 more (3,318 to 3,374): `entity-attachments` (client: composition, chain, depth, loop, emit pass, view entity, spin), `server-attachments`
  (API, loops, tag by name, PVS, release on free, `writeEntitiesToClient`), wire writer and parser, savegame, `toModelRotationMatrixInto` against `toRotationMatrix`,
  renderer culling and uniforms, muzzle flash on a child. Mutation checks (composition order, offset not turned by the tag, view instead of model angles, no parent check in the emit pass,
  own PVS for a child, PVS of the child instead of the root, no release on free, transposed matrix, the noclip rule, resolve before the handler) each fail a test.

**Browser pass** (`browser-ui-verification`, software GL, e1m1, id1 with the swapped soldier and player; attachments made from the page through
`window.engine.SV.server.edicts[n].setAttachment`, since no game uses them yet) and a second one for two fixes:
- A nailgun attached to soldier `Arm.R.006` is sent and resolved; its `lerp.origin` matches `entitytag` (240.74, 2386.11 against 240.7, 2386.1) and moves with the animation;
  on a paused soldier it is within 0.2 units of the tag and its matrix within about 1 degree of the tag's angles.
- Armor on the player's `R.hand` and the nailgun on the armor: neither is drawn in first person, both with `chase_active 1`, at different world origins (a chain).
- An unknown tag puts the child at the parent's origin plus the offset and logs once. Freeing the soldier detaches the child and leaves it at (240.7, 2386.1, 44.3)
  (43.5 drawn before: the unblended pose). A client-only entity on `Arm.L.006` draws and stops being drawn when its parent is freed. After `save` and `load` the
  attachment (edict 15 to parent 1, `R.hand`) is back.
- Second pass: under noclip, also inside rock, the child reaches the client and is drawn in chase view; an attached `MF_ROTATE` item spins about the tag's axis on a paused
  soldier (about 58 degrees per 350 ms, six distinct matrices); `EF_DIMLIGHT` and `EF_BRIGHTLIGHT` put the light at the child's `lerp.origin` plus 16.
- 0 page errors; only 404s of optional textures.

Not checked: **shadows of an attached entity** (a diff of two shots was dominated by the lava; the shadow passes use the same `lerp.origin` and `lerp.rotationMatrix` and a unit
test covers the renderer's uniforms, but nothing drew one), a weapon attached in a real game (no game uses attachments until Phase 7), a muzzle flash on a real attached `tag_flash`,
the first frame of a new attachment (a light there may use the offset), a WebSocket or WebRTC client, pointer lock, real-GPU timing.

Differences from the plan, and why:

- **No separate "resolved quaternion stored on the child, parents first" pass over `visedicts`.** The resolve happens in the deferred pass that also decides visibility, and
  `EntityAttachments.transformInto` recurses through the chain on demand, so `GetEntityTag` of an attached entity needs no cached state and cannot be a frame behind.
- **The tag index on the wire is a signed short, -1 for the parent's origin** (DarkPlaces: 1-based, 0 for the origin). An IQM can have more than 255 joints.
- **Client-only attachments hold the tag name and look it up every frame**; server ones carry the index the server resolved.
- **An oriented sprite takes the parent's place but not its turn** (the sprite code reads angles, and a camera-facing flash is the case that matters). Documented.
- **`MF_ROTATE` and the lights of an attached entity** needed the emit-before-resolve order and `worldOrigin` in `ClientLegacy`; trails of an attached entity are zero length.
- **Attached entities are not saved on the client** (a client-only entity's parent is a reference no save format has); the server's are.
- **Relinking after a detach is the game's job**: `clearAttachment` leaves the origin alone, and a game sets it with `setOrigin` (JSDoc and docs say so).
- **Found afterwards, not part of attachments: the muzzle flash was swallowed, for two reasons**, both old behavior. (1) Flush against a wall the light, 20 units ahead
  of an entity with a 16 wide hull, is inside the wall and the cube shadow of the world blacks it out (measured: light point contents -2, the room dark with
  `r_shadow_point 1` and lit with 0). `ClientEntities.emit` now pulls the light of a server entity back to 4 units before the first wall on the line from the entity's
  origin (`#pullLightsOutOfWalls`). (2) The entity that owns the light cast into it once `EF_MUZZLEFLASH` was gone, while the light was still fading, and in
  some poses its arm or weapon covers much of it: with the player hidden as the reference, the lit floor beside it lost up to a third of its light in attack frames 103,
  107, 113, 115, 117 and run frame 9, and none in the standing frames. The point is never *inside* the IQM player or soldier mesh in any frame (ray parity, nearest vertex 1.6 to
  2 units), it is covered, not enclosed. The owner of a light, and what is attached to it, no longer casts into that light (`ShadowMap.pointLightOwners`); the same
  frames then match the hidden-player reference. A first measurement with a standing pose showed no effect and the change was reverted for a while; the pose was the variable.
- **`ServerEdict` has no `#private` members** and the new state is symbol-keyed, for the reason above.

### Phase 7 results, exporter half (2026-11-16)

Shipped in `qs-tools/blender/` (commit `5fd64e6`): `export_iqm.py` gained `--strip-groups`, `--tag BONE=NAME` (repeatable) and `--colormap PALETTE.lmp`; the new
`export_attachment.py` writes attachable models (`--grip FILE` or `--fit-to-bone BONE`, `--tag-empty OBJECT=NAME`); README, `run-tests.sh`. Tests: 57 scene tests for
`export_iqm` (22 new), 28 for `export_attachment`, 32 pure ones; mutation checks (grip applied in the wrong order, no rigid frame in the fit, triangles of stripped
vertices kept, mask ramp, shirt row, PNG row order, Euler order, tag not renamed, tag bone dropped, fit frame ignored) each fail a test; the last one survived at first
(a weapon parented to the bone gives the same grip at any frame) and got a test with an unparented weapon.

- **The player export**, with the README recipe (`--strip-groups playergun,playeraxe,flash --tag playergun=tag_weapon --tag playeraxe=tag_axe --tag flash=tag_flash
  --colormap lq1/gfx/palette.lmp`): 25 joints, 143 frames, 603 vertices and 840 triangles, 93 KB. **117 vertices cut, the 59 + 29 + 29 of the survey.** The tags are
  `tag_weapon` (22), `tag_flash` (23, child of `tag_weapon`) and `tag_axe` (24); no vertex is skinned to any of them. The engine's `IQMLoader` and the Python reader agree on
  every tag at frames 0 and 60 (0.01 units): frame 0 has `tag_weapon` at (−4.08, 7.40, 19.01) and `tag_axe` at (9.53, −1.15, 2.96), the gun on the back and the axe in the
  hand of Phase 0. Sequence names and loop flags survive (`axrun` 0, `stand` 2).
- **The skin split**: 7,473 shirt pixels (row 1) and 20,089 pants pixels (row 6) with a non-zero mask (index 16 and 96, the darkest of a row, get mask 0 and a black
  base), every pixel of the LibreQuake skin is an exact palette match. Looked at: the base keeps the armor edges and legs without the colorable fills, the shirt mask is the
  chest armor, the pants mask the leg plates. Two palette colors are shared between a colorable row and another row (indices 16 and 175, 111 and 192); lowest index wins, so
  they count as colorable, and the exporter says so.
- **A fitted weapon**: `g_nail` appended into the player's file and parented to `playergun` came out 0.8 times the size of the original on every axis (33.5 long gives
  26.8, 13.4 wide gives 10.75, 12.8 high gives 10.24): the bone's scale is baked into the model, as the engine needs. The fitting scene was a script, not hand work, so the
  grip itself (where the weapon sits in the hand) is still art work.

Differences from the plan, and why:

- **The exporter does not orthonormalize tags.** The engine already does when it samples one (`SkeletalAnimation.#orthonormalizeInto`), and doing it in the file as well would
  distort any vertex still weighted to a tag bone (the pivot of a scaled joint is not its origin). A tag bone with a world scale is reported instead, and the attachable
  model carries the scale (the grip of `--fit-to-bone` includes it).
- **`--colormap` takes the palette file** (`palette.lmp`), because the skins are truecolor PNG and the palette index is the only thing that says shirt or pants. Masks are
  `(index & 15) * 17`, the engine's own alias translation, not DarkPlaces' brightness ratios: the same ramp as the MDL player, so the look is the same.
- **Grip transforms are JSON files or a fitting scene, tags of an attachable model are empties** (not a second JSON section); one way each, and an empty can be placed by eye.
- **Deform bones whose group is stripped are not exported** unless tagged; this is what keeps the player's `playergun` family from becoming joints nobody asked for.

Not done: the Hellwave half of Phase 7 (assets exported into Hellwave, weapon table, gun and melee slots, muzzle flash sprites) and its browser pass. The exported player has not been
drawn in the engine yet (the loader and tags are checked, the picture is not), and a weapon grip for any real weapon is still to be fitted by hand.

### Phase 7 results, Hellwave half (2026-11-16)

Shipped, in five repositories (none pushed): **qs-tools** `9aa5f47` (`fit_grip.py`, `export_attachment.py --tag-muzzle`, tests, README); **id1** `b18e731`
(`PlayerEntity._modelPlayer`, `WeaponConfigEntry.playerModel`, the player client handler's muzzle flash); **Hellwave game** `39d5bcc` (`HeldWeaponEntity`, `HellwavePlayer`
changes, `docs/held-weapons.md`); **Hellwave data** `f7eb668` (`progs/player.iqm`, `progs/p_*.iqm`, textures, `progs/src/build-models.sh`, `progs/src/grips/*.json`); **this
repository** (`EntityTags.resolveMuzzleFlash`, `ClientEngineAPI.GetMuzzleFlashOrigin`, docs).

- **Player**: `progs/player.iqm` (24 joints, 143 frames) with the tags `tag_weapon` and `tag_axe`, colormap masks, and **no `tag_flash`**: the engine prefers the
  entity's own `tag_flash` over a held weapon's, so the rig's `flash` bone would have kept every flash at the built-in gun's place. Each weapon model has its own muzzle
  (`export_attachment.py --tag-muzzle`, the middle of the face at the largest X, 22 to 27 units ahead of the player).
- **Weapons**: eight models (`p_shot1`, `p_shot`, `p_nail`, `p_nail2`, `p_rock`, `p_rock2`, `p_light`, `p_axe`) from the LibreQuake world models with grips from `fit_grip.py`:
  the world model's barrel onto the long axis of the gun that is built into the LibreQuake player, its center onto that gun's center, at scale 1. The axe needed `--axis pca` on
  both steps (the first guess, with the front picked by a "forward" direction that means nothing for an axe, had the blade at the hand; the head is now the wider end).
- **Game side**: each player owns a gun entity on `tag_weapon` (the last gun, always drawn, on the back while the axe is out) and an axe entity on `tag_axe` (drawn while it is
  the weapon in use, `EF_NODRAW` otherwise); `_syncHeldWeapons()` is idempotent and runs on weapon change, every `playerPostThink`, death, spectate and return; dead, spectating
  and invisible players carry nothing. Tests: 8 for the held weapons (a stand-in player and engine, so the logic is checked, not the declarations), 3 for the id1 handler, 1 for
  the swappable model.
- **Engine**: the id1 player handler allocated the flash with the fixed offset, so the engine's tag rule (it lives in `ClientLegacy`) never ran for players. The rule is now
  `EntityTags.resolveMuzzleFlash`, shared by `ClientLegacy` and `ClientEngineAPI.GetMuzzleFlashOrigin`, and id1's handler asks it. `npm test` 3,395 pass, typecheck zero.

**Browser passes** (`browser-ui-verification`, software GL, hw_e1m2, in-page worker server, `sv_cheats 1` set after the map loaded, `impulse 9`, `chase_active 1`, camera
override for the views):
- *First*: the player draws solid and textured; `color 4 13` against `color 13 4` swaps the shirt and pants tints. At start only the axe is on `tag_axe` (tag 22 is `tag_weapon`
  once a gun is picked); switching to a gun hides the axe (`EF_NODRAW`) and shows the gun in the hand; with the axe out the last gun hangs diagonally on the back. All seven guns
  were judged from four views each: shotgun, super shotgun and nailgun good; super nailgun, grenade launcher and rocket launcher acceptable (big, they cover part of the torso or stick
  out behind); thunderbolt the weakest (prongs stick out sideways, one passes through the shoulder in the side view). Axe upside down (fixed, below). After `kill` the held entities are
  gone and the corpse model is `h_player.mdl`; after the restart the player comes back with the axe. No GL errors, no page errors, only 404s of optional files. It found the flash bug.
- *Second*: with the fix the dynamic flash light equals `GetEntityTag(gun, 'tag_flash')` to 0.000 units, polled every render frame, for all seven guns (forced `EF_MUZZLEFLASH`, 20 to
  24 samples each) and for real firing of the nailgun (13 samples), rocket launcher (1) and shotgun (2); it is 13.7 to 21 units from the old fixed place. Flush against a wall the
  `tag_flash` is inside solid for every weapon and the light sits 4 units before the wall, in empty space. First person still gets its own flash (exactly view origin + 20 forward
  + 32 up) and nothing throws. The refitted axe: haft through the hand, head at the top and front, the right way up, no clipping in the back and left views; the blade looks large
  (about a third of the figure's height), a judgment call. The gun on the back sits flush against it.

Not checked: pointer lock and mouse look; real-GPU rendering and frame time; **a second human player** (what a remote client sees; only the local player's entity was driven), the
dedicated-server variant, other maps; spectating, invisibility and disconnect in a browser (unit-tested only); a screenshot of the first-person flash (data only); `r_speeds`. The grips are
first guesses for **a human to adjust**; the thunderbolt in particular. A flash light keeps the origin it was given for its 0.2 s, so after a rocket's knockback it lags the gun by
up to about 45 units (the fixed offset did the same). The colormap change seemed to take several seconds to show up in the first pass (not looked into).

**Found afterwards, not part of this work: wave monsters stood still.** `GameManager.spawnEnemies` calls `hunt()` right after the spawn; since id1 commit `39822b7` (2026-11-10) the
first think of a monster (`EntityAI._initialize()` ends in `thinkStand()`) undoes that, and `findTarget` no longer re-acquires a player that already is the enemy. A bisect with the
Phase 7 changes removed pinned it to that commit, so it was not this plan's work. Fixed on the Hellwave side (Hellwave commit after `4d5a32d`): `orderHuntAfterSpawn` schedules a named,
serializable think that repeats the order after the first think; checked in a browser for natural waves (monsters start moving 0.9 to 1.0 s after the spawn), a save and load right after a
spawn, and monsters killed in the first second. id1 is untouched; its `hunt()` is still undone by a first think that has not run yet.

Differences from the plan, and why:

- **No muzzle flash sprite.** The plan's Hellwave flash was an additive sprite on the gun's `tag_flash`; what exists now is the light at the barrel (which was the part that was wrong).
  A sprite needs an asset, which does not exist yet, and a client-side trigger; `ClientEngineAPI.AllocEntity` with `setAttachment(gun, 'tag_flash')` is ready for it.
- **No `tag_holster`.** The gun on the back comes from the rig, as Phase 0 found.
- **Weapons are freed, not dropped, when the player dies.** The backpack already carries them in a deathmatch; a corpse holds nothing.
- **A weapon is one entity, hidden by `EF_NODRAW` for the axe, freed for a player who cannot carry it**, not a fresh entity per switch: switching is frequent in a fight.
- **The weapon table is filled by the game when the module loads** (`weaponConfig` is a mutable shared map), since `WeaponConfigEntry` is read-only per entry and id1 has no per-game hook.
- **`PlayerEntity._modelPlayer`** is a new id1 static, the minimum for a game to swap the model; id1's own behavior is unchanged.

### Phase 7b: look pitch on the spine, the axe on the back (2026-11-16, ideas from the maintainer)

Two follow-ups after the first look at Hellwave's players. Decided by me (recommendations, nothing forked on the maintainer yet):

1. **The axe is on the back while a gun is in the hand** (instead of hidden). The rig has no back tag, so the exporter learns `--tag-on BONE:NAME=x,y,z[,rx,ry,rz]` (a fixed tag on a bone, placed in the model space of
   the rest pose) and Hellwave's player gets `tag_axe_back` on `spine1`. The place was found with a Blender render of the player with the axe at candidate holsters, not by guessing: (−9, −1, 10), rolled 50 degrees about
   X, which lies the axe diagonally across the back with the head over the left shoulder, blade flat. `HeldWeaponEntity` moves between `tag_axe` and `tag_axe_back` with the weapon in use (no more `EF_NODRAW`).
2. **Looking up and down flexes the spine** instead of tilting the whole body. The wire already carries the player's pitch (the entity's `angles[0]` is −v_angle/3, set by `ServerClientPhysics`), so the work is on the client:
   - **Engine, a general capability, not a player feature: procedural joint rotations.** `JointAdjustments` (a rotation per joint, in model space about the joint's own origin) is an optional argument of
     `SkeletalAnimation.computePose` and `sampleJointInto` (so a weapon on a hand tag follows the bent spine), lives on `ClientEdict.jointAdjustments`, is part of the renderer's skinning cache key, and is set by the game through
     `ClientEngineAPI.SetEntityJointAngles(entity, jointName, angles)` / `ClearEntityJointAngles`. No format, no wire change, no model metadata: which joints and how much is the game's decision.
   - **The body stops tilting:** `ClientEdict.bodyPitch` (default true, set by `SetEntityPitchesBody`) makes `lerp.rotationMatrix` and the attachment parent transform ignore the entity's pitch (`lerp.bodyAngles`); the game
     turns it off for a model it bends the spine of.
   - **Game (id1's player client handler):** 3 × the entity's interpolated pitch is the look angle, spread over `spine0`, `spine1`, `neck` and `head`; a model without those joints (the MDL player) keeps the old whole-body tilt.
   - Tests: the pose maths against hand-computed joints (pivot at the joint's own origin, children follow, tags agree with the skinned pose under adjustments), the cache key, `bodyPitch`, the API, the handler.
   - Not in this: bone controllers on the wire (Half-Life style), a model-declared aim rig, server-side use of the adjustments (the server's pose of a freed child's parent ignores them).

**Phase 7b results (2026-11-16).** Shipped: `JointAdjustments` and the optional argument of `computePose`/`sampleJointInto`/`sampleTag`; `ClientEdict.jointAdjustments`/`bodyPitch`, `lerp.bodyAngles`;
`ClientEngineAPI.SetEntityJointAngles`/`ClearEntityJointAngles`/`SetEntityPitchesBody`; the renderer's skinning cache keyed on the set and its version; id1's player handler (3 × the entity pitch over
`spine0` 0.15, `spine1` 0.25, `neck` 0.25, `head` 0.35); Hellwave's axe on `tag_axe_back` while a gun is in the hand; qs-tools `--tag-on` and `--reparent`; docs. `npm test` 3,430 pass, typecheck zero, ESLint
clean; mutation checks (a flipped rotation-matrix sign, a tag or the renderer or the parent transform ignoring the adjustments, the cache keyed without the version or without the set's identity, no
resize for another model, the holster's parent, its Euler order, the reparent's parents and loop check) each fail a test, and four survivors got tests (yaw and roll, the Euler order with three
angles, the identity of the set, a vertex shared by two groups in `fit_grip`).

- **The weapon tags did not follow the bend, and the first browser pass found it.** The rig's `playergun` and `playeraxe` are root bones keyed per frame in model space, so `tag_weapon` and `tag_axe` had no parent
  and the engine's rotation of `spine1` (which carries the arms) left the gun behind: at a look pitch of +80 the left fist hung a hand's width from the gun. The exporter's `--reparent BONE=PARENT` now puts them under
  `spine1` and recomputes their local poses so that their world places in every frame stay what Blender shows (checked: the same tag positions to 0.01 as before); the hands are under `spine1` too, and a rotation of
  `spine1` moves all of them rigidly. Re-checked in the browser: `tag_weapon` and `tag_axe` now move with the bend, and the gun stays in both hands at +80 and −70.
- **Weapons at 66% size** (the maintainer found them too big): all eight grips refitted with `fit_grip.py grip --scale 0.66`, so they stay centered on the same place in the hand; the guns read as hand-held at that size,
  the muzzle flash light still equals `GetEntityTag(gun, 'tag_flash')` for all eight within 0.1 unit.
- **The bend over the wire**: the entity pitch is a byte (1.4 degrees, 4.2 for the look pitch), interpolated; at 15 degrees per second the pitch moved 1.0 to 1.4 degrees per frame with a one-frame stall every 3 to 4 seconds
  followed by a catch-up of about 2.5 degrees, of which the head gets 35%: no visible 4-degree steps. A smoother look would need the full view pitch on the wire (a wire change, not done).
- **The axe on the back**: one axe entity per player, its tag name switches between `tag_axe` and `tag_axe_back` with the weapon; the haft lies diagonally across the back; the handle looks a little long next to the torso
  (a judgment call; the holster's place is one `--tag-on` argument).

Not checked: the MDL player (Hellwave has none; the check on an id1 build is open, so the fallback "no joints, the body tilts as a whole" is covered by the handler's unit tests and by `SetEntityJointAngles` returning
`false`, not by a picture); ducking; pointer lock and mouse look (the pitch was written to `CL.state.viewangles`); a real GPU; a second human player; the server's own tags and the pose a freed child is left in still
ignore joint rotations; stale rotations stay on an entity whose model is swapped for one without those joints (harmless there).

### Phase 7c: the muzzle flash sprite (2026-11-16)

Shipped: Hellwave's `HellwavePlayerClientEdictHandler` (replaces id1's for `player`) and `MuzzleFlashClientEdictHandler` (`hellwave_muzzleflash`, a client-only entity on the held gun's `tag_flash`, one of three random GIFs
of the weapon's family from `gfx/muzzle_flash/`, rolled, gone when its animation is over), their registration (`_clientEdictHandlerRegistry` in Hellwave's server and client game API, so the server precaches the 12 GIFs),
the sidecar settings of the 27 GIFs the maintainer found (additive, black color key, `repeat: 1`, `interpolate`, `scale` 0.16 to 0.30; `parallelOriented` for the stars and the energy flashes so that a roll turns them, `oriented`
for the three cone families, which no weapon uses yet), `ClientEdict.setAttachment` taking the game's read-only entity type (the documented call did not typecheck for a game).

- **"The flash is not always there" was a sampling bug, and it was in the light of id1's player handler too.** The first version found a shot by looking at the `EF_MUZZLEFLASH` bit once per render frame. The server clears
  the bit after one datagram, and a client frame that reads two datagrams (a slow frame, a burst after a hitch) sets and clears it before any handler runs. The browser pass measured it: at 7 to 9 frames per second the sampling saw 2
  of 55 shotgun shots and 19 of 91 nailgun shots; the light of id1's handler was missed 53 times in 55. Fix: the engine counts shots while it parses updates (`ClientEdict.muzzleFlashCount`, `muzzleFlashTime`: +1 when an update
  sets the bit, not when it keeps it) and both handlers compare the count with the one they saw last. With it the shotgun made 55 sprites for 55 shots.
- **A second bug in the fix, found by the same pass:** the freshness rule (a shot older than 0.2 s is not flashed, so that nothing pops out of a player who comes back into view) measured the age against the clock after the frame
  had advanced, so any frame longer than 0.2 s threw its own shots away (4 of 56 shotgun shots, 12 of 65 nailgun frames, all of them at 335 ms frames). The age now allows for the frame's own length (`CL.frametime`).
- Browser pass (software GL, dev build): the 12 GIFs load and precache with no console warning; for impulses 2 to 8 the flash entity is attached to the gun with tag `tag_flash`, its drawn origin is 0.000 units from
  `GetEntityTag(gun, 'tag_flash')`; it leaves after its animation (0.12 to 0.24 s, observed 0.21 to 0.38 at 110 ms frames) and nothing leaks after 50 shots or a save and load; mid-flash screenshots show it at the barrel, bright,
  additive, no dark box, the roll varying; the axe makes none; first person makes none (the player's own model is not drawn) and the view's own light still works.
- **Open:** the nailgun is counted about 7 to 10% short in the in-page server's slow frames: two shots whose bits are set in two consecutive datagrams are one change to the client, since the server sends only a changed field.
  A server frame faster than the shot interval (the dedicated server) does not show it. The scales were chosen blind and the shotgun and rocket launcher flashes are about as big as the weapon (`star_shotgun` at 0.30): one number
  per family in the `.gif.json` files. The light of a flash is placed once at the shot, so after a rocket's knockback it lags the barrel by up to 12 units while the sprite follows it. The cone flashes (a side view that needs a
  client entity placed at the tag with the tag's angles, since an attached `oriented` sprite does not turn with its parent) are not wired.
- Not checked: a real GPU and 60 frames per second (the freshness bug is only visible below 5 frames per second there, so it is a hitch and slow device bug), a second human player, the production build.

### Phase 7d: beams start at the muzzle (2026-11-16)

Shipped (`56901be6`, documented in "Beams" of `docs/skeletal-models.md`): a lightning beam (`te.lightning1` to `te.lightning3`) starts on the `tag_flash` of the entity that fired it (its own, or
its weapon's), the same place the muzzle flash uses, and follows it every frame while the beam lasts; the end stays where the server's trace hit. A shooter without a muzzle keeps the server's start
(its origin plus 16 up). The local player in first person still starts at the player's origin, since the player model is not drawn there; a chase view uses the muzzle. Test: `test/client/beam-start.test.ts`.
Not checked in a browser.

### Phase 8 results, engine half (2026-11-16)

Shipped: `FrameUniforms.UploadPerspective`, `R.DrawViewModel` for every renderer, `sequence`/`animtime`/`framerate` on `ViewmodelConfig`,
`ClientEngineAPI.GetViewmodelEntity`, entities attached to the view model drawn with it (`ClientEntities.resolveViewmodelAttachments`,
`R.#drawViewModelAttachments`), docs ("The first-person weapon" in `docs/skeletal-models.md`, `game-module-contract.md`, `setAttachment` JSDoc).

- **`DrawViewModel` was alias-only**: it wrote the narrow projection to the `alias` program and drew the weapon with whatever renderer its model had, so a
  skeletal weapon would have been drawn with the world's field of view, and so would anything attached. The projection now goes to every program that has one
  (`UploadPerspective`, about forty programs, twice a frame and only while a weapon is drawn), and the frame's own is written back afterwards.
- **Attachments to the view model are drawn in its pass**, not in the world's: the weapon sits in front of the camera in world units, but a flash placed at its
  barrel and projected with the world's field of view lands somewhere else on the screen. The entity list is built *before* the view is calculated
  (`ClientHost` runs `emit()`, then `ScreenFrame.Update()` calls `CalcRefdef`), so a child of the weapon is only collected at emit time (handler run, kept out of
  `visedicts`) and placed when `DrawViewModel` asks, with the weapon in its place for the frame: no frame of lag, no jitter against the bob. Chains work.
  Solid children draw with the weapon; blended ones and sprites draw **after the world and the transparent pass** (`R.DrawViewModelBlended`) with the depth mask off and the sprite blend function (the first version drew them with the weapon, before the world, and the first browser test with a real flash found that the world painted over them: a blended entity writes no depth); the sprite quads are streamed, so the pass flushes
  before the projection goes back (found while writing the test: a flush per child, solid ones included, was wasted, and a child without a renderer switched the
  blend state on).
- **Tests**: 16 more (3,462 to 3,478): `view-model-pass.test.ts` (7: the order of projection, renderer, flush and restore; a missing renderer;
  everything that hides the weapon; solid, blended and sprite children), 4 emit tests for the collection (late placement, chain, unplaceable, next pass and world-pass
  attachments untouched), 3 for the sequence fields in `view-refdef.test.ts` (given, stamped by the engine, forgotten), one for `UploadPerspective`, one for the API.
  Typecheck zero, ESLint clean, `npm test` green.

Not done, and why:

- **No browser pass.** Nothing in this half has been drawn: no game has an IQM view weapon yet, so a pass needs a temporary one (an exported `v_axe`), and the
  projection and flush order are covered by recorded GL calls only. That is the exit test of this phase.
- **The assets and the games' side**: `v_axe` and `v_nail2` exported with the Phase 7 exporter (`--tag-on`/`--tag` for `tag_flash`), id1's and Hellwave's client
  `viewmodel` filling `sequence` (and `animtime` on each shot), the first-person muzzle flash as a sprite on the view model's `tag_flash` in place of the fixed
  offset, and the weapon table's view model names. All of it is game content and Blender work.
- **No shadow of, and no dynamic light from, what hangs on the weapon** (documented). The flash light keeps using `GetMuzzleFlashOrigin(GetViewmodelEntity(), out)`.

### Phase 8 results, Hellwave half: the shotgun (2026-11-16)

The first IQM view weapon, with its muzzle flash, checked by the maintainer in a real browser ("works").

- **`v_shot` has no rig**: two shape keys, `flame` (a 24-vertex mesh flash) and `kick` (the recoil). The recoil is a rigid motion of all the other vertices (best fit off by 0.008 units
  at the worst frame, 4 degrees at most), so `qs-tools/blender/bake_shape_keys.py` (new, 12 tests) fits one bone per frame, refuses a file whose keys bend the mesh, and saves a copy
  that `export_iqm.py` exports: 2 joints (`gun`, `tag_flash` at the front of the barrel), 8 frames, the MDL's. `progs/v_shot.iqm` matches Blender's shape-key mesh in every frame to 0.0083.
  `build-models.sh` has a `shapekey_viewmodel` line; the other models it builds came out byte-identical.
- **Game**: `viewModels` in Hellwave's `HeldWeapons.ts` swaps the shotgun's `viewModel` in the weapon table (id1's `weaponframe` drives it unchanged); `FirstPersonMuzzleFlash` puts the flash
  sprite on the view model's `tag_flash` when the engine counts a shot of the local player.
- **Found by a browser run**: the flash was spawned, attached, resolved onto the tag and given a draw call, and still invisible: it was drawn in the weapon's pass before the world, and a blended
  sprite writes no depth, so the world painted over it. Blended attachments now have their own pass after the world (`R.DrawViewModelBlended`, see Phase 8 results, engine half).
- **The flash light** of id1's first-person handler now sits at the view model's `tag_flash` (`GetMuzzleFlashOrigin(GetViewmodelEntity())`), the fixed place 20 units ahead of the eye for a view model without one (id1 commit after `b2a4b0f`; not looked at in a browser).
- **Open**: the flash scale is per
  GIF family and shared with third person (`star_shotgun` is 0.15 now); the other view models (`v_shot2` has five shape keys and needs a look; `v_axe` and `v_nail2` are rigged and go through
  `export_iqm.py`); the "MDL first-person weapon still looks as before" check of the merge list was not done on its own, though the other weapons were drawn in the same runs.

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
    *Amended 2026-11-15 after Phase 1:* the files need more than the survey showed. The soldier and the
    dog use IK and Copy Rotation constraints, the soldier has unused shape keys, and its file also holds
    a camera's action. The exporter reads each bone's evaluated pose, so constraints are baked in and
    correct; they are reported, not refused. Shape keys are refused only when in use (above 0, or
    animated or driven), and the actions of other objects are ignored with a note (J).
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

- **The protocol may be bumped** (see decision 16). Phase S took it to 44 and Phase 6 to 45 (`Protocol.ts:3`).
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

### What exists today (verified in source 2026-11-12, before Phase 0; the phase results above say what changed)

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

**Scope** (decided 2026-11-13, amended 2026-11-15): what the LibreQuake files need now. Blender 5.x
only, armature deformation with vertex groups, image-texture materials. Bone constraints are baked
through the evaluated pose. Shape keys that are in use, other modifiers, dual quaternion skinning and
other Blender versions are reported as unsupported, not exported half-way.

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
while it animates, with shadows, in third person.* *Exit: general attachments work.* **Done 2026-11-15, see Phase 6 results.**

**Phase 7: exporter features for attachments, Hellwave integration.** **Done 2026-11-16, see the Phase 7 results (and 7b to 7d for the follow-ups).** Cutting out parts, tag
renaming, colormap masks, `export_attachment.py` with grip files; Hellwave player and weapons, gun
and melee slots, muzzle flash sprites. Hellwave is its own repository (`submodule-aware-commit`).
*Browser: co-op with two players in chase cam, weapon switches, axe with the gun on the back, flashes
at the barrel.* *Exit: Hellwave players carry their weapons.*

**Phase 8: IQM view weapons.** **Engine half done 2026-11-16 (see Phase 8 results); assets, the games' side and the browser pass are open. Not needed for the merge (decision 3).** `R.DrawViewModel` renderer-agnostic (can ship earlier on its own),
`ViewmodelConfig` sequence fields, view model tags and attached entities in the view model pass.
`v_axe` and `v_nail2` are rigged; the shape-key view weapons stay MDL until reworked in Blender.

**Phase 9: polish, as measured.** **Not started; waits for real-GPU numbers (see "Before the merge").** GPU skinning if Phase 4's numbers ask for it; skipping pose updates
for far entities.

**Open items kept from Phase 7 (2026-11-16), decided to wait:**
- **Look pitch precision.** The entity pitch is one byte on the wire (1.4 degrees, so 4.2 degrees of look pitch, interpolated); the bend of the spine looks smooth at slow sweeps and the maintainer is happy with it. If it ever
  bothers (fast looking, a remote player's head), the fix is the full view pitch on the wire for player entities (a wire change and a protocol bump), or a client-side smoothing of the joint angles. Watch for it in multiplayer.
- **Muzzle flash sprite scales and cone flashes.** The sprite itself shipped in Phase 7c; what is left is the scale per weapon family (one number in each `.gif.json`, chosen blind) and the three cone families, which no
  weapon uses yet and which need a client entity placed at the tag with the tag's angles. The nailgun is counted 7 to 10% short in the in-page server's slow frames (Phase 7c).

**Before the merge (checks the plan owes, none of them a known bug):**
1. **A colored MDL player in a browser.** The Phase 4 fix (`tPlayer` behind the shadow samplers) is only unit tested; the bug it fixes blacked out the whole world and remote players in multiplayer are colored.
2. **A real GPU.** Every browser pass ran on software GL. Phase 4's exit item "`r_speeds` with a wave of IQM monsters" is met as counts only; take frame times (`r_speeds`, `r_bench`, `docs/frame-profiling.md`)
   with a Hellwave wave and record them here. They decide Phase 9.
3. **Two human players** (what a remote client sees: held weapons, flash sprite, spine bend), once with the in-page server and once with a dedicated server. Phase 7's exit criterion named co-op with two players in chase cam.
4. **The MDL first-person weapon in a browser** (Phase 8 changed how the narrow projection reaches every program; the weapon, the world behind it and the HUD must look as before, in id1 and in Hellwave).
5. `npm run build:production` (the build that ships), a beam in a chase view (Phase 7d), and the shadow of an attached entity.

Known and accepted: pointer lock and mouse look were never exercised in the headless harness.

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
  IQM made from LibreQuake assets is committed for an end-to-end test (decided
  2026-11-13: loader, animation and tags on a real export; it lives in `test/fixtures/skeletal/`, which the Dockerfile already copies, see Phase 2 results). The BSD-3 attribution is next to the file.
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

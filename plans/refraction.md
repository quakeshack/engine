# Screen-space refraction for translucent liquids and glass

**Status:** Done (2026-10): Phases 1 to 3 shipped, and the duplicate liquid and translucent draws found on the way are fixed. Water and glass ship together in this pass.

## Context

Translucent liquids and glass are plain alpha blends today: what is behind them shows through unchanged.

- **Scene capture already exists.** `R.PreRenderScene` requests the capture FBO whenever turbulents or fog volumes are
  drawn (`PostProcess.requestSceneCapture`), so on practically every map with water the frame is drawn into
  `PostProcess.scene` (color, emissive, depth) or its multisampled twin `PostProcess.msaaTarget`.
- **Mid-frame copies have a pattern.** `PostProcess.copySceneDepth()` blits the depth drawn so far into
  `PostProcess.depthCopy` so a pass can sample it while it keeps drawing into the scene; with MSAA the blit resolves.
  It records itself in the frame graph (`Frame.beginPass`), which asserts no pass samples its own target.
- **The water shader already reads scene depth** (`turbulent.frag`: `tDepth`, `uScreenSize`, `linearizeDepth`) for
  the `_qs_waterfog` depth fog, bound in `BrushModelRenderer.beginWorldTurbulentPass`.
- **One sorted pass** (`scene/TransparentPass.ts`) draws transparent world leafs, world turbulent chains, fog volumes,
  translucent entities (brush entities with `alpha`, including their turbulent faces), sprites, decals and
  particles back to front.
- **Materials:** `MaterialFlags` (`Materials.ts`) has `MF_TRANSPARENT`, `MF_TURBULENT`, ...; `.qsmat.json` sets flags
  by name (`QSMatLoader`) and can supply a `normal` map (`PBRMaterial.normal`). `{` textures get `MF_TRANSPARENT`
  in `BSP29Loader`, but they are fences and grates, not glass, so refraction must be opt-in.
- **Sampler budget:** `brush.frag` binds 14 samplers, assigned to units 0..13 in declaration order
  (`GL.CreateProgram`). Adding the scene color and depth copies makes 16, exactly the WebGL2 guaranteed
  `MAX_TEXTURE_IMAGE_UNITS`.

### Decisions already made

- **Water** opts in per map with the worldspawn key `_qs_waterrefraction "1"`, and it applies to turbulent surfaces
  only. It covers every turbulent (water, slime, lava, teleporter), but only when the surface's resolved alpha
  (`_wateralpha`, `_lavaalpha`, ... times entity alpha) is below 1. Opaque liquids are untouched.
- **Glass** opts in per texture with a new qsmat flag, `MF_REFRACT`.
- **Re-copy when stale:** the scene color copy is refreshed whenever something was drawn since the last copy, so glass
  behind water, particles behind glass and so on show up in the refraction. No early-Source "stuff behind the glass
  is missing" artifacts.
- Passing refraction through the game-driven effects field is out of scope for now.
- **Seen from below too:** a surface refracts when the camera is in the liquid as well, on top of the `warp` effect.
- **Strength is a number:** `_qs_waterrefraction` takes a strength (`"1"` is the default strength, `"0"` or absent is
  off, `"0.5"` is half); qsmat stays at the flag for now.
- **Glass receives no shadows:** a translucent surface passes light through, so `brush-refract` drops all shadow
  samplers, the directional one included.

## Goals

- Refraction on translucent turbulent surfaces of maps that set `_qs_waterrefraction`, on world and brush-entity
  turbulents alike, seen from above and from below.
- Refraction on surfaces whose material has `MF_REFRACT`, distorted by the material's normal map.
- No foreground bleeding: an offset sample that lands on geometry in front of the surface falls back to the
  unshifted one.
- Correct with and without MSAA, and with bloom (the emissive buffer is refracted too).
- `r_refraction` cvar to turn it off on weak GPUs; with it off, rendering is exactly what it is today.

## Non-goals (this pass)

- Reflection (planar or screen-space), Fresnel-driven reflection/refraction mix, Snell's window, chromatic
  dispersion.
- Refraction driven by the game (entity keys, `effects` bits, network protocol changes).
- Refraction on alias models, sprites or particles.
- A per-material refraction strength in qsmat.

## Design

### A. Scene color copy (`PostProcess.ts`)

- New `PostProcess.colorCopy: RenderTarget`, two linear-filtered color textures (color, emissive), no depth, resized
  with the scene in `resize()`.
- New `PostProcess.copySceneColor(): { color: GLRenderTexture; emissive: GLRenderTexture }`, built like
  `copySceneDepth()`: assert the bound target is the scene or the MSAA target, `Frame.beginPass('scene-color-copy',
  ...)`, blit both attachments (reusing `_resolveMSAAColorAttachment` for the attachment-1 workaround), rebind the
  source. JSDoc carries the same contract as the depth copy (copy is a snapshot; unit hygiene after the pass).
- Free the target with the others on shutdown. Memory: 2 × RGBA8 × screen size, the same as the ping-pong pair.

### B. Copy scheduling (`TransparentPass.ts`)

- An item is *refractive* when `r_refraction` is on, the capture FBO is active, and:
  - `Turbulent`: the chain's material resolves to alpha < 1 and the map set `_qs_waterrefraction`, or the material
    has `MF_REFRACT`;
  - `WorldLeaf`: the leaf has a translucent `MF_REFRACT` material;
  - `Entity`: the brush renderer says the entity has refractive surfaces (new
    `BrushModelRenderer.rendersRefraction(model, entity)`, mirroring `rendersTransparentPass`).
- The predicate lives in one place, `BrushModelRenderer.isRefractiveMaterial(material, alpha, worldspawnInfo)`, a pure
  static so it can be unit-tested.
- `TransparentPass` tracks `#sceneColorStale`, set at the start of the pass (the opaque world was just drawn) and
  after every drawn item. Before a refractive item, when stale: copy color (and depth, which the same items sample),
  hand the textures to the brush renderer, clear the flag.
- **Granularity:** one copy per contiguous run of refractive items, not per item. Within a run, a refractive surface
  does not see another refractive surface behind it (water seen through water, glass seen through glass). Copying per
  item would fix that at one full-screen blit per chain, which is too much on liquid-heavy maps. The decision of
  where to copy is a pure static, `TransparentPass.PlanSceneCopies(items, isRefractive): boolean[]`, testable without
  GL like `Compare`.
- The kind switch has to handle a run boundary inside one kind: a refractive turbulent chain followed by an opaque
  one stays in the same GL kind, so the copy happens between draws without ending the kind (the copy rebinds the
  scene target; the program, VAO and blend state survive a blit, and the textures are re-bound after it).

### C. Water (`turbulent.frag`, `turbulent.vert`, `BrushModelRenderer`)

- New uniforms `uRefraction` (strength: `_qs_waterrefraction` times `r_refraction`, 0 = off for this draw) and sampler `tSceneColor`, `tSceneEmissive` (8 → 10
  samplers, well within budget).
- Offset: the gradient of the same `sin` waves the texture warp uses (analytic, so no extra texture), turned into a
  screen-space offset and scaled by `uRefraction / linearDepth` so distant water does not shimmer more than near water.
- Foreground rejection: sample `tDepth` at the offset UV; if it is closer than the surface, use the unshifted UV.
- Composition: `refracted = mix(sceneColor(uv'), litWaterColor, effectiveAlpha)`, output with alpha 1 (the water
  fully replaces the pixel because it now contains what is behind it). The `_qs_waterfog` depth fog uses the depth
  at the refracted UV, which keeps the edge of the fog aligned with the distorted bottom.
- Emissive: `mix(sceneEmissive(uv'), surfaceEmissive, effectiveAlpha)`, alpha 1, so bloom from lava behind the water
  is refracted rather than erased.
- Where blending stays: when `uRefraction` is 0 the shader runs the current path unchanged, alpha-blended.
- The same per-draw switch is used in `_renderWorldTurbulentBatch` and `_renderTurbulentSurfaces`. The brush-entity
  path does not bind `tDepth` today (so entity water also has no depth fog); it gets the same bindings as the world
  path, which also fixes that.
- Camera in the liquid: refraction stays on. The depth fog keeps its `uCameraInside` switch (the underwater fog
  effect covers that case), but the refracted sample is used either way.

### D. Glass (`MF_REFRACT`)

- `MaterialFlags.MF_REFRACT = 32`; `QSMatLoader` already maps flag names, so the qsmat side is the enum entry plus
  docs. A refracting material is still drawn translucent: `MF_TRANSPARENT` or entity alpha < 1. `MF_REFRACT` on an
  opaque surface does nothing (logged once at load in development builds).
- New program `brush-refract`. `brush.frag` cannot take two more samplers with room to spare (see Context), so:
  - move the body of `brush.frag` into a chunk (`include/brush-surface.glsl`) that returns the lit color and emissive,
    and keep `brush.frag` a thin entry that writes them, as before;
  - `brush-refract.frag` includes the same chunk, drops all four shadow samplers (glass passes light through and
    receives no shadows) and adds `tSceneColor`, `tSceneEmissive`, `tDepth` (14 − 4 + 3 = 13 samplers).
- Offset from the material's tangent-space normal map (the `tNormal` path that already exists), projected to screen
  space; foreground rejection and composition as in C, with the texel alpha as the mix factor.
- Without a normal map the glass is flat and shows no distortion. That is physically correct for flat glass, and
  documented in `docs/qsmat-format.md`.
- Drawing: transparent world leafs currently draw all transparent materials of a leaf with one program. Refractive
  materials move to their own items (`TransparentKind.RefractiveWorldLeaf`, ranked next to `WorldLeaf`), so a leaf
  with both a grate and a window becomes two items and neither switches programs mid-leaf. Brush entities with alpha
  switch to `brush-refract` per chain in `_renderTransparentSurfaces`.

### E. Scene capture request (`R.ts`)

`PreRenderScene` also requests capture when `r_refraction` is on and the map has an `MF_REFRACT` material (a flag
computed once at load on the `BrushModel`), so glass refracts on maps without turbulents or fog volumes. Water
needs nothing new: turbulents already request capture.

### F. Configuration and docs

- `r_refraction` (archived, default `1`): `0` off; any other value scales the strength. Conventions in
  `docs/console.md`.
- `BSP.ts` worldspawn info gets `_qs_waterrefraction?: string`, parsed as a number; anything not a positive number
  is off.
- Docs: `docs/qsmat-format.md` (`MF_REFRACT`, normal map requirement, example), `docs/volumetric-fog.md` or a new
  `docs/refraction.md` for `_qs_waterrefraction`, `docs/post-process-effects.md` for `copySceneColor` and the copy
  scheduling, the `PostProcess` class JSDoc.

## Phasing

All phases ship in this pass; each ends with typecheck, lint and tests green and is a checkpoint for review.

1. **Infrastructure:** `copySceneColor`, `colorCopy` target, `r_refraction`, `PlanSceneCopies` and the stale tracking
   in `TransparentPass` (wired, but with no refractive items yet nothing is copied). Frame graph shows no new pass on
   existing maps.
2. **Water:** `_qs_waterrefraction`, `isRefractiveMaterial`, turbulent shader and bindings in both the world and
   brush-entity paths.
3. **Glass:** `MF_REFRACT`, the `brush-surface.glsl` chunk split, `brush-refract`, `RefractiveWorldLeaf`, the brush
   entity path, the capture request, docs.

### What actually shipped in Phase 1

- `PostProcess.colorCopy` (`scene-color-copy`, two linear color textures, no depth), resized with the scene and freed
  on shutdown, and `PostProcess.copySceneColor()`. It returns the target rather than a pair of textures:
  `colorTexture(0)` is the color, `colorTexture(1)` the emissive, and there is nothing to allocate per call. Both
  attachments go through `_resolveMSAAColorAttachment`, whose JSDoc now says it copies any color attachment and
  only resolves when the source is multisampled; the copy puts its attachments back and restores the read buffer of
  the source afterwards. The frame graph records the pass with the scene color and emissive as inputs.
- `r_refraction` (archived, default `1`) in `RendererCvars`, registered last.
- `TransparentPass.PlanSceneCopies(items, isRefractive, copyBefore)`: one copy before each run of refracting items.
- **Deviation:** `TransparentPass.Render` does not call it yet. With no refractive item there is nothing to decide,
  and a predicate that always answers false would be a stub; Phase 2 wires it together with the first real
  predicate.
- Tests: `test/renderer/post-process-color-copy.test.ts` (blits, attachments restored, MSAA source, never a scene
  texture) and `PlanSceneCopies` in `transparent-sorting.test.ts`.

### What actually shipped in Phase 2

- `_qs_waterrefraction` (`WorldspawnInfo`), resolved by `BrushModelRenderer.ResolveLiquidRefraction(value, scale)`
  (positive finite number times `r_refraction`, else 0) and set for the pass with `prepareLiquidRefraction(world)`,
  reset with `prepareLiquidRefraction(null)` after it. The plan's `isRefractiveMaterial` became
  `refractsWorldTurbulentChain` and `refractsEntity`, which resolve the alpha exactly as the draw does
  (`MaterialBinder.Emit` + `_getTurbulentMaterialAlpha`); `_setTurbulentDrawUniforms` sets `uAlpha`, the depth fog
  and `uRefraction` from that alpha for the world and the entity path alike, so the predicate and the shader cannot
  disagree about whether a copy is sampled.
- `TransparentPass.Render` runs `PlanSceneCopies` with `#isRefractive` and, at a planned item, ends the active kind
  first (so streamed geometry is flushed into the copy), then copies depth and color, then begins the kind. Within
  a kind (a translucent chain after an opaque lava chain) it copies between draws; the program and VAO survive the
  blits, and the copies reuse the textures already bound.
- Shader: the chunk `include/refraction.glsl` (`tSceneColor`, `tSceneEmissive`, `uRefraction`,
  `refractedScreenUV`, `composeRefraction`; includes `depth.glsl`) for Phase 3 to reuse. `turbulent.frag` takes the
  distortion from `cos` of the same phase its texture warp uses `sin` of, shifts at most 0.02 of the screen up close
  and less beyond 64 units, and mixes branchlessly with `step(uRefraction)`. The `_qs_waterfog` depth fog samples the
  depth at the shifted position.
- **Brush-entity liquids were never drawn** (found while wiring them): nothing calls pass 1 for entities, an opaque
  entity skipped its turbulent chains in pass 2, and a translucent one drew them through the opaque vertex array with
  offsets of the turbulent one. Now `rendersTransparentPass` takes entities with liquids, pass 2 skips turbulent
  chains in `_renderTransparentSurfaces` and draws them afterwards with the `turbulent` program and VAO, opaque ones
  writing depth. They also get the depth copy, so `_qs_waterfog` absorption now works on them. Not covered by the
  browser pass (no stock map at hand with a liquid brush entity).
- Sampler hygiene: `_bindTurbulentSceneInputs` / `_unbindTurbulentSceneInputs` in both paths; units 8 and 9 (the
  copies) are the brush shader's `tNormal`/`tDeluxemap` units, put back to the empty texture like `tDepth` on 7.
- Docs: new `docs/refraction.md`, the chunk in `docs/shader-chunks.md`.
- Browser pass (`start`, `e1m1`, software GL, MSAA 0 and 4): no WebGL errors, `scene-color-copy` in the frame graph
  with no violations, `r_refraction 0` and opaque liquids pixel-identical to refraction off, refraction animated.

### Found in Phase 2: translucent liquids are drawn several times

The world builds its turbulent chains per leaf from the leaf's marksurfaces, and Quake lists a face in every leaf it
borders. On `start` one lava face is listed by 22 leafs, many liquid faces by 2 to 5, so every visible duplicate is
blended again: `_lavaalpha 0.5` looks practically opaque (mean difference 0.4/255 from alpha 1). Refraction hides it
by accident, because every duplicate replaces the pixel from the same copy, so the same map looks clearly more
transparent with refraction on than off. This predates refraction and is a separate fix (draw each liquid face once
per frame); it changes how every map with translucent liquids looks.

**Fixed** (decided with the developer: the overdraw was never intended). `_buildWorldModelDisplayLists` packs every
liquid face once, in a batch with the faces of its texture that the same set of leafs lists; each of those leafs
refers to the one batch (`cmds` and `turbulentChains` hold the same objects), and `getWorldTurbulentChains` hands a
batch out once per call. A face cannot simply belong to one leaf: on a map compiled without transparent water the
view from the air sees only the air leaf, from inside only the water leaf. The world's dead per-leaf liquid paths
(`renderWorldTurbolents`, `renderWorldTurbulentLeaf`, `getWorldTurbulentLeaves`, world pass 1) are gone. Browser
pass against the previous build: `_lavaalpha 0.5` without refraction is now one 50% layer and matches the refracted
view (mean difference 0.02 to 0.08), opaque liquids are unchanged from above and below (0.02 to 0.06), and the lava
view on `start` went from 68 to 41 draw calls.

**Same problem left for Phase 3:** translucent world surfaces that are not liquids (`{` fences, MF_TRANSPARENT
qsmat materials, the glass of Phase 3) sit in the per-leaf opaque chains and are drawn once per visible listing leaf
by `renderWorldTransparentLeaf`. The `RefractiveWorldLeaf` items of design D have to be built the same way as the
liquid batches (packed once, shared by the listing leafs, handed out once per frame), and the plain transparent
world leafs should move to it too.

### What actually shipped in Phase 3

- `MaterialFlags.MF_REFRACT = 32`, set by qsmat (`QSMatLoader` resolves flag names through the enum, nothing else to
  change there). Glass refracts with strength `r_refraction`, no worldspawn key. The flag on liquids does nothing:
  liquids follow `_qs_waterrefraction` (the plan had "or the material has `MF_REFRACT`"; dropped, one rule per kind
  of surface is easier to explain).
- Shaders: `brush.vert` became the chunk `brush-vertex.glsl` (`emitBrushVertex()`), shared with `brush-refract.vert`.
  The fragment stage became `brush-fragment-inputs.glsl` and `brush-shading.glsl` (`shadeBrushSurface(shadow,
  pointDlight, ...)`, `pointLightAttenuation()`); `brush.frag` keeps its shadow sampling and calls it.
  `brush-refract.frag` passes shadow 1 and the unshadowed point lights (the developer: glass lets the light through,
  so no shadows, but dynamic lights still light it) and takes the distortion from the normal map's xy.
  Browser pass: `capture.mjs` before/after on `start`, three captures a side, no view flagged and 0 differing pixels
  outside the noise mask in every view that could be masked.
- Sampler units: `brush-refract` lists `tShadowMap` at index 10 although it does not sample it, so the scene copies
  land on 11 to 13. WebGL rejects a draw whose 2D shadow sampler finds a texture without compare mode, and 10 is
  `brush`'s; on 11 to 13 the other programs only have cube shadow samplers, which read another target. The copies
  are put back to the empty texture after the pass (`_unbindSceneInputs`, renamed from the turbulent-only version).
  Verified in the browser: with shadows and point shadows on, the units `brush` reads are identical before and after
  a glass draw.
- World translucent surfaces (`MF_TRANSPARENT`, not liquids) left the per-leaf opaque chains: they are packed once in
  batches shared by their leafs (`WorldRenderState.transparentBatches`), like the liquids, with the vertex layout
  of the opaque surfaces factored into `#pushOpaqueVertices`. `WorldTurbulentChainInfo` is now `WorldSurfaceBatch`.
  `TransparentKind.WorldLeaf` became `WorldSurface` (one item per batch instead of per leaf, sorted by tight bounds)
  plus `RefractiveWorldSurface` for the batches that refract, drawn by `beginWorldRefractivePass`. The dead world
  pass-2 path (`renderWorldTransparent`, `getWorldTransparentLeaves`, `renderWorldTransparentLeaf`) is gone.
- Brush entities: `_renderTransparentSurfaces(..., refractive)` runs twice in pass 2 when the entity has refracting
  glass, the second time with `brush-refract`; glass therefore does not see the entity's other translucent surfaces
  through itself. A material that is not PBR gets the flat normal map bound, so it never bends by accident.
- `R.PreRenderScene` requests the scene capture when `r_refraction` is on and the map has an `MF_REFRACT` material.
- Browser pass on brush-entity glass built in the page (no qsmat file): flat normal = plain alpha blend (0.3/255),
  `r_refraction 0` identical (0.03), a wavy normal map bends what is behind the pane, a monster in front stays crisp;
  MSAA 0 and 4, no frame violations or WebGL errors. Not covered: the qsmat file path itself, and the bending of
  world glass in numbers (the test pane stood in front of animated sky).

## Testing

- `PlanSceneCopies`: copies before the first refractive item, not again within a run, again after any non-refractive
  item, none when no item is refractive.
- `isRefractiveMaterial`: opaque liquid with the key set → no; translucent liquid without the key → no; with it → yes;
  `MF_REFRACT` translucent → yes; `MF_REFRACT` opaque → no; `{` grate without the flag → no.
- `QSMatLoader`: `MF_REFRACT` in `flags` sets the bit (extend the existing flag test, if there is one).
- `TransparentPass.Collect`: a leaf with a grate and a refractive window yields one `WorldLeaf` and one
  `RefractiveWorldLeaf` item.
- Shader compile coverage through the existing program tests, if they cover new programs.
- **Browser pass** (`browser-ui-verification`): a map with translucent water and `_qs_waterrefraction 1`, plus a test
  `.qsmat.json` with `MF_REFRACT` and a normal map on a window texture. Check distortion, no foreground bleeding at
  the water edge with a monster half in the water, MSAA on/off, `r_refraction 0` identical to today, and
  `r_framegraph` showing the copies with no violations.

## Open questions

None; the three raised with the plan (camera underwater, strength, glass shadows) are settled under Decisions
already made.

### Performance pass (2026-10-28)

Measured on the developer's machine (AMD Radeon 890M, integrated; Chromium headless on ANGLE/Vulkan), map `start` with
every liquid at alpha 0.5 and `_qs_waterrefraction 1`, 1920×1080, GPU time of the scene from a timer query between
`PostProcess.begin` and `end` (harness kept out of the repo). The cost was the copies, not the shader: turning the
color blits into no-ops took the spawn view from +2.7 to +1.0 ms over refraction off, and timing the copies alone gave
0.2 ms per color copy (color and emissive) and 0.3 to 0.5 ms per depth copy at MSAA 4. Every refracting run made one
color copy and two depth copies (`TransparentPass` and again `_bindTurbulentSceneInputs`), and every restart of the
turbulent kind another depth copy, refraction or not: up to 8 color and 16 depth copies a frame.

- **Depth copy shared by the pass:** `PostProcess.sceneDepthCopy()` copies only when stale (frame begin,
  `TransparentPass.Render`, `invalidateSceneDepthCopy()` from an opaque liquid in `_setTurbulentSurfaceState`). One
  depth copy a frame on `start`.
- **No emissive copy:** a refracting surface blends its emissive with its own alpha over the unshifted emissive
  (blending is per attachment, so the color still replaces the pixel). Deviates from "the emissive buffer is refracted
  too": bloom behind a refracting surface is kept but not shifted. Not visible on `start` (nothing emissive behind
  its liquids), unverified in a scene that has it.
- **`r_refraction_distance`** (archived, 1024; the developer's idea): strength fades over the last quarter, nothing
  farther refracts or gets a copy. `TransparentPass` hands the sort distance to `BrushModelRenderer.setRefractionDistance`
  before checking or drawing an item, so the copy plan and the uniform agree.
- **Not done:** a lower-resolution color copy. A multisampled source cannot be scaled by the resolving blit, and once
  the count was down a copy was 0.1 to 0.2 ms.
- **Not done, dismissed as low yield (2026-10-29):** copying only the screen rectangle the refracting items of a copy
  cover (their projected bounds, padded by the largest shift of the group, full screen when a corner is behind the
  camera, the shader clamping to the copied rectangle). It would save at most the 0.1 to 0.2 ms of each color copy,
  scaled by the area no longer copied: most for a small or distant surface, nothing for a liquid that fills the
  screen. Worth revisiting only if a measurement shows the copies are most of what refraction still costs.

### Second optimization pass (2026-10-29)

Done ahead of bigger maps, not measured on a GPU (the session renders on SwiftShader); both are pixel-identical.

- **Visible leafs instead of every leaf:** `Visibility.MarkLeafs` lists the leafs it stamps in
  `WorldRenderState.visibleLeafs` (sorted by index, so the draw order is the one the full scans had), rebuilt only when
  the view leaf changes. The opaque world, the batch collection of liquids and translucent surfaces (twice a frame),
  the underwater boundary depth and the sky walk that list instead of skipping through every leaf of the map. The
  boundary depth pass now goes through the deduplicated, frustum-culled liquid batches too, instead of every listing
  leaf's copy of a batch. `SkyDrawContext.visframecount` became unused and is gone. The shadow passes still walk
  every leaf: their casters are not limited to what the view sees.
- **Uniform branch in `turbulent.frag`:** the refraction reads (depth at the shifted position, scene color) are skipped
  with `if (uRefraction > 0.0)` instead of computed and mixed away, so opaque liquids and maps without refraction
  no longer pay them. The `shader-chunks` skill now names this exception to its branchless rule.
- Browser pass (`start`, production builds of `13f916e` and the change, plain, `CAPTURE_WATERFOG=1`, and refracting
  liquids with the clock frozen): identical draw counts in every view, the sky and liquid views 0 pixels apart outside
  the HUD text, the opaque views apart only by the light flicker two captures of one build also show; no WebGL
  errors, no frame violations.
- Left for a CPU profile on a big map: every refracting item resolves its material alpha twice (copy plan and draw).

| View (scene GPU ms) | MSAA | on, before | on, after | off, before | off, after |
|---|---|---|---|---|---|
| spawn | 4 | 7.11 | 4.80 | 4.46 | 3.91 |
| liquid at 64 units | 4 | 10.96 | 5.82 | 5.77 | 4.28 |
| liquid at 400 units | 4 | 11.18 | 2.69 | 3.92 | 1.73 |
| spawn | 0 | 4.31 | 2.97 | 2.61 | 2.22 |
| liquid at 64 units | 0 | 6.40 | 3.43 | 3.43 | 2.46 |
| liquid at 400 units | 0 | 6.84 | 1.69 | 2.72 | 0.79 |

Browser pass (SwiftShader, `start`, MSAA 0 and 4, time pinned): spawn and 64-unit views bit-identical before/after,
`r_refraction 0` identical everywhere, differences only on liquids 830 to 990 units away (inside the fade).

### Third optimization pass: glass (planned, 2026-10-31)

Refraction costs a noticeable frame rate on glass-heavy maps. Everything here is proposed, nothing is implemented; the
numbers come from prototypes in a scratch copy of the tree.

#### Context

Measured on the developer's machine (AMD Radeon 890M, Chromium headless on ANGLE/Vulkan, production build, 1920x1080,
GPU time of the scene from a timer query between `PostProcess.begin` and `end`), map `hw_doom`, from the spot the
developer picked (origin `190.9 -985.3 24.8`, angles `1.3 335.3 -0.2`) and four views built around its panes. Player
placed at the view, see C: the panes are entities, and moving only the camera leaves them out.

`hw_doom` has 75 glass faces, all in 9 `func_wall` brush entities, none in the world. `TransparentPass.SharesCopy` gives
every brush entity its own copy, so the count of glass entities in the PVS sets the count of copies.

| View (MSAA 4, scene GPU ms) | Copies today → culled | Off | Today | Today, color copies skipped | Culled | Culled + rectangle |
|---|---|---:|---:|---:|---:|---:|
| spot (3 rounds) | 6 → 3 | 7.3–8.0 | 9.2–9.5 | 7.6 | 8.1–8.5 | 7.4–8.2 |
| `300 -1000 70`, yaw 180 (pane fills the screen) | 3 → 1 | 7.1–7.2 | 7.9 | 6.5 | 7.0 | 6.9 |
| `570 -930 70`, yaw 90 (two strips of pane, whole-screen rectangle) | 3 → 2 | 9.0 | 9.5 | 9.0 | 9.2 | 9.5 |
| `420 -1000 70`, yaw 135 | 3 → 1 | 6.8–6.9 | 8.1 | 6.7 | 7.2 | 7.1 |
| `200 -1050 70`, yaw 25 | 6 → 2 | 7.6–7.7 | 9.9 | 7.4 | 8.6 | 8.2 |

The spot at MSAA 0 (2 rounds): off 6.0–6.4, today 7.2, culled 6.2–6.3, culled + rectangle 5.8–6.0.

Noise is about 0.4 ms between runs of an identical plan and up to 0.7 ms for one setting within a run, so only
differences above that mean anything in a single row. The rows agree on the direction.

- **The copies are the whole cost.** With the color copies skipped, refraction is at or below refraction off in all
  five views, also with a pane filling the screen: `brush-refract` drops the shadow samplers `brush` pays for. The
  fragment shader needs no work. "Skipped" keeps the shader and its samples, reading a stale copy.
- **Half the copies are for glass that is not on the screen.** `TransparentPass.Collect` takes every brush entity of
  the visible list, the copy plan asks `refractsEntity`, and the frustum check only comes later, in
  `BrushModelRenderer.render`. A pane behind the camera costs a full-screen copy and draws nothing. At the spot,
  `*37`, `*38` and `*39` are such panes.
- **A full copy costs about 0.25 to 0.45 ms here,** about double the 0.1 to 0.2 ms taken on `start`. Why is not measured.
- This meets the condition the 2026-10-29 note set for revisiting rectangle copies: copies are most of what refraction
  still costs, and panes are usually small on the screen.
- Refraction adds 0.5 to 2.3 ms here. FPS was not measured (the page is capped near 60), but 1 ms is 9 FPS at 100 FPS
  and 2.3 ms is 19, so this fits the 10 FPS the developer sees.

#### Goals

- At the five views, refraction on costs at most 0.5 ms over refraction off at MSAA 4.
- No change in the picture: both phases are meant to be pixel-identical.

#### Non-goals (this pass)

- **Shader work** on `brush-refract`: measured above, nothing to gain.
- **Sharing a copy between panes that do not overlap on the screen.** The prototype removed no copy in the five views.
  It treated fog volumes as full-screen, so it may undersell itself, but rectangle copies leave it little to win.
  Worth a measurement only on a map with glass in the world, where particles between two batches do break a run. No
  such map was measured: `hw_doom` had 413 particles in one frame at the spot, but its glass is in entities, which copy anyway.
- Occlusion queries for glass in the frustum behind a wall.
- Tighter bounds per chain: `*32` wraps around the camera at the spot, so its rectangle is the whole screen, but it
  also covers much of it.
- A new player setting: `r_refraction_distance` is saved and can already be turned down, `r_refraction` stays a cheat.

#### Design

##### A. Brush entities out of view leave the pass (`BrushModelRenderer`)

- Move the two `Camera.CullBox` branches of `render()` into `isEntityInView(clmodel, entity)`, on scratch vectors instead
  of the two `new Vector` per call. `render()` uses it for its passes.
- `rendersTransparentPass` returns false for an entity out of view. `TransparentPass.Collect` is its only caller, so
  the entity gets no item: no sort, no copy, no `setupRenderState(2)`. The check goes last, after the cheap ones.
- An out-of-view item can no longer split a run. Two groups of world glass with such an entity between them now share
  a copy, the accepted behavior within a run. No such case exists in `hw_doom`.

##### B. Copy only the rectangle the refracting items need (`PostProcess`, `TransparentPass`, `Camera`)

- `Camera.ScreenBounds(mins, maxs, out)`: projects the 8 corners into 0..1 of the view, whole screen when a corner is at
  or behind the near plane. Refraction only runs in the capture path, where the viewport starts at 0,0 and the
  target has the size of the view (`R.SetupGL`), so 0..1 times `PostProcess.width` and `height` are the pixels.
- `BrushModelRenderer`: `refractsWorldBatch`, `refractsWorldTurbulentChain` and `refractsEntity` become strength
  getters (0 = does not refract, an entity answers for its strongest chain), so the plan and the padding cannot
  disagree. `TransparentPass.#isRefractive` is the same question, `> 0`.
- `TransparentPass.PlanCopyRects(items, copyBefore, rectOf, rects)`, a pure static beside `PlanSceneCopies`: every copy
  gets the union of the rectangles of the items that use it, including later items of its run, each padded by
  `REFRACTION_MAX_SHIFT` times its strength. Strength has no upper limit (`_qs_waterrefraction`, material `refraction`,
  `r_refraction`), so the padding reads it instead of assuming 1. Only refracting items get a rectangle, on reused
  arrays. Liquids take the same path and gain too.
- `PostProcess.copySceneColor(rect)` blits that rectangle, floor and ceil to whole pixels, same rectangle on both sides as
  a multisampled source requires. `null` is the whole screen. The JSDoc states that outside the rectangle the copy
  holds an old frame.
- `REFRACTION_MAX_SHIFT` then lives in `refraction.glsl` and in TypeScript. A test reads the chunk and compares them.
  No clamp in the shader: correct padding makes one unnecessary, and it would cost a uniform.

##### C. Measurement in the repo (`scripts/renderer-capture/`)

The harness was rebuilt for each pass. `gpu-bench.mjs` keeps it: real GPU, timer query around the scene, copy counts,
named views. `docs/browser-verification.md` gets the trap that produced a wrong first measurement here: `camera_override`
moves only the view, the server keeps sending the entities of the player's position, so brush entities at the view
are missing without an error. Load with `?serverthread`, then `noclip` and `setOrigin` on the player's edict.

#### Phasing

Each phase ends with typecheck, lint and tests green, and is a checkpoint.

0. **Bench:** `gpu-bench.mjs` with the five views, the doc section, and a baseline for the record.
1. **Cull (A):** expected to reach 0 to +1.0 ms over off, the larger part of the win, for a small diff.
2. **Rectangle copies (B):** expected to reach about 0 to +0.6 ms. Most of the gain is where panes are small on the
   screen, none where the bounds of a pane cover it. If Phase 1 already meets the goal, this one is optional: it adds the most
   code of the pass and a duplicated constant.

##### What actually shipped in Phase 0

- `scripts/renderer-capture/gpu-bench.mjs`, documented in `docs/browser-verification.md`, section 9. The views and what
  to compare are in a bench file (`views/hw_doom-glass.json`) rather than in the script, so the script stays free of
  any one game. It warns on software GL and at a view where no setting made a color copy.
- The file server and the console typing of `capture.mjs` moved to `harness.mjs`, shared by both. `capture.mjs` ran
  end to end after the move (`hw_test_gameloop`, nine views).
- The bench is steadier than the prototypes, which is why it was worth having: rounds agree within about 0.1 to 0.2 ms
  at MSAA 4, not the 0.4 to 0.7 ms of the Context table. Differences of a phase are read against this table.

Baseline (`d1ff5b9`, scene GPU ms, range over 2 rounds, color copies with refraction on):

| View | MSAA 4 off | MSAA 4 on | Copies | MSAA 0 off | MSAA 0 on |
|---|---:|---:|---:|---:|---:|
| spot | 8.00–8.09 | 9.36–9.37 | 6 | 5.93–6.04 | 6.83–7.03 |
| pane-fills-screen | 7.16–7.23 | 7.57–7.60 | 3 | 5.75–6.00 | 5.88–6.09 |
| pane-strips | 8.97–8.98 | 9.42–9.48 | 3 | 7.31–7.45 | 7.93–7.94 |
| two-panes | 6.99–7.04 | 7.89–8.06 | 3 | 5.32–5.70 | 5.92–6.49 |
| through-glass | 7.78–7.86 | 9.37–9.40 | 6 | 5.66–5.79 | 6.59 |

#### Testing

- `isEntityInView` and `rendersTransparentPass`: an entity behind the frustum gets no item and no copy, in
  `TransparentPass.Collect`. This is the regression that would quietly bring the cost back. The existing
  `rendersTransparentPass` tests need a frustum that contains their entity.
- `PlanCopyRects`: the union over a run, padding by strength, a strength of 2 pads twice as far, a rectangle per copy
  when the owner changes, the whole screen when `ScreenBounds` says so.
- `Camera.ScreenBounds`: a box in view, a box crossing the near plane, a box partly off-screen is clamped.
- `copySceneColor(rect)` in `post-process-color-copy.test.ts`: the blit arguments with and without MSAA, whole pixels,
  `null` copies everything.
- The constant in TypeScript equals the one in `refraction.glsl`.
- **Browser pass** (`browser-ui-verification`): before/after at the five views with the clock frozen. Pixel-identical,
  with `gl_msaa` 0 and 4, `r_framegraph` without violations, and at Phase 2 a material with `refraction` 2 at a pane
  edge, where wrong padding shows as a seam of old pixels.
- `gpu-bench.mjs` before/after on the developer's machine for each phase, recorded here.

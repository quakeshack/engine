# Screen-space refraction for translucent liquids and glass

**Status:** Phases 1 and 2 shipped (2026-10), and the duplicate liquid draws found in Phase 2 are fixed; Phase 3 (glass) next. Water and glass ship together in this pass.

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

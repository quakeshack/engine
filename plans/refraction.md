# Screen-space refraction for translucent liquids and glass

**Status:** Planned (2026-10), forks settled, Phase 1 next. Water and glass ship together in this pass.

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

# Screen-space reflections for a more realistic specular

**Status:** Parked (2026-11-07). Assessment only, nothing started. Pick it up with Phase 0; Phase 2 needs its own
design round (`plan-first-workflow`) and a measured cost before it is committed to.

## Context

- **Specular is simple.** `include/brush-shading.glsl` does Blinn-Phong with a fixed exponent of 16, scaled by the
  `.r` channel of the material's `specular` map, lit by the baked lightmap directions (deluxemap) and one dynamic
  light. There is no roughness and no environment term.
- **Forward, LDR scene.** `PostProcess.scene` is RGBA8 color plus emissive (two MRT outputs) and a depth texture,
  `gl_msaa` 4 by default (`PostProcess.msaaTarget`). There is no normal buffer. Gamma and fog are applied per shader,
  so the color buffer is final display color.
- **Draw order** (`R.RenderScene`): sky, view model (`depthRange(0, 0.3)`), opaque world, opaque entities,
  `TransparentPass`.
- **Refraction built the infrastructure** (`plans/refraction.md`, `docs/refraction.md`): `PostProcess.copySceneColor`,
  `PostProcess.sceneDepthCopy`, `linearizeDepth`/`uPerspective` in `include/depth.glsl`, copy planning in
  `TransparentPass`. Measured: about 0.2 ms per color copy, 0.3 to 0.5 ms per depth copy at MSAA 4, 1080p.

## Phases

### Phase 0: material data

- Add `roughness` to `.qsmat.json` (scalar, optionally the `.g` channel of the specular map) and maybe
  `reflectivity`; document in `docs/qsmat-format.md`.
- Derive the Blinn-Phong exponent from roughness instead of the fixed 16. Improves specular on its own, no frame
  cost, and every later phase needs it.

### Phase 1: reflections on liquids and glass

- `turbulent.frag` and `brush-refract.frag` already sample the scene color and depth copies: march the reflected
  view ray in screen space in a new `include/reflection.glsl` (linear steps, binary refinement, fade at screen edges
  and for low-confidence hits). Water normal = up plus the warp slope, glass = its normal map.
- Fresnel weights reflection against refraction: grazing water reflects, looking straight down refracts.
- `TransparentPass.PlanCopyRects` grows copies only by `REFRACTION_MAX_SHIFT`; reflecting items need a full-screen
  copy (`rect = null`).
- No new targets, no MSAA work. Cvar to turn it off, off = identical to today.

### Phase 2: reflections on opaque surfaces (needs its own design round)

- **G-buffer attachment:** a third MRT output with an octahedral-encoded normal (normal maps show), specular and
  roughness. Every program drawing into the scene writes it (about 12: alias, mesh, player, character, sky, sprite,
  decal, ...), because an output a shader does not write is undefined in GLES3. Decals blend toward specular 0.
- **MSAA:** a third renderbuffer and its resolve in `PostProcess.resolveMSAA`; about +33 MB at 1080p MSAA 4 plus
  8 MB resolved.
- **Pass between opaque and `TransparentPass`:** depth copy, color copy with mips (roughness picks the level, no TAA
  to hide noise), half-res march, additive composite weighted by Fresnel times specular, fogged by the surface depth.
- **View model:** it sits in the depth buffer near the near plane, so floors would reflect the gun. Mark it as not
  reflectable in the attachment or draw it after the pass.
- **Cost guess, not measured:** 1.5 to 3 ms on an integrated GPU at 1080p. Measure with
  `scripts/renderer-capture/gpu-bench.mjs` before deciding.

## Known limits

- Only what is on screen reflects: things behind the camera, occluded or off-screen fade out.
- No reflection probes. Rays ending in sky take the sky color, other misses reflect nothing. Per-leaf cubemap probes
  would be a separate project.
- Only materials with a qsmat specular map (and roughness) benefit; stock textures look as before.

## Open questions

- Phase 2 attachment layout (RGBA8 octahedral normal + spec + roughness vs. RGBA16F) and whether it can share an
  existing attachment.
- Composite into the MSAA target directly or after the resolve.
- Whether a sky-color fallback for missed rays looks right on indoor maps.

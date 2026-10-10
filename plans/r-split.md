# Split `R.ts` into renderer subsystems

Track D2 of `plans/engine-architecture-modernization.md`. Status: **plan agreed, all open questions settled
(2026-10-10); Phases 0 and 0b are done, committed, and wait for a go-ahead for Phase 1.** The renderer files have
moved into their folders; no class has been extracted yet.

## Context

`source/engine/client/R.ts` is about 3540 lines and 155 static members. It is the one-per-tab renderer facade
(Phase 4 fork 1 kept it a static class on purpose), and over the years it collected everything that touches the
frame: view state, PVS marking, light sampling, dynamic lights, the CPU lightmap atlas, particles, decals, the
transparent pass, cvars, default textures and the shader program table.

What is already split off and works as the model for this plan: `BrushModelRenderer`, `AliasModelRenderer`,
`SpriteModelRenderer`, `MeshModelRenderer` (behind `ModelRendererRegistry`), `PostProcess` + effects, `ShadowMap`,
`SkyRenderer`, `Materials`, `ShaderLibrary`/`ShaderPreprocessor`, and the groundwork `LightmapAtlas.ts`
(constants only) and `RenderContext.ts` (the leaf that lets `Materials`/`Sky` run headless, which this plan removes).

### What R.ts contains

| Concern | Lines | Main members |
|---|---|---|
| Particles (pool, effects, collision, serialize, draw) | ~650 | `ptype`, `particles`, `AllocParticles`, `ParticleExplosion`, `RocketTrail`, `ResolveParticleCollision`, `SerializeParticles`, `_renderAndAdvanceParticle` |
| Decals | ~120 | `decals`, `PlaceDecal`, `DrawDecals`, `_emitDecalQuad` |
| Light sampling (lightmap, lightgrid, deluxemap) | ~420 | `LightPoint`, `RecursiveLightPoint`, `LightPointFromGrid`, `SampleLightgridPoint`, `_SampleDeluxemapDirection` |
| Per-entity lighting and smoothing | ~170 | `_CalculateLightValues`, `_SmoothLightValues`, `GetEntityLightSamplePoint` |
| Lightstyles | ~60 | `lightstylevalue_a/b`, `AnimateLight`, `GetLightstyleInterpolation`, `GetTextureInterpolation` |
| Dynamic lights (marking, atlas update, coronas) | ~250 | `MarkLights`, `PushDlights`, `AddDynamicLights`, `RemoveDynamicLights`, `RenderDlights` |
| CPU lightmap atlas | ~220 | `AllocBlock`, `BuildLightMap`, `BuildLightMapEx`, `BuildLightmaps` |
| View state (refdef, frustum, matrices, culling) | ~330 | `refdef`, `vpn/vup/vright`, `SetFrustum`, `CullBox`, `Perspective`, `WorldToScreen` |
| Per-program frame uniforms | ~85 | the loop at the end of `Perspective()` |
| PVS marking | ~90 | `MarkLeafs`, `RecursiveWorldNode`, `viewleaf`, `visframecount` |
| Transparent pass and entity drawing | ~430 | `_renderTransparentsUnified`, `compareTransparentItems`, `DrawEntitiesOnList`, `DrawViewModel` |
| Scene orchestration | ~170 | `PreRenderScene`, `RenderScene`, `RenderWorld`, `RenderView`, `SetupGL` |
| Fog (incl. underwater) | ~110 | `NewMapFog`, `#nearestLiquidFogTint`, the underwater block of `PreRenderScene`, 7 fog cvars |
| Default textures, shader table, cvars, init, map change | ~440 | `InitTextures`, `InitShaders`, `Init`, `NewMap`, `ClearAll` |
| Stats and `r_speeds` | ~50 | `c_brush_*`, `c_alias_polys`, `_speeds`, `PrintSpeeds` |
| Sky facade | ~55 | `skyrenderer`, `drawsky`, `MakeSky`, `DrawSkyBox` |

### Who reaches into R today

About 30 files outside `R.ts`. The surface is narrower than the raw `R.` count, because some hits are the `R.ts`
import path or JSDoc mentions (`source/shared/*` only mentions `R.SerializeParticles` in comments):

- **Renderers read back into R** (the real coupling, a cycle R → renderer → R): `BrushModelRenderer` uses
  ~26 distinct members (lightmap/lightstyle/shadow textures, `CullBox`, `visframecount`, `LightPoint`,
  `_CalculateLightValues`, the interpolation getters, ~30 counter increments). `AliasModelRenderer` and
  `MeshModelRenderer` use `_CalculateLightValues`, `CullBox`, shadow textures, `notexture`, `c_alias_polys`.
  `Sky.ts` uses shadow textures, `visframecount`, `CullBox`, `refdef`, `bloomSkyStrength`.
  `BloomEffect`, `UnderwaterFogEffect` read their own cvars and state off `R`.
- **Frame owners**: `V.ts` (37 `refdef` writes/reads, drives `PreRenderScene`/`PushDlights`/`RenderView`),
  `SCR.ts` (20 `refdef`, `perspective`, `RenderView`, `PrintSpeeds`, `PolyBlend`), `Chase.ts`, `ClientHost.ts`.
- **Effect spawners**: `ClientServerCommandHandlers` (particle effects, `NewMap`), `ClientLegacy` (`RocketTrail`,
  `EntityParticles`), `NavigationDebug`, `ClientEngineAPI` (`WorldToScreen`, `RocketTrail`, `PlaceDecal`,
  `refdef.vrect`), `ClientHost` (`SerializeParticles`).
- **Game-facing**: only through `ClientEngineAPI` (`WorldToScreen`, `RocketTrail`, `PlaceDecal`, `refdef.vrect`).
  None of it changes, so no game module is touched.
- **Tests**: `test/renderer/particle-physics`, `r-sorting` (light sampling and smoothing, `compareTransparentItems`),
  `turbulent-lightstyle-interpolation`, `brush-model-renderer`, `materials`, `test/client/client-entities-savegame`,
  and `test/support/renderer.ts` (`useRendererOf` patches members of the real `R`).
- **Nothing outside R assigns to R state** (checked: no `R.x = ...` outside `R.ts`); `V` mutates `R.refdef` in place.

### Dead members and post-process leftovers (swept 2026-10-10)

Found by counting readers inside and outside `R.ts`, not just outside. Removed:

- `world_depth_texture`: written once in `ClearAll`, never read.
- `dlightvecs`: stored on `R`, never read (the VAO keeps the buffer alive).
- `dowarp`: a per-frame temporary kept as a static, now inline in the `warp` effect's `active` assignment.
- `c_brush_draws_pbr`: reset every frame and printed as `(0 PBR)`, never incremented. The `r_speeds` first line now
  reads `N draw calls`.
- The `// warp` section label above the sky code (a WinQuake file name that survived the warp move) and the
  `This replaces the previous R.WarpScreen / R.warpbuffer implementation` line in `WarpEffect.ts`.

Not dead, although nothing outside `R.ts` reads them (I had listed these wrongly in the first draft): `waterwarp`,
`underwater_fog_density`, `fog_start`, `fog_end` are cvars read inside `R`. They stay.

Still open, handled in the phases: `R.usePostProcess` plus the duplicated "scene capture needed" condition in
`R.SetupGL` and `SCR` (Design E), and one sentence in `docs/post-process-effects.md` that still describes warp and
bloom as outside the effect stack (Phase 7 checks it against the code).

## Decisions already made with the developer

First round (2026-10-10):

1. **New static classes, imported directly** (the `V`/`SCR` shape), not a registry, not instances. Matches
   Phase 4 fork 1: one GL context per tab.
2. **Forwarders are allowed while moving, and removed at the end.** A final phase deletes all of them.
3. **Order:** particles and decals first, lighting second, view state last.
4. **`LightmapAtlas.ts` is the groundwork** for the lightmap subsystem.

Second round (2026-10-10):

5. **Dead members and leftovers are cleaned out**, warp first (done, see above).
6. **Headless needs nothing renderer-related.** `RenderContext` goes away; see Design C.
7. **Ordering contracts that live only in comments are replaced by structure**, inside the phase that moves the
   state, not deferred to the end. See Design E.
8. **graphify is removed** (done): script, skill, instructions, `CLAUDE.md` entries, gitignore line.
9. **Cvars move out of `R` into one module that mirrors `ClientCvars`** (`RendererCvars`), not into the owning
   classes. See Design A.
10. **The renderer directory is organized into subfolders**, including the existing files, in its own mechanical
    step first. See "Directory layout".
11. **No frame graph in this plan.** The depth-sampling feedback-loop trap is the real problem it was meant to
    solve, and it has a smaller fix; see Design F.
12. `GetTextureInterpolation` lives in `Interpolation`; `ShaderPrograms` is a verbatim move now, per-owner program
    registration is a later, separate cleanup.

Third round (2026-10-10), the open questions:

13. **The worker keeps `GL.ts` and the material/sky classes for now.** Only the renderer stand-in goes (Design C). A
    render-data factory for the loaders is not planned.
14. **The depth-sampling fix (Design F) is part of Phase 3.**
15. **The directory layout is confirmed as proposed**, including `Sky`/`SkyBox` in `scene/` and `Materials` in `models/`.
16. **Phase 6 is decided after Phase 5.** Separately, the developer saw wrong draw order for entities with transparent
    brush models; it is recorded under Phase 6 and is deliberately **not** fixed during the pure-move phases, so the
    before/after screenshot pairs stay comparable.

## Goals

- `R.ts` ends as a thin orchestrator: `Init`, `NewMap`, `ClearAll`, `RenderView`, `RenderScene`. Target under 400 lines.
- Every subsystem owns its state, its GL resources and its init/clear, and is importable and testable alone.
- Break the R ↔ renderer cycle: renderers import the subsystem they use instead of the facade.
- No behavior change in any phase. Pixels, particle counts, savegame format, cvar names and console commands stay
  the same.
- A model loader in a server realm needs no renderer object, stand-in or otherwise.
- Hidden ordering contracts become explicit structure.
- Tests for each extracted subsystem (several have none today), converted to `.test.ts` when the module is
  touched, as agreed in Phase 4 fork 3.

## Non-goals (this pass)

- No change to what is drawn, to pass order, or to shaders (shader chunk work is D1, finished).
- No frame graph, no GPU abstraction or WebGPU spike (D3, D4), no uniform buffer objects, no render-thread worker.
- No change to the model renderer interface (`ModelRenderer`, `ModelRendererRegistry`).
- No game-facing API change. `ClientEngineAPI` keeps its surface.
- Not splitting `BrushModelRenderer` (2092 lines). It benefits from this plan (it stops importing `R`) but is its own job.
- Not turning `R` or the new classes into instances.
- Not removing `GL.ts` from the server worker's import closure (decision 13, see Design C).

## Directory layout

Existing files and new files go into subfolders of `source/engine/client/renderer/`. `R.ts` stays in `client/` next
to `V.ts` and `SCR.ts`. No barrel files.

| Folder | Files |
|---|---|
| `models/` | `ModelRenderer`, `ModelRendererRegistry`, `BrushModelRenderer`, `AliasModelRenderer`, `SpriteModelRenderer`, `MeshModelRenderer`, `Mesh`, `Materials` |
| `lighting/` | `LightmapAtlas`, `Lightmaps`, `LightStyles`, `LightSampler`, `EntityLighting`, `DynamicLights`, `ShadowMap` |
| `effects/` | `Particles`, `Decals` |
| `postprocess/` | `PostProcess`, `PostProcessEffect`, `BloomEffect`, `BlurEffect`, `ColorGradeEffect`, `UnderwaterFogEffect`, `WarpEffect` |
| `scene/` | `Camera`, `Visibility`, `Fog`, `FrameUniforms`, `TransparentPass`, `RenderStats`, `Interpolation`, `Sky`, `SkyBox` |
| `programs/` | `ShaderLibrary`, `ShaderPreprocessor`, `ShaderPrograms` |
| `resources/` | `DefaultTextures`, `RendererCvars` (and `RenderContext` until Phase 5 deletes it) |

`programs/` rather than `shaders/` because `client/shaders/` already holds the GLSL sources.

The move is **Phase 0b**: `git mv` plus import rewrites in 28 files outside `renderer/` and the relative imports
inside it, in one commit with no other change, so blame and the later phases stay readable. It happens before the
extractions, so every new file is created in its final place and no import is rewritten twice. It also updates:
`test/common/engine-boundaries.test.mjs` (lists paths), the `shader-chunks` skill, and `docs/shader-chunks.md`,
`docs/post-process-effects.md`, `docs/code-style-guide.md`, `.github/instructions/code-style-guide.instructions.md`
where they name a moved path. Tests stay flat in `test/renderer/` (one level, glob-safe).

## Design

### A. Subsystem map

New classes are static, as in the table. `R` keeps its name and file so `V`, `SCR`, `ClientHost` keep working
while the split lands.

| Class | Owns | Callers outside R today |
|---|---|---|
| `ParticleType`, `Particles` | enum, pool, ramps, `AllocParticles`, all effect spawners, collision, serialize/deserialize, billboard emit and advance, `DrawParticles` fallback | ClientServerCommandHandlers, ClientLegacy, NavigationDebug, ClientHost, ClientEngineAPI, particle-physics test |
| `Decals` | list, `PlaceDecal`, quad emit, `DrawDecals`, the `test_decal` command | ClientEngineAPI |
| `Interpolation` | the interpolation cvar's value, `texture()`, `lightstyle()` | BrushModelRenderer, Materials, tests |
| `LightStyles` | `lightstylevalue_a/b`, their two textures, `animate()` | BrushModelRenderer, tests |
| `LightSampler` | `LightPoint`, `RecursiveLightPoint`, lightgrid octree and trilinear sampling, deluxemap direction | BrushModelRenderer, Decals, r-sorting test |
| `EntityLighting` | sample point, `CalculateLightValues`, smoothing and its constants | Brush/Alias/MeshModelRenderer, r-sorting test |
| `Lightmaps` | `AllocBlock`, `BuildLightMap`, `BuildLightMapEx`, the CPU buffers, lightmap, deluxemap and dlightmap textures, upload | BrushModelRenderer (textures), `R.NewMap` |
| `DynamicLights` | `dlightframecount`, marking, `PushDlights`, `AddDynamicLights`/`RemoveDynamicLights`, coronas, the corona VAO | V, BrushModelRenderer |
| `Camera` | `refdef`, `vpn/vup/vright`, `frustum`, `SetFrustum`, `CullBox`, `perspective`, view/projection matrices, `WorldToScreen` | V, SCR, Chase, ClientHost, ClientEngineAPI, Brush/Alias/Mesh/Sprite renderers, Sky, UnderwaterFogEffect |
| `FrameUniforms` | the per-program uniform upload (view, gamma, fog, shadow, point lights) | `Camera`'s caller only |
| `Visibility` | `viewleaf`, `oldviewleaf`, `visframecount`, `MarkLeafs`, `RecursiveWorldNode`, `skyVisible` (was `drawsky`), the three event subscriptions that reset `oldviewleaf` | BrushModelRenderer, Sky, ClientHost |
| `Fog` | `NewMapFog`, underwater tint selection, `underwaterFogColor/Density` | FrameUniforms, UnderwaterFogEffect |
| `RenderStats` | `c_brush_*`, `c_alias_polys`, `_speeds`, `PrintSpeeds` | Brush/Alias/MeshModelRenderer, Materials, SCR |
| `DefaultTextures` | `notexture`, `blacktexture`, `flatnormalmap`, `null_texture`, `normal_up_texture`, `fullbright_texture`, `renderer.textures.initialized` | Materials, Brush/Alias/MeshModelRenderer |
| `RendererCvars` | every `r_*` and `gl_*` cvar of `R` (see below) | everything that reads one |
| `ShaderPrograms` | the `GL.CreateProgram` table, `renderer.shaders.initialized` | none |
| `SkyBox` | the `SkyRenderer` instance, `make`/`clear`/`draw` | none |
| `TransparentPass` | `TransparentKind`, `compareTransparentItems`, collection, sorted draw | r-sorting test |
| `R` | `Init`, `NewMap`, `ClearAll`, `RenderView`, `RenderScene`, `RenderWorld`, `DrawEntitiesOnList`, `DrawViewModel`, `PolyBlend` | V, SCR, ClientHost, ClientServerCommandHandlers |

**`RendererCvars` mirrors `ClientCvars`** (decision 9): a class of `Cvar` fields initialized to `null!`, one exported
instance, a module that imports only the `Cvar` type so reading a variable never depends on module load order.
`R.Init` creates the cvars exactly as today, in today's order (the order is user-visible in `cvarlist`), and assigns
them. The fields keep today's names (`bloom`, `bloomStrength`, `fog_color`, ...), so a call site changes from
`R.bloom` to `rendererCvars.bloom`. The cvar names, defaults, flags and descriptions do not change. A test pins the
creation order.

Other judgment calls (veto any):

- **`Lightmaps` is a new file; `LightmapAtlas.ts` stays the constants leaf.** The constants module imports nothing
  on purpose (Phase 4b step 2: a constant needed while the renderers evaluate lived in a module that imported `R`).
  A class that imports GL and the client state must not live in it.
- **`DynamicLights` and `Lightmaps` stay two classes.** `DynamicLights` decides which faces a light touches and
  accumulates colors; `Lightmaps` owns the buffers and the GL upload.
- **`BuildLightmaps` is split.** Today it allocates the atlas, builds lightmaps and calls `prepareModel` on the
  renderers in one loop. `prepareModel` needs each face's `light_s`/`light_t` first, so the loop stays in
  `R.NewMap` and calls `Lightmaps.begin()`, `Lightmaps.addModel(model)`, `Lightmaps.upload()`.
- **`DrawViewModel` and `PolyBlend` stay on `R`.** They are pass-shaped and there is nothing to extract.

### B. Dependencies between the new classes

Allowed edges (an arrow means "imports"). The graph is acyclic apart from the unavoidable `R` → everything:

```
Particles      → Camera, clientCollision, GL (stream)
Decals         → LightSampler, Camera (test_decal), Draw
LightSampler   → LightStyles, Interpolation, clientRuntimeState
EntityLighting → LightSampler, V.SmoothValue, Host.frametime
DynamicLights  → Lightmaps, ShadowMap (pointLightDlightIndices), LightmapAtlas constants
Lightmaps      → LightmapAtlas constants, GL
Camera         → nothing in renderer/
FrameUniforms  → Camera, Fog, ShadowMap, V.gamma, RendererCvars
Visibility     → Camera (vieworg), clientCvars.areaportals, RendererCvars
model renderers→ Camera, Visibility, LightStyles, LightSampler, EntityLighting, Lightmaps, DefaultTextures,
                 RenderStats, ShadowMap
```

Two existing couplings stay and are called out so nobody "fixes" them by accident: `RenderDlights` adds to `V.blend`
(a view side effect of drawing a corona), and `Particles` reads `clientStaticState.serverInfo.sv_gravity` at draw time.

### C. Headless needs no renderer

Today `Materials` and `Sky` read the renderer through `RenderContext` (`typeof R`, with a headless stand-in), because
the model loaders construct them in the server worker. Why the stand-in exists is narrow: the constructors read
`R.blacktexture`, and `emit()`/`bindTo()` read `R.interpolation`, `R.c_brush_texture_binds` and the client state.
Nothing of that is needed before a draw. The fix is to stop `Materials`/`Sky` from *drawing*:

- **`Materials` becomes data plus frame selection.** Fields that default to a fallback texture become
  `GLTexture | null`, where `null` means "the default". The binding code (`bindTo`, the primary/luminance bind helpers,
  `_bindInterpolation`, the counters) moves into the model renderers (a `MaterialBinder` next to
  `BrushModelRenderer`), which import `DefaultTextures`, `Interpolation` and `RenderStats` directly and resolve the
  worldspawn alpha with the entity they already hold. `free()` frees whatever is non-null, so the sentinel
  comparisons against `R.notexture` go away.
- **`Sky` renderers take their draw state as a parameter.** `SkyBox.draw()` builds a small context (visibility
  frame, `cullBox`, shadow textures, sky bloom strength, `vieworg`) and passes it to `SkyRenderer.render(context)`.
  `Sky.ts` then imports only GL, `Host`, `W` and the BSP types.
- **`RenderContext.ts` is deleted**, `installRenderContext` leaves `createBrowserClient`, `engineMocks` and
  `test/support/renderer.ts`, and `RenderContext.ts` leaves the `engine-boundaries` allow-list.
- **What this does not do:** the worker closure still contains `client/GL.ts`, `PageServices.ts`, `VID.ts`,
  `Materials.ts` and `Sky.ts`, because the loaders call `GLTexture.*` and construct material and sky classes directly.
  Removing those too means the loaders get a render-data factory instead of the `loadRenderData` boolean: a larger
  change to every loader, and independent of this split. Decided: not planned (decision 13).

The change lands in Phase 5, once `DefaultTextures`, `Interpolation` and `RenderStats` exist; until then `typeof R`
stays valid because of the forwarders.

### D. Forwarders

A moved member may remain on `R` as a delegate, tagged `@deprecated Moved to X; removed in Phase 7`. Limits:

- **Methods and read-only object members** (`R.refdef`, `R.vpn`, `R.frustum`, effect spawners): a static getter or a
  one-line method is fine.
- **Reassigned state** (`particles`, `decals`, `viewleaf`, `oldviewleaf`): nothing outside `R.ts` assigns to them
  today, so forwarders are read-only getters. `useRendererOf` assigns through `patchMembers`; a mocked member on a
  getter-only static fails silently. So a phase that moves state a test mocks **updates that test in the same
  phase** rather than relying on the forwarder.
- **Hot paths** (`CullBox`, the `c_brush_*` increments, `refdef` reads inside the frame): callers are updated to the
  new class in the phase that moves it. A forwarder in a loop is a cost and a wrong signal.
- A "Forwarder ledger" at the bottom of this file lists live forwarders. Phase 7 is done when it is empty and
  `grep -n "@deprecated Moved" source/engine/client/R.ts` returns nothing.

### E. Ordering contracts become structure

The current renderer depends on four orderings that are documented, if at all, only in comments. Each is replaced
when the state it concerns moves:

1. **Shadow textures cached on `R`.** `PreRenderScene` assigns `R.shadow_texture`/`R.point_shadow_textures`, then
   `RenderScene` assigns them again after `selectPointLights` because the first assignment can be stale (the
   comment says so). `ShadowMap` keeps its own active-texture lists (the point list is allocated per call today, so it
   is refreshed once inside `selectPointLights`) and the renderers read `ShadowMap`. The two assignments in `R`
   and the three `R.*shadow*` members disappear. Phase 3, with `Lightmaps`/`DynamicLights`, because that is where
   `ShadowMap` is already touched.
2. **"Scene capture needed".** `R.usePostProcess` is computed in `PreRenderScene`, read in `SetupGL`, and
   `SCR` repeats `R.usePostProcess || PostProcess.hasActiveEffects()`. One predicate, `PostProcess.needsSceneCapture()`,
   fed by an explicit `PostProcess.requestSceneCapture()` from the frame preparation, replaces the static and both
   copies of the condition. Phase 4 (`SetupGL` and `SCR` are touched there).
3. **View state derived in `PreRenderScene`.** `vpn`/`vright`/`vup`, `viewleaf` and the blend color are computed as a
   side effect and read by `V`, `ClientHost` (sound listener) and the renderers. `Camera.update()` and
   `Visibility.update()` become explicit calls, in the order `V` already uses. Phase 4.
4. **Depth sampling.** Design F. Separate from the split.

### F. No frame graph; fix the depth-sampling trap directly

The tie-in you meant was `PostProcess.beginDepthSampling()`/`endDepthSampling()`. It does not need a frame graph.
The trap today: a caller binds `depthTexture` to a sampler unit, and must bind a null texture to that same unit before
`endDepthSampling()`, or WebGL raises a feedback-loop error. Two call sites do it by hand
(`BrushModelRenderer.endWorldTurbulentPass`, `endFogVolumePass`), each with a comment.

Proposed fix, small and independent of the split:

- `PostProcess.bindDepthForSampling(unit)` binds `depthTexture` to the unit **and records it**.
- `endDepthSampling()` binds the null texture to every recorded unit itself, then reattaches the depth texture.
- `beginDepthSampling()`'s JSDoc contract shrinks to "pair with `endDepthSampling()`".
- A test with a fake GL asserts that a recorded unit is unbound before the reattach, and that calling `end` without
  `begin` is an assertion failure.

That removes a Known Trap from `CLAUDE.md` instead of documenting it. It touches `PostProcess.ts`, two call sites and
one test. Decided (decision 14): it ships with Phase 3, next to the shadow-texture change that touches the same
passes, and `CLAUDE.md` and the `PostProcess` JSDoc are updated in that phase.

## Phasing

Every phase leaves `npm test`, `npm run typecheck` and `npx eslint source/engine` green, and stops for a go-ahead.
Phases 1 to 5 are pure moves: no pixel and no behavior change. The browser check for a phase is the same
before/after screenshot pair as in the shader-chunks work (`docs/browser-verification.md`), taken on the same map,
same seed, same camera.

### Phase 0: Cleanup, baseline and safety net (done 2026-10-10)

What shipped:

- **Dead-member sweep and warp leftovers**, see Context.
- **graphify removed**, see decision 8.
- **Characterization tests**, written against the current `R` (47 tests, each later move only changes an import):
  `test/renderer/particle-pool.test.ts` (alloc order and exhaustion, serialize/deserialize round trip, the
  `die < clock` rule), `lightmap-allocation.test.ts` (`AllocBlock` packing, skyline, "full"),
  `mark-leafs.test.ts` (PVS marking, parents, `r_novis`, area portals, sky request, the `oldviewleaf` resets on
  `areaportals.changed` and `cvar.changed`), `view-frustum.test.ts` (`SetFrustum`, `CullBox`, `WorldToScreen`),
  `renderer-init.test.ts` (cvar creation order, resource/renderer/effect order of `R.Init`, with the GL-bound steps
  mocked). A typed `assertNear` is in `test/support/assertions.ts`, because a `.test.ts` that imports
  `test/physics/fixtures.mjs` drags that file into the type check.
- Mutation check: breaking `CullBox`, the `oldviewleaf` bookkeeping, `AllocBlock` and the particle clock rule each
  turns the new tests red.
- **Browser baseline tooling**, in the session scratchpad (`capture.mjs`, `compare.py`, per
  `docs/browser-verification.md` section 8): a production build of the working tree is driven through the real
  client on `e1m1`, paused, with a seeded `Math.random` and a camera override. It captures 9 views and the
  `r_speeds` lines: spawn, dynamic lights + particles + decal, chase (alias model), bloom, fog, sky (camera under a
  sky face), lava from above, inside the lava, spawn again. Comparison is a pixel diff outside a noise mask (two
  captures of the same build) plus a coarse 120 px block-mean check for the animated full-screen views. A build with
  the sky draw and the particle billboards disabled is flagged in 7 of 9 views, so the tool does see regressions.
- Verified: `npm test` 1861 pass, `npm run typecheck` clean, `eslint` clean on everything touched.

Baseline `r_speeds` for the working tree (`e1m1`, 960x600; identical across two runs, so these are exact):

| View | Draw calls | Tris | Verts | VBOs | Texture binds |
|---|---|---|---|---|---|
| spawn, effects, chase, bloom, fog | 426 | 4153 | 12459 | 2 (3 with effects) | 1263 |
| sky (camera under a sky face) | 48 | 528 | 1584 | 1 | 144 |
| lava from above | 66 | 670 | 2010 | 2 | 176 |
| inside the lava | 3 | 46 | 138 | 2 | 8 |

Limits of the baseline, so nobody over-trusts it: the sky and lava views animate with real time, so the pixel diff
is mostly masked there and only the block means and the `r_speeds` counts protect them. Software GL runs at 4 to 5
FPS, so it says nothing about frame time. The `e1m1` start has no water other than lava and no `_qs_waterfog`
volume, so underwater fog is not covered by a view. It also does not touch pointer lock or any input path.

### Phase 0b: Directory layout (done 2026-10-10)

The mechanical move in "Directory layout": 21 `git mv`s and 159 import specifiers rewritten in 48 files by a script
that resolves each relative specifier from the old location and writes it relative to the new one (so a moved file's
imports of unmoved files are fixed too). One commit, no logic change.

- `ShaderLibrary`'s two `import.meta.glob('../shaders/...')` became `'../../shaders/...'`.
- Path text was updated in `docs/`, `.github/`, `.claude/`, `CLAUDE.md`, the other plans and
  `test/common/engine-boundaries.test.mjs`, so no link or allow-list names an old path.
- `renderer/` itself now holds only the folders; `R.ts` stays in `client/`.
- Verified: `npm test` 1861 pass, `npm run typecheck` clean, `eslint` 0 errors (the `.mjs` tests outside the project
  service still print the parser-service errors they printed before), a production browser build succeeds, and the
  browser capture shows identical `r_speeds` in all 9 views in 4 runs (2 before, 2 after).
- The pixel comparison is weaker than I wanted: four runs of two builds cluster by run, not by build (one
  "before" run is the outlier against the other three, `after-a` vs `after-b` differ as much as `base-a` vs
  `base-b`). The capture needed two fixes along the way and still has run-to-run noise from something I did not pin
  down (the lightstyle phase and the sky are the suspects). Particles and effects are seeded and placed after a
  reseed; the client clock is pinned. What it can prove is "no more different than the same build is from itself".
  Treat the `r_speeds` counts as the exact check.
- Unrelated fix on the way, own commit: `channel-driver.test.mjs` "ignores messages that are not channel
  messages" waited a fixed 20 ms and failed twice under full-suite load; it now polls up to 2 s.

### Phase 1: Particles and decals

`Particles`, `ParticleType`, `Decals`. Callers updated (ClientServerCommandHandlers, ClientLegacy, NavigationDebug,
ClientHost, ClientEngineAPI, tests). `compareTransparentItems` stays exported from `R.ts`; the transparent pass
calls `Particles`/`Decals` for emit and advance. `Decals.PlaceDecal` temporarily calls `R.RecursiveLightPoint`
(an R ↔ Decals import cycle, harmless: nothing is built at module evaluation) until Phase 2.
`docs/client-entities.md` (`R.collidableParticleTypes`) and `docs/traceline.md` are updated.

### Phase 2: Light sampling and lightstyles

`Interpolation`, `LightStyles`, `LightSampler`, `EntityLighting`. All pure CPU apart from the two lightstyle texture
uploads, so `r-sorting.test.mjs` moves with them and is converted to `.ts`. BrushModelRenderer, Alias/Mesh renderers
and Decals switch imports.

### Phase 3: Lightmaps and dynamic lights

`Lightmaps`, `DynamicLights`, plus Design E item 1 (shadow textures read from `ShadowMap`) and the Design F
depth-sampling fix (`PostProcess.bindDepthForSampling`, the two call sites in `BrushModelRenderer`, the new test,
the Known Trap entry in `CLAUDE.md`). `BuildLightmaps` is split as described in Design A. First phase that moves GL textures, so the browser pair matters: static
lightmaps, a rocket's dynamic light on a wall, flashblend on and off, a deluxemap map, a point-light shadow.

### Phase 4: Camera, frame uniforms and visibility

`Camera`, `FrameUniforms`, `Visibility`, plus Design E items 2 and 3. The biggest call-site count (`refdef` 105
uses, `CullBox` 12). Done as a mechanical rename plus the extraction of the uniform loop. `V.ts` and `SCR.ts`
change in imports and in the one scene-capture predicate. The three event subscriptions move with `Visibility`.

### Phase 5: Resources, cvars, init, stats, fog, sky, headless

`RendererCvars`, `DefaultTextures`, `ShaderPrograms`, `RenderStats`, `Fog`, `SkyBox`, then Design C: `Materials` as
data, `MaterialBinder`, `Sky` with a draw context, `RenderContext` deleted, `engine-boundaries` allow-list and
`useRendererOf` updated. `R.Init` becomes the ordered list of subsystem inits below. `R.NewMap` and `ClearAll`
become fan-outs. This is where `R.ts` drops under about 1000 lines.

### Phase 6: Scene orchestration

`TransparentPass`, then `RenderScene`/`RenderWorld`/`PreRenderScene` reduced to the readable list of steps they
are (shadow passes, scene capture begin, turbulent boundary depth, sky, view model, world, entities, coronas,
transparent, resolve, poly blend). Plain methods, no declared resources. Optional: whether it happens is decided
after Phase 5, when `R.ts` can be read again (decision 16).

**Known bug to look at here, not before:** entities with transparent brush models draw in the wrong order
(observed by the developer, 2026-10-10). Hypothesis, not yet verified: `_renderTransparentsUnified` sorts every
transparent entity by `_getEntityTransparentDistance()`, the distance from the view origin to `entity.origin`, and its
comment admits model bounds were not available there. A brush entity's `origin` is usually the world origin (its
geometry sits at world coordinates), so every such entity sorts by a distance that has nothing to do with where it
is. If that is right, the fix is to sort brush entities by the center of their bounds. It becomes a test on
`compareTransparentItems`/the collection step, and its own commit, so a before/after pair for the move phases is
never mixed with a behavior change.

### Phase 7: Forwarder cleanup and docs

Delete every forwarder on `R`. Rename leftover `_`-prefixed statics to the style guide's. Update
`docs/post-process-effects.md` (the bloom/warp sentence), `docs/shader-chunks.md` (program registration now lives in
`programs/ShaderPrograms.ts`), the `shader-chunks` skill, `docs/events.md` if the owner text of
`renderer.textures.initialized` / `renderer.shaders.initialized` changes, and `.github/instructions/*`. Record
"what shipped" in this file and tick D2 in the parent plan.

### Init order that must be preserved

`Init` creates cvars, then `InitTextures`, `InitParticles`, `InitDecals`, `InitShaders`, registers the four model
renderers, then `PostProcess.init()`, then effects in the order bloom, underwater fog, warp, color grade, blur (the
resolve order), then `ShadowMap.init()`, then the corona buffer, then `ClearAll`. A test pins it.
`client.disconnected` fans out to each subsystem's `clear()` in today's order. The `areaportals.changed` and
`cvar.changed` (`r_novis`, `cl_areaportals`) subscriptions move with `Visibility` and are covered by a test; losing
one makes PVS go stale silently. `SerializedParticle` keeps its shape and export name (`ClientHost` and the savegame
test depend on it).

## Testing

- **Per phase:** `npm test`, `npm run typecheck`, `npx eslint --fix` on touched files; `.mjs` tests are not
  type-checked, so a moved member is also grepped through `test/` and `source/game/**/test/` by hand.
- **Existing coverage that moves with the code:** particle collision (`particle-physics`), light sampling and
  smoothing (`r-sorting`), turbulent lightstyle interpolation, brush renderer, materials, bloom, savegame particles.
- **New coverage** (Phase 0 writes it against `R`, later phases re-point it): particle pool and serialize round trip,
  `AllocBlock`, `MarkLeafs` and its resets, frustum/cull/projection, `Init` order, dynamic-light face marking on a
  fake BSP, `Materials` constructed and freed with no renderer installed (Phase 5), depth-sampling unbind (Design F).
- **Boundary:** `test/common/engine-boundaries.test.mjs` drops `RenderContext.ts` from the worker allow-list
  (Phase 5), and Phase 0b rewrites its paths.
- **New test files** go in `test/renderer/` (one level, covered by the existing glob). No new nesting, so
  `test-glob-coverage` does not apply.
- **Dockerfile:** the `test` and `builder` stages copy `source` and `test` whole, so new and moved files under them
  need no change. `dockerfile-fixture-sync` applies only if a fixture directory is added.
- **Real browser, every phase from 0b:** the before/after pair and `r_speeds` numbers. Pointer-lock and mouse look
  are not touched by this plan, so there is nothing to hand off for a live test; each phase report says so.
- **Frame time:** record median frame time on the baseline scene before Phase 4 and after Phase 5 (the static
  facade is hot-path code and `Camera` changes access patterns). A regression above noise is a finding.
- **Known flaky test, unrelated:** `test/common/channel-driver.test.mjs` "ignores messages that are not channel
  messages" waits a fixed 20 ms for `MessageChannel` delivery and failed once under full-suite load (passes alone,
  6 of 6). Not part of this plan; mentioned so a red run is not blamed on a phase.

## Open questions

None open. Settled on 2026-10-10: decisions 13 to 16 above. New questions are added here as phases turn them up.

## Forwarder ledger

Empty. Every forwarder added in Phases 1 to 6 is listed here with the phase that adds it; Phase 7 deletes them.

# Frame graph: render targets and passes as declarations, hazards checked

Track D3 of `plans/engine-architecture-modernization.md`. Status: **plan drafted 2026-10-13. Option 1 (validated
scopes) was chosen the same day. Phase 0, Phase 1 and Phase 2 are done (2026-10-13); Phase 3 is next.**
Written for the maintainers. Numbers are from a read of the tree on that date (branch
`engine-architecture-modernization`), not from a profiler.

## Context

### What a frame does today

The pass order is fixed by hand in `R.RenderScene()`, `ScreenFrame.#draw()` and `PostProcess.resolve()`. Which
framebuffer is bound at each step is a convention between those three places.

| # | Step | Code | Writes | Reads | Bound afterwards |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | top-down shadow | `ShadowMap.renderTopDownShadow` | top-down depth | | screen (`null`) |
| 2 | point-light shadows | `ShadowMap.renderPointLightShadow` | depth cube per slot, 6 faces | | screen |
| 3 | scene begin | `R.SetupGL` → `PostProcess.begin` | color, emissive, depth (multisampled renderbuffers when `gl_msaa` > 0) | | scene FBO or MSAA FBO |
| 4 | turbulent boundary depth | `R.#renderTurbulentBoundaryDepth` | boundary depth | | scene or MSAA FBO, restored by hand |
| 5 | sky, view model, world, entities, coronas | `R.RenderScene` | scene | shadow maps, lightmaps | scene |
| 6 | transparent pass; turbulent and fog volumes sample depth | `TransparentPass`, `BrushModelRenderer` | scene color | scene depth | scene |
| 7 | MSAA resolve, unbind | `PostProcess.end` | resolved color, emissive, depth | multisampled renderbuffers | screen |
| 8 | game stack, `scene` stage | `PostProcess.resolveGameplayStack` | ping/pong, then back into the color texture | color | screen |
| 9 | renderer effects, then `final` stage | `PostProcess.resolve` | ping/pong; bloom's own 3 targets and 1x1 adaptation history; blur's intermediate | color, emissive, depth, boundary depth | screen |
| 10 | HUD, menu, console | `ScreenFrame.#drawOverlays` | screen | | screen |

### Where the state is implicit

Each item is a thing a reader, or a new pass, has to know and nothing checks.

1. **A texture can be an attachment and a sampler at once.** WebGL turns that into a feedback-loop error even when the
   draw never samples it. The contract is JSDoc on `PostProcess.beginDepthSampling`/`bindDepthForSampling`/
   `endDepthSampling` and a trap in `CLAUDE.md`; the enforcement is a module array of units to release.
   `BrushModelRenderer.renderSingleFogVolume` still re-binds the depth texture by hand (line 962), which is safe only
   because the unit was registered earlier in the same pass.
2. **"Which FBO is bound" is a convention.** The shadow passes end by binding `null`, which is right only because
   `SetupGL` binds the scene FBO afterwards (the order is explained in a comment in `R.RenderScene`). The turbulent
   boundary pass restores `msaaSamples > 0 ? msaaFBO : fbo` by hand. This bit us: `5f8a761` fixed
   `resolveGameplayStack` ending with the scene FBO bound, so with only a game stack active the HUD was drawn into the
   FBO and the screen stayed black. A renderer effect that happened to be on hid it.
3. **Effects find their output by asking GL.** `BloomEffect.apply` and `BlurEffect.apply` read
   `getParameter(FRAMEBUFFER_BINDING)` and `getParameter(VIEWPORT)` to know where to write, and so do
   `resolve` and `resolveGameplayStack`. The base class documents that "the caller has already bound the correct output".
4. **`PostProcess.active` is a global that means "the scene FBO is bound".** Six readers outside `PostProcess`
   (`TransparentPass`, `BrushModelRenderer` ×3, `DynamicLights`, and `R`) use it to decide whether fog volumes exist,
   whether turbulents sample depth, whether a corona can tint.
5. **MSAA resolve is lazy and positional.** `msaaResolved` is set by whichever comes first: the first depth-sampling
   pass, or `end()`. *Observed while reading, not yet confirmed in a browser:* `resolveMSAA` leaves the resolved,
   non-multisampled FBO bound, so everything drawn after the first depth-sampling pass of a frame (the rest of the
   transparent pass: sprites, particles, later fog volumes) is not multisampled. That may be the wanted trade-off; today
   it is an accident of ordering that nobody wrote down.
6. **Resource creation is copy-pasted.** Create texture, four `texParameteri`, create FBO, attach, `drawBuffers`,
   resize on a pull from `resizePingPong`, delete in `shutdown`: `PostProcess` (7 FBOs, 8 textures and renderbuffers),
   `BloomEffect` (6 FBOs, 6 textures), `BlurEffect` (1 + 1), `ShadowMap` (2 FBOs, a texture and a cube array), `Draw`
   (1 FBO). 55 `bindFramebuffer` sites in 6 files, 29 of them in `PostProcess.ts`.
7. **`drawBuffers` is toggled by hand** between `[COLOR0]` and `[COLOR0, COLOR1]` around blits, with comments about
   drivers that reject the other form.

`Draw.BeginTexture`/`EndTexture` (render a 2D draw into a texture, with the 6th FBO) has no caller anywhere in `source/`.

### What is not a problem

The pass sequence is short, fixed and the same every frame except for `if` conditions. There is no transient-memory
pressure to alias away, and nothing reorders passes. A textbook frame graph (compile, topological sort, aliasing,
culling) would solve problems this renderer does not have. What it does have is item 1 to 7 above.

### Decisions already made

- 2026-10-13: Track D4 (GPU abstraction, WebGPU spike) is postponed past 1.3.0. This plan does not assume a WebGPU
  backend and has to earn its place on WebGL2 alone.
- The game-facing post-process API (`ClientEngineAPI.PostProcess`: `setStack`, `clearStack`, `hasStack`, `pulse`, and
  the types in `shared/GameInterfaces.ts`) and `PostProcessEntries` stay as they are.

## Goals

- Render targets are objects with a declared shape (attachments, size policy, multisampling) and one implementation of
  create, resize, bind and free.
- Passes declare what they read and write. A hazard (sampling what is attached to your own target, reading a
  multisampled target before it is resolved, a pass leaving the wrong target bound) is an assertion in development
  builds and a failing test, not a browser console message.
- A pass is given its output target. No `getParameter(FRAMEBUFFER_BINDING)`, no `PostProcess.active`.
- The depth-sampling contract (`begin`/`bind`/`end`) moves from a convention that call sites follow into something the
  frame does for a pass that declares `reads: sceneDepth`.
- One page to read what a frame does, and a `r_framegraph`-style dump of the passes of the last frame, so a browser
  verification can say which passes ran against which targets.
- Rendering is pixel-identical to before, checked with the existing capture and compare scripts (`da84d83`), except
  for deviations a phase lists.

## Non-goals (this pass)

- WebGPU or any second backend (D4, postponed).
- Memory aliasing of transient targets, automatic pass reordering, culling of passes by dependency. Pass order stays
  the fixed order of the frame.
- Per-frame allocation of a graph object. The declarations are built once and toggled; this is a hot path.
- Changing shaders, `GL.ts`'s program and texture-unit caches, the 2D path (`Draw`, `GL.Set2D`), or the game contract.
- New visual features. This is a refactor; no gain in frame time is promised (see "What it buys").

## Design

### A. `RenderTarget`

A class (new directory `source/engine/client/renderer/frame/`, not `GL.ts`: `GL.ts` is in the server worker's import
closure and `engine-boundaries.test.mjs` pins that) built from a descriptor:

```ts
interface RenderTargetDescriptor {
  readonly name: string;
  readonly size: 'viewport' | { readonly divisor: number } | { readonly width: number; readonly height: number };
  readonly color: readonly ColorAttachment[];      // GLRenderTexture-backed, or multisampled renderbuffer
  readonly depth: 'texture' | 'renderbuffer' | 'none';
  readonly samples: () => number;                  // 0 for single-sampled; the `gl_msaa` cvar for the scene
}
```

`color` is a list of any length, not "color and emissive": a velocity or normals attachment is one more entry, bounded
by a capability read once at init (`MAX_DRAW_BUFFERS`, `MAX_COLOR_ATTACHMENTS`, `MAX_SAMPLES`). A target can be marked
as history: it is two textures that swap at the end of the frame, which is what bloom's adaptation texture does by hand.
A fixed-size target is how a later secondary view or a menu preview gets its own render surface.

It owns the FBO and its attachments, `bind()`, `resize(w, h)`, `free()`, and the `drawBuffers` list, and it absorbs the
driver workarounds that are scattered through `PostProcess.ts` today (renderbuffer bound once before attach, the
resolve with slot 0 re-bound). Bloom's history textures and the blur intermediate become targets too; ping/pong
becomes a two-element pool owned by the post-process chain. The shadow cube array keeps its per-face attach, because
that is what a cube target is.

### B. Pass declarations

One file lists the passes of a frame with their reads and writes by target name, for example `shadow-topdown`
(writes `shadowTopDown`), `scene-opaque` (writes `scene`; reads `shadowTopDown`, `shadowCubes`),
`scene-transparent-depth` (writes `scene`; reads `sceneDepth`), `bloom` (reads `sceneEmissive`, writes its own
targets). The declarations are static data; a predicate per pass says whether it runs this frame (the `if` that is in
`R.RenderScene` today).

A pass runs inside a scope the frame provides: it binds the declared target, sets the viewport, and on exit checks and
restores. In development builds (`console.assert`, stripped in production like every other assertion here) the scope
asserts the hazards listed under Goals. The same checks run against the declarations alone in a test, with no GPU,
over every combination of the frame's toggles.

There are two shapes for this, the first fork of the plan (Open question 1):

- **Option 1, validated scopes (recommended).** `R` and `ScreenFrame` keep calling passes in their order, each call
  wrapped by a scope. No compile step, no scheduler. The declarations are checked and used for the dump.
- **Option 2, compiled graph.** Passes register themselves; a compile step orders them, inserts the MSAA resolve and
  the depth copy where a read requires them, and an executor runs the result. This is what the umbrella plan sketched.

### C. Depth sampling and MSAA resolve owned by the frame

A pass that declares `reads: sceneDepth` gets, from the frame: the resolve if the scene is multisampled and not yet
resolved, the depth copy into the scratch renderbuffer, the attachment swap, the sampler binding, and the release of the
unit afterwards. `BrushModelRenderer` loses its `beginDepthSampling`/`bindDepthForSampling`/`endDepthSampling` calls
(3 places) and the by-hand re-bind; `PostProcess.bindDepthForSampling` becomes internal and the `CLAUDE.md` trap is
rewritten to "declare the read". Where the MSAA segment ends becomes a visible decision of the frame (Open question 4).

`reads: sceneColor` works the same way and is what glass and refraction need: the frame resolves the multisampled color
into a side texture, which the pass samples, and drawing continues into the multisampled target, so one pass that reads
color does not end the antialiased part of the frame. The scene is then resolved once more at the end.

### D. Effects receive their output

`PostProcessEffect.apply(input, output, settings)` where `output` is `{ target, viewport }` (screen or a pool target).
Six effects change signature; `PostProcessEffect` is engine-internal (games name effects by `id` through the stack),
so no game code is involved. `BloomEffect` and `BlurEffect` stop querying GL.

### E. The dump

A development-build console command prints the passes of the last frame: name, target, size, reads, writes, whether
it ran. The browser-verification recipe in `docs/browser-verification.md` gets "run the dump" as a step for a
renderer change.

## What it buys, and what it does not

| Gain | How sure |
| :-- | :-- |
| Hazard class caught by a node test and a development assertion instead of the browser console. The last two weeks had two of this class (`5f8a761`, `25565e4`), and the CLAUDE.md trap exists for a third. | High for the validated ones; it cannot see a driver quirk. |
| Effects testable with a fake target; the config matrix (MSAA × fog volumes × underwater × bloom × stack) enumerated in one test. | High |
| `PostProcess.ts` (889 lines) shrinks to the stack and chain logic; about 100 to 150 lines of copy-pasted FBO code go. | Medium: estimate. |
| One place to read the frame, plus a dump for verification. | High |
| MSAA behavior (item 5) becomes a written decision. | High |
| Frame time | **No gain promised.** Dropping the `getParameter` queries may help slightly; not measured, not claimed. |
| Memory | **None.** No aliasing in scope. |
| New features | None. |
| A step toward WebGPU | Real but irrelevant while D4 is postponed. |

## Future uses

Added 2026-10-13 after the developer asked what this makes possible. None of it is in scope and none of it is
prototyped; the column "Does D3 help" says how much of the work this plan removes. Claims about the code were checked
on that date.

| Idea | What it needs | Does D3 help |
| :-- | :-- | :-- |
| Glass, refraction, heat haze behind particles | A copy of the opaque scene color, sampled mid-frame by the transparent pass. Only depth can be sampled mid-frame today. | **Directly.** The same mechanism as depth sampling (`reads: sceneColor`, Phase 3). `MF_TRANSPARENT` already exists; refraction is a new material flag plus a shader. |
| Motion blur from camera movement | Previous frame's matrices, scene color and depth. | **Barely.** `UnderwaterFogEffect` is already the template for an effect that reads color and depth. The view model is drawn in depth range 0 to 0.3 and needs masking, or the weapon blurs. |
| Per-object motion blur | A velocity attachment that every scene shader writes. | **Yes.** The scene target is hardcoded to two attachments (color, emissive) in five places of `PostProcess.ts`; with a descriptor a third is a line plus a shader-chunk edit. |
| More post effects (SSAO, depth of field, god rays, chromatic aberration, vignette, grain, sharpen) | Color and depth, which are available after the resolve. | **Mostly no.** The recipe of an effect class, a shader and the game's stack and pulse API already works. D3 adds hazard checks and testability. |
| Temporal AA, SSR, dynamic resolution | History targets and a velocity buffer (TAA), a normals attachment (SSR), a scaled scene target (resolution). Bloom's adaptation history is the pattern. | **Yes.** All three are render-target bookkeeping, which Phase 1 centralizes. TAA would also settle the MSAA question. |
| Cameras, monitors, mirrors, portals, planar water reflections | A second render of the scene from another camera into a texture, shown on a surface. | **Partly, and not the hard part.** See below. |
| 3D previews in menus (weapon or character in a buy menu) | The same mechanism, with a camera the game controls and no PVS problem. | **Partly.** The easiest consumer of a secondary view. |
| `r_showtarget <name>` debug views | Named, registered targets. | **Yes**, nearly free; replaces the one-off bloom debug preview. |

### Why cameras and displays are a plan of their own

- **`Camera` and `Visibility` are static globals** (`refdef`, view vectors, frustum, `viewleaf`, `visframecount`). A
  second view has to save and restore them or they become instances. D3 lists that as a non-goal.
- **The client only has what the server sent.** The server picks entities with one origin's fat PVS
  (`getFatPvsByPoint`, `ServerMessages.ts:660`); a camera in another room would show an empty room. FTE unions the PVS
  of every camera origin (`pvscamera_t`, `SV_AddCameraEntity` in `sv_ents.c`). On our side that is a server-side
  change that appears not to touch the wire format; the entity delta path has not been traced.
- **A game API is needed** ("this surface shows camera X", a dynamic texture on a material or entity), which changes
  `shared/GameInterfaces.ts`. That is a fork for the developer.
- **Every extra view is a full scene render.** Cameras need small targets, a rate limit and a visibility check.

Cameras are also the first feature that wants dynamic composition of passes (N views a frame, decided by the game).
That is the one argument for Option 2 of the design, and it is weak: a loop that renders the requested views before the
main view is easy by hand, and the declarations would still catch a monitor that shows its own camera. The follow-up
would be `plans/secondary-views.md`.

### What this asks of D3 now

Three details are cheap in Phase 1 and 3 and expensive later; they are built into the design below:

1. The target descriptor has N color attachments, fixed-size offscreen targets, and previous-frame history as a
   first-class kind of target.
2. A pass that reads scene color gets a resolve into a side texture while drawing continues into the multisampled
   target (see C and Open question 4).
3. The engine never queries `MAX_DRAW_BUFFERS`, so a third attachment needs a capability check first (Phase 1 adds it).

## Blast radius

Counted from the tree. "Changed" is my estimate of lines edited, not the size of the file.

| Area | Files | What changes | Changed |
| :-- | :-- | :-- | :-- |
| Targets and chain | `PostProcess.ts` (889), `BloomEffect.ts` (614), `BlurEffect.ts` (106), `WarpEffect`, `ColorGradeEffect`, `ColorShiftEffect`, `UnderwaterFogEffect`, `PostProcessEffect.ts` | Allocation moves to `RenderTarget`; `apply` signature; chain owns ping/pong | 700 to 1,000 |
| Shadows | `ShadowMap.ts` (832) | FBO half only (about 150 lines) | 150 |
| Frame orchestration | `R.ts` (441), `ScreenFrame.ts` (254) | Scopes around the passes, `PostProcess.active` and `getParameter` gone | 150 |
| Depth consumers | `BrushModelRenderer.ts` (2,129; three regions of about 40 lines), `TransparentPass.ts`, `DynamicLights.ts` | Declared reads instead of begin/bind/end; `active` readers | 150 |
| 2D | `Draw.ts` | Delete `BeginTexture`/`EndTexture` and its FBO (no caller) | -60 |
| New | `renderer/frame/*` | `RenderTarget`, descriptors, pass scope, validator, dump | 600 to 900 |
| Tests | 8 of the 9 files that touch `PostProcess` (about 120 of 151 references; the entries test, 34, is untouched), `shadow-map.test.mjs`, `bloom-effect.test.mjs`, `renderer-init.test.ts` | Fakes target objects instead of `gl`; new matrix and validator tests | 500 to 800 |
| Docs | `docs/post-process-effects.md`, `docs/volumetric-fog.md`, `docs/browser-verification.md`, `CLAUDE.md` trap, `.claude/skills/browser-ui-verification` | Contract text | small |

Not touched: shaders (no `.frag`/`.vert`), game modules and `shared/GameInterfaces.ts`, `PostProcessEntries`, the server
and its worker, `GL.ts` (kept out on purpose), networking. Total, about 2,000 to 3,000 changed lines across roughly 20
source files and 12 test files, all under `source/engine/client/` and `test/renderer/`.

The risk is not the size. It is that GL state is order-dependent and some of it is driver-dependent (the multisample
resolve and `drawBuffers` quirks the comments mention). Headless Chromium here is software GL and will not reproduce
driver differences, so a phase that moves resolve or depth-copy logic needs a human run on a real GPU in Chrome and
Firefox, as Phase 3 and 4 of the umbrella plan did.

## Phasing

Each phase leaves `npm test`, `npm run typecheck` and eslint green and stops for a go-ahead.

- **Phase 0, pin the behavior (read-only, no engine change).** Capture before-images with the capture/compare scripts on
  `e1m1`, a map with fog volumes (Hellwave `hw_e1m2`, 7 volumes), a map with turbulents and an underwater view, each
  with `gl_msaa` 0 and 4. Confirm or refute item 5 in a browser and record it. Done when the results are in this plan.
- **Phase 1, `RenderTarget`.** Create the class, move `PostProcess`, `BloomEffect`, `BlurEffect` and `ShadowMap`
  allocation onto it, delete `Draw.BeginTexture`. No behavior change; the 55 bind sites become `target.bind()`. The
  descriptor takes N color attachments and history targets, and the capability limits are read once. Tests construct
  targets over a fake `gl`.
- **Phase 2, pass declarations, validator, output targets.** The declarations file, the scope around each pass, the
  validator and the matrix test, `apply(input, output, settings)`, `PostProcess.active` replaced by a query of the
  frame, the dump command. Option 1 ends here.
- **Phase 3, depth sampling and MSAA owned by the frame.** `BrushModelRenderer` stops calling begin/bind/end; the trap in
  `CLAUDE.md` and the JSDoc are rewritten; the MSAA decision of Open question 4 is implemented. Needs the live GPU run.
- **Phase 4, compile step (only under Option 2).** Passes register themselves, the compiler orders and inserts resolve
  and copy, the executor runs. Not recommended; listed so the fork is visible. Decided only after Phase 3, with the
  declarations as evidence of whether anything wants dynamic composition.

Option 1 is Phases 0 to 3: about 4 reviewable steps. Phase 1 alone is the cheapest useful piece (shrinks
`PostProcess.ts`, no new concept) and can stand if the rest is postponed.

### Phase 0: what was found (2026-10-13)

Built from `b378c0c` (the working tree had no engine changes), headless Chromium 1234 on software GL
(`--use-gl=swiftshader`), a scratch dedicated server per game, scratch production builds outside `dist/`. The method
is a tracer injected into the page (not committed, a throwaway in the session's scratch folder): it wraps the draw and
blit calls of the GL context and the entry points of `PostProcess` and `R`, and records, for one steady frame, the
sample count of the framebuffer each draw lands in (`gl.getParameter(gl.SAMPLES)`) with the pass markers in between.

1. **Item 5 is confirmed, and measured.** `hw_e1m2` (7 fog volumes, `gl_msaa` 4), one frame: 10 draws into the shadow
   targets, then 470 draws at 4 samples (view model, world, entities), then `beginDepthSampling` resolves the
   multisampled target (2 color blits and a depth blit), and the remaining 49 draws of the scene, plus the 5 of the
   effects chain, are at 0 samples. The frame has **three** depth-sampling passes, each with its own depth blit (four
   depth blits and one resolve in total). So any map with a fog volume or a turbulent surface in the transparent pass
   draws everything after the first such pass without multisampling. That includes sprites and particles.
2. **`gl_msaa` does not take effect live.** `PostProcess.resize()` returns early when the size is unchanged, before it
   calls `_resizeMSAA()`. Measured on `e1m1`: after `gl_msaa 0` the frame still draws at 4 samples
   (`msaaSamples` 4); after a viewport change by one pixel it is 0, and 4 again after `gl_msaa 4` and another resize.
   `docs/browser-verification.md` says the cvar can be toggled live, which was never true. This is a bug independent of
   D3; the cause is in the code that Phase 1 rewrites, so it is fixed there with a test (a change of the cvar re-runs the
   multisample allocation).
3. **Baseline is clean.** No GL error or warning on either map; the only console entries are 3 (`e1m1`) and 9
   (`hw_e1m2`) 404s for assets that were already missing and the driver's ReadPixels stall from the screenshots.
4. **`e1m1` at spawn has no depth-sampling pass** (no turbulent surface in view, no fog volume), so item 5 is only
   exercised by maps with fog volumes or turbulents in view, which is why the capture matrix has `hw_e1m2`.
5. **The capture script gained three environment variables** (`CAPTURE_MAP`, `CAPTURE_GAME`, `CAPTURE_MSAA`) and a
   `setup` block in `views.json`; documented in `docs/browser-verification.md`, section 8. The setup block also
   showed that the default scene is the map the menu's New Game starts, `start`, not `e1m1` as the doc and the script
   header said; both are corrected. The trace above used `map e1m1` explicitly.
6. **The baseline matrix**: nine views each of `start` at `gl_msaa` 4 and 0, and of `hw_e1m2` at 4, two captures per
   configuration so that the noise floor is measured (six captures of about 3 minutes each on this machine, software
   GL). Built from `b378c0c`; any later phase compares against a build of that commit, the images are not stored.

### Phase 1: what shipped (2026-10-13)

`RenderTarget` is the one place a framebuffer and its attachments are created, resized, bound and freed.
2376 tests pass, `npm run typecheck` is clean, eslint is clean on everything touched.

- **`renderer/frame/RenderTarget.ts`**: built from a descriptor (`color` is a list of any length, each `texture`,
  `renderbuffer` or `external`; `depth` the same or `null`). `resize(width, height, samples)` allocates what it owns
  and does nothing when neither size nor samples changed; a 0 by 0 resize releases the storage. `bind()`,
  `bindForRead()`, `bindForDraw()`, `attachDepthCubeFace()`, `swapDepthToRenderbuffer()` and `restoreDepthTexture()`
  (the two ends of depth sampling, each binding the framebuffer itself), `colorTexture(i)`, `depthTexture`,
  `depthRenderbuffer`, `free()`. `RenderTarget.limits` reads `MAX_COLOR_ATTACHMENTS`, `MAX_DRAW_BUFFERS` and
  `MAX_SAMPLES` once per context. `RenderTargetPair` (read and write side, `swap()`, `reset()`) is the history kind.
- **`PostProcess`**: 889 to 693 lines. The seven FBOs and eight textures and renderbuffers are `scene` (color,
  emissive, depth texture), `depthCopy` (external scene color, depth renderbuffer), `turbulentBoundary`, `msaaTarget`,
  `ping` and `pong`. `colorTexture`, `emissiveTexture`, `depthTexture` and `turbulentBoundaryDepthTexture` stay, as
  getters, so no consumer changed; `fbo`, `pingFBO`, `depthRenderbuffer` and the other raw handles are gone.
  `beginToEffectFBO` had no caller and is deleted.
- **`BloomEffect`**: extract, blur and metric are targets, the adaptation history is a `RenderTargetPair` (the read
  index and the two arrays are gone); **`BlurEffect`**: the intermediate is a target; **`ShadowMap`**: `topdownTarget`
  (external depth texture, which keeps its compare mode and `texStorage` allocation in `ShadowMap`) and
  `pointTarget` (a cube face attached per pass). Only the framebuffer ownership moved for the shadow maps.
- **`Draw.BeginTexture`/`EndTexture`** and the framebuffer behind them are deleted (no caller anywhere in `source/`;
  closes the `TODO: cleanup` on the framebuffer).
- **Every `createFramebuffer` and `createRenderbuffer` of the renderer is in `RenderTarget` now**; `bindFramebuffer`
  occurrences went from 55 to 14: 5 inside `RenderTarget`, 6 `null` unbinds, 2 that restore the binding a caller had
  (`BloomEffect`, `BlurEffect`, which Phase 2 replaces with a handed-in output target) and 1 that is the debug
  wrapper's list of names in `GL.ts`.
- **Fixed on the way: `gl_msaa` takes effect at the next scene capture** (Phase 0 finding 2). Release of the
  multisampled storage at 0 samples is new, and a context whose `MAX_SAMPLES` is 0 no longer asks for multisampled
  storage with 0 samples.
- **`GL.ts` takes its context from `gl.ready`** as well as from `GL.Init()` (the event carries it), which is what lets a
  test give the module a context. No production difference.
- **Small deviations, all in favor of the target describing itself**: a depth-only target now ends with
  `drawBuffers([NONE])` and `readBuffer(NONE)` (the shadow FBOs used `drawBuffers([])`, the turbulent boundary FBO
  neither readBuffer); `endDepthSampling` binds the scene framebuffer itself instead of relying on it being bound.
- **Tests**: new `test/renderer/render-target.test.ts` (17) over a recording context
  (`test/support/recordingContext.ts`) and `post-process-resize.test.ts` (4: `gl_msaa` follows the cvar, storage is
  released at 0, the targets size together); `test/support/renderTargets.ts` is the fake target the PostProcess and
  ShadowMap tests install. The depth-sampling, resolve-binding, stack and shadow tests were re-pointed, not
  dropped; the sequence assertion of the depth-sampling test now reads "bind the unit, release the unit, restore the
  depth texture".
- **Verified in Chromium** (same setup as Phase 0, scratch builds of the working tree): the frame trace of `hw_e1m2`
  is draw for draw the one of `b378c0c` (10 shadow draws, 470 at 4 samples, three depth-sampling passes, 49 at 0
  samples, the same blits); `gl_msaa 0` on its own now gives 0 samples on the next frame and `gl_msaa 4` brings 4 back
  without a resize; no GL error or warning beyond the known 404s.
- **Capture comparison** (`compare.mjs`, two captures per side, the matrix of Phase 0 finding 6): `start` at
  `gl_msaa` 4, `start` at `gl_msaa` 0 and `hw_e1m2` (7 fog volumes) at 4 each report "nothing differs beyond the noise
  between captures of one build" in all nine views, and `r_speeds` are identical in every view and every run. The
  noise between two captures of one build is large in the sky, water and bloom views (tens of thousands of pixels
  up to half the image for the animated sky and liquid views), so the comparison is a check against gross change and
  cannot see a few pixels; the frame trace above is the finer instrument for the order of draws and binds.
- **Not covered**: a real GPU, and Firefox. Both need a live run by the developer, as in the earlier phases.

### Phase 2: what shipped (2026-10-13)

Option 1: the frame records and checks its passes; call order is still the hand-written one. 2408 tests pass,
`npm run typecheck` and eslint are clean.

- **`renderer/frame/Frame.ts`**: `beginFrame()`, `beginPass(name, output, input?, extraInputs?)`, `continueIn(target)`,
  `endPass()`, `Frame.violations`, `Frame.records`, and the `r_framegraph` command. Every call is a `console.assert`, so
  a production build strips it with its arguments and keeps no record (the command says so). The checks are the ones
  of Goals: a pass samples a texture attached to its own output; samples a texture of a target that nothing drew into
  this frame (which covers a multisampled scene that was never resolved); ends with another framebuffer bound than the
  one it was opened with; a pass is left open or closed without having been opened.
- **Deviation from design B: there is no declarations file.** A pass declares itself by its call, the target it draws
  into and the textures it samples, and the frame learns the rest from the targets themselves (`RenderTarget.isAttached`,
  `ownerOf`, `bound`). A table of resource names would be a second description of the frame to keep in step with the
  one the code already has, and the matrix test can run the real code instead.
- **`RenderTarget`** gained `bound` and `unbind()`/`bindOutput()` (every bind goes through the class, so what GL has
  bound is known without asking it), `isAttached()` (honest about a depth texture that is swapped out),
  `ownerOf()`/`describeTexture()` and `persistent` (set on the sides of a `RenderTargetPair`).
  `test/renderer/framebuffer-binds.test.ts` fails when `bindFramebuffer`, `createFramebuffer` or `createRenderbuffer`
  appear anywhere under `client/` outside `RenderTarget.ts`.
- **Effects are handed their output**: `apply(input, x, y, width, height, settings, output)`, `output` being the target
  (`null` for the screen) and the viewport the chain set. `BloomEffect` and `BlurEffect` put it back with
  `RenderTarget.bindOutput` and no longer call `getParameter` (four sites). `PostProcess` keeps its two reads of the
  screen viewport, once per frame, which the caller (`GL.Set2D`) sets. `PostProcessEffect` has `passName` and
  `sampledTextures` (`UnderwaterFogEffect` lists scene and boundary depth, `BloomEffect` the emissive buffer).
- **Passes recorded**: `scene` (output `scene-msaa -> scene` when the resolve moved it), nested `turbulent-boundary`,
  `msaa-resolve` and `scene-depth-sample`; `gameplay-stack-writeback`; `post-process:<effect>` per effect, `present`
  when there is none, `shadow-topdown`, `shadow-point`, `overlays`. `ScreenFrame` starts the frame.
- **`PostProcess.active` stays.** The plan said to replace it by a query of the frame; but it is real state that the
  six readers need in a production build, which keeps no record, so the frame cannot answer it. It remains the one
  flag of "the scene is being captured".
- **Behavior is the same**; the one visible difference is that `window.engine.Frame` exists and `capture.mjs` records the
  passes and violations of each view when the build is a development one.
- **Tests**: `frame.test.ts` (13: what a good frame records and what each check catches, negative controls, the
  command's output), `frame-matrix.test.ts` (96 configurations of `gl_msaa` 0 and 4, 0, 1 and 3 depth sampling
  passes, underwater fog, bloom and four game stacks, over the real `PostProcess` code and real targets; no violation,
  the screen is bound at the end, nothing is left open; and a bloom that leaves its scratch target bound is reported
  together with the overlays that would have been drawn into it, the bug of `5f8a761`), `framebuffer-binds.test.ts`.
  Existing tests that run passes over fake targets silence `console.assert`, because a fake is never
  `RenderTarget.bound`.
- **Verified in Chromium, development builds, real maps** (`capture.mjs` with the frame record): `start` with
  `CAPTURE_WATERFOG=1` and `hw_e1m2` (7 fog volumes), nine views each, **0 violations in all 18**, and no failing
  assertion in the console. The record shows the structure: the underwater view is `shadow-topdown`, `scene`
  (`scene-msaa -> scene`) with `turbulent-boundary`, `msaa-resolve` and `scene-depth-sample` inside it, then
  `post-process:underwater-fog` into ping, `warp` into pong, `color-shift` to the screen, `overlays`; the fog volume
  view has six `scene-depth-sample` passes in one frame.

## Testing

- Unit: `RenderTarget` against a recording fake `gl` (create/attach/resize/free order, `drawBuffers`, multisample
  resolve with slot 0 re-bound). The existing `post-process-depth-sampling`, `post-process-resolve-binding`,
  `post-process-scene-capture` and `post-process-stack` tests are re-pointed, not dropped: each pins a bug that was real.
- Validator matrix: every combination of MSAA on/off, fog volumes, turbulents, underwater fog, bloom, scene-stage and
  final-stage entries, run against the declarations; asserts no pass samples what it writes, no pass reads a
  multisampled target unresolved, and the bound target after each scope equals the declared one.
- Regression for `5f8a761` (screen restored after the game's stack) stays and is expressed as a scope-exit check.
- Browser (required, `browser-ui-verification`): capture/compare per Phase 0's list after every phase, no GL warnings
  in the console, the dump read for one frame with fog volumes and one underwater. Not verifiable here: driver quirks
  on a real GPU, Firefox; those need the developer's run.

## Open questions

Settled 2026-10-13, before Phase 2: **1** Option 1, validated scopes, Phases 0 to 3; no compile step. **2** The validator
is development-only (`console.assert`, stripped in production) with the matrix test covering the call order. **3** The
`apply` signature change for the effects is accepted. Still open: 4, decided in Phase 3, and 5.

1. **Scope: Option 1 (validated scopes, Phases 0 to 3) or Option 2 (compiled graph, plus Phase 4), or stop after Phase
   1?** Recommendation: Option 1. The pass order is a fixed, short sequence; a compiler would hold the same list the
   scopes already hold, and its only dynamic input would be "does a game want to add a pass", which nothing asks for.
   The honest summary is that the gain is hazard checking and legibility, not performance, so the cost has to be weighed
   against the next renderer change that would have tripped over item 1 to 7.
2. **Validator in production builds?** Recommendation: development only (`console.assert`, as the convention says),
   with the matrix test covering the declarations.
3. **Is the `apply` signature change for the six effects acceptable?** It is engine-internal. Recommendation: yes.
4. **MSAA after the first depth-sampling pass: keep (document it), or keep drawing into the multisampled target,
   resolve into a side texture for the sampling pass, and resolve again at the end (a second resolve per frame)?**
   Decide after Phase 0 measures the difference in a capture and in frame time. Glass (`reads: sceneColor`) makes the
   second option the likely one: without it every color-reading pass ends the antialiased part of the frame. Default if
   the difference is not visible and no color read exists yet: keep and document.
5. **Does this belong in 1.3.0?** It is invisible to players. The umbrella plan's release scope lists D3 as part of
   "everything"; with F, G and D4 postponed this is the one renderer item left. Phase 0 and 1 are low-risk either way.

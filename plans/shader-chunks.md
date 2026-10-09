# Shader chunks: one copy of every shared GLSL routine

**Status:** Done, all phases shipped and committed 2026-10-09 (Phase 4 was taken, see below). Checked live by the
maintainer afterwards: hellwave, fog (including the `turbulent` exp-fog change) and the player model near shadow
casters (the `player.frag` `ptFade` change) look right. Track D1 of
`plans/engine-architecture-modernization.md`. The numbers in
"Context" are from a scripted survey of `source/engine/client/shaders/` on 2026-10-09.

## Context

The engine has 60 shader files (30 programs, `.vert` plus `.frag`, 2700 lines), all `#version 300 es`, loaded as
raw strings by one `import.meta.glob('./shaders/*.{vert,frag}', { eager: true, query: '?raw' })` in
[GL.ts](../source/engine/client/GL.ts) and compiled unchanged by `GL.CreateProgram` (29 call sites in `R.ts`,
`Draw.ts` and `GL.ts`). There is no `#include`, so `shaders.instructions.md` §4 and the
`shader-duplication-propagation` skill tell whoever edits a shared routine to grep for every copy and fix them all
by hand. Nothing enforces that, and the survey shows it has already failed once.

**Duplication, by kind**

| Kind | Where | Copies |
| :--- | :--- | :--- |
| Whole functions, identical | `samplePointShadowPCF` | `alias`, `mesh`, `player`, `brush` (.frag) |
| | `linearizeDepth` | `fog-volume`, `turbulent`, `underwater-fog` (.frag), each with its own `uniform mat4 uPerspective` |
| | `hash2D` | `shadow-alias`, `shadow-brush` (.frag) |
| Whole functions, **drifted** | `sampleLocalShadow` | `alias` differs from `mesh`/`player` only in a variable name (`lit` vs `rawShadow`): harmless |
| | `samplePointShadow` | `alias` and `mesh` are identical; **`player.frag` lacks the `ptFade` term** the other two got (the comment on it explains a light-bleed fix). Either an unported fix or a deliberate difference nobody wrote down |
| Declaration blocks | the shadow uniforms (`tShadowMap`, `uShadowEnabled`, `uShadowDarkness`, `uShadowMaxDepthNDC`, `uShadowLightDir`, three `tPointShadowMapN`, `uPointLightPosN`, `uPointLightRadiusN`, `uPointShadowEnabled`, `uPointShadowBias`) and the shared varyings (`vTexCoord`, `vLightDot`, `vDynamicLightDot`, `vFog`, `vShadowCoord`, `vWorldPos`, `vNormal`, `vLightVec`, `vDynamicLightVec`, `vViewVec`, `uFogColor`) | `alias`, `mesh`, `player` (.frag), partly `brush.frag` | 3 to 4 |
| Inline blocks | the fog-mode blend (`fogLinear`/`fogExp`/`fogExp2`/`isNoFog`/`isLinear`/`isExp`/`vFog = mix(...)`), 9 lines | `alias`, `mesh`, `player`, `brush`, `turbulent`, `sprite`, `decal`, `particle` (.vert) | 8 |
| | the `main()` lighting composition of the lit entity shaders (top-down shadow, facing mask, 3 point shadows combined with `min`, dlight fill, Blinn-Phong) | `alias`, `mesh`, `player` (.frag): 65 shared 6-line windows between each pair | 3 |
| | the vertex side of the same three | `alias.vert` and `player.vert` share 35 windows, `mesh.vert` 24 | 3 |
| Deliberately different | `brush.frag` has its own `sampleLocalShadowPCF` (54 lines, uses `uShadowMapSize`) and `samplePointLightContribution`; `fog-volume.frag` has `intersectAABB`, `sampleLightProbe`; `bloom-adapt.frag` has five helpers | one each: **not** shared, they stay where they are |

**Side finding: the shader text is in the server worker bundle.** `GL.ts` is in the import closure of the server
worker (the model loaders pull `GL`, `VID`, `Materials`, `Sky`; `engine-boundaries.test.mjs` lists it), and the
eager glob lives in `GL.ts`, so `dist/browser/libs/worker-ServerWorker-*.js` (777 KB) contains all 60 shaders
(`sampleLocalShadow` occurs 11 times in it). Dead weight in a realm that has no GL context. Chunks add a second glob
next to the first, so this gets worse unless it is fixed in the same change.

**What already helps**

- Programs are created in one place and all sources pass through `GL.CreateProgram`, so an include pass has a
  single seam.
- `glslangValidator` exists on this machine (it accepted `mesh.frag` as GLSL ES 3.00), so an offline compile check
  is possible without a browser. It is not in the Docker test image, so a test has to skip without it.
- Two tests read shader files directly with `readFileSync` (`turbulent.frag`, `bloom-blur.frag`) and look for
  strings. Chunking must not move what those look for, or they move with it.
- The Dockerfile copies `source` wholesale (`COPY source ./source`), so new chunk files need no Dockerfile change.

**Why not leave it** (the umbrella plan calls D1 "independent of A/B ... a quick win"): the `player.frag` drift above is a rendering inconsistency that was invisible until a script compared
the copies, and every lighting change costs a grep-and-hope across four files.

### Decisions already made with the developer

1. Shader chunking (D1) is the next piece of work after the registry removal (2026-10-09).
2. **Includes are expanded at runtime** by a pure `ShaderPreprocessor` in `GL.CreateProgram`, not by a Vite plugin
   (2026-10-09, Design A).
3. **`player.frag` adopts `mesh.frag`'s `samplePointShadow`** (with `ptFade`) in Phase 2. It is the one deliberate
   rendering change of the plan, shown with its own screenshot (2026-10-09).
4. **Commitment is Phases 1 to 3.** Phase 4 (lit-entity composition) is decided from what is left afterwards
   (2026-10-09).
5. **Moving the shader text out of `GL.ts` and the server worker bundle is part of Phase 1** (2026-10-09, Design C).

## Goals

- Every shared GLSL routine and declaration block exists once, in a chunk file, and programs pull it in with
  `#include`.
- The expansion is a plain function that can be tested in Node without a GL context, and compile errors from the
  driver point at `chunk-file:line`, not at a line number of an expanded blob.
- Phases 1 and 2 render **pixel-identically** to today (the one deliberate exception, `player.frag`, is a decision in
  "Open questions", not a side effect).
- Shader text leaves the server worker bundle.
- The `shader-duplication-propagation` skill and `shaders.instructions.md` §4 describe the new reality, because
  the duplication they teach around is gone.

## Non-goals (this pass)

- A frame graph, a GPU abstraction or WebGPU (D3/D4 of the umbrella plan), and splitting `R.ts` (D2).
- `#define`-driven shader variants or an ubershader that replaces `alias`/`mesh`/`player`. The three stay three
  programs.
- Reflection of uniform names from the compiled program. The uniform and attribute lists stay in the TypeScript
  that calls `GL.CreateProgram` (see Design D for the one thing worth revisiting).
- Rewriting any lighting model, changing the branchless style of `shaders.instructions.md`, or tuning visuals.
- Unifying shaders that differ on purpose (`brush.frag`'s PCF, `fog-volume.frag`'s volume code, bloom helpers).

## Design

### A. Include syntax and where it is expanded

```glsl
#version 300 es
precision highp float;
precision highp sampler2DShadow;
precision highp samplerCubeShadow;

#include "shadow-entity.glsl"
```

- Chunks live in `source/engine/client/shaders/include/*.glsl` (a subfolder, so the existing
  `shaders/*.{vert,frag}` glob and the program-name lookup `shaders/<identifier>.{vert,frag}` are untouched, and a
  chunk can never be mistaken for a program).
- `#include "name.glsl"` is a whole line on its own. Names are flat, relative to `include/`, no `..`, no URLs.
- `#version` and the `precision` statements stay in each program: `#version` has to be the first line of the final
  source, and precision has to precede the first use of a sampler type in a chunk. A chunk that needs a precision a
  program does not declare is a bug in the program, caught by the compile check (Phase 1).
- Each chunk is expanded **once per program** (like `#pragma once`), so chunks can include chunks without a
  diamond problem. A cycle, a missing chunk or a malformed line throws with the program name and the line.
- Expansion emits `#line` directives around every expanded chunk (`#line 1 <n>` going in, `#line <k> 0` coming
  back, GLSL ES 3.00 `source-string-number` form), and the expander returns a table mapping string numbers to file
  names. `GL.CreateProgram` uses it to rewrite the driver's `ERROR: 2:41:` into `shadow-entity.glsl:41`.

**Fork: when to expand.** Recommended: **at runtime, in `GL.CreateProgram`**, by a pure `ShaderPreprocessor`
class that is handed the raw strings. The alternative is a Vite plugin that expands at build time inside the `?raw`
load.

| | Runtime (recommended) | Build-time Vite plugin |
| :--- | :--- | :--- |
| Testable in plain Node | Yes, pure function over strings | Only through Vite, or by also exporting the function |
| Works in `vite build --watch`, the dev server and the dedicated build | Same code everywhere, nothing to configure | Needs the plugin in both Vite configs; chunk edits during `--watch` need the plugin to add file dependencies |
| Error mapping | Free: the expander owns the line table | Same, but the table has to cross the build/run boundary |
| Bundle size | Chunks stored once as strings | Expanded copies stored per program (bigger) |
| Cost | A few string passes at startup over 60 small files, well under a millisecond each | Zero at runtime |

The runtime cost is paid once, before the first frame, and the expanded source is cached per program for the
life of the page.

### B. Chunk layout (what moves, and what does not)

First cut, by what the survey found. A chunk owns the uniforms and varyings its functions read, so including it
is enough; a program does not redeclare them.

| Chunk | Contents | Replaces |
| :--- | :--- | :--- |
| `depth.glsl` | `uniform mat4 uPerspective;`, `linearizeDepth` | 3 copies |
| `hash.glsl` | `hash2D` | 2 copies |
| `shadow-point.glsl` | `samplePointShadowPCF` (pure: takes the sampler and direction) | 4 copies |
| `shadow-entity.glsl` | includes `shadow-point.glsl`; the entity shadow uniforms; `sampleLocalShadow`, `samplePointShadow` (the chunk declares the `vWorldPos`, `uPointShadowBias` and `uPointShadowEnabled` it reads) | 3 copies of two functions plus 3 declaration blocks |
| `fog-vertex.glsl` | `uniform vec4 uFogParams;`, `out float vFog;`, `float computeFog(float dist)` (the 9-line blend) | 8 copies (Phase 3) |
| `entity-lighting.glsl` | the shared fragment-side composition for `alias`/`mesh`/`player` | the 65-window block (Phase 4, optional) |

`brush.frag` includes `shadow-point.glsl` only: its local shadow test and dlight code are different on purpose and
stay in the file. If Phase 1 to 3 shows a chunk needs a per-program knob, it takes a function parameter or a
`const` the program declares before the include. No `#ifdef` configuration of chunks (a non-goal above).

Chunks are named for what they are, not who uses them, so a future program can include them.

### C. Where the shader sources live (and leaving the worker)

`GL.ts` today owns the glob. New split:

- `client/renderer/ShaderLibrary.ts` (name illustrative) owns the two globs (programs and chunks) and
  `ShaderPreprocessor`. It exposes `ShaderLibrary.build(identifier)` which returns `{ vertex, fragment, lineTable }`.
- `GL.CreateProgram` gets its sources from `GL.shaderLibrary`, a hook that `bootstrap/createBrowserClient.ts` fills
  in (the "Hooks" rule of `code-style-guide.instructions.md`), not from an import. `GL.ts` then no longer references
  shader text, so the server worker's closure loses it.
- `engine-boundaries.test.mjs` pins it: the closure of `ServerWorker.ts` must not contain `ShaderLibrary.ts`.
- The Node fallback stays (`shaderSources === null` throws "unavailable in this runtime"), now inside
  `ShaderLibrary`.

### D. Uniform names stay in TypeScript, with one thing to revisit

A chunk-owned uniform is still only live if the program's TypeScript lists it in the `uniforms` argument of
`GL.CreateProgram`, as today. Moving 20 shadow uniform declarations into a chunk does not remove the 20 names from
the call sites in `R.ts`. That is the same duplication in another language and the next candidate after this plan:
a per-chunk exported name list (`ShaderLibrary.uniformsOf('shadow-entity.glsl')`) that call sites spread into their
list. Not in this plan; recorded so it is not rediscovered.

### E. Tests and tooling

- `test/renderer/shader-preprocessor.test.ts`: include resolution, once-only expansion, nested includes, cycle,
  missing chunk, `#include` not alone on its line, `#line` and the file-name table, `#version` stays first.
- `test/renderer/shader-library.test.ts`: every program in the library expands without error, no `#include`
  survives, and the chunk table has no unused chunk (a chunk nobody includes is dead code).
- A compile check over every expanded program with `glslangValidator -S <stage>` when it is on `PATH`
  (skipped, loudly, when it is not: the Docker `test` stage has no glslang).
- Existing readers of shader files (`turbulent-lightstyle-interpolation`, `bloom-effect`) stay green or move with
  what they assert.
- Real browser (required): the page has to boot with all 30 programs compiled, and a before/after screenshot pair
  at a fixed camera on a map with entity shadows and a dlight must be pixel-identical for Phases 1 and 2
  (`browser-ui-verification`, `docs/browser-verification.md`).

### F. Documentation and skills

- `shaders.instructions.md` §4 ("No Shader Preprocessor Limits") is rewritten: shared routines live in
  `shaders/include/`, edit them there, and say which routines are still intentionally per-program.
- `.claude/skills/shader-duplication-propagation/SKILL.md` becomes `shader-chunks` (rename, new `description`):
  the trigger is "editing a chunk or adding a routine to a shader", the checklist is "does a chunk already have
  it, who includes the chunk you are changing, the compile check, the screenshot pair". The "does NOT introduce a
  preprocessor" paragraph goes. `CLAUDE.md`'s Known Traps entry follows.
- A short `docs/shader-chunks.md` (syntax, once-only rule, `#line`, error mapping, how to add a chunk).

## Phasing

Each phase ends with `npm test`, `npm run typecheck`, `npx eslint` green and the page booting, and stops for a
go-ahead.

### Phase 1: plumbing, no shader changes

- `ShaderPreprocessor` (pure) and `ShaderLibrary`, `GL.shaderLibrary` hook, the line table and the error
  rewrite in `GL.CreateProgram`, the boundary-test line. Every existing program expands to itself.
- Tests from E (preprocessor, library, glslang pass over all programs).
- Done when: the server worker bundle no longer contains shader text (compare `dist` before and after), all 30
  programs compile in a real browser, screenshots identical.

#### What actually shipped in Phase 1

- `client/renderer/ShaderPreprocessor.ts`: `ShaderPreprocessor` (pure, `expand(stageName, source)`, `chunkNames`) and
  `ExpandedShader` (`source`, `files`, `mapInfoLog`). A stage without includes comes back as the very same string.
- `client/renderer/ShaderLibrary.ts`: owns both globs (`../shaders/*.{vert,frag}`, `../shaders/include/*.glsl`, keyed by
  file name), caches `build(identifier)` per program, throws the old `MissingResourceError` text for a missing stage.
  The constructor takes the two maps, so tests build a library from files read with `fs`; `fromBundle()` is the only
  place that touches `import.meta.glob` and throws "unavailable in this runtime" under raw Node.
- `GL.ts` lost the glob; `GL.shaderLibrary` (a `ShaderSourceProvider`, interface declared in `GL.ts`) is filled by
  `createBrowserClient.ts`. `GL.CreateProgram` runs driver logs through `mapInfoLog`.
- Tests: `shader-preprocessor.test.ts` (28), `shader-library.test.ts` (10, including a glslang pass over all 60 stages
  and a glslang check that an error after a chunk maps back to the stage's own line), and a boundary test that the
  server worker closure has neither new file and `GL.ts` has no `import.meta.glob`.
- Deviation: `ShaderSourceProvider`/`ShaderStageSource` carry `mapInfoLog` on the stage instead of a separate line
  table, so `GL.ts` needs no value import from the preprocessor and the closure list in the boundary test stays as is.
- Measured: the server worker bundle went from 578,006 to 477,316 bytes and from 60 shaders to none (the survey above
  said 777 KB, that was a different build; the 60 are now only in `main-browser`). All 60 expanded stages are
  byte-identical to the files (script, not screenshots, which is the stronger proof while nothing is included yet).
- `#line n s` is "the next line is line n of string s" in both glslang and ANGLE (checked in Chromium, in and out of
  an include), which is what the expander emits.
- Real browser: Chromium (SwiftShader) boots the production build, single player starts E1M1 and renders world,
  viewmodel and HUD; no shader or page error (three 404s for optional assets: `conback.png`, `concharslarge.png`,
  `progs/beam.mdl`). No before/after screenshot pair was taken: nothing in Phase 1 can change a pixel and the
  byte-identity check says so. Phase 2 needs the pair.

### Phase 2: function chunks

- `depth`, `hash`, `shadow-point`, `shadow-entity`, with the `player.frag` decision applied.
- Done when: the four duplicated function groups of the survey exist once; the survey script reports no function
  defined in more than one file except the intentional ones; screenshots identical (the `player.frag` change, if
  adopted, is shown separately with a case that exercises it).

#### What actually shipped in Phase 2

- Four chunks in `shaders/include/`: `depth.glsl` (`uPerspective`, `linearizeDepth`; 3 programs), `hash.glsl` (`hash2D`; 2),
  `shadow-point.glsl` (`samplePointShadowPCF`; included by `brush.frag` and by `shadow-entity.glsl`) and
  `shadow-entity.glsl` (the 16 shadow uniforms, `vWorldPos`, `sampleLocalShadow`, `samplePointShadow`; `alias`, `mesh`,
  `player`). The chunks were cut out of the existing text by script, which asserted the copies matched (same uniform
  sets, identical PCF in all four files) before it replaced them. 396 lines left the programs, 132 are in chunks.
- `shadow-entity.glsl` takes `mesh.frag`'s wording of `sampleLocalShadow` (`rawShadow` instead of `lit`, no behavior
  difference) and `mesh.frag`'s `samplePointShadow`. So **`player.frag` now has the `ptFade` term** (decision 3).
  The comment above the point-shadow uniforms is generic now; each program keeps its own comment where it combines
  the three results.
- New test: no function is defined in more than one shader file (the survey as a permanent check, no allowlist
  needed: nothing is intentionally duplicated any more). `brush.frag`'s own `samplePointLightContribution` and
  `sampleLocalShadowPCF` are unique names and stay. The glslang pass and the "every chunk is used" test now cover real
  chunks. `shadow-alias.frag` and `shadow-brush.frag` are byte-identical whole files (found on the way, left alone).
- Real browser, before/after, same scene, built from HEAD and from the working tree with the same settings
  (`VITE_GAME_DIR=hellwave`, `VITE_BASE_DIR=librequake`, each served by a throwaway static server in front of the
  running dedicated server's `/qfs`): paused single player on `hw_e1m2`, a fixed camera, two injected dlights with
  point shadows, all weapons. First person (large alias viewmodel plus world): **0 differing pixels** outside the pixels
  that animate on their own (sky and turbulent surfaces, 68,845 of 460,800, measured from the baseline's own
  run-to-run and in-run variation). Third person (the `player` program): world identical (0 px on one capture, 549 px
  at 1 level on the other).
- **Not shown:** the visible effect of `ptFade` on the player model. The idle pose differs from run to run (it is
  whichever frame the pause hit; pinning `frame` from the page did not hold), so the player's pixels cannot be compared
  across builds. The term only acts in the outer 15% of a light's radius, where the dlight's own linear falloff is
  already close to zero, so a large visible change is not expected. This needed a look in a live session, and the maintainer confirmed it looks right near shadow casters.
- `main-browser` went from 773,626 to 763,028 bytes.
- Harness notes for Phase 3: `chase_active 1` shows the player model; the sky, turbulent surfaces and the HUD timer
  animate regardless of `pause`, so a comparison needs a noise mask. Do not run `vite build --watch` and a scratch
  build at once into the same `dist/`.

### Phase 3: declaration blocks and the fog blend

- The varyings/uniform blocks and `fog-vertex.glsl` (8 vertex shaders).
- Done when: no `isNoFog` outside the chunk; screenshots identical on a fogged map.

### Phase 4 (optional, its own go/no-go): the lit-entity composition

- `entity-lighting.glsl` for the fragment `main()` bodies of `alias`/`mesh`/`player`, and the vertex side. Needs
  parameters for what differs (specular shininess/intensity, `tLuminance`, `uTop`/`uBottom`). The decision is made on
  what Phases 2 and 3 leave: if the remaining duplication is small, stop.

### Phase 5: docs and skills

- F above. Could ride along with each phase; listed separately so it is not forgotten.

#### What actually shipped in Phase 3

- `fog-vertex.glsl` (`uFogParams`, `out vFog`, `computeFog(dist)`) in the 8 vertex shaders that had the blend inline
  (`alias`, `mesh`, `player`, `brush`, `turbulent`, `sprite`, `decal`, `particle`); `fog-fragment.glsl` (`in vFog`,
  `uFogColor`) in the nine fragment shaders that read them (`alias`, `mesh`, `player`, `brush`, `turbulent`, `sprite`,
  `decal`, `particle`, `sky`).
  `sky.vert` keeps its own `vFog = step(uFogParams.w, -0.5)` (it is deliberately different), so it does not include
  `fog-vertex.glsl`. `isNoFog` now occurs only in the chunk, and a test pins that.
- `entity-varyings-out.glsl` / `entity-varyings-in.glsl`: vertex outputs and fragment inputs cannot be one chunk
  (`out` vs `in`), so they are a pair. `brush` stays out of them (its `vTexCoord` is a `vec4`). **The glslang test now
  links each vertex/fragment pair** (`-l`), which is the check that catches a varying only one side declares; compiling a stage on its own does not.
- **A second deliberate rendering change, found by the dedup:** `turbulent.vert` fed the exp and exp2 fog modes a
  *normalized* distance (`distNorm`, 0 to 1) where all seven other copies use the world distance. The survey had
  called the eight blends identical. With exp fog this left water and lava almost unfogged (crop in the "before"
  build: brownish lava surfaces standing out of the fog). It now uses the shared blend. Linear fog is unaffected.
  It dates from the shaders' first import (`ed4ede5`) with no stated reason; revert by giving `computeFog` a second
  distance if it turns out to be wanted.
- Real browser, same harness as Phase 2: linear fog first-person is **0 differing pixels** outside the animated ones
  (23,187 masked), which covers all eight vertex shaders that do the blend, the viewmodel included. With exp fog the
  only difference is where the lava surfaces are (max delta about 10 of 255), as intended.

#### What actually shipped in Phase 4

Taken, because what was left after Phase 3 was the lighting block (about 35 lines) in three fragment shaders and
three vertex mains, i.e. the "every lighting change is a grep across files" cost the plan started from.
- `entity-lighting.glsl`: `computeEntityLighting(specularShininess, specularIntensity, out lighting, out specular)`,
  owning the three light uniforms, `shadow-entity.glsl` and `entity-varyings-in.glsl`. The programs pass their
  specular constants as arguments and keep their texturing and emissive output.
- `entity-vertex.glsl`: the shared uniforms and `emitEntityVertex(localPosition, localNormal, texCoord)`. `alias.vert`,
  `player.vert` and `mesh.vert` are now 12 to 15 lines each (alias and player are byte-identical programs; they stay
  two files because the TypeScript names them).
- Float operation order was kept (the player's one-line lighting sum is the same left-to-right expression as
  mesh's), so a pixel-identical result was the expectation, and it held: first person with and without fog,
  **0 differing pixels** outside the animated ones; third person: world identical (84 px at 1 level), the player
  model is masked by its varying pose as before.
- Shader line count: 2,700 before the plan; the programs are now 1,952 lines plus 276 in chunks.

#### What actually shipped in Phase 5

`shaders.instructions.md` §4 rewritten, `.claude/skills/shader-duplication-propagation` renamed to `shader-chunks`
with a new description and checklist, the `CLAUDE.md` Known Traps line follows, `docs/shader-chunks.md` (syntax,
once-only rule, `#line`, the chunk table, adding a chunk), a "Comparing two builds" section in
`docs/browser-verification.md` (the scratch-build and noise-mask recipe, and the `VITE_GAME_DIR` trap).

## Testing

See E. Phases 1 to 3 change no rendering on purpose, so the screenshot comparison is the real test; unit tests prove
the expander, not the pixels. Headless Chromium here renders WebGL2 in software, which is enough for identity
checks and useless for performance questions. Frame time is not expected to change (the driver sees the same GLSL
modulo comments), and Phase 1 checks that by looking at the compiled source length and a frame-time sample rather
than by claim.

## Open questions

None open. The four forks (expansion time, the `player.frag` fade, how far to commit, moving the shader text out of
the worker bundle) are settled in "Decisions already made". New questions get added here as the phases surface them.

Not forks, decided here and open to veto: chunk folder `shaders/include/*.glsl` (named `chunks/` in the first draft, renamed to `include/` after Phase 5 since that is the usual name for the folder `#include` reads from); flat chunk names; chunks own the
uniforms their functions read; per-program once-only expansion; `#version` and `precision` stay in programs.

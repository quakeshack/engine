# Shader chunks: one copy of every shared GLSL routine

**Status:** Forks settled 2026-10-09, ready for a go-ahead on Phase 1. Track D1 of
`plans/engine-architecture-modernization.md`. Nothing is built. The numbers in
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

- Chunks live in `source/engine/client/shaders/chunks/*.glsl` (a subfolder, so the existing
  `shaders/*.{vert,frag}` glob and the program-name lookup `shaders/<identifier>.{vert,frag}` are untouched, and a
  chunk can never be mistaken for a program).
- `#include "name.glsl"` is a whole line on its own. Names are flat, relative to `chunks/`, no `..`, no URLs.
- `#version` and the `precision` statements stay in each program: `#version` has to be the first line of the final
  source, and precision has to precede the first use of a sampler type in a chunk. A chunk that needs a precision a
  program does not declare is a bug in the program, caught by the compile check (Phase 1).
- Each chunk is expanded **once per program** (like `#pragma once`), so chunks can include chunks without a
  diamond problem. A cycle, a missing chunk or a malformed line throws with the program name and the line.
- Expansion emits `#line` directives around every expanded chunk (`#line 1 <n>` going in, `#line <k> 0` coming
  back, GLSL ES 3.00 `source-string-number` form), and the expander returns a table mapping string numbers to file
  names. `GL.CreateProgram` uses it to rewrite the driver's `ERROR: 2:41:` into `chunks/shadow-entity.glsl:41`.

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
  `shaders/chunks/`, edit them there, and say which routines are still intentionally per-program.
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

### Phase 2: function chunks

- `depth`, `hash`, `shadow-point`, `shadow-entity`, with the `player.frag` decision applied.
- Done when: the four duplicated function groups of the survey exist once; the survey script reports no function
  defined in more than one file except the intentional ones; screenshots identical (the `player.frag` change, if
  adopted, is shown separately with a case that exercises it).

### Phase 3: declaration blocks and the fog blend

- The varyings/uniform blocks and `fog-vertex.glsl` (8 vertex shaders).
- Done when: no `isNoFog` outside the chunk; screenshots identical on a fogged map.

### Phase 4 (optional, its own go/no-go): the lit-entity composition

- `entity-lighting.glsl` for the fragment `main()` bodies of `alias`/`mesh`/`player`, and the vertex side. Needs
  parameters for what differs (specular shininess/intensity, `tLuminance`, `uTop`/`uBottom`). The decision is made on
  what Phases 2 and 3 leave: if the remaining duplication is small, stop.

### Phase 5: docs and skills

- F above. Could ride along with each phase; listed separately so it is not forgotten.

## Testing

See E. Phases 1 to 3 change no rendering on purpose, so the screenshot comparison is the real test; unit tests prove
the expander, not the pixels. Headless Chromium here renders WebGL2 in software, which is enough for identity
checks and useless for performance questions. Frame time is not expected to change (the driver sees the same GLSL
modulo comments), and Phase 1 checks that by looking at the compiled source length and a frame-time sample rather
than by claim.

## Open questions

None open. The four forks (expansion time, the `player.frag` fade, how far to commit, moving the shader text out of
the worker bundle) are settled in "Decisions already made". New questions get added here as the phases surface them.

Not forks, decided here and open to veto: chunk folder `shaders/chunks/*.glsl`; flat chunk names; chunks own the
uniforms their functions read; per-program once-only expansion; `#version` and `precision` stay in programs.

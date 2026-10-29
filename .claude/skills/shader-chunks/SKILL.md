---
name: shader-chunks
description: Use when editing any .frag/.vert under source/engine/client/shaders/ or a chunk in shaders/include/. Covers the GLSL style rules, the #include chunk mechanism (a chunk edit changes every program that includes it), the link check and the before/after screenshot recipe.
---

# Shaders: style rules and chunks

WebGL 2 (GLSL ES 3.00) shaders live in `source/engine/client/shaders/*.frag` and `*.vert`.

## Style rules

1. **Branchless math over flow control.** `if`/`else` trees diverge warps and stall. Compute every path and blend with `mix()` and `step()`.
   ```glsl
   // Avoid: if (uFogMode == 0.0) val = linearFog; else if (uFogMode == 1.0) val = expFog;
   float isLinear = step(uFogMode, 0.5);
   float isExp = step(abs(uFogMode - 1.0), 0.5);
   val = mix(expFog, linearFog, isLinear);
   ```
   In utility functions, replace an early return (`if (z < 0.0 || z > 1.0) return 1.0;`) with a mask (`float zValid = step(0.0, z) * step(z, 1.0);`) and `mix()` the result. Cascade and shadow-step selection is `step()`-weighted too, not nested `if`s.
   The exception: an `if` on a uniform that skips texture reads. Every fragment of the draw takes the same side, so it does not diverge, and computing both sides would pay the reads for nothing (`turbulent.frag` skips its refraction reads when `uRefraction` is 0). Cheap math stays branchless.
2. **Vectorize.** `color.rgb = pow(color.rgb, vec3(uGamma));` and `color.rgb = base.rgb * mix(vec3(1.0), light.rgb, a);`, never one statement per channel.
3. **Safe normalization without a guard.** Clamp the denominator: `worldNormal /= max(normalLen, 0.0001);` and scale a dependent term with `step(0.0001, normalLen)`.
4. **Unroll small kernels** (a 3x3 blur is nine `texture()` calls with constant offsets) so the result does not depend on the driver unrolling a loop.

## Shared routines live in chunks

GLSL ES 3.00 has no `#include`, so QuakeShack expands it: `ShaderPreprocessor` (called in `GL.CreateProgram` through `ShaderLibrary`) replaces a whole line `#include "name.glsl"` with `source/engine/client/shaders/include/name.glsl`, once per stage. Details: `docs/shader-chunks.md`.

- **Edit a shared routine in its chunk, once.** Never paste it into a program. `#version` and the `precision` statements stay in each program, ahead of the first include.
- **A chunk owns the uniforms and varyings its functions read.** The program must not declare them again (redeclaration error).
- **Vertex outputs and fragment inputs come as pairs** (`fog-vertex.glsl`/`fog-fragment.glsl`, `entity-varyings-out.glsl`/`entity-varyings-in.glsl`) because `out` and `in` cannot share a chunk. Change both sides together. Linking catches a mismatch, compiling alone does not.
- **Per-program differences are function parameters or a `const` declared before the include**, not `#ifdef`. There is no `#define`-driven variant system and no ubershader.
- **Still per program on purpose:** `brush.frag`'s `sampleLocalShadowPCF` and `samplePointLightContribution`, `fog-volume.frag`'s volume code, the bloom helpers, `sky.vert`'s `vFog`. Do not unify these without a reason; say why in a comment when two programs differ on purpose.
- **Name a chunk for what it is** (`fog-vertex.glsl`), not for who uses it.

## Checklist

1. **Does a chunk already have it?** `ls source/engine/client/shaders/include/` and `grep -rn "<routine>" source/engine/client/shaders/`. The test `no function is defined in more than one shader file` fails if you re-declare one.
2. **Who includes the chunk you are about to change?** `grep -ln '#include "<chunk>"' source/engine/client/shaders/*.{vert,frag} source/engine/client/shaders/include/*.glsl`. That list, plus the chunks that include it, is the blast radius. Read the callers before changing a signature.
3. **A routine that would appear in a second file becomes a chunk** (or extends one) and is included.
4. **Check.** `node --import tsx --test test/renderer/shader-library.test.ts` expands every program and, when `glslangValidator` is on `PATH`, compiles and *links* each one. Without glslang the test skips; then boot the page, a driver message names the chunk and line (`ERROR: shadow-entity.glsl:41:`).
5. **A visible change needs a before/after screenshot pair** (`browser-ui-verification`, and "Comparing two builds" in `docs/browser-verification.md`). A dedup that should not change a pixel is proven by a pair that is identical outside what animates on its own; a deliberate rendering change is shown by its own pair.
6. **Uniform name lists are still manual.** A chunk-owned uniform is only live when the program's TypeScript lists it (`renderer/programs/ShaderPrograms.ts`/`Draw.ts`, the `uniforms` argument of `GL.CreateProgram`); an unlisted one silently reads 0. `test/renderer/shader-programs.test.ts` fails for a program in `ShaderPrograms.ts` that declares a uniform it does not list (not for `Draw.ts`).

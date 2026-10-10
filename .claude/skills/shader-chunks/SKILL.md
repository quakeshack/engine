---
name: shader-chunks
description: Use whenever editing a .frag or .vert file under source/engine/client/shaders/, adding a routine, uniform or varying to a shader, or touching anything in shaders/include/. Shared GLSL lives once in include/*.glsl and programs pull it in with #include, so the trap is the opposite of copy-paste drift: a change to a chunk silently changes every program that includes it, and a routine pasted into a program instead of a chunk starts a new copy. Also covers the compile/link check and the before/after screenshot recipe for shader changes.
---

# Shader chunks

Shared GLSL is not copied between programs. It lives in `source/engine/client/shaders/include/*.glsl`
and a program pulls it in with `#include "name.glsl"` (a whole line, flat name, expanded once per stage by
`ShaderPreprocessor`, see `docs/shader-chunks.md`). `shaders.instructions.md` §4 has the rules in short.

## Fast path

1. **Does a chunk already have it?** `ls source/engine/client/shaders/include/` and
   `grep -rn "<routine>" source/engine/client/shaders/`. A routine that exists in a chunk is edited there, never
   re-declared in a program. The test `no function is defined in more than one shader file` fails if you do.
2. **Who includes the chunk you are about to change?** `grep -ln '#include "<chunk>"' source/engine/client/shaders/*.{vert,frag} source/engine/client/shaders/include/*.glsl`.
   Every program in that list changes with it, and so does every chunk that includes it. That list is the
   blast radius; read the chunk's callers before changing a signature.
3. **A new shared routine goes in a chunk.** If the same logic would appear in a second file, make or extend a chunk
   and include it. Name the chunk for what it is (`fog-vertex.glsl`), not for who uses it. A chunk owns the uniforms
   and varyings its functions read; the program must not declare them again (that is a redeclaration error).
   Vertex outputs and fragment inputs cannot share a chunk (`out` vs `in`), so those come as a pair
   (`entity-varyings-out.glsl` / `entity-varyings-in.glsl`, `fog-vertex.glsl` / `fog-fragment.glsl`). Change both
   sides together.
4. **Per-program differences are not chunk knobs.** There is no `#ifdef` configuration. Pass what differs as a
   function parameter or a `const` the program declares *before* the include. If two programs differ on purpose
   (`brush.frag`'s own PCF, `sky.vert`'s `vFog`), leave them separate and say why in a comment.
5. **Check.** `node --import tsx --test test/renderer/shader-library.test.ts` expands every program and, when
   `glslangValidator` is on `PATH`, compiles and *links* each one. The link is what catches a varying that only one
   stage declares. Without glslang the test skips; then boot the page, a driver message names the chunk and line
   (`ERROR: shadow-entity.glsl:41:`).
6. **A visible change needs a before/after screenshot pair** (`browser-ui-verification`, and "Comparing two builds"
   in `docs/browser-verification.md`). A dedup that should not change a pixel is proven by a pair that is identical
   outside what animates on its own; a deliberate rendering change is shown by its own pair.

## What this skill does NOT do

- It does not add `#define`-driven shader variants or an ubershader.
- It does not cover the uniform name lists in `renderer/programs/ShaderPrograms.ts`/`Draw.ts` (`GL.CreateProgram`'s `uniforms` argument). A
  chunk-owned uniform is only live when the program's TypeScript lists it there; that list is still maintained by
  hand.

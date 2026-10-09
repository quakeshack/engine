# Shader Chunks

GLSL ES 3.00 has no `#include`. QuakeShack adds one so that a shared routine, uniform or varying exists once, in a
chunk file, and every program that needs it includes it.

## Syntax

```glsl
#version 300 es
precision highp float;
precision highp sampler2DShadow;
precision highp samplerCubeShadow;

#include "shadow-entity.glsl"
```

- `#include "name.glsl"` has to be the only thing on its line. The name is flat (no path separators, no `..`) and is
  looked up in `source/engine/client/shaders/include/`. A malformed line, an unknown chunk or a name that is not a plain
  `*.glsl` file name throws with the program, the file and the line.
- `#version` and the `precision` statements stay in the program: `#version` has to be the first line, and the
  precision of a sampler type has to be declared before the first chunk that uses it. A chunk must not contain
  `#version`.
- A chunk is expanded **once per stage** (like `#pragma once`), so chunks can include chunks, and two paths to the same
  chunk are fine. A cycle throws. The program's vertex and fragment stage are expanded on their own.
- A chunk owns the uniforms and varyings its functions read, so including it is enough. Do not declare them again in
  the program.
- There is no `#ifdef` configuration of chunks. What differs per program is a function parameter or a `const` the
  program declares before the include.

## Where it runs

`ShaderPreprocessor` (`client/renderer/ShaderPreprocessor.ts`) is a pure class over strings: no GL context, no file
system, so it runs in Node tests. `ShaderLibrary` (`client/renderer/ShaderLibrary.ts`) owns the two
`import.meta.glob` calls (programs `shaders/*.{vert,frag}`, chunks `shaders/include/*.glsl`) and caches the expanded
program. `bootstrap/createBrowserClient.ts` installs it into `GL.shaderLibrary`, and `GL.CreateProgram` asks it for the
sources. `GL.ts` itself holds no shader text, so the server worker bundle does not either (pinned by
`test/common/engine-boundaries.test.mjs`). A new shader file is picked up by the glob; restart a running
`vite build --watch` after adding one.

## Error messages

Expansion wraps every chunk in `#line` directives (`#line 1 <n>` going in, `#line <k> 0` coming back, where `n` is
the source string number of the file). The expander keeps the table, and `GL.CreateProgram` runs the driver's info log
through it, so `ERROR: 2:41: 'x' : undeclared identifier` is reported as
`ERROR: shadow-entity.glsl:41: 'x' : undeclared identifier`. In ES 3.00 (glslang and ANGLE alike) `#line n s` makes the
*next* line line `n` of string `s`.

## The chunks

| Chunk | Contents | Included by |
| :--- | :--- | :--- |
| `depth.glsl` | `uPerspective`, `linearizeDepth` | `fog-volume`, `turbulent`, `underwater-fog` (.frag) |
| `hash.glsl` | `hash2D` | `shadow-alias`, `shadow-brush` (.frag) |
| `shadow-point.glsl` | `samplePointShadowPCF` (pure) | `brush.frag`, `shadow-entity.glsl` |
| `shadow-entity.glsl` | entity shadow uniforms, `vWorldPos`, `sampleLocalShadow`, `samplePointShadow` | `alias`, `mesh`, `player` (.frag) |
| `fog-vertex.glsl` | `uFogParams`, `vFog` (out), `computeFog(dist)` | `alias`, `mesh`, `player`, `brush`, `turbulent`, `sprite`, `decal`, `particle` (.vert) |
| `fog-fragment.glsl` | `vFog` (in), `uFogColor` | the matching fragment shaders and `sky.frag` |
| `entity-varyings-out.glsl` / `entity-varyings-in.glsl` | the vertex outputs / fragment inputs shared by the lit entity programs | `entity-vertex.glsl` / `entity-lighting.glsl` |
| `entity-vertex.glsl` | the vertex side of a lit entity: shared uniforms, `emitEntityVertex(position, normal, texCoord)` (position, shadow coordinates, light vectors, fog) | `alias`, `mesh`, `player` (.vert) |
| `entity-lighting.glsl` | the fragment side: `computeEntityLighting(shininess, intensity, lighting, specular)` (top-down and point shadows, shade and dynamic light, Blinn-Phong) | `alias`, `mesh`, `player` (.frag) |

Vertex outputs and fragment inputs cannot be one chunk (`out` vs `in`), so they come as pairs. Linking a program
fails when one side declares a varying the other does not, which is what the glslang link test checks.

What a lit entity program keeps for itself: its attributes and how it builds the object-space position (alias and player
interpolate two frames, mesh does not), its texturing, the specular constants it passes in, its emissive output.

Still per program on purpose: `brush.frag`'s `sampleLocalShadowPCF` and `samplePointLightContribution`,
`fog-volume.frag`'s volume code, the bloom helpers, `sky.vert`'s `vFog`.

## Adding a chunk

1. Create `shaders/include/<name>.glsl`, named for what it is. Put the uniforms and varyings its functions read in it.
2. `#include` it from the programs, after their `precision` statements. Remove the copies they had.
3. Add the uniform names to the `uniforms` argument of the program's `GL.CreateProgram` call in `R.ts`/`Draw.ts`
   when they were not there. The list of live uniform names is still TypeScript, not read back from the compiled
   program.
4. `node --import tsx --test test/renderer/shader-library.test.ts`: every program expands, no function is defined in
   two files, every chunk is included by something, and (with `glslangValidator` on `PATH`) every program compiles and
   links. Without glslang the compile check skips; the page then reports the error with the chunk file and line.
5. For anything visible, a before/after screenshot pair, see `browser-verification.md`.

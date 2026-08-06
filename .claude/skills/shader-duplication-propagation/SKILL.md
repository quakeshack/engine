---
name: shader-duplication-propagation
description: Use whenever editing a shared routine (lighting math, shadow sampling, fog, tonemapping, or any helper function) inside a .frag or .vert file under source/engine/client/shaders/. This codebase has no #include preprocessor step, so shared GLSL routines are hand-duplicated verbatim across independent shader files (e.g. sampleLocalShadow currently exists in 4 separate files). Editing one copy without finding and updating every other copy leaves a silent, hard-to-spot rendering bug in the untouched shaders.
---

# Shader duplication propagation

`shaders.instructions.md` §4 states the consequence directly: because there's no
`#include`, "shared routines (like `sampleLocalShadow` or lighting math) must be
structurally duplicated across independent shaders," and the action required is to "grep
and update all manually duplicated instances consistently." Nothing else enforces this —
a shader compiles fine with only one copy fixed, so a missed duplicate is a silent visual
bug (wrong shadows/fog/lighting in whichever shaders didn't get the fix), not a build
error.

## Fast path

1. Before editing, identify the exact routine/function name being changed (e.g.
   `sampleLocalShadow`, a fog blend helper, a tonemap curve).
2. Grep for every other file containing it, across both extensions:
   ```bash
   grep -rl "<routine name>" source/engine/client/shaders/
   ```
3. List every match before making the edit — this is the propagation checklist for this
   change, not just the one file you started in.
4. Apply the same logical fix to each file. Exact byte-for-byte duplication isn't required
   (surrounding uniforms/varyings differ per shader), but the routine's *behavior* must
   match across all copies — the whole point is that `alias.frag`, `mesh.frag`,
   `player.frag`, etc. render lighting/shadows/fog identically.
5. After editing, re-run the grep to confirm no copy was missed, and verify visually via
   the `browser-ui-verification` skill if the change is visible (shadows, fog, lighting) —
   a shader that compiles is not proof it renders correctly everywhere it's duplicated.

## What this skill does NOT do

- Does not introduce a preprocessor/`#include` build step to eliminate the duplication —
  that's a real architectural option but out of scope for a single shader edit; raise it
  as a separate discussion if the duplication burden is the actual complaint.
- Does not apply to shader-local code that's genuinely unique to one file (e.g. a
  material-specific blend mode) — only to routines that are deliberately the same logic
  copy-pasted across files.

# GLSL Shader Optimization & Style Guide

When writing or modifying WebGL 2 (GLSL ES 3.00) shaders in QuakeShack (`source/engine/client/shaders/*.frag` and `*.vert`), adhere to these performance patterns and learnings to ensure optimal GPU execution.

## 1. Branchless Math Over Flow Control
GPU execution units process fragments in parallel (warps/wavefronts). `if-else` trees cause thread divergence and significantly stall execution. Always prefer branchless arithmetic.

- **State & Mode Selection**: Instead of branching on a conditional uniform (`if (mode == 0) ... else if (mode == 1) ...`), compute all paths and blend them using `mix()` and `step()`.
  ```glsl
  // Avoid:
  if (uFogMode == 0.0) val = linearFog;
  else if (uFogMode == 1.0) val = expFog;

  // Prefer:
  float isLinear = step(uFogMode, 0.5);
  float isExp = step(abs(uFogMode - 1.0), 0.5);
  val = mix(expFog, linearFog, isLinear);
  ```

- **Early Returns in Utility Functions**: Avoid early exits like `if (coord.z < 0.0) return 1.0;`. Calculate a valid/fade mask using `step()` and `mix()` the final returned value.
  ```glsl
  // Avoid:
  if (z < 0.0 || z > 1.0) return 1.0;

  // Prefer:
  float zValid = step(0.0, z) * step(z, 1.0);
  ```

- **Cascades & Shadow Steps**: Replace nested cascade checks (`if (uShadowCount > 1) s = min(s, ...);`) with `step()`-weighted mathematical comparisons.

## 2. Vectorize Per-Component Operations (SIMD)
Native GLSL functions operate optimally on vectors. Breaking operations down into individual scalar channels wastes instruction cycles and bloats the shader.

- **Avoid scalar repetition**:
  ```glsl
  color.r = pow(color.r, uGamma);
  color.g = pow(color.g, uGamma);
  color.b = pow(color.b, uGamma);

  color.r = base.r * mix(1.0, light.r, a);
  // ... repeated for g, b
  ```

- **Prefer vectorized operations**:
  ```glsl
  color.rgb = pow(color.rgb, vec3(uGamma));
  color.rgb = base.rgb * mix(vec3(1.0), light.rgb, a);
  ```

## 3. Safe, Branchless Normalization
Instead of using `if (len > 0.0)` guard checks to prevent division-by-zero when normalizing vectors or dealing with lengths, clamp the denominator.

- **Prefer**:
  ```glsl
  float normalLen = length(worldNormal);
  worldNormal /= max(normalLen, 0.0001); // Safe, branchless normalization
  worldPos += worldNormal * bias * step(0.0001, normalLen);
  ```

## 4. No Shader Preprocessor Limits
QuakeShack currently uses raw GLSL ES 3.00 directly in JavaScript without a preprocessor build step (no `#include`).
- **Consequence**: Shared routines (like `sampleLocalShadow` or lighting math) must be structurally duplicated across independent shaders (`alias.frag`, `mesh.frag`, `player.frag`, etc.).
- **Action**: When updating a core rendering mechanism, remember to grep and update all manually duplicated instances consistently.

## 5. Loop Unrolling for Small Kernels
While modern graphics drivers eventually unroll static loops (like a 3x3 gaussian blur), explicitly unrolling them into linear texture fetches (e.g. 9 `texture()` calls with hardcoded offsets) ensures consistent optimized performance and prevents dynamic loop overheads across all downstream mobile and discrete GPUs.

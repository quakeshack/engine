# `GL.Bind`/`Bind3D`/`BindArray`/`BindCube` replacement

## Status

✅ Done — implemented in full, all 8 phases below. `GL.Bind`, `GL.Bind3D`, `GL.BindArray`, and
`GL.BindCube` are deleted from `GL.ts`; `grep -rn "GL\.\(Bind\|Bind3D\|BindArray\|BindCube\)("`
across `source/` returns zero results. Verified with `tsc --noEmit`, `eslint --fix` on every
touched file, and the full `npm test` suite (1280 tests passing) after each phase. This is Tier 4
item 1 from `plans/deprecated-todo-triage.md`. Scope confirmed with the user twice:
(1) do the full migration for `GL.Bind`, not just a doc-comment fix, because
the abstraction implied by `@deprecated` genuinely doesn't exist yet for the
vast majority of call sites; (2) generalize to `GL.Bind3D`/`GL.BindArray`/
`GL.BindCube` too, since they have the exact same problem under a different
(untagged) name.

## Problem recap

`GL.Bind(target, texnum, flushStream?)` in `source/engine/client/GL.ts` is
marked `@deprecated` with no successor referenced anywhere. It has 68 call
sites across 12 files. Initially it looked like the "successor" might already
be `GLTexture.bind()` (an instance method with an identical bind-cache
algorithm), so the fix might just be "point callers at the instance they
already have."

That's not the actual shape of the problem. All 68 call sites were audited —
**none of them bind a `GLTexture`-wrapped asset**. Every single one binds a
raw `WebGLTexture` handle owned by engine-internal render-target / effect code
(`R.ts` lightmap and dlight textures, `PostProcess.ts` scene/ping-pong
buffers, `ShadowMap.ts` top-down depth textures, `BloomEffect.ts` and
`BlurEffect.ts` intermediate buffers). `GLTexture` can't absorb these as-is —
it hardcodes RGBA8 + mipmap generation + a global identifier cache built for
loaded assets (WAD lumps, image files), whereas the render-target textures use
`DEPTH_COMPONENT24`, `R8`, `RGBA` without mipmaps, `texStorage2D` (immutable)
in some cases and `texImage2D` (resizable) in others, and are never meant to
be looked up by name.

`GL.Bind3D`, `GL.BindArray`, and `GL.BindCube` are not tagged `@deprecated`,
but auditing their 26 combined call sites turns up the identical pattern:
raw `WebGLTexture` fields with no owner, bound through a static helper.
Specifically:

- `GL.Bind3D` — fog-volume light-probe textures owned by
  `BrushModelRenderer.ts` (`#fogLightProbes` map values, `#fogLightProbeWhite`).
- `GL.BindArray` — `R.ts`'s `deluxemap_texture`, `lightmap_texture`,
  `fullbright_texture`, `normal_up_texture` (all `TEXTURE_2D_ARRAY`).
- `GL.BindCube` — `ShadowMap.ts`'s per-slot point-light shadow cubes
  (`pointDepthCubes[]`, `pointDummyCube`), aliased into
  `R.point_shadow_textures[]` the same way `R.shadow_texture` aliases the
  top-down shadow texture.

Several consumer files (`BrushModelRenderer.ts` especially) interleave
`GL.Bind`/`GL.Bind3D`/`GL.BindArray`/`GL.BindCube` calls on adjacent lines of
the same method. Fixing only `Bind` would leave those methods visually split
between wrapped instances and raw static calls, which is worse than the
current consistently-raw state. So all four are in scope, sharing one
bind-cache helper design, each with its own thin per-target class.

So there is no existing successor for any of the four. The right fix is to
give these raw-handle render targets an actual owner: small wrapper classes
that plug into the same bind-cache `GL.Bind`/`Bind3D`/`BindArray`/`BindCube`
currently maintain, then delete all four static methods.

## Full inventory

### 2D (`GL.Bind`, 68 call sites)

| Field | Owner | Storage | Resizes? | Notes |
|---|---|---|---|---|
| `colorTexture` | `PostProcess` | `texImage2D` RGBA/UNSIGNED_BYTE | yes (viewport) | scene color, multiple FBO attachments |
| `emissiveTexture` | `PostProcess` | `texImage2D` RGBA/UNSIGNED_BYTE | yes | |
| `depthTexture` | `PostProcess` | `texImage2D` DEPTH_COMPONENT24/UNSIGNED_INT | yes | also read back via depth-sampling FBO |
| `turbulentBoundaryDepthTexture` | `PostProcess` | `texImage2D` DEPTH_COMPONENT24 | yes | |
| `pingTexture` / `pongTexture` | `PostProcess` | `texImage2D` RGBA | no (fixed at init, never resized in current code) | effect ping-pong |
| `intermediateTexture` | `BlurEffect` | `texImage2D` RGBA | yes | |
| `extractTexture` / `blurTexture` | `BloomEffect` | `texImage2D` RGBA | yes (downsampled) | |
| `metricTexture`, `adaptationTextures[]` | `BloomEffect` | `texImage2D` RGBA, 1×1 | no | filled once via solid-color upload |
| `topdownDepthTexture` | `ShadowMap` | `texStorage2D` DEPTH_COMPONENT24 | no (fixed `TOPDOWN_SHADOW_SIZE`) | has `TEXTURE_COMPARE_MODE/FUNC` set |
| `topdownDummyTexture` | `ShadowMap` | `texStorage2D` DEPTH_COMPONENT24, 1×1 | no | same compare params, "always lit" |
| `dlightmap_rgba_texture` | `R` | `texStorage2D` RGBA8 | no (fixed lightmap block size) | updated per-frame via `texSubImage2D` |
| `lightstyle_texture_a` / `_b` | `R` | `texStorage2D` R8, 64×1 | no | updated per-frame via `texSubImage2D` |
| `null_texture` | `R` | `texStorage2D` RGBA8, 1×1 | no | filled once via `texSubImage2D` |
| `shadow_texture` | `R` | n/a — alias | n/a | holds whichever `ShadowMap` 2D texture is active; not its own lifecycle |

### 3D (`GL.Bind3D`, ~5 call sites)

| Field | Owner | Storage | Notes |
|---|---|---|---|
| `#fogLightProbeWhite` | `BrushModelRenderer` | `texImage3D`, small fixed size | lazily created fallback probe |
| `FogLightProbeData.texture` (map values in `#fogLightProbes`) | `BrushModelRenderer` | `texImage3D`, per-volume resolution | pooled per `FogVolumeInfo`, freed via `_freeFogLightProbes()` |

### 2D array (`GL.BindArray`, ~10 call sites)

| Field | Owner | Storage | Notes |
|---|---|---|---|
| `deluxemap_texture` | `R` | `texStorage3D` RGBA8 | 3 layers (lightstyle banks) |
| `lightmap_texture` | `R` | `texStorage3D` RGBA8 | 3 layers |
| `fullbright_texture` | `R` | `texStorage3D` RGBA8, 1×1×3 | filled once via `texSubImage3D` |
| `normal_up_texture` | `R` | `texStorage3D` RGBA8, 1×1×3 | filled once via `texSubImage3D` |

### Cube map (`GL.BindCube`, ~11 call sites)

| Field | Owner | Storage | Notes |
|---|---|---|---|
| `pointDepthCubes[]` | `ShadowMap` | 6× `texImage2D` DEPTH_COMPONENT24 per face | per-slot, face attached to FBO during shadow-pass rendering (raw `gl.bindTexture`/`gl.framebufferTexture2D`, not through `GL.BindCube` today) |
| `pointDummyCube` | `ShadowMap` | 6× `texImage2D` DEPTH_COMPONENT24, 1×1 | "always lit" fallback |
| `point_shadow_textures[]` | `R` | n/a — alias | holds whichever `ShadowMap` cubes are active this frame, same alias pattern as `shadow_texture` |

Genuinely out of scope: nothing left — every raw-handle texture bound via any
of the four `GL.Bind*` functions is now accounted for above. `ShadowMap.ts`'s
own creation/render-pass code for the cube textures (face uploads, per-face
FBO attachment while rendering the shadow pass) does **not** go through
`GL.BindCube` today and doesn't need a new wrapper method for that — it stays
as raw `gl.*` calls via the new class's `.texture` getter, same as the 2D
render targets' `texImage2D`/`texStorage2D` calls stay raw via
`GLRenderTexture.texture`.

## Proposed design

Four small classes, one per target type, all following the same shape:
own the handle, expose a `.texture` getter for calls the class doesn't wrap,
provide a `.bind()` that plugs into the shared bind-cache, and a `.free()`.
No shared base class — each body is 3 near-identical lines
(constructor/getter/free) and CLAUDE.md's "three similar lines is better
than a premature abstraction" applies directly. What *is* shared is the
actual bind-cache logic, since that's real behavior worth having in exactly
one place.

Format, storage (`texImage2D`/`texStorage2D`/`texImage3D`/`texStorage3D`),
mip/filter/wrap/compare params, and per-face cube uploads all stay as
explicit `gl.*` calls at the call site, aimed at `.texture` instead of a bare
field — unchanged behavior, just a typed owner instead of a loose static
field.

```ts
// in GL.ts, alongside GLTexture

/** Bind-cache-aware 2D texture-unit bind, shared by GLTexture and GLRenderTexture. */
function bindTexture2D(target: number, texnum: WebGLTexture, flushStream: boolean): void {
  if (currentTextureTargets[target] === texnum) {
    return;
  }

  if (flushStream) {
    GL.StreamFlush();
  }

  activateTextureUnit(target);

  currentTextureTargets[target] = texnum;
  gl.bindTexture(gl.TEXTURE_2D, texnum);
}

/**
 * Binds a non-2D texture (3D/array/cube) to a unit. Matches the current
 * Bind3D/BindArray/BindCube behavior exactly: always issues gl.bindTexture
 * (no same-texture skip — these targets aren't rebound often enough for that
 * to have mattered when this was written) and unconditionally invalidates
 * the unit's 2D bind-cache entry, even though the 2D and non-2D binding
 * points of a unit don't actually collide in WebGL. Preserved as-is rather
 * than "fixed" — this migration only changes the API surface, not behavior.
 */
function bindTextureToUnit(target: number, glTarget: number, texnum: WebGLTexture): void {
  activateTextureUnit(target);
  currentTextureTargets[target] = null;
  gl.bindTexture(glTarget, texnum);
}

function activateTextureUnit(target: number): void {
  if (currentTextureTarget !== target) {
    currentTextureTarget = target;
    gl.activeTexture(gl.TEXTURE0 + target);
  }
}

/**
 * A raw 2D render-target texture (post-process buffers, shadow maps, lightmap
 * data textures, ...) that isn't a loaded asset and doesn't belong in
 * GLTexture's identifier cache.
 */
export class GLRenderTexture {
  #texnum: WebGLTexture;

  constructor() {
    this.#texnum = requireValue(gl.createTexture(), 'Failed to create WebGL texture');
  }

  /** Raw handle, for gl.* calls this wrapper doesn't itself cover. */
  get texture(): WebGLTexture {
    return this.#texnum;
  }

  bind(target = 0, flushStream = false): this {
    bindTexture2D(target, this.#texnum, flushStream);
    return this;
  }

  /** Attaches this texture to the currently bound framebuffer. */
  attachToFramebuffer(attachmentPoint: number): void {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachmentPoint, gl.TEXTURE_2D, this.#texnum, 0);
  }

  free(): void {
    gl.deleteTexture(this.#texnum);
  }
}

/** A 3D texture (fog-volume light probes). */
export class GLVolumeTexture {
  #texnum: WebGLTexture;

  constructor() {
    this.#texnum = requireValue(gl.createTexture(), 'Failed to create WebGL texture');
  }

  get texture(): WebGLTexture {
    return this.#texnum;
  }

  bind(target = 0): this {
    bindTextureToUnit(target, gl.TEXTURE_3D, this.#texnum);
    return this;
  }

  free(): void {
    gl.deleteTexture(this.#texnum);
  }
}

/** A 2D array texture (lightmap/deluxemap/fullbright/normal-up banks). */
export class GLTextureArray {
  #texnum: WebGLTexture;

  constructor() {
    this.#texnum = requireValue(gl.createTexture(), 'Failed to create WebGL texture');
  }

  get texture(): WebGLTexture {
    return this.#texnum;
  }

  bind(target = 0): this {
    bindTextureToUnit(target, gl.TEXTURE_2D_ARRAY, this.#texnum);
    return this;
  }

  free(): void {
    gl.deleteTexture(this.#texnum);
  }
}

/** A cube-map texture (point-light shadow cubes). */
export class GLCubeTexture {
  #texnum: WebGLTexture;

  constructor() {
    this.#texnum = requireValue(gl.createTexture(), 'Failed to create WebGL texture');
  }

  get texture(): WebGLTexture {
    return this.#texnum;
  }

  bind(target = 0): this {
    bindTextureToUnit(target, gl.TEXTURE_CUBE_MAP, this.#texnum);
    return this;
  }

  free(): void {
    gl.deleteTexture(this.#texnum);
  }
}
```

`GLTexture.bind()` is refactored to call the shared `bindTexture2D()` helper
instead of duplicating the algorithm, so there's exactly one implementation of
"the thing `GL.Bind` used to do." None of `Bind3D`/`BindArray`/`BindCube` had
a `flushStream` parameter and none of their call sites pass one, so the new
`.bind()` methods on `GLVolumeTexture`/`GLTextureArray`/`GLCubeTexture`
correctly omit it too — not adding an unused parameter.

`GLCubeTexture` intentionally has no `attachToFramebuffer` — cube attachment
is always per-face (`gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment,
gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, cube.texture, 0)`), only happens inside
`ShadowMap`'s own render-pass code, and isn't a generic enough operation to
justify a wrapper method. Same reasoning for `GLVolumeTexture`/
`GLTextureArray`: nothing renders into them via a framebuffer, only CPU-side
`texSubImage3D` uploads, so no attach method is needed.

### Migration shape (per call site)

```ts
// Before
PostProcess.colorTexture = gl.createTexture();
GL.Bind(0, PostProcess.colorTexture);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
// ... later ...
GL.Bind(0, PostProcess.colorTexture);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
// ... later ...
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, PostProcess.colorTexture, 0);
// ... shutdown ...
gl.deleteTexture(PostProcess.colorTexture);

// After
PostProcess.colorTexture = new GLRenderTexture();
PostProcess.colorTexture.bind(0);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
// ... later ...
PostProcess.colorTexture.bind(0);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
// ... later ...
PostProcess.colorTexture.attachToFramebuffer(gl.COLOR_ATTACHMENT0);
// ... shutdown ...
PostProcess.colorTexture.free();
```

```ts
// Before (ShadowMap.ts, cube map creation — stays raw, only the field type changes)
const depthCube = gl.createTexture()!;
gl.bindTexture(gl.TEXTURE_CUBE_MAP, depthCube);
for (let face = 0; face < 6; face++) {
  gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.DEPTH_COMPONENT24, POINT_SHADOW_SIZE, POINT_SHADOW_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
}
// ...
ShadowMap.pointDepthCubes.push(depthCube);

// After
const depthCube = new GLCubeTexture();
gl.bindTexture(gl.TEXTURE_CUBE_MAP, depthCube.texture);
for (let face = 0; face < 6; face++) {
  gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.DEPTH_COMPONENT24, POINT_SHADOW_SIZE, POINT_SHADOW_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
}
// ...
ShadowMap.pointDepthCubes.push(depthCube);
```

```ts
// Before (sampling side, e.g. MeshModelRenderer.ts)
GL.BindCube(program.tPointShadowMap0, R.point_shadow_textures[0]);

// After
R.point_shadow_textures[0].bind(program.tPointShadowMap0);
```

Field type changes, all following the same nullability pattern already in
use (`static x: T | null = null;`):

- `PostProcess`/`BloomEffect`/`BlurEffect`/`ShadowMap`'s 2D fields and
  `R`'s 2D fields → `GLRenderTexture | null`.
- `R.shadow_texture` → `GLRenderTexture | null` (still just an alias).
- `BrushModelRenderer`'s `#fogLightProbeWhite` and `FogLightProbeData.texture`
  → `GLVolumeTexture` (`| null` for the former).
- `R.deluxemap_texture`/`lightmap_texture`/`fullbright_texture`/
  `normal_up_texture` → `GLTextureArray | null`.
- `ShadowMap.pointDepthCubes[]`/`pointDummyCube` → `GLCubeTexture[]` /
  `GLCubeTexture | null`.
- `R.point_shadow_textures[]` → `GLCubeTexture[]` (still just an alias array).

## Migration order (checkpointed phases)

Lowest blast-radius first; each phase independently lints/type-checks/tests
clean and gets a manual visual check before moving on, per this repo's
practice for rendering changes.

1. **Add all four classes + the three shared helper functions to `GL.ts`**,
   refactor `GLTexture.bind()` to use `bindTexture2D()`. No call-site changes
   yet. Verify: `tsc --noEmit`, `eslint`, full test suite (should be a no-op
   behaviorally).
2. **`ShadowMap.ts`** — 2D fields (`topdownDepthTexture`, `topdownDummyTexture`)
   and cube fields (`pointDepthCubes[]`, `pointDummyCube`), self-contained
   subsystem. Verify in-browser: `r_shadows 1` for top-down shadows,
   `r_shadow_point 1` for point-light cube shadows, toggle both off to
   confirm the dummy ("always lit") paths still work.
3. **`R.ts`** — 2D fields (`dlightmap_rgba_texture`, `lightstyle_texture_a/b`,
   `null_texture`, `shadow_texture` alias), array fields (`deluxemap_texture`,
   `lightmap_texture`, `fullbright_texture`, `normal_up_texture`), and the
   `point_shadow_textures[]` alias. Verify in-browser: dynamic lights (rocket
   explosion, muzzle flash), lightstyle-driven flickering lights, static
   lightmaps/deluxemaps on brush geometry, point-light shadows on models.
4. **`BrushModelRenderer.ts` fog light probes** — `#fogLightProbeWhite`,
   `FogLightProbeData.texture`. Verify in-browser: enter a fog volume with
   dynamic lights nearby, confirm probe-based lighting inside the fog still
   looks right, leave/re-enter to exercise probe pooling and
   `_freeFogLightProbes()`.
5. **`BlurEffect.ts`, `BloomEffect.ts`** — self-contained post-process effects.
   Verify in-browser: enable bloom/blur post-process settings, confirm visual
   output unchanged, resize the window to exercise `resize()`.
6. **`PostProcess.ts`** — the biggest single file (6 fields, ping-pong FBOs,
   MSAA interaction, depth-sampling FBO). Verify in-browser: full scene
   render with post-processing on, window resize, and the depth-sampling
   feedback-loop guard already documented in memory (`GL.Bind(tDepth, null_texture)`
   before `PostProcess.endDepthSampling()`) — re-verify that guard still reads
   correctly once `PostProcess.depthTexture`/`R.null_texture` are
   `GLRenderTexture` instances instead of raw handles.
7. **Remaining consumer files** — `BrushModelRenderer.ts` (remaining 2D/array/
   cube call sites not covered by phase 4), `AliasModelRenderer.ts`,
   `MeshModelRenderer.ts`, `Sky.ts`, `ColorGradeEffect.ts`,
   `UnderwaterFogEffect.ts`, `WarpEffect.ts` — swap every remaining
   `GL.Bind*(unit, X)` call to `X.bind(unit)` now that every `X` they
   reference is one of the four new classes. Mechanical once 2–6 land.
8. **Delete `GL.Bind`, `GL.Bind3D`, `GL.BindArray`, `GL.BindCube`** once
   `grep -rn "GL\.\(Bind\|Bind3D\|BindArray\|BindCube\)("` returns zero
   results. Update `plans/deprecated-todo-triage.md` Tier 4 to mark this item
   done.

## Verification per phase

- `npx tsc --noEmit`
- `npx eslint --fix` on touched files
- `npm run test:renderer` (and full `npm test` before the final phase)
- Manual browser check per the specifics called out in each phase above —
  this is rendering code with no automated visual regression coverage, so
  each phase needs eyes on the actual output, not just green tests.

## Possible future optimization (explicitly not part of this migration)

`bindTextureToUnit` preserves the current unconditional-rebind behavior for
3D/array/cube targets. Since these targets don't actually share a binding
point with `TEXTURE_2D` on the same unit, a real cache (separate
"last-bound-3D-texture-per-unit" / "...-array-..." / "...-cube-..." arrays,
mirroring `currentTextureTargets`) could skip redundant `gl.bindTexture`
calls the same way `GL.Bind` already does for 2D. Not done here to keep this
a pure API-surface refactor with zero behavior change; worth a follow-up if
profiling ever shows these binds as hot.

## Open questions before starting implementation

1. None outstanding — design and phase order above are ready to execute.
   Flagging here only that phase boundaries (2–7) are natural commit points;
   confirm whether you want one commit per phase or one commit for the whole
   migration.

# Implement the LMSHIFT / LMOFFSET / LMSTYLE / LMSTYLE16 / DECOUPLED_LM BSPX lumps

**Status:** Not started (checked 2026-09-21). `BSPXLoader.ts` still reads only `LIGHTINGDIR`,
`LIGHTGRID_OCTREE` and `FACENORMALS`, `docs/bspx.md` does not list the five lumps, and no
`rawTextureMins` or `decoupledLightmapVecs` exist yet. The premises hold: `Face.lmshift` is still
set only from the worldspawn `_lightmap_scale` key, in all three loaders. Line references are as of
writing (2026-07-12) and were not re-verified one by one.

## Context

`resources/bspx.txt` documents several BSPX lumps that provide per-surface lightmap
metadata: `LMSHIFT`, `LMOFFSET`, `LMSTYLE`, `LMSTYLE16`, and `DECOUPLED_LM`. Unlike
`VERTEXNORMALS` (which `ericw-tools` never emits), these are actively written by the
`light` and `qbsp` tools in `ericw-tools/` — confirmed by grepping `light/light.cc`,
`light/write.cc`, and `qbsp/writebsp.cc`. Any map compiled with a per-surface `_lmscale`
override, or with `light -world_units_per_luxel` (increasingly common for
high-quality-lit modern maps), currently either mis-renders or fails to render its
lightmaps correctly in QuakeShack, because none of these lumps are read today.

The engine already has partial plumbing that anticipates this: `Face.lmshift`
([BaseModel.ts:85](source/engine/common/model/BaseModel.ts#L85)) exists and is consumed
throughout the lightmap pipeline (`R.AllocBlock`, `R.BuildLightMap`, `R.BuildLightMapEx`,
`BrushModelRenderer._buildSurfaceDisplayList`), but it is only ever set uniformly from the
worldspawn `_lightmap_scale` key in `BSP29Loader._loadFaces` /
`BSP2Loader._loadFaces` / `BSP38Loader` — never from a per-face BSPX lump. This plan closes
that gap and adds `DECOUPLED_LM` support, following the existing architecture in
`BSPXLoader.ts` (which already loads the other format-agnostic lumps: `LIGHTGRID_OCTREE`,
`LIGHTINGDIR`, `FACENORMALS`) and its per-face post-load-override pattern (see
`#loadFaceNormals`).

All new lumps are format-agnostic (same layout regardless of BSP29/BSP2/BSP38), so they
belong in `BSPXLoader.ts`, consistent with the existing doc comment there and how
`FACENORMALS` is handled. `BSPXLoader.load()` already runs after each loader's
`_loadFaces()` (BSP29Loader.ts:115 area / BSP38Loader.ts:148), so `loadmodel.faces` is
always populated by the time these new lumps parse — same precondition `#loadFaceNormals`
already relies on. Per-face lump indices line up 1:1 with `loadmodel.faces` for both world
and submodel faces, since submodels reference a shared range of the same flat `faces`
array (confirmed in `BSP29Loader._loadSubmodels`, `out.faces[out.firstface + j]`).

## Priority and phasing

Recommended order (can stop after any phase and still ship a correct, useful increment):

1. **Phase A — `LMSHIFT` + `LMOFFSET`** (fixes an active correctness bug on any map using
   a non-uniform lightmap scale). Moderate complexity.
2. **Phase B — `DECOUPLED_LM`** (bigger win for compatibility with modern high-quality-lit
   maps; touches the renderer, not just the loader). Moderate-to-larger complexity.
3. **Phase C — `LMSTYLE` / `LMSTYLE16`** (lowest value; the renderer's lightmap atlas and
   shader are hardcoded to 4 concurrent lightstyles per face — `MAXLIGHTMAPS`-equivalent —
   so this phase can only apply the *first 4* styles from the lump. Supporting more than 4
   concurrent styles per face would require reworking the lightmap atlas format and shader,
   which is out of scope here and not worth it given `ericw-tools` only emits more than 4
   with a non-default `-facestyles` flag).

## Shared groundwork

- Add two new `Face` fields in `source/engine/common/model/BaseModel.ts` to preserve the
  *raw* (unsnapped) texture-space bounds computed during `_loadFaces`, so `BSPXLoader` can
  re-snap them against a different per-face `lmshift` without re-walking the face's
  vertices/texinfo a second time:
  ```typescript
  /** Raw (pre-lmshift-snap) texture-space min bounds, used to re-derive texturemins/extents when a per-face LMSHIFT override applies. */
  rawTextureMins: [number, number] = [0, 0];
  /** Raw (pre-lmshift-snap) texture-space max bounds, used to re-derive texturemins/extents when a per-face LMSHIFT override applies. */
  rawTextureMaxs: [number, number] = [0, 0];
  ```
- In `BSP29Loader._loadFaces` ([BSP29Loader.ts:1354](source/engine/common/model/loaders/BSP29Loader.ts#L1354)),
  `BSP2Loader._loadFaces` ([BSP2Loader.ts:105](source/engine/common/model/loaders/BSP2Loader.ts#L105)),
  and the equivalent block in `BSP38Loader.ts` (~line 485), assign
  `face.rawTextureMins = [mins[0], mins[1]]; face.rawTextureMaxs = [maxs[0], maxs[1]];`
  right before the existing `texturemins`/`extents` computation. This is a 2-line addition
  per loader, no behavior change.

## Phase A — `LMSHIFT` + `LMOFFSET`

New private method `BSPXLoader.#loadLightmapShiftAndOffset(loadmodel, buf)`, called from
`load()` alongside the existing `#loadLightgridOctree` / `#loadDeluxeMap` /
`#loadFaceNormals` calls.

- **`LMSHIFT`**: 1 byte per face (matches `loadmodel.faces.length`), value is the shift
  exponent directly (confirmed via `ericw-tools/include/common/bitflags.hh` `nth_bit()` —
  `bspinfo.cc` does `nth_bit(byte)` to get the *ratio*, meaning the stored byte itself is
  already the exponent `n`, exactly matching `Face.lmshift`'s existing semantics — no bit
  tricks needed on read).
- For every face where the lump provides a shift different from the face's current
  `lmshift`, recompute using the new shift and the face's `rawTextureMins`/`rawTextureMaxs`:
  ```typescript
  const lmscale = 1 << newShift;
  face.lmshift = newShift;
  face.texturemins = [Math.floor(face.rawTextureMins[0] / lmscale) * lmscale, Math.floor(face.rawTextureMins[1] / lmscale) * lmscale];
  face.extents = [Math.ceil(face.rawTextureMaxs[0] / lmscale) * lmscale - face.texturemins[0], Math.ceil(face.rawTextureMaxs[1] / lmscale) * lmscale - face.texturemins[1]];
  ```
  This exactly mirrors the loaders' existing snap formula, just re-parameterized.
- **`LMOFFSET`**: 1 `int32` per face, directly replaces `face.lightofs`. Simple 1:1
  overwrite, no recomputation needed elsewhere — `R.BuildLightMap` / `BuildLightMapEx`
  already just read `surf.lightofs` generically.
- Bounds-check both lumps against `filelen === loadmodel.faces.length * (1 | 4)` up front;
  bail with `Con.DPrint` (matching the existing truncation-handling style in
  `#loadFaceNormals`/`#loadLightgridOctree`) if the size doesn't match — don't attempt
  partial application.

## Phase B — `DECOUPLED_LM`

Struct (confirmed via `ericw-tools/include/common/bspxfile.hh` `bspx_decoupled_lm_perface`
and `bspfile_common.hh` `texvecf = qmat<float,2,4>`), 40 bytes per face, one entry per
`loadmodel.faces` index:

```
uint16_t lmwidth, lmheight;   // pixels
int32_t  offset;              // replaces lightofs; sample-indexed the same way lightofs already is
float    world_to_lm_space[2][4]; // row 0 -> s, row 1 -> t; lmcoord = dot(worldpos, row.xyz) + row.w
```

- New `Face` field in `BaseModel.ts`:
  ```typescript
  /** World-space-to-lightmap-space projection rows from the BSPX DECOUPLED_LM lump (row 0 = s, row 1 = t). Null unless the lump is present for this face. */
  decoupledLightmapVecs: [readonly [number, number, number, number], readonly [number, number, number, number]] | null = null;
  ```
- New `BSPXLoader.#loadDecoupledLightmap(loadmodel, buf)`, parsed the same way as
  `#loadFaceNormals` (iterate `loadmodel.faces`, bounds-check per entry, commit only after
  a full successful parse). For each face with lump data:
  ```typescript
  face.lmshift = 0;
  face.lightofs = offset;
  face.texturemins = [0, 0];
  face.extents = [lmwidth - 1, lmheight - 1];
  face.decoupledLightmapVecs = [row0, row1];
  ```
  Setting `lmshift = 0` and `extents = [lmwidth - 1, lmheight - 1]` means `R.AllocBlock`,
  `R.BuildLightMap`, and `R.BuildLightMapEx` need **no changes** — `smax = (extents[0] >> 0) + 1 === lmwidth` etc. already falls out correctly from the existing formulas.
- **Renderer change** — `BrushModelRenderer._buildSurfaceDisplayList`
  ([BrushModelRenderer.ts:1922-1929](source/engine/client/renderer/BrushModelRenderer.ts#L1922-L1929)):
  texture UV (`vert[3]`/`vert[4]`) keeps using `texinfo.vecs` unchanged. Lightmap UV
  (`vert[5]`/`vert[6]`) branches when `face.decoupledLightmapVecs` is set:
  ```typescript
  if (face.decoupledLightmapVecs) {
    const [row0, row1] = face.decoupledLightmapVecs;
    const lmS = vec.dot(new Vector(row0[0], row0[1], row0[2])) + row0[3];
    const lmT = vec.dot(new Vector(row1[0], row1[1], row1[2])) + row1[3];
    vert[5] = (lmS + face.light_s + 0.5) / LIGHTMAP_BLOCK_SIZE;
    vert[6] = (lmT + face.light_t + 0.5) / LIGHTMAP_BLOCK_SIZE;
  } else {
    // existing lmshift-based formula
  }
  ```
  (Reusing the existing `(s - texturemins + (light_s << lmshift) + (1 << (lmshift - 1))) / ...`
  formula with `lmshift = 0` is not safe: `1 << (lmshift - 1)` becomes `1 << -1`, which JS
  evaluates as `1 << 31` — a latent bug for any real `lmshift = 0` face today, not just
  decoupled ones. The branch above sidesteps it with an explicit `+ 0.5` half-luxel bias,
  which is the correct conceptual equivalent.)
- **Verification caveat to flag to the user**: the exact sample-indexing convention of
  `offset` (whether it's directly comparable to the classic `lightofs`, including the `* 3`
  multiplier `BuildLightMapEx` applies for RGB data) is inferred from `ericw-tools` source
  reading, not confirmed against a real compiled `.bsp`. Recommend testing against an
  actual map compiled with `light -world_units_per_luxel` before trusting this in
  production.

## Phase C — `LMSTYLE` / `LMSTYLE16` (optional, lower priority)

New `BSPXLoader.#loadLightmapStyles(loadmodel, buf, name)`:

- Stride (`stylesperface`) is inferred from lump size: `filelen / (loadmodel.faces.length * bytesPerEntry)`, where `bytesPerEntry` is 1 for `LMSTYLE`, 2 for `LMSTYLE16`. Sentinel value is `255` / `65535` respectively.
- For each face, read up to `stylesperface` entries, stop at the first sentinel (compiler
  always writes contiguously — confirmed via `light.cc`'s `break` on first
  `INVALID_LIGHTSTYLE`), and cap at 4 (`MAXLIGHTMAPS`-equivalent — the renderer's lightmap
  atlas and shader hardcode this everywhere: `R.BuildLightMap`'s `for (; maps < 4; maps++)`
  fill loop, and every `styles[0..3]` block in `BrushModelRenderer.ts`). If the lump has
  more than 4 real styles for a face, `Con.DPrint` a one-time warning and drop the rest.
- Prefer `LMSTYLE16` over `LMSTYLE` if both are present (mirrors `DECOUPLED_LM`-over-`LMOFFSET` precedence — `LMSTYLE16` is strictly newer/more capable).
- Overwrites `face.styles` wholesale (fresh array, not in-place mutation — avoids the
  existing sparse-array footgun in `_loadFaces`'s `if (styles[j] !== 255) face.styles[j] = styles[j]` pattern, which can leave holes if compilers ever produce non-contiguous style bytes).

## Testing

Follow the existing pattern in `test/common/bspx-loader.test.mjs` exactly
(`buildBspxBuffer` helper, `withSilentCon`, `createFace`). Add one `describe` block per
lump:

- **LMSHIFT/LMOFFSET**: assert `face.lmshift`/`face.lightofs` are overridden, and that
  `texturemins`/`extents` are correctly re-snapped from `rawTextureMins`/`rawTextureMaxs`
  for a face whose lump shift differs from its loader-assigned default. Cover the
  size-mismatch/truncation no-throw case like the existing `FACENORMALS` tests do.
- **DECOUPLED_LM**: assert `lmshift === 0`, `texturemins === [0, 0]`, `extents` derived
  from `lmwidth`/`lmheight`, `lightofs === offset`, and `decoupledLightmapVecs` populated
  correctly. Also add a small `BrushModelRenderer` test (or extend an existing one, if a
  suitable fixture already exists — check `test/renderer/`) verifying the lightmap-UV
  branch picks the dot-product path when `decoupledLightmapVecs` is set.
- **LMSTYLE/LMSTYLE16**: assert style arrays are parsed correctly, sentinel-terminated
  entries stop early, and the >4-styles-per-face truncation warns and caps at 4.

Run `npm run test:common` and `npm run test:renderer` after each phase; run
`npx eslint --fix` on every touched file.

## Non-goals / explicitly deferred

- **`VERTEXNORMALS`**: separately determined not worth implementing (`ericw-tools` never
  emits it; `FACENORMALS`, already implemented, is a superset).
- **`BSP38` (Quake II) relevance**: `BSP38Loader.ts` already calls `BSPXLoader.load()` and
  duplicates the same `lmshift`/`texturemins`/`extents` logic, so it gets these lumps for
  free from the shared `BSPXLoader` code. Whether any actual Quake II map source in this
  project's toolchain emits these lumps is unverified and not a blocker — the loader logic
  is format-agnostic and harmless to apply either way (lumps simply won't be present if
  unused).
- **More than 4 concurrent lightstyles per face**: would require reworking the lightmap
  atlas texture format (`RGBA8` = 4 style slots) and the fragment shader's style-blend
  uniforms. Not attempted here; flagged in Phase C as a hard cap.

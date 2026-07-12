# BSPX Support in QuakeShack

The QuakeShack engine supports a subset of the **BSPX** extension format, an unofficial standard
to embed additional lumps (data chunks) into a `.bsp` file without breaking backward
compatibility. Originally a Quake 1 `BSP29`/`BSP2` concept, modern `ericw-tools` can also attach
a BSPX trailer to compiled **Quake II `BSP38`** files — QuakeShack loads it there too.

These extended lumps and specific features are enabled by modern Map Compilers (such as `ericw-tools`).

BSPX trailer parsing plus the lumps that are genuinely format-agnostic (`LIGHTGRID_OCTREE`,
`LIGHTINGDIR`, and `FACENORMALS`) live in a single shared
[`BSPXLoader`](../source/engine/common/model/BSPXLoader.ts), used by every BSP loader. Lumps that
only make sense for Quake 1's native format (`RGBLIGHTING`, `BRUSHLIST` — see below) stay in
`BSP29Loader`.

## Supported BSPX Lumps

The following lumps are recognized and utilized by the engine when available in the `.bsp` file. Note that some features are fully supported while others have experimental or limited usage due to engine constraints mapping them.

| State | Lump Name | Formats | Purpose | Support Level | Description |
|---|-----------|---------|---------|---------------|-------------|
| ✅ | `RGBLIGHTING` | BSP29, BSP2 | Colored Lightmaps | **Full** | Replaces the standard grayscale Quake lightmaps with 3-byte RGB variants for rich colored static lighting. Not needed for BSP38 — Quake II's native `LIGHTING` lump is already RGB. |
| ✅ | `LIGHTINGDIR` | BSP29, BSP2, BSP38 | Deluxemaps / Directional Lighting | **Full** | Stores light direction vectors (normals) alongside lightmaps, used for **per-pixel Lambertian lighting**. PBR materials (`.qsmat.json`) combine it with their real normal map for full bump-mapped shading; standard (non-material) surfaces also consume it, shaded against a flat normal (so they get the same per-pixel directional response as the baked lightmap, without fabricated bump detail). Enabled per-draw whenever the model actually carries `LIGHTINGDIR` data (`BrushModelRenderer.usesDeluxemap`) — maps without the lump render exactly as before. On BSP38, requires ericw-tools 2.0.0-alpha11+ (`-q2bsp` output silently omitted this lump on earlier alpha releases even with `-bspxlux` passed) and the map's worldspawn must opt in with `"_qs_wal" "1"` (see [QSMAT Format](qsmat-format.md) for details) for BSP38's diffuse/base texture pipeline to be active at all. |
| ✅ | `LIGHTGRID_OCTREE` | BSP29, BSP2, BSP38 | Dynamic Entity Lighting | **Full** | A sparse voxel octree structure containing baked ambient lighting data. This allows cleanly and smoothly lighting dynamically moving objects (like players, monsters, and items) anywhere in the map based on the static lights compiled into the layout. |
| ⚠️ | `BRUSHLIST` | BSP29, BSP2 | Brush-Based Collision | **Used in production, two known caveats** | Contains original brush plane data. When present, QuakeShack uses a Quake 2-based `Pmove` (Player Move) code path for **non-hull-based collision detection**, providing smoother physics compared to the original Quake 1 node/cliphull logic. Every hellwave map compiles with it today and it holds up well in normal gameplay — "experimental" reflects two specific, still-open caveats (see [BRUSHLIST collision notes](#brushlist-collision-notes) below), not general instability. Not applicable to BSP38 — Quake II's native `BRUSHES`/`BRUSHSIDES`/`LEAFBRUSHES` lumps already provide this, more accurately than BSPX BRUSHLIST would. |
| ✅ | `FACENORMALS` | BSP29, BSP2, BSP38 | Per-face, per-vertex normals/tangents/bitangents | **Full** | Written by `-wrnormals`. Loaded into `Face.vertexNormals`/`vertexTangents`/`vertexBitangents` (aligned to each face's per-edge vertex order) and consumed by `BrushModelRenderer` in place of the flat per-face plane normal and the UV-derivative tangent/bitangent computation (`Mesh.CalculateTangentBitangents`) — vertices covered by the lump are left untouched by that recomputation. For maps compiled with `_phong`, this gives smooth per-vertex shading across face boundaries instead of faceted lighting, matching the smoothing the baked lightmap already uses. Falls back to the flat/recomputed path per-face when the lump is absent. |

### `BRUSHLIST` collision notes

Used in production today — every hellwave map compiles with `BRUSHLIST`, and after the latest
round of fixes to the brush/hull traceline reconciliation code it holds up well across normal
gameplay. "Experimental" reflects two specific, still-open caveats, not general instability:

- **Brush and legacy hull traces can still disagree at exact face/edge/corner contact.**
  `ServerCollision._canUseHullPointFallback`/`_shouldPreferHullPointTrace`
  ([ServerCollision.ts:239](../source/engine/server/physics/ServerCollision.ts#L239)) cross-checks
  point traces against the legacy hull path and prefers the hull result when the two disagree; a
  separate heuristic in `Pmove.ts` (`shouldUseHullTangentFallback`, via
  [`BrushHullCompatibility.ts`](../source/engine/common/collision/BrushHullCompatibility.ts))
  reconciles tangent-contact cases the same way, and a debug-only diagnostic module
  ([`BrushHullDiagnostics.ts`](../source/engine/common/collision/BrushHullDiagnostics.ts)) exists
  purely to log when they disagree. All three exist because the two paths aren't guaranteed to
  agree at exact tangency — most of the historical bugs here (NaN origins, false
  `startsolid`/`allsolid` on axial faces, players "choking" when sliding along walls) came from
  exactly this class of edge case, and each one needed a targeted fix rather than resolving the
  class of bug outright.
- **Submodel (`*N` brush entity) contents are compiler-forced to `CONTENTS_SOLID`.** ericw-tools'
  BRUSHLIST writer sets every non-world brush's contents to solid regardless of its real content
  type (except clip brushes), so a liquid-filled submodel (e.g. a water-filled `func_door`) would
  render as impassable rather than swimmable under brush-based collision. This is baked in at
  compile time — not something the engine can correct on load.

## Compiling maps with BSPX support
To take advantage of these features, you should compile your maps using tools capable of producing BSPX lumps, such as [ericw-tools](https://github.com/ericwa/ericw-tools).

For example, generating `LIGHTINGDIR`, `RGBLIGHTING`, and `LIGHTGRID_OCTREE` for a Quake 1 map with `light`:
```bash
light -extra -bspx -bspxlux -lightgrid <mapname>
```

### Quake II (`BSP38`) specifics

- Don't pass `-bspxonly`/`-novanilla` when compiling Quake II output. Those flags tell `light` to
  skip the *vanilla* (native) lighting lump in favor of BSPX RGB data — correct for Quake 1 (whose
  native lump is mono-only), but Quake II's native `LIGHTING` lump is already RGB and there's no
  BSPX lightmap-equivalent lump for it to fall back to, so those flags silently leave the compiled
  BSP38 with **zero lighting data** at all. Use plain `-bspx` (writes lightgrid/lux data as BSPX
  *alongside* the native lump, doesn't suppress it).
- `-bspxlux` needs ericw-tools **2.0.0-alpha11 or newer** to actually produce a `LIGHTINGDIR` lump
  for `-q2bsp` output; earlier alpha builds silently omit it even when the flag is accepted.
- A working Quake II `light` invocation: `light -bspx -bspxlux -lightgrid <mapname>` (see
  `data/bsp38-tests/Makefile` for a Q2-only example, or `data/hellwave/Makefile` for a Makefile
  that compiles to *both* BSP2 and BSP38 and therefore has to make `-bspxonly`/`-novanilla`
  conditional on the target format).

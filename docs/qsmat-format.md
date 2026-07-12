# QSMAT (QuakeShack Material) Format

The `.qsmat.json` file format is used to define PBR (Physically Based Rendering) materials for Quake BSP maps in the QuakeShack engine. It allows replacing or augmenting standard Quake textures with high-resolution diffuse, normal, specular, and luminance maps.

## Referencing Material Files

Material files are referenced via the `_qs_mat` key in the map's **worldspawn** entity. The value is one or more file paths (relative to the game directory), separated by semicolons. The engine loads all listed files in parallel and merges their material definitions.

**Example worldspawn entry (in your `.map` source):**
```
"_qs_mat" "materials/example.qsmat.json"
```

**Multiple files** (useful for shared material libraries):
```
"_qs_mat" "materials/shared.qsmat.json; materials/example.qsmat.json"
```

## Format Structure

The file is a standard JSON object with the following top-level properties:

| Property | Type | Description |
|----------|------|-------------|
| `version` | `number` | The version of the format. Currently, this must be set to `1`. |
| `materials` | `object` | A dictionary where keys are the texture names used in the BSP file, and values are material definitions. |

### Material Definition

Each entry in the `materials` object defines the properties for a specific texture. The key must match the texture name in the BSP file (case-sensitive, typically uppercase).

| Property | Type | Description |
|----------|------|-------------|
| `diffuse` | `string` | Path to the diffuse (albedo) texture. If omitted, the original texture from the BSP/WAD is used. |
| `normal` | `string` | Path to the normal map texture. |
| `specular` | `string` | Path to the specular map texture. |
| `luminance` | `string` | Path to the luminance (emissive) texture, layered on top of the lightmap. |
| `flags` | `string[]` | An array of material flags. |
| `width` | `number` | Optional. Overrides the texel-space tiling scale (see [Width and Height](#width-and-height) below). |
| `height` | `number` | Optional. Overrides the texel-space tiling scale (see [Width and Height](#width-and-height) below). |

### Material Flags

The `flags` array can contain the following strings:

| Flag | Description |
|------|-------------|
| `MF_TRANSPARENT` | Use alpha blending for this material. Useful for glass, grating, etc. Note that textures starting with `{` are automatically marked as transparent by the engine. |
| `MF_SKY` | Marks the surface as a sky surface. |
| `MF_TURBULENT` | Applies turbulent deformation (like water/slime/lava). Textures starting with `*` or `!` are automatically marked as turbulent. |
| `MF_FULLBRIGHT` | Renders the surface unlit, ignoring lightmaps. Useful for emissive/glowing surfaces. Unlike `luminance`, this applies the diffuse texture itself as the emissive layer rather than a separate map. |

### Width and Height

`width`/`height` control the **texel-space tiling scale** the engine uses when mapping a surface's UVs onto your `diffuse` image — not the pixel dimensions of the image file itself. This is the same scale the original map texture was compiled against; if your replacement texture doesn't tile at that same scale, it will tile more or fewer times across the surface than the mapper intended (a common symptom: a swapped-in texture looking "zoomed in" or "zoomed out" compared to the original).

You don't need to set these for a typical Quake 1/Quake 2 (BSP29/BSP2/BSP38) map when your `diffuse` replacement is the same pixel size as the original texture — the engine derives the scale from the original automatically. Set them explicitly when:

- Your `diffuse` replacement is a **different resolution** than the original texture (e.g. a 4x upscaled or hand-painted replacement at a different size). Set `width`/`height` to the **original** texture's dimensions, not the replacement's.
- You're overriding a **BSP38 (Quake II)** map's texture and either haven't opted into `.wal`
  loading (see `_qs_wal` below) or the texture has no `.wal` file to fall back to. Without a
  resolved `.wal` texture, the engine falls back to using your `diffuse` image's own pixel size,
  which only tiles correctly if it happens to match the original — for anything else, set these
  explicitly.

### `.wal` texture loading (BSP38 / Quake II only)

BSP38 maps can load native `.wal` textures (`textures/<name>.wal`) for surfaces that don't have a
qsmat override, but this is **opt-in** — set `"_qs_wal" "1"` on the map's worldspawn entity to
enable it. It defaults to off because a map fully covered by qsmat has no use for `.wal` data, and
loading it anyway would mean a file request per distinct texture in the map, almost all doomed to
fail.

```json
"DOOR03": {
  "diffuse": "textures/doors/door03_d.png",
  "width": 64,
  "height": 128
}
```

## Example

```json
{
  "version": 1,
  "materials": {
    "BRICK1": {
      "diffuse": "textures/walls/brick1_d.png",
      "normal": "textures/walls/brick1_n.png",
      "specular": "textures/walls/brick1_s.png"
    },
    "LIGHT01": {
      "diffuse": "textures/lights/light01_d.png",
      "luminance": "textures/lights/light01_l.png"
    },
    "GLASS": {
      "diffuse": "textures/windows/glass_d.png",
      "flags": ["MF_TRANSPARENT"]
    }
  }
}
```

## Notes

1. Texture paths are relative to the game directory (e.g., `id1/`).
2. The engine uses `GLTexture.FromImageFile` to load these textures, so standard image formats supported by the browser (PNG, JPG, etc.) are acceptable. Make sure the dimensions are each a power of two, e.g. 512x512.
3. If a `diffuse` map is not provided in the `.qsmat.json`, the engine will use the original diffuse texture data from the BSP file, allowing you to add only normal or specular maps to existing textures.

## In-game example

See [video showing support of PBR materials](./img/pbr-support.mp4).

![PBR materials](./img/pbr-support.jpg)



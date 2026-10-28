# Refraction

Translucent liquids and glass can refract what is behind them: instead of blending over the scene, the surface shows
a copy of it, shifted. Liquids shift it along the slope of the waves that warp their texture, glass along its normal
map. Both work in the world and in brush entities (`func_door`, `func_wall`, ...).

## Liquids

Refraction is opt-in per map. Set `_qs_waterrefraction` on `worldspawn` to a strength:

```
{
"classname" "worldspawn"
"_wateralpha" "0.5"
"_qs_waterrefraction" "1"
}
```

- `1` is the default strength, `0.5` half of it, `2` twice as much. `0`, a negative value, anything that is not a
  number or no key at all turns it off.
- Only a liquid drawn translucent refracts: the map has to make it so with `_wateralpha`, `_slimealpha`, `_lavaalpha`
  or `_telealpha`, the material with its `alpha` (see below), or a brush entity with `alpha` below 1. An opaque liquid
  shows nothing behind it and is drawn as it always was.
- A material can ask for refraction without the map: with the flag `MF_REFRACT` (strength 1) or its own `refraction`
  strength, which also wins over the map's. `"refraction": 0` keeps one liquid from refracting on a map that asks for
  it. The worldspawn alpha keys still win over a liquid's material `alpha`.

```json
"*slime0": {
  "flags": ["MF_TURBULENT"],
  "alpha": 0.7,
  "refraction": 0.6
}
```
- It works seen from above and from inside the liquid. Together with `_qs_waterfog` (see
  [Volumetric Fog](volumetric-fog.md)) the depth absorption follows the shifted bottom.

## Glass

A material refracts when its `.qsmat.json` entry has the flag `MF_REFRACT` (see [QSMAT](qsmat-format.md)):

```json
"WINDOW1": {
  "diffuse": "textures/windows/window1_d.png",
  "normal": "textures/windows/window1_n.png",
  "flags": ["MF_TRANSPARENT", "MF_REFRACT"]
}
```

- The surface has to be translucent: `MF_TRANSPARENT` and an alpha channel in the `diffuse` image (its alpha is how
  much of the glass covers what is behind it), the material's `alpha` below 1, or a brush entity with `alpha` below 1.
- `refraction` sets the strength (default 1), e.g. `"refraction": 0.5` for a gentler bend; it makes the material
  `MF_REFRACT`.
- The normal map bends the view; without one the glass is flat and bends nothing, which is what flat glass does.
- Glass receives no shadows, it lets the light through. Dynamic lights still light it.
- It needs no worldspawn key; `r_refraction` turns it off.

## For players

`r_refraction` (a cheat variable, not saved, default `1`) scales the strength the map asks for (glass has strength 1); `0` turns
refraction off and liquids and glass are blended as without it.

## How it works

- `TransparentPass.Render` decides, with `TransparentPass.PlanSceneCopies`, where in the sorted back-to-front pass the
  scene is copied: once before every run of refracting items, and again within a run where the owner changes
  (`TransparentPass.SharesCopy`): a brush entity, the world's liquids and the world's glass each get a copy that holds
  what was drawn before them. A refracting surface replaces its pixels with the copy, so without that a glass wall in
  front of a pool would erase the pool. It copies the depth (`PostProcess.copySceneDepth`) and the color and emissive
  (`PostProcess.copySceneColor`) drawn so far, so whatever was drawn before shows through, other translucent things
  included. Within one owner nothing is copied again: the faces of the world's liquids do not see each other (water
  seen through water), which keeps a map full of liquid down to a few copies.
- `BrushModelRenderer` decides which items refract (`refractsWorldTurbulentChain`, `refractsWorldBatch`,
  `refractsEntity`) with the same alpha the draw uses, so a surface samples a copy only when one was made for it. The
  strengths are set for the pass by `prepareRefraction` and back to 0 after it. Refracting world glass is its own
  item kind (`RefractiveWorldSurface`), drawn by the `brush-refract` program.
- The world's liquids and translucent surfaces are packed once per face, in batches shared by the leafs that list
  them, and handed out once per frame, so a face on a leaf boundary is not blended over itself.
- Within a brush entity, glass is drawn after its other translucent surfaces and does not see them through itself:
  the scene was copied before the entity.
- The `turbulent` and `brush-refract` shaders sample the copies through `include/refraction.glsl`. A shifted sample that lands on something
  in front of the surface falls back to the unshifted one, so near geometry does not bleed into the liquid. The
  emissive buffer is refracted too, so bloom of what is behind the surface is kept.
- Refraction needs the scene capture, which every frame with liquids has. Without it nothing refracts.

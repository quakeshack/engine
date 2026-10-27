# Refraction

Translucent liquids can refract what is behind them: instead of blending over the scene, the surface shows a copy of
it, shifted along the slope of the waves that warp the liquid's texture. Water, slime, lava and teleporters all take
part, in the world and in brush entities (`func_door`, `func_wall`, ...).

## For mappers

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
  or `_telealpha` (or a brush entity with `alpha` below 1). An opaque liquid shows nothing behind it and is drawn as it
  always was.
- It works seen from above and from inside the liquid. Together with `_qs_waterfog` (see
  [Volumetric Fog](volumetric-fog.md)) the depth absorption follows the shifted bottom.

## For players

`r_refraction` (archived, default `1`) scales the strength the map asks for; `0` turns refraction off and the liquids
are blended as without it.

## How it works

- `TransparentPass.Render` decides, with `TransparentPass.PlanSceneCopies`, where in the sorted back-to-front pass the
  scene is copied: once before every run of refracting items. It copies the depth (`PostProcess.copySceneDepth`) and
  the color and emissive (`PostProcess.copySceneColor`) drawn so far, so whatever was drawn before the run, other
  translucent things included, shows through it. Within a run nothing is copied again: a refracting surface does not
  see another refracting surface of its run behind it (water seen through water).
- `BrushModelRenderer` decides which items refract (`refractsWorldTurbulentChain`, `refractsEntity`) with the same
  alpha the draw uses, so a liquid samples a copy only when one was made for it. The strength is set for the pass by
  `prepareLiquidRefraction` and back to 0 after it.
- The turbulent shader samples the copies through `include/refraction.glsl`. A shifted sample that lands on something
  in front of the surface falls back to the unshifted one, so near geometry does not bleed into the liquid. The
  emissive buffer is refracted too, so bloom of what is behind the surface is kept.
- Refraction needs the scene capture, which every frame with liquids has. Without it nothing refracts.

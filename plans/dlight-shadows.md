# Shadow every dynamic light that matters: culled cube passes and a shared shadow atlas

**Status:** Parked (2026-10-24). The two leak bugs found while investigating are fixed (see "Already fixed");
what is left is not visible in regular gameplay and was put on hold by the developer. Maps with many dlights at
once (E1M8's lava balls, grenade spam) are where it would show. Nothing below is started.

## Context

### How dynamic lights are lit today

- Up to 32 dlights are alive (`Def.limits.dlights`). Every frame `ShadowMap.selectPointLights()` picks the
  **3** with the highest `radius / distance to the camera` (`POINT_SHADOW_COUNT`). Each of them gets a 512² depth
  cube (`ShadowMap.pointDepthCubes`) and is lit per fragment and shadowed in `brush.frag`
  (`samplePointLightContribution`, via `samplePointShadowMap` in `shaders/include/shadow-point.glsl`).
- Every other dlight goes through the original Quake path: `DynamicLights.Push()` walks the BSP
  (`MarkLights`), adds the light to the dynamic lightmap texel by texel (`AddDynamicLights`), and the brush shader
  reads it as `tDlight`. Its only occlusion test is per face: one trace from the light to the projection of the light
  onto the face's plane (`IsDynamicLightSurfaceVisible`). When that trace is clear, the whole face is lit, also
  the parts a wall or pillar hides from the light.
- Entities (`EntityLighting.CalculateLightValues`) add up **all** dlights on the CPU without occlusion, and
  `entity-lighting.glsl` darkens the whole sum by `min()` of the 3 point shadows. An entity therefore leaks light
  from every unshadowed dlight, and one occluding shadowed light darkens the light of all the others.

### Why 3 is not enough

An id1 explosion is two lights: the TE light (radius 350, `ClientServerCommandHandlers.ts`) and the
`EF_DIMLIGHT` of the explosion sprite (radius 200, 16 units up, `ClientLegacy.ts`) for its 0.6 s. Add the player's
muzzle flash (radius about 200 at 20 units, so it scores about 10 and always wins a slot) and a second
explosion, and the far explosion behind a wall is the one that falls back to the baked path and lights through
the wall. E1M7/E1M8 add lava balls (`misc_fireball`, radius about 290 each), and Chthon's lightning allocates a
radius-50 light per beam segment.

### Why the count cannot simply be raised

- **Texture units.** The brush program already binds 14 samplers (`ShaderPrograms.ts`: the two texture frames,
  lightmap, dlight map, two lightstyle maps, luminance, specular, normal, deluxemap, top-down shadow and the 3
  cubes). WebGL 2 guarantees 16 fragment texture units, and there are no cube map arrays.
- **Memory.** A 512² `DEPTH_COMPONENT24` face is about 1 MB, so a cube is about 6 MB. 3 lights are 18 MB, 8 would
  be 48 MB.
- **Draw cost.** `_renderPointLightShadowSlot` draws **every** world leaf into **all 6** faces of every shadowed
  light, with no culling: 18 full world passes per frame for 3 lights, plus the entities within the radius.

### Already fixed (2026-10-24, not part of this plan)

- Shadow acne at grazing angles: casters are drawn without bias, receivers use a normal offset and PCF taps in
  their own plane, measured in shadow map texels (`samplePointShadowMap`). `r_shadow_point_bias` had never
  reached the shaders (its uniform was not listed); `test/renderer/shader-programs.test.ts` now fails for any
  declared uniform a program does not list.
- The ring at the edge of a light: the shadow test was faded out over the outer 15% of the radius, where the light
  is still bright, so light came through walls there. The test now stays active up to the radius.
- One-frame leak on selection changes: `DynamicLights.Push()` ran before `selectPointLights()` and excluded the
  previous frame's selection. It now runs in `R.RenderScene()` after the selection
  (`test/renderer/renderer-init.test.ts`).

## Goals

- Every dlight that noticeably lights what the camera sees is shadowed, up to a budget of N lights (N about 8).
- Shadow casting costs scale with what each light can reach, not with the size of the map.
- Entities are lit and shadowed per light, the same way world surfaces are.
- No visual change from Phase 1 on its own; each later phase is a deliberate, captured change.

## Non-goals (this pass)

- Shadows from static map lights (`light` entities); they stay baked into the lightmaps.
- Soft shadows that depend on light size (PCSS), or variance/moment shadow maps.
- Changing how a dlight falls off (it stays the linear Quake ramp with no N·L), unless "Decisions needed" says
  otherwise.
- The top-down entity shadow (`ShadowMap.renderTopDownShadow`).

## Design

### A. Culling the point shadow pass by BSP traversal

Replace the loop over all `leafTable.count` leaves in `_renderPointLightShadowSlot` with a BSP walk from the root
that, like `DynamicLights.MarkLights`, keeps a node only when the light's sphere reaches it (signed distance to the
node's plane against the radius). Once per light, collect the reached leaves. Then, per cube face, keep only the
leaves on the inside of that face's four side planes (planes through the light origin, 90° frustum). Per the
architecture rule this is plane-based traversal, not an AABB test. The leaf list is cached per light while its
origin and radius are unchanged (a muzzle flash attached to a still player, a lava ball at rest), so that only the
per-face split runs again.

Brush entities and alias models already go through `renderEntitiesShadow` with a radius cutoff; add the same
per-face test using the entity's origin and model radius, so an entity is not drawn into faces it cannot appear in.

### B. One shared shadow atlas instead of three cube textures

- One `DEPTH_COMPONENT24` 2D texture (for example 4096², 64 MB, or 2048²) holds the 6 faces of every shadowed light
  as square tiles. The tile size per light comes from its importance (512, 256, 128), so far or small lights cost
  less. A simple per-frame shelf allocator packs the tiles; each tile has a guard band of 2 texels, so PCF taps
  and bilinear filtering never read a neighboring tile.
- `ShadowMap` keeps, per light slot, the origin, radius, color and the atlas rectangle of each of its 6 faces.
  The shader gets them as uniform arrays (`uPointLightPos[N]`, `uPointLightRadius[N]`, `uPointLightColor[N]`,
  `uPointShadowTile[N*6]` as `vec4(x, y, size, 0)` in atlas texels) and one `sampler2DShadow tPointShadowAtlas`.
  The brush program goes from 3 samplers to 1, which frees 2 units.
- `samplePointShadowMap` keeps its normal offset and its receiver-plane taps. Each tap already computes its own
  direction, so each picks its own cube face (major axis), projects into that face's tile and samples the atlas
  with the hardware comparison. Taps on either side of a cube edge therefore land in two different tiles, which a
  cube texture used to do for us with seamless filtering.
- The lighting loop runs over a fixed `MAX_POINT_SHADOWS` with a per-slot mask (zero radius = inactive), so it is
  branchless as `shader-chunks` asks. An inactive slot still runs its math and its texture reads unless the driver
  skips them, so measure the cost per slot before choosing N.
- The baked dynamic lightmap keeps taking every light that did not get a slot.

### C. Choosing the lights

Replace `radius / distance to camera` with an estimate of how much a light lights the view: whether its sphere
intersects the view frustum, how much of the radius reaches into the camera's PVS, and its brightness. A big
explosion behind a nearby wall then beats a muzzle flash in the player's face that only lights a small patch. Add
hysteresis (a selected light keeps its slot unless a candidate scores clearly higher), so slots and tile sizes do
not swap every frame.

### D. Per-light entity lighting

Pass the slotted lights to the entity programs (they share the atlas and the uniform arrays) and light entities
per light and per fragment, as the brush shader does, instead of the CPU sum times `min()` of the shadows. Only the
unslotted lights stay in `EntityLighting`'s CPU sum, as `uDynamicShadeLight`.

### E. Optional: a PVS gate for the baked path

For the lights that still go through `DynamicLights.Push()`, only mark faces in leaves the light's own leaf can
see. This stops leaks into other rooms (not past a pillar in the same room) at almost no cost. It departs from
stock Quake dlights, which light through anything.

## Phasing

1. **Culling (A).** No visual change. Unit tests for the leaf collection, a capture comparison with
   `scripts/renderer-capture/` to show that nothing changed, and `r_speeds` (or the frame graph) for the saving.
   Also add a debug cvar that shows only the dlight light on brush surfaces (what the investigation did by
   editing `brush.frag`), since every later phase is verified with it.
2. **Atlas (B), N = 3.** Same lights as today, moved into the atlas. Visually unchanged apart from the cube seams
   that PCF may now cross differently; captured before and after.
3. **More lights and better selection (B with N > 3, C).** The visible change: grenade spam and E1M8's lava balls
   stop leaking.
4. **Entities (D).**
5. **PVS gate (E)**, only if the developer wants it after Phase 3.

## Testing

- Unit tests: leaf collection against a small BSP fixture (`createBrushWorldModel` and friends in
  `test/support/fixtures.ts`), the per-face split, the tile allocator (packing, guard bands, running out of
  space), the light score and the hysteresis, and `FrameUniforms` uploading the new arrays.
- `test/renderer/shader-library.test.ts` compiles and links every program (glslang), and
  `test/renderer/shader-programs.test.ts` catches a new uniform missing from a program's list.
- Browser: the dlight-only debug view with lights placed out of sight. The investigation searched the BSP for
  points with no line of sight to the camera; that helper should move into the capture scripts. Real scenes:
  E1M7/E1M8 with lava balls, and several grenades exploding behind a wall. Software GL in headless Chromium says
  nothing about frame time, so the cost of N lights has to be measured on real hardware.

## Decisions needed from you

1. **N and memory:** how many shadowed lights (6, 8, 12) and how large an atlas (2048² is 16 MB, 4096² is 64 MB),
   against the extra fragment cost of N lights per pixel.
2. **Entity lighting (D):** per-light, shadowed entity light changes how monsters look near several lights. Do it,
   or keep the CPU sum?
3. **PVS gate (E):** acceptable to depart from stock Quake dlights for the unslotted ones?
4. **N·L for dlights:** keep the Quake ramp without a surface angle term, or add one for the shadowed lights only
   (inconsistent with the baked ones) or for all of them?

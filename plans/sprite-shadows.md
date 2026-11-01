# Sprite shadows: sprites cast shadows, light passes through their transparent pixels

**Status:** ✅ Phase 1 done (2026-10-25), see "What actually shipped in Phase 1". Phase 2 (sprites receive shadows) is
parked by the maintainer's decision, see Non-goals.

## Context

Sprites cast no shadow today. `ShadowMap.renderEntitiesShadow()` calls `renderShadow()` on the renderer of every
caster, for the top-down pass and for each face of each point-light cube, and `SpriteModelRenderer` keeps the empty
default of `ModelRenderer.renderShadow()`. The shadow programs that exist (`shadow-brush`, `shadow-point`,
`shadow-alias`, `shadow-alias-point`) only write depth and never read a texture, so nothing in the shadow passes knows
about transparent pixels.

What already fits (verified in source):

- **The caster loop.** `ShadowMap._isShadowCasterEntity()` already leaves out entities with `alpha < 1`,
  `EF_FULLBRIGHT`, the light effects and the client's own entities; `_computeCasterFade()` cuts casters off at the pass's
  range. A sprite only needs a `renderShadow()`.
- **The stream buffer.** `SpriteModelRenderer.#emitQuad()` streams a quad for the program that is current. A shadow
  program with the same attributes as `sprite` (`aPosition`, `aTexCoord`, `aBlend`) reuses it unchanged.
- **The texel lookup.** `sprite-texel.glsl` (`sampleSpriteTexel`) reads the array texture, fades between images and
  drops the pixels of an alpha-tested sprite below a quarter alpha; the shadow program includes it.
- **The dither.** The shadow programs discard by `hash2D(gl_FragCoord.xy) > uCasterFade`. Discarding by the texel's
  alpha the same way leaves a fraction of the depth texels covered, and the receivers' PCF turns that into a partial
  shadow: a half transparent pixel casts about half a shadow.

## Goals

- A sprite whose settings file says `"shadow": true` casts a shadow in the top-down pass and from the point lights.
- Light passes through transparent pixels. Partly transparent pixels (an `alpha` sprite) cast a partial shadow.
- The shadow is the sprite as the light sees it: its quad is built for the light, and a sprite with rotations shows the
  view that faces the light.
- Nothing changes for a sprite without the setting, and nothing changes for game code.

## Non-goals (this pass)

- **Sprites receiving shadows** (Phase 2, parked 2026-10-25). `sprite.frag` reads no shadow map; it would need the
  shadow chunks and the light-space coordinates in `sprite.vert`. It only matters for `lit` sprites.
- **A shadow for upright sprites in the straight-down top-down pass** (decision 1). A `parallelUpright` or
  `facingUpright` sprite is edge-on to a light that points straight down (`r_shadow_pitch -90`, the default) and casts
  nothing there; it casts from the point lights and from a slanted `r_shadow_pitch`. No flattened "blob" stand-in.
- **Shadows for `.spr` sprites.** They have no settings file, so they keep casting none (Quake's explosions and flames
  are alpha tested and should not cast).

## Design

### A. The setting

`"shadow": true | false` in `<file>.json`, default `false` for every format (decision 2). `SpriteSidecar.shadow`,
`SpriteModel.castsShadow`, set by `ImageSpriteLoader` like `lit`. Not on by default for `alphaTest` either: an
alpha-tested GIF is just as often a flame as a monster.

### B. Renderer: `SpriteModelRenderer.renderShadow()`

1. Leave when `castsShadow` is off or the asset has no texture.
2. Work out the direction from the light to the sprite: the top-down pass's `ShadowMap.lightDir`, which
   `ShadowRenderContext` gains as `lightDirection`, or `origin - pointLightOrigin` for a point light.
3. Build the viewer basis from that direction, the way the camera's is built from its angles (no roll): `right` is the
   horizontal perpendicular (`(fy, -fx, 0)`, Quake's `right` for that forward), `up = right × forward`. A forward that
   is straight up or down has no horizontal part; `right` is then `(0, -1, 0)`, the camera's right at yaw 0.
4. `#setBasis()` takes that viewer instead of reading the camera itself: `parallel*` use the viewer's `right`/`up`,
   `facingUpright` the direction to the sprite, `oriented` the entity's angles as before. The camera pass passes the
   camera's, so it does not change.
5. A quad that is edge-on to the light (`|(right × up) · forward|` near 0) is skipped, it would rasterize nothing.
6. Pick the image with `#selectImage()`, the view from the light's side (the inverse of the direction).
7. Stream the quad with `shadow-sprite` and flush at once: the next caster switches programs.

### C. Program `shadow-sprite`

- Vertex: `gl_Position = uLightSpaceMatrix * vec4(aPosition, 1.0)`, passing the texture coordinate and the blend on.
  One program for both passes: the point cubes take the rasterized depth of the face's perspective matrix, as
  `shadow-alias` does. No normal bias: the bias of `shadow-alias-point` keeps a caster from shadowing its own surface,
  and a sprite receives no shadow.
- Fragment: `sampleSpriteTexel()` (drops the alpha-tested pixels below a quarter alpha), then
  `coverage = mix(1.0, texel.a, step(0.5, uBlendMode))` (an alpha-tested pixel that survives covers fully), and
  `discard` when `hash2D(gl_FragCoord.xy) > uCasterFade * coverage`.

## Phasing

- **Phase 1:** A, B, C, the tests, `docs/sprites.md` (the setting, what upright sprites do in the straight-down pass,
  that sprites receive none). Exit: tests and typecheck green, a sprite's shadow seen in Chromium from a point light
  and from a slanted top-down pass, with light through its transparent pixels.
- **Phase 2 (parked):** sprites receive shadows.

## Testing

- `SpriteSidecars.parse` reads `shadow`, warns on a non-boolean.
- `ImageSpriteLoader` carries it to `castsShadow`, false without a sidecar.
- `SpriteModelRenderer.renderShadow()`: streams nothing without `castsShadow`; builds the quad facing a point light;
  skips an upright sprite under a straight-down light; casts from an upright sprite under a slanted light; picks the
  view facing the light.
- `shader-library.test.ts` compiles and links the new program (when `glslangValidator` is installed).

## Decisions (2026-10-25, from the maintainer)

1. **Upright sprites under the straight-down light cast nothing** (option A of the assessment), no flattened stand-in.
2. **Opt-in through the settings file**, `"shadow"`, off by default.
3. **Receiving shadows is parked.**

## What actually shipped in Phase 1

- **As designed:** `"shadow"` in the settings file (`SpriteSidecar.shadow`, `SpriteModel.castsShadow`, set by
  `ImageSpriteLoader`), `ShadowRenderContext.lightDirection`, `SpriteModelRenderer.renderShadow()` with the viewer split
  out of `#setBasis()` (`#viewFromCamera()` for the drawn sprite, `#viewFromLight()` for the shadow, `#isEdgeOn()`), and
  the `shadow-sprite` program. The camera pass builds the same quads as before; the existing rotation tests still pass
  through `#viewFromCamera()`.
- **Found in the browser, fixed in the renderer:** `GL.UseProgram()` only enables the attributes the previous program
  did not have, assuming the previous program's are still enabled. `AliasModelRenderer.renderShadow()` disables its
  positions by hand after drawing, so a sprite casting right after an alias model (the player, in the top-down pass)
  drew with `aPosition` disabled and cast nothing. `renderShadow()` enables its own attributes. The alias renderer's
  manual disables are left as they are, see Open questions.
- **Found on the way, documented:** `ShadowMap._isShadowCasterEntity()` leaves out every client-owned entity
  (`num === -1`), so static decorations (`makeStatic`) and client-only entities cast no shadow of any model type.
  `docs/sprites.md` says so; nothing changed.
- **Tests:** the sidecar setting, the loader default and value, and eight renderer tests (no setting, facing a point
  light, the program and blend mode, the attributes, edge-on upright sprites under a straight-down light, upright under
  a slanted light, flat under a straight-down light, the view facing the light). `shader-library.test.ts` compiles and
  links the program with `glslangValidator`.
- **Browser check** (Chromium on software GL, `start`, a 64x64 ring on a post, the left half opaque and the right half at
  43% alpha, `blend: alpha`, `parallelUpright`): with a point light the ring's shadow on the floor has a lit hole, and
  nothing is cast without the setting; with `r_shadow_pitch -45`, `r_shadow_darkness 0` and `r_shadow_yaw` at 0, 180 and
  270 the shadow falls to the right, the left and toward the camera, the opaque half dark and the other half lighter;
  at `-90` the upright sprite casts nothing. **Not checked:** Firefox, Safari, a sprite with rotations in a real game,
  `alphaTest` GIFs (covered by the shared texel lookup only).
- **Docs:** `docs/sprites.md` (the setting and a "Shadows" section), `docs/shader-chunks.md` (the new includer).

## Open questions

- **Client-owned entities cast no shadow.** Static decorations and client-only entities are left out for every model
  type, which also leaves out a static sprite prop. Was that on purpose (cost, or the viewmodel), or should static
  decorations cast?
- **`AliasModelRenderer.renderShadow()` disables its attributes by hand,** which leaves `GL.UseProgram()`'s bookkeeping
  wrong for the next non-VAO program. The sprite works around it; removing the disables would fix it at the source but
  touches every pass after an alias shadow, so it needs its own before/after capture.

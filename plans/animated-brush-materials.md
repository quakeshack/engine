# Animated brush materials: GIF, (A)PNG, WebP and Aseprite on brush surfaces

## Status

⏸ Parked (2026-10-23). Nothing built. Written down after the image sprite work
([animated-image-sprites.md](animated-image-sprites.md)) so that it doesn't get lost; picked up only on the
maintainer's go-ahead. The file and line references below are as of 2026-10-23, on branch
`feature/animated-image-sprites`. Before starting, read the code again rather than trusting this plan.

### Decisions (2026-10-23, from the maintainer)

- **Textures: one `GLTexture` per frame** (D), so the brush shaders and everything that binds them stay as
  they are.
- **Order: after the sprite plan.** The move and rename (A) waits until the image sprite work, its 2D phase
  included, is done or dropped. Until then this plan stays parked.
- **Every layer may animate** (E). A layer that is a still image stays still, so a screen can animate its
  diffuse and luminance while the normal and specular maps of its bezel stay fixed.
- **Clock like sprites** (E): the client advances the animation, and the server picks the sequence through the
  entity's `frame`.
- **Quake II `nexttexinfo` chains: out of scope**, tracked under "Later" so they are not forgotten.

## Context

### The goal

A mapper or modder points a brush texture at an animated image and it plays, with the same timing, sequences
and sidecar settings that image sprites already have:

```json
{
  "version": 1,
  "materials": {
    "lava1": { "diffuse": "textures/lava1.webp", "fps": 8, "interpolate": true }
  }
}
```

### What exists today (verified in source)

- **Brush animation is Quake's model, hard-coded.** `QuakeMaterial`
  ([Materials.ts](../source/engine/client/renderer/models/Materials.ts)) holds up to ten frames (`+0`–`+9`)
  and ten alternate frames (`+a`–`+j`, stored at index 10 and up). `selectFrame(entityFrame, time)` advances at a
  fixed 5 Hz and shows the alternate set when the entity's `frame` is above 0. `BSP29Loader` fills the frames
  from the texture names ([BSP29Loader.ts:307](../source/engine/common/model/loaders/BSP29Loader.ts#L307)).
- **The renderer already blends frames.** `MaterialBinder.#bindQuake` binds `currentTexture` and `nextTexture`
  to `tTextureA`/`tTextureB` (`sampler2D` in `brush.frag`), and the shader mixes them by the interpolation
  factor (`r_interpolation`).
- **Material overrides come from `.qsmat.json`** (`QSMatLoader`, [docs/qsmat-format.md](../docs/qsmat-format.md)):
  a matched texture is replaced with a `PBRMaterial` whose `diffuse`/`luminance`/`specular`/`normal` are single
  `GLTexture`s loaded with `GLTexture.FromImageFile()`. A PBR material has no animation at all, so a `+0` texture
  that gets a qsmat override stops animating.
- **Quake II chains are parsed but unused.** `BSP38Loader` reads `nexttexinfo`
  ([BSP38Loader.ts:361](../source/engine/common/model/loaders/BSP38Loader.ts#L361)) and nothing follows it.
- **Render-only.** Brush textures are loaded only when `context.loadRenderData` is true. The server needs no
  header parsing, no precache flags and no duration query, which makes this simpler than the sprite work.

### What the sprite work leaves behind to reuse

- **Header parsers and decoders** (`source/engine/common/model/sprite/`): `ImageHeader`, the GIF/PNG/WebP/Aseprite
  parsers, `SpriteImageDecoding` (handed to every loader through `ModelLoadContext.spriteImages`) and
  `SpritePixels` (color key, halving to fit, premultiplying). They know nothing about entities.
- **`SpriteAnimator`**: a pure function from a sequence and a time to the current image (or two images and a
  blend factor). It handles per-image durations, `direction` and `repeat`.
- **The sidecar reader** (`SpriteSidecar.ts`): the `SettingsReader` validation and the `fps`, `repeat`,
  `interpolate`, `filter`, `colorKey` and `sequences` keys.
- **`ClientEdict.animationStartTime`**: it restarts when an entity's `model` or `frame` changes, for brush
  entities too.

### What does not carry over as it is

1. **Premultiplied alpha.** `DecodedSpriteImages` promises premultiplied RGBA, which the sprite blending relies
   on. Brush textures use straight alpha: `{` textures are alpha-tested and liquids are blended with straight
   alpha.
2. **Wrapping.** `GLTextureArray.FromRGBALayers()` hard-codes `CLAMP_TO_EDGE`
   ([GL.ts:803](../source/engine/client/GL.ts#L803)). Brush textures tile.
3. **One array texture per asset.** A sprite's frames are layers of one `GLTextureArray`, and `brush.frag`
   samples `sampler2D`.
4. **Sprite-only sidecar keys**: `orientation`, `origin`, `scale`, `phase` and `blend`. On a brush surface the
   material flags decide blending, and the clock is decided by what is drawn (world or entity).
5. **Names.** `SpriteAnimator`, `SpriteSequence` and `SpriteSidecar` would no longer be about sprites only.

## Goals

- A `.qsmat.json` layer (`diffuse` at least) may be an animated GIF, APNG, WebP or Aseprite file and plays on the
  surface.
- Timing, sequences, `direction`, `repeat`, `interpolate`, `filter` and `colorKey` mean the same thing on a
  material as in a sprite sidecar, and are read by the same code.
- The classic `+0`–`+9` / `+a`–`+j` animation keeps working unchanged and becomes one case of the general model
  (sequence 0 at 5 fps, sequence 1 the alternate set).
- A qsmat override of an animated Quake texture no longer silently stops its animation.
- Every qsmat layer (`diffuse`, `luminance`, `specular`, `normal`) may be animated; the animated layers share one
  timing.
- A game picks a brush entity's sequence through its `frame`, as for sprites; the client plays it.

## Non-goals (this pass)

- Layers with timings of their own (a luminance at 4 fps over a diffuse at 10 fps).
- Interpolating layers other than the diffuse. Only the diffuse has a pair of samplers (`tTextureA`/`tTextureB`)
  in `brush.frag`; the other layers step from frame to frame, since the shaders stay as they are (decided).
- Video textures (WebM/MP4), as for sprites.
- Texture atlases across materials.
- Following Quake II `nexttexinfo` chains (decided, see "Later").
- Changes to a game's logic. Games see nothing new; a map or mod opts in through qsmat.

## Design

### A. Shared image animation module

Move what is not about sprites out of `sprite/` into a shared place (`source/engine/common/model/image/` or
similar) under names that do not say "sprite": the header parsers, the decoding hook, `SpritePixels`, the
animator, the sequence type and the shared sidecar settings. `SpriteModel` and the sprite loaders keep importing
them. This is a rename and a move, not a change in behavior, and lands on its own before anything else. It
happens after the sprite plan is finished (decided), so its 2D phase does not build on names that are about to
change.

### B. Sidecar split

`SpriteSidecar` becomes two parts: the animation settings (`fps`, `repeat`, `interpolate`, `filter`, `colorKey`,
`sequences`, `phase`) and the sprite-only settings (`orientation`, `origin`, `scale`, `blend`). `phase` moves to
the shared part because a material picks its clock the same way a sprite does (E). The sprite reader reads both,
the material reader only the first. The validation and the console messages for unknown keys
stay the same; each reader passes the keys it knows.

### C. Decoding options

The decoding path takes two options it hard-codes today: `premultiply` (sprites yes, materials no) and `wrap`
(`clamp` for sprites, `repeat` for materials). The color key and the halving have to work on straight alpha too.

### D. Textures for an animated material

**Decided: each frame of each layer is its own `GLTexture`**, with `REPEAT` and mipmaps like any brush texture.
`brush.frag` and the existing `tTextureA`/`tTextureB` blend stay as they are, and `MaterialBinder` binds the
current frame of every layer (and the next frame of the diffuse) per material chain, as many binds as today.
`sampler2DArray` for brush textures was rejected: it would change every brush program and turn every Quake
texture into a one-layer array.

So the decoding path (C) ends in a list of `GLTexture`s for materials and in a `GLTextureArray` for sprites. The
frames a long animation brings are capped as for sprites (`SpriteImageLimits`), with a frame count limit of its
own since there is no `MAX_ARRAY_TEXTURE_LAYERS` to follow.

### E. Material model

`QuakeMaterial`'s fixed frames and `selectFrame` become sequences played by the shared animator:

- Classic `+0`–`+9` gives sequence 0 at 5 fps and `+a`–`+j` gives sequence 1. `BSP29Loader` builds them; what
  it shows does not change.
- An animated file gives its sequences, named by the file's tags or the qsmat entry's `sequences`.
- **Who picks, who plays (decided, like sprites).** The server picks the sequence: sequence 0 for the world,
  and for a brush entity its `frame`, which the game sets and the protocol already carries. The client plays it;
  nothing about the timing crosses the network. For the classic textures, `frame > 0` with only two sequences
  shows the alternate set, which keeps today's behavior exactly.
- **Which clock** is the material's `phase`, as for sprites: `global` (the client time, Quake's behavior and
  the default, so a looping texture runs in step on every surface) or `spawn` (from the entity's
  `animationStartTime`, so when the game changes a button's `frame`, its texture plays its sequence once from
  the start). `random` makes no sense for a surface and is rejected for materials. A world surface has no entity
  start time, so `spawn` there falls back to `global` with a warning at load.
- **Layers (decided).** Any layer may be animated. The timing comes from the first animated layer in the order
  diffuse, luminance, specular, normal, and every other animated layer follows it frame by frame. A still layer
  stays still. An animated layer whose frame count differs from the timing layer's is reported on the console
  and shows its first frame. Only the diffuse interpolates (Non-goals).
- `PBRMaterial` gets the same animation, so a qsmat override no longer loses it. Whether `QuakeMaterial` and
  `PBRMaterial` share it through a common base or a held `MaterialAnimation` object is decided when this starts
  (composition is the likelier fit).

### F. qsmat entries

`QSMatLoader` sends an animated layer through the shared decoding path and reads the animation settings (B) from
the material entry itself, so a material needs no second file. The `width`/`height` rules stay as they are; for
an animated file the image size is the frame size.

## Phasing

Starts only after the sprite plan is finished (decided).

0. **Re-verify** this plan against the code at that point: what moved since 2026-10-23, and what the sprite
   plan's 2D phase changed in the shared parts.
1. **Move and rename (A, B, C).** No change in behavior; the sprite tests keep passing and gain tests for the
   straight-alpha and repeat options.
2. **Material model (E) with the classic animation on it.** `+0`/`+a` textures play exactly as before.
3. **Animated files in qsmat (D, F)**, every layer, the `global` clock. Browser-verified on a test map.
4. **The `spawn` clock** for brush entities, browser-verified with a button whose `frame` the game changes.

## Documentation

- `docs/qsmat-format.md`: animated layers and the animation keys (Phase 3).
- `docs/sprites.md`: points to the shared settings instead of describing them twice, once B lands (Phase 1).
- `README.md`: one feature bullet for animated brush textures (Phase 3).
- JSDoc on the moved and renamed classes and on the material animation (Phases 1–2).

## Testing

- The shared animator, sidecar and pixel tests move with their code; new tests for straight alpha and repeat
  (Phase 1).
- Material: the classic `+0`–`+9` / `+a`–`+j` frame selection at given times, before and after the change
  (Phase 2). These pin down the old behavior and should be written first.
- qsmat: an animated layer builds the expected sequences; a broken file falls back to a still texture
  (Phase 3).
- A real browser pass on a map with an animated qsmat texture, including interpolation and a `{` texture
  (Phase 3).

## Open questions

- **Names (A):** what the shared module and its classes are called. Settle when Phase 1 starts.
- **Sharing the animation (E):** a common base for `QuakeMaterial` and `PBRMaterial`, or a held
  `MaterialAnimation`. Settle when Phase 2 starts.

## Later (tracked, out of scope)

- **Quake II texture animation.** BSP38 surfaces chain their animation frames through `nexttexinfo`, which
  `BSP38Loader` parses ([BSP38Loader.ts:361](../source/engine/common/model/loaders/BSP38Loader.ts#L361)) and
  nothing follows yet. Once the sequence model of E exists, a chain maps onto one sequence, so it is a small
  change on top of this plan, not a part of it. Mind the semantics (`R_TextureAnimation` in Quake II's
  `ref_gl/gl_rsurf.c`): the world steps at 2 fps (`frame = time * 2`), but a brush entity shows image
  `frame % numframes` directly, with no clock, so the server steps it, unlike Quake's alternate sets.
- **Interpolating the other layers** would need a second sampler per layer in `brush.frag`; only worth it if
  stepping luminance turns out to look bad.

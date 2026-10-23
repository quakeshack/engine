# Image sprites: GIF, (A)PNG, WebP and Aseprite as sprite models

## Status

✅ Phase 0 done (2026-10-23): formats verified against their specs, the code questions answered,
results folded into the design below and summarized under "What actually shipped in Phase 0".

✅ Phase 1 done (2026-10-23, branch `feature/animated-image-sprites`; phases 1 to 7 are committed there, one commit
each): SPR runs on the reshaped `SpriteModel`, see "What actually shipped in Phase 1".

✅ Phase 2 done (2026-10-23): GIF, PNG/APNG and WebP header parsers and `ImageSpriteLoader`, see "What actually
shipped in Phase 2".

✅ Phase 3 done (2026-10-23): client decoding for GIF, APNG, static PNG and WebP, see "What actually shipped in
Phase 3". Chromium checked, Firefox not.

✅ Phase 4 done (2026-10-23): the sidecar with all its settings, the blend modes, `filter`, `interpolate`, the
`sidecar: false` precache hint (protocol 43), see "What actually shipped in Phase 4". Chromium checked, Firefox not.

✅ Phase 5 done (2026-10-23): the game API queries, the README bullet and the complete `docs/sprites.md`, see "What
actually shipped in Phase 5".

✅ Phase 6 done (2026-10-23): native Aseprite files and Half-Life SPR v2, see "What actually shipped in Phase 6".

✅ Phase 7 done (2026-10-23): lit sprites, the one extra the maintainer chose, see "What actually shipped in Phase 7".

✅ Phase 8 done (2026-10-23): sprites on the screen (`LoadSprite`, `SpritePlayback`, `DrawSprite`, regions, tint), see "What
actually shipped in Phase 8". A blend-state bug from Phase 1 that it builds on was fixed ahead of it ("Fixed before
Phase 8"). This was the last phase of the plan.

### Decisions so far (2026-10-22, from the maintainer)

- **Animation model: auto-play sequences.** A file is one sequence at `frame 0` that plays by
  itself; more sequences come from the sidecar or Aseprite tags, and `frame` picks the sequence.
- **Settings: optional sidecar JSON** (`<file>.json`), read by both realms (C).
- **Architecture: unify.** One reshaped `SpriteModel` and renderer; SPR moves onto it (A, Phase 1).
- **Formats:** GIF, PNG/APNG, WebP, plus **native `.aseprite`** and **Half-Life SPR v2**.
  Animated AVIF is out of this pass.

### Decisions from Phase 0 (2026-10-23, derived from the code and specs)

- **Premultiplied alpha for every sprite**, one blend function `ONE, ONE_MINUS_SRC_ALPHA` for
  `alphaTest`, `alpha` and `additive` (F). No per-sprite GL state change.
- **`ClientEdict.model` and `frame` become accessors** that stamp `animationStartTime` (E).
- **Sequence playback uses Aseprite's vocabulary**, `direction` + `repeat`, for every format (A, C).
- **Files repeat as a browser would play them** unless the sidecar says otherwise (C).
- **SPR v2 follows v1** for phase: its header carries the same `synctype` (`global`/`random`).

### Decisions after Phase 0 (2026-10-23, from the maintainer)

- **The game hints when there is no sidecar:** `PrecacheModel(name, { sidecar: false })` skips the
  lookup (C). It replaces the miss cache proposed in Phase 0. The hint has to reach the client,
  which costs one protocol change (C, Non-goals).
- **Sequences can be looked up by name:** `GetSpriteSequenceIndex(modelName, name)` next to
  `GetSpriteSequenceDuration` (E).

### Decisions for Phase 8 (2026-10-23, from the maintainer, taking the recommendations)

- **API shape: one handle per element.** `LoadSprite(name)` returns a new `SpritePlayback` per call over an asset
  that is cached once, drawn with `DrawSprite(x, y, playback, options)`. Rejected: handing out the asset with a
  separate playback factory (two objects per HUD element), and a stateless `DrawSprite` that takes a sequence and a
  start time (every HUD would track time itself).
- **Screen effects are a full-screen `DrawSprite`** from the game's `draw()` or `drawOverlay()`. A `sprite` effect in
  the post-process stack, which would get the pulse timing for free, is a later option.
- **Clock: the handle picks it.** Client time by default, real time on request (menus, pause).
- **Scope: HUD and screen effects.** No menu-space wrapper (`Menu.toScreenPosition` plus `DrawSprite` covers menus),
  no `hud.txt` reader, no animated decals.

### Requests from the maintainer while testing Phase 3 (2026-10-23)

A GIF sprite works in the engine but is drawn at one pixel per world unit, far too big for a torch flame, and its
black background shows as a black rectangle. Both belong in the sidecar (C), Phase 4, and both come first there:

- **`scale`** (already planned) is the first sidecar field to implement.
- **Black to alpha.** `blend: additive` already makes black vanish (it adds nothing), which is the usual fix for
  fire. For an alpha-blended look a key is needed too; the shape is proposed under "Open questions".

### Verified format layouts

Checked 2026-10-23 against the primary sources (downloaded, read, not recalled): GIF89a (W3C
`spec-gif89a.txt`), PNG Third Edition §11.3.6 (W3C, APNG is part of it), WebP container RFC 9649,
VP8 RFC 6386 §9.1, Aseprite `docs/ase-file-specs.md` (main branch), and FTE's reader for HL SPR v2
(`fteqw/engine/client/spritegn.h`, `gl/gl_model.c` `Mod_LoadSpriteModel`). Phase 2 copies these
into each parser's JSDoc. All integers little-endian except PNG (big-endian).

| Format | Detect | Size | Frames and timing | Repeat | Traps |
|---|---|---|---|---|---|
| GIF | `GIF87a`/`GIF89a` at 0 | Logical Screen Descriptor, u16 w/h at 6/8 | one Image Descriptor (`0x2C`) per frame; Graphic Control Extension (`0x21 0xF9`, 4 bytes: packed `disposal = (b >> 2) & 7`, transparent flag bit 0, u16 delay in 1/100 s, transparent index) applies to the next image | NETSCAPE2.0 application extension (`0x21 0xFF`), not in GIF89a; absent = play once | disposal 3 (restore previous) needs a saved copy; interlaced images (4-pass row order); local color tables; frames are sub-rectangles of the screen; skip data sub-blocks by their length bytes |
| PNG/APNG | `89 50 4E 47 0D 0A 1A 0A` | `IHDR` | `acTL` (u32 `num_frames`, u32 `num_plays`) before `IDAT`; one `fcTL` per frame (seq, w, h, x, y, u16 `delay_num`/`delay_den`, den 0 = 100, `dispose_op`, `blend_op`); `fdAT` = seq + data | `num_plays`, 0 = forever | the default image is frame 0 only when an `fcTL` comes before `IDAT`, otherwise a hidden fallback; first frame's `DISPOSE_OP_PREVIOUS` = `BACKGROUND`; canvas cleared to transparent black each play |
| WebP | `RIFF` at 0, `WEBP` at 8 | `VP8X` 24-bit w−1/h−1; simple files: `VP8L` (signature `0x2F`, 14-bit w−1, h−1) or `VP8 ` (key-frame start code `9D 01 2A`, then u16 with 14-bit width, 2-bit scale, same for height) | `VP8X` flags bit `0x02` = animated; `ANIM` (BGRA background, u16 loop count); `ANMF` (24-bit x/2, y/2, w−1, h−1, duration in ms, then bits `B` blend, `D` dispose) | loop count, 0 = forever | odd chunk sizes have a pad byte; frame offsets are stored halved |
| Aseprite | u16 `0xA5E0` at **offset 4** (file size is at 0) | header u16 w/h at 8/10, depth at 12 (32 RGBA, 16 grayscale, 8 indexed) | frame header (u32 bytes, u16 `0xF1FA`, chunk counts, u16 duration in ms); chunks `0x2004` layer, `0x2005` cel, `0x2018` tags, `0x2019` palette, `0x2022` slice | tag `repeat`, 0 = forever (as the editor plays it); tag directions forward, reverse, ping-pong, ping-pong reverse | cel z-index reorders layers per frame; hidden groups hide their children; reference layers (flag 64) are never drawn; layer opacity valid only with header flag 1; tilemap layers (type 2) need the tileset chunk; cels are zlib (`DecompressionStream('deflate')`, not `deflate-raw`) |
| HL SPR v2 | `IDSP`, version 2 | as v1, with one extra s32 `texFormat` after `type` (40-byte header) | as v1 after the palette: s16 count (must be 256), 256 × RGB | `synctype` as v1 | `texFormat`: 0 normal, 1 additive, 2 index-alpha, 3 alpha-test (index 255 transparent). FTE's own comment says it is "not sure what the values mean", and its index-alpha keeps each entry's RGB with alpha = index. Treat both as leads and check against a real Half-Life sprite in Phase 6 |

**Timing clamp.** Durations of 10 ms or less (GIF delay 0 or 1, APNG numerator 0, WebP 0) play as
100 ms, as browsers do, so a file times the same in the engine as in a browser tab. The sidecar's
`fps` overrides it.

**Orientation math** comes from FTE's `R_DrawSpriteModel` (`gl/gl_alias.c`): `VP_PARALLEL_UPRIGHT`
uses world Z as up and the view's right; `FACING_UPRIGHT` uses world Z as up and the
perpendicular of (sprite − view) in the XY plane as right; `VP_PARALLEL_ORIENTED` rotates the view
basis by the entity's roll. FTE computes that roll's `sin` from degrees without converting, so
copy the intent, not the line.

## Context

### The goal, in game code

```ts
static precache(engine: ServerEngineAPI): void {
  engine.PrecacheModel('gfx/torch-flame.gif');
}

spawn(): void {
  this.setModel('gfx/torch-flame.gif'); // loops, nothing else to do
}
```

The engine picks the loader from the file, works out bounds and frame timing on the server, and
decodes, uploads and animates it on the client. The same call must work for `ClientEngineAPI.ModForName`
(client-only effect entities such as id1's `BubbleClientEdictHandler`).

### What exists today (verified in source)

- **Loading.** `Mod.Init()` (`source/engine/common/Mod.ts`) registers the loaders in order;
  `ModelLoaderRegistry.findLoader()` takes the first whose `canLoad()` passes, which by default
  needs both a matching extension and a matching 4-byte magic number. `SpriteSPRLoader` is the
  only sprite loader. It handles version 1 only (Half-Life's version 2 is rejected).
- **Two realms.** The server (Node dedicated, or the browser's server worker) loads with
  `ModelLoadContext.loadRenderData = false` and only needs `mins`/`maxs` (`Edict.setModel()` in
  `source/engine/server/Edict.ts` copies them into the entity). `#loadSpriteFrame` returns `null`
  there, so frame data is never touched.
- **Boundary.** `test/common/engine-boundaries.test.ts` allows only a few client files
  (`client/GL.ts`, `Materials.ts`, `Sky.ts`, ...) in the server worker's import closure. A decoder
  imported from a `common/` loader would break it.
- **Model shape.** `SpriteModel` (`source/engine/common/model/SpriteModel.ts`) holds `frames[]`,
  each either a single image or a group of images with cumulative `interval`s, every image with
  its own `GLTexture`, size and origin. `oriented` is a boolean (`type === 3`); the other four
  Quake orientation types (`VP_PARALLEL_UPRIGHT`, `FACING_UPRIGHT`, `VP_PARALLEL`,
  `VP_PARALLEL_ORIENTED`) are all drawn as `VP_PARALLEL`.
- **Rendering.** `SpriteModelRenderer` draws in the transparent pass only, binds one texture per
  sprite and streams a quad. A group animates on `clientRuntimeState.time + entity.syncbase`, so
  its phase is global (all instances in step) unless the SPR header sets `random`
  (`ClientServerCommandHandlers.ts:532`). There is no "start when the entity appeared".
- **Shader.** `sprite.frag` always discards below alpha 0.25 and multiplies by `uAlpha`; no soft
  edges, no additive blending, no lighting.
- **Texture helpers.** `GLTexture.FromImageFile()` decodes any still image with
  `createImageBitmap`. `GLTextureArray` exists (lightmap banks) and is the natural home for
  sprite frames: one bind per sprite, frame = layer.
- **Network.** `frame` and `modelindex` are bytes (`Protocol.u.frame`, `u.model`), so 256 frame
  indices per model. That is the limit for game-selectable frames, not for images inside one
  auto-playing sequence.

### Browser decoding, the state of play (2026-10)

- **`ImageDecoder` (WebCodecs)** decodes animated GIF, APNG, animated WebP and animated AVIF into
  composited full frames with durations, on the main thread or in a worker. Chromium since 94,
  Firefox desktop since 133. **Safari stable does not ship it** (Technology Preview only, per
  caniuse). So the plan uses it only for the one format we don't decode ourselves (WebP).
- **`createImageBitmap`** works everywhere but yields only the first frame of an animation. The
  same is true of `texImage2D` fed an `<img>`: WebGL has no standard way to receive an animation,
  so frames become texture layers in our code (D).
- **What we can decode ourselves cheaply:** GIF (LZW plus disposal, a few hundred lines) and APNG
  (split into one still PNG per frame, decode each with `createImageBitmap`, composite with
  `dispose_op`/`blend_op`). Animated WebP and AVIF need a VP8/AV1 decoder: not worth it, Safari
  falls back to the first frame with a console warning.

### Format pick, for artists

| Format | Alpha | Colors | Size | Tooling | Everywhere |
|---|---|---|---|---|---|
| GIF | 1-bit | 256 per frame | big | everything | yes (own decoder) |
| APNG | 8-bit | true color | medium (lossless) | Aseprite, ffmpeg, apngasm, browsers | yes (own decoder) |
| animated WebP | 8-bit | true color | small (lossy or lossless) | ffmpeg, img2webp, Aseprite | Chromium, Firefox; Safari first frame |
| animated AVIF | 8-bit | HDR capable | smallest | ffmpeg, avifenc | Chromium, Firefox; Safari first frame |
| Aseprite `.aseprite` | 8-bit | true color | small | the pixel-art standard | yes (own parser, zlib via `DecompressionStream`) |

Recommendation: **APNG is the house format** (true alpha, lossless, decodable everywhere), GIF for
compatibility, WebP/AVIF for big effects where size matters and a Safari still frame is acceptable.
Aseprite is the cool one: its tags become named sequences and its slice pivot becomes the sprite
origin, so an artist's file drops in without an export step.

## Goals

- `setModel('<path>.gif|.png|.apng|.webp|.aseprite')` and Half-Life `.spr` (version 2) work on
  the server (bounds, frame count, durations) and the client (decode, upload, animate) with no
  other game code.
- Animations auto-play from the moment the model is set on the entity, loop or play once.
- Per-sprite settings without code: orientation, origin, scale, blend mode, filtering, repeat, phase,
  named sequences, frame crossfade.
- One `SpriteModel` shape and one renderer path for SPR and image sprites.
- The decoded animation (`SpriteAsset`) is independent of the world model, so the 2D side can use
  it later (G, Phase 8): HUD elements, Half-Life-style HUD sheets, screen effects.
- SPR keeps drawing exactly as today (browser-checked), and gains the four orientation types it
  silently ignores.

## Non-goals (this pass)

- Video (WebM/MP4 with alpha through `<video>` textures). Different lifetime (streaming, audio,
  autoplay policy); a separate plan if wanted.
- Animated AVIF (decided 2026-10-22). `ImageDecoder` would decode it for free; what it costs is the
  ISOBMFF header parse the server needs. Easy to add later as one more header parser.
- Our own WebP decoder for Safari.
- Sprite sheets packed into an atlas across models; each model gets its own array texture.
- Changing id1's existing `.spr` effects to image sprites (game change, raise separately).
- Protocol changes beyond one: per-model precache flags in `serverdata` (C), a version bump.
  Animation fits into today's `frame`/`modelindex` bytes.
- Building the 2D side (G). It is designed so Phase 1 shapes the data for it; the code waits for
  Phase 8 and its own go-ahead.

## Design

### A. Data model: `SpriteAsset` inside one `SpriteModel`

The decoded images, their timing and the array texture form a `SpriteAsset`
(`source/engine/common/model/sprite/SpriteAsset.ts`) that knows nothing about entities, bounds or
the model cache. `SpriteModel` (a `BaseModel`) owns one and adds what only a world sprite needs:
`orientation`, `phase`, `lit`, `mins`/`maxs`. The split costs nothing in Phase 1 and lets the 2D
side reuse the same asset later (G) without going through precache, networking or the per-map
model cache.

`SpriteModel` keeps `frames[]` with Quake's semantics (the entity's `frame` picks an entry, a
group animates by time), but frames reference layers of one texture instead of owning textures:

```ts
export interface SpriteImage {
  readonly layer: number;                 // layer in SpriteModel.texture
  readonly origin: [number, number];      // in world units, after scale
  readonly width: number;
  readonly height: number;
  readonly uvScale: [number, number];     // < 1 when padded into a larger layer (SPR frames)
}

export interface SpriteSequence {
  readonly name: string;                  // '' for SPR groups and untagged images
  readonly images: SpriteImage[];
  readonly endTimes: Float32Array;        // cumulative seconds, like SPR intervals
  readonly direction: SpriteDirection;    // forward | reverse | pingpong | pingpongReverse
  readonly repeat: number;                // plays, 0 = forever; ends on the last image shown
}

export type SpriteFrame = SpriteImage | SpriteSequence;
```

On the asset: `frames`, `blend: SpriteBlend` (`alphaTest` | `alpha` | `additive`),
`interpolate: boolean`, `filter: 'linear' | 'nearest' | null` (null follows `gl_texturemode`),
`regions` (named sub-rectangles, G; empty until then) and `texture: GLTextureArray | null` (null
on the server). On the model: `orientation: SpriteOrientation` (the five Quake types as an enum,
replacing the `oriented` boolean), `phase: SpritePhase` (`global` | `random` | `spawn`) and
`lit: boolean` (Phase 7).

The server needs `frames.length`, every sequence's `endTimes`, `direction` and `repeat` (for the
duration query in E) and `mins`/`maxs`; it never sees a texture. `SpriteSPRLoader` is rewritten onto this shape:
frames padded into the largest frame's size, `uvScale` set per image, `phase` = `random` when the
SPR header says so and `global` otherwise, so SPR timing does not change.

### B. Loaders: header parsing in `common/`, pixels through a hook

`source/engine/common/model/loaders/ImageSpriteLoader.ts`, registered after `SpriteSPRLoader`.
It overrides `canLoad()` because two signatures are not one 4-byte magic at offset 0
(`RIFF....WEBP`; Aseprite's `0xA5E0` at offset 4) and because PNG is both static and animated.

1. **Header pass, both realms** (`source/engine/common/model/sprite/`, GL-free, Node-testable):
   `GifHeader.ts`, `PngHeader.ts` (IHDR, `acTL`, every `fcTL`), `WebpHeader.ts` (`VP8X`, `ANIM`,
   `ANMF`), `AsepriteHeader.ts` (header, frame durations, tags, slice pivot; cel data skipped).
   Each returns
   `{ width, height, frameDurations: number[], tags: SpriteTag[] }` without touching pixel data
   (GIF: walk the blocks and skip the LZW sub-blocks). This builds the whole model except
   textures, and is all the server does.
2. **Sidecar** (C) is read and merged.
3. **Pixel pass, render realm only.** `ModelLoadContext` gains
   `readonly spriteImages: SpriteImageDecoding | null`, filled by `createBrowserClient` and `null`
   on the server, the same "hook" pattern as `Cmd.files`. The loader stays out of `client/`, so
   the boundary test holds.

### C. Optional sidecar `<file>.json`

`gfx/torch-flame.gif` reads `gfx/torch-flame.gif.json` if it exists, in both realms (it can change
repeat and sequences, so the server needs it too). Every field is optional:

```json
{
  "version": 1,
  "orientation": "parallelUpright",
  "origin": [16, 4],
  "scale": 0.5,
  "blend": "additive",
  "filter": "nearest",
  "phase": "random",
  "interpolate": true,
  "fps": 12,
  "repeat": 0,
  "sequences": [
    { "name": "idle", "from": 0, "to": 7, "direction": "pingpong" },
    { "name": "burst", "from": 8, "to": 15, "repeat": 1 }
  ]
}
```

Defaults: `parallel`, origin at the image center, scale 1 (one pixel per unit, as SPR), blend
`alphaTest` for GIF and `alpha` for the rest, phase `spawn`, the file's own frame timing after
the clamp (`fps` overrides it), one `forward` sequence over all images that repeats as the file
says (GIF without a NETSCAPE block, or APNG/WebP with a count: that many plays; otherwise
forever). A top-level `repeat` overrides the file's count. With `sequences`, each becomes one
`frame` index, in order. Aseprite tags fill `sequences` when there is no sidecar.

**A missing sidecar costs a request** (checked in Phase 0). `COM.LoadFile` has no file list: in
the browser every miss is a `fetch` that 404s, and `CachedFetchAssetSource` stores only `ok`
responses, so the miss repeats in each realm (client and server worker) on every load, and
`COM.LoadFile` prints `can't find` each time.

**So the game says when there is none** (maintainer's decision):

```ts
engine.PrecacheModel('gfx/torch-flame.gif', { sidecar: false });
```

- `PrecacheModelOptions` (`ServerEngineAPI.ts`) gains `sidecar?: boolean`, default `true`.
  `ModelLoadOptions` gains `readonly sidecar: boolean` (default `true` in
  `DEFAULT_MODEL_LOAD_OPTIONS`), and `ImageSpriteLoader` reads the sidecar only when it is set.
  Leaving the option out keeps "drop in a sidecar and it works"; the hint is an optimization.
- **The client needs the hint too.** It loads every world model from the name list in
  `serverdata` (`ServerMessages.ts`, read in `ClientServerCommandHandlers.ts`), and
  `ClientEngineAPI.ModForName` only looks up precached models, so a server-only option would
  leave the client still checking. `serverdata` therefore writes one flags byte after each model
  name: a `ModelPrecacheFlags` bit enum in `source/shared/` (`noSidecar = 1`, room for more hints).
  `meshCollision` stays server-only and is not sent. That is a protocol bump, 42 → 43; the
  Half-Life studio model plan also plans a bump, and whichever lands first takes 43.
- **Precaching the same model twice:** like `meshCollision`, a later precache that wants the
  sidecar after an earlier one said `false` reloads the model with it; the other way round
  changes nothing.
- The check is quiet: a missing sidecar is expected, so it goes through a `LoadFile` variant that
  doesn't print `can't find`.

### D. Client decoding: `SpriteImageDecoding` strategies

**The engine turns every animation into textures itself.** No web standard hands WebGL the frames
of an animated image: `texImage2D` with an `<img>`, `ImageBitmap` or canvas uploads the first
frame only, and an `<img>` playing a GIF can't be sampled at a given time. The only thing that is
standard and available everywhere is decoding a *still* image (`createImageBitmap` on PNG, JPEG,
WebP bytes, as `GLTexture.FromImageFile` already does). So every path ends the same way: the
engine composites frame *n* into RGBA and uploads it with `texSubImage3D` into layer *n* of the
model's `GLTextureArray`. What differs is only who turns bytes into pixels for one frame.

Our own decoders come first, so GIF, APNG and Aseprite look and time the same in every browser
and are testable in Node; `ImageDecoder` is used only where we have no decoder of our own (WebP).

`source/engine/client/renderer/sprite/` (strategy pattern, registry lookup, one strategy per
format, chosen by the header pass):

- `GifSpriteDecoder`: own LZW decoder plus disposal compositing into a reused RGBA buffer. No
  browser API at all.
- `ApngSpriteDecoder`: rebuilds one still PNG stream per frame (`IHDR` + the shared chunks +
  `fdAT` rewritten to `IDAT`, fresh CRCs), decodes it with `createImageBitmap` (still-image
  decoding, universal), composites with `dispose_op`/`blend_op` on an `OffscreenCanvas`, reads
  back or uploads the canvas. A static PNG is the one-frame case.
- `WebCodecsSpriteDecoder` (animated WebP only): `ImageDecoder` when
  `ImageDecoder.isTypeSupported('image/webp')`; uploads each composited `VideoFrame` into its
  layer with `texSubImage3D`, then `close()`s it.
- `AsepriteSpriteDecoder`: inflates cels with `DecompressionStream('deflate')` (browsers and
  Node), composites visible layers per frame in z-index order (opacity, normal blend; other blend
  modes warn and fall back to normal), skips reference layers and the children of hidden groups,
  handles RGBA, grayscale and indexed color modes and linked cels. Tilemap layers warn and are
  skipped in Phase 6.
- `StillSpriteDecoder`: `createImageBitmap`, first frame only, the last resort (warns for an
  animation it cannot play).

Half-Life SPR v2 needs no decoder strategy: `SpriteSPRLoader` gains a version 2 branch (the
40-byte header and the palette in the table above, `texFormat` mapped onto `blend`: additive →
`additive`, alpha-test → `alphaTest` with index 255 transparent, index-alpha → `alpha` with the
palette index as alpha, normal → opaque `alphaTest`), pixels translated in the loader as for
version 1.

The order is the format's own decoder, then `ImageDecoder` (WebP), then still. Decoding runs on the main
thread inside the async model load. Moving it into a worker (`docs/workers.md`) is the Phase 7
option if big sprites hitch at map load.

**Memory guard.** `frames × width × height × 4` bytes, plus mips. Above a budget (a cvar,
default 64 MB per model) the loader halves the resolution and warns. Width and height are capped
at `MAX_TEXTURE_SIZE`, layers at `MAX_ARRAY_TEXTURE_LAYERS` (WebGL 2 guarantees 2048 and 256).

### E. Animation timing and the game API

- `ClientEdict` gains `animationStartTime`. `model` and `frame` are plain fields today, written
  in five engine places (`u.model`/`u.frame` in `ClientServerCommandHandlers.ts`, static
  entities, baselines, save-game restore in `ClientEntities.ts`) and by game code
  (`bubble.model = engine.ModForName(...)` in id1's `Bubbles.ts`, `Gibs.ts`, the view model). So
  both become accessors on `ClientEdict` that stamp `animationStartTime = clientRuntimeState.time`
  when the value changes; no caller has to remember it. Assignment syntax stays the same for the
  games. A `frame` write with an unchanged value (every `u.frame` update) does not restart the
  sequence. A restored persistent client entity starts its sequence at load time.
- `SpriteAnimator` (`source/engine/common/model/sprite/SpriteAnimator.ts`, pure, tested) answers
  "which image(s) and what blend factor at time t" for a sequence, honoring `direction` and
  `repeat` (a finished sequence holds the image it ended on). The renderer and the duration query
  share it.
- Phase picks `t`: `global` = `cl.time` (today's SPR), `random` = `cl.time + syncbase`,
  `spawn` = `cl.time - animationStartTime`.
- **One-shot effects** need the game to know how long a sequence runs. `ServerEngineAPI` and
  `ClientEngineAPI` gain `GetSpriteSequenceDuration(modelName, frame): number` (0 for a model
  that is not a sprite), so an explosion is:

  ```ts
  this.setModel('gfx/explosion.webp'); // the file (or sidecar) says repeat: 1
  this._scheduleThink(this.game.time + this.engine.GetSpriteSequenceDuration('gfx/explosion.webp', 0), function (this: ExplosionEntity) {
    this.remove();
  });
  ```

- **Sequences by name** (maintainer's decision): both APIs also gain
  `GetSpriteSequenceIndex(modelName, name): number` (−1 when absent), so a game writes
  `this.frame = this.engine.GetSpriteSequenceIndex('gfx/imp.aseprite', 'burst')` instead of
  relying on the order of the sequences in a sidecar or Aseprite file.

  All of it goes into `source/shared/GameInterfaces.ts` and `docs/game-module-contract.md`.
- A client that joins mid-animation starts it from the beginning. Acceptable for effects; a
  game that needs exact sync keeps driving `frame` itself.

### F. Rendering

- `SpriteModelRenderer` binds `model.texture` once per sprite and streams the quad with a layer
  attribute (and a second layer plus mix factor when `interpolate`). Sprites with the same model
  can then share one stream flush.
- The five orientation types get their real basis vectors (math under "Verified format
  layouts"). The transparent pass enables `CULL_FACE` for sprites, so `oriented` sprites stay
  one-sided as today.
- **Blending, as checked in Phase 0.** `TransparentPass.#beginKind` sets the blend function once
  per run of same-kind items and keeps `depthMask(false)` for the whole pass, so sprites never
  write depth already. A per-sprite blend function would mean a flush and a state change inside
  a run. Premultiplied alpha avoids both: textures are uploaded premultiplied
  (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`), the sprite run uses `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`,
  and the shader picks the mode by what it writes: `alpha` writes `(rgb·a, a)`, `additive` writes
  `(rgb·a, 0)`, `alphaTest` discards below 0.25 as today. Sprites of every mode batch in one run,
  and premultiplying also removes the dark fringes straight alpha gets from linear filtering and
  mipmaps. `uAlpha` scales all four channels. Fog mixes towards `uFogColor·a` for `alpha` and
  towards black for `additive`. The emissive attachment is blended with the same function.
- `sprite.frag` switches to `sampler2DArray` and selects the mode with a uniform, branchless, per
  the `shader-chunks` style rules.
- Fullbright and bloom emissive stay as they are.

### G. The same sprites in 2D (HUD, screen effects), Phase 8

Built in Phase 8 (see "What actually shipped in Phase 8", which also lists where it differs from this design: no
batching, and the clock). A–F were shaped so it is an addition, not a rework. Reviewed against the code on 2026-10-23;
the forks were settled ("Decisions for Phase 8").

- **Today** a HUD draws a `GLTexture` with `engine.DrawPic()` (`Draw.Pic`, `pic` program, `sampler2D`, straight
  alpha), at screen coordinates times a `scale`, loaded once with `engine.LoadPicFromFile()`. Nothing animates, there
  are no sub-rectangles, no tint, no additive blending, and `Draw.Pic` flushes the stream after every quad.
- **Loading.** `ClientEngineAPI.LoadSprite(filename, options?): Promise<SpritePlayback>`, with
  `options.sidecar` and `options.clock`. The asset comes from `Mod.modelLoaderRegistry.load()`, the
  loaders a world sprite goes through (header pass, sidecar, decoder strategies, memory guard), so `.spr` works as well,
  and Half-Life's HUD sheets are SPR v2. The resulting `SpriteModel` never enters Mod's per-map caches: a client-side
  `SpriteAssets` cache keeps its asset by file name for the page's lifetime, survives map changes and disconnects, and
  frees the textures on `gl.shutdown`. A file that does not load as a sprite throws. Of the sidecar, `orientation`,
  `phase`, `lit` and `origin` are world settings and do nothing in 2D; the rest applies.
- **Playback.** Each `LoadSprite` call returns a new `SpritePlayback` over the shared asset, so two HUD elements from
  one file play independently. It holds the sequence, the start time, a speed and whether it is paused:
  `play(sequence: number | string)` (by index or by name, restarting it), `pause()`, `resume()`, `duration`,
  `finished`. It answers through the shared `SpriteAnimator`, the way world sprites use the entity's `frame` and
  `animationStartTime`. Its clock is client time (`clientRuntimeState.time`) by default, or real time
  (`clock: 'real'`). **Correction (Phase 8):** the two were meant to differ (client time stopping with a pause and
  starting over on a new connection), but client time is `Host.realtime` minus a latency that is always 0, so today they
  run alike; a clock that goes backwards restarts the sequence. Game code never constructs a playback:
  `SpritePlayback` is re-exported from `source/shared/GameInterfaces.ts` as a type, like `GLTexture`.
- **Drawing.** `ClientEngineAPI.DrawSprite(x, y, playback, options?)` with `scale`, `region` (a name), `tint` (RGB) and
  `alpha`, at screen coordinates like `DrawPic`; a menu places it with `Menu.toScreenPosition`/`viewportScale`. The top
  left corner of the image (or the region) is at `x, y`; its size is the image's width and height (pixels times the
  sidecar's `scale`) times `options.scale`. `Draw` gets a `pic-sprite` program on `sampler2DArray` whose vertex carries
  the layer, the next layer and the fade, so the asset's `blend` and `interpolate` (with `r_interpolation`) work as in
  the world. **Deviation (Phase 8):** every `DrawSprite` flushes its own quad, no batching, see "What actually shipped in Phase 8".
- **Blend state.** Pictures hold straight alpha and the 2D pass blends with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`, which
  `GL.Set2D()` now sets ("Fixed before Phase 8"). Sprite textures are premultiplied, so `DrawSprite` switches to
  `ONE, ONE_MINUS_SRC_ALPHA` for its quad and switches back after the flush.
- **Shader chunk.** What the 2D program shares is the sprite texel and blend-mode output of `sprite.frag` (crossfade
  between two premultiplied layers, discard below a quarter for `alphaTest`, alpha 0 for `additive`), so that moves
  into a chunk both programs include (`shader-chunks`). `pic.frag` is one line and stays as it is.
- **Regions.** `SpriteAsset` gains `regions`, named rectangles in file pixels: from the sidecar
  (`"regions": { "number_0": [0, 0, 20, 24] }`) and from Aseprite slices, the sidecar winning on a name clash. A
  region cuts whatever image is current. `AsepriteSliceKey` keeps only `x`, `y` and the pivot today, so the reader has
  to keep each key's width and height too; a slice takes the bounds of its key at frame 0. `SpriteImage` gains its
  size in file pixels (today it has only world units after `scale`), so a region's texture coordinates come from
  pixels and `uvScale`, not from the texture, which the memory guard may have shrunk.
- **Screen effects.** A full-screen `DrawSprite` with `additive` or `alpha` from the game's `draw()`, or from
  `drawOverlay()` for one that must stay visible under `nohud`, covers damage splatter, visor rain or a teleport flash.
  Like every overlay it is not in a clean screenshot. A `sprite` effect in the post-process stack, which would get the
  pulse timing (fade in, hold, fade out, keyed restarts) and the `final` stage, is a later option.
- **Not in Phase 8.** A `hud.txt` reader (GoldSrc cuts its HUD sheets into named regions with it; there is no real
  Half-Life file here to check it against, and SPR v2 itself is unverified), a menu-space wrapper under
  `ClientEngineAPI.Menu`, animated decals (`PlaceDecal` taking a sprite), the post-process effect.

## Phasing

Every phase from 1 on also updates the docs listed under "Documentation" for what it ships, as
part of its exit.

0. ✅ **Settle the forks**, verify the format layouts against the specs, check `TransparentPass`
   blend-state handling and how `COM.LoadFile` misses.
1. ✅ **Reshape `SpriteModel`, SPR on the new path.** A (with the `SpriteAsset` split), F (array texture, orientations, shader
   `sampler2DArray`), `SpriteAnimator`, `animationStartTime`. No new formats. Exit: id1's
   `s_explod.spr`, `s_light.spr`, `s_bubble.spr` look and animate exactly as before in a browser.
2. ✅ **Header parsers and the server side.** B.1, `ImageSpriteLoader` without pixels. Exit:
   `setModel('gfx/x.gif')` on the dedicated server sets correct bounds; duration query works
   server-side.
3. ✅ **Client decoding.** D: GIF and APNG decoders, the WebP `ImageDecoder` path, still fallback,
   memory guard. Exit: GIF, APNG,
   static PNG and WebP sprites animate in Chromium and Firefox; GIF and APNG in Safari (or a
   WebKit build, if available here; otherwise say so). Checked in Chromium only; Firefox and Safari not.
4. ✅ **Sidecar and blend modes.** C, the `alpha`/`additive` shader paths, `filter`, `fps`,
   sequences, `interpolate`, `phase`, the `sidecar: false` precache hint with its `serverdata`
   flags byte (protocol 43) and the quiet `LoadFile` variant.
5. ✅ **Game API and docs.** E's duration and name queries, the README bullet (formats shipped so
   far: GIF, PNG/APNG, WebP), the complete `docs/sprites.md` page on authoring image sprites (formats,
   sidecar reference, ffmpeg/Aseprite export one-liners), JSDoc.
6. ✅ **Aseprite and Half-Life SPR v2.** `AsepriteHeader` + `AsepriteSpriteDecoder` (tags →
   sequences with direction and repeat, slice pivot → per-image origin), SPR v2 branch with its
   render modes. Their sections in `docs/sprites.md`; the README bullet gains Aseprite and
   Half-Life sprites. The Half-Life render modes are unverified (no real file).
7. ✅ **Extras, each optional:** lit sprites (sample the lightgrid at the origin), decoding in a
   worker, AVIF. Only lit sprites was chosen and built; the worker was measured as not needed, AVIF not built.
8. ✅ **2D sprites (G).** `LoadSprite` with the `SpriteAssets` cache, `SpritePlayback` with
   its clock, `DrawSprite` with the `pic-sprite` program and the chunk shared with `sprite.frag`, regions from the
   sidecar and Aseprite slices, tint. Browser check of an animated HUD element, a tinted additive region and a
   full-screen effect (Chromium).

## Documentation

Docs ship with the phase that ships the feature, never later; a phase isn't done until its docs
are. Nothing claims a format before it loads.

- **New `docs/sprites.md`**, linked from the table of contents in `docs/README.md`. The guide for
  artists and game programmers:
  - the formats, what each is good for (the "Format pick" table) and where each animates
    (WebP shows only its first frame in Safari);
  - the minimal use (`PrecacheModel` + `setModel`) and what happens without any configuration;
  - the sidecar reference: every field, its values and default, and which realm reads it;
  - timing: the 10 ms clamp, `fps`, `direction` and `repeat`, `phase`, when a sequence restarts
    (model or frame change);
  - blend modes and premultiplied alpha, the five orientation types, `scale` and `origin`;
  - Aseprite: tags become sequences, the pivot slice becomes the origin, what isn't supported
    (non-normal layer blend modes, tilemaps);
  - Half-Life SPR v2 and how its texture formats map onto blend modes;
  - the `sidecar: false` precache hint, and the sequence queries with a one-shot explosion example;
  - the memory guard and its cvar;
  - export one-liners (ffmpeg to APNG and WebP, Aseprite's CLI).
- **`docs/game-module-contract.md`**: the `sidecar` option next to the existing `meshCollision`
  paragraph about `PrecacheModel`, and `GetSpriteSequenceDuration`/`GetSpriteSequenceIndex` on both
  engine APIs.
- **`docs/client-entities.md`**: `model` and `frame` are accessors now, and changing either
  restarts a sprite's animation.
- **`docs/asset-layer.md`**: the quiet `LoadFile` variant for optional files.
- **`docs/shader-chunks.md`**: its list of chunks, if the sprite or `pic` shaders get a new one.
- **JSDoc**: every format parser carries its byte layout from "Verified format layouts"; the
  `serverdata` writer and reader document the flags byte and protocol 43.
- **`README.md`**: one bullet in the feature list, linking `docs/sprites.md`, for example:
  "**Modern Sprites**: animated sprites from GIF, PNG/APNG, WebP and Aseprite files, plus
  Half-Life sprites, with blend modes, named sequences and optional per-sprite settings."
- Phase 8 (2D) adds a HUD and screen-effects section to `docs/sprites.md` (the `regions` setting in the settings
  reference, which settings do nothing in 2D), `LoadSprite`/`DrawSprite` and the `SpritePlayback` handle to
  `docs/game-module-contract.md`, the new chunk to `docs/shader-chunks.md`, and extends the README bullet.

## Testing

- **Unit (Node):** each header parser against tiny fixtures (a 2-frame GIF with two disposal
  modes, an interlaced GIF, a GIF without a NETSCAPE block, a static PNG, a 3-frame APNG whose
  default image is part of the animation and one where it is not, an animated WebP plus a simple
  `VP8 ` and a `VP8L` file, a 2-layer tagged `.aseprite` with a pivot slice, a small HL v2 `.spr`
  per render mode), checked-in under `data/` and added to the Dockerfile
  (`dockerfile-fixture-sync`). GIF LZW decode to RGBA (pure). APNG frame splitting (byte-level, no
  `createImageBitmap`). Sidecar merge and defaults. The 10 ms timing clamp. `SpriteAnimator`
  directions / repeat / phase. `ClientEdict` accessors stamp `animationStartTime` only on a
  change. SPR loader onto the new shape (padding, `uvScale`). `ImageSpriteLoader` with
  `loadRenderData = false` (bounds, durations, no decoder call). Boundary test stays green.
- **Browser (`browser-ui-verification`):** after Phase 1 the three SPR effects side by side with
  `main`; after Phase 3/4 a test entity per format and blend mode, in Chromium and Firefox. Safari
  can't be run here; I'll say so rather than claim it.
- **Phase 8, unit:** `SpritePlayback` (both clocks, play by index and name, pause, repeat and `finished`, a clock that
  started over), `LoadSprite` (one asset for two handles, a file that is no sprite, survives a map change, freed on
  `gl.shutdown`), regions from the sidecar and from Aseprite slices (the reader keeping their size, the sidecar
  winning), region texture coordinates on a texture the memory guard shrank, `DrawSprite`'s blend switch and batching
  with the recording context. **Browser:** an animated HUD element, a tinted additive region, a full-screen effect, and
  a half transparent HUD rectangle while a sprite is the nearest transparent item (the fix below).

### What actually shipped in Phase 0

No code. Everything below changed the plan, not the engine:

- **Specs verified** from the downloaded primary sources; the results are the "Verified format
  layouts" table. Corrections to the first draft: Aseprite's magic is at offset 4, so `canLoad()`
  can't use the 4-byte-at-0 default; an APNG's default image is not always frame 0; static WebP
  keeps its size in the VP8/VP8L bitstream header; GIF's loop count lives in a de-facto extension
  that isn't in the GIF89a spec, and when it is missing the file plays once.
- **Transparent pass:** blend function per run of same-kind items, depth writes already off for
  the whole pass. That led to the premultiplied-alpha decision (F) instead of switching blend
  state per sprite.
- **Missing files:** no file list; every miss is a network round trip per realm and a console line
  (C). I proposed a miss cache; the maintainer chose a precache hint carried to the client
  instead (C, decided 2026-10-23).
- **Client model writes** are spread over engine and game code, which led to the accessor decision (E).
- **Loop vocabulary** changed from `loop | once | pingpong` to Aseprite's `direction` + `repeat`,
  which every format maps onto without loss.
- **SPR v2 phase** follows v1: its header has the same `synctype`.

### What actually shipped in Phase 1

SPR sprites run on the new model, renderer and shader; no new file format yet.

- **Data model (A).** `source/engine/common/model/sprite/` holds `SpriteTypes.ts` (the `SpriteOrientation`,
  `SpriteBlend`, `SpriteDirection`, `SpritePhase` enums, `SpriteImage`, `SpriteSequence`),
  `SpriteAsset.ts` (frames, blend, layer size, array texture), `SpriteAnimator.ts` and `SpritePixels.ts`
  (pads an image into a larger layer). `SpriteModel` owns an `asset` and has `orientation` and `phase` instead of
  `oriented`; `frames` and `numframes` are getters. `model.random` stays, set from `phase`, because the client
  derives `syncbase` from it.
- **SPR loader.** Rewritten onto that shape. It now reads the frames in both realms (the old one skipped them on the
  server), so the server has `endTimes` and image sizes. Only `loadRenderData` builds the texture. An unknown
  header `type` falls back to `parallel` with a warning instead of being drawn as one by accident.
- **Array texture.** `GLTextureArray.FromRGBALayers()` (full mip chain, clamped, follows `gl_texturemode` like
  `GLTexture`), `bind(unit, flushStream)`. `GL.Shutdown()` frees the arrays.
- **Rendering (F).** `sprite.vert/.frag` use a `vec3` texture coordinate and `sampler2DArray`; the shader takes
  the color out of the premultiplied texel (`rgb / a`) for gamma and fog and writes premultiplied output;
  `TransparentPass` blends sprites with `ONE, ONE_MINUS_SRC_ALPHA`. All five orientation types have their basis
  (`parallelUpright`, `facingUpright`, `oriented`, `parallelOriented`, `parallel`). Only the `alphaTest` path is in
  the shader; the `alpha`/`additive` uniform waits for Phase 4.
- **Timing (E).** `ClientEdict.model` and `.frame` are accessors that stamp the new `animationStartTime`;
  `phase` picks `global`, `random` (`+ syncbase`) or `spawn` (`- animationStartTime`).
  `SpriteAnimator` has `imageIndexAt()`, `cycleDuration()` and `duration()`. A finished ping-pong sequence holds
  the image its cycle started with; the other directions hold the last image they showed.
- **Deviations from the design.**
  - `SpriteAnimator` returns an image index only. The blend factor for `interpolate` comes with Phase 4.
  - `SpriteAsset` has no `regions` (G) and `SpriteModel` no `lit` yet; they land with their phases.
  - **Fixed a latent bug on the way:** sprites are streamed and drawn at the next flush, but `uAlpha` and
    `uBloomEmissiveScale` were set per sprite, so every sprite of a run was drawn with the last sprite's values.
    The renderer now flushes when either changes. An entity with `alpha 0.5` next to others was drawn opaque
    before; the browser pass showed it.
  - Sprites that share an array texture are batched into one flush; a different texture, alpha or emissive scale
    flushes.
- **Visible change (deliberate).** The premultiplied path removes the dark fringe on a sprite's silhouette: the
  one-pixel edge of `s_explod`, `s_light` and a synthetic group differs from `main` by at most a few dozen levels
  per pixel (summed over RGB); everything inside the silhouette is identical.
- **Docs updated:** `docs/client-entities.md` (the accessors). `docs/sprites.md`, the README bullet and
  `docs/game-module-contract.md` wait for the phases that ship what they describe.
- **Tests added:** `test/common/sprite-animator.test.ts` (every direction, repeat, holds),
  `test/common/sprite-spr-loader.test.ts` (header, orientation, phase, groups, layers, `uvScale`, server realm,
  padding), `test/client/client-edict-animation.test.ts` (accessors stamp only on a change). All 2644 tests,
  ESLint and `npm run typecheck` are green; the shader library test links `sprite` with `glslangValidator`.
- **Browser check** (Chromium on software GL, `browser-ui-verification` recipe, before = `HEAD`, after = working
  tree): `s_explod`, `s_light`, `s_bubble` and a synthetic three-image group of different sizes (padding and
  `uvScale`) with the clock pinned. Same image at every time in both builds, only the silhouette edge differs
  (above). Then the after build alone: `alpha 0.5` entities draw at half brightness, and all four orientation
  types other than `parallel` draw plausibly (upright, facing, entity-angled, rolled). Not checked: Firefox and
  Safari, and a group in an id1 sprite (none of the three shipped SPRs has one; the synthetic group stands in).

### What actually shipped in Phase 2

A server can load GIF, PNG/APNG and WebP files as sprite models; nothing draws them yet (Phase 3).

- **Header parsers** in `source/engine/common/model/sprite/`: `GifHeader.ts`, `PngHeader.ts`, `WebpHeader.ts`, each
  with the byte layout from "Verified format layouts" in its JSDoc, and `ImageHeader.ts` (`ImageHeader`, `SpriteTag`,
  `ImageHeaders.detect()/parse()`, `ImageHeaders.frameSeconds()` for the 10 ms clamp). A header is
  `{ width, height, frameDurations (ms, as written), repeat (plays, 0 = forever), tags }`. A truncated file
  (`RangeError` from the `DataView`) becomes a `CorruptedResourceError`.
- **`ImageSpriteLoader`**, registered after `SpriteSPRLoader` in `Mod.Init()`. `canLoad()` is overridden (extension in
  `.gif .png .apng .webp` plus a signature check, `getMagicNumbers()` returns `[]`). It builds the model without
  pixels: bounds like an SPR (`±width/2` in x and y, `±height/2` in z), origin at the image's center, one `forward`
  sequence over all images with the file's repeat count, a still file as a single `SpriteImage`, `phase: spawn`,
  `alphaTest` for GIF and `alpha` for the rest.
- **Repeat counts:** GIF with a NETSCAPE loop count N plays N + 1 times (N = 0: forever) and plays once without
  the block; APNG and WebP play exactly their count. The N + 1 reading is how Chromium's decoder treats a GIF
  as far as I know, it was not checked against a browser; Phase 3 renders GIFs and can confirm it.
- **Deviation:** while the pixel pass does not exist, a load in a realm that draws prints a warning and the model's
  asset has no texture, so the renderer skips it. Phase 3 removes the warning.
- **Duration query:** `SpriteAnimator.duration()` on the loaded sequence already answers it on the server
  (tested); `GetSpriteSequenceDuration` as game API is Phase 5.
- **Fixtures:** 13 real files in `test/fixtures/sprites/` (README there says how they were made). They sit under `test/`,
  which the Dockerfile copies as a whole, so it needed no change. Cross-checked with Pillow and `ffprobe`
  (frame counts, sizes, delays, the APNG whose default image is not part of the animation).
- **Tests added:** `test/common/image-headers.test.ts` (all three parsers, the clamp, broken files),
  `test/common/image-sprite-loader.test.ts` (`canLoad`, bounds, sequence, durations through the model cache in a
  server realm, the warning on a drawing realm), and one in `test/physics/server-edict.test.ts` that `setModel()`
  on a GIF sets the entity's `mins`/`maxs`. 2678 tests, ESLint and typecheck green; the boundary test still holds.
- **Docs:** none yet, by plan (`docs/sprites.md` is Phase 5); no doc claims the formats.

### What actually shipped in Phase 3

Image sprites are decoded and drawn in the client: GIF, APNG, static PNG, animated and static WebP.

- **Contract.** `ModelLoadContext.spriteImages: SpriteImageDecoding | null` (interface in
  `common/model/sprite/SpriteImageDecoding.ts`, `null` on a server), passed by `Mod.Init({ spriteImages })` from
  `ClientHost`. A decoder answers with `{ width, height, frames }`: every frame composited onto the full canvas as
  premultiplied RGBA. `ImageSpriteLoader.load()` is async now: with a decoder it uploads the frames through
  `GLTextureArray.FromRGBALayers()` and builds the sequence from as many frames as there are pixels for, so a
  browser that only shows the first frame of a WebP gives a still sprite, with a warning.
- **Strategies** in `client/renderer/sprite/`, tried in order by `SpriteImageDecoding`, a failing one hands
  over to the next with a warning: `GifSpriteDecoder` (own LZW, color tables, transparency, sub-rectangles,
  interlacing, disposal 0 to 3), `ApngSpriteDecoder` (rebuilds each frame as a standalone PNG with fresh CRCs
  (`CRC32` in `common/CRC.ts`), the browser decodes it as a still image, the compositing with `dispose_op` and
  `blend_op` is plain code on premultiplied pixels), `WebCodecsSpriteDecoder` (animated WebP through `ImageDecoder`),
  `StillSpriteDecoder` (`createImageBitmap`, first frame; also the path of plain PNG and static WebP).
  `BrowserImagePixels` is the only place that touches `createImageBitmap`, `OffscreenCanvas` and `getImageData`.
- **Limits.** `SpriteImageLimits`: frames over `MAX_ARRAY_TEXTURE_LAYERS` are dropped, images are halved (box filter
  on premultiplied pixels) until they fit `MAX_TEXTURE_SIZE` and the budget, and the loader warns. The budget is the
  new archived cvar `r_sprite_memory` (megabytes, default 64, mip chain counted, read at each load). The sprite
  keeps its world size, only the texture gets smaller. `GL.maxArrayTextureLayers` is new.
- **Deviations from the design.** The decoders hand out pixel arrays and never touch GL, so the plan's
  "`WebCodecsSpriteDecoder` uploads each `VideoFrame` with `texSubImage3D`" became "reads each frame back and
  premultiplies it on the CPU"; one upload path, and everything but the browser calls is testable in Node.
  Premultiplying after `getImageData` costs a rounding step on half transparent pixels.
- **Timing check postponed.** The N + 1 plays of a GIF loop count (Phase 2) was not compared with a browser; the
  fixture is too fast to count. It needs a GIF with a visible counter in each browser.
- **Test support.** `test/support/spriteImages.ts` has a small GIF encoder (LZW, interlacing, disposal, local
  palettes), an APNG encoder and a PNG decoder, so the decoders run in Node on shapes the fixtures lack.
  `progressive.gif` (Pillow, not interlaced) joins the fixtures.
- **Tests added** (2735 in all, ESLint and typecheck clean): `sprite-gif-decoder` (a Pillow file against known
  pixels, interlaced against progressive, all disposal methods, transparency, local palettes, LZW growth to 12
  bits and dictionary reset, clipping, broken files), `sprite-apng-decoder` (splitting with and without a default
  image frame, rebuilt PNGs, blend over/source, dispose none/background/previous, premultiplied rounding),
  `sprite-image-decoding` (order, fallback on failure, short frame counts, limits), `sprite-pixels` (premultiply,
  halve, CRC32), and the loader's client path (what it asks the texture for, size of the sprite vs the texture,
  fewer frames than the file, no decoder, none on a server).
- **Browser check** (Chromium on software GL, clock pinned, 64x64 four-frame test images with transparency):
  `t.gif`, `t.apng` and animated `t.webp` show the same frame at the same time at the four 250 ms steps and again a
  cycle later; a GIF without a loop block plays once and holds its last frame; static PNG and static WebP draw;
  half transparent pixels blend in APNG and WebP and are on/off in GIF; `r_sprite_memory 0.02` makes a 64x64 sprite
  load as 16x16 with a warning and draw at the same world size. **Not checked:** Firefox (needs `ImageDecoder`
  there for animated WebP, version 133 or later), Safari, and the sidecar-less size problem (Phase 4).
- **Docs:** none yet, by plan; `r_sprite_memory` is described in the cvar's own help text.

### What actually shipped in Phase 4

- **Sidecar (C).** `common/model/sprite/SpriteSidecar.ts`: `SpriteSidecars.parse()` validates every setting with
  typed readers and reports what is wrong on the console (wrong type, out of range, a word that is not a choice, an
  unknown key as "unknown setting"), leaves it out and still loads the sprite. Both realms read it
  (`ModelFiles.LoadOptionalTextFile(name + '.json')`), because the scale decides the bounds the server uses.
  Settings: `version`, `orientation`, `origin`, `scale`, `blend`, `filter`, `phase`, `interpolate`, `fps`, `repeat`,
  `colorKey`, `sequences`.
  - **`origin` is a pixel of the image counted from its top left corner** (the plan did not say). Default is the
    center; `[width / 2, height]` is the bottom center. The bounds follow it: horizontally as far as the farther
    side, because a billboard turns around the origin; vertically from the real bottom to the real top.
  - **A sequence's `repeat` and `fps` default to the sidecar's top-level ones, then the file's.** `fps` replaces
    the file's delays and the 10 ms clamp. Sequences that reach past the file are cut and reported.
- **Black to alpha.** Built as proposed and recommended: `blend: additive` and `colorKey` (`color`, `tolerance`;
  matches by the color a pixel has at full alpha, hard edge, applied to every frame before upload).
  `"alphaFrom": "luminance"` is **not built** (no answer to the question yet); say so and it is a few lines in
  `SpritePixels`.
- **Rendering (F).** `sprite.frag` has `uBlendMode` (0 alpha tested, 1 alpha, 2 additive): additive writes no alpha,
  so it adds; fog fades an additive sprite to nothing; the three batch in one run with a flush when alpha, emissive
  scale or mode change. The vertex got `aBlend` (next layer, fade) at attribute location 10; `interpolate` mixes the
  two premultiplied texels. `SpriteAnimator.blendAt()` gives the next image and the fade (reverse and ping-pong
  included) and honors `r_interpolation`. `GLTextureArray.FromRGBALayers(..., filter)`: `nearest` is hard pixels, `linear`
  is smooth with mips, none follows `gl_texturemode`.
- **Hint and protocol.** `PrecacheModel(name, { sidecar: false })`; `ModelLoadOptions.sidecar` (default `true`);
  `BaseModel.sidecarSkipped` lets the model cache reload a model that skipped it when a later load wants it (and
  never replace one that has it by one that skipped). `serverdata` carries one `ModelPrecacheFlags` byte after each
  model name, protocol **43** (`source/shared/ModelPrecacheFlags.ts`; the writer and reader of the list are
  `network/ModelPrecacheList.ts`, tested for layout and round trip). The Half-Life studio model plan still has to
  take 44.
- **Quiet lookup.** `Com.LoadOptionalFile` / `LoadOptionalTextFile`: like `LoadFile` but a miss prints nothing; every
  `ModelFiles` implementation has the text variant. In a browser a miss is still a request, so the hint matters.
- **Docs.** New `docs/sprites.md` (formats as they are shipped, the settings reference, timing, memory, the hint),
  linked from `docs/README.md`; `docs/game-module-contract.md` (the option and the flags byte); `docs/asset-layer.md`
  (the optional lookups). The README bullet and the game API queries stay with Phase 5.
- **Tests added** (2784 in all, ESLint and typecheck clean): `sprite-sidecar` (every setting, every kind of
  mistake), the loader with a sidecar (scale, origin, bounds, every setting, fps below the clamp, sequences, repeat
  inheritance, cut sequences, broken file, no lookup with the hint, color key and filter reaching the texture),
  `precache-sidecar` (hint, flags, reload order, model cache rule), `model-precache-list`, animator `blendAt`,
  `keyColor`.
- **Browser check** (Chromium, clock pinned, ten sprites at once): scale 1 against 0.5, bottom-center origin,
  `linear` against `nearest` on a pixel-art PNG, a flame GIF with an opaque black background drawn plain, `additive`
  and with a color key, a crossfade at half time between two frames, a named sequence selected with `frame` playing
  in reverse. A sidecar-less lookup prints nothing and costs one request. **Not checked:** Firefox; the hint end to
  end in a live game (covered by unit tests of both sides, the in-browser server and client talk through the same
  `ModelPrecacheList`); `interpolate` on a sprite whose images differ in size (image sprites never do).
- **Found on the way:** a maintainer's uncommitted id1 experiment (`setModel('gfx/fire.gif')`, 437x498, 20 frames,
  opaque black) is what the lookup 404 in the logs was, and what the settings are for.

### What actually shipped in Phase 5

- **Game API (E).** `GetSpriteSequenceDuration(modelName, frame = 0)` and `GetSpriteSequenceIndex(modelName, name)` on
  both `ServerEngineAPI` and `ClientEngineAPI` (the logic is `SpriteModel.sequenceDuration()` / `sequenceIndex()`).
  Duration is `Infinity` for a sequence that repeats forever (an SPR group does), 0 for a still image and for a model
  that is no sprite, and a `frame` out of range selects the first, like the renderer. The index is -1 for no match,
  an empty name and a model that is no sprite. Both **throw** for a model that was not precached, and on the server for
  one that has not finished loading (a precaching entity's `spawn()` during the map load can hit that): a typo must
  not turn into an effect that removes itself at once. `ServerDependencies.ModelCache` got `ResolveScopedModel`.
  The queries live on the engine API classes, which `GameInterfaces.ts` re-exports; nothing to add there.
- **Docs.** `README.md` feature bullet; `docs/sprites.md` is complete for what exists: formats, settings, timing,
  memory, the hint, effects that remove themselves, making the files (the three ffmpeg commands in it were run with
  ffmpeg 8.0.1 against small generated inputs), what an Aseprite or Half-Life sprite will add is left to Phase 6;
  `docs/game-module-contract.md` lists both queries.
- **Real-world files.** An APNG and a GIF written by ffmpeg (12 frames, the GIF with sub-rectangle frames from its
  palette optimization) decode pixel-identical to Pillow's frames with our decoders and headers (checked once, by
  hand, not a test: no ffmpeg in the Docker stage). This is the check the maintainer's own files were meant for.
- **Tests added** (2801 in all, ESLint and typecheck clean): `sprite-sequence-queries`, the same 8 cases against
  both APIs (one-shot and counted durations, forever, still and non-sprite, named frame durations, out of range,
  lookup by name, unknown and empty names, not precached) and `SpriteModel` ping-pong counting.
- **Not changed:** the README does not promise Aseprite or Half-Life sprites yet.

### What actually shipped in Phase 6

- **Aseprite file reader.** `common/model/sprite/AsepriteFile.ts` takes a file apart (header, frames, chunks `0x2004`
  layer, `0x2005` cel, `0x2018` tags, `0x2019` and the old `0x0004`/`0x0011` palettes, `0x2022` slice; everything else is
  skipped by its size) without decompressing, and `AsepriteHeader.ts` turns it into the `ImageHeader` of the header pass
  (durations, tags, pivots). Both realms use it. `ImageHeader` gained `origins` (one pixel per image or `null`), `ImageFormat`
  gained `aseprite`, detection looks for `0xA5E0` at offset 4 (so an Adobe `.ase` swatch file, which shares the
  extension, is not taken). A frame without a duration takes the header's speed, as the spec says.
- **Pixel decoder.** `client/renderer/sprite/AsepriteSpriteDecoder.ts`: inflates with `DecompressionStream('deflate')`,
  converts RGBA, grayscale and indexed pixels (palette alpha; the transparent index is transparent except in the
  background layer), skips hidden layers, layers in hidden groups, reference layers, tilemap layers (reported once) and
  groups, orders cels by `layer + z-index` then `z-index` (spec NOTE.5), applies layer opacity (when the header says it is
  valid) and cel opacity, follows linked cels, composites in float premultiplied and rounds once. Non-normal blend modes
  are drawn as normal and reported once.
- **Tags and pivots in the loader.** With no `sequences` in the sidecar the tags become the sequences, in order, with
  their direction and repeat; the sidecar's `repeat` and `fps` replace theirs. Aseprite counts the legs of a ping-pong in
  `repeat`, a sequence counts cycles, so a ping-pong tag's count is halved (rounded, at least 1): this is the one
  place where the file cannot be followed exactly (an odd count like "3 legs" has no equivalent). The first slice with a
  pivot sets `origin` per image (a moving slice moves it), the sidecar's `origin` wins, and the bounds are the union.
- **Half-Life SPR v2** in `SpriteSPRLoader`: the 40 byte header, the 256 color palette, `texFormat` 0 normal (opaque),
  1 additive (`blend: additive`), 2 index-alpha (`blend: alpha`, alpha = index, color from the entry, premultiplied), 3
  alpha test (index 255 transparent); an unknown value is alpha test with a warning. The values are FTE's and no real
  Half-Life sprite was available: **unverified**, and the docs say so. A `.spr` does not read a sidecar.
- **Checked against the real thing (once, by hand, files not committed because of Aseprite's license):** the 18 test
  files of the Aseprite repository (made by the real editor) all parse and decode; layer names, hidden layers and groups,
  tag names, directions and repeats, slice keys, the transparent index and the palettes agree with the README of those
  files, and the decoded frames look right (text sprites, letters on four layers, linked cels, the empty second frame
  of `1empty3`). No file had a slice pivot, and there is no ground-truth image to compare pixels against.
- **Tests added** (2863 in all, ESLint and typecheck clean): `test/support/aseprite.ts` is an Aseprite encoder written
  from the spec; `aseprite-file` (parsing, durations and speed, unknown chunks, damaged files, layer visibility, palettes,
  tags, pivots), `sprite-aseprite-decoder` (every color mode, order and z-index, opacity, hidden and reference layers,
  tilemap and blend-mode warnings, links), the loader's Aseprite tests (tags to sequences, repeat conversion, sidecar
  overrides, pivots and bounds, upload), and the Half-Life cases of `sprite-spr-loader`.
- **Browser check** (Chromium, the same ten-sprite scene): editor-made `abcd`, `1empty3` (sequences by `frame`), `tags3`
  (the three tags animating at once, each in its own direction), `link`, and a synthetic file with a pivot against the
  same file with `origin: [8, 8]`; all drawn from the real client path (zlib in the browser, array texture). Not checked:
  Firefox, a Half-Life sprite, a pivot from a real file.
- **Docs.** `docs/sprites.md` (an Aseprite section, a Half-Life section with the unverified caveat, the format table),
  the README bullet names Aseprite and Half-Life sprites.

### What actually shipped in Phase 7

The three extras were put to the maintainer (2026-10-23) with a recommendation; only **lit sprites** was chosen.

- **Lit sprites.** Sidecar `lit: true` (`SpriteSidecar.lit`, `SpriteModel.lit`, off by default; `.spr` sprites are never lit).
  The renderer asks `EntityLighting.CalculateLightValues()` (the baked light at the origin through `LightSampler`, the
  dynamic lights, smoothing, the fullbright and minlight rules) and adds ambient and dynamic light (`SpriteLighting.combine()`,
  clamped to 0..1 per channel, so a lit sprite is never brighter than its texture). The shade term and the light
  direction are not used: a billboard has no surface direction. `sprite.frag` multiplies the color by `uLight` (white
  for unlit sprites, so nothing changes for them), before fog and the bloom emissive. A different light flushes the
  stream like a different alpha does, so lit sprites do not batch with each other.
- **Decoding in a worker: not built.** Measured instead: the largest sample (437x498, 20 frames, the maintainer's flame)
  decodes in about 35 ms in Node, and the upload is one `texSubImage3D` per frame. That is no hitch at map load, which
  was the plan's condition. Reconsider if someone ships sprites several times bigger.
- **AVIF: not built,** nobody authors in it here; it would be an ISOBMFF header parser plus a WebCodecs strategy.
- **Tests added** (2868 in all): `sprite-lighting`, the `lit` setting in `sprite-sidecar` and the loader tests.
- **Browser check** (Chromium, one white sprite at one spot, shown unlit, lit and lit with a nearby dynamic light):
  the unlit one is 255 on all its pixels, the lit one 193 (the map's light there), the lit one with the light 255 again.
- **Docs:** the `lit` row in `docs/sprites.md`.

### Fixed before Phase 8

Found while reviewing Phase 8, from reading the code. `GL.Set2D()` turned blending on but never set a blend function,
and `TransparentPass` does not put one back either. Since Phase 1 the sprite run blends with `ONE, ONE_MINUS_SRC_ALPHA`,
so in a frame whose nearest transparent item was a sprite (and no color shift ran) the HUD, menu and console drew
their straight-alpha pictures with the premultiplied function: half transparent pixels (a `DrawRect` with alpha, PNG
pictures, font edges) came out too bright. Fully opaque and fully transparent lump pixels were not affected.
`Set2D()` now sets `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` (alpha `ONE, ONE`, as `GL.Init()` does). Test in
`test/client/gl.test.ts`; the recording context knows `ONE`, `SRC_ALPHA` and `ONE_MINUS_SRC_ALPHA` now (`ONE` is
logged as `1`, like `NONE` as `0`, because it is a size nearly everywhere).

**Browser check** (Chromium on software GL, `start`, production builds of `HEAD` and of the fix): `s_explod.spr` as a
client entity 40 units in front of the camera, and a 50% white rectangle over black drawn with the HUD. `HEAD` ends
the frame with `ONE, ONE_MINUS_SRC_ALPHA` and draws the rectangle white (255); the fix ends it with `SRC_ALPHA,
ONE_MINUS_SRC_ALPHA` and draws it mid gray (127). Both builds log the same three 404s of optional files, nothing else.

### What actually shipped in Phase 8

- **Data.** `SpriteImage` has `pixelWidth`/`pixelHeight` (the file's pixels, both loaders fill them). `SpriteAsset` has
  `regions` (a `Map` of name to `SpriteRegion {x, y, width, height}` in pixels, a `Map` so that a name like `constructor`
  is only a name), and now owns `sequenceDuration()`/`sequenceIndex()` (`SpriteModel`'s methods delegate, the `SpritePlayback`
  uses them). Regions come from the sidecar's `"regions": { "name": [x, y, w, h] }` (validated like the other settings:
  four whole numbers from 0, no area warns) and from Aseprite slices (`AsepriteSliceKey` keeps `width`/`height`, a
  slice takes the rectangle of its key at frame 0, or its first key; nameless and empty slices are left out). The loader
  merges them with the sidecar winning on a name, and drops a region that reaches outside the image with a warning.
  `ImageHeader` has `regions`.
- **Shader.** `include/sprite-texel.glsl` (the array texture, `uBlendMode`, `sampleSpriteTexel()` with the crossfade and
  the alpha test, `spriteIsAdditive()`) is shared by `sprite.frag` and the new `pic-sprite.vert/.frag`. `sprite.frag`
  is the same math as before, checked in a browser (the explosion SPR, an additive and an alpha image sprite).
  `pic-sprite` outputs premultiplied `(rgb * tint, a * (1 - additive)) * uAlpha`.
- **`SpritePlayback`** (`client/renderer/sprite/`): `sequence`, `play(index | name)` (throws a `RangeError` for a sequence
  the file does not have), `pause()`/`resume()`/`paused`, `speed` (changing it keeps what has played), `duration` (speed
  counted in), `finished`, `width`/`height`. It takes its clock as a function, so it is a pure class in tests.
  `SpriteAnimator.sample()` (with `SpriteSample`) is the one place that turns a frame and a time into an image, the
  fade and the next layer; the world renderer and the playback both use it, and `SpriteModelRenderer`'s own copy went away.
- **`SpriteAssets`** (`LoadSprite`): the cache by file name (a promise, so overlapping loads share the work; a
  `sidecar: false` load is its own entry; a failed load is not remembered). It asks `Mod.modelLoaderRegistry.findLoader()`
  first and refuses anything but the two sprite loaders, so a model of another kind is not loaded onto the GPU for
  nothing, and keeps the asset out of every `Mod` cache. `gl.shutdown` frees the textures. `SpriteAssets` is on
  `window.engine` for scripts.
- **`Draw.Sprite()`** and `ClientEngineAPI.LoadSprite()`/`DrawSprite()` (`tint` is any three-number array such as a
  `Vector`). Region coordinates are shares of the image (pixels over `pixelWidth`, times `uvScale`), so a texture the
  memory guard shrank or an SPR image padded into a bigger layer still cuts the right pixels. `GL.BlendStraightAlpha()`
  and `GL.BlendPremultipliedAlpha()` are the two blend functions (`Set2D()` uses the first).
- **Deviation: no batching.** Section G planned to batch sprites and flush on a texture or uniform change. A batch would
  have left the premultiplied blend function active until some later flush, and the 2D code has no single place to put it
  back (`Pic`, `Fill`, `String` all draw on their own), so each `DrawSprite` sets the function, flushes its one quad and
  puts the other back, like `Draw.Pic` flushes after each quad. A HUD with a few dozen sprites is not what this costs; if
  one ever is, it needs a hook in `GL.StreamFlush` first.
- **Correction: the clock.** The plan said client time stops while the game is paused and starts over with a new
  connection. It does neither: `CL.PredictMove()` sets it to `Host.realtime - latency` every frame and the latency field
  is always 0. So `'client'` and `'real'` run at the same speed today (pause does not stop either, which the browser check
  confirmed). The option stays as the seam for a game clock that someone makes later, the playback still restarts when its
  clock goes backwards, and the docs say what is true now.
- **Tests added** (2936 in all, ESLint and typecheck clean): `sprite-playback` (21: both ways to play, pause and resume,
  speed, duration and finished, a clock that goes backwards, size), `sprite-assets` (15: one asset for two handles and
  overlapping loads, the clocks, the settings file and `sidecar: false`, missing and non-sprite files including a model
  of another kind, no trace in `Mod`, survives `ClearAll()`, freed on `gl.shutdown`), `draw-sprite` (15 with the
  recording context: quad and uv, region on a padded layer, blend function switched and put back around the draw, uniforms,
  crossfade and `r_interpolation`, no texture), regions in `sprite-sidecar`, `aseprite-file` and `image-sprite-loader`,
  `pixelWidth` in the SPR test. The recording context knows `TRIANGLES` (logged as `4`) and `ARRAY_BUFFER` now.
- **Browser check** (Chromium on software GL, the production build in a scratch folder, a dedicated server on a spare
  port, test files generated with Pillow and served over the game directory): on `start`, an APNG spinner (three
  playbacks of one file: normal, at a quarter speed, half transparent on the real clock; the first two changed
  between screenshots 450 ms apart, and kept changing while the game was paused), a nearest-filtered sheet with five regions (the cells came out with
  the right bars, a blue cell tinted (1, 0.5, 0.5) went from (0, 128, 255) to (0, 64, 128), a white cell tinted
  (1, 0.5, 0) to (255, 128, 0)), an additive glow over a gray panel (center (255, 193, 105) over (76, 76, 76)) and a tinted
  half-alpha one, a red alpha vignette over the whole screen, and a 50% white rectangle drawn after all of them over black
  (127, so straight alpha is back). `gl.getError()` was 0, an unknown region threw the `RangeError` with its message.
  The same page put the explosion SPR, an additive image sprite and the APNG into the world as client entities: all drew
  as before. Not checked: Firefox, Safari, pointer lock (not involved), a real HUD in a game (no game code uses it yet).
- **Docs:** `docs/sprites.md` has the `regions` row, the Aseprite slices bullet and the section "On the screen: HUD
  elements and screen effects" (what a screen sprite ignores, the clock, the lifetime, the missing batching);
  `docs/game-module-contract.md`, `docs/shader-chunks.md` (the chunk), the README bullet.
- **Not built (as decided):** a `hud.txt` reader, a menu-space wrapper, animated decals, the post-process `sprite` effect.

## Open questions

- **Half-Life sprites need a real file** to confirm the meaning of `texFormat` and of index-alpha colors.
- **Luminance alpha.** Not built, see above.
- **Black to alpha (Phase 4), shape of the setting (settled, see Phase 4).** My proposal for the sidecar, to settle when Phase 4 starts:
  `"blend": "additive"` for fire and glow (black adds nothing, no key needed); for an alpha-blended sprite with a
  black background `"colorKey": { "color": [0, 0, 0], "tolerance": 16 }` that makes matching pixels transparent
  (a hard key, fine for pixel art); and `"alphaFrom": "luminance"` that takes the alpha from the brightness of the
  pixel and keeps its color (soft, for smoke and glow drawn on black). Do you want all three, or does `additive`
  plus the key cover it? The two that came out of Phase 0 were settled by the maintainer on 2026-10-23 (Status).
- **The G forks (2D API shape, screen effects, clock, scope)** were settled on 2026-10-23, see "Decisions for Phase 8".

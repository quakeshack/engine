# Sprite rotations: pick a sprite's picture by the angle it is seen from (Doom style)

**Status:** ✅ Phase 1 done (2026-10-24) and ✅ Phase 2 done (2026-10-24), see "What actually shipped". Phase 3 (the
converter) waits for a go-ahead. Mirroring was dropped from the engine (decision 4): the converter writes every view.
Phases 1 and 2 are committed on `feature/animated-image-sprites` as one commit, and hellwave's demon ("A first
monster") inside hellwave. Left out on purpose: hellwave's first wave spawning only the demon and id1's flames and
explosions drawn from GIFs, both local experiments that need files no game ships.

**⏸ Parked (2026-10-24, maintainer's decision)** after Phase 2, together with
[animated-image-sprites.md](animated-image-sprites.md). Phase 3 (the converter) is not started; `monster_doom_demon`
stays behind `hw_doom_monsters` (default 0) until it exists, because its files come from a throwaway script nobody
committed. Not checked: the demon's sounds (they load, but the browser runs were headless), and any browser but
Chromium. `docs/sprites.md` says that no converter ships yet and lists what has not been tested.

## Context

A Doom monster is drawn from a set of pictures per animation step: 8 *rotations* (16 in some
source ports), one for each direction the viewer can see it from. Doom's lump names say which
rotation a picture is and that some are mirrored: `SARGA1` is step A seen from the front,
`SARGA2A8` serves rotation 2 as it is and rotation 8 flipped, `SARGI0` (rotation 0) is one picture
for every direction (the death frames). The renderer picks the rotation from the angle between
the thing's facing and the direction it is seen from (`R_ProjectSprite` in `r_things.c`; how that
math works is quoted from memory, so Phase 1 checks it against the Doom source, see Testing).

The image sprites of [animated-image-sprites.md](animated-image-sprites.md) cannot do this today:

- **One picture per moment.** An entity's `frame` selects a `SpriteFrame`
  (`source/engine/common/model/sprite/SpriteTypes.ts`), a picture or a `SpriteSequence`, and
  `SpriteAnimator.sample()` returns one `SpriteImage` for a time. Nothing in the chain knows where
  the viewer stands relative to the entity's facing.
- **The orientations are about the quad, not the picture.** `SpriteModelRenderer.#setBasis()`
  turns the quad (`parallelUpright`, `facingUpright`, ...); none of them changes the image.
- **It cannot be done from outside the renderer.** The angle depends on the viewer, so in
  multiplayer each client needs a different picture of the same entity: it cannot be `frame` or
  `modelindex`, which the server sends to everyone. Client-only entities could swap models, but
  a model swap restarts the animation and costs one precache slot per direction.

What already fits:

- **Per-image origins.** `SpriteImage.origin` is per image, so Doom's per-lump offsets fit once a
  converter (or an Aseprite slice pivot) supplies them.
- **Angles reach the client.** Entities carry `angles` (`ClientEdict.angles`, interpolated), which
  the `oriented` orientation already reads. The yaw is all a rotation needs, so the protocol does
  not change.
- **One timeline per sequence.** `SpriteAnimator` works on `endTimes` and an image count. If every
  rotation of a sequence has the same number of steps and the same timing, the animator stays as
  it is and the rotation only decides *which* image of that step is drawn. Doom works the same
  way: the state machine picks the frame letter, the renderer picks the rotation.
- **The server needs nothing new.** Bounds come from `#placeImages()` over every image of the file.
  `GetSpriteSequenceDuration` and
  `GetSpriteSequenceIndex` keep their meaning, because rotations share the timing.

## Goals

- A sequence in the settings file can have **rotations**: N views of the same steps, one of which
  is drawn depending on where the camera is relative to the entity's yaw.
- Rotated and unrotated sequences mix in one file (Doom's walk has 8 rotations, its death has 1).
- Game code does not change: `frame`, `angles`, `GetSpriteSequenceIndex` and
  `GetSpriteSequenceDuration` work as before.
- Crossfading (`interpolate`) stays within the view that is showing.

## Non-goals (this pass)

- Reading Doom WADs in the engine's loaders (lump format, `PLAYPAL`, `S_START`/`S_END`). Getting
  Doom art in is the converter's job (G), done once before the game runs.
- Smoothing the switch from one rotation to the next. Doom snaps, and so does this.
- Rotations for Quake and Half-Life `.spr` files: their formats have no such concept.
- Pitch-dependent views (seeing a thing from above). Doom has none.
- Mirroring at draw time (Doom's `A2A8` lumps drawn flipped for the other side). Every view is an image of its own;
  the converter writes the mirrored ones (decision 4).
- Changes to id1 or hellwave. Neither uses rotated sprites. A game that wants them only adds the
  setting.

## Design

### A. Data model: views of a sequence

`SpriteSequence` gets a list of views. Each view holds the same number of images as the others:

```ts
export interface SpriteSequence {
  readonly name: string;
  /** The images of the first view (the front), the same array as `views[0]`. */
  readonly images: readonly SpriteImage[];
  /** One list of images per rotation, counterclockwise from the front; a single entry for a sequence without rotations. */
  readonly views: ReadonlyArray<readonly SpriteImage[]>;
  readonly endTimes: Float32Array;
  readonly direction: SpriteDirection;
  readonly repeat: number;
}
```

`images` stays, so `SpriteAnimator`, `SpritePlayback` and every caller that knows nothing about
rotations keep working unchanged. They see the front view. A sequence without rotations has
`views = [images]`, so the renderer runs the same code for both.

A still image with rotations becomes a sequence of one step, because only a sequence has views.

### B. The settings file

The setting is per sequence, because rotations differ per sequence (Doom's death frames have
none):

```json
{
  "filter": "nearest",
  "orientation": "parallelUpright",
  "lit": true,
  "sequences": [
    { "name": "walk",  "from": 0,  "to": 31, "rotations": 8 },
    { "name": "death", "from": 32, "to": 37 }
  ]
}
```

- `rotations`: a whole number of 1 or more, default 1. Typical values are 8 and 16.
- **Image layout within `from`..`to`** is **rotation-major** (decision 1): the range splits into equal blocks, one per view, each holding the steps of that view in
  order. With `"rotations": 8` and 4 steps, the 32 images are front ×4, view 1 ×4, ..., view 7 ×4. A range that does not split evenly is reported on the console, and
  the sequence loads without rotations, in the spirit of the sidecar's "report and go on".
- The per-sequence `fps` and the file's per-image durations: the **front view's** durations are
  the timeline. If the other views have different delays, the console reports it once.
- `SpriteSidecars.#readSequences` learns the key (`SEQUENCE_SETTINGS`), `SpriteSidecarSequence`
  gets `rotations: number | null`, and
  `ImageSpriteLoader.#buildNamedSequence` builds the views.

### C. Aseprite tags

An Aseprite tag has no "rotations" field. In this pass an Aseprite file gets rotations **only
through a sidecar `sequences` list** (decision 2), which already replaces the tags. The artist's tags stay useful in the editor, and the sidecar repeats their ranges. A tag
convention (`walk@8`, or the tag's user data) is a later convenience once someone uses it.

### D. Choosing the view

A pure static method in `source/engine/common/model/sprite/SpriteAnimator.ts`, or a small
`SpriteViews` class next to it, so the server tests and the renderer share it:

```ts
/**
 * @param count Number of views of the sequence.
 * @param yaw The entity's yaw in degrees.
 * @param toViewerX, toViewerY Direction from the entity to the viewer, in the horizontal plane.
 * @returns The view, 0 for the front, counting counterclockwise as seen from above.
 */
static viewIndex(count: number, yaw: number, toViewerX: number, toViewerY: number): number
```

`angle = atan2(toViewerY, toViewerX) - yaw`, normalized to [0, 360), then
`Math.floor(angle / (360 / count) + 0.5) % count`, so view 0 covers ±(180 / count)° around the
front. Quake's and Doom's yaw both count counterclockwise from east, so the conversion is direct,
and view k is the viewer k × 360/N degrees counterclockwise around the entity. Which side Doom's
rotation 2 shows is checked in Phase 1 against the Doom source and a real lump (Testing). If the
recalled convention is mirrored, the fix is the sign here, not the file layout.

The viewer is `Camera.refdef.vieworg`, as `facingUpright` uses it.

### E. Renderer

`SpriteModelRenderer.#selectImage` computes the view only when `frame.views.length > 1` (one
`atan2` per rotated sprite per frame), and `SpriteAnimator.sample()` takes the view index:

```ts
static sample(frame: SpriteFrame, time: number, interpolate: boolean, out: SpriteSample, view = 0): void
```

The animator picks the image index as before, then reads `frame.views[view][index]` and, when
interpolating, the next layer from the same view. The view can change between two steps: the
crossfade then fades from the new view's image into the new view's next image, so nothing blends
across views.

No geometry or shader changes.

Rotations make sense with `parallelUpright` (Doom's look) and `facingUpright`. With the other
orientations they still work but look odd. The docs say so, and the code does not forbid it.

### F. The screen (`LoadSprite` / `DrawSprite`)

A playback shows the front view by default. `SpritePlayback` gets a `view` property (a whole
number, wrapping around in both directions, so `view += 1` turns the monster on and on) so a menu
or a HUD can show a monster turning. `sample()` passes it to `SpriteAnimator.sample()`, and a
sequence without rotations ignores it. Changing the view does not restart the sequence, as in the
world. `width` and `height` (for placing the element) are the ones of the view that is showing.

### G. Getting Doom art in

**A converter script in `scripts/`, not a loader** (decision 3). It reads a WAD's sprite
lumps for one prefix (`SARG`), the `PLAYPAL` palette and each lump's offsets. It pads every picture
onto one canvas aligned at the offsets (so `origin` is one value for the whole file). It sorts
the lumps into the rotation-major layout, writes both sides of an `A2A8` pair (the second flipped in place
inside the lump's rectangle, as Doom draws it), and writes an
APNG with the Doom tic timing and the sidecar. The state table, which frames form "walk", "attack"
and so on, lives in Doom's code, not in the WAD, so the script takes the grouping as an argument or
a small preset per monster. It is a Node script (`scripts/doom-sprites/`, run with `tsx`) that
needs no browser: the APNG writer is a few chunks around `zlib.deflateSync`. Its tests run in
`npm test`, and a deeper test directory means checking the globs (`test/common/test-globs.test.ts`).

**Its first user** is hellwave's `monster_doom_demon` (2026-10-24, see "A first monster" below). The demon preset has
to write what that entity reads: the sequences `idle` (A B), `walk` (A–D), `attack` (E–G), `pain` (H), all with 8
rotations, then `death` (I–N, once) and `dead` (N), in that order, each image timed by its Doom tics; the origin
24 units above Doom's (a Quake monster's origin is 24 above its feet); and the sounds as 8-bit WAV under `sound/doom/`
(Doom's DMX lumps, format 3, minus 16 pad samples at each end). A throwaway script in that session did exactly this
and is the starting point.

## Phasing

1. **Rotations.** Data model (A), sidecar keys `rotations` without `mirror` (B), view choice (D),
   renderer (E). Tests for the sidecar, the loader's layout, `viewIndex` and `sample` with views.
   Browser pass with a generated test sprite (each view a digit and a color) on a client entity
   that turns. Docs. Checks the angle convention against Doom.
2. **The screen.** `SpritePlayback.view` (F). Tests and a browser pass of a rotated sprite turning on
   the screen. (Was "Mirroring and the screen"; mirroring went to the converter, decision 4.)
3. **Doom conversion** (G), the converter in `scripts/`. A converted pinky (or Freedoom's equivalent, see Testing)
   walking around in a map with `lit`, checked against Doom's look.

Each phase is usable alone: Phase 1 with any file that stores all its views, Phase 2 adds the
screen, Phase 3 makes the files from Doom's.

## Documentation

- `docs/sprites.md`: Phase 1 adds a section "Rotations (Doom-style sprites)": what a view is, the
  layout of a range, which orientation to use, and a pinky-like example. Phase 1 also adds
  `rotations` to the `sequences` row of the settings table. Phase 2 adds the
  playback's `view`, and Phase 3 adds a "Making the files" paragraph on the converter.
- `docs/README.md`: the Sprites line mentions rotations (Phase 1).
- `README.md`: the "Modern Sprites" feature line gets "Doom-style rotations" (Phase 1).
- JSDoc: `SpriteSequence.views`, `SpriteAnimator.sample`'s `view`,
  `viewIndex`, `SpritePlayback.view` (with the phase that adds each).
- `plans/animated-image-sprites.md`: a one-line pointer to this plan (Phase 1).
- No event changes, so `docs/events.md` is untouched. No game docs are touched.

## Testing

- `test/common/sprite-sidecar.test.ts`: `rotations` parses, bad values are reported and left out.
- `test/common/image-sprite-loader.test.ts`: a range of 8 × 4 images becomes 8 views of 4 steps in
  rotation-major order. An uneven range falls back with a warning. A mixed file keeps its
  unrotated sequences as they were. Bounds do not change.
- `test/common/sprite-animator.test.ts`: `viewIndex` at the centers and the edges of each sector, the
  wrap at 360°, 8 and 16 views, any yaw. `sample` with a view picks that view's image, and its
  crossfade stays in the view.
- `test/renderer/`: a rotated sprite streams the layer of the view the camera sees (the recording GL
  context the sprite tests already use). `SpritePlayback.view` picks the view on the screen, wraps,
  and does not restart the sequence.
- **Doom's convention**: the angle math is recalled, not read, and `LLM.md` says not to trust such
  recollection. Phase 1 reads `R_ProjectSprite` in the released Doom source (linuxdoom-1.10,
  `r_things.c`) and records here which way the rotations count. The browser pass then shows that
  Freedoom's replacement for `SARG` (same lump names, free art) looks the same from the same side
  as in a Doom source port.
- **Browser** (`browser-ui-verification`): orbit a turning, rotated sprite and check each view
  appears in its sector, that it does not flicker at the sector edges any more than Doom does, that
  the converter's mirrored views face the right way, and that `interpolate` does not blend views. All three phases
  need this pass.
- The converter's tests build a tiny WAD inside the test instead of checking one in, so there is no
  fixture for `dockerfile-fixture-sync`. The Dockerfile's `test` stage must still `COPY` the new
  `scripts/doom-sprites/` directory if the tests import it (check in Phase 3).

## Decisions (2026-10-24)

1. **Image layout of a rotated range: rotation-major.** Each view is a block of the steps. Rejected:
   step-major (Doom's lump order, awkward to animate by hand; the converter reorders instead) and an
   explicit list of ranges per view (flexible, but verbose and easy to get wrong).
2. **Aseprite: rotations only through the sidecar's `sequences`.** A tag naming convention
   (`walk@8`) or the tag's user data can come later if someone authors rotated sprites in Aseprite.
3. **Doom art: a converter script in `scripts/`.** Rejected: the same script in `qs-tools` (outside
   the engine's tests), a WAD sprite loader in the engine (lump format, palette, and the grouping
   that only Doom's state table knows), and a docs-only recipe.
4. **Mirroring: none at draw time, the converter writes every view (option c, 2026-10-24).** Exact, and simple in
   the engine; costs 3 extra layers per step for 8 rotations (the pinky's walk: 32 layers instead of 20). See the
   note on option (a) under Open questions for the memory saving that stays possible.

### What actually shipped in Phase 1

- **Doom's convention, read from the source** (`DOOM/linuxdoom-1.10/r_things.c`, `R_ProjectSprite`):
  `rot = (ang - thing->angle + (ANG45 / 2) * 9) >> 29`, with `ang` the angle from the viewer to the thing
  (`R_PointToAngle`). With φ the angle from the thing to the viewer that is `floor((φ - yaw + 22.5°) / 45°) mod 8`,
  which is the formula of D: view k (Doom's rotation k + 1) is the viewer k × 45° counterclockwise from the facing,
  and on a sector edge the later view wins (the `>> 29` is a floor). `R_InstallSpriteLump` confirms that `A2A8`
  serves rotation 2 as it is and rotation 8 flipped.
- **Data model (A)**: `SpriteSequence.views`, with `images === views[0]`. SPR sequences and the default sequence of a
  file get `views: [images]`. (`SpriteImage.mirrored` was planned for Phase 2 and dropped, decision 4.)
- **View choice (D)** is `SpriteAnimator.viewIndex(count, yaw, toViewerX, toViewerY)`, a static method next to the
  timing code instead of a new class (one method). `SpriteAnimator.sample()` takes the view as an optional last
  parameter (default 0), so `SpritePlayback` and its 2D drawing are unchanged and show the front.
- **Renderer (E)**: `SpriteModelRenderer.#selectImage` computes the view only for a sequence with more than one
  view, from `entity.angles[1]` and `Camera.refdef.vieworg`. No shader or geometry change.
- **Sidecar (B)**: `rotations` per sequence (whole number from 1). `ImageSpriteLoader.#buildNamedSequence` splits
  the range rotation-major. A range that does not split evenly falls back to one view, with a console message. Views
  timed differently play with the front's timing, with a console message (not when a sequence `fps` times them all).
  Aseprite tags get `rotations: null` (decision 2).
- **Tests**: `test/common/sprite-sidecar.test.ts` (parse, bad values), `test/common/image-sprite-loader.test.ts`
  ("ImageSpriteLoader, rotations": layout, mixed sequences, uneven range, timing, bounds),
  `test/common/sprite-animator.test.ts` (`viewIndex` sectors, edges, yaw ranges, 4/8/16 views; `sample` in a view,
  crossfade within the view), and a new `test/renderer/sprite-model-renderer.test.ts` that draws through the real
  renderer with a recording GL context and checks the streamed layer for camera positions and yaws. `npm test`
  (2959 tests), `npm run typecheck` and ESLint clean.
- **Browser** (Chromium with SwiftShader, the running watch build and dedicated server on `start`): the pinky
  (`SARG`) from `resources/doom1.wad` was turned into an Aseprite file plus sidecar by a throwaway script (not
  committed; it writes the mirrored rotations as images of their own, as the converter will, decision 4) and placed as client entities in front
  of the camera. A row of eight, each turned 45° further, shows views 0 to 7 in order: face, the turning sides,
  the back, and rotations 2 and 8 as mirror images of each other. One pinky turned to four yaws shows the front,
  a side facing screen-left (yaw west), the back and a side facing screen-right. Switching `frame` to `death` plays
  it once and holds the corpse. `lit` darkens it with the room. The 404s in the console (`gfx/conback.png`,
  `gfx/concharslarge.png`, `progs/beam.mdl`) are optional assets of that game data, unrelated.
- **Docs**: `docs/sprites.md` (section "Rotations: Doom-style sprites", `rotations` in the `sequences` row),
  `docs/README.md` and `README.md` (feature lines), a pointer in `plans/animated-image-sprites.md`.

### What actually shipped in Phase 2

- **Decision 4 first**: no mirroring at draw time (option c); option (a) is kept as a note under Open questions. A, B,
  D, E, G, the phasing, the docs and the tests above were rewritten to match: no `mirror` key, no
  `SpriteImage.mirrored`, no `u` swap.
- **`SpritePlayback.view`** (F): a getter and setter. The setter takes any whole number and throws a `RangeError`
  otherwise, like `speed`. The getter returns the number as it was set; `#viewOf()` wraps it around the views of the
  sequence that is showing when it samples, so `view += 1` keeps turning, a negative view works, one value serves
  sequences with different counts of views, and a sequence without rotations ignores it. `width` and `height` are
  those of the view that is showing. The view stays when another sequence plays and does not restart the sequence.
  `ClientEngineAPI.DrawSprite` needed no change, `Draw.Sprite` draws what `sample()` gives it.
- **Tests**: `test/renderer/sprite-playback.test.ts` ("view": the front by default, the view at the step that is
  playing, wrapping both ways, no restart, a sequence without rotations, whole numbers only) and
  `test/renderer/draw-sprite.test.ts` (a turned playback streams the layer of its view). `npm test` (2966),
  `npm run typecheck` and ESLint clean.
- **Browser**: the running watch build had stopped rebuilding (its bundle was from before the change), so the check
  used a scratch development build served by a throwaway static server that forwards `/qfs` to the running
  dedicated server (`docs/browser-verification.md` section 8). With the Phase 1 test pinky, `SpriteAssets.Load()`
  playbacks drawn by `Draw.Sprite()` from a wrapped `gameAPI.draw()`: eight on the screen at views 0 to 7 show the
  same order as the world row of Phase 1; one playback set to 0..7, 8 and −1 turns through the views, 8 shows the
  front and −1 view 7, and the walk keeps stepping between the screenshots. The console showed only the three
  unrelated 404s of Phase 1.
- **Docs**: `docs/sprites.md` (the playback's `view` in the member table; the rotations section says every view is an
  image of its own and points to `view` for the screen).

### A first monster (2026-10-24, outside the phases)

On request, hellwave got Doom's demon as `monster_doom_demon` (`source/game/hellwave/entity/DoomMonsters.ts`) to
try the rotations in a game:

- **States map onto sprite sequences by number** (`DoomDemonSequence`), no model QC: id1's `_runState` takes a
  numeric keyframe. Every state of one behavior sets the same sequence, so the sprite plays Doom's tic timing by
  itself while the 0.1-second state machine does the AI. Doom's timing is rounded to steps: the bite 0.5 s into a
  0.7 s attack (Doom: 16 of 24 tics), the scream at 0.2 s, not solid from 0.6 s, the corpse at 0.8 s (Doom: 8, 20,
  28 tics). Health 150, pain chance 180/256, bite 4–40 in steps of 4, the growl about every 5 seconds, no gibbed
  death, Quake's large hull.
- **The bite reaches 120 units**, Quake's melee range that starts the attack, as Doom checks the same reach at the
  start and at the bite. A first try with the dog's 100 missed every bite after the first, which pushes the player
  back to 106 units (seen in the browser).
- **Gated by `hw_doom_monsters`** (default 0): hellwave precaches every `monster_*` class at map start, and the files
  are not shipped, so a map without them would fail to load.
- **A hellwave bug it found**: hellwave's `Init` called id1's `Init`, which readies only id1's registry, so no class
  hellwave adds had its `_initStates()` run. The existing hellwave monsters inherit id1's states and never noticed;
  the demon stood still. Hellwave's `Init` now readies its own registry too (test in `hellwave-game-api.test.ts`).
- **Tests**: `source/game/hellwave/test/hellwave-doom-monsters.test.ts` (registration, the state graph and its timing,
  the bite's damage and reach, removal without the cvar, precache with and without it). `npm test` 2977, typecheck and
  ESLint clean.
- **Browser** (hellwave build with `?serverthread`, `hw_doom` map, a second instance of the dedicated build serving
  the hellwave files): a demon spawned 360 units away comes through the door and runs at the player, the front view
  facing the camera; spawned at 90 units it bites the player from 100 down to 4 health in steps that are multiples
  of 4, flinches when hit, plays its death and lies as a corpse that no longer blocks. The sprite, its settings file
  and the five sounds load (HTTP 200); that the sounds play was not heard (headless). Hellwave's map load needed
  `gfx/explosion1.gif`, which only `data/id1` has (asked for by uncommitted changes to id1's `Weapons.ts`); the check
  served that one file from a scratch folder.

## Open questions

- **Later: mirroring at draw time the way Doom does it (option a of decision 4).** Doom does not mirror a picture
  around the thing: a flipped lump keeps its rectangle (`tx -= spriteoffset[lump]` is the same for both, only the
  columns run backwards from `startfrac = width - 1`). Mirroring around the entity's origin instead (option b,
  `origin[0]` → `-(width + origin[0])`) agrees only where `leftoffset` is half the width. For the pinky in
  `doom1.wad` the difference (`2 × leftoffset − width`) is −6 to +14 pixels across its 12 mirrored lumps
  (`SARGD4D6`: 14), enough to make the walk jitter sideways, so (b) was rejected. Doom's in-place flip is cheap at
  draw time (swap the `u` coordinates, keep the origin), but only when each picture has its own rectangle: a file
  whose images share one canvas (how the converter aligns the lumps) is one layer per image, and flipping that layer
  flips around the canvas, not around the lump. What (a) would take: per-image sizes and origins from the file
  (today only Quake/Half-Life `.spr` pad their images into a layer with a per-image `uvScale`; an image file's
  frames all have the canvas size, and only an Aseprite slice pivot gives a per-image origin), `SpriteImage.mirrored`,
  the `u` swap in `SpriteModelRenderer.#emitQuad` and in `Draw.Sprite`, and a sidecar `mirror` key telling the
  loader which views to derive. Worth it only when sprite memory becomes the limit: it saves 3 of 8 layers per step.

# Sprites: Images as Models

A sprite is a flat picture or animation that is placed in the world as an entity and turns towards the viewer. Besides
Quake's `.spr` files (and Half-Life's) the engine takes GIF, PNG/APNG, WebP and Aseprite files directly, and an optional
settings file next to the image changes how it is drawn. No other game code is needed:

```ts
static precache(engine: ServerEngineAPI): void {
  engine.PrecacheModel('gfx/torch-flame.gif');
}

spawn(): void {
  this.setModel('gfx/torch-flame.gif'); // loops, nothing else to do
}
```

The same works for client-only entities (`ClientEngineAPI.ModForName`, see [Client Entities](client-entities.md)), and the
same files can be drawn on the screen as HUD elements and screen effects, see [On the screen](#on-the-screen-hud-elements-and-screen-effects).

## Which format

| Format | Alpha | Colors | Size | Notes |
| :--- | :--- | :--- | :--- | :--- |
| GIF | on or off | 256 per frame | big | Decoded by the engine, looks the same in every browser. Drawn alpha tested. |
| APNG (`.png`, `.apng`) | 8 bit | true color | medium, lossless | Decoded by the engine. The house format. A plain PNG is a one-image sprite. |
| Aseprite (`.aseprite`, `.ase`) | 8 bit | true color, indexed, grayscale | small | The pixel art standard. An artist's file drops in without an export: its tags become named sequences and a slice's pivot becomes the origin, see below. |
| WebP | 8 bit | true color | small | Animated files need `ImageDecoder` (WebCodecs: Chromium 94+, Firefox 133+ on the desktop); without it only the first image is shown, with a console warning. |

Without a settings file an image is drawn at one pixel per world unit, around its center, as a billboard that
starts playing when the entity gets the model. Animated files play as one sequence over all images, as often as the
file says: a GIF with a loop count of N plays N + 1 times, a GIF without one plays once, APNG and WebP play exactly their
count, and a count of 0 means forever. The delays are the file's, except that 10 ms or less plays as 100 ms, as in a browser.

## Settings: `<file>.json`

`gfx/torch-flame.gif` reads `gfx/torch-flame.gif.json` when it exists. Every setting is optional, and the server reads the
file too (the scale decides the bounds). A broken file, a wrong value or a setting nobody knows is reported on the console
(a typo shows up as `unknown setting "scal"`) and left out; the sprite still loads.

```json
{
  "version": 1,
  "scale": 0.08,
  "origin": [218, 498],
  "blend": "additive",
  "colorKey": { "color": [0, 0, 0], "tolerance": 16 },
  "filter": "nearest",
  "orientation": "parallelUpright",
  "phase": "random",
  "fps": 12,
  "repeat": 0,
  "interpolate": true,
  "lit": true,
  "regions": { "number_0": [0, 0, 20, 24], "number_1": [20, 0, 12, 24] },
  "sequences": [
    { "name": "idle", "from": 0, "to": 7, "direction": "pingpong" },
    { "name": "burst", "from": 8, "to": 15, "repeat": 1, "fps": 24 }
  ]
}
```

| Setting | Values | Default | What it does |
| :--- | :--- | :--- | :--- |
| `version` | `1` | `1` | For later changes of the format. |
| `scale` | number above 0 | `1` | World units per pixel. A 437 x 498 flame at `0.08` is about 35 x 40 units. The bounds scale with it. |
| `origin` | `[x, y]` pixels | the center | The pixel that sits on the entity's origin, counted from the top left corner of the image. `[width / 2, height]` puts the entity at the bottom center, like a flame on a torch. See [Placing the origin](#placing-the-origin). |
| `blend` | `alphaTest`, `alpha`, `additive` | `alphaTest` for GIF, `alpha` for the rest | `alphaTest` drops pixels below a quarter alpha and draws the rest. `alpha` blends. `additive` adds the color to what is behind, so black adds nothing (fire, glow, sparks). All three use premultiplied alpha, so edges do not get dark fringes. |
| `colorKey` | `{ "color": [r, g, b], "tolerance": 0 to 255 }` | none | Makes pixels of that color transparent, in every frame. The edge is hard (a pixel is in or out); for an image with a black background that should blend, `additive` is the soft solution. A GIF's "black" is often not quite black (a flame GIF measured `(4, 2, 4)`), and an additive sprite then shows a faint box; key that color out as well, for example `"blend": "additive", "colorKey": { "color": [0, 0, 0], "tolerance": 16 }`. |
| `filter` | `linear`, `nearest` | follows `gl_texturemode` | `nearest` keeps hard pixels for pixel art, `linear` is smooth with mip levels. |
| `orientation` | `parallel`, `parallelUpright`, `facingUpright`, `oriented`, `parallelOriented` | `parallel` | `parallel` faces the view plane. `parallelUpright` stays upright around the world's Z axis and keeps the view's right vector. `facingUpright` stays upright and faces the viewer's position. `oriented` uses the entity's own angles. `parallelOriented` faces the view and rolls with the entity's roll angle. |
| `phase` | `spawn`, `global`, `random` | `spawn` | Which clock a sequence follows: `spawn` starts when the entity gets the model or a new `frame`, `global` is the same time for every instance, `random` starts each entity at its own random point of the loop (also for map decorations made static, like torches). |
| `fps` | number above 0 | the file's timing | Frames per second for every image, replacing the delays of the file (also below the 10 ms limit). |
| `repeat` | whole number, 0 = forever | the file's | How often the whole animation plays. A finished sequence holds its last image. |
| `interpolate` | `true`, `false` | `false` | Crossfades from an image to the next. Needs `r_interpolation 1`, which is the default. |
| `lit` | `true`, `false` | `false` | Shades the sprite with the light of the map at its origin plus the dynamic lights that reach it (a flat sprite has no surface direction, so this is its brightness only, never above the texture's own). Right for smoke, dust and puffs that should darken in a dark room; leave it off for fire, glow and sparks. A lit sprite is drawn on its own, it does not batch with its neighbors. |
| `regions` | `{ "name": [x, y, width, height] }`, pixels | none | Named rectangles of the image, counted from its top left corner, for drawing a part of a sprite sheet on the screen (`region` of `DrawSprite`). An Aseprite file's slices are regions as well; the settings file wins on a name clash. A region that reaches outside the image is left out with a console message. It does nothing for a sprite in the world. |
| `sequences` | list of `{ name, from, to, direction, repeat, fps, rotations }` | one sequence over all images | Each entry becomes one `frame` of the entity, in order, so `this.frame = 1` plays the second. `from` and `to` (both included) default to the first and last image, `direction` to `forward` (`reverse`, `pingpong` and `pingpongReverse` exist), `repeat` and `fps` to the settings above. `rotations` (a whole number, default 1) makes the sequence look different from each side, see [Rotations](#rotations-doom-style-sprites). |

How a sequence ends: `forward` holds its last image, `reverse` its first. A `pingpong` goes to the far end and back without
showing either end image twice in a row, and holds the image it started with.

### Placing the origin

`origin` pins one pixel of the image to the entity's origin, and a billboard turns around the vertical line through that
pixel. With `s` for `scale`, the picture reaches `originX · s` to the left and `(width − originX) · s` to the right,
`originY · s` up and `(height − originY) · s` down. The bounds follow from the same numbers.

To stand the picture on something `d` units below the entity's origin, find the column it is centered on and the row its
base is on (the lowest row of the visible picture, not of the image), then:

```
originX = center column
originY = base row − d / s
```

`d` comes from where maps put the entity, not from the image. A mapper places a point entity by its editor box, so one with
the box `(-8 -8 -8) (8 8 8)` resting on the floor has its origin 8 units up (`d = 8`). A sprite that replaces a model keeps
the model's offset; for example, Quake's small flame (`progs/flame2.mdl`, frame 0) reaches 12 units below its origin, so a
replacement uses `d = 12` to sit in the same braziers. A 500 x 500 flame centered on column 253 with its base on row 465
then gets `originY = 465 − 12 / 0.125 = 369` at `scale` 0.125, so `"origin": [253, 369]`. A new `scale` changes `d / s`,
so work out `originY` again.

A wrong `originX` does not just shift the picture. It makes the picture swing around the entity as the viewer walks around it.

## Effects that remove themselves

An explosion or a puff plays once and goes away. The settings file (or the file itself) says it plays once, and the game asks
how long that takes:

```ts
// gfx/explosion.apng.json: { "repeat": 1, "blend": "additive", "scale": 0.5 }
static precache(engine: ServerEngineAPI): void {
  engine.PrecacheModel('gfx/explosion.apng');
}

explode(): void {
  this.setModel('gfx/explosion.apng');
  this._scheduleThink(this.game.time + this.engine.GetSpriteSequenceDuration('gfx/explosion.apng', 0), function (this: ExplosionEntity) {
    this.remove();
  });
}
```

Both engine APIs have the two queries. They need the model to be precached (and, on the server, to have finished loading, so
ask while the map runs, not while it loads), and throw if it is not:

| Query | Answer |
| :--- | :--- |
| `GetSpriteSequenceDuration(modelName, frame = 0)` | Seconds the sequence that `frame` selects plays, counting its repeats. `Infinity` for a sequence that repeats forever, 0 for a still image and for a model that is no sprite. A `frame` out of range selects the first, as drawing does. |
| `GetSpriteSequenceIndex(modelName, name)` | The `frame` of the sequence the settings file named `name`, -1 for none, an empty name or a model that is no sprite. |

Naming sequences keeps a game independent of their order in the file:

```ts
this.frame = this.engine.GetSpriteSequenceIndex('gfx/imp.gif', 'burst');
```

Changing `frame` restarts a sprite that follows its entity's own clock (`phase: spawn`); setting the frame it already has
does not, so a server repeating it every update leaves a running animation alone.

## Rotations: Doom-style sprites

A monster drawn as a sprite needs a picture for each side it can be seen from, the way Doom draws its monsters with 8
rotations. A sequence with `rotations` has that many *views* of the same animation, and the angle between the entity's
yaw and the direction to the camera picks the view that is drawn:

```json
{
  "origin": [33, 59],
  "orientation": "parallelUpright",
  "filter": "nearest",
  "lit": true,
  "sequences": [
    { "name": "walk", "from": 0, "to": 31, "rotations": 8 },
    { "name": "death", "from": 32, "to": 37, "repeat": 1 }
  ]
}
```

- **The images of a range are one block per view**, each block holding the steps of the animation in order: here
  images 0 to 3 are the four steps of the walk seen from the front, 4 to 7 the same steps seen from the next view, and
  so on. A range that does not split into blocks of the same length is reported on the console and drawn without
  rotations.
- **View 0 is the front**, seen while the camera stands in front of the entity. The views go on counterclockwise as
  seen from above: view k is drawn while the camera stands k × 360 / N degrees counterclockwise around the entity,
  and each view covers the same angle, centered on its direction. This is Doom's order (`R_ProjectSprite`): Doom's
  rotation 1 is view 0, its rotation 2 is view 1 and so on.
- **Every view plays on the same timeline.** The views share the timing of the front view (a console message says so
  if the file times them differently), so the walk does not restart or skip when the camera moves around the
  monster. A crossfade (`interpolate`) stays within one view.
- **Sequences with and without rotations mix**, like Doom's walk (8 rotations) and death (one picture for every side).
- **The game does nothing new.** The entity's yaw (`angles[1]`) and `frame` choose what is drawn, so
  `GetSpriteSequenceIndex` and `GetSpriteSequenceDuration` work as for any sequence.
- **Use `parallelUpright` or `facingUpright`**, which keep the sprite upright like Doom's. The other orientations
  work too, but turn the quad in ways that do not suit a picture of a side.
- **Every view is an image of its own.** The engine does not mirror one side to make the other: a picture that Doom
  draws flipped for the other side (its `A2A8` lumps) is in the file twice, the second time flipped.
- **On the screen** a playback shows the front view until its `view` is set, see the playback's members below.

## On the screen: HUD elements and screen effects

Any sprite file also draws in 2D, from a game's `draw()` (or `drawOverlay()`, which stays visible when `nohud` is set):
an animated HUD icon, a digit cut out of a sheet, a damage splatter over the whole screen.

```ts
// once, when the HUD is created
this.flame = await engine.LoadSprite('gfx/hud/flame.apng');
this.digits = await engine.LoadSprite('gfx/hud/digits.png'); // gfx/hud/digits.png.json has the regions

// every frame
engine.DrawSprite(16, 16, this.flame, { scale: 2 });
engine.DrawSprite(100, 16, this.digits, { region: 'seven', tint: [1, 0.8, 0.2] });
```

`LoadSprite(filename, options?)` takes the same files as `setModel()` (GIF, PNG/APNG, WebP, Aseprite, Half-Life and Quake
`.spr`), with their settings file, and returns a **`SpritePlayback`**, one handle per element on the screen. The images are
loaded once per file and shared; every call gives a playback of its own, so two flames from one file play independently.
It rejects when the file is missing or is no sprite. `options.sidecar: false` skips the settings file lookup, like the
precache hint above.

`DrawSprite(x, y, playback, options?)` draws what the playback shows now, with its top left corner at `x, y`, in the
screen coordinates `DrawPic` uses. Its size is the image's size in pixels times the settings file's `scale` times
`options.scale`.

| Option | What it does |
| :--- | :--- |
| `scale` | Multiplies the size, `1` by default. |
| `region` | Draws only the region of that name (see `regions` in the settings reference) of the image that is showing. The region's size replaces the image's. A name the sprite does not have throws a `RangeError` that lists the names it has. |
| `tint` | Red, green and blue from 0 to 1, multiplied with the colors. White by default. |
| `alpha` | Opacity from 0 to 1, `1` by default. |

The blend mode is the sprite's own (`blend` in its settings): `alpha` blends, `alphaTest` drops pixels below a quarter
alpha, `additive` adds the color to what is behind, so a glow or a flash brightens the world under it. `filter` and
`interpolate` (with `r_interpolation`) work as in the world. Cut regions out of a sheet with `"filter": "nearest"`,
or the smooth filter blends a pixel row of the neighboring cell in at the edge.

**The playback** starts the first sequence and plays it by itself:

| Member | |
| :--- | :--- |
| `play(sequence)` | Starts a sequence from its first image, by index or by name (a sidecar sequence, an Aseprite tag). Throws a `RangeError` for one the file does not have. |
| `pause()`, `resume()`, `paused` | Holds the image that is showing, and goes on from there. |
| `view` | The view of a sequence with [rotations](#rotations-doom-style-sprites) to show, 0 (the front) by default, counting counterclockwise. A whole number that wraps around, so `view += 1` keeps turning the sprite; changing it does not restart the sequence. A sequence without rotations ignores it. |
| `speed` | How fast it plays, `1` is the file's speed. Changing it keeps what has played. |
| `duration` | Seconds the sequence takes as far as its repeat count goes, with the speed counted in; `Infinity` for one that repeats forever, `0` for a single picture. |
| `finished` | The sequence has played as often as it repeats and holds its last image. A sequence that repeats forever never finishes. |
| `width`, `height` | The size of the image that is showing, for placing it. |

A one-shot effect on the screen plays a sequence that repeats once, and stops drawing when it is `finished`.

**A screen effect** is a sprite drawn over the whole screen from `draw()` or `drawOverlay()`: scale it so that its size
covers the viewport, give it `additive` for a flash or `alpha` for a splatter, and fade it with `alpha`. Like any overlay
it is not in a clean screenshot.

**The clock** of a playback is the client's game time, which the sprites in the world follow, unless `LoadSprite` is
given `{ clock: 'real' }` for the wall clock. Today both run at the same speed, and neither stops while the game is paused.

What a sprite on the screen ignores from its settings, because it has no place in the world: `orientation`, `phase`
(a playback starts when it is made and when `play()` is called), `lit` and `origin` (the top left corner is the anchor).

**Lifetime.** A loaded sprite lives for the page: it survives map changes and disconnects, and is not part of the model
cache or the precache list. Its textures are freed when the GL context goes away, and the playbacks made before that are
dead. Load the sprites of a HUD once, not per frame (a second load of a file that is loaded only makes a new playback).
Every `DrawSprite` is one draw call, there is no batching of neighbors yet.

## Making the files

Any tool that writes GIF, APNG or animated WebP works. With `ffmpeg` (the three commands below were tried with ffmpeg 8.0.1-3ubuntu2, on
small test inputs; a sprite is drawn at its pixel size times `scale`, so pick the size you want to keep):

```bash
# a video or a GIF to APNG, true color and 8 bit alpha, forever (-plays 0)
ffmpeg -i in.mp4 -vf "fps=12,scale=128:-1,format=rgba" -plays 0 out.apng

# a GIF to animated WebP (smaller, needs ImageDecoder in the browser)
ffmpeg -i in.gif -loop 0 out.webp

# a video to a GIF with a good palette
ffmpeg -i in.mp4 -vf "fps=12,scale=128:-1,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 out.gif
```

Frames of an animation that glows or burns are best made on a black background and drawn with `"blend": "additive"`, which
needs no transparency at all; a GIF's "black" is often a few levels off, see `colorKey` above. For pixel art draw at the size
the sprite has on screen and set `"filter": "nearest"`.

## Aseprite files

An `.aseprite` file is read as it is saved, no export step. What is taken from it:

- **Frames and timing:** every frame is an image, each with its own duration (a frame without one takes the file's speed).
  The file plays forever by default, like in the editor.
- **Layers:** what the editor shows is what is drawn. Hidden layers, layers inside a hidden group and reference layers are
  left out. Layers are ordered as in the editor, including a cel's z-index. Layer opacity and cel opacity count. Indexed
  files use their palette; the transparent index is transparent in every layer but the background. Linked cels work.
- **Tags become sequences,** in the order of the tag list, named like the tag, so `GetSpriteSequenceIndex(model, 'walk')`
  finds the tag "walk". A tag keeps its direction (forward, reverse, ping-pong, ping-pong reverse) and its repeat count
  (0 plays forever). Aseprite counts the legs of a ping-pong ("repeat 2" is forward once and back once), a sequence
  counts its cycles, so the count is halved there. A `sequences` list in the settings file replaces the tags, and its
  top-level `repeat` and `fps` replace theirs.
- **Slices become regions** for drawing on the screen, named like the slice, with the rectangle the slice has in the first
  frame (see [On the screen](#on-the-screen-hud-elements-and-screen-effects)).
- **A slice with a pivot sets the origin.** The first slice that has a pivot decides, a slice that moves from frame to
  frame moves the origin with it. `origin` in the settings file wins.
- **Not supported:** blend modes other than normal (a layer is drawn as normal, the console says so once), tilemap layers
  (skipped, with a console message), a group's own opacity and blend mode.

For pixel art draw at the size the sprite has on screen and set `"filter": "nearest"`.

## Half-Life sprites

Half-Life's `.spr` files (version 2) load like Quake's, with their own 256 color palette. The texture format in the header
decides how a sprite is drawn:

| Format | Meaning | Drawn as |
| :--- | :--- | :--- |
| 0, normal | opaque | alpha tested, every pixel opaque |
| 1, additive | the color is added to what is behind | `additive` |
| 2, index alpha | the palette index is the alpha | `alpha`, color from the palette entry, alpha is the index |
| 3, alpha test | palette index 255 is transparent | alpha tested |

These meanings come from the source of another engine (FTE), which says it is not sure about them, and **no Half-Life
sprite has been compared against them yet**: if an additive or index-alpha sprite looks wrong, that is the first suspect.
A `.spr` does not read a settings file: its header says how it is drawn.

## Memory

All images of a sprite are uploaded as the layers of one texture. A sprite may take `r_sprite_memory` megabytes of video
memory, mip levels counted (default 64, applies to sprites loaded afterwards). A bigger one is halved in size until it
fits and the console says so; the sprite keeps its size in the world, only the texture gets coarser. Frames beyond the
hardware's layer limit are dropped. A 437 x 498 GIF with 20 frames takes about 23 MB.

## Telling the engine there is no settings file

Every sprite load asks for `<file>.json`, and in a browser a file that is not there still costs a request (twice, the
client and the server worker each ask). A game that knows better says so:

```ts
engine.PrecacheModel('gfx/torch-flame.gif', { sidecar: false });
```

The server skips the lookup and sends the hint to the clients with the model list, so they skip it too. Leaving the option
out keeps "drop in a settings file and it works"; precaching the same model again without `sidecar: false` loads it with
the file after all.

## Sprites from Quake's `.spr` files

`.spr` files (version 1) draw as they always did, on the same renderer: groups animate on the global clock, or on a random
offset when the file says so, and all five orientation types of the header are honored. Only image files read the settings
file: a `.spr` is configured by its header.

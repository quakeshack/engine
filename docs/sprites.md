# Sprites: Images as Models

A sprite is a flat picture or animation that is placed in the world as an entity and turns towards the viewer. Besides
Quake's `.spr` files the engine takes GIF, PNG/APNG and WebP images directly, and an optional settings file next to the
image changes how it is drawn. No other game code is needed:

```ts
static precache(engine: ServerEngineAPI): void {
  engine.PrecacheModel('gfx/torch-flame.gif');
}

spawn(): void {
  this.setModel('gfx/torch-flame.gif'); // loops, nothing else to do
}
```

The same works for client-only entities (`ClientEngineAPI.ModForName`, see [Client Entities](client-entities.md)).
Aseprite files and Half-Life sprites are planned and not loaded yet.

## Which format

| Format | Alpha | Colors | Size | Notes |
| :--- | :--- | :--- | :--- | :--- |
| GIF | on or off | 256 per frame | big | Decoded by the engine, looks the same in every browser. Drawn alpha tested. |
| APNG (`.png`, `.apng`) | 8 bit | true color | medium, lossless | Decoded by the engine. The house format. A plain PNG is a one-image sprite. |
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
| `origin` | `[x, y]` pixels | the center | The pixel that sits on the entity's origin, counted from the top left corner of the image. `[width / 2, height]` puts the entity at the bottom center, like a flame on a torch. |
| `blend` | `alphaTest`, `alpha`, `additive` | `alphaTest` for GIF, `alpha` for the rest | `alphaTest` drops pixels below a quarter alpha and draws the rest. `alpha` blends. `additive` adds the color to what is behind, so black adds nothing (fire, glow, sparks). All three use premultiplied alpha, so edges do not get dark fringes. |
| `colorKey` | `{ "color": [r, g, b], "tolerance": 0 to 255 }` | none | Makes pixels of that color transparent, in every frame. The edge is hard (a pixel is in or out); for an image with a black background that should blend, `additive` is the soft solution. A GIF's "black" is often not quite black (a flame GIF measured `(4, 2, 4)`), and an additive sprite then shows a faint box; key that color out as well, for example `"blend": "additive", "colorKey": { "color": [0, 0, 0], "tolerance": 16 }`. |
| `filter` | `linear`, `nearest` | follows `gl_texturemode` | `nearest` keeps hard pixels for pixel art, `linear` is smooth with mip levels. |
| `orientation` | `parallel`, `parallelUpright`, `facingUpright`, `oriented`, `parallelOriented` | `parallel` | `parallel` faces the view plane. `parallelUpright` stays upright around the world's Z axis and keeps the view's right vector. `facingUpright` stays upright and faces the viewer's position. `oriented` uses the entity's own angles. `parallelOriented` faces the view and rolls with the entity's roll angle. |
| `phase` | `spawn`, `global`, `random` | `spawn` | Which clock a sequence follows: `spawn` starts when the entity gets the model or a new `frame`, `global` is the same time for every instance, `random` gives each entity an offset. |
| `fps` | number above 0 | the file's timing | Frames per second for every image, replacing the delays of the file (also below the 10 ms limit). |
| `repeat` | whole number, 0 = forever | the file's | How often the whole animation plays. A finished sequence holds its last image. |
| `interpolate` | `true`, `false` | `false` | Crossfades from an image to the next. Needs `r_interpolation 1`, which is the default. |
| `sequences` | list of `{ name, from, to, direction, repeat, fps }` | one sequence over all images | Each entry becomes one `frame` of the entity, in order, so `this.frame = 1` plays the second. `from` and `to` (both included) default to the first and last image, `direction` to `forward` (`reverse`, `pingpong` and `pingpongReverse` exist), `repeat` and `fps` to the settings above. |

How a sequence ends: `forward` holds its last image, `reverse` its first. A `pingpong` goes to the far end and back without
showing either end image twice in a row, and holds the image it started with.

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
offset when the file says so, and all five orientation types of the header are honored.

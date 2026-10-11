# Color Shifts

A color shift tints the whole 3D view: the red of damage, the gold of a pickup, the blue of the quad, the green of
a slime pit. They are entries of the `color-shift` post-process effect, so everything in
[post-process-effects.md](post-process-effects.md) (stacks, pulses, channels, fades, stages) applies to them.

## The effect

```ts
{ id: 'color-shift', settings: { color: new Vector(1, 0, 0), alpha: 0.4 } }
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `color` | `Vector` or `[r, g, b]` | black | Red, green and blue, each 0 to 1. |
| `alpha` | `number` | `0` | How much the color covers the view, 0 to 1. |

- **Stage:** `final`. A tint is laid over what the renderer's own effects (bloom, warp, underwater fog) made of the
  scene, and under the HUD.
- **Fades:** only `alpha` fades. The color is taken as it is, so a flash does not run through other colors on its way out.
- **A tint is not drawn while there is no 3D view** (the console or the menu is up with no game running).

## Mixing

Entries of `color-shift` that follow each other are mixed into one tint and drawn as one quad. They are mixed in
the order they are applied, with the formula Quake always used:

```
a  = a + a2 * (1 - a)
c  = c * (1 - a2 / a) + c2 * (a2 / a)
```

which is the same as laying one tint after the other over the scene with ordinary alpha blending. The order matters:
a red flash over a blue tint is not a blue flash over a red tint. Another effect between two tints (a `blur` entry)
splits them into two passes.

The player has two controls over the result, and a game does not have to honor them itself:

| Variable | Default | What it does |
| --- | --- | --- |
| `gl_cshiftpercent` | `100` | Scales the alpha of every shift, in percent. `0` shows none. An accessibility control. |
| `gl_polyblend` | `1` | `0` draws no color shifts at all. |

## Setting a tint from a game

**A tint that stays** is a stack entry on a channel the game owns. Set it every frame (the client game's
`startFrame()` runs every frame, `draw()` does not run with `nohud`) or when the state changes:

```ts
this.engine.PostProcess.setStack(
  hasQuad ? [{ id: 'color-shift', settings: { color: new Vector(0, 0, 1), alpha: 0.12 } }] : [],
  { channel: 'hud.powerup', fade: 0.2 },
);
```

**A flash** is a pulse. The same `key` restarts it instead of stacking a second one:

```ts
this.engine.PostProcess.pulse({
  id: 'color-shift',
  key: 'damage',
  settings: { color: new Vector(1, 0, 0), alpha: 0.4 },
  timing: { fadeOut: 0.6 },
});
```

Quake's flashes fall at a fixed number of alpha units per second (0 to 255), 150 for damage and 100 for the
rest. A flash of alpha `a` (0 to 1) that falls at `r` units per second has a `fadeOut` of `a * 255 / r` seconds.
Order between a game's own tints is the order of their channels (the order they were first used), and within a
channel pulses can sit `below` or `above` the stack.

## What the engine tints with when a game does not

Until a game sets its own, the engine applies Quake's set, in Quake's order, as entries on the channel
`engine.color-shifts`:

| Slot | What | Color and alpha | Decay (alpha units per second) |
| --- | --- | --- | --- |
| `contents` | the liquid the eye is in | `v_cshift` for clear air (alpha 0), water 130 80 50 at 128, slime 0 25 5 at 150, lava 255 80 0 at 150 | none, replaced when the contents change |
| `damage` | damage from `svc_damage` | red for flesh, pinkish for armor; adds 3 per point of half the damage (at least 10), at most 150 | 150 |
| `bonus` | the `bf` command | 215 186 69 at 50 | 100 |
| `powerup` | the items the player has | quad blue at 30, suit green at 20, invisibility grey at 100, invulnerability yellow at 30 | none, set from the items every frame |
| `user1` to `user4` | `ClientEngineAPI.ContentShift` | what the game sets | 100 |

A dynamic light whose glare the eye is inside of (with `gl_flashblend` on) tints the frame orange for one frame, on
the channel `engine.corona`, after the ones above.

`ClientEngineAPI.ContentShift(slot, color, alpha)` sets one of the four user slots. It is deprecated: use
`PostProcess.pulse` or `setStack`, where the timing is the game's. The engine's set is deleted together with it once
the games set their own tints (plans/scr-v-split.md, phase 5). Until then a game that sets its own tint *and* leaves
the engine's alone is tinted by both, which is what a game that mirrors the powerup from its HUD sees today.

## Adding another effect that mixes its entries

An effect that wants its entries mixed (they are layers of one thing) implements
`combineSettings(settings)` and returns the one set of settings to apply, or `null` for nothing. See
`ColorShiftEffect` and `PostProcessEntries.collect()`.

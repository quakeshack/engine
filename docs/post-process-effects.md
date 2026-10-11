# Post-Process Effects

Game code can push an ordered stack of screen-space effects onto the renderer each frame. Effects are applied to the 3D scene only — the HUD and UI are always drawn on top, sharp and unaffected.

The renderer owns a few effects of its own (bloom, underwater fog, screen-warp). `R.Init()` registers them with the same `PostProcess` that holds the stack's effects, and the renderer turns them on and off itself from its console variables and from where the camera is. They are not `stackable`, so a stack cannot name them. The `scene` stage of the stack runs first (`PostProcess.resolveGameplayStack()`), then the active effects of the renderer resolve to the screen in registration order, and the `final` stage of the stack comes last (`PostProcess.resolve()`).

## API

`ClientEngineAPI.PostProcess` exposes four methods:

| Method | Description |
| --- | --- |
| `setStack(stack, options?)` | Replace the stack of a channel with new entries. Applied on the next rendered frame, or cross-faded over `options.fade` seconds. |
| `clearStack(channel?)` | Remove the stack of a channel at once, of every channel without a name. Pulses that are running end on their own. |
| `hasStack(channel?): boolean` | Returns `true` when a stack is set and meant to stay. Pulses and entries that are fading out do not count. |
| `pulse(descriptor, options?)` | Start an entry that fades in, holds, fades out and is gone. See "Pulses". |

Import the types from `GameInterfaces.ts`:

```ts
import type { PostProcessStack, PostProcessPulseDescriptor } from '../../../shared/GameInterfaces.ts';
```

## Defining a Stack

A stack is a read-only array of effect descriptors. Each descriptor names an effect by `id` and carries its settings. Effects are applied in the order they appear in the array.

```ts
const stack: PostProcessStack = [
  { id: 'color-grade', settings: { saturation: 0.0 } },
  { id: 'blur',        settings: { radius: 6.0 } },
];

this.engine.PostProcess.setStack(stack);
```

To revert to the normal look:

```ts
this.engine.PostProcess.clearStack();
```

## Fading between stacks

`setStack(stack, { fade })` cross-fades from the previous stack of the channel to the new one over `fade` seconds, so a menu does not have to snap its blur on:

```ts
this.engine.PostProcess.setStack(buymenuStack, { fade: 0.25 });
// later
this.engine.PostProcess.setStack([], { fade: 0.25 });
```

- An entry that is new fades in from nothing, an entry that is gone fades out and is then removed, and an entry that stays moves from its old settings to its new ones.
- An entry stays the same entry when it has the same `key`, or, without a key, when it is the n-th entry of the same effect. Give entries a `key` when a stack reorders them or repeats an effect.
- What fades are the numbers an effect lists as neutral (`saturation`, `contrast`, `exposure`, `tintStrength` and `pulseStrength` of `color-grade`, `radius` of `blur`). A tint color or a pulse period is taken as it is, and the strengths carry how much of it shows.
- An entry that is on its way out is applied after the entries of the new stack.
- Fades run on the real clock, which does not stop while the game is paused, so a blur fades in over a paused game.

## Pulses

A pulse is an entry that removes itself: a damage flash, the moment of a pickup, a berserk surge on the grade.

```ts
this.engine.PostProcess.pulse({
  id: 'color-grade',
  key: 'damage',
  settings: { saturation: 0.4, tintColor: new Vector(1, 0, 0), tintStrength: 0.5 },
  timing: { fadeIn: 0.05, hold: 0.1, fadeOut: 0.6 },
});
```

- `timing` is in seconds, parts that are left out are zero. The pulse is nothing at its start, full strength after `fadeIn`, held for `hold`, and nothing again after `fadeOut`, when the engine removes it. A pulse without any duration shows for one frame.
- Starting a pulse with a `key` that is already running starts it over instead of stacking a second one. Without a key every call is its own pulse.
- `placement: 'below'` puts the pulse in front of the stack entries of its channel, so that the stack is applied over it; `'above'` (the default) puts it behind them. Pulses of one placement are applied in the order they were started.
- `clearStack()` does not end a pulse.

## Channels

`setStack(stack, { channel })` and `pulse(descriptor, { channel })` take a channel name, `'default'` when left out. A channel has its own stack, which is replaced and cleared on its own, so the HUD can own the powerup tint and the gameplay code the death grade without knowing about each other. Channels are composed in the order they were first used; within a channel the order is the pulses placed below, the stack, then the pulses placed above.

## Several entries of one effect

Every entry is applied: two `blur` entries blur twice, each with its own radius.

## Stages

Each entry has a `stage`:

| Stage | Where it is applied |
| --- | --- |
| `'scene'` | Before the renderer's own effects (bloom, underwater fog, warp), so they see the result. The default for `color-grade` and `blur`. |
| `'final'` | After the renderer's own effects, as the last pass before the HUD. The default for `color-shift`. |

Set `stage` on an entry to override the default of its effect. A `final` entry costs no extra pass when it is the only thing that is active: it replaces the plain copy of the scene to the screen.

## Available Effects

### `color-grade`

Adjusts color tone. All fields are optional and default to neutral values.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `saturation` | `number` | `1.0` | Color saturation. `0` = grayscale, `1` = normal, `>1` = oversaturated. |
| `contrast` | `number` | `1.0` | Contrast multiplier around mid-grey. `<1` = flat, `>1` = punchy. |
| `exposure` | `number` | `0.0` | Additive brightness offset applied to all channels. |
| `tintColor` | `Vector` | — | RGB tint color to mix over the scene (e.g. `new Vector(1, 0, 0)` for red). |
| `tintStrength` | `number` | `0.0` | How strongly the tint is applied. `0` = no tint, `1` = full tint. |
| `pulseStrength` | `number` | `0.0` | Amplitude of a sinusoidal saturation pulse layered on top of the base saturation. |
| `pulsePeriod` | `number` | `0.0` | Period of the saturation pulse in seconds. `0` disables the pulse. |

### `blur`

Two-pass separable Gaussian blur (9-tap, σ = 1.5). All fields are optional.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `radius` | `number` | `4.0` | Pixel spread of the Gaussian. Higher values produce a wider blur. `0` = no blur. |

### `color-shift`

Tints the whole view: a damage flash, a pickup, a powerup, the color of a liquid. Entries that follow each other are
mixed into one tint. See [color-shifts.md](color-shifts.md).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `color` | `Vector` or `[r, g, b]` | black | Red, green and blue, each 0 to 1. |
| `alpha` | `number` | `0` | How much the color covers the view, 0 to 1. Only this fades. |

## Usage Examples

### Desaturated grayscale on game-over

```ts
import type { PostProcessStack } from '../../../shared/GameInterfaces.ts';
import Vector from '../../../shared/Vector.ts';

const gameoverStack: PostProcessStack = [
  { id: 'color-grade', settings: { saturation: 0.0, tintColor: new Vector(1.0, 0.0, 0.0), tintStrength: 1.0 } },
  { id: 'blur',        settings: { radius: 3.0 } },
];

// Activate when the game ends
this.engine.PostProcess.setStack(gameoverStack);

// Remove when returning to normal play
this.engine.PostProcess.clearStack();
```

### Blurred desaturation while a menu is open

```ts
const buymenuStack: PostProcessStack = [
  { id: 'color-grade', settings: { saturation: 0.3 } },
  { id: 'blur',        settings: { radius: 8.0 } },
];

onMenuOpen(): void {
  this.engine.PostProcess.setStack(buymenuStack);
}

onMenuClose(): void {
  this.engine.PostProcess.clearStack();
}
```

### Berserk-style power-up with a pulsating oversaturation

```ts
const berserkStack: PostProcessStack = [
  {
    id: 'color-grade',
    settings: {
      saturation: 1.4,
      tintColor: new Vector(1.0, 0.2, 0.2),
      tintStrength: 0.25,
      pulseStrength: 0.6,
      pulsePeriod: 0.8,
    },
  },
];

onBerserkPickup(): void {
  this.engine.PostProcess.setStack(berserkStack);
}

onBerserkExpired(): void {
  this.engine.PostProcess.clearStack();
}
```

## Adding New Effects

1. Create `source/engine/client/renderer/postprocess/MyEffect.ts` extending `PostProcessEffect` with `this.stackable = true`. Implement `apply()`, and `init()`/`resize()`/`shutdown()` if the effect owns GPU resources.
2. Say what an entry of the effect is made of:
   - `neutral`: the settings with which the effect changes nothing. The numbers listed here are the ones that fade, so list those that carry the intensity and leave out colors and periods.
   - `resolveSettings(settings)`: fills in what an entry left out and repairs numbers that are not finite. It must return settings it can be asked to resolve again.
   - `defaultStage`, if the effect belongs after the renderer's own effects.
   - `combineSettings(settings)`, if the entries of the effect are layers of one thing (a tint) and not passes of
     their own: entries that follow each other are handed to it in one list and it returns the one set of settings to
     apply, or `null` for nothing.
3. `apply(input, x, y, width, height, settings)` gets the settings of the entry it is applied for, already resolved and faded to where the entry is. Do not look them up on `PostProcess`: with several entries of one effect there is no single answer.
4. Add `MyEffectDescriptor` to `PostProcessEffectDescriptor` in `source/shared/GameInterfaces.ts`.
5. Register the GLSL program in `renderer/programs/ShaderPrograms.ts` alongside the existing `color-grade` and `blur` registrations.
6. Call `PostProcess.addEffect(new MyEffect())` in `R.ts` after `PostProcess.init()`.

The entries themselves (timing, channels, fades, order) live in `PostProcessEntries.ts`, which knows nothing of GL and is tested on its own.

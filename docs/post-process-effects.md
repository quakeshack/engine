# Post-Process Effects

Game code can push an ordered stack of screen-space effects onto the renderer each frame. Effects are applied to the 3D scene only — the HUD and UI are always drawn on top, sharp and unaffected.

Bloom and screen-warp are renderer-owned and always run independently of this stack.

## API

`ClientEngineAPI.PostProcess` exposes three methods:

| Method | Description |
| --- | --- |
| `setStack(stack: PostProcessStack)` | Replace the active stack with new entries. Applied immediately on the next rendered frame. |
| `clearStack()` | Remove all gameplay-driven effects. |
| `hasStack(): boolean` | Returns `true` when a non-empty stack is active. |

Import `PostProcessStack` from `GameInterfaces.ts`:

```ts
import type { PostProcessStack } from '../../../shared/GameInterfaces.ts';
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

1. Create `source/engine/client/renderer/MyEffect.ts` extending `PostProcessEffect` with `this.stackable = true`. Implement `apply()`, and `init()`/`resize()`/`shutdown()` if the effect owns GPU resources.
2. Add `MyEffectDescriptor` to `PostProcessEffectDescriptor` in `source/shared/GameInterfaces.ts`.
3. Register the GLSL program in `R.ts` alongside the existing `color-grade` and `blur` registrations.
4. Call `PostProcess.addEffect(new MyEffect())` in `R.ts` after `PostProcess.init()`.

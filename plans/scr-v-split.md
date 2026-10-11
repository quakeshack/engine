# Dissolve `SCR.ts` and `V.ts`

Follow-up to `plans/r-split.md`. Status: **plan drafted 2026-10-10, developer decisions 1 to 8 recorded (4 to 8 on 2026-10-11); G6 is a
direction, not a closed decision; Phases 0 to 4 are done (2026-10-11; Phase 4 not committed), Phases 5 and 6 are not started.** Written for the maintainers; the game-side suggestions are proposals, each its own go/no-go.

## Context

`source/engine/client/SCR.ts` (534 lines) and `V.ts` (595 lines) are the two static classes `R.ts` used to
be: several unrelated jobs each, with the renderer and the game reaching into them and they reaching back.

### What V contains

| Concern | Members |
|---|---|
| First-person view calculation | `CalcRefdef` (155 lines), `CalcIntermissionRefdef`, `CalcBob`, viewmodel bob and look-bob state, idle sway, damage kick (`dmg_*`), step smoothing (`oldz`) |
| Pitch drift | `StartPitchDrift`, `StopPitchDrift`, `DriftPitch` (mutates `clientRuntimeState.pitchvel`, `nodrift`, `driftmove`, `laststop`) |
| Color shifts | `cshift_*`, `ContentShift`, `SetContentsColor`, `CalcBlend`, `BonusFlash_f`, `cshift_f`, the color half of `ApplyDamage`, the global `blend` |
| Math helpers | `SmoothValue`, `ShortestAngleDelta`, `ComputeViewmodelLookBobTargets`, `CalcRoll` |
| Frame hooks | `PreRenderView`, `RenderView` |
| Cvars | 27, among them `gamma` (a display setting that `FrameUniforms` clamps) and `scr_ofsx/y/z` |

### What SCR contains

| Concern | Members |
|---|---|
| Frame driver | `UpdateScreen`: rAF dedupe, FPS and refresh-rate detection (writes `Host.refreshrate`), post-process resolve, overlay order, screenshots, the clean-screenshot cvar dance |
| Viewport and FOV | `CalcRefdef` (writes `Camera.refdef.vrect`, `fov_x/y` and the two scale entries of `Camera.perspective`), `SizeUp_f`/`SizeDown_f`, `viewsize`, `hudReservedHeight` |
| Console slide | `con_current` (16 uses, mostly tests), `SetUpToDrawConsole`, `DrawConsole`, `isConsolePassiveBackdrop`, `conspeed` |
| Center print | `CenterPrint`, `DrawCenterString`, `#formatCenterLines` |
| Indicators | turtle, net, pause, crosshair |
| Loading plaque | `BeginLoadingPlaque`, `EndLoadingPlaque` |

### Findings

1. **Latent crash.** `SCR.crosshair`, `crossx`, `crossy` are declared and never created, so `SCR.crosshair.value`
   throws for a game without `CAP_HUD_INCLUDES_CROSSHAIR`. id1 and hellwave both declare it, which hides it.
2. **Dead state.** `disabled_for_loading` and `disabled_time` are written and never read. The loading plaque only
   stops sounds (`Draw.EndDisc` and `Con.ClearNotify` on the way out).
3. **The dedicated server loads the renderer.** `createDedicatedServer` passes the client `V` as the server's
   `view`, only for `CalcRoll`, and `V` imports `R`. The server worker already uses `server/PlayerRollView.ts`
   (same cvar names), so the `FIXME` on `V.CalcRoll` is stale.
4. **Wrong-way dependencies.** `EntityLighting` imports `V` for `SmoothValue`; `DynamicLights` writes `V.blend`;
   `FrameUniforms` owns a clamp on `V.gamma`; `V` reads `SCR.viewsize` and `SCR` drives `V.PreRenderView` and
   `V.RenderView` (a cycle); `R.DrawViewModel` and `SCR.CalcRefdef` both write `Camera.perspective` entries.
5. **Quake knowledge in the engine.** `V.CalcBlend` reads Quake item bits (`Def.it.quad`, `suit`, `invisibility`,
   `invulnerability`) and fixed tint colors; `ApplyDamage` hardcodes the armor/blood colors; `SCR.CalcRefdef`
   hardcodes the status bar heights (24 and 48) and the `viewsize` thresholds; the pause, net and turtle pictures
   are lumps of the base game.
6. **Duplicates of game code.** id1's `HUD._powerupFlash` already sets the powerup tint through
   `engine.ContentShift`, the bonus flash and the secret flash likewise, and its HUD has its own copy of the
   center-print wrapping (`formatCenterPrintLines`) and a `client.center-print` subscriber. By reading the code the
   engine's items-based tint and the game's both apply; not yet confirmed on screen.
7. **Almost no tests.** `v.test.mjs` pins three math helpers, `scr.test.mjs` a pause/net indicator case.
   `CalcRefdef`, `CalcBlend`, `DriftPitch` and `UpdateScreen` are not covered. (Covered since Phase 0.)
8. **Quirks the characterization tests pinned, found by writing them** (2026-10-11), none changed in Phase 0.
   The developer's answers are in italics.
   - Refresh-rate detection rounds the measured FPS *up* to a multiple of 15, so a measurement a hair above one
     (60.0000001 from floating-point timestamps) becomes the next multiple, 75. *Fix in `FramePacing` (Phase 4):
     step up to the next multiple only once the measurement is clearly above the current one, about 63 for 60
     (3 FPS, 5 percent), a threshold to be pinned by a test. Not set from a single measurement window either.*
   - `V.CalcRefdef` clamps the eye against the player origin *unsanitized*: a `NaN` coordinate leaves the eye
     unclamped (0.03125), a `+Infinity` one puts it 14 units below zero. Only reachable with a broken origin.
     *No known issue, origins populate quickly; no action. The characterization test stays, so it is a visible
     decision if `FirstPersonView` ever sanitizes the origin once at the top.*
   - The viewmodel and look bob are smoothed with module state (`#smoothedViewmodelBob`, the look-bob pair), so
     the first frame after a map change starts from the previous map's values. The tests had to run quiet frames
     between cases to reset it. *Accepted as is.* `ViewmodelMotion` (Phase 3) owns that state anyway; resetting it
     on a map change is free there, and optional.

## Decisions

1. **Remove the engine-drawn crosshair** (`SCR.crosshair`, `crossx`, `crossy`, `disableCrosshair` and its branch in
   `UpdateScreen`). Drawing it is game code's job. `CAP_HUD_INCLUDES_CROSSHAIR` loses its meaning: it is removed
   from `source/shared/Defs.ts` and from the `main.ts` of id1 and hellwave (one line each; two repos, two commits,
   see `submodule-aware-commit`).
2. **The dedicated server uses `PlayerRollView`** and so no longer registers the `V` cvars (`gamma`, `v_kick*`,
   `cl_bob*`, ...). A config line that sets one of them there becomes an unknown-cvar message. Accepted.
3. **`V` and `SCR` dissolve.** Their members go to classes named for what they do and the two files are deleted.
   Forwarders are allowed while moving and are removed in the last phase (same rule as `r-split.md` Design D).
4. **`Camera` has no client state** (2026-10-11). It stays a leaf under `renderer/scene/`; the screen layout
   (`Viewport`) and everything that reads the client state live in `client/view/`.
5. **The first-person view calculation moves to the client game code (G6), direction agreed, details open**
   (2026-10-11; the developer is unsure, so this is recorded as the working assumption, not as settled). See "G6
   in detail" below. Phases 0 to 4 do not depend on it: they keep the calculation in the engine, as
   `FirstPersonView`, and the move is Phase 5.
6. **Color shifts are unified into one model, owned by the client game code, and rendered by the post-process
   pipeline** (2026-10-11), G4 is a yes. A color shift is an entry of the post-process stack (effect `color-shift`);
   the engine keeps the timers and the mixing. See "Color shifts in detail" below.
7. **Placement is explicit** (2026-10-11): a flash can sit below or above the persistent layers (the question was
   whether a damage flash goes under a powerup tint). It is the generic `stage` and ordering of decision 8, not a
   color-shift field.
8. **Timing is a general property of post-process entries** (2026-10-11), not a color-shift feature, so a game can
   be as creative as it likes with the existing effects (a berserk pulse on the grade, a blur fade-in on a menu).
   This turns the post-process stack into the one mechanism, and it is built first (Phase 1). See "Post-process
   entries: timing, stages, channels".

## Target

Names are proposals, settled in the phase that creates them. New files go in `client/view/` and `client/screen/`,
no barrel files.

| Class | Owns | From |
|---|---|---|
| `ViewCvars` | the view cvars, one instance, imports only the `Cvar` type (the `ClientCvars` shape) | V |
| `mixColorShifts` and `ColorShiftEffect` (in `renderer/postprocess/`) | the mixing, `gl_cshiftpercent`, `gl_polyblend`, the draw as the last effect; replaces `R.PolyBlend` and `V.blend` | V, R |
| `PostProcess` additions | timing, stages, channels, `pulse`, multi-entry apply (see above) | PostProcess |
| `FirstPersonView` | `CalcRefdef`, `CalcIntermissionRefdef`, damage kick, idle sway, step smoothing, viewmodel placement | V |
| `ViewmodelMotion` | `CalcBob`, bob smoothing, look-bob state and targets | V |
| `PitchDrift` | the three drift methods and the `centerview` command | V |
| `smoothing` (in `source/shared/`) | `SmoothValue`, `ShortestAngleDelta`; `CalcRoll` stays with `PlayerRoll.ts` | V |
| `Viewport` | `viewsize`, `fov`, `sizeup`/`sizedown`, vrect and FOV into `Camera`, the HUD reservation | SCR |
| `Camera.UpdateProjection(fovY, aspect)` | the only writer of `perspective[0]`/`[5]`, used by `Viewport` and `R.DrawViewModel` | SCR, R |
| `ConsoleOverlay` (existing; the slide is merged into it, see Phase 4) | `con_current`, `conspeed`, `SetUpToDrawConsole`, `DrawConsole`, passive-backdrop rule | SCR |
| `FramePacing` | FPS window, refresh-rate detection | SCR |
| `Screenshots` | the two commands and the capture dance | SCR |
| `ScreenFrame` | `UpdateScreen` as named steps: prepare, scene, resolve, overlays, finish | SCR |
| `CenterPrint`, `ScreenIndicators` | until the game takes them (see below) | SCR |
| loading plaque | `ClientHost`/`CL` (it only stops sounds and clears notify lines) | SCR |

`gamma` goes to `RendererCvars`, and the clamp stays in `FrameUniforms`.

## Suggestions: what the game could take over

Each is its own decision. "API" is what the engine would have to offer; most of it exists.

| # | Duty | Why it is the game's | API | Risk | Suggested |
|---|---|---|---|---|---|
| G1 | Crosshair | decided above | none | none | yes |
| G2 | Center print | the HUD already has its own wrapping and subscribes to `client.center-print`; the engine draws a second copy | the event exists; the engine stops drawing, a game that wants the Quake look has `HUD` | a game without a HUD gets no center print; hellwave to check | yes |
| G3 | Pause, net and turtle indicators | the pictures are base-game lumps (`pause`, `NET`, `TURTLE` of the WAD) | `CL.paused`, `last_received_message` exposed read-only; `draw()` already runs every frame | `nohud` skips `draw()`, so the net indicator would vanish with it; pause should not | pause yes, net/turtle later as an engine diagnostic with a text fallback |
| G4 | Color shifts: powerup, bonus, damage, secret, liquid tint | `V.CalcBlend` reads Quake item bits and owns the decay constants; id1's HUD already sets powerup and bonus through `ContentShift` and decays its own damage value; `ApplyDamage` hardcodes colors | `engine.PostProcess` with the `color-shift` effect, pulses and channels; `viewContents`; see the two sections above | the engine and the game tint twice today, so a game that relied on the engine's would lose it: id1 and hellwave need a check | **decided yes**: the engine keeps the timers, the mixing, `gl_cshiftpercent` and the draw |
| G5 | HUD space and the `viewsize` thresholds | 24 and 48 are the id1 status bar heights | `ClientGameInterface.hudReservedHeight(viewsize)` (default 0), the `SCR.viewsize` the HUD already reads | a game that does not implement it gets a full-height view | yes |
| G6 | The whole first-person view: bob, roll, damage kick, idle sway, step smoothing, viewmodel placement and the `viewsize` Z nudge | feel of the game, not of the camera; `updateRefDef(refdef)` is already a hook for the last step | see "G6 in detail" | the order inside `CalcRefdef` matters (kick before punch angle, nudge after bob); needs the characterization tests of Phase 0 first | **direction agreed, developer unsure**, after G4 and G5 |
| G7 | Pitch drift | input behavior that modifies `viewangles`, which prediction uses | stays in the engine (`PitchDrift`, next to `ClientInput`) | | no |
| G8 | Console slide, screenshots, FPS, refresh rate | engine services | | | no |

G4 and G5 are the ones that remove Quake constants from the engine. G6 is the largest and the most opinionated: a
game may reasonably want the engine's bob and kick as a default, so it would be an opt-out, not a move.

## G6 in detail (working assumption)

The game's client code computes the first-person view; the engine supplies inputs and applies the result. Sketch,
to be turned into an interface in Phase 5 (and then into `docs/game-module-contract.md`):

- **Inputs** the engine hands over each frame: player origin, velocity, predicted view angles, view height, on-ground
  flag, punch angle, intermission camera, the client time and frame time. Most of it is already readable through
  `ClientEngineAPI`; what is missing is added there, not reached for through the client state.
- **Result:** the `RefDef` (view origin and angles) plus a viewmodel transform (origin, angles, model, frame and
  lerp data), which replaces the bits of `CalcRefdef` that write the view entity today.
- **Engine default:** `FirstPersonView` stays and is exported through the engine API as a function a game can call
  or compose with, so a game gets today's Quake bob, roll, kick and sway with one call and adjusts the result, or
  writes its own. That keeps the cost of the hand-off for hellwave at one line, and keeps the tuned cvars
  (`cl_bob*`, `v_kick*`, `v_idlescale`, `scr_ofs*`) with the default implementation instead of with a game.
- **Not handed over:** the chase camera (`Chase.ts`) runs after the game's result, the intermission camera data
  comes from the server, and pitch drift stays engine input behavior (G7).
- **Risks:** prediction reads `viewangles`, so a game must not feed back a modified value into them; the order
  inside today's `CalcRefdef` becomes part of the contract and is written down; a game that implements nothing gets
  the default, so no existing game breaks.

What would settle the doubt: a prototype in hellwave with a distinct view (say, no bob and a different kick) that
shows the interface is enough without touching engine internals. Phase 5 starts with that.

## Post-process entries: timing, stages, channels

What the stack does today (`PostProcess.ts`, `docs/post-process-effects.md`): the game replaces the whole stack with
`setStack(stack)`; `resolveGameplayStack` applies the entries in array order, looking each effect up by `id`, into the
scene capture; the renderer-owned effects (bloom, underwater fog, warp) and the plain resolve follow. An effect reads
its settings with `getStackEntry(id)`, which returns the first entry of that id, so an id cannot appear twice with
different settings. There is no notion of time: the game animates by pushing a new stack every frame.

What it becomes (an additive extension; a game that calls `setStack` as today sees no change):

- **Timing.** A descriptor may carry `timing: { fadeIn?, hold?, fadeOut? }` (seconds). The engine derives an
  *intensity* in 0..1 and passes it to the effect together with the settings; an effect has a `neutral` settings
  object and the engine blends settings from neutral to the entry's values by the intensity (`color-grade`:
  saturation and contrast to 1, exposure and tint strength to 0; `blur`: radius to 0; `color-shift`: alpha to 0).
  Two ways in:
  - `PostProcess.pulse(descriptor)`: fire and forget. The entry lives for `fadeIn + hold + fadeOut` seconds and is
    removed by the engine; the same `key` restarts it.
  - `PostProcess.setStack(stack, { fade })`: cross-fades from the previous stack of that channel to the new one
    over `fade` seconds; an id that is new fades in from neutral, one that is gone fades out.
  Timers run on the real clock (see "Phase 1: what shipped": `Host.frametime` never stops while the game is paused,
  so a menu blur fades in over a paused game, which is wanted here).
  (Corrected 2026-10-11, this sentence used to say that a paused game does not fade.)
- **Several entries of one id.** `apply` receives the entry's settings instead of looking up the first one, and
  `resolveGameplayStack` applies every entry. `color-shift` uses it for its layers; for `color-grade` and `blur`
  repeating an id now does what it says.
- **Stage.** A descriptor has `stage?: 'scene' | 'final'`. `scene` is what entries do today: applied before the
  renderer-owned effects, so bloom and warp see the result. `final` is applied after the plain resolve as the last
  pass, over everything and under the HUD. Each effect has a default (`color-shift`: `final`, the others: `scene`),
  which is also where `R.PolyBlend` sits today. Within a stage, order is stack order and then pulses by start
  time; a pulse with `placement: 'below'` goes in front of the stack entries instead of behind (decision 7).
- **Channels.** `setStack(stack, { channel })` (default channel `'default'`, so existing calls are unchanged):
  channels are composed in creation order and cleared independently. Without them every subsystem of a game that
  wants to tint the screen has to know about every other one; with them the HUD owns the powerup and liquid tint and
  the gameplay code owns the death grade. `clearStack(channel?)` and `hasStack(channel?)` follow.
- **Scene capture and cost.** `needsSceneCapture()` keeps its meaning (an active effect or a request). In the
  default configuration the scene is always captured (`R.PreRenderScene` requests it while `r_drawturbulents` is on,
  and it is on by default), and a `final` effect that is the only active one replaces the blit of `resolve` with its
  own last pass, so it costs no extra pass; with other effects it is one more pass. Only with `r_drawturbulents 0`
  and nothing else active does a pulse bring the capture back, and for as long as it lasts.
- **Docs and typing.** `PostProcessEffectDescriptor` gains the timing and stage members and `'color-shift'`;
  `docs/post-process-effects.md` documents timing, stages and channels with the existing berserk, buy menu and game
  over examples extended by one fade each.
- **Tests:** a fake clock and fake effects pin the envelope (fade in, hold, fade out, restart by key, pause), the
  neutral blend, multi-entry application order, stage order, channel composition and the unchanged behavior of a
  plain `setStack` / `clearStack`.

## Color shifts in detail

Today there are two vocabularies for one thing: the engine's `Def.contentShift` slots (`contents`, `damage`, `bonus`,
`powerup`, `user1` to `user4`), the game's `contentShift` enum that `ClientEngineAPI.ContentShift` offsets by 4 into
the engine's user slots, the legacy console commands `bf` and `v_cshift`, and the Quake item bits in `CalcBlend`.
The engine also owns time for them (150 per second for damage, 100 for bonus and user slots) and the colors of
the damage and bonus flashes. Drawing is a separate special case: `R.PolyBlend` runs after `PostProcess.resolve`
and is skipped (replaced by a black screen) while the console is forced up.

With the generic entries above, a color shift is nothing special any more:

```ts
// source/shared/GameInterfaces.ts
export type PostProcessColorShiftDescriptor = {
  readonly color: Vector;  // 0 to 1 per channel
  readonly alpha: number;  // 0 to 1
};
// added to PostProcessEffectDescriptor:  { id: 'color-shift'; settings: PostProcessColorShiftDescriptor }
```

- **Persistent tints are stack entries** of a channel the game owns: the quad tint while the quad is held, the
  liquid tint from `viewContents`. The game sets them from `startFrame()` (which runs every client frame, unlike
  `draw()`, which `nohud` skips).
- **Flashes are pulses:** `engine.PostProcess.pulse({ id: 'color-shift', key: 'damage', settings: {...}, timing:
  { fadeOut: 0.6 } })`. Damage, a pickup, a secret. Restarting a key restarts the fade instead of stacking.
- **The effect** (`ColorShiftEffect`, renderer-registered after `blur`) receives all of its entries, mixes them in
  order with Quake's formula (`a = a + a2 * (1 - a)` per entry, the same clamps), scales by `gl_cshiftpercent`
  (the user's accessibility control, which is why mixing is not the game's), and draws one quad. `gl_polyblend`
  stays its off switch. The mixing is a pure function, `mixColorShifts(entries)`, tested without GL.
- **The Quake rates map exactly:** a flash with alpha `a` and a decay of `r` per second (in 0..255 units) has a
  `fadeOut` of `a * 255 / r`; the game computes it once where it declares the flash. The engine's default set
  (below) reproduces today's slot order, so Phase 2 does not change a pixel.
- **Dynamic-light coronas** stay engine-side: `RenderCoronas` adds a one-frame engine pulse instead of writing
  `V.blend` by hand.
- **While the console is forced up** the effect is inactive (the mix returns alpha 0), which keeps what `SCR` does
  today: no tint over the black background. Part of the Phase 0 characterization.
- **Defaults until the game half lands:** the engine registers a default set (content tints, the item tints,
  the damage and bonus colors) on its own channel so a game that does nothing looks as before; the game half
  (Phase 5) sets its own and the default is deleted, together with `Def.contentShift`, the game's offset enum
  and the `+ 4`, `ClientEngineAPI.ContentShift`, the item-bit block of `CalcBlend`, `ApplyDamage`'s color half,
  `R.PolyBlend`, `V.blend`, `bf` and `v_cshift` (the game's `BONUS_FLASH` event replaced the first command, the
  second only edited the clear-air tint).
- **Compatibility:** `ClientEngineAPI.ContentShift` stays for one phase as a deprecated forwarder that turns a call
  into a pulse with the old decay rate, so a game that has not moved yet keeps working; it is deleted with the
  forwarders in the last phase.
- **Test:** `mixColorShifts` (the two formulas, the clamps, `gl_cshiftpercent`, order dependence, below/above), the
  forced-up case, a fake-GL test of the effect ("active only above alpha 0, draws one quad with the mixed color"),
  and the game's HUD tests assert which entries and pulses it sets.

## Phasing

Every phase leaves `npm test`, `npm run typecheck` and `eslint` green and stops for a go-ahead. Phases 2 to 4
are pure moves (the capture pair of `scripts/renderer-capture` before and after; the view calculation is
covered by the numbers in its characterization tests as well, because the capture pins the camera). Phase 1 is
additive: nothing changes for a game that calls `setStack` as today.

- **Phase 0, safety net and the small fixes.** Characterization tests with a fake client state: `CalcRefdef` (bob,
  roll, kick, idle sway, the 14/22/30 clamp, step smoothing, punch angle, viewmodel placement), `CalcBlend`
  (priority of the powerup tint, decay, cap, `gl_cshiftpercent`), `DriftPitch`, `ApplyDamage`, `SCR.CalcRefdef`
  (the viewsize ladder, FOV from aspect), center-print wrapping, `UpdateScreen` ordering with a fake GL, and the
  forced-up case. Then decisions 1 and 2, the dead plaque flags removed, `smoothing` moved to `shared/` with
  `EntityLighting` and the tests re-pointed.
- **Phase 1, the post-process entry model.** Timing and `pulse`, `setStack` fade, multi-entry apply, stages,
  channels, in `PostProcess.ts`, the effects' `apply` signature (engine-internal) and `GameInterfaces.ts`;
  `docs/post-process-effects.md`. No game code changes. Browser: the existing color-grade and blur stacks of
  hellwave look as before; a pulse and a fade are checked by eye.
- **Phase 2, V's color shifts.** `color-shift` effect, `mixColorShifts`, the engine default set on its own channel,
  the `ContentShift` forwarder; `DynamicLights` and `ClientEngineAPI` switch; `R.PolyBlend`, `V.blend` and the
  `SCR` call are deleted; `docs/color-shifts.md` next to `post-process-effects.md`. Browser: the capture pair plus
  a damage flash, a pickup and a powerup by eye.
- **Phase 3, V's view.** `ViewCvars`, `ViewmodelMotion`, `PitchDrift`, `FirstPersonView`; `V` is deleted;
  `gamma` to `RendererCvars`.
- **Phase 4, SCR.** `Viewport` and `Camera.UpdateProjection`, the console slide (into `ConsoleOverlay`), `FramePacing`, `Screenshots`,
  `ScreenFrame`; `SCR` is deleted.
- **Phase 5, game handover**, one commit per item that the developer picks from G2 to G6 (G4 is decided: the game
  sets its entries and pulses and the engine default goes; G6 starts with the hellwave prototype), each with the
  engine half, the id1 and hellwave half in their repos, and `docs/game-module-contract.md`.
- **Phase 6, docs and cleaning up.** `docs/`, the instructions and skills name the new files; the forwarder ledger is
  empty. Also the cleaning up phase for the lint warnings the split leaves in files it touches: the 27
  `@typescript-eslint/unbound-method` warnings of `ClientHost.ts` (15), `ClientInput.ts` (5), `ClientLifecycle.ts`
  (3), `Draw.ts` (2) and `VID.ts` (2), and the two `jsdoc/require-returns` of `DedicatedHost.ts` (developer,
  2026-10-11: clean them up here). The fix for each is the `this: void` annotation the rule suggests, or a method
  registered as an arrow function; no behavior change.

### Phase 0: what shipped (2026-10-11)

Characterization first, then the small fixes, so the tests ran green against the code as it was before anything moved.

**The safety net** (6 new `.test.ts` files in `test/client/`, 99 tests; mutation-checked: dropping the 1/32 eye
nudge, the damage decay constant, the HUD height, the wrapping column, the black-screen branch and the step
threshold each turn a test red, after one case was added for the last):

- `view-refdef.test.ts`: `V.CalcRefdef` (eye height, the 1/32 nudge, walking bob and its cap, roll, damage kick,
  idle sway, the `scr_ofs` offsets and the 14/22/30 clamp, punch angle, step smoothing, the `viewsize` weapon
  nudge, the viewmodel from the game, the `updateRefDef` then chase order, drift when `v_pitchdrift` is on),
  `CalcIntermissionRefdef`, and `PreRenderView` (the order of the derived steps, forced-up, intermission, paused,
  the multiplayer offset reset).
- `view-color-shifts.test.ts`: `CalcBlend` (mixing formula and order, `gl_cshiftpercent`, the powerup priority,
  the decay rates, the cap), `SetContentsColor`, `ContentShift`, `BonusFlash_f`, `cshift_f`, `ApplyDamage`.
- `pitch-drift.test.ts`: `StartPitchDrift`, `StopPitchDrift`, `DriftPitch`.
- `scr-viewport.test.ts`: `SCR.CalcRefdef` (the view size ladder and the HUD heights 0/24/48, the 96 pixel
  minimum, the clamps, the intermission, FOV from aspect, the two projection scale entries).
- `scr-center-print.test.ts`: wrapping at 40 and at newlines, the timer, centering, the typewriter.
- `scr-update-screen.test.ts`: the order of a frame with a fake GL and recorded calls: connected, scene capture,
  intermission, connecting, forced-up (black screen instead of the tint, the console only when opened), pacing,
  refresh-rate detection, the two screenshots.

**The fixes**

- **Decision 1, the engine crosshair is gone.** `SCR.crosshair`, `crossx`, `crossy`, `disableCrosshair` and the
  branch in `UpdateScreen` are removed (the latent crash of finding 1 with them), and `CAP_HUD_INCLUDES_CROSSHAIR`
  is removed from `Defs.ts`. A game that still lists it is rejected at load with "unsupported capabilities", which
  a test pins. **Two game repos changed, not committed:** `source/game/id1/main.ts` and `source/game/hellwave/main.ts`
  lose the one line (and hellwave its now unused import), each needs its own commit, see `submodule-aware-commit`.
  A game built against the previous engine that lists the capability will not load on this one.
- **Decision 2, the dedicated server does not load the client `V`.** `createDedicatedServer` passes
  `new PlayerRollView()` as the server's view (as the server worker already did), and `DedicatedHost` lost its
  `view` dependency and `view.Init()`. A new test in `engine-boundaries.test.mjs` pins what the dedicated closure
  loads from `client/`: the same five model-loading files as the worker, no `V`, `R` or `Camera`. The browser's
  in-thread server (`?serverthread`) still takes its roll from the client's `V`, as that realm has one. Smoke:
  a production dedicated build boots on a spare port, loads `e1m1` and logs no error.
- **Dead plaque flags removed.** `disabled_for_loading` and `disabled_time` are gone, and with them the TODO in
  `ClientDemos.ts` that wanted to reset one (nothing reads the flag, so there was nothing left to reset).
- **`smoothing` moved to `source/shared/smoothing.ts`** (`smoothValue`, `shortestAngleDelta`, functions, since there
  are two). `V.SmoothValue` and `V.ShortestAngleDelta` are deleted without forwarders; `EntityLighting` no longer
  imports `V`. The tests moved to `test/shared/smoothing.test.ts` (adds the exact closing fraction, step
  composition and the half-turn edge); `v.test.mjs` keeps `CalcRoll` and `ComputeViewmodelLookBobTargets` until
  Phase 3.
- **Verified:** `npm test` 2114 pass (was 1992), `npm run typecheck` clean, `eslint` 0 errors on everything
  touched. No browser capture: nothing in this phase changes what the renderer draws, and `V` and `SCR` calculate
  from the same code as before (the new numbers are the proof). Pointer lock and input are not touched.

### Phase 1: what shipped (2026-10-11)

The post-process entry model, additive: a game that calls `setStack(stack)` and `clearStack()` as before sees no
change. `postprocess/PostProcessEntries.ts` is new and has no GL in it; `PostProcess` holds one instance.

- **`PostProcessEntries`** keeps the channels (in the order they were first used), each with its stack, the fade
  every entry is in, and its pulses. `setStack(stack, { channel, fade })`, `clearStack(channel?)`,
  `hasStack(channel?)`, `pulse(descriptor, { channel })`, `advance(dt)`, `collect(stage)` and `reset()`.
  `PostProcessEntries.blend` and `pulseIntensity` are pure statics.
- **Timing.** A pulse's `timing` is `{ fadeIn, hold, fadeOut }` seconds; its intensity runs 0 to 1 and back and
  moves the numbers an effect lists as `neutral`; anything else (a tint color, a pulse period) is taken as it is.
  The same `key` restarts a pulse. A pulse without any duration is shown for one frame. A stack fade is linear
  per entry between the old displayed settings (or nothing) and the new ones (or nothing, when it leaves).
- **Matching** an entry of a new stack to the previous one is by `key`, or by position among the entries of the
  same effect, so reordering needs keys. An entry that is gone fades out and is applied after the new ones; one that
  comes back while fading out is picked up from where it was.
- **Several entries of one effect are all applied.** `apply(input, x, y, w, h, settings)` receives the settings of
  its entry; `PostProcess.getStackEntry` is gone, so `ColorGradeEffect` and `BlurEffect` no longer look up "the
  first entry". The renderer's own effects get `null`.
- **Stages.** `scene` entries run in `resolveGameplayStack` as before; `final` entries run in `resolve` after the
  renderer's own effects, as its last pass, and replace the plain blit when they are all there is. An effect has a
  `defaultStage` (`scene` for both of today's).
- **The clock** is `PostProcess.advance()`, called once per rendered frame from `SCR.UpdateScreen` (so before
  `V.PreRenderView`, after the "frame still pending" return) on `Host.realtime`, clamped to 0.1 s per step. It is
  not `Host.frametime`, as the plan assumed: `Host.frametime` is the real frame delta and does not stop while the
  game is paused either, so nothing could make "a paused game does not fade" true, and it is not wanted.
- **Public surface:** `ClientEngineAPI.PostProcess` gained `pulse`, and `setStack`/`clearStack`/`hasStack` take
  the channel and fade. New types in `GameInterfaces.ts`: `PostProcessStage`, `PostProcessTiming`,
  `PostProcessPlacement`, `PostProcessEntryOptions`, `PostProcessPulseDescriptor`, `PostProcessStackOptions`,
  `PostProcessPulseOptions`. `timing` and `placement` exist on pulses only, so a stack entry that carries one is a
  type error and not a silent no-op. `PostProcess` is on `window.engine` now.
- **A bug that was already there, fixed on the way (found by the browser check):** `resolveGameplayStack` left
  the scene FBO bound, so with only a game stack active (no bloom, warp or underwater fog on) the scene was blitted
  into the FBO, the HUD was drawn into it too, and the screen stayed black with `GL_INVALID_OPERATION: Active draw
  buffers with missing fragment shader outputs` in the console. A bloom or warp that happened to be on masked it,
  since `resolve` binds the screen for its last effect. It now binds the screen again and puts the viewport back.
  The same black frame is on `HEAD` before this phase (built and captured), and a test pins the fix.
- **Tests:** new `post-process-entries.test.ts` (envelope, blend, stack order, repeats, null and unknown entries,
  stages, channels, fades in and out and mid-fade, key matching, tint carried whole, pulses incl. restart, stacking,
  placement, channels, zero duration, bad numbers, `advance` clamp); `post-process-stack.test.mjs` became
  `.test.ts` and covers the facade, the clock, `resolveGameplayStack` and `resolve` with recording effects and a fake
  GL, the effects' `neutral` and `resolveSettings`, and the unbind; `post-process-scene-capture.test.ts` and
  `scr-update-screen.test.ts` follow the new API and the `advance` call.
- **Verified:** `npm test`, `npm run typecheck` and `eslint` on touched files clean; browser, a production build
  against the id1 server, with the game paused: a grayscale stack takes the view's colorfulness from 14.5 to the
  3.5 of the un-graded PAUSE plaque and clearing brings it back; a 6 s cross-fade passes 14.4, 10.6, 6.6, 3.5 and
  back out to 14.7; a pulse (0.5/4/1.5 s) is gray while it holds, is gone after its end and `hasStack` stays
  false while `hasGameplayStack` is true; a `final` blur drops the edge measure from 4.6 to 1.7 and leaves the
  colors; two channels, with one cleared on its own, leave the other; with `r_bloom 1` on, a grayscale stack and a
  `final` blur on top of it also come out right (colorfulness 14.6, 3.6, 3.6 and back to 14.8, edge 4.6 to 1.7);
  no console errors beyond the usual 404s. Not covered: hellwave's own game-over and buy-menu stacks (they use
  the unchanged `setStack`), warp and underwater fog together with a stack, and a color-grade fade of `tintColor`
  by eye.

### Phase 2: what shipped (2026-10-11)

V's color shifts are entries of a `color-shift` post-process effect now, and `R.PolyBlend`, `V.blend`, `V.CalcBlend`
and the `SCR` call are gone.

- **`ColorShiftEffect`** (`renderer/postprocess/`, registered after `blur`, `final` stage, `stackable`). Settings
  `{ color, alpha }`, 0 to 1. `ColorShiftEffect.mix(layers, percent)` is the pure mixing (Quake's formula, the
  clamps), tested without GL, including that it equals laying the layers over a scene with ordinary alpha
  blending. The effect draws the input with the `pic` program and then one `fill` quad with blending, the two
  draws `resolve` and `R.PolyBlend` made before, so a frame with a tint costs what it did.
- **Entries that mix.** `PostProcessEntryEffect` and `PostProcessEffect` gained an optional `combineSettings(list)`;
  `PostProcessEntries.collect` hands a run of entries of such an effect to it and applies the one result, or none
  when it returns `null`. That is how "the effect receives all of its entries" is true with Phase 1's one-pass-
  per-entry model: the run is mixed in the order it is applied and drawn once. `gl_polyblend` 0 and a mix that
  covers nothing return `null`, so no pass runs at all.
- **`gl_cshiftpercent`** is in `RendererCvars` and created by `R.Init` after `gl_polyblend` (it was `V.Init`'s). The
  `cvarlist` order changes by that one name; the order test pins it.
- **The engine's default set is `client/view/QuakeColorShifts.ts`** (the first file of `client/view/`). Deviation
  from the plan: it keeps Quake's eight slots in `clientRuntimeState.cshifts` and their decay, and each frame
  (`Update`, called where `CalcBlend` was) hands one entry per slot that covers something to the stack, in slot
  order, on the channel `engine.color-shifts`. Pulses are not used for damage and the pickup flash, because a new
  damage flash is added to what is left of the last one (3 per point, at most 150) and the mixing order of the
  slots has to stay exactly Quake's; both are the engine default's, and the game's half (phase 5) uses pulses.
  `V` keeps the view kick of `ApplyDamage`, and calls `QuakeColorShifts.Damage` for the color half.
  `v_cshift` and `bf` are registered by `QuakeColorShifts.Init()`, which `V.Init()` calls.
- **`ClientEngineAPI.ContentShift`** is a deprecated forwarder to the user slots (`slot + 4`), as before, with
  the JSDoc saying what to use instead. It is deleted with the default set in phase 5.
- **The corona** (a dynamic light the eye is inside of, `gl_flashblend` on) is a one-frame pulse on the channel
  `engine.corona`, mixed after the engine's slots, and only while the frame is captured (`PostProcess.active`),
  because a pulse started during the draw would otherwise turn the capture on for a scene that was not drawn into
  it. **One visible change:** the old code computed its red channel from the green one
  (`V.blend[0] = V.blend[1] * ...`), so the glare's color depended on what the tint was; it is plain orange now.
- **Forced up.** `V.PreRenderView` clears the engine's channel while the console is forced up, so no tint is left
  to keep the capture on and `SCR` only draws the black screen.
- **Tests.** `view-color-shifts.test.ts` became `quake-color-shifts.test.ts` and keeps every Phase 0 expectation,
  read through what the stack would draw (plus the channel, `gl_polyblend`, the corona and `Clear`);
  `color-shift-effect.test.ts` (mixing, settings, `combineSettings`, `apply` with a recording GL: the blit, the
  quad over the same rectangle with bytes clamped and rounded, the blend state left as the chain expects);
  `corona-tint.test.ts`; run mixing in `post-process-entries.test.ts`; `renderer-init` (the cvar and the effect)
  and `scr-update-screen` (no `PolyBlend` call, the black screen when forced up) follow.
- **Docs.** `docs/color-shifts.md` is new (the effect, mixing, the player's two controls, setting a tint and a flash
  from a game with the Quake rate mapping, what the engine tints with); `post-process-effects.md` lists the effect
  and `combineSettings`.
- **Verified:** `npm test` 2190 pass, `npm run typecheck` clean, `eslint` on touched files; browser, production builds
  of HEAD and the working tree: three captures per side show nothing beyond the noise between captures of one build
  (`r_speeds` identical), and the same scenarios on both builds give the same mean colors within animation noise:
  no tint 36.3 against 36.4, a clear-air tint of 255 0 0 at 128 142.7 against 142.6, at 50 percent 89.5 against
  89.4, with `gl_polyblend 0` 36.2 against 36.3, with the quad 32.9 against 32.8, and red + quad + bloom 125.8
  against 126.5. On the new build: the pickup flash falls 32, 17, 8 (from 50 at 100 per second), a 40 damage hit
  47, 22 (at 150), the corona is orange at 0.09, a game pulse mixes in, and with nothing active there are no entries
  and no capture request. **Not covered:** the liquid tints in the browser (the capture's map, the start hall,
  has none, the earlier captures found lava on it; `SetContentsColor` is covered by the unit test), and the
  tint through `r_drawturbulents 0`.

### Phase 3: what shipped (2026-10-11)

`V.ts` is deleted. Its members went to the classes of the target table, in `client/view/`, with no forwarder left.

- **`ViewCvars`** (`view/ViewCvars.ts`, the `ClientCvars` shape: fields only, one exported instance, imports the
  `Cvar` type only) holds the 21 view cvars, with a description of each. `FirstPersonView.Init()` creates them in
  the order `V.Init` did.
- **`FirstPersonView`**: `Init`, `CalcRefdef`, `CalcIntermissionRefdef`, `ApplyDamage` (the view kick, the event, the
  face animation, and a call to `QuakeColorShifts.Damage`), and the state `dmg_time`, `dmg_roll`, `dmg_pitch`, `oldz`.
  A body moved verbatim, only the names of what it reads changed. The roll is `calcRoll` of `shared/PlayerRoll.ts`
  called with the two cvars, so `CalcRoll` and its `FIXME` are gone.
- **`ViewmodelMotion`**: `CalcBob`, `ComputeLookBobTargets` (was `ComputeViewmodelLookBobTargets`), `Advance(bob,
  pitch, yaw)` for the smoothing that `CalcRefdef` did inline, `Reset()`, and the public `bob`, `lookBobRight`,
  `lookBobUp`. The module state of the old `V` is here and no longer private to a facade nobody could reset.
  **`FirstPersonView.Init()` resets it on `server.spawning`**, so the weapon does not glide in from the previous
  map's values (the quirk of finding 8, free to fix here).
- **`PitchDrift`**: `Init` (the `centerview` command), `Start`, `Stop`, `Update`; `ClientInput` and `IN` call it.
- **`gamma`** is in `RendererCvars` and created by `R.Init` after `gl_cshiftpercent` (same flags: archive and cheat);
  `FrameUniforms` keeps its clamp. The configuration runs after every init, so an archived value still reaches it.
- **`PreRenderView` and `RenderView` moved to `SCR`**, unchanged, because `SCR` drives them and that ends the `V` and
  `SCR` import cycle; phase 4 turns them into the steps of `ScreenFrame`. `FirstPersonView` still imports `SCR` for
  `viewsize` (the weapon nudge), the one cycle that remains, gone with `Viewport` in phase 4.
- **In-thread server (`?serverthread`)**: `PlayerRollView` takes the cvar object it reads the roll from, and the page
  passes `viewCvars`, which is filled in later and read when a roll is asked for. The dedicated server and the
  worker construct it with its own cvars, as before. `window.engine.V` is `window.engine.FirstPersonView` now.
- **Tests.** `v.test.mjs` is deleted: its smoothing tests moved in phase 0, `CalcRoll` is `test/shared/
  player-roll.test.ts` (adds the cap and the zero case) and `ComputeViewmodelLookBobTargets` is in the new
  `viewmodel-motion.test.ts` (the bob formula, its off switches and caps, the targets, `Advance` on the first and the
  next frames, the short way round the yaw, settling, `Reset`). `view-refdef`, `pitch-drift`, `quake-color-shifts`,
  `scr-update-screen` and `frame-uniforms` are re-pointed with every expectation kept, except the weapon bob of
  the first frame, which is exact now that tests `Reset()` instead of running quiet frames. Docs and instructions
  no longer name `V` or `V.ts`.
- **Verified:** `npm test` 2205 pass, `npm run typecheck` clean, `eslint` 0 errors on touched files; browser, a live
  (unpaused) game on production builds of `HEAD` and the working tree, same script: standing eye height 22.03 on
  both, a walk at 200 units per second bobs the eye and the weapon (range 5.6 and 4.5, sampled at arbitrary phases of
  a 0.3 s cycle) and not with `cl_bob 0`, `v_idlescale 1` sways the pitch by about 3 degrees, a 40 damage hit from
  the side rolls the view -12 and back (-7.9, -3.8, 0 against -7.8, -4.4, -0.8, timing noise), and `gamma`,
  `v_centerspeed`, `centerview` and `cl_rollangle` exist with their defaults. No console error beyond what `HEAD` prints.
  Not covered: the browser's in-thread server roll (the unit test covers `PlayerRollView` with injected cvars),
  and pitch drift by hand (pointer lock and look keys, covered by the unit tests).

### Phase 4: what shipped (2026-10-11)

`SCR.ts` is deleted. Its members are in `client/view/` (what reads the client state to place the view) and
`client/screen/` (the frame and what is drawn on it).

- **`Camera.UpdateProjection(fovY, aspect)`** is the only writer of `perspective[0]` and `[5]` now. `Viewport` calls
  it, and `R.DrawViewModel` calls it twice (the weapon's narrower field of view, then the world's again) instead of
  repeating the formula.
- **`view/Viewport`**: `fov`, `viewsize`, `sizeup`, `sizedown`, the rectangle and the field of view
  (`Recalculate`, the old `CalcRefdef` unchanged), `Update` (what notices a change of `fov` or `viewsize`),
  `Invalidate` (new map, resize of the screen), and `hudReservedHeight`. `fov` and `viewsize` are in `ViewCvars`.
  `FirstPersonView` reads `viewCvars.viewsize`, which removes the last import cycle of the view.
- **`screen/ScreenFrame`**: `Init` (creates everything the screen has, in the order `cvarlist` showed it), `Update`
  (the old `UpdateScreen` up to the request for the frame), `Prepare` and `RenderScene` (was `PreRenderView` and
  `RenderView`), and the frame as private steps: the draw callback, `#resolve`, `#drawOverlays`, `#finish`. The
  loading plaque is here too (`BeginLoadingPlaque`, `EndLoadingPlaque`), which is not where the plan put it
  (`ClientHost`/`CL`): what it does is to put the console slide and the center print away, state that lives in the
  screen, so the screen is the one place that has to know.
- **The console slide is part of `ConsoleOverlay`** (review, 2026-10-11: a separate `ConsoleSlide` had no state of
  its own, it only read `isOpen` and wrote `forcedup`, and its height was the same quantity as `vislines`): `current`,
  `conspeed` (`scr_conspeed`, created in `ConsoleOverlay.Init`), `Update`, `Draw`, `IsPassiveBackdrop`, `Reset`.
  It stays in `client/` and stays one class: the console is one unit, and drawing it is client only. **`CenterPrint`**
  (`Print`, `Draw`, `Clear`, the lines and the timer), **`ScreenIndicators`** (net, turtle, pause),
  **`Screenshots`** (the two commands, `TakeRequested`, `BeginClean`, `EndClean`) and **`FramePacing`** (`FPS`,
  `Record`, `Reset`). Bodies moved verbatim, except `FramePacing`.
- **`FramePacing` changed behavior, as agreed** (quirk 1): the refresh rate is the next step of 15 up only once the
  frame rate is clearly above the current one (the tolerance is 5 percent: 63 for 60), and it is set only after
  the same pick held for a whole window of 30 frames, after ten windows have been drawn. A browser that delivers
  60.0004 FPS gets 60, where it got 75 before. The headless run of the verification below showed exactly that:
  `Host.refreshrate` is 75 on the build of `HEAD` and 60 on this one.
- **Callers**: `ClientHost`, `ClientConnection`, `ConsoleOverlay`, `ClientServerCommandHandlers`, `ClientEngineAPI`
  (the game-facing `engine.SCR.viewsize` and `viewRect` are unchanged, they read `ViewCvars` and `Camera`) and
  `createBrowserClient` (`window.engine.SCR` is `window.engine.ScreenFrame` now).
- **Tests.** The characterization tests of phase 0 moved with their code: `viewport`, `center-print`,
  `screen-frame` (the order of a frame, with `ScreenIndicators.Draw` as one step), and new `console-slide`,
  `screenshots`, `screen-indicators` (the `DrawNet` regressions are kept) and `frame-pacing` (the window, the
  threshold, "not from a single window", already set) plus `Camera.UpdateProjection` and `Viewport.Update`. `scr.test.mjs`
  is gone. Tests of other parts that stub `engineMocks.SCR` keep working through `test/support/screen.ts`, which
  sorts the old members onto the new classes the way `useRendererOf` does for the renderer; `.github/instructions/
  unit-tests.instructions.md` says so, and new tests patch the classes directly. Mutants (the open height of the
  slide, the order of `PostProcess.advance` and `Prepare`, a HUD height, the tolerance) are caught.
- **Verified:** `npm test` 2234 pass, `npm run typecheck` clean, `eslint` 0 errors on touched files; browser, production
  builds of `HEAD` and the working tree: three captures per side show nothing beyond the noise between captures of
  one build with identical `r_speeds`; the pause sign, HUD, the console drawer over the scene and the menu over the
  game draw as before (screenshots of both builds side by side, the pixel differences are the view settling after
  spawn); no console error beyond the usual. Not covered: a center print on screen (the unit tests cover wrapping,
  timing and the typewriter), the net and turtle indicators in the browser, and `screenshot`/`screenshot_clean`
  downloads (unit tests only).

## Testing

- New tests are `.test.ts` in `test/client/` (one level, glob-safe); `v.test.mjs` and `scr.test.mjs` are replaced.
- Game-side items (Phase 5) add tests under `source/game/<mod>/test/`.
- Browser: the capture pair for Phases 2 to 4 (Phase 1 changes nothing a capture shows; its pulse and fade are
  checked by eye on a hellwave map). Phase 5 items that change what is drawn (G2, G3, G4) are checked by eye on
  `e1m1` and one hellwave map. Pointer lock and mouse look are not touched by Phases 0 to 4; `PitchDrift` moves in
  Phase 3 and the input path around it is read, not run.
- Dockerfile: sources and tests are copied whole; no change expected.

## Open questions (parked 2026-10-11)

Closed on 2026-10-11: where `Viewport` lives (decision 4); that color shifts are post-process entries (decision 6);
placement and timing as generic features (decisions 7 and 8). The four below are **parked** by the developer: nobody
works on them now, and each one has a default so that nothing waits for an answer by accident. "Needed by" is the
phase that has to settle it before it starts; every phase stops for a go-ahead anyway.

| # | Question | Needed by | Default if not decided |
|---|---|---|---|
| 1 | G6: is the interface in "G6 in detail" enough once prototyped in hellwave, or does the game keep only `updateRefDef`? (the developer is unsure) | Phase 5, G6 only | The engine keeps `FirstPersonView`; G6 is not started |
| 2 | ~~Channels: is `setStack(stack, { channel })` the right shape, or should a game register channels up front?~~ | Phase 1 | **Settled 2026-10-11 by the developer:** `setStack(stack, { channel })`, default channel `'default'`, so every existing call is unchanged |
| 3 | ~~Neutral settings per effect: where they live, and how a non-numeric setting interpolates~~ | Phase 1 | **Settled 2026-10-11 by the developer:** a `neutral` member of each effect; `tintColor` of the grade stays, its strength carries the intensity |
| 4 | Order of the frame: the game sets the liquid tint from `viewContents`, which needs the view leaf, which needs the final view origin (from the game itself with G6): previous frame's leaf, or looked up again after the game's view result? | Phase 2 | The previous frame's leaf (one frame of lag, invisible in practice) |

Phase 0 (characterization tests and the small fixes) depends on none of them.

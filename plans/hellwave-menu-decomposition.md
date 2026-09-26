# Split hellwave's Menu.ts into a `menu/` module, and move the buy menu into it

**Status:** Done (checked in the tree 2026-09-21; this plan has no per-phase "what shipped"
notes, and whether the manual click-through under "Verification" was run is not recorded). All
seven files of the layout below exist in `source/game/hellwave/client/menu/`, with `Menu.ts` as
the 54-line composition root. The buy menu moved out of `HUD.ts`: `HellwaveHUD` constructs a
`HellwaveBuyMenu` and delegates to it. The tests were split into
`source/game/hellwave/test/client/` and `source/game/hellwave/test/client/menu/`, and
`hellwave-client.test.mjs` no longer exists. All three items under "Recommendations flagged for
your review" landed as recommended: `MenuCommon` is a static-method class, `BuyMenu` holds a
reference to its `HellwaveHUD`, and the test reorganization took the larger option. The text
below describes the layout before the split.

## Context

`source/game/hellwave/client/Menu.ts` is 794 lines and building toward 1k. It's a single
static-only `HellwaveMenu` class that builds and registers four unrelated pages (`main`,
`hellwave_profile`, `hellwave_newgame`, `hellwave_newgame_settings` — see
`plans/hellwave-main-menu-rework.md` for how each came to exist) plus a pile of shared geometry
constants and small draw/layout helpers used across them.

Separately, the buy menu (opened with `hw_buymenu`/`b` inside a `func_buyzone`) is *not* in
`Menu.ts` at all — it's ~180 lines of `HellwaveHUD` (`source/game/hellwave/client/HUD.ts:264-424`,
see `plans/hellwave-buy-menu-mouse.md` for how it became a real `MenuPage` instead of a manually
drawn overlay). It's conceptually a menu page exactly like the other four, just historically grown
inside the HUD class instead.

Both files mix multiple cohesive-but-independent concerns in one place, which is what makes them
hard to navigate: `Menu.ts` currently interleaves four pages' worth of state/logic/constants, and
`HUD.ts` interleaves genuine HUD concerns (status bar, player names, round timer) with an entire
menu page's worth of unrelated logic.

This plan is a **pure structural refactor** — no behavior, layout, or visual change. Nothing in
`plans/hellwave-main-menu-rework.md` or `plans/hellwave-buy-menu-mouse.md` is being revisited;
this only relocates their code.

### Precedent already in this codebase

- The engine itself splits its menu toolkit into `source/engine/client/menu/{MenuItem,MenuPage,
  MenuStack,SaveSlots,SessionDiscovery}.ts` — one file per cohesive concern, entry point
  (`Menu.ts`, the `M` class) stays one level up. This plan mirrors that shape on the game side.
- `source/game/id1/test/client/` already nests tests under `client/` (`client.test.mjs`,
  `menu.test.mjs`) separately from `test/core/`, `test/entity/`, etc. — hellwave's `test/` is
  currently flat; this is a natural point to start mirroring that convention for the files this
  plan touches (not a repo-wide reorg).

## Goals

- Split `client/Menu.ts` into `client/menu/{Menu,MenuCommon,MainMenu,ProfileMenu,NewGameMenu,
  NewGameSettingsMenu}.ts` — one file per page, plus one shared-helpers file.
- Extract the buy menu out of `HUD.ts` into `client/menu/BuyMenu.ts`, as its own class owned by
  `HellwaveHUD` (not a static grab-bag of HUD private methods).
- Keep exactly one public entry point, `HellwaveMenu.Init(engineAPI)`, so `ClientAPI.ts` only
  needs its import path updated (`'./Menu.ts'` → `'./menu/Menu.ts'`).
- No new abstractions beyond what the split itself needs — no speculative extensibility.
- Mirror the source split in the test suite (see Testing below), since the existing
  `hellwave-client.test.mjs` (1281 lines) already has one `describe` block per page/concern —
  it just needs to be cut along the same lines the source is being cut along.

## Non-goals

- No changes to `source/game/id1/client/Menu.ts` (735 lines, single file). It's a different
  situation — id1 owns a smaller, more homogeneous set of "classic front end" pages — and
  splitting it isn't asked for here. Worth a follow-up someday, not bundled into this.
- No changes to the engine's own `source/engine/client/menu/` toolkit.
- No behavior, copy, or layout changes to any page. If something looks worth fixing while moving
  it, note it instead of fixing it inline (keeps this refactor's diff reviewable).

## Design

### File layout

```
source/game/hellwave/client/menu/
  Menu.ts                 -- HellwaveMenu.Init(): thin orchestrator, unchanged public API
  MenuCommon.ts           -- shared constants/helpers used by 2+ pages
  MainMenu.ts             -- 'main': sidebar + live session list
  ProfileMenu.ts          -- 'hellwave_profile': name/color page + the profile gate
  NewGameMenu.ts          -- 'hellwave_newgame': map picker
  NewGameSettingsMenu.ts  -- 'hellwave_newgame_settings': rounds/private-game + Start
  BuyMenu.ts              -- 'hellwave_buy': relocated out of HUD.ts
```

Each page file keeps the existing static-class shape `HellwaveMenu` already uses today (a
static-only class with private static state) — just one class per page instead of one class for
all four. This keeps the codebase's established "group into a class, static members" convention
(`code-style-guide.instructions.md`) consistent across every file in the new folder, including the
ones (`MainMenu`) that would otherwise be a single exported function.

### Dependency graph (no cycles)

```
MenuCommon.ts   <- leaf, no deps on siblings
ProfileMenu.ts  <- MenuCommon
NewGameMenu.ts  <- MenuCommon
NewGameSettingsMenu.ts <- MenuCommon, NewGameMenu (reads the selected map)
MainMenu.ts     <- MenuCommon, ProfileMenu (enforces the profile gate)
BuyMenu.ts      <- (none of the above; lives alongside them because it's a page, not because it
                    shares code with the other pages)
Menu.ts         <- all of the above (composition root only)
```

`MainMenu` depending on `ProfileMenu` and `NewGameSettingsMenu` depending on `NewGameMenu` aren't
refactor artifacts — they're the actual product relationships already in the code today (the
profile gate is enforced by whatever wants to open a game; the settings screen shows whichever map
the picker just selected). Making them explicit imports instead of same-class private-static
access is most of the point of this split.

### `MenuCommon.ts`

Everything genuinely shared by 2+ pages, and nothing that's only used by one:

- `RowLayout` interface (today declared once, used by `MainMenu`'s custom two-column layout, the
  map-picker's card layout, and `buildTrailingActionLayout`'s own return type).
- `toScreenPosition(engineAPI, x, y)` — used by `MainMenu` (logo), `NewGameMenu` (card pictures +
  hover border), `NewGameSettingsMenu` (map preview picture).
- `wrapLabel(label, maxChars)` — used by `NewGameMenu` (card labels) and `NewGameSettingsMenu`
  (selected-map label on the settings screen).
- `buildTrailingActionLayout(fieldsLayout, fieldCount)` and the `BOTTOM_RIGHT_BUTTON_X`/`_Y`
  constants — used by `ProfileMenu` and `NewGameSettingsMenu`, both of which pin one primary
  call-to-action button to the same shared corner.
- The header `BitmapFont` module state (`menuFont`) and a setter, since
  `buildTrailingActionLayout` needs it to measure the trailing button's label width, and `Menu.ts`
  is what loads the font.

Constants that today live in `Menu.ts` but are only read by one page (`SIDEBAR_X`, `SESSIONS_X`,
`ROWS_START_Y`, `ROW_SPACING`, `CURSOR_MARKER`, `CARD_WIDTH`, `CARD_GAP`, `CARDS_START_Y`,
`CARD_HOVER_BORDER_COLOR`/`_THICKNESS`, `HEADER_FONT_*`, `ROUNDS_MIN`/`MAX`/`DEFAULT`,
`SETTINGS_*`) move with their one consumer, not into `MenuCommon.ts` — no point sharing something
nothing else reads. `CARD_LABEL_LINE_HEIGHT` is the one exception: `NewGameSettingsMenu` reuses it
for its own wrapped label, so it's really a generic "wrapped small-text line height," not a
card-specific constant — rename to `LABEL_LINE_HEIGHT` and place it in `MenuCommon.ts`.

### `Menu.ts` (entry point)

Shrinks to the orchestration `Init()` already does today, just delegating instead of inlining:

1. `ProfileMenu.build(engineAPI)` — registers `'hellwave_profile'`, registers
   `hw_profile_confirmed`, loads `bigbox`/`menuplyr` itself, returns `[acceptAction]`.
2. `NewGameMenu.build(engineAPI)` — registers `'hellwave_newgame'`, loads map screenshots itself.
3. `NewGameSettingsMenu.build(engineAPI)` — registers `'hellwave_newgame_settings'`, returns
   `[startAction]`.
4. `MainMenu.build(engineAPI)` — registers `'main'`, loads the hi-res logo itself, returns the
   sidebar `Action`s.
5. `engineAPI.Menu.SetRootPage('main')`.
6. Load `gfx/header-font.png`, and once it resolves, attach it to the concatenation of all three
   returned action arrays (`NewGameMenu`'s cards deliberately don't use the header font today —
   digits/brackets aren't in its charset — so it isn't in this list, same as now).

Every asset each page uses only for itself (hi-res logo → `MainMenu`; `bigbox`/`menuplyr` →
`ProfileMenu`; map screenshots → `NewGameMenu`) moves to being loaded inside that page's own
`build()`, instead of all being kicked off up front in one shared `Init()`. This is a real (small)
behavior-neutral improvement: each file becomes independently readable without having to trace
back to `Menu.ts` to see what it depends on being preloaded.

### `BuyMenu.ts` — the bigger structural change

Today `HellwaveHUD` owns: `#buyMenuActions`, `#buyMoneyLabel`, `#buyFeedbackLabel`,
`#buyFeedbackExpiry`, a static `#activeHUD` (so the module-level `hw_buymenu` command can reach
whichever HUD instance is currently live), `#registerBuyMenu`, `#refreshBuyMenuActions`,
`#refreshBuyMoneyLabel`, `#refreshBuyMenuIfOpen`, `#updateBuyzonePostProcess`, and half of
`#drawBuyMenu` (the other half is the "Buyzone!" prompt, which isn't part of the menu page at
all — see below). Plus the static `Init`/`Shutdown` pair that registers/unregisters the
`hw_buymenu` command.

Proposed: a `HellwaveBuyMenu` class, one instance per `HellwaveHUD` instance, constructed in
`HellwaveHUD.init()` and holding a plain (not `WeakRef`) reference back to its owning HUD — the
same "hold a reference to the owner, read its public state directly" shape the game-logic side
already uses for `EntityWrapper<T>` (`DamageHandler`, `AI`, `Sub`), just without the `WeakRef`:
entities need that because of serialization/edict-recycling concerns that don't exist for a
client-side HUD object with a plain one-map-load lifetime.

```typescript
export default class HellwaveBuyMenu {
  static #active: HellwaveBuyMenu | null = null;

  readonly #hud: HellwaveHUD; // reads hud.game.clientdata.buyzone, hud.inventory.money, hud.stats
  readonly #engine: ClientEngineAPI;
  // ...#actions, #moneyLabel, #feedbackLabel, #feedbackExpiry -- same shape as today, just moved

  constructor(hud: HellwaveHUD, engine: ClientEngineAPI) { ... }

  register(): void { /* builds + RegisterPage('hellwave_buy', ...); sets #active = this */ }
  dispose(): void { /* clears #active if it's still this instance */ }
  refreshIfOpen(): void { ... }         // was #refreshBuyMenuIfOpen
  showFeedback(message: string): void { ... }  // was the BUY_MESSAGE handler body
  tick(gametime: number): void { ... }  // feedback-expiry-only, called every HUD frame
  isOpen(): boolean { return this.#engine.Menu.IsOpen('hellwave_buy'); }

  static Init(engineAPI: ClientEngineAPI): void { /* registers hw_buymenu, unchanged */ }
  static Shutdown(engineAPI: ClientEngineAPI): void { /* unregisters it, unchanged */ }
}
```

`HellwaveHUD` shrinks to:

```typescript
#buyMenu!: HellwaveBuyMenu;

override init(): void {
  super.init();
  this.#buyMenu = new HellwaveBuyMenu(this, this.engine);
  this.#buyMenu.register();
}

override shutdown(): void {
  super.shutdown();
  this.#buyMenu.dispose();
}
```

with the `buyzone`/`money`/`BUY_MESSAGE` event handlers in `_subscribeToEvents()` now one-line
delegations (`this.#buyMenu.refreshIfOpen()`, `this.#buyMenu.showFeedback(message)`, etc.) instead
of inline logic, and `draw()` calling `this.#buyMenu.tick(this.engine.CL.gametime)` where it used
to call the feedback-expiry half of `#drawBuyMenu` directly.

**What stays on `HellwaveHUD`, deliberately:**

- `#drawAccountBalance` / `#drawRoundStats` — these are status-bar displays (top-of-screen money
  counter, round/wave counter), not the purchase-catalog page. They read `inventory.money` and
  `stats`, same as always; the buy *menu page* just also happens to read the former.
- The "Buyzone!" prompt (today the other half of `#drawBuyMenu`) — it's the pre-menu invitation
  drawn on the world HUD while standing in a zone, not part of the menu page itself. Renamed to
  `#drawBuyzonePrompt` for clarity now that it's not sharing a method with the actual menu logic.
- `updateBuyzonePostProcess`'s *decision* of whether the game-over stack should win over the buy
  blur (`this.stats?.phase !== phases.gameover`) — `BuyMenu` needs to trigger it (on the buy
  page's `onEnter`/`onExit`) but the gating condition is HUD-owned state. Simplest fix: expose a
  small public method on `HellwaveHUD` (e.g. `setBuyMenuBlur(active: boolean)`) that does the
  `phases.gameover` check and calls `PostProcess.setStack/clearStack` itself; `BuyMenu` calls
  `this.#hud.setBuyMenuBlur(true/false)` rather than reaching for `this.#hud.stats` directly. This
  keeps the boundary rule from `code-style-guide.instructions.md` ("avoid accessing private
  members of other classes — add a public method instead") intact without inventing a bigger
  callback-injection abstraction for a single call site.

`buymenuPostProcessStack` and the `BUY_MENU_START_Y`/`_SPACING`/`_CURSOR_X` constants move with
the class into `BuyMenu.ts` unchanged. Import paths shift one level (`../Defs.ts` →
`../../Defs.ts`, `../entity/Player.ts` → `../../entity/Player.ts`) since the file moves into
`client/menu/`.

## Testing

`source/game/hellwave/test/hellwave-client.test.mjs` (1281 lines) already has one `describe` block
per concern this plan is separating — the cut lines already exist, just not as file boundaries:

| Current `describe` (line) | Moves to |
|---|---|
| `'hw_buymenu command registration'` (283), `'buy menu as a real menu page'` (360) | `test/client/menu/buy-menu.test.mjs` |
| `'Hellwave HUD'` (225, minus the two above) | `test/client/hud.test.mjs` |
| `'Hellwave client API'` (537) | `test/client/client-api.test.mjs` |
| `'Hellwave main menu'` (670), `'Hellwave live session list'` (1116) | `test/client/menu/main-menu.test.mjs` |
| `'Hellwave profile page'` (780) | `test/client/menu/profile-menu.test.mjs` |
| `'Hellwave new game map picker'` (884) | `test/client/menu/new-game-menu.test.mjs` |
| `'Hellwave new game settings'` (961) | `test/client/menu/new-game-settings-menu.test.mjs` |

This mirrors `source/game/id1/test/client/` (which already nests `client.test.mjs`/
`menu.test.mjs` under `test/client/`), extended one level further for the pages, matching
`unit-tests.instructions.md`'s "mirror the source layout with folders... when that keeps related
tests easier to find" guidance.

The shared test rigs at the top of the current file (`createBuyMenuHud`, `createMainMenuRig`,
`withMockTimers`, `createClientdata`, `createHellwaveGame`, `expectedBuyRowLabel`) split the same
way their consumers do: `createBuyMenuHud` → a `fixtures.ts` (or inline) in
`test/client/menu/buy-menu.test.mjs`; `createMainMenuRig` gets **split further** since it currently
captures all four page registrations in one rig — after this refactor, each menu test file only
needs to capture its own page, so this becomes a smaller, per-file `createXRig()`, or a shared
`test/client/menu/fixtures.ts` if enough duplication would otherwise result (decide once actually
writing the tests — likely the latter, since every rig still wraps the same
`createMockMenuAPI()`/`createMockClientEngine()` pair).

No new test *assertions* — this is a move, not new coverage. Existing coverage should come out
identical, just reorganized.

## Phasing

Land as two checkpoints rather than one big diff, so a regression in one is easy to isolate from
the other:

1. **Page split**: `Menu.ts` → the six `client/menu/*.ts` files. Update the one import site
   (`ClientAPI.ts`). Split/move the menu-related test `describe` blocks into `test/client/menu/`.
   `eslint --fix`, `tsc --noEmit`, `npm run test:game` green.
2. **Buy menu extraction**: `HUD.ts` → `client/menu/BuyMenu.ts` + the `HellwaveHUD` delegation
   shrink. Move the two buy-menu `describe` blocks into `test/client/menu/buy-menu.test.mjs`. Same
   verification.

After each phase: since this reshuffles page-registration order, cross-file wiring (the profile
gate, the font-attachment list, the map-picker → settings-screen selection handoff) and nothing
here is covered by a visual regression test, do a quick manual boot + click-through of the actual
main menu → profile → new game → settings → buy menu flow before calling either phase done,
per this repo's usual practice for anything touching menu wiring — not because behavior is
expected to change, but because "the page still registers and opens in the right order" is
exactly the kind of thing a pure file-move can silently break and unit tests alone wouldn't catch
(wrong import order, a forgotten re-export, a page registered under the old class's static state
instead of the new one's).

## Recommendations flagged for your review (not locked in)

- **`MenuCommon.ts` as a static-method class** (`MenuCommon.toScreenPosition(...)`, etc.) rather
  than plain exported functions — consistent with the "group >3 related helpers into a class"
  style rule and with every other file in this split being a static class. Open to just exporting
  plain functions instead if you'd rather keep it lightweight, since none of them hold state
  except the font.
- **`BuyMenu` holding a plain reference to its owning `HellwaveHUD`** (reading `hud.inventory`,
  `hud.game.clientdata` directly) rather than three injected callbacks
  (`getMoney`/`getBuyzone`/`isGameOver`). Recommended because it mirrors the existing
  `EntityWrapper<T>` convention and is less ceremony for a class that will only ever have one
  owner type; flagging in case you'd rather keep `BuyMenu` fully decoupled from `HellwaveHUD`'s
  shape for standalone testability.
- **Test reorg depth** — moving everything into `test/client/` + `test/client/menu/` is a bigger
  diff than strictly necessary for just the buy-menu move. If you'd rather keep
  `hellwave-client.test.mjs` mostly intact and only carve out the buy-menu tests, say so and I'll
  scope Phase 2's test changes down to just that.

## Verification

- `npx eslint --fix source/game/hellwave/client/menu/*.ts source/game/hellwave/client/HUD.ts source/game/hellwave/client/ClientAPI.ts`
- `npx tsc --noEmit`
- `npm run test:game`
- Manual: `npm run dedicated:dev` + browser client against `?game=hellwave` — boot to the main
  menu, open Profile, back out, open New Game → pick a map → settings screen → Start, then in a
  live round walk into a buyzone and open/close the buy menu with both keyboard and mouse.

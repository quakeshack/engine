# Menu System

The client menu system is a stack-based, widget-driven UI framework, split the way Quake III
Arena splits the engine from `ui`/`cgame`: the engine owns the toolkit (widgets, layouts,
navigation stack, drawing primitives, mouse/back-button handling) and has zero opinion on menu
*content*. Every actual screen — main menu, options, save/load, the multiplayer lobby, and so
on — is built by game code (`source/game/id1/client/Menu.ts`) through `ClientEngineAPI.Menu`,
the same public-API boundary every other piece of game code uses.

It also doubles as a general-purpose declarative-panel toolkit: nothing in `MenuPage`/`MenuItem`
depends on the pause-menu stack, so game HUD code can build a page and call `.draw()` on it every
frame for always-on, non-modal UI (see [Non-modal panels](#non-modal-panels-hud-embedded-ui)).

## Building blocks

| Class | File | Responsibility |
| - | - | - |
| `MenuItem` (+ subclasses) | `source/engine/client/menu/MenuItem.ts` | A single interactive or decorative row: label, focus state, draw, input handling. |
| `MenuLayout` (+ implementations) | `source/engine/client/menu/MenuPage.ts` | Positions a page's items on screen and draws the navigation cursor. |
| `MenuPage` (+ subclasses) | `source/engine/client/menu/MenuPage.ts` | A screen: an item list, a layout, and lifecycle hooks (`activate`/`deactivate`, `onEscape`/`onConfirm`, plus the composition hooks below). |
| `MenuStack` | `source/engine/client/menu/MenuStack.ts` | Named page registry, a navigation stack (push/pop/replace/clear), and the root-page concept (see below). |
| `M` | `source/engine/client/Menu.ts` | Owns the single `menuStack` instance and the pixel-drawing primitives (`M.Print`, `M.DrawPic`, `M.DrawTextBox`, `M.DrawSlider`, ...) that widgets call into. Builds **no pages** — it's pure machinery. |
| `ClientEngineAPI.Menu` | `source/engine/common/GameAPIs.ts` | The only surface game code should use — wraps `M`/`M.menuStack` and re-exports the widget/layout classes plus the drawing primitives. |
| `Id1Menu` | `source/game/id1/client/Menu.ts` | Builds and registers every built-in id1 page (`main`, `singleplayer`, `load`, `save`, `multiplayer`, `launch_server`, `options`, `keys`, `help`, `quit`, `alert`) via `ClientEngineAPI.Menu`, and declares `'main'` as the root. hellwave inherits this wholesale via `super.Init()` and only overrides what it wants to change. |

### MenuItem

Base class in `source/engine/client/menu/MenuItem.ts`. Every item has `label`, `focusable`,
`visible`, `enabled`, and an optional `heightOverride` (for rows that need more vertical space
than the default 8px line). Subclasses:

| Class | Purpose |
| - | - |
| `Action` | Runs a callback on Enter. Dims (`M.Print` instead of `M.PrintWhite`) when `enabled` is false. An optional `font` (`BitmapFont`) draws the label with a stylized atlas instead — variant 0 while focused, 1 otherwise, so the font's own color rows double as the hover/selection highlight. |
| `Slider` | Adjusts a numeric cvar (or `min`/`max`/`step`/`invert`/`displayScale`) with Left/Right, drawn with `M.DrawSlider`. |
| `Toggle` | On/off value backed by a cvar, or a custom `getValue`/`setValue` pair (e.g. bitflags) — see `ColorPicker`-style usage. |
| `Textbox` | Free-text input, optionally bound to a cvar (loads on `activate()`, commits on `deactivate()`). Supports a `customDraw` hook (see below) for layouts other than "label above box". |
| `Label` | Non-interactive, non-focusable text. |
| `Spacer` | Non-focusable, reserves vertical space (`height`). |
| `Image` | Draws a `MenuPic`, optionally horizontally centered. |
| `SaveSlotItem` | One load/save slot: Enter activates it, Del deletes it (if `canDelete`). |
| `ColorPicker` | Wrapping numeric selector (Enter/Left/Right) for a `0..max` value, e.g. shirt/pants color. |
| `NumberInput` | Clamped (not wrapping) numeric field with a `getValue`/`setValue` pair: Left/Right/Enter nudge by `step`, or digits can be typed directly (Backspace edits), like a native `<input type="number">`. |
| `KeyBindItem` | A rebindable action row — Enter arms capture of the next keypress, Backspace/Del clears the binding. Owns its own `capturing` state instead of a page-level flag. |

`draw(x, y, focused, valueX?)` — the optional 4th argument is an absolute column, set by
`VerticalLayout` when it's using right-justified labels (see below), that value-drawing items
(`Slider`, `Toggle`, `NumberInput`) should align their bar/value to instead of a fixed offset
from `x`.

#### `Textbox.customDraw` — composition instead of subclassing

```typescript
interface TextboxConfig {
  // ...
  customDraw?: (textbox: Textbox, x: number, y: number, focused: boolean) => void;
}
```

Replaces the whole `draw()` body when set. Exists so game code (which can't subclass `Textbox`
the way engine code used to) can still build a differently-laid-out text field — e.g. id1's
multiplayer setup screen draws the name field's input box in a fixed column to the right of the
label instead of on the line below it. Pairs with `Textbox.getCursorGlyph()` (public — computes
the current blink phase internally), which a `customDraw` callback needs to draw the same
blinking cursor the default layout does.

### Layouts

All implement `MenuLayout.draw(items, focusedIndex)`:

| Class | Used for |
| - | - |
| `VerticalLayout` | The default: one item per row, optional blinking cursor character. Two label modes — a fixed `labelX` column, or (when `valueX` is set) each label is right-justified against `valueX` so values/sliders always line up in the same column regardless of label length (used by the Options page). |
| `ImageBasedLayout` | A background picture plus an animated dot-cursor at fixed row positions (main menu, single-player menu). |
| `ListLayout` | Save/load slot lists — no per-row value column, tighter spacing. |
| `GridLayout` | Multi-column layouts. |

`VerticalLayout`'s `valueX` mode exists specifically so labels of different lengths (e.g. "Sound
Volume" vs. "CD Music Volume") can share one aligned value column — see
`LABEL_VALUE_GAP` in `MenuPage.ts` for the fixed label/value gap this reproduces from the
original hand-tuned layout.

### MenuPage

A page owns `items`, a `layout`, optional `title`/`titlePic`/`logoPic`, and lifecycle hooks:

- `onEnter`/`onExit` — called from `activate()`/`deactivate()`, in addition to forwarding
  `activate()`/`deactivate()` to every item (so `Textbox` can load/commit its cvar, for example).
- `onEscape`/`onConfirm` — fallback handlers used only when nothing else (a focused item first,
  then generic Up/Down navigation) consumed the key.
- `customDraw` — replaces the item/layout draw step entirely (logo/title still draw first). Used
  for screens that don't fit the item/layout model at all, e.g. the full-screen help picture
  viewer, or a page that wants to draw its items *and* something extra (call
  `page.layout?.draw(page.items, page.cursor)` yourself inside the callback, then add more).
- `customHandleInput` — replaces the default key-handling entirely, given a `defaultHandleInput`
  callback to fall back to for anything it doesn't want to special-case. Used for pages that need
  extra keys beyond the generic navigation, e.g. the help viewer's Left/Right page-turning, or a
  Yes/No dialog's `y`/`n`/mouse-click-on-prompt handling.
- `customGetBackButtonAnchor` — repositions the page-agnostic Back/Close button (e.g. centered
  under a dialog's message box) instead of the default bottom-left corner.
- `pausesGame` — whether showing this page freezes single-player world simulation the way the
  classic pause menu does; `true` by default. `Host.ServerFrame()` gates `SV.physics.physics()`
  (monster think, physics, round timers) behind `M.AllowsSimulation()` for listen servers below
  multiplayer capacity (`SV.svs.maxclients < 2`), which in turn defers to the current page's
  `pausesGame`. Set `false` for a page meant to sit over a world that must keep running
  regardless of one player having a menu open — e.g. an in-game buy menu in a coop mod, where the
  mod is never really "single-player" even when only one player happens to be connected right
  now. Has no effect once the server is genuinely multiplayer-capacity — that case never
  auto-pauses on menu open in the first place.

These four `custom*` hooks are the composition-based replacement for what used to be
subclassing `MenuPage` directly (engine-only code could do that; game code, which can't import
`MenuPage` as a base class to `extends`, builds everything through these hooks instead — see
[`ClientEngineAPI.Menu`](#clientenginemenu--the-game-facing-api) below).

Two subclasses (still genuinely useful as subclasses since they're reusable, generic screen
*shapes* rather than specific content):

- **`DialogPage`** — draws a `getBackdrop()` page first, then itself, so a dialog can appear on
  top of whatever was already open. `getBackdrop` is itself just a config option (no subclassing
  needed) — e.g. `getBackdrop: () => engineAPI.Menu.GetPreviousPage()` for "show whatever was
  open before this dialog."
- **`ListPage`** — remaps Left/Right to Up/Down navigation (used by save/load slot lists, so the
  same key that "would" go left/right instead moves the cursor).

### Mouse input

The menu is rendered on a WebGL2 canvas, not the DOM, so mouse support is built from raw
coordinates rather than element listeners:

- `M.MouseMove(canvasX, canvasY)` converts a canvas-relative CSS-pixel position into the same
  virtual 320×200 space `M.DrawPic`/`M.Print` already draw in (it's the exact inverse of that
  transform), stores it as `M.mouseX`/`M.mouseY`, and — only while the menu is the active input
  destination — forwards it to the current page's `updateHover()`. `Sys.ts` wires this up from a
  `mousemove` listener via `VID.mainwindow.getBoundingClientRect()`.
- Every `MenuLayout` implements `hitTest(items, px, py): number | null`, resolving which
  focusable item (if any) occupies a point, mirroring that same layout's `draw()` position math.
  `MenuPage.updateHover(mx, my)` uses this to move `cursor` to whatever's under the pointer,
  silently (no navigation sound, unlike Up/Down).
- Mouse buttons already flow through the same `Key.Event` dispatch as keyboard keys
  (`K.MOUSE1`/`MOUSE2`/`MOUSE3`), so `MenuPage.handleInput()` treats a `K.MOUSE1` press as "hit
  test at the current mouse position, then activate whatever's there exactly like Enter would" —
  reusing each widget's existing `K.ENTER` semantics rather than inventing click-specific behavior.
  Position-aware widgets get first refusal via an optional `MenuItem.handleClick(px, py)`
  override; `Slider` uses it to set its value from where the bar was clicked (rather than just
  nudging it up, which is all the `K.ENTER` fallback would do) — everything else (`Action`,
  `Toggle`, ...) is fine with the default Enter-equivalent behavior.
- A fixed, page-agnostic **Back/Close button** (`< Back` when the stack is more than one page
  deep, `< Close` at the root) is drawn/hit-tested by `M` itself, independent of whatever page is
  active — the same pattern as `M.DrawOverlayNotice()`. Clicking it synthesizes an `Escape`
  keypress on the current page (`page.handleInput(K.ESCAPE)`), so its behavior is always
  identical to pressing Escape and can't drift out of sync with a page's own `onEscape`/
  `customHandleInput`, including game-authored pages.
  - It only draws/hit-tests while the mouse is the most-recently-used input device (an internal
    `M` flag set by `MouseMove()` and by mouse-button/wheel keys, cleared by any other key or by
    `ToggleMenu_f()`), so keyboard-only play never shows a stray mouse affordance.
  - Its position defaults to the bottom-left corner, but a page can set `customGetBackButtonAnchor`
    to reposition it (returning a `{ centerX, y }` in virtual menu-space instead of `null`) —
    used by the quit/alert dialogs to center it under their own message box rather than leaving
    it stranded in the corner.
- Getting *into* the menu with just a mouse is covered too: `Key.Event()`
  (`source/engine/client/Key.ts`) opens the root page (`M.Menu_Main_f()`) on a `K.MOUSE1` press
  while the console is up with no game running (disconnected or still connecting) — a
  mouse-only escape hatch for whenever a player is stuck on the console without a keyboard,
  mirroring what Escape already does there (`Con.ToggleConsole_f()`). A click is a no-op while
  the console is up during an active connection, same as today — only Escape returns to gameplay
  from there. This has to live in `Key.Event()` (evaluated at mousedown time) rather than on the
  browser's later `click` event (which is where `IN.onclick()` handles the pointer-lock request):
  clicking the menu's own Back/Close button can change `Key.destination` from menu to console
  within that same mousedown, and checking again on the trailing `click` event would immediately
  reopen the menu it was just asked to close.
- A Yes/No dialog's own confirmation prompts aren't keyboard-only either: id1's quit page draws
  clickable "Yes"/"No" text (hover-highlighted the same dim/bright way as everything else), wired
  to the same confirm/cancel logic as the `Y`/`N` keys via `customHandleInput` (since a page with
  no `items`/`layout` of its own has nothing for the generic `K.MOUSE1` hit-test path to find).

### MenuStack

`source/engine/client/menu/MenuStack.ts` — a named page registry (`pages: Map<string, MenuPage>`)
plus a navigation stack (`stack: MenuPage[]`):

- `register(name, page)` — makes a page openable by name; fires `menu.page-registered`.
- `push(pageOrName)` — deactivates the current page (if any), activates the new one, plays the
  menu-enter sound (`M.entersound = true`), fires `menu.closed`/`menu.opened`.
- `pop()` — deactivates and removes the top page, reactivates whatever is now on top (if any).
- `replace(pageOrName)` — pop then push; keeps stack depth constant (used for sibling screens
  like Options/Keys, so Escape from either goes straight back to Main, not through the other).
- `clear()` — pops everything (used by `M.CloseMenu()` and whenever the root is opened fresh).
- `current()`, `depth()`, `isEmpty()`, `popTo(depth)`, `popToRoot()`, `isShowing(name)`.

**Root page** — `setRootPage(name)` / `pushRoot()` / `isShowingRoot()`. The engine has no idea
what page is "the main menu"; game code declares it (id1's `Init()` ends with
`Menu.SetRootPage('main')`). Resolved by *name*, not by instance reference, so when hellwave
later re-registers `'main'` to a different page, the root stays correct automatically — nothing
needs to call `SetRootPage` again. This is what `Menu_Main_f`/`ToggleMenu_f` (Escape,
`togglemenu`) and an involuntary disconnect (`client.disconnected` with nothing open) resolve
against: "go to the root," never a specific page name.

Pages can be pushed either by their registered name or by passing the `MenuPage` instance
directly (useful for pages a mod keeps a private reference to and never registers under a name).

### `M` — machinery only, no page content

`source/engine/client/Menu.ts` no longer builds a single page. What's left:

- The low-level drawing primitives every widget/layout calls into: `M.Print`, `M.PrintWhite`,
  `M.DrawCharacter`, `M.DrawPic`, `M.DrawPicTranslate`, `M.DrawTextBox`, `M.DrawSlider`,
  `M.DrawBitmapString` (draws with a `BitmapFont` instead of the standard conchars font — see
  `Action`'s `font` option above). These operate in the classic virtual 320×200 centered coordinate space
  (`cx * 2 + VID.width/2 - 320`, ...) — **this is a different coordinate system from the HUD's
  `Gfx`/`sbar` helpers**, which use resolution-aware absolute pixel offsets, and also different
  from `ClientEngineAPI.DrawPic`/`DrawString` (resolution-aware, used outside the menu stack
  entirely). Widgets built for menu pages are not directly reusable inside HUD draw code without
  going through `M`'s primitives (see [Non-modal panels](#non-modal-panels-hud-embedded-ui) for
  how HUD code uses them correctly).
- Mouse/back-button mechanics (see above).
- The root-page-aware open/close/toggle flow: `M.CloseMenu()`, `M.PopMenu()`, `M.ReturnToGame()`,
  `M.ToggleMenu_f()`, `M.Menu_Main_f()` (pushes the root, clearing the stack first — the
  `togglemenu` command and a handful of `Key.ts` input paths are the only remaining callers; see
  [Commands](#commands) below).
- `M.LoadTranslatablePic(lumpName)` — loads a lump-based pic together with a color-translation
  texture built from its raw palette indices (for `DrawPicTranslate`, e.g. a player-color
  preview). Kept engine-side since it's raw LMP-format parsing, not menu content; exposed to game
  code as `ClientEngineAPI.Menu.LoadTranslatablePic`.
- `M.StartSingleplayerGame()` / `M.StartMultiplayerGame(mapname)` — route to
  `ClientLifecycle.startGame` (the active mod's `StartGameInterface`, or the engine default).
  Live on `M` rather than being called directly from `GameAPIs.ts` to avoid a circular import
  (`ClientLifecycle.ts` already imports `GameAPIs.ts`); exposed as
  `ClientEngineAPI.Menu.StartSingleplayerGame`/`StartMultiplayerGame`.
- `M.SetOverlayNotice`/`ClearOverlayNotice`/`DrawOverlayNotice` — a generic notice banner,
  suppressed while the (game-owned, but name-known) `'alert'`/`'quit'` pages are showing.

`M.CloseMenu()` clears the whole stack and returns to the root while disconnected (nothing to
close to), or returns control to the game while connected. `M.PopMenu()` pops one level, falling
back to the same root/game logic once the stack empties. Both are the only intended way to
close/back-out of a menu from *engine* code — pages themselves go through
`ClientEngineAPI.Menu.Close()`/`Pop()`/`ForceClose()`.

### Commands

The engine registers exactly one menu-related console command: `togglemenu` (bound to Escape by
default), routed through the root-page indirection above — the engine has no page-name knowledge
even here. Every id1-specific command that used to exist (`menu_main`, `menu_singleplayer`,
`menu_options`, `menu_keys`, `menu_quit`, ...) was deleted along with the engine-owned pages they
pointed at. If a mod wants that console/bind compatibility back, it registers its own commands via
`ClientEngineAPI.RegisterCommand`/`UnregisterCommand`, pointed at `ClientEngineAPI.Menu.Open(...)`
calls — nothing currently does this by default.

## `ClientEngineAPI.Menu` — the game-facing API

Game code (`source/game/id1`, `source/game/hellwave`, future mods) must never import
`source/engine/client/menu/*` directly. Everything needed is exposed on
`ClientEngineAPI.Menu` (`source/engine/common/GameAPIs.ts`):

```typescript
static readonly Menu = {
  // Registration / navigation
  RegisterPage(name: string, page: MenuPage): void;
  UnregisterPage(name: string): void;
  SetRootPage(name: string): void;      // declare which page Escape/togglemenu goes to
  Open(name: string): void;             // pushes the page and switches Key.destination to the menu
  Push(name: string): void;             // pushes on top of whatever's open; assumes menu is already open
  Pop(): void;
  PopTo(depth: number): void;
  PopToRoot(): void;
  Replace(name: string): void;          // swap the current page without growing the stack
  Close(): void;
  Clear(): void;                        // empty the stack without touching Key.destination
  ForceClose(): void;                   // close unconditionally, even while disconnected --
                                         // for actions that are themselves about to start a game
  IsOpen(name?: string): boolean;
  Depth(): number;
  IsEmpty(): boolean;
  GetPreviousPage(): MenuPage | null;   // one level below the current page, e.g. a dialog's backdrop
  AddItem(pageName: string, item: MenuItem, index?: number): void;
  RemoveItem(pageName: string, item: MenuItem): void;

  // Action helpers a few built-in pages need, kept out of the generic top-level API
  StartSingleplayerGame(): void;
  StartMultiplayerGame(mapname: string): void;
  ToggleConsole(): void;
  ForceQuit(): void;                    // skips the `quit` command's own confirmation gate

  // Assets
  LoadTranslatablePic(lumpName: string): Promise<MenuPic>;

  // Low-level drawing primitives (virtual 320x200 space -- see M above), mouse position
  mouseX: number;
  mouseY: number;
  Print/PrintWhite/DrawCharacter/DrawPic/DrawPicTranslate/DrawTextBox/DrawSlider(...): void;
  DrawBitmapString(cx: number, cy: number, str: string, font: BitmapFont, variant?: number): void;

  // Re-exported so mods never import engine internals directly:
  Action, Label, Slider, Toggle, Textbox, Spacer, Image,
  ColorPicker, NumberInput, SaveSlotItem, KeyBindItem,
  MenuPage, DialogPage, ListPage,
  VerticalLayout, ImageBasedLayout, ListLayout, GridLayout,
};
```

Access it the same way as any other `ClientEngineAPI` group, via the engine reference passed
into `ClientGameAPI.Init`/HUD constructors:

```typescript
const { Menu } = this.engine;
```

### Registering and opening a custom page

```typescript
const { Menu } = this.engine;

const page = new Menu.MenuPage({
  title: 'My Mod Settings',
  layout: new Menu.VerticalLayout({ valueX: 220 }),
  items: [
    new Menu.Slider({ label: 'Some Setting', cvar: 'mymod_setting', min: 0, max: 1 }),
    new Menu.Action({ label: 'Back', action: () => Menu.Pop() }),
  ],
  onEscape: () => Menu.Pop(),
});

Menu.RegisterPage('mymod_settings', page);

// Later, e.g. from a console command or a button on another page:
Menu.Push('mymod_settings');
```

### Building a screen id1's toolkit can't already express

For anything beyond the item/layout model — full-screen custom drawing, extra input handling, a
repositioned back button — use the `custom*` config hooks instead of trying to subclass
`MenuPage` (game code can't; only the class *instances* are reachable, not a base class to
`extends`):

```typescript
const page = new Menu.MenuPage({
  onEscape: () => Menu.Pop(),
  customDraw: (page) => {
    Menu.DrawPic(0, 0, myFullscreenPic);
  },
  customHandleInput: (key, page, defaultHandleInput) => {
    if (key === someSpecialKey) {
      // ... handle it ...
      return true;
    }
    return defaultHandleInput(key); // fall back to normal Escape/navigation handling
  },
  customGetBackButtonAnchor: () => ({ centerX: 160, y: 180 }),
});
```

See `source/game/id1/client/Menu.ts` for real examples of every hook (`#buildHelpPage` for
`customHandleInput` + `customDraw`, `#buildQuitPage` for all four hooks together on a
`DialogPage`).

### Extending a built-in page

`AddItem`/`RemoveItem` let a mod add a row to an existing registered page (e.g. an extra entry on
the Options screen) without owning or replacing the whole page:

```typescript
const item = new Menu.Toggle({ label: 'My Mod Feature', cvar: 'mymod_enabled' });
Menu.AddItem('options', item);

// later, if the mod unloads:
Menu.RemoveItem('options', item);
```

### Replacing a built-in page

Since registration is by name and the root is resolved by name too, a mod can replace any
built-in page — including the root itself — just by registering something else under the same
name, after calling `super.Init(engineAPI)` (which registers id1's defaults first):

```typescript
static override Init(engineAPI: ClientEngineAPI): void {
  super.Init(engineAPI); // registers id1's full page set, including 'main' as root

  const { Menu } = engineAPI;
  Menu.RegisterPage('main', myCustomMainPage); // root stays 'main' -- no SetRootPage needed
}
```

### Checking menu state

```typescript
if (Menu.IsOpen()) { /* any page open */ }
if (Menu.IsOpen('mymod_settings')) { /* specifically that page is current */ }
```

## Non-modal panels (HUD-embedded UI)

`MenuPage`/`MenuItem`/layouts have no dependency on `M.menuStack` or `Key.destination` — they
only call `M`'s drawing helpers and `S.LocalSound`. That means a page can be built once, kept as
a private field, and driven entirely from HUD code: call `.draw()` every frame from the game's
own `draw()` hook, with no `Push`/`Open`/stack involvement at all. Because gameplay input is
never redirected to `Key.destination = menu`, this is non-modal — the player keeps moving/looking
while the panel is visible.

This is exactly how Hellwave's buy-menu works
(`source/game/hellwave/client/HUD.ts`, `#getBuyMenuPage()`/`#drawBuyMenu()`):

```typescript
#getBuyMenuPage(): MenuPage {
  if (this.#buyMenuPage) {
    return this.#buyMenuPage;
  }

  const { Label, MenuPage, VerticalLayout } = this.engine.Menu;
  const items: MenuItem[] = [new Label({ label: 'Available for purchase:' })];

  for (const impulse of Object.keys(buyMenuItems)) {
    const label = new Label({ label: '', visible: false });
    this.#buyMenuLabels.set(Number(impulse), label);
    items.push(label);
  }

  this.#buyMenuPage = new MenuPage({
    layout: new VerticalLayout({ startY: 40, spacing: 4, labelX: 40, showCursor: false }),
    items,
  });

  return this.#buyMenuPage;
}

#drawBuyMenu(): void {
  // ... early-out checks on buyzone state ...

  const page = this.#getBuyMenuPage(); // build/memoize the page (and its label map) first
  const currentMoney = this.inventory.money[0] ?? 0;

  for (const [impulse, item] of Object.entries(buyMenuItems)) {
    const label = this.#buyMenuLabels.get(Number(impulse))!;
    label.visible = item.cost <= currentMoney;
    label.label = `[${impulse}] ${formatMoney(item.cost).padStart(5)} - ${item.label}`;
  }

  page.draw();
}
```

The page is built once and memoized; every frame just mutates each row's `visible`/`label` and
redraws. `showCursor: false` on the `VerticalLayout` suppresses the blinking navigation cursor,
since this panel is purely informational (no `handleInput` is ever called on it).

**Pitfall:** build/memoize the page (and populate any per-row lookup map) *before* the loop that
reads from that map — reading it first on a page that hasn't been built yet will read from an
empty map.

Out of scope for this pattern: giving a non-modal panel actual keyboard focus (e.g. an
in-game-navigable scoreboard while still moving), or a genuinely *modal* in-game panel (something
that isn't the pause menu but still needs to steal input focus, e.g. a hypothetical inventory
screen). That needs deliberate input-focus arbitration on top of `KeyDestination` and hasn't been
designed for arbitrary panels yet — though the drop-down console (see `docs/console.md`) is now a
working precedent for exactly that shape of problem: `Con.isOpen` is an independent overlay flag
that takes `Key.Event()` dispatch priority over whichever `KeyDestination` is active underneath,
rather than being folded into the destination enum itself. A generalized version of that pattern
is the natural next extension if a mod ever needs a modal in-game panel; `MenuStack` isn't a
hardcoded singleton internally (a second instance is cheap to create), so the missing piece is
specifically the focus-arbitration mechanism, not the stack.

## Events

Fired on the shared `eventBus` by `MenuStack`; documented alongside all other engine events in
[`events.md`](events.md#menu):

| Event | Arguments | When |
| - | - | - |
| `menu.page-registered` | page name | `MenuStack.register()` was called. |
| `menu.opened` | page name, or `null` if unregistered | A page became current (`push`). |
| `menu.closed` | page name, or `null` if unregistered | A page stopped being current (`pop`, replaced, or the stack was cleared). |

Two more, published by `Host.ts` rather than `MenuStack` — the engine reports these as plain
events instead of calling into the menu system directly, so it has no dependency on whether (or
how) a game module chooses to present them (see [`events.md`](events.md#host) for full details):

| Event | Arguments | When |
| - | - | - |
| `host.alert` | `HostAlertEvent` (`title`, `message`, `severity`) | `Host.EndGame`/`Host.Error` reporting a fault or an expected end-of-game condition. id1 subscribes and opens its `'alert'` page. |
| `host.quit-requested` | - | The `quit` command wants confirmation. id1 subscribes and opens its `'quit'` page. |

## Testing

- `test/client/menu-stack.test.mjs` — `MenuStack` register/push/pop/replace/popTo/clear, plus
  `isShowing`/root-page (`setRootPage`/`pushRoot`/`isShowingRoot`).
- `test/client/menu-item.test.mjs` — widget behaviors (cvar round-trip, focus-skipping, input
  handling per widget type).
- `test/client/menu-page.test.mjs` — `MenuPage`/`DialogPage`/`ListPage` navigation and dialog
  backdrop drawing, `VerticalLayout`'s `valueX` right-justification behavior, and the
  `customDraw`/`customHandleInput`/`customGetBackButtonAnchor` composition hooks.
- `test/client/menu.test.mjs` — `M`'s remaining machinery: mouse/back-button mechanics, root-page
  aware `CloseMenu`/`PopMenu`, involuntary-disconnect reopen.
- `test/client/session-discovery.test.mjs`, `test/client/save-slots.test.mjs` — the
  `SessionDiscovery`/`SaveSlots` services `ClientEngineAPI.Multiplayer`/`ClientEngineAPI.SaveSlots`
  wrap.
- `test/common/client-engine-api-menu.test.mjs`,
  `test/common/client-engine-api-multiplayer.test.mjs`,
  `test/common/client-engine-api-save-slots.test.mjs`,
  `test/common/client-engine-api-connection-state.test.mjs` — `ClientEngineAPI.Menu`/
  `.Multiplayer`/`.SaveSlots`/`.CL.connected`/`.SV.active` register/open/add-item round-trips,
  using the same mock-registry pattern as other client API tests.
- `test/common/host-alert.test.mjs` — `Host.EndGame`/`Host.Error` publish `host.alert` with the
  right severity, and `Con.PrintError`/`PrintSuccess` still fire even with nothing subscribed.
- `source/game/id1/test/client/menu.test.mjs` — `Id1Menu.Init()`: every built-in page registers
  and the root is `'main'`; each page's actual behavior (main menu navigation, new-game/load/save
  flows, options toggles, the quit Y/N dialog, the help page-turner, the multiplayer setup
  name/color/join flow, the launch-server session list, and the `host.alert`/`host.quit-requested`
  subscriptions).

All of the above follow the project's standard mock-registry pattern
(`registry.X = {...}; eventBus.publish('registry.frozen');`) for engine-level tests, and the
`createMockClientEngine()` fixture (`source/game/id1/test/client/fixtures.ts`) for game-level
ones — see [Unit Tests](../.github/instructions/unit-tests.instructions.md) for the general
convention.

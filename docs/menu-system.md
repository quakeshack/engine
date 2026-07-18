# Menu System

The client menu system is a stack-based, widget-driven UI framework. It replaces the old
WinQuake-style single `M` class with a giant `switch` over a `MenuStateId` enum — every screen
is now a `MenuPage` built from reusable widgets, and game code can register, extend, or push its
own pages through `ClientEngineAPI.Menu` without touching engine internals.

It also doubles as a general-purpose declarative-panel toolkit: nothing in `MenuPage`/`MenuItem`
depends on the pause-menu stack, so game HUD code can build a page and call `.draw()` on it every
frame for always-on, non-modal UI (see [Non-modal panels](#non-modal-panels-hud-embedded-ui)).

## Building blocks

| Class | File | Responsibility |
| - | - | - |
| `MenuItem` (+ subclasses) | `source/engine/client/menu/MenuItem.ts` | A single interactive or decorative row: label, focus state, draw, input handling. |
| `MenuLayout` (+ implementations) | `source/engine/client/menu/MenuPage.ts` | Positions a page's items on screen and draws the navigation cursor. |
| `MenuPage` (+ subclasses) | `source/engine/client/menu/MenuPage.ts` | A screen: an item list, a layout, and lifecycle hooks (`activate`/`deactivate`, `onEscape`/`onConfirm`). |
| `MenuStack` | `source/engine/client/menu/MenuStack.ts` | Named page registry plus a navigation stack (push/pop/replace/clear). |
| `M` | `source/engine/client/Menu.ts` | Owns the single `menuStack` instance, the built-in pages, and the pixel-drawing primitives (`M.Print`, `M.DrawPic`, `M.DrawTextBox`, `M.DrawSlider`, ...) that widgets call into. |
| `ClientEngineAPI.Menu` | `source/engine/common/GameAPIs.ts` | The only surface game code should use — wraps `M.menuStack` and re-exports the widget/layout classes. |

### MenuItem

Base class in `source/engine/client/menu/MenuItem.ts`. Every item has `label`, `focusable`,
`visible`, `enabled`, and an optional `heightOverride` (for rows that need more vertical space
than the default 8px line). Subclasses:

| Class | Purpose |
| - | - |
| `Action` | Runs a callback on Enter. Dims (`M.Print` instead of `M.PrintWhite`) when `enabled` is false. |
| `Slider` | Adjusts a numeric cvar (or `min`/`max`/`step`/`invert`/`displayScale`) with Left/Right, drawn with `M.DrawSlider`. |
| `Toggle` | On/off value backed by a cvar, or a custom `getValue`/`setValue` pair (e.g. bitflags) — see `ColorPicker`-style usage. |
| `Textbox` | Free-text input, optionally bound to a cvar (loads on `activate()`, commits on `deactivate()`). |
| `Label` | Non-interactive, non-focusable text. |
| `Spacer` | Non-focusable, reserves vertical space (`height`). |
| `Image` | Draws a `MenuPic`, optionally horizontally centered. |
| `PlayerSkin` | Renders the shirt/pants-colored player preview box (`M.bigbox` + `M.menuplyr`). |
| `SaveSlotItem` | One load/save slot: Enter activates it, Del deletes it (if `canDelete`). |
| `ColorPicker` | Wrapping numeric selector (Enter/Left/Right) for a `0..max` value, e.g. shirt/pants color. |
| `KeyBindItem` | A rebindable action row — Enter arms capture of the next keypress, Backspace/Del clears the binding. Owns its own `capturing` state instead of a page-level flag. |

`draw(x, y, focused, valueX?)` — the optional 4th argument is an absolute column, set by
`VerticalLayout` when it's using right-justified labels (see below), that value-drawing items
(`Slider`, `Toggle`) should align their bar/value to instead of a fixed offset from `x`.

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
  then generic Up/Down navigation) consumed the key. A page with an empty item list and only
  `onConfirm` set is a common "dismiss on Enter" pattern (see `AlertDialogPage`).
- `customDraw` — escape hatch for screens that don't fit the item/layout model at all (used by
  the full-screen help picture viewer).

Two subclasses:

- **`DialogPage`** — draws a `getBackdrop()` page first, then itself, so a dialog can appear on
  top of whatever was already open without the previous "recursive draw with shared state" hack.
  Used by the quit confirmation (`QuitDialogPage`), which resolves its backdrop as
  "whatever is one level below me on the stack" (`stack[stack.length - 2]`).
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
  identical to pressing Escape and can't drift out of sync with a page's own `onEscape`/override,
  including custom pages and future game/mod pages.
  - It only draws/hit-tests while the mouse is the most-recently-used input device (an internal
    `M` flag set by `MouseMove()` and by mouse-button/wheel keys, cleared by any other key or by
    `ToggleMenu_f()`), so keyboard-only play never shows a stray mouse affordance.
  - Its position defaults to the bottom-left corner, but a page can override
    `MenuPage.getBackButtonAnchor()` to reposition it (returning a `{ centerX, y }` in virtual
    menu-space instead of `null`) — used by `QuitDialogPage`/`AlertDialogPage` to center it under
    their own message box rather than leaving it stranded in the corner.
- Getting *into* the menu with just a mouse is covered too: `Key.Event()`
  (`source/engine/client/Key.ts`) opens the main menu (`M.Menu_Main_f()`) on a `K.MOUSE1` press
  while the console is up with no game running (disconnected or still connecting) — a
  mouse-only escape hatch for whenever a player is stuck on the console without a keyboard,
  mirroring what Escape already does there (`Con.ToggleConsole_f()`). A click is a no-op while
  the console is up during an active connection, same as today — only Escape returns to gameplay
  from there. This has to live in `Key.Event()` (evaluated at mousedown time) rather than on the
  browser's later `click` event (which is where `IN.onclick()` handles the pointer-lock request):
  clicking the menu's own Back/Close button can change `Key.destination` from menu to console
  within that same mousedown, and checking again on the trailing `click` event would immediately
  reopen the menu it was just asked to close.
- `QuitDialogPage`'s Y/N confirmation isn't keyboard-only either: it draws clickable "Yes"/"No"
  prompts inside the dialog box (hover-highlighted the same dim/bright way as everything else),
  wired to the exact same confirm/cancel logic as the `Y`/`N` keys — `MenuPage`'s generic
  `handleInput()` MOUSE1 path doesn't apply here since this dialog has no `items`/`layout` of its
  own, so the click is hit-tested directly in its `handleInput()` override instead.

### MenuStack

`source/engine/client/menu/MenuStack.ts` — a named page registry (`pages: Map<string, MenuPage>`)
plus a navigation stack (`stack: MenuPage[]`):

- `register(name, page)` — makes a page openable by name; fires `menu.page-registered`.
- `push(pageOrName)` — deactivates the current page (if any), activates the new one, plays the
  menu-enter sound (`M.entersound = true`), fires `menu.closed`/`menu.opened`.
- `pop()` — deactivates and removes the top page, reactivates whatever is now on top (if any).
- `replace(pageOrName)` — pop then push; keeps stack depth constant (used for sibling screens
  like Options/Keys, so Escape from either goes straight back to Main, not through the other).
- `clear()` — pops everything (used by `M.CloseMenu()` and whenever Main is opened fresh).
- `current()`, `depth()`, `isEmpty()`, `popTo(depth)`, `popToRoot()`.

Pages can be pushed either by their registered name or by passing the `MenuPage` instance
directly (useful for pages a mod keeps a private reference to and never registers under a name).

### `M` — the built-in pages and drawing primitives

`source/engine/client/Menu.ts` builds every stock screen as a `MenuPage`/`MenuLayout`
combination and registers them into `M.menuStack` under stable string keys in `#buildPages()`:
`'main'`, `'singleplayer'`, `'load'`, `'save'`, `'multiplayer'`, `'options'`, `'keys'`, `'help'`,
`'quit'`, `'alert'`, `'launch_server'`. The `Cmd`-registered entry points
(`menu_main`, `menu_options`, `togglemenu`, ...) are thin wrappers that call
`M.menuStack.push`/`replace`/`clear` — they're unchanged from before this refactor, so existing
binds and console commands keep working.

`M` also exposes the low-level drawing primitives every widget/layout calls into: `M.Print`,
`M.PrintWhite`, `M.DrawCharacter`, `M.DrawPic`, `M.DrawPicTranslate`, `M.DrawTextBox`,
`M.DrawSlider`. These operate in the classic virtual 320×200 centered coordinate space
(`cx * 2 + VID.width/2 - 320`, ...) — **this is a different coordinate system from the HUD's
`Gfx`/`sbar` helpers**, which use resolution-aware absolute pixel offsets. Widgets built for menu
pages are not directly reusable inside HUD draw code without going through `M`'s primitives (see
[Non-modal panels](#non-modal-panels-hud-embedded-ui) for how HUD code uses them correctly).

`M.CloseMenu()` clears the whole stack and returns `Key.destination` to game/console.
`M.PopMenu()` pops one level, only returning `Key.destination` if the stack is now empty. Both
are the only intended way to close/back-out of a menu — pages should call these from their
`onEscape`/action handlers rather than manipulating `M.menuStack` or `Key.destination` directly.

## `ClientEngineAPI.Menu` — the game-facing API

Game code (`source/game/id1`, `source/game/hellwave`, future mods) must never import
`source/engine/client/menu/*` directly. Everything needed is exposed on
`ClientEngineAPI.Menu` (`source/engine/common/GameAPIs.ts`):

```typescript
static readonly Menu = {
  RegisterPage(name: string, page: MenuPage): void;
  UnregisterPage(name: string): void;
  Open(name: string): void;    // pushes the page and switches Key.destination to the menu
  Push(name: string): void;    // pushes on top of whatever's open; assumes menu is already open
  Pop(): void;
  Replace(name: string): void; // swap the current page without growing the stack
  Close(): void;
  IsOpen(name?: string): boolean;
  AddItem(pageName: string, item: MenuItem, index?: number): void;
  RemoveItem(pageName: string, item: MenuItem): void;

  // Re-exported so mods never import engine internals directly:
  Action, Label, Slider, Toggle, Textbox, Spacer, Image,
  MenuPage, VerticalLayout, ImageBasedLayout, ListLayout, GridLayout,
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

Use `Menu.Open(name)` instead of `Push` when the call site can't assume the menu is already
open (e.g. binding a raw key or console command to jump straight to the page) — it also sets
`Key.destination` to `menu`, which `Push` deliberately leaves alone.

### Extending a built-in page

`AddItem`/`RemoveItem` let a mod add a row to an existing registered page (e.g. an extra entry on
the Options screen) without owning or replacing the whole page:

```typescript
const item = new Menu.Toggle({ label: 'My Mod Feature', cvar: 'mymod_enabled' });
Menu.AddItem('options', item);

// later, if the mod unloads:
Menu.RemoveItem('options', item);
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
in-game-navigable scoreboard while still moving). That needs deliberate input-focus arbitration
on top of `KeyDestination` and hasn't been designed for arbitrary panels yet — though the
drop-down console (see `docs/console.md`) is now a working precedent for exactly that shape of
problem: `Con.isOpen` is an independent overlay flag that takes `Key.Event()` dispatch priority
over whichever `KeyDestination` is active underneath, rather than being folded into the
destination enum itself. A similar approach (an independent "this panel currently has focus" flag,
checked early in `Key.Event()`) would generalize to other focus-stealing non-modal panels.

## Events

Fired on the shared `eventBus` by `MenuStack`; documented alongside all other engine events in
[`events.md`](events.md#menu):

| Event | Arguments | When |
| - | - | - |
| `menu.page-registered` | page name | `MenuStack.register()` was called. |
| `menu.opened` | page name, or `null` if unregistered | A page became current (`push`). |
| `menu.closed` | page name, or `null` if unregistered | A page stopped being current (`pop`, replaced, or the stack was cleared). |

## Testing

- `test/client/menu-stack.test.mjs` — `MenuStack` register/push/pop/replace/popTo/clear.
- `test/client/menu-item.test.mjs` — widget behaviors (cvar round-trip, focus-skipping, input
  handling per widget type).
- `test/client/menu-page.test.mjs` — `MenuPage`/`DialogPage`/`ListPage` navigation and dialog
  backdrop drawing, plus `VerticalLayout`'s `valueX` right-justification behavior.
- `test/client/menu-multiplayer-setup.test.mjs` — the ported multiplayer setup screen's
  name/color editing and join/accept-changes flow.
- `test/common/client-engine-api-menu.test.mjs` — `ClientEngineAPI.Menu` register/open/add-item
  round-trip, using the same mock-registry pattern as other client API tests.

All of the above follow the project's standard mock-registry pattern
(`registry.X = {...}; eventBus.publish('registry.frozen');`) rather than touching a real client
bootstrap — see [Unit Tests](../.github/instructions/unit-tests.instructions.md) for the general
convention.

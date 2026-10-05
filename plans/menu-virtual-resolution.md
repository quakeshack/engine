# Per-page virtual menu resolution

**Status:** Done (checked in the tree 2026-09-21; this plan has no "what shipped" notes). In the
engine: `MenuViewport` (including the corner `anchor()` helper from Design F), `MenuPage.viewport`
(defaulting to `MenuViewport.classic`), and `toScreenPosition`, `viewportScale` and `MenuViewport`
on `ClientEngineAPI.Menu`, with tests in `test/client/menu-viewport.test.mjs`. Hellwave adopted it
with a 640x360 `'contain'` viewport, **not** the 1280x720 recommended under "Decisions needed from
you": a comment in its `MenuCommon.ts` says 1280x720 rendered text and logos too small relative to
the layout, so every position constant was halved. `MenuCommon.toScreenPosition` remains as a thin
forward to the engine call. Line references are as of writing.

## Context

Discussed as a follow-on to [`menu-rework.md`](menu-rework.md) and
[`hellwave-main-menu-rework.md`](hellwave-main-menu-rework.md): the entire menu system —
both id1's classic pages and hellwave's new ones — draws through a single, hardcoded
320×200 virtual coordinate space, fixed at exactly 2x pixel-doubling regardless of the
real canvas size. This lives in `M`'s drawing primitives
([Menu.ts:102-186](../source/engine/client/Menu.ts#L102-L186)):

```typescript
static Print(cx: number, cy: number, str: string): void {
  Draw.StringWhite(cx * 2 + Math.floor(VID.width / 2) - 320, cy * 2 + Math.floor(VID.height / 2) - 200, str, 2.0);
}
```

The same `* 2` / `- 320` / `- 200` literals are duplicated in `M.PrintWhite`, `DrawPic`,
`DrawPicTranslate`, `DrawCharacter`, `DrawBitmapString` (all at
[Menu.ts:102-128](../source/engine/client/Menu.ts#L102-L128)), and inverted again in
`M.MouseMove()` ([Menu.ts:233-236](../source/engine/client/Menu.ts#L233-L236)) to convert
canvas-pixel clicks back into virtual-space coordinates. `MenuPage.draw()` hardcodes `160`
for title centering and `(16, 4)` for the corner logo
([MenuPage.ts:136-149](../source/engine/client/menu/MenuPage.ts#L136-L149)). Two stock
layouts hardcode a `320`-wide hit-test bound
([MenuPage.ts:399](../source/engine/client/menu/MenuPage.ts#L399),
[MenuPage.ts:517](../source/engine/client/menu/MenuPage.ts#L517)). `ClientEngineAPI.Menu`'s
own doc comment calls this out explicitly: "All operate in the classic virtual 320x200
centered coordinate space" ([GameAPIs.ts:1486-1488](../source/engine/common/GameAPIs.ts#L1486-L1488)).

hellwave's menu rework is already fighting this ceiling. Its hi-res logo/map art bypasses
`M` entirely and draws through the resolution-aware top-level `engineAPI.DrawPic(x, y, pic,
scale)` instead ([GameAPIs.ts:962](../source/engine/common/GameAPIs.ts#L962)), landing
[a note in the asset-cleanup log](hellwave-menu-asset-cleanup.md#L392-L396) that a 320-space
draw "would have rendered the hi-res logo almost 3x the entire virtual canvas width." To
place that hi-res pic at a virtual-space position, hellwave hand-rolled its own copy of the
same transform in `MenuCommon.toScreenPosition()`
([MenuCommon.ts:52-56](../source/game/hellwave/client/menu/MenuCommon.ts#L52-L56)), and a
*third* copy of the bare `2` scale constant shows up again in `MainMenu.#drawLogo()`:

```typescript
// MainMenu.ts:60
const scale = (LOGO_VIRTUAL_WIDTH * 2) / hiResLogoPic.width;
```

Three independent places now assume "the virtual space is 320×200 at a fixed 2x" as a
magic number rather than a queryable property. That's the concrete cost of not having this
today, beyond the aesthetic question of screen real estate.

### Why not just bump the shared constant to 640×480

id1's classic pages are laid out against actual 320×200-native `.lmp` art
(`mainmenu.lmp`, `ttl_main.lmp`, the `box_*` corner pieces, `conchars`). Changing the
shared constant makes that art blurrier (or blockier, under nearest-neighbor) without
making it sharper — there's no new detail in a 320×200 source image to reveal. It would
also force re-tuning every hand-placed pixel coordinate in
[id1/client/Menu.ts](../source/game/id1/client/Menu.ts) (ported wholesale from the original
Quake menu in `menu-rework.md` Phase 2) for zero visual payoff. That work has no upside, so
this plan does not do it.

## Goals

- Let a mod declare its **own** virtual canvas size and scaling behavior, per page, without
  changing anything about pages it doesn't touch. Concretely: hellwave's `main` /
  `hellwave_newgame` / `hellwave_profile` pages get a wide, screen-filling canvas; every
  id1-owned page hellwave still inherits (`options`, `keys`, `load`, `save`, `quit`,
  `alert`, `multiplayer`, `launch_server`) keeps rendering pixel-identical to today.
- Remove the duplicated `* 2` / `- 320` / `- 200` transform math from `MenuCommon.ts` and
  `MainMenu.ts` — both should ask the engine for the current page's resolved transform
  instead of assuming it.
- Make picking a virtual canvas size for a *new* page a declarative, one-line choice
  instead of a manual pixel-math exercise, addressing "designing menu pages should be
  easier" directly (see Design C).
- Zero behavior change for every page that doesn't opt in — this is purely additive to the
  existing `M`/`MenuPage`/`MenuItem`/layout API surface.

## Non-goals

- No change to id1's classic page layout, art, or virtual resolution.
- No change to the 8×8 conchars glyph grid or the existing hi-DPI `concharslarge.png` swap
  ([Draw.ts:280-289](../source/engine/client/Draw.ts#L280-L289)) — that's a texture-crispness
  concern, orthogonal to canvas *size*, and continues to work unchanged under either
  viewport.
- No generic "any mod can theme everything" mechanism beyond what's already true today
  (custom fonts via `BitmapFont`, `customDraw`/`customHandleInput` hooks). This plan only
  adds a size/scale knob to the coordinate system those hooks already draw into.

## Design

### A. `MenuViewport` — the virtual-space transform, made into a first-class object

New file `source/engine/client/menu/MenuViewport.ts`:

```typescript
export interface MenuViewportConfig {
  readonly width: number;
  readonly height: number;
  /**
   * 'fixed': scale is the given constant, matching today's hardcoded 2x id1 behavior --
   * pixel-doubled, does not grow to fill a larger display.
   * 'contain': scale = min(vidWidth / width, vidHeight / height), i.e. grows/shrinks to fill
   * as much of the real canvas as possible while preserving the width:height ratio.
   */
  readonly fit: 'fixed' | 'contain';
  readonly scale?: number; // required when fit === 'fixed'
  readonly integerScale?: boolean; // 'contain' only -- floor to whole pixels for crisp nearest-neighbor art
}

export interface ResolvedMenuViewport {
  readonly scale: number;
  readonly originX: number;
  readonly originY: number;
}

export class MenuViewport {
  readonly width: number;
  readonly height: number;

  // id1's exact current behavior, made explicit and reusable as the default for every page
  // that doesn't set its own viewport.
  static readonly classic = new MenuViewport({ width: 320, height: 200, fit: 'fixed', scale: 2 });

  constructor(private readonly config: MenuViewportConfig) {
    this.width = config.width;
    this.height = config.height;
  }

  resolve(vidWidth: number, vidHeight: number): ResolvedMenuViewport {
    const scale = this.config.fit === 'fixed'
      ? this.config.scale!
      : this.#containScale(vidWidth, vidHeight);

    return {
      scale,
      originX: Math.floor(vidWidth / 2) - (this.width * scale) / 2,
      originY: Math.floor(vidHeight / 2) - (this.height * scale) / 2,
    };
  }

  #containScale(vidWidth: number, vidHeight: number): number {
    const raw = Math.min(vidWidth / this.width, vidHeight / this.height);
    return this.config.integerScale ? Math.max(1, Math.floor(raw)) : raw;
  }

  toScreen(resolved: ResolvedMenuViewport, x: number, y: number): { x: number; y: number } {
    return { x: x * resolved.scale + resolved.originX, y: y * resolved.scale + resolved.originY };
  }

  fromScreen(resolved: ResolvedMenuViewport, x: number, y: number): { x: number; y: number } {
    return { x: (x - resolved.originX) / resolved.scale, y: (y - resolved.originY) / resolved.scale };
  }
}
```

Sanity check against today's behavior: `MenuViewport.classic.resolve(vidWidth, vidHeight)`
gives `scale = 2`, `originX = floor(vidWidth / 2) - (320 * 2) / 2 = floor(vidWidth / 2) -
320` — byte-identical to the literal in `M.Print` today. This is the regression test in
Testing below.

### B. `MenuPage.viewport`

Add an optional field to `MenuPageConfig`/`MenuPage`
([MenuPage.ts:6-29](../source/engine/client/menu/MenuPage.ts#L6-L29)):

```typescript
readonly viewport?: MenuViewport; // defaults to MenuViewport.classic
```

Per-*page*, not per-mod: hellwave's inherited id1 pages (`options`, `keys`, ...) never set
this and keep rendering through `MenuViewport.classic`; only hellwave's own pages
(`main`, `hellwave_newgame`, `hellwave_profile`) set a wider one. This matches how page
registration already works — the composition point is the page, not a mod-wide switch.

### C. Wire the viewport into `M`

`M` resolves the *current page's* viewport once per relevant entry point and uses the
result everywhere the old literals were, instead of re-deriving a transform inline per
draw call:

```typescript
// Replaces the individual '* 2 + Math.floor(VID.width / 2) - 320' literals throughout M.
static #resolved: ResolvedMenuViewport = MenuViewport.classic.resolve(0, 0);

static #currentViewport(): MenuViewport {
  return M.menuStack.current()?.viewport ?? MenuViewport.classic;
}
```

- `M.Draw()` ([Menu.ts:507-521](../source/engine/client/Menu.ts#L507-L521)) resolves
  `M.#resolved` from `M.#currentViewport()` and `VID.width/height` once, before calling
  `current.draw()` — every `M.Print`/`DrawPic`/etc. call made during that page's `draw()`
  (including from `MenuItem` subclasses, which call `M.*` directly, e.g.
  `Action.draw()` at [MenuItem.ts:188-207](../source/engine/client/menu/MenuItem.ts#L188))
  reads the cached `M.#resolved` instead of recomputing per call.
- `M.MouseMove()` ([Menu.ts:233-243](../source/engine/client/Menu.ts#L233-L243)) resolves
  against the *current* page the same way before inverting canvas coordinates into
  `M.mouseX`/`M.mouseY` — necessary because the mouse can move while any page is active,
  not just during a draw call.
- The back button ([Menu.ts:254-313](../source/engine/client/Menu.ts#L254-L313)) rides
  along automatically since it calls `M.Print`/`PrintWhite` like everything else — no
  separate change needed, but its fixed corner position (`#backButtonX = 8, #backButtonY =
  224`) is virtual-space, so it moves proportionally with whatever viewport the current
  page uses. Worth a look during implementation to confirm that still reads sensibly on a
  much wider canvas, or whether hellwave wants `customGetBackButtonAnchor()` (already
  exists) to override it per page.
- **`M.DrawOverlayNotice()`** ([Menu.ts:202-226](../source/engine/client/Menu.ts#L202-L226))
  is the one caller that must **not** follow the current page's viewport: it's called
  unconditionally every frame from `SCR.ts:471`, independent of whether a menu page is even
  open (e.g. a mobile "unsupported input" notice during live gameplay, see
  `IN.ts:453`). It stays pinned to `MenuViewport.classic` explicitly.

`MenuPage.draw()`'s hardcoded `160` (title centering,
[MenuPage.ts:144,147](../source/engine/client/menu/MenuPage.ts#L144)) and `(16, 4)` (logo
position) become `viewport.width / 2` / a `logoPosition` config field, read from `this
.viewport ?? MenuViewport.classic`. In practice this only affects id1 pages today, since
hellwave's pages use `customDraw` and never populate `titlePic`/`logoPic` — the fallback
still computes `160` for `width = 320`, so no visible change there either.

### D. Relax the `320` hit-test bound independent of viewport size

`VerticalLayout.hitTest` / `ListLayout.hitTest`
([MenuPage.ts:399](../source/engine/client/menu/MenuPage.ts#L399),
[MenuPage.ts:517](../source/engine/client/menu/MenuPage.ts#L517)) hardcode `px < 320`, but
the comment right above it explains the actual intent: *"the hit box spans the full virtual
screen width regardless of where [the layout] placed the text."* That intent has nothing to
do with the number 320 specifically — drop the upper bound entirely (`px >= 0` is enough; a
row's vertical band is what actually disambiguates it from neighboring rows). This fix is
correct regardless of whether the rest of this plan lands, and removes the last hidden
"320" assumption from the stock layouts.

### E. Expose the viewport to game code — replacing the duplicated transforms

`ClientEngineAPI.Menu` ([GameAPIs.ts:1259-1520](../source/engine/common/GameAPIs.ts#L1259-L1520))
gains:

```typescript
// Re-exported class, alongside Action/Label/... already there.
MenuViewport,

/** The currently-active page's resolved transform -- for a customDraw that needs to place
 *  a resolution-aware DrawPic (see DrawPic/DrawString above) at a virtual-space position. */
toScreenPosition(x: number, y: number): { x: number; y: number } {
  return M.toScreenPosition(x, y); // wraps MenuViewport.toScreen(M.#resolved, x, y)
},

/** The currently-active page's resolved pixel scale (virtual units -> real screen pixels). */
get viewportScale(): number {
  return M.#resolved.scale;
},
```

This directly retires the two duplicated transforms:

- `MenuCommon.toScreenPosition()` ([MenuCommon.ts:46-56](../source/game/hellwave/client/menu/MenuCommon.ts#L46-L56))
  becomes a one-line forward to `engineAPI.Menu.toScreenPosition(x, y)` — and, unlike
  today, it now correctly follows whatever viewport hellwave's page actually declares
  instead of being permanently hardcoded to `320`/`200`.
- `MainMenu.#drawLogo()`'s `(LOGO_VIRTUAL_WIDTH * 2) / hiResLogoPic.width`
  ([MainMenu.ts:60](../source/game/hellwave/client/menu/MainMenu.ts#L60)) becomes
  `(LOGO_VIRTUAL_WIDTH * engineAPI.Menu.viewportScale) / hiResLogoPic.width` — the `2` was
  always "the current viewport's scale," just spelled out as a literal because there was no
  other way to ask for it.

`MenuPageConfig.viewport` is accepted directly by `RegisterPage`'s `MenuPage` construction
(it's just a field on the config object passed to `new Menu.MenuPage({ ..., viewport })`),
so no separate setter method is needed on `ClientEngineAPI.Menu`.

### F. Making new pages easier to design — corner/edge anchoring

This is the concrete answer to "make designing menu pages easier," beyond just picking a
bigger canvas. Today, positioning anything relative to an edge is hand-computed per page —
e.g. hellwave's own `BOTTOM_RIGHT_BUTTON_X = 304` / `BOTTOM_RIGHT_BUTTON_Y = 216`
([MenuCommon.ts:19-20](../source/game/hellwave/client/menu/MenuCommon.ts#L19-L20)), tuned
by hand against the classic 320×200 space and already commented as mirroring "the
page-agnostic Back button's bottom-left corner... with the same 16px margin... the
sidebar/logo use." Three different pages independently re-deriving the same "16px margin
from an edge" idea is exactly the friction a wider, per-page canvas would make worse, not
better, without a shared helper.

Add a small static helper on `MenuViewport` (or a sibling `MenuAnchor` module — naming TBD
during implementation):

```typescript
type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

// Given this page's virtual width/height and a measured content size, returns the
// top-left virtual-space position to draw at for the requested corner + margin.
anchor(corner: Corner, contentWidth: number, contentHeight: number, marginX = 16, marginY = 16): { x: number; y: number } {
  const x = corner.endsWith('left') ? marginX : this.width - marginX - contentWidth;
  const y = corner.startsWith('top') ? marginY : this.height - marginY - contentHeight;
  return { x, y };
}
```

`BOTTOM_RIGHT_BUTTON_X`/`Y` in `MenuCommon.ts` become
`hellwaveViewport.anchor('bottom-right', buttonWidth, buttonHeight)`, and any *future*
hellwave page reaches for the same call instead of hand-deriving new magic numbers. This is
engine-owned (on `MenuViewport`, not hellwave-local) since id1 pages could use it too, but
nothing requires id1 to adopt it — purely additive.

## Decisions needed from you

1. **hellwave's target virtual size.** Recommendation: **1280×720** (16:9), `fit: 'contain'`
   (not `integerScale` — hellwave's art is smooth hi-res PNG/JPG, not palette-indexed pixel
   art, so there's no nearest-neighbor crispness to protect, unlike id1's conchars/LMPs).
   This fills a widescreen display properly instead of sitting in a fixed 640×400 island,
   matches the wireframe's wide sidebar+session-list composition, and avoids imitating a
   specific 1998 SVGA mode (640×480) that has no particular relevance today. Open to a
   different number if you have one in mind (1920×1080 is the other obvious candidate — the
   only real tradeoff is finer-grained coordinates vs. bigger, easier-to-reason-about
   virtual pixels; 1280×720 vs 1920×1080 is purely a "how many virtual units per design
   decision" preference, the resulting scale-to-real-pixels math is identical either way).
2. **Ship the anchor helper (Design F) now, alongside the viewport, or defer it?** It's
   small, but it's scope beyond "give hellwave a bigger canvas" strictly speaking. I'd
   include it since `MenuCommon.ts` already has three independent hand-rolled edge-margin
   constants that would otherwise multiply as hellwave adds more pages — but flagging it as
   a separate decision in case you'd rather land the viewport alone first and see if the
   duplication actually gets worse before generalizing it.
3. **Back button on a wide canvas** ([Menu.ts:77-78](../source/engine/client/Menu.ts#L77)):
   keep it in the classic bottom-left virtual-space corner (proportional to whatever
   viewport is active), or should hellwave's pages override
   `customGetBackButtonAnchor()` to place it somewhere that fits the sidebar layout better?
   Not blocking — can be decided per-page during implementation — but flagging since it's
   the one piece of chrome every page gets "for free" regardless of viewport.

## Phasing

1. **Engine groundwork**: `MenuViewport` (Design A), `MenuPage.viewport` (Design B), wire
   into `M` (Design C), relax the `320` hit-test bound (Design D) — all additive, id1
   unaffected, verified against the regression test in Testing below.
2. **`ClientEngineAPI.Menu` surface** (Design E): `toScreenPosition`/`viewportScale`/
   `MenuViewport` export.
3. **hellwave adopts it**: set `viewport` on `main`/`hellwave_newgame`/`hellwave_profile`'s
   `MenuPage` construction, delete `MenuCommon.toScreenPosition()` and the `LOGO_VIRTUAL_WIDTH
   * 2` literal in favor of the new API, re-tune hellwave's own hand-placed constants
   (`SIDEBAR_X`, `SESSIONS_X`, `ROWS_START_Y`, `ROW_SPACING`, the card grid in
   `NewGameMenu.ts`, `MenuCommon`'s bottom-right button constants, ...) for the new
   1280×720 space.
4. **Anchor helper** (Design F), if confirmed in scope for this pass.

## Testing

- `MenuViewport.resolve()`: unit tests for both `fit` modes, `integerScale` on/off, and a
  **regression test asserting `MenuViewport.classic.resolve(w, h)` produces the exact same
  `{scale, originX, originY}` as manually computing `2` / `Math.floor(w/2) - 320` /
  `Math.floor(h/2) - 200`** for a spread of `VID.width`/`VID.height` values — the safety net
  protecting id1's pixel-perfectness through this refactor.
- `M`'s drawing primitives: existing tests (if any target `M` directly) continue passing
  unmodified against the default viewport; add a test that a page with a custom `viewport`
  produces different resolved screen coordinates than a page without one.
- Hit-testing: confirm `VerticalLayout`/`ListLayout` still correctly distinguish rows by Y
  and now accept clicks across the full width regardless of virtual canvas size (covers
  Design D independent of the viewport work).
- hellwave: update existing `MainMenu`/`NewGameMenu`/`ProfileMenu` tests for the new
  coordinate constants once picked; add a test that `MenuCommon.toScreenPosition` (now a
  thin forward) matches `engineAPI.Menu.toScreenPosition` for a non-classic viewport.
- Manual: id1 menu pixel-identical before/after at a couple of window sizes. hellwave menu
  now fills more of a widescreen viewport; verify mouse hit-testing still lines up with
  drawn positions, including after a live window resize (viewport must recompute on resize,
  not just at load — confirm `VID.width`/`height` are read fresh each `M.Draw()`/
  `MouseMove()` call, which they already are).

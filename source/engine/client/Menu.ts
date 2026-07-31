import type { SFX } from './Sound.ts';

import { K } from '../../shared/Keys.ts';
import Cmd from '../common/Cmd.ts';
import { clientConnectionState } from '../common/Def.ts';
import { eventBus, getClientRegistry } from '../registry.ts';
import type { BitmapFont } from './BitmapFont.ts';
import ClientLifecycle from './ClientLifecycle.ts';
import { GLTexture } from './GL.ts';
import { KeyDestination } from './Key.ts';
import type { BackButtonAnchor, MenuPage } from './menu/MenuPage.ts';
import { MenuStack } from './menu/MenuStack.ts';
import { MenuViewport, type ResolvedMenuViewport } from './menu/MenuViewport.ts';
import VID from './VID.ts';
import { MissingResourceError } from '../common/Errors.ts';

let { CL, COM, Draw, Key, S } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, Draw, Key, S } = getClientRegistry());
});

// An involuntary disconnect (server shutdown, kick, timeout) can happen with no menu open at
// all -- e.g. mid-gameplay. There's nothing to show without a game running, so bring the main
// menu back up rather than leaving the player at a blank/console-backdrop screen.
eventBus.subscribe('client.disconnected', () => {
  if (M.menuStack.isEmpty()) {
    M.Menu_Main_f();
  }
});

// Cold boot never fires `client.disconnected` (there's no prior connection to disconnect from),
// so without this the player would sit at a blank screen until they happened to press Escape or
// click. Fired once, right after the active game module has registered its pages -- see
// `ClientLifecycle.initGame()`.
eventBus.subscribe('client.game-initialized', () => {
  if (CL.cls.state === clientConnectionState.disconnected && M.menuStack.isEmpty()) {
    M.Menu_Main_f();
  }
});

// A connection attempt is starting -- via a menu action (which already calls ForceClose itself,
// making this a no-op there), a `+connect`/`+map` argument from a share link at cold boot, or a
// `connect`/`map` command typed directly into the console. The latter two never go through any
// menu code at all, so without this the menu (if one happened to be open, e.g. the main menu
// showing at cold boot) would just sit on top of the connecting/loading screen for the whole
// connect-and-load sequence instead of getting out of the way. Fires for every connection
// attempt, not just successful ones, since there's nothing useful left for the menu to show
// once the attempt has started either way.
eventBus.subscribe('client.connecting', () => {
  if (!M.menuStack.isEmpty()) {
    M.menuStack.clear();
    M.ReturnToGame();
  }
});

export type MenuPic = GLTexture & { translate?: GLTexture | null };

export default class M {
  static menuStack = new MenuStack();

  // The page whose viewport should resolve M's drawing primitives right now -- normally null,
  // meaning "use the top of the stack" (see #activeViewport()). Set for the duration of a
  // DialogPage drawing its backdrop (see withRenderingPage()), since the backdrop page draws
  // while a *different* page (the dialog itself) still sits on top of menuStack, and the
  // backdrop's own drawing calls must resolve against its own viewport, not the dialog's.
  static #renderingPage: MenuPage | null = null;

  static entersound = false;

  // Current mouse position in the current page's virtual menu-space coordinates (see
  // MenuViewport), updated by MouseMove().
  static mouseX = 0;
  static mouseY = 0;

  // Tracks whether the mouse (rather than the keyboard) was the most recent input, so the
  // Back/Close button can stay hidden for keyboard-only players. True while the mouse moves or
  // a mouse button/wheel is used; false the moment any other key is pressed.
  static #usingMouse = false;

  // Fixed, page-agnostic Back/Close button, drawn/hit-tested independently of whatever page is
  // active (same pattern as DrawOverlayNotice) so every page — including custom ones and future
  // game/mod pages — gets a clickable way back without having to add it to their own item list.
  // Pages that need it positioned elsewhere (e.g. centered under a dialog box) can override
  // MenuPage.getBackButtonAnchor() instead of using this default corner.
  static readonly #backButtonX = 8;
  static readonly #backButtonY = 224;

  static sfx_menu1: SFX | null = null;
  static sfx_menu2: SFX | null = null;
  static sfx_menu3: SFX | null = null;

  static box_tl: MenuPic = null!;
  static box_ml: MenuPic = null!;
  static box_bl: MenuPic = null!;
  static box_tm: MenuPic = null!;
  static box_mm: MenuPic = null!;
  static box_mm2: MenuPic = null!;
  static box_bm: MenuPic = null!;
  static box_tr: MenuPic = null!;
  static box_mr: MenuPic = null!;
  static box_br: MenuPic = null!;

  static menudot: MenuPic[] = [];

  static overlayNoticeId: string | null = null;
  static overlayNoticeLines: string[] = [];

  static #saveDemonum = 0; // THIS IS THE REASON WHY I HATE UNINITIALIZED PROPERTIES, this line was missing and it quietly caused some NaNs deep in the demo code…

  /**
   * The virtual drawing-space the current page draws in -- the current page's own `viewport`
   * (see `MenuPage`), or `MenuViewport.classic` (320x200, pixel-doubled) while no page is on the
   * stack at all (e.g. `DrawOverlayNotice()` during live gameplay).
   * @returns The active viewport and its transform resolved against the real canvas size.
   */
  static #activeViewport(): { viewport: MenuViewport; resolved: ResolvedMenuViewport } {
    const viewport = (M.#renderingPage ?? M.menuStack.current())?.viewport ?? MenuViewport.classic;
    return { viewport, resolved: viewport.resolve(VID.width, VID.height) };
  }

  /**
   * Run `draw` with `page`'s own viewport as the active one for M's drawing primitives, then
   * restore whatever was active before -- lets a page's draw() (see `MenuPage.draw()`) resolve
   * its own coordinates correctly even when called as another page's backdrop (see
   * `DialogPage.draw()`), while that other page still sits on top of `menuStack`.
   */
  static withRenderingPage(page: MenuPage, draw: () => void): void {
    const previous = M.#renderingPage;
    M.#renderingPage = page;
    try {
      draw();
    } finally {
      M.#renderingPage = previous;
    }
  }

  /**
   * Project a virtual-space point into real screen pixels, together with the scale factor a
   * drawing call needs to pass through to `Draw`/`BitmapFont`.
   * @returns The screen position and scale.
   */
  static #project(vx: number, vy: number): { x: number; y: number; scale: number } {
    const { viewport, resolved } = M.#activeViewport();
    const screen = viewport.toScreen(resolved, vx, vy);
    return { x: screen.x, y: screen.y, scale: resolved.scale };
  }

  /**
   * Convert a virtual-space point (in the current page's viewport) into a real screen pixel
   * position -- exposed to game code via `ClientEngineAPI.Menu.toScreenPosition` for a
   * `customDraw` that needs to place a resolution-aware `DrawPic`/`DrawString` call (a different
   * coordinate system from `M`'s own drawing primitives) at a virtual-space position.
   * @returns The equivalent real screen position.
   */
  static toScreenPosition(x: number, y: number): { x: number; y: number } {
    const { viewport, resolved } = M.#activeViewport();
    return viewport.toScreen(resolved, x, y);
  }

  /**
   * The current page's resolved virtual-to-real pixel scale -- exposed to game code via
   * `ClientEngineAPI.Menu.viewportScale`, e.g. to size a resolution-aware `DrawPic` call to match
   * a virtual-space target width.
   * @returns The scale factor.
   */
  static get viewportScale(): number {
    return M.#activeViewport().resolved.scale;
  }

  static DrawCharacter(cx: number, cy: number, num: number): void {
    const p = M.#project(cx, cy);
    Draw.Character(p.x, p.y, num, p.scale);
  }

  static Print(cx: number, cy: number, str: string): void {
    const p = M.#project(cx, cy);
    Draw.StringWhite(p.x, p.y, str, p.scale);
  }

  static PrintWhite(cx: number, cy: number, str: string): void {
    const p = M.#project(cx, cy);
    Draw.String(p.x, p.y, str, p.scale);
  }

  static DrawPic(x: number, y: number, pic: MenuPic): void {
    const p = M.#project(x, y);
    Draw.Pic(p.x, p.y, pic, p.scale);
  }

  static DrawPicTranslate(x: number, y: number, pic: MenuPic, top: number, bottom: number): void {
    const p = M.#project(x, y);
    Draw.PicTranslate(p.x, p.y, pic, top, bottom, p.scale);
  }

  /**
   * Draws a string with a custom `BitmapFont` instead of the standard conchars font, in the
   * current page's virtual coordinate space -- see `Print`/`PrintWhite`.
   */
  static DrawBitmapString(cx: number, cy: number, str: string, font: BitmapFont, variant = 0): void {
    const p = M.#project(cx, cy);
    font.draw(p.x, p.y, str, variant, p.scale);
  }

  static DrawTextBox(x: number, y: number, width: number, lines: number): void {
    let cx: number;
    let cy: number;
    let n: number;

    cy = y;
    M.DrawPic(x, cy, M.box_tl);
    for (n = 0; n < lines; n++) {
      M.DrawPic(x, cy += 8, M.box_ml);
    }
    M.DrawPic(x, cy + 8, M.box_bl);

    cx = x + 8;
    let p: MenuPic;
    for (; width > 0;) {
      cy = y;
      M.DrawPic(cx, y, M.box_tm);
      p = M.box_mm;
      for (n = 0; n < lines; n++) {
        M.DrawPic(cx, cy += 8, p);
        if (n === 0) {
          p = M.box_mm2;
        }
      }
      M.DrawPic(cx, cy + 8, M.box_bm);
      width -= 2;
      cx += 16;
    }

    cy = y;
    M.DrawPic(cx, cy, M.box_tr);
    for (n = 0; n < lines; n++) {
      M.DrawPic(cx, cy += 8, M.box_mr);
    }
    M.DrawPic(cx, cy + 8, M.box_br);
  }

  static DrawSlider(x: number, y: number, range: number): void {
    if (range < 0) {
      range = 0;
    } else if (range > 1) {
      range = 1;
    }
    M.DrawCharacter(x - 8, y, 128);
    M.DrawCharacter(x, y, 129);
    M.DrawCharacter(x + 8, y, 129);
    M.DrawCharacter(x + 16, y, 129);
    M.DrawCharacter(x + 24, y, 129);
    M.DrawCharacter(x + 32, y, 129);
    M.DrawCharacter(x + 40, y, 129);
    M.DrawCharacter(x + 48, y, 129);
    M.DrawCharacter(x + 56, y, 129);
    M.DrawCharacter(x + 64, y, 129);
    M.DrawCharacter(x + 72, y, 129);
    M.DrawCharacter(x + 80, y, 130);
    M.DrawCharacter(x + Math.floor(72 * range), y, 131);
  }

  static SetOverlayNotice(id: string, message: string): void {
    M.overlayNoticeId = id;
    M.overlayNoticeLines = message.split('\n');
  }

  static ClearOverlayNotice(id?: string): void {
    if (id !== undefined && M.overlayNoticeId !== id) {
      return;
    }

    M.overlayNoticeId = null;
    M.overlayNoticeLines = [];
  }

  static DrawOverlayNotice(): void {
    if (
      M.overlayNoticeLines.length === 0
      || M.menuStack.isShowing('alert')
      || M.menuStack.isShowing('quit')
    ) {
      return;
    }

    const { viewport } = M.#activeViewport();
    const widestLineLength = M.overlayNoticeLines.reduce((widest, line) => Math.max(widest, line.length), 0);
    const boxWidth = Math.max(24, Math.min(64, widestLineLength + 4));
    const maxTextLength = boxWidth - 2;
    const x = Math.floor((viewport.width - boxWidth * 8) / 2);
    const y = Math.max(28, Math.floor((viewport.height - (M.overlayNoticeLines.length + 6) * 8) / 2));

    M.DrawTextBox(x, y, boxWidth, M.overlayNoticeLines.length + 2);

    let textY = y + 16;
    for (const line of M.overlayNoticeLines) {
      if (line.length > 0) {
        M.PrintWhite(x + 16, textY, line.substring(0, maxTextLength));
      }
      textY += 8;
    }
  }

  /**
   * Convert a canvas-relative CSS-pixel mouse position into the current page's virtual
   * menu-space coordinates (inverting the transform every M.DrawPic/M.Print call applies) and
   * forward it to the active page's hover tracking.
   */
  static MouseMove(canvasX: number, canvasY: number): void {
    if (Key.destination !== KeyDestination.menu) {
      return;
    }

    const { viewport, resolved } = M.#activeViewport();
    const point = viewport.fromScreen(resolved, canvasX, canvasY);
    M.mouseX = point.x;
    M.mouseY = point.y;
    M.#usingMouse = true;

    M.menuStack.current()?.updateHover(M.mouseX, M.mouseY);
  }

  static #backButtonLabel(): string {
    return M.menuStack.depth() > 1 ? '< Back' : '< Close';
  }

  /**
   * Where to draw/hit-test the Back/Close button: the current page's own override (e.g. a
   * dialog centering it under its message box), the classic bottom-left corner for pages using
   * the default `MenuViewport.classic` (preserving the exact legacy position), or an
   * edge-anchored bottom-left corner (see `MenuViewport.anchor()`) for a page with its own,
   * differently-sized viewport, so a mod's pages get a sensibly placed button for free without
   * having to hand-tune one.
   * @returns The button's center-x and top-y in virtual menu-space coordinates.
   */
  static #backButtonAnchor(): BackButtonAnchor {
    const label = M.#backButtonLabel();
    const override = M.menuStack.current()?.getBackButtonAnchor() ?? null;
    if (override) {
      return override;
    }

    const halfWidth = (label.length * 8) / 2;
    const { viewport } = M.#activeViewport();
    if (viewport === MenuViewport.classic) {
      return { centerX: M.#backButtonX + halfWidth, y: M.#backButtonY };
    }

    const { x, y } = viewport.anchor('bottom-left', halfWidth * 2, 8);
    return { centerX: x + halfWidth, y };
  }

  static #backButtonBounds(): { x0: number; y0: number; x1: number; y1: number } {
    const label = M.#backButtonLabel();
    const halfWidth = (label.length * 8) / 2;
    const anchor = M.#backButtonAnchor();

    return {
      x0: anchor.centerX - halfWidth,
      y0: anchor.y,
      x1: anchor.centerX + halfWidth,
      y1: anchor.y + 8,
    };
  }

  /**
   * The button is hidden entirely at the root of the stack while disconnected: clicking it
   * there would try to close the whole menu, which M.CloseMenu() now refuses to do since
   * there's no game to return to (see M.CloseMenu()) -- showing a button that does nothing
   * would just be confusing.
   * @returns True if the Back/Close button should be shown/hit-tested this frame.
   */
  static #canShowBackButton(): boolean {
    if (!M.#usingMouse) {
      return false;
    }

    return M.menuStack.depth() > 1 || CL.cls.state === clientConnectionState.connected;
  }

  static #isOverBackButton(mx: number, my: number): boolean {
    if (!M.#canShowBackButton()) {
      return false;
    }

    const bounds = M.#backButtonBounds();
    return mx >= bounds.x0 && mx < bounds.x1 && my >= bounds.y0 && my < bounds.y1;
  }

  static #drawBackButton(): void {
    if (!M.#canShowBackButton()) {
      return;
    }

    const label = M.#backButtonLabel();
    const bounds = M.#backButtonBounds();
    if (M.#isOverBackButton(M.mouseX, M.mouseY)) {
      M.PrintWhite(bounds.x0, bounds.y0, label);
    } else {
      M.Print(bounds.x0, bounds.y0, label);
    }
  }

  static CloseMenu(): void {
    if (CL.cls.state !== clientConnectionState.connected) {
      // There's no game to return to while disconnected -- collapse back to the root page
      // instead of leaving nothing on screen to look at or interact with.
      if (!M.menuStack.isShowingRoot()) {
        M.menuStack.clear();
        M.menuStack.pushRoot();
      }
      return;
    }
    M.menuStack.clear();
    M.ReturnToGame();
  }

  static PopMenu(): void {
    M.menuStack.pop();
    if (M.menuStack.isEmpty()) {
      if (CL.cls.state !== clientConnectionState.connected) {
        M.menuStack.pushRoot();
        return;
      }
      M.ReturnToGame();
    }
  }

  /**
   * Whether single-player world simulation (monster think, physics, round timers, ...) should
   * keep running right now, consulted by `Host.ServerFrame()` for listen servers below
   * multiplayer capacity. `true` during gameplay; while a menu is open, defers to the current
   * page's `pausesGame` flag (`true` by default, matching classic pause-on-menu behavior) so a
   * page can opt out for a world that must keep running regardless of whether one player has a
   * menu open (e.g. an in-game buy menu in a coop mod). Always `false` for any other destination
   * (e.g. typing a chat message), unchanged from prior behavior.
   * @returns True if simulation should keep running.
   */
  static AllowsSimulation(): boolean {
    switch (Key.destination) {
      case KeyDestination.game:
        return true;
      case KeyDestination.menu:
        return M.menuStack.current()?.pausesGame === false;
      default:
        return false;
    }
  }

  /**
   * Return control to the game unconditionally, regardless of connection state -- unlike
   * CloseMenu(), which stays open while disconnected (there's nothing to return to). Used by
   * the two call sites above (once the menu is actually, fully closing) and by actions that are
   * themselves about to create a game to return to, e.g. starting a new game from a disconnected
   * menu (see ClientEngineAPI.Menu.ForceClose).
   */
  static ReturnToGame(): void {
    // `game` regardless of connection state: it's just "not the menu" now that the console is
    // an independent overlay rather than a destination to fall back into.
    Key.destination = KeyDestination.game;
    // Restore the demo-loop cursor paused (set to -1 in Menu_Main_f) when the menu was opened
    // over a playing demo, so ClientDemos can naturally advance to the next one when it ends.
    CL.cls.demonum = M.#saveDemonum;
  }

  /**
   * Start a new singleplayer game via the active mod's `StartGameInterface`, or the engine's
   * own default (`map start`) if the mod didn't provide one. Exposed to game code via
   * `ClientEngineAPI.Menu.StartSingleplayerGame` -- routed through `M` rather than importing
   * `ClientLifecycle` directly into `GameAPIs.ts`, which would create a circular import
   * (`ClientLifecycle.ts` already imports `GameAPIs.ts`).
   */
  static StartSingleplayerGame(): void {
    ClientLifecycle.startGame!.startSingleplayerGame();
  }

  /**
   * Start (host) a multiplayer game on `mapname` via the active mod's `StartGameInterface`, or
   * the engine's own default (`map <mapname>`) if the mod didn't provide one. Same routing
   * rationale as `StartSingleplayerGame` above -- exposed as
   * `ClientEngineAPI.Menu.StartMultiplayerGame`.
   */
  static StartMultiplayerGame(mapname: string): void {
    ClientLifecycle.startGame!.startMultiplayerGame(mapname);
  }

  /**
   * Load a lump-based pic together with a color-translation texture built from the raw palette
   * indices (for `DrawPicTranslate`, e.g. a player-color preview). This is the only way to get
   * the player picture translation right -- the palette-index parsing has to happen ourselves,
   * there's no higher-level asset pipeline for it.
   * @returns The pic, with `.translate` populated.
   */
  static async LoadTranslatablePic(lumpName: string): Promise<MenuPic> {
    const pic: MenuPic = Draw.LoadPicFromLumpDeferred(lumpName);

    const lmpfile = await COM.LoadFile(`gfx/${lumpName}.lmp`);
    if (lmpfile === null) {
      throw new MissingResourceError(`gfx/${lumpName}.lmp`);
    }

    const view = new DataView(lmpfile, 0, 8);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const data = new Uint8Array(lmpfile, 8, width * height);

    const trans = new Uint8Array(new ArrayBuffer(width * height * 4));

    for (let i = 0; i < width * height; i++) {
      const p = data[i];
      if ((p >> 4) === 1) {
        trans[i << 2] = (p & 15) * 17;
        trans[(i << 2) + 1] = 255;
      } else if ((p >> 4) === 6) {
        trans[(i << 2) + 2] = (p & 15) * 17;
        trans[(i << 2) + 3] = 255;
      }
    }

    pic.translate = GLTexture.Allocate(`${lumpName}_translate`, width, height, trans);

    return pic;
  }

  static ToggleMenu_f(this: void): void {
    M.entersound = true;
    // Only reachable via the Escape key or a bound command, never a mouse click, so opening or
    // cycling the menu this way always means the player is currently using the keyboard.
    M.#usingMouse = false;
    if (Key.destination === KeyDestination.menu) {
      if (!M.menuStack.isShowingRoot()) {
        M.Menu_Main_f();
        return;
      }
      M.CloseMenu();
      return;
    }
    M.Menu_Main_f();
  }

  /**
   * Push the root page (see `ClientEngineAPI.Menu.SetRootPage`), clearing the stack first --
   * the engine's only opinion on menu content is "there is a root, and Escape/an involuntary
   * disconnect goes there." Called directly from `Key.ts` (mouse click while disconnected with
   * the console up) in addition to the internal call sites below.
   */
  static Menu_Main_f(this: void): void {
    if (CL.cls.connecting !== null) {
      return;
    }

    if (Key.destination !== KeyDestination.menu) {
      M.#saveDemonum = CL.cls.demonum;
      CL.cls.demonum = -1;
    }
    Key.destination = KeyDestination.menu;
    M.menuStack.clear();
    M.menuStack.pushRoot();
  }

  // Menu Subsystem
  static async Init(): Promise<void> {
    Cmd.AddCommand('togglemenu', M.ToggleMenu_f);

    M.sfx_menu1 = S.PrecacheSound('misc/menu1.wav');
    M.sfx_menu2 = S.PrecacheSound('misc/menu2.wav');
    M.sfx_menu3 = S.PrecacheSound('misc/menu3.wav');

    M.box_tl = Draw.LoadPicFromLumpDeferred('box_tl');
    M.box_ml = Draw.LoadPicFromLumpDeferred('box_ml');
    M.box_bl = Draw.LoadPicFromLumpDeferred('box_bl');
    M.box_tm = Draw.LoadPicFromLumpDeferred('box_tm');
    M.box_mm = Draw.LoadPicFromLumpDeferred('box_mm');
    M.box_mm2 = Draw.LoadPicFromLumpDeferred('box_mm2');
    M.box_bm = Draw.LoadPicFromLumpDeferred('box_bm');
    M.box_tr = Draw.LoadPicFromLumpDeferred('box_tr');
    M.box_mr = Draw.LoadPicFromLumpDeferred('box_mr');
    M.box_br = Draw.LoadPicFromLumpDeferred('box_br');

    // eslint-disable-next-line require-atomic-updates
    M.menudot = await Promise.all([
      Draw.LoadPicFromLump('menudot1'),
      Draw.LoadPicFromLump('menudot2'),
      Draw.LoadPicFromLump('menudot3'),
      Draw.LoadPicFromLump('menudot4'),
      Draw.LoadPicFromLump('menudot5'),
      Draw.LoadPicFromLump('menudot6'),
    ]);

    // always close the menu when a connection progresses
    eventBus.subscribe('client.signon', () => {
      M.CloseMenu();
    });
  }

  static Draw(): void {
    const current = M.menuStack.current();
    if (current === null || Key.destination !== KeyDestination.menu) {
      return;
    }

    Draw.FadeScreen();
    current.draw();
    M.#drawBackButton();

    if (M.entersound) {
      S.LocalSound(M.sfx_menu2);
      M.entersound = false;
    }
  }

  static Keydown(key: number): void {
    const typedKey = key as K;

    // Any other key means the player switched back to the keyboard, so the mouse-only Back/Close
    // button should hide again until the mouse actually moves.
    M.#usingMouse = typedKey === K.MOUSE1 || typedKey === K.MOUSE2 || typedKey === K.MOUSE3
      || typedKey === K.MWHEELUP || typedKey === K.MWHEELDOWN;

    // The Back/Close button is drawn/hit-tested independently of the current page, so it takes
    // priority over whatever the page itself would do with a click at that position. It
    // synthesizes exactly what Escape already does on the current page (M.PopMenu()/CloseMenu()
    // via onEscape, or a page's own handleInput override), so behavior can never drift from
    // Escape's.
    if (typedKey === K.MOUSE1 && M.#isOverBackButton(M.mouseX, M.mouseY)) {
      S.LocalSound(M.sfx_menu2);
      M.menuStack.current()?.handleInput(K.ESCAPE);
      return;
    }

    M.menuStack.current()?.handleInput(typedKey);
  }

  /**
   * Forward pasted text (e.g. Ctrl+V) to the focused item of the current menu page.
   */
  static Paste(text: string): void {
    M.menuStack.current()?.handlePaste(text);
  }
}

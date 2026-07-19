import type { SFX } from './Sound.ts';

import { K } from '../../shared/Keys.ts';
import Cmd from '../common/Cmd.ts';
import { clientConnectionState } from '../common/Def.ts';
import { eventBus, getClientRegistry } from '../registry.ts';
import ClientLifecycle from './ClientLifecycle.ts';
import { GLTexture } from './GL.ts';
import { KeyDestination } from './Key.ts';
import type { BackButtonAnchor } from './menu/MenuPage.ts';
import { MenuStack } from './menu/MenuStack.ts';
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

export type MenuPic = GLTexture & { translate?: GLTexture | null };

export default class M {
  static menuStack = new MenuStack();

  static entersound = false;

  // Current mouse position in virtual 320x200 menu-space coordinates, updated by MouseMove().
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

  static DrawCharacter(cx: number, cy: number, num: number): void {
    Draw.Character(cx * 2 + Math.floor(VID.width / 2) - 320, cy * 2 + Math.floor(VID.height / 2) - 200, num, 2.0);
  }

  static Print(cx: number, cy: number, str: string): void {
    Draw.StringWhite(cx * 2 + Math.floor(VID.width / 2) - 320, cy * 2 + Math.floor(VID.height / 2) - 200, str, 2.0);
  }

  static PrintWhite(cx: number, cy: number, str: string): void {
    Draw.String(cx * 2 + Math.floor(VID.width / 2) - 320, cy * 2 + Math.floor(VID.height / 2) - 200, str, 2.0);
  }

  static DrawPic(x: number, y: number, pic: MenuPic): void {
    Draw.Pic(x * 2 + Math.floor(VID.width / 2) - 320, y * 2 + Math.floor(VID.height / 2) - 200, pic, 2.0);
  }

  static DrawPicTranslate(x: number, y: number, pic: MenuPic, top: number, bottom: number): void {
    Draw.PicTranslate(x * 2 + Math.floor(VID.width / 2) - 320, y * 2 + Math.floor(VID.height / 2) - 200, pic, top, bottom, 2.0);
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

    const widestLineLength = M.overlayNoticeLines.reduce((widest, line) => Math.max(widest, line.length), 0);
    const boxWidth = Math.max(24, Math.min(64, widestLineLength + 4));
    const maxTextLength = boxWidth - 2;
    const x = Math.floor((320 - boxWidth * 8) / 2);
    const y = Math.max(28, Math.floor((200 - (M.overlayNoticeLines.length + 6) * 8) / 2));

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
   * Convert a canvas-relative CSS-pixel mouse position into virtual menu-space coordinates
   * (inverting the transform every M.DrawPic/M.Print call applies) and forward it to the active
   * page's hover tracking.
   */
  static MouseMove(canvasX: number, canvasY: number): void {
    M.mouseX = (canvasX - (Math.floor(VID.width / 2) - 320)) / 2;
    M.mouseY = (canvasY - (Math.floor(VID.height / 2) - 200)) / 2;
    M.#usingMouse = true;

    if (Key.destination !== KeyDestination.menu) {
      return;
    }

    M.menuStack.current()?.updateHover(M.mouseX, M.mouseY);
  }

  static #backButtonLabel(): string {
    return M.menuStack.depth() > 1 ? '< Back' : '< Close';
  }

  /**
   * Where to draw/hit-test the Back/Close button: the current page's own override (e.g. a
   * dialog centering it under its message box), or the default bottom-left corner.
   * @returns The button's center-x and top-y in virtual menu-space coordinates.
   */
  static #backButtonAnchor(): BackButtonAnchor {
    const label = M.#backButtonLabel();
    const override = M.menuStack.current()?.getBackButtonAnchor() ?? null;
    if (override) {
      return override;
    }

    return { centerX: M.#backButtonX + (label.length * 8) / 2, y: M.#backButtonY };
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

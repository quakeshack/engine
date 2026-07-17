import type { SFX } from './Sound.ts';

import { K } from '../../shared/Keys.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { clientConnectionState } from '../common/Def.ts';
import { eventBus, getClientRegistry } from '../registry.ts';
import ClientLifecycle from './ClientLifecycle.ts';
import { GLTexture } from './GL.ts';
import { KeyDestination } from './Key.ts';
import { Action, ColorPicker, KeyBindItem, SaveSlotItem, Slider, Textbox, Toggle } from './menu/MenuItem.ts';
import type { BackButtonAnchor } from './menu/MenuPage.ts';
import { DialogPage, ImageBasedLayout, ListLayout, ListPage, MenuPage, VerticalLayout } from './menu/MenuPage.ts';
import { MenuStack } from './menu/MenuStack.ts';
import MultiplayerMainMenu from './menu/Multiplayer.ts';
import VID from './VID.ts';
import { MissingResourceError } from '../common/Errors.ts';

let { CL, COM, Con, Draw, Host, Key, S, SCR, SV } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, Con, Draw, Host, Key, S, SCR, SV } = getClientRegistry());
});

export type MenuPic = GLTexture & { translate?: GLTexture | null };
type SaveGameData = { comment?: string; mapname?: string };
type QuitMessage = [string, string, string, string];

const MAX_SAVEGAMES = 12;

const bindnames: [string, string][] = [
  ['+attack', 'attack'],
  ['impulse 10', 'change weapon'],
  ['+jump', 'jump / swim up'],
  ['+forward', 'walk forward'],
  ['+back', 'backpedal'],
  ['+left', 'turn left'],
  ['+right', 'turn right'],
  ['+speed', 'run'],
  ['+moveleft', 'step left'],
  ['+moveright', 'step right'],
  ['+strafe', 'sidestep'],
  ['+lookup', 'look up'],
  ['+lookdown', 'look down'],
  ['centerview', 'center view'],
  ['+mlook', 'mouse look'],
  ['+klook', 'keyboard look'],
  ['+moveup', 'swim up'],
  ['+movedown', 'swim down'],
];

const quitMessage: QuitMessage[] = [
  ['  Are you gonna quit', '  this game just like', '   everything else?', ''],
  [' Milord, methinks that', '   thou art a lowly', ' quitter. Is this true?', ''],
  [' Do I need to bust your', '  face open for trying', '        to quit?', ''],
  [' Man, I oughta smack you', '   for trying to quit!', '     Press Y to get', '      smacked out.'],
  [' Press Y to quit like a', '   big loser in life.', '  Press N to stay proud', '    and successful!'],
  ['   If you press Y to', '  quit, I will summon', '  Satan all over your', '      hard drive!'],
  ['  Um, Asmodeus dislikes', ' his children trying to', ' quit. Press Y to return', '   to your Tinkertoys.'],
  ['  If you quit now, I\'ll', '  throw a blanket-party', '   for you next time!', ''],
];

const launchServerMenu = new MultiplayerMainMenu();

/**
 * Full-screen help picture viewer; Left/Right (or Up/Down) flip pages, Escape goes back.
 */
class HelpPage extends MenuPage {
  pageIndex = 0;

  constructor() {
    super({ onEscape: () => { M.PopMenu(); } });
  }

  override draw(): void {
    M.DrawPic(0, 0, M.help_pages[this.pageIndex]);
  }

  override handleInput(key: K): boolean {
    if (key === K.UPARROW || key === K.RIGHTARROW) {
      M.entersound = true;
      this.pageIndex = (this.pageIndex + 1) % M.help_pages.length;
      return true;
    }

    if (key === K.DOWNARROW || key === K.LEFTARROW) {
      M.entersound = true;
      this.pageIndex = (this.pageIndex - 1 + M.help_pages.length) % M.help_pages.length;
      return true;
    }

    return super.handleInput(key);
  }

  override activate(): void {
    super.activate();
    this.pageIndex = 0;
  }
}

/**
 * Key-binding menu; shows different instructional text while capturing a keypress to bind.
 */
class KeysPage extends MenuPage {
  override draw(): void {
    super.draw();

    const focused = this.items[this.cursor];
    const capturing = focused instanceof KeyBindItem && focused.capturing;

    if (capturing) {
      M.Print(12, 32, 'Press a key or button for this action');
    } else {
      M.Print(18, 32, 'Enter to change, backspace to clear');
    }
  }
}

/**
 * Quit confirmation dialog. Y confirms, N/Escape returns to whatever page was open before it.
 */
export class QuitDialogPage extends DialogPage {
  static readonly #boxX = 56;
  static readonly #boxY = 76;
  static readonly #boxWidth = 24; // in DrawTextBox's content-width units (8px each)
  static readonly #boxLines = 5; // 4 flavor-text lines + 1 Yes/No prompt row

  // Row for the mouse-clickable Yes/No prompt, below the 4 lines of flavor text.
  static readonly #promptY = 116;
  static readonly #yesX = 88;
  static readonly #noX = 168;

  #messageIndex = 0;

  constructor() {
    super({
      onEscape: () => { M.PopMenu(); },
      getBackdrop: () => {
        const stack = M.menuStack.stack;
        return stack.length > 1 ? stack[stack.length - 2] : null;
      },
    });
  }

  override activate(): void {
    super.activate();
    this.#messageIndex = Math.floor(Math.random() * quitMessage.length);
  }

  static #isOverPrompt(x: number, label: string): boolean {
    return M.mouseX >= x && M.mouseX < x + label.length * 8
      && M.mouseY >= QuitDialogPage.#promptY && M.mouseY < QuitDialogPage.#promptY + 8;
  }

  static #drawPrompt(x: number, label: string): void {
    if (QuitDialogPage.#isOverPrompt(x, label)) {
      M.PrintWhite(x, QuitDialogPage.#promptY, label);
    } else {
      M.Print(x, QuitDialogPage.#promptY, label);
    }
  }

  #confirmQuit(): void {
    Key.destination = KeyDestination.console;
    Host.Quit_f();
  }

  override draw(): void {
    super.draw();

    const message = quitMessage[this.#messageIndex];
    M.DrawTextBox(QuitDialogPage.#boxX, QuitDialogPage.#boxY, QuitDialogPage.#boxWidth, QuitDialogPage.#boxLines);
    M.Print(64, 84, message[0]);
    M.Print(64, 92, message[1]);
    M.Print(64, 100, message[2]);
    M.Print(64, 108, message[3]);
    QuitDialogPage.#drawPrompt(QuitDialogPage.#yesX, 'Yes');
    QuitDialogPage.#drawPrompt(QuitDialogPage.#noX, 'No');
  }

  override getBackButtonAnchor(): BackButtonAnchor {
    const totalWidth = 16 + QuitDialogPage.#boxWidth * 8;
    const boxBottom = QuitDialogPage.#boxY + (QuitDialogPage.#boxLines + 2) * 8;
    return { centerX: QuitDialogPage.#boxX + totalWidth / 2, y: boxBottom + 8 };
  }

  override handleInput(key: K): boolean {
    if (key === 110 as K) { // 'n'
      M.PopMenu();
      return true;
    }

    if (key === 121 as K) { // 'y'
      this.#confirmQuit();
      return true;
    }

    if (key === K.MOUSE1 && QuitDialogPage.#isOverPrompt(QuitDialogPage.#yesX, 'Yes')) {
      this.#confirmQuit();
      return true;
    }

    if (key === K.MOUSE1 && QuitDialogPage.#isOverPrompt(QuitDialogPage.#noX, 'No')) {
      M.PopMenu();
      return true;
    }

    return super.handleInput(key);
  }
}

/**
 * A dismissable alert/error dialog with a dynamically sized text box.
 */
class AlertDialogPage extends MenuPage {
  static readonly #boxY = 52;
  static readonly #boxWidth = 64; // in DrawTextBox's content-width units (8px each)

  #title = '';
  #message = '';

  constructor() {
    super({
      onEscape: () => { M.CloseMenu(); },
      onConfirm: () => { M.CloseMenu(); },
    });
  }

  setMessage(title: string, message: string): void {
    this.#title = title;
    this.#message = message;
  }

  /**
   * Build the message's text-box layout: the lines to draw, the box's left edge, and its
   * total line count. Shared between draw() and getBackButtonAnchor() so both agree on where
   * the box actually ends up.
   * @returns The box's left edge, total line count, and the lines themselves.
   */
  #computeBoxMetrics(): { x: number; totalLines: number; lines: Array<string | null> } {
    const titleLines = this.#title ? this.#title.split('\n') : [];
    const messageLines = this.#message ? this.#message.split('\n') : [];

    const lines: Array<string | null> = [];
    if (titleLines.length) {
      lines.push(...titleLines);
      lines.push(`\x1d${'\x1e'.repeat(60)}\x1f`);
    }

    lines.push(null);

    if (messageLines.length) {
      lines.push(...messageLines);
    }

    lines.push(null);
    lines.push('Press enter to continue.');

    const totalLines = lines.length;
    const x = (320 - AlertDialogPage.#boxWidth * 8) / 2;

    return { x, totalLines, lines };
  }

  override draw(): void {
    const { x, totalLines, lines } = this.#computeBoxMetrics();

    M.DrawTextBox(x, AlertDialogPage.#boxY, AlertDialogPage.#boxWidth, totalLines + 2);

    for (let i = 0, y = 68; i < totalLines; i++, y += 8) {
      if (lines[i]) {
        // Limit each line to 62 characters for safe drawing
        M.PrintWhite(x + 16, y, lines[i]!.substring(0, 62));
      }
    }
  }

  override getBackButtonAnchor(): BackButtonAnchor {
    const { x, totalLines } = this.#computeBoxMetrics();
    const totalWidth = 16 + AlertDialogPage.#boxWidth * 8;
    const boxBottom = AlertDialogPage.#boxY + (totalLines + 2 + 2) * 8;
    return { centerX: x + totalWidth / 2, y: boxBottom + 8 };
  }
}

/**
 * A name-entry row matching the original multiplayer screen's layout: label on the left,
 * input box in a fixed column to the right (rather than stacked below the label), so it
 * doesn't compete for horizontal space with the player skin preview next to it.
 */
class NameFieldTextbox extends Textbox {
  static readonly #boxX = 160;

  override draw(x: number, y: number, focused: boolean): void {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);
    M.DrawTextBox(NameFieldTextbox.#boxX, y - 8, this.width, 1);
    M.PrintWhite(NameFieldTextbox.#boxX + 8, y, this.getValue());

    if (focused) {
      const glyph = this._getCursorGlyph((Host.realtime * 4.0) & 1);
      if (glyph !== null) {
        M.DrawCharacter(NameFieldTextbox.#boxX + 8 + this.cursorPos * 8, y, glyph);
      }
    }
  }
}

/**
 * Legacy multiplayer setup screen: player name, shirt/pants color, then either joins the
 * server browser (not yet connected) or applies profile changes immediately (connected).
 */
export class MultiplayerSetupPage extends MenuPage {
  top = 0;
  bottom = 0;
  #oldTop = 0;
  #oldBottom = 0;
  #nameTextbox: Textbox;

  constructor() {
    const nameTextbox = new NameFieldTextbox({ label: 'Your name', width: 16, maxLength: 14, heightOverride: 24 });
    const joinAction = new Action({ label: 'Join Game' });

    super({
      logoPic: M.qplaque,
      titlePic: M.p_multi,
      layout: new VerticalLayout({ startY: 48, spacing: 0, labelX: 64, cursorX: 56 }),
      items: [
        nameTextbox,
        new ColorPicker({
          label: 'Shirt color',
          heightOverride: 24,
          getValue: () => this.top,
          setValue: (value) => { this.top = value; },
        }),
        new ColorPicker({
          label: 'Pants color',
          heightOverride: 36,
          getValue: () => this.bottom,
          setValue: (value) => { this.bottom = value; },
        }),
        joinAction,
      ],
      onEscape: () => { M.PopMenu(); },
      onEnter: () => {
        nameTextbox.value = CL.name.string;
        this.top = this.#oldTop = CL.color.value >> 4;
        this.bottom = this.#oldBottom = CL.color.value & 15;
        joinAction.label = CL.cls.state !== clientConnectionState.connected ? 'Join Game' : 'Accept Changes';
      },
    });

    this.#nameTextbox = nameTextbox;

    joinAction.action = () => {
      if (CL.name.string !== this.#nameTextbox.getValue()) {
        Cmd.text += `name "${this.#nameTextbox.getValue()}"\n`;
      }

      if (this.top !== this.#oldTop || this.bottom !== this.#oldBottom) {
        this.#oldTop = this.top;
        this.#oldBottom = this.bottom;
        Cmd.text += `color ${this.top} ${this.bottom}\n`;
      }

      if (CL.cls.state !== clientConnectionState.connected) {
        M.Menu_Launch_Server_f();
        return;
      }

      M.CloseMenu();
    };
  }

  override draw(): void {
    super.draw();

    M.DrawPic(160, 56, M.bigbox);
    M.DrawPicTranslate(
      172, 64, M.menuplyr,
      (this.top << 4) + (this.top >= 8 ? 4 : 11),
      (this.bottom << 4) + (this.bottom >= 8 ? 4 : 11),
    );
  }
}

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

  static qplaque: MenuPic = null!;
  static menudot: MenuPic[] = [];
  static ttl_main: MenuPic = null!;
  static mainmenu: MenuPic = null!;

  static ttl_sgl: MenuPic = null!;
  static sp_menu: MenuPic = null!;
  static p_load: MenuPic = null!;
  static p_save: MenuPic = null!;

  static p_multi: MenuPic = null!;
  static bigbox: MenuPic = null!;
  static menuplyr: MenuPic = null!;

  static p_option: MenuPic = null!;
  static ttl_cstm: MenuPic = null!;
  static help_pages: MenuPic[] = [];

  static overlayNoticeId: string | null = null;
  static overlayNoticeLines: string[] = [];

  static #saveDemonum = 0; // THIS IS THE REASON WHY I HATE UNINITIALIZED PROPERTIES, this line was missing and it quietly caused some NaNs deep in the demo code…

  static #loadSlotItems: SaveSlotItem[] = [];
  static #saveSlotItems: SaveSlotItem[] = [];

  static #mainPage: MenuPage = null!;
  static #alertPage: AlertDialogPage = null!;
  static #quitPage: QuitDialogPage = null!;
  static #multiplayerPage: MenuPage = null!;

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
    const current = M.menuStack.current();

    if (
      M.overlayNoticeLines.length === 0
      || current === M.#alertPage
      || current === M.#quitPage
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

  static #isOverBackButton(mx: number, my: number): boolean {
    if (!M.#usingMouse) {
      return false;
    }

    const bounds = M.#backButtonBounds();
    return mx >= bounds.x0 && mx < bounds.x1 && my >= bounds.y0 && my < bounds.y1;
  }

  static #drawBackButton(): void {
    if (!M.#usingMouse) {
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
    M.menuStack.clear();
    M.#returnToPreviousDestination();
  }

  static PopMenu(): void {
    M.menuStack.pop();
    if (M.menuStack.isEmpty()) {
      M.#returnToPreviousDestination();
    }
  }

  static #returnToPreviousDestination(): void {
    if (CL.cls.state === clientConnectionState.connected) {
      Key.destination = KeyDestination.game;
    } else {
      Key.destination = KeyDestination.console;
    }
  }

  static ToggleMenu_f(this: void): void {
    M.entersound = true;
    // Only reachable via the Escape key or a bound command, never a mouse click, so opening or
    // cycling the menu this way always means the player is currently using the keyboard.
    M.#usingMouse = false;
    if (Key.destination === KeyDestination.menu) {
      if (M.menuStack.current() !== M.#mainPage) {
        M.Menu_Main_f();
        return;
      }
      M.CloseMenu();
      return;
    }
    M.Menu_Main_f();
  }

  // Main menu
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
    M.menuStack.push('main');
  }

  // Single player menu
  static Menu_SinglePlayer_f(this: void): void {
    Key.destination = KeyDestination.menu;
    M.menuStack.push('singleplayer');
  }

  // Load/save menu
  static Menu_Load_f(this: void): void {
    Key.destination = KeyDestination.menu;
    M.menuStack.push('load');
  }

  static Menu_Save_f(this: void): void {
    if (!SV.server.active || CL.state.intermission !== 0 || SV.svs.maxclients !== 1) {
      return;
    }
    Key.destination = KeyDestination.menu;
    M.menuStack.push('save');
  }

  // Multiplayer menu
  static Menu_MultiPlayer_f(this: void): void {
    if (M.menuStack.current() === M.#multiplayerPage) {
      return;
    }
    Key.destination = KeyDestination.menu;
    M.menuStack.push('multiplayer');
  }

  // Options menu
  static Menu_Options_f(this: void): void {
    Key.destination = KeyDestination.menu;
    M.menuStack.push('options');
  }

  // Keys menu
  static Menu_Keys_f(this: void): void {
    Key.destination = KeyDestination.menu;
    M.menuStack.push('keys');
  }

  // Help menu
  static Menu_Help_f(this: void): void {
    Key.destination = KeyDestination.menu;
    M.menuStack.push('help');
  }

  // Quit menu
  static Menu_Quit_f(this: void): void {
    if (M.menuStack.current() === M.#quitPage) {
      return;
    }
    Key.destination = KeyDestination.menu;
    M.menuStack.push('quit');
  }

  static Menu_Launch_Server_f(this: void): void {
    if (M.menuStack.current() === launchServerMenu) {
      return;
    }
    Key.destination = KeyDestination.menu;
    M.menuStack.push('launch_server');
  }

  static Alert(title: string, message: string): void {
    if (M.menuStack.current() === M.#alertPage) {
      return;
    }
    M.#alertPage.setMessage(title, message);
    Key.destination = KeyDestination.menu;
    M.menuStack.push('alert'); // TODO: have a different sound
  }

  static #scanSaves(): void {
    const searchpaths = COM.searchpaths;
    const search = `Quake.${COM.gamedir![0].filename}/s`;
    COM.searchpaths = COM.gamedir!;

    for (let i = 0; i < MAX_SAVEGAMES; i++) {
      const raw = localStorage.getItem(`${search}${i}.json`);
      const hasFile = raw !== null;
      let label = 'Empty slot';

      if (hasFile) {
        const gamestate = JSON.parse(raw!) as SaveGameData;
        label = gamestate.comment || gamestate.mapname || '';
      }

      M.#loadSlotItems[i].label = label;
      M.#loadSlotItems[i].enabled = hasFile;
      M.#loadSlotItems[i].canDelete = hasFile;
      M.#saveSlotItems[i].label = label;
      M.#saveSlotItems[i].canDelete = hasFile;
    }

    COM.searchpaths = searchpaths;
  }

  static #buildPages(): void {
    const mainPage = new MenuPage({
      logoPic: M.qplaque,
      titlePic: M.ttl_main,
      layout: new ImageBasedLayout({ backgroundPic: M.mainmenu }),
      items: [
        new Action({ action: () => { M.Menu_SinglePlayer_f(); } }),
        new Action({ action: () => { M.Menu_MultiPlayer_f(); } }),
        new Action({ action: () => { M.Menu_Options_f(); } }),
        new Action({ action: () => { M.Menu_Help_f(); } }),
        new Action({ action: () => { M.Menu_Quit_f(); } }),
      ],
      onEscape: () => {
        M.CloseMenu();
        CL.cls.demonum = M.#saveDemonum;
        if (CL.cls.demonum !== -1 && !CL.cls.demoplayback && CL.cls.state !== clientConnectionState.connected) {
          CL.NextDemo();
        }
      },
    });

    const singlePlayerPage = new MenuPage({
      logoPic: M.qplaque,
      titlePic: M.ttl_sgl,
      layout: new ImageBasedLayout({ backgroundPic: M.sp_menu }),
      items: [
        new Action({
          action: () => {
            if (SV.server.active) {
              void Cmd.ExecuteString('disconnect');
            }
            Key.destination = KeyDestination.game;
            ClientLifecycle.startGame!.startSingleplayerGame();
          },
        }),
        new Action({ action: () => { M.Menu_Load_f(); } }),
        new Action({ action: () => { M.Menu_Save_f(); } }),
      ],
      onEscape: () => { M.PopMenu(); },
    });

    M.#loadSlotItems = Array.from({ length: MAX_SAVEGAMES }, (_, index) => new SaveSlotItem({
      label: 'Empty slot',
      onActivate: () => {
        S.LocalSound(M.sfx_menu2);
        if (!M.#loadSlotItems[index].enabled) {
          return;
        }
        M.CloseMenu();
        SCR.BeginLoadingPlaque();
        Cmd.text += `load s${index}\n`;
      },
      onDelete: () => {
        if (!confirm('Delete selected game?')) {
          return;
        }
        localStorage.removeItem(`Quake.${COM.gamedir![0].filename}/s${index}.sav`);
        M.#scanSaves();
      },
    }));

    const loadPage = new ListPage({
      titlePic: M.p_load,
      layout: new ListLayout(),
      items: M.#loadSlotItems,
      onEscape: () => { M.PopMenu(); },
      onEnter: () => { M.#scanSaves(); },
    });

    M.#saveSlotItems = Array.from({ length: MAX_SAVEGAMES }, (_, index) => new SaveSlotItem({
      label: 'Empty slot',
      onActivate: () => {
        M.CloseMenu();
        Cmd.text += `save s${index}\n`;
      },
      onDelete: () => {
        if (!confirm('Delete selected game?')) {
          return;
        }
        localStorage.removeItem(`Quake.${COM.gamedir![0].filename}/s${index}.sav`);
        M.#scanSaves();
      },
    }));

    const savePage = new ListPage({
      titlePic: M.p_save,
      layout: new ListLayout(),
      items: M.#saveSlotItems,
      onEscape: () => { M.PopMenu(); },
      onEnter: () => { M.#scanSaves(); },
    });

    const multiplayerSetupPage = new MultiplayerSetupPage();

    const optionsPage = new MenuPage({
      logoPic: M.qplaque,
      titlePic: M.p_option,
      layout: new VerticalLayout({ startY: 32, spacing: 0, valueX: 220, cursorX: 200 }),
      items: [
        new Action({ label: 'Customize controls', action: () => { M.Menu_Keys_f(); } }),
        new Action({
          label: 'Go to console',
          action: () => {
            M.CloseMenu();
            Con.ToggleConsole_f();
          },
        }),
        new Action({ label: 'Reset to defaults', action: () => { Cmd.text += 'exec default.cfg\n'; } }),
        new Slider({ label: 'Screen size', cvar: 'viewsize', min: 30, max: 120, step: 10 }),
        new Slider({ label: 'Brightness', cvar: 'gamma', min: 0.5, max: 1.0, step: 0.05, invert: true }),
        new Slider({ label: 'Mouse Speed', cvar: 'sensitivity', min: 1, max: 11, step: 0.5 }),
        new Slider({ label: 'CD Music Volume', cvar: 'bgmvolume', min: 0, max: 1, step: 0.1 }),
        new Slider({ label: 'Sound Volume', cvar: 'volume', min: 0, max: 1, step: 0.1 }),
        new Toggle({
          label: 'Always Run',
          getValue: () => (CL.forwardspeed.value > 200.0 ? 1 : 0),
          setValue: (value) => {
            const speed = value ? 400.0 : 200.0;
            Cvar.Set('cl_forwardspeed', speed);
            Cvar.Set('cl_backspeed', speed);
          },
        }),
        new Toggle({
          label: 'Invert Mouse',
          getValue: () => (CL.m_pitch.value < 0.0 ? 1 : 0),
          setValue: () => { Cvar.Set('m_pitch', -CL.m_pitch.value); },
        }),
        new Toggle({ label: 'Lookspring', cvar: 'lookspring' }),
        new Toggle({ label: 'Lookstrafe', cvar: 'lookstrafe' }),
      ],
      onEscape: () => { M.PopMenu(); },
    });

    const keysPage = new KeysPage({
      titlePic: M.ttl_cstm,
      layout: new VerticalLayout({ startY: 48, spacing: 0, labelX: 16, showCursor: false }),
      items: bindnames.map(([command, label]) => new KeyBindItem({ label, command })),
      onEscape: () => { M.PopMenu(); },
    });

    const helpPage = new HelpPage();
    const quitPage = new QuitDialogPage();
    const alertPage = new AlertDialogPage();

    M.menuStack.register('main', mainPage);
    M.menuStack.register('singleplayer', singlePlayerPage);
    M.menuStack.register('load', loadPage);
    M.menuStack.register('save', savePage);
    M.menuStack.register('multiplayer', multiplayerSetupPage);
    M.menuStack.register('options', optionsPage);
    M.menuStack.register('keys', keysPage);
    M.menuStack.register('help', helpPage);
    M.menuStack.register('quit', quitPage);
    M.menuStack.register('alert', alertPage);
    M.menuStack.register('launch_server', launchServerMenu);

    M.#mainPage = mainPage;
    M.#alertPage = alertPage;
    M.#quitPage = quitPage;
    M.#multiplayerPage = multiplayerSetupPage;
  }

  // Menu Subsystem
  static async Init(): Promise<void> {
    Cmd.AddCommand('togglemenu', M.ToggleMenu_f);
    Cmd.AddCommand('menu_main', M.Menu_Main_f);
    Cmd.AddCommand('menu_singleplayer', M.Menu_SinglePlayer_f);
    Cmd.AddCommand('menu_load', M.Menu_Load_f);
    Cmd.AddCommand('menu_save', M.Menu_Save_f);
    Cmd.AddCommand('menu_multiplayer', M.Menu_MultiPlayer_f);
    Cmd.AddCommand('menu_setup', M.Menu_MultiPlayer_f);
    Cmd.AddCommand('menu_options', M.Menu_Options_f);
    Cmd.AddCommand('menu_keys', M.Menu_Keys_f);
    Cmd.AddCommand('help', M.Menu_Help_f);
    Cmd.AddCommand('menu_quit', M.Menu_Quit_f);
    Cmd.AddCommand('menu_server_launch', M.Menu_Launch_Server_f);

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

    M.qplaque = Draw.LoadPicFromLumpDeferred('qplaque');

    // eslint-disable-next-line require-atomic-updates
    M.menudot = await Promise.all([
      Draw.LoadPicFromLump('menudot1'),
      Draw.LoadPicFromLump('menudot2'),
      Draw.LoadPicFromLump('menudot3'),
      Draw.LoadPicFromLump('menudot4'),
      Draw.LoadPicFromLump('menudot5'),
      Draw.LoadPicFromLump('menudot6'),
    ]);

    // eslint-disable-next-line require-atomic-updates
    M.ttl_main = await Draw.LoadPicFromLump('ttl_main');
    // eslint-disable-next-line require-atomic-updates
    M.mainmenu = await Draw.LoadPicFromLump('mainmenu');

    // eslint-disable-next-line require-atomic-updates
    M.ttl_sgl = Draw.LoadPicFromLumpDeferred('ttl_sgl');
    // eslint-disable-next-line require-atomic-updates
    M.sp_menu = Draw.LoadPicFromLumpDeferred('sp_menu');
    // eslint-disable-next-line require-atomic-updates
    M.p_load = Draw.LoadPicFromLumpDeferred('p_load');
    // eslint-disable-next-line require-atomic-updates
    M.p_save = Draw.LoadPicFromLumpDeferred('p_save');

    // eslint-disable-next-line require-atomic-updates
    M.p_multi = Draw.LoadPicFromLumpDeferred('p_multi');
    // eslint-disable-next-line require-atomic-updates
    M.bigbox = Draw.LoadPicFromLumpDeferred('bigbox');
    // eslint-disable-next-line require-atomic-updates
    M.menuplyr = Draw.LoadPicFromLumpDeferred('menuplyr');

    // FIXME: I really don’t like this, but it’s the only way to get the player picture translation right for now
    {
      const lmpfile = await COM.LoadFile('gfx/menuplyr.lmp');
      if (lmpfile === null) {
        throw new MissingResourceError('gfx/menuplyr.lmp');
      }

      const view = new DataView(lmpfile, 0, 8);
      const width = view.getUint32(0, true);
      const height = view.getUint32(4, true);
      const data = new Uint8Array(lmpfile, 8, width * height);

      const trans = new Uint8Array(new ArrayBuffer(width * height * 4));

      for (let i = 0; i < 4096; i++) {
        const p = data[i];
        if ((p >> 4) === 1) {
          trans[i << 2] = (p & 15) * 17;
          trans[(i << 2) + 1] = 255;
        } else if ((p >> 4) === 6) {
          trans[(i << 2) + 2] = (p & 15) * 17;
          trans[(i << 2) + 3] = 255;
        }
      }

      // eslint-disable-next-line require-atomic-updates
      M.menuplyr.translate = GLTexture.Allocate('menuplyr_translate', width, height, trans);
    }

    // eslint-disable-next-line require-atomic-updates
    M.p_option = Draw.LoadPicFromLumpDeferred('p_option');
    // eslint-disable-next-line require-atomic-updates
    M.ttl_cstm = Draw.LoadPicFromLumpDeferred('ttl_cstm');

    // eslint-disable-next-line require-atomic-updates
    M.help_pages = [
      Draw.LoadPicFromLumpDeferred('help0'),
      Draw.LoadPicFromLumpDeferred('help1'),
      Draw.LoadPicFromLumpDeferred('help2'),
      Draw.LoadPicFromLumpDeferred('help3'),
      Draw.LoadPicFromLumpDeferred('help4'),
      Draw.LoadPicFromLumpDeferred('help5'),
    ];

    await launchServerMenu.init();

    M.#buildPages();

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

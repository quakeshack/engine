import { K } from '../../../shared/Keys.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import type { MenuPic } from '../Menu.ts';
import { MenuItem } from './MenuItem.ts';

interface MenuPageConfig {
  readonly items?: MenuItem[];
  readonly layout?: MenuLayout | null;
  readonly title?: string | null;
  readonly titlePic?: MenuPic | null;
  readonly logoPic?: MenuPic | null;
  readonly onEnter?: () => void;
  readonly onExit?: () => void;
  readonly onEscape?: (() => void) | null;
  readonly onConfirm?: (() => void) | null;
  readonly customDraw?: ((page: MenuPage) => void) | null;
  readonly customHandleInput?: ((key: K, page: MenuPage, defaultHandleInput: (key: K) => boolean) => boolean) | null;
  readonly customGetBackButtonAnchor?: (() => BackButtonAnchor | null) | null;
}

interface VerticalLayoutConfig {
  readonly startY?: number;
  readonly spacing?: number;
  readonly labelX?: number;
  readonly valueX?: number | null;
  readonly showCursor?: boolean;
  readonly cursorX?: number;
}

interface ImageBasedLayoutConfig {
  readonly backgroundPic?: MenuPic | null;
  readonly backgroundX?: number;
  readonly backgroundY?: number;
  readonly cursorX?: number;
  readonly cursorYBase?: number;
  readonly cursorYSpacing?: number;
}

interface ListLayoutConfig {
  readonly startX?: number;
  readonly startY?: number;
  readonly spacing?: number;
  readonly cursorX?: number;
}

interface GridLayoutConfig {
  readonly columns?: number;
  readonly startX?: number;
  readonly startY?: number;
  readonly columnSpacing?: number;
  readonly rowSpacing?: number;
}

export interface MenuLayout {
  draw(items: MenuItem[], focusedIndex: number): void;

  /**
   * Resolve which item, if any, occupies the given point in virtual menu-space coordinates.
   * @returns The index of the focusable item under the point, or null if none.
   */
  hitTest(items: MenuItem[], px: number, py: number): number | null;
}

/** Where M should draw/hit-test the page-agnostic Back/Close button, in virtual menu-space. */
export interface BackButtonAnchor {
  readonly centerX: number;
  readonly y: number;
}

// Destructure registry modules
let { Host, M, S } = getClientRegistry();

// Update when registry is frozen
eventBus.subscribe('registry.frozen', () => {
  ({ Host, M, S } = getClientRegistry());
});

/**
 * A menu page containing items with automatic navigation.
 */
export class MenuPage {
  items: MenuItem[];
  layout: MenuLayout | null;
  title: string | null;
  titlePic: MenuPic | null;
  logoPic: MenuPic | null;
  cursor: number;
  onEnter: () => void;
  onExit: () => void;
  onEscape: (() => void) | null;
  onConfirm: (() => void) | null;
  customDraw: ((page: MenuPage) => void) | null;
  customHandleInput: ((key: K, page: MenuPage, defaultHandleInput: (key: K) => boolean) => boolean) | null;
  customGetBackButtonAnchor: (() => BackButtonAnchor | null) | null;

  constructor(config: MenuPageConfig = {}) {
    this.items = config.items || [];
    this.layout = config.layout || null;
    this.title = config.title || null;
    this.titlePic = config.titlePic || null;
    this.logoPic = config.logoPic || null;
    this.cursor = 0;
    this.onEnter = config.onEnter || (() => {});
    this.onExit = config.onExit || (() => {});
    this.onEscape = config.onEscape || null;
    this.onConfirm = config.onConfirm || null;
    this.customDraw = config.customDraw || null;
    this.customHandleInput = config.customHandleInput || null;
    this.customGetBackButtonAnchor = config.customGetBackButtonAnchor || null;

    // Find first focusable item
    this._moveCursorToFirstFocusable();
  }

  /**
   * Initialize the menu page (called once when menu system is set up).
   */
  async init(): Promise<void> {
  }

  /**
   * Draw the menu page.
   */
  draw(): void {
    // Corner logo (e.g. the Quake plaque) shown alongside the title on several built-in screens.
    if (this.logoPic) {
      M.DrawPic(16, 4, this.logoPic);
    }

    // Draw title if provided
    if (this.titlePic) {
      const titleX = 160 - Math.floor((this.titlePic.width ?? 0) / 2);
      M.DrawPic(titleX, 4, this.titlePic);
    } else if (this.title) {
      const titleX = 160 - (this.title.length * 8) / 2;
      M.Print(titleX, 8, this.title);
    }

    // Custom drawing (for special menus)
    if (this.customDraw) {
      this.customDraw(this);
      return;
    }

    // Use layout system
    this.layout?.draw(this.items, this.cursor);
  }

  /**
   * Handle keyboard input. Delegates to `customHandleInput` when configured (e.g. a page that
   * needs extra keys beyond the generic navigation below, like Left/Right page-turning or a
   * Yes/No dialog prompt) -- it decides whether to fall back to the default handling via the
   * `defaultHandleInput` callback it's passed.
   * @returns True if input was handled.
   */
  handleInput(key: K): boolean {
    if (this.customHandleInput) {
      return this.customHandleInput(key, this, (k) => this._defaultHandleInput(k));
    }

    return this._defaultHandleInput(key);
  }

  /**
   * The generic navigation/activation behavior every page gets unless overridden via
   * `customHandleInput`.
   * @returns True if input was handled.
   */
  protected _defaultHandleInput(key: K): boolean {
    // Let focused item handle input first
    const focused = this.items[this.cursor];
    if (focused && focused.handleInput(key)) {
      return true;
    }

    if (key === K.ESCAPE && this.onEscape) {
      this.onEscape();
      return true;
    }

    if (key === K.ENTER && this.onConfirm) {
      this.onConfirm();
      return true;
    }

    // Generic navigation
    if (key === K.DOWNARROW) {
      this._moveCursor(1);
      return true;
    }

    if (key === K.UPARROW) {
      this._moveCursor(-1);
      return true;
    }

    // A click activates whatever item is under the cursor. Position-aware widgets (e.g. Slider)
    // get first refusal via handleClick(); everything else falls back to Enter's semantics,
    // the same way Enter activates the currently focused item.
    if (key === K.MOUSE1) {
      const index = this.layout?.hitTest(this.items, M.mouseX, M.mouseY) ?? null;
      if (index === null) {
        return false;
      }

      this.cursor = index;
      const item = this.items[index];
      if (item.handleClick(M.mouseX, M.mouseY)) {
        return true;
      }

      return item.handleInput(K.ENTER);
    }

    return false;
  }

  /**
   * Forward a text paste to the focused item, if it supports one.
   * @returns True if the focused item consumed the paste.
   */
  handlePaste(text: string): boolean {
    return this.items[this.cursor]?.handlePaste(text) ?? false;
  }

  /**
   * Move the cursor to whatever focusable item is under the given point, without playing the
   * keyboard-navigation sound. Called on every mouse move while this page is active.
   */
  updateHover(mx: number, my: number): void {
    const index = this.layout?.hitTest(this.items, mx, my) ?? null;
    if (index !== null && index !== this.cursor && this.items[index]?.focusable) {
      this.cursor = index;
    }
  }

  /**
   * Where M should draw/hit-test the page-agnostic Back/Close button for this page. Returns
   * null (the default) to use the standard bottom-left corner unless `customGetBackButtonAnchor`
   * is configured, e.g. a dialog centering it under its own message box.
   * @returns The button's anchor, or null to use the default corner.
   */
  getBackButtonAnchor(): BackButtonAnchor | null {
    return this.customGetBackButtonAnchor ? this.customGetBackButtonAnchor() : null;
  }

  /**
   * Called when menu becomes active.
   */
  activate(): void {
    this._moveCursorToFirstFocusable();

    for (const item of this.items) {
      item.activate();
    }

    this.onEnter();
  }

  /**
   * Called when menu becomes inactive.
   */
  deactivate(): void {
    for (const item of this.items) {
      item.deactivate();
    }

    this.onExit();
  }

  /**
   * Move cursor by offset, skipping non-focusable items.
   */
  protected _moveCursor(offset: number): void {
    if (!this.items.length) {
      return;
    }

    const start = this.cursor;
    let attempts = 0;
    const maxAttempts = this.items.length;

    do {
      this.cursor += offset;

      // Wrap around
      if (this.cursor < 0) {
        this.cursor = this.items.length - 1;
      } else if (this.cursor >= this.items.length) {
        this.cursor = 0;
      }

      attempts++;

      // Check if current item is focusable
      if (this.items[this.cursor]?.focusable) {
        S.LocalSound(M.sfx_menu1);
        return;
      }
    } while (attempts < maxAttempts && this.cursor !== start);
  }

  /**
   * Move cursor to first focusable item.
   */
  protected _moveCursorToFirstFocusable(): void {
    this.cursor = 0;
    if (!this.items.length) {
      return;
    }

    // If current item is not focusable, find first focusable
    if (!this.items[this.cursor]?.focusable) {
      for (let index = 0; index < this.items.length; index++) {
        if (this.items[index]?.focusable) {
          this.cursor = index;
          return;
        }
      }
    }
  }
}

/**
 * Vertical layout - standard menu layout.
 */
// Gap between a right-justified label's end and the value column it's justified against
// (matches the original Options screen's hand-tuned label/slider alignment).
const LABEL_VALUE_GAP = 28;

export class VerticalLayout implements MenuLayout {
  startY: number;
  spacing: number;
  labelX: number;
  valueX: number | null;
  showCursor: boolean;
  cursorX: number;

  constructor(config: VerticalLayoutConfig = {}) {
    this.startY = config.startY ?? 32;
    this.spacing = config.spacing ?? 4;
    this.labelX = config.labelX ?? 16;
    this.valueX = config.valueX ?? null;
    this.showCursor = config.showCursor ?? true;
    this.cursorX = config.cursorX ?? 200;
  }

  draw(items: MenuItem[], focusedIndex: number): void {
    let y = this.startY;

    for (const [index, item] of items.entries()) {
      if (!item.visible) {
        continue;
      }

      const focused = index === focusedIndex;

      // When a value column is configured, right-justify the label against it instead of
      // using a fixed left column, so values line up regardless of label length.
      const x = this.valueX !== null ? this.valueX - LABEL_VALUE_GAP - item.label.length * 8 : this.labelX;

      // Draw the item
      item.draw(x, y, focused, this.valueX ?? undefined);

      // Draw cursor for focused item
      if (focused && this.showCursor && item.focusable) {
        const cursorChar = 12 + ((Host.realtime * 4.0) & 1);
        M.DrawCharacter(this.cursorX, y, cursorChar);
      }

      y += item.getHeight() + this.spacing;
    }
  }

  hitTest(items: MenuItem[], px: number, py: number): number | null {
    let y = this.startY;

    for (const [index, item] of items.entries()) {
      if (!item.visible) {
        continue;
      }

      const height = item.getHeight();

      // The whole row is clickable, not just the glyphs under the label/value, so the hit box
      // spans the full virtual screen width regardless of where VerticalLayout placed the text.
      if (item.focusable && px >= 0 && px < 320 && py >= y && py < y + height) {
        return index;
      }

      y += height + this.spacing;
    }

    return null;
  }
}

/**
 * Image-based layout - for menus that use a single background image.
 */
export class ImageBasedLayout implements MenuLayout {
  backgroundPic: MenuPic | null;
  backgroundX: number;
  backgroundY: number;
  cursorX: number;
  cursorYBase: number;
  cursorYSpacing: number;

  constructor(config: ImageBasedLayoutConfig = {}) {
    console.assert(config.backgroundPic !== undefined, 'ImageBasedLayout requires a backgroundPic');
    this.backgroundPic = config.backgroundPic!;
    this.backgroundX = config.backgroundX ?? 72;
    this.backgroundY = config.backgroundY ?? 32;
    this.cursorX = config.cursorX ?? 54;
    this.cursorYBase = config.cursorYBase ?? 32;
    this.cursorYSpacing = config.cursorYSpacing ?? 20;
  }

  draw(items: MenuItem[], focusedIndex: number): void {
    // Draw background image
    if (this.backgroundPic) {
      M.DrawPic(this.backgroundX, this.backgroundY, this.backgroundPic);
    }

    // Draw animated cursor
    const dotFrame = Math.floor(Host.realtime * 10.0) % 6;
    const cursorY = this.cursorYBase + focusedIndex * this.cursorYSpacing;
    M.DrawPic(this.cursorX, cursorY, M.menudot[dotFrame]);

    // Items can still draw if needed (for custom elements)
    for (const [index, item] of items.entries()) {
      if (!item.visible) {
        continue;
      }

      item.draw(0, 0, index === focusedIndex);
    }
  }

  hitTest(items: MenuItem[], _px: number, py: number): number | null {
    // Items have no individual geometry of their own here — hit-test the same fixed-height row
    // band the animated dot cursor is drawn at for each index.
    for (const [index, item] of items.entries()) {
      if (!item.visible || !item.focusable) {
        continue;
      }

      const rowY = this.cursorYBase + index * this.cursorYSpacing;
      if (py >= rowY - this.cursorYSpacing / 2 && py < rowY + this.cursorYSpacing / 2) {
        return index;
      }
    }

    return null;
  }
}

/**
 * List layout - for save/load game lists.
 */
export class ListLayout implements MenuLayout {
  startX: number;
  startY: number;
  spacing: number;
  cursorX: number;

  constructor(config: ListLayoutConfig = {}) {
    this.startX = config.startX ?? 16;
    this.startY = config.startY ?? 32;
    this.spacing = config.spacing ?? 8;
    this.cursorX = config.cursorX ?? 8;
  }

  draw(items: MenuItem[], focusedIndex: number): void {
    let y = this.startY;

    for (const [index, item] of items.entries()) {
      if (!item.visible) {
        continue;
      }

      const focused = index === focusedIndex;

      // Draw the item
      item.draw(this.startX, y, focused);

      // Draw cursor for focused item
      if (focused && item.focusable) {
        const cursorChar = 12 + ((Host.realtime * 4.0) & 1);
        M.DrawCharacter(this.cursorX, y, cursorChar);
      }

      y += this.spacing;
    }
  }

  hitTest(items: MenuItem[], px: number, py: number): number | null {
    let y = this.startY;

    for (const [index, item] of items.entries()) {
      if (!item.visible) {
        continue;
      }

      if (item.focusable && px >= 0 && px < 320 && py >= y && py < y + this.spacing) {
        return index;
      }

      y += this.spacing;
    }

    return null;
  }
}

/**
 * Grid layout - for multi-column layouts.
 */
export class GridLayout implements MenuLayout {
  columns: number;
  startX: number;
  startY: number;
  columnSpacing: number;
  rowSpacing: number;

  constructor(config: GridLayoutConfig = {}) {
    this.columns = config.columns ?? 2;
    this.startX = config.startX ?? 16;
    this.startY = config.startY ?? 32;
    this.columnSpacing = config.columnSpacing ?? 160;
    this.rowSpacing = config.rowSpacing ?? 8;
  }

  draw(items: MenuItem[], focusedIndex: number): void {
    for (const [index, item] of items.entries()) {
      if (!item.visible) {
        continue;
      }

      const focused = index === focusedIndex;
      const row = Math.floor(index / this.columns);
      const col = index % this.columns;

      const x = this.startX + col * this.columnSpacing;
      const y = this.startY + row * this.rowSpacing;

      item.draw(x, y, focused);
    }
  }

  hitTest(items: MenuItem[], px: number, py: number): number | null {
    for (const [index, item] of items.entries()) {
      if (!item.visible || !item.focusable) {
        continue;
      }

      const row = Math.floor(index / this.columns);
      const col = index % this.columns;

      const x = this.startX + col * this.columnSpacing;
      const y = this.startY + row * this.rowSpacing;

      if (px >= x && px < x + this.columnSpacing && py >= y && py < y + this.rowSpacing) {
        return index;
      }
    }

    return null;
  }
}

interface DialogPageConfig extends MenuPageConfig {
  readonly getBackdrop?: () => MenuPage | null;
}

/**
 * A page drawn on top of whatever page was active when it was pushed (e.g. quit/alert dialogs),
 * replacing the previous recursive-draw-with-shared-state approach with an ordinary stack entry.
 */
export class DialogPage extends MenuPage {
  getBackdrop: () => MenuPage | null;

  constructor(config: DialogPageConfig = {}) {
    super(config);
    this.getBackdrop = config.getBackdrop ?? (() => null);
  }

  override draw(): void {
    this.getBackdrop()?.draw();
    super.draw();
  }
}

/**
 * A page where left/right arrows behave like up/down navigation (e.g. save/load slot lists).
 */
export class ListPage extends MenuPage {
  override handleInput(key: K): boolean {
    // Give the focused item first refusal on the original key before remapping navigation.
    const focused = this.items[this.cursor];
    if (focused && focused.handleInput(key)) {
      return true;
    }

    if (key === K.LEFTARROW) {
      return super.handleInput(K.UPARROW);
    }

    if (key === K.RIGHTARROW) {
      return super.handleInput(K.DOWNARROW);
    }

    return super.handleInput(key);
  }
}

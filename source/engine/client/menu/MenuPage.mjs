import { K } from '../../../shared/Keys.ts';
import { eventBus, registry } from '../../registry.mjs';

// Destructure registry modules
let { S, M, Host } = registry;

// Update when registry is frozen
eventBus.subscribe('registry.frozen', () => {
  ({ S, M, Host } = registry);
});

/**
 * A menu page containing items with automatic navigation
 */
export class MenuPage {
  constructor(config = {}) {
    this.items = config.items || [];
    this.layout = config.layout || null;
    this.title = config.title || null;
    this.titlePic = config.titlePic || null;
    this.cursor = 0;
    this.onEnter = config.onEnter || (() => { });
    this.onExit = config.onExit || (() => { });
    this.customDraw = config.customDraw || null;

    // Find first focusable item
    this._moveCursorToFirstFocusable();
  }

  /**
   * Initialize the menu page (called once when menu system is set up)
   */
  async init() {
  }

  /**
   * Draw the menu page
   */
  draw() {
    // Draw title if provided
    if (this.titlePic) {
      const titleX = 160 - Math.floor(this.titlePic.width / 2);
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
    if (this.layout) {
      this.layout.draw(this.items, this.cursor);
    }
  }

  /**
   * Handle keyboard input
   * @param {number} key - Key code
   * @returns {boolean} True if input was handled
   */
  handleInput(key) {
    // Let focused item handle input first
    const focused = this.items[this.cursor];
    if (focused && focused.handleInput(key)) {
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

    return false;
  }

  /**
   * Called when menu becomes active
   */
  activate() {
    this._moveCursorToFirstFocusable();

    for (const item of this.items) {
      item.activate?.();
    }

    this.onEnter();
  }

  /**
   * Called when menu becomes inactive
   */
  deactivate() {
    for (const item of this.items) {
      item.deactivate?.();
    }

    this.onExit();
  }

  /**
   * Move cursor by offset, skipping non-focusable items
   * @param {number} offset - Direction to move (-1 for up, 1 for down)
   */
  _moveCursor(offset) {
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
   * Move cursor to first focusable item
   */
  _moveCursorToFirstFocusable() {
    this.cursor = 0;
    if (!this.items.length) {
      return;
    }

    // If current item is not focusable, find first focusable
    if (!this.items[this.cursor]?.focusable) {
      for (let i = 0; i < this.items.length; i++) {
        if (this.items[i]?.focusable) {
          this.cursor = i;
          return;
        }
      }
    }
  }
}

/**
 * Vertical layout - standard menu layout
 */
export class VerticalLayout {
  constructor(config = {}) {
    this.startY = config.startY ?? 32;
    this.spacing = config.spacing ?? 4;
    this.labelX = config.labelX ?? 16;
    this.valueX = config.valueX ?? 220;
    this.showCursor = config.showCursor ?? true;
    this.cursorX = config.cursorX ?? 200;
  }

  draw(items, focusedIndex) {
    let y = this.startY;

    for (const [i, item] of items.entries()) {
      if (!item.visible) {
        continue;
      }

      const focused = i === focusedIndex;

      // Draw the item
      item.draw(this.labelX, y, focused);

      // Draw cursor for focused item
      if (focused && this.showCursor && item.focusable) {
        const cursorChar = 12 + ((Host.realtime * 4.0) & 1);
        M.DrawCharacter(this.cursorX, y, cursorChar);
      }

      y += item.getHeight() + this.spacing;
    }
  }
}

/**
 * Image-based layout - for menus that use a single background image
 */
export class ImageBasedLayout {
  constructor(config = {}) {
    this.backgroundPic = config.backgroundPic;
    this.backgroundX = config.backgroundX ?? 72;
    this.backgroundY = config.backgroundY ?? 32;
    this.cursorX = config.cursorX ?? 54;
    this.cursorYBase = config.cursorYBase ?? 32;
    this.cursorYSpacing = config.cursorYSpacing ?? 20;
  }

  draw(items, focusedIndex) {
    // Draw background image
    if (this.backgroundPic) {
      M.DrawPic(this.backgroundX, this.backgroundY, this.backgroundPic);
    }

    // Draw animated cursor
    const dotFrame = Math.floor(Host.realtime * 10.0) % 6;
    const cursorY = this.cursorYBase + focusedIndex * this.cursorYSpacing;
    M.DrawPic(this.cursorX, cursorY, M.menudot[dotFrame]);

    // Items can still draw if needed (for custom elements)
    for (const [i, item] of items.entries()) {
      if (!item.visible) {
        continue;
      }

      item.draw?.(0, 0, i === focusedIndex);
    }
  }
}

/**
 * List layout - for save/load game lists
 */
export class ListLayout {
  constructor(config = {}) {
    this.startX = config.startX ?? 16;
    this.startY = config.startY ?? 32;
    this.spacing = config.spacing ?? 8;
    this.cursorX = config.cursorX ?? 8;
  }

  draw(items, focusedIndex) {
    let y = this.startY;

    for (const [i, item] of items.entries()) {
      if (!item.visible) {
        continue;
      }

      const focused = i === focusedIndex;

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
}

/**
 * Grid layout - for multi-column layouts
 */
export class GridLayout {
  constructor(config = {}) {
    this.columns = config.columns ?? 2;
    this.startX = config.startX ?? 16;
    this.startY = config.startY ?? 32;
    this.columnSpacing = config.columnSpacing ?? 160;
    this.rowSpacing = config.rowSpacing ?? 8;
  }

  draw(items, focusedIndex) {
    for (const [i, item] of items.entries()) {
      if (!item.visible) {
        continue;
      }

      const focused = i === focusedIndex;
      const row = Math.floor(i / this.columns);
      const col = i % this.columns;

      const x = this.startX + col * this.columnSpacing;
      const y = this.startY + row * this.rowSpacing;

      item.draw(x, y, focused);
    }
  }
}

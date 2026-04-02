import Q from '../../../shared/Q.ts';
import { K } from '../../../shared/Keys.ts';
import Cvar from '../../common/Cvar.mjs';
import { eventBus, registry } from '../../registry.mjs';

let { S, M, Host } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ S, M, Host } = registry);
});

/**
 * Base class for all menu items
 */
export class MenuItem {
  constructor(config = {}) {
    /** @type {string} */
    this.label = config.label || '';
    /** @type {boolean} */
    this.focusable = config.focusable ?? true;
    /** @type {boolean} */
    this.visible = config.visible ?? true;
    /** @type {boolean} */
    this.enabled = config.enabled ?? true;
  }

  /**
   * Draw the menu item
   * @param {number} x - X position (for label)
   * @param {number} y - Y position
   * @param {boolean} focused - Whether this item is currently focused
   */
  // eslint-disable-next-line no-unused-vars
  draw(x, y, focused) {
    // Override in subclasses
  }

  /**
   * Handle keyboard input
   * @param {number} key - Key code
   * @returns {boolean} True if input was handled
   */
  // eslint-disable-next-line no-unused-vars
  handleInput(key) {
    return false;
  }

  /**
   * Called when item becomes active (e.g., menu opens)
   */
  activate() {
    // Override in subclasses
  }

  /**
   * Called when item becomes inactive (e.g., menu closes)
   */
  deactivate() {
    // Override in subclasses
  }

  /**
   * Get the height this item needs for rendering
   * @returns {number} Height in pixels
   */
  getHeight() {
    return 8; // Default single line height
  }
}

/**
 * Action item - executes a callback when activated
 */
export class Action extends MenuItem {
  constructor(config) {
    super(config);
    /** @type {function(): void} */
    this.action = config.action || (() => { });
  }

  /**
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {boolean} focused - Whether focused
   */
  // eslint-disable-next-line no-unused-vars
  draw(x, y, focused) {
    if (!this.visible) {
      return;
    }

    if (this.enabled) {
      M.PrintWhite(x, y, this.label);
    } else {
      M.Print(x, y, this.label);
    }
  }

  /**
   * @param {number} key - Key code
   * @returns {boolean} True if handled
   */
  handleInput(key) {
    if (!this.enabled) {
      return false;
    }

    if (key === K.ENTER) {
      this.action();
      S.LocalSound(M.sfx_menu2);
      return true;
    }
    return false;
  }
}

/**
 * Slider for adjusting numeric values
 */
export class Slider extends MenuItem {
  constructor(config) {
    super(config);
    /** @type {string} */
    this.cvar = config.cvar;
    /** @type {number} */
    this.min = config.min ?? 0;
    /** @type {number} */
    this.max = config.max ?? 1;
    /** @type {number} */
    this.step = config.step ?? 0.1;
    /** @type {boolean} For brightness slider */
    this.invert = config.invert ?? false;
    /** @type {number} For displaying normalized values */
    this.displayScale = config.displayScale ?? 1;
  }

  /**
   * Get current cvar value
   * @returns {number} Current value
   */
  getValue() {
    const cvarObj = Cvar.FindVar(this.cvar);
    return cvarObj ? cvarObj.value : this.min;
  }

  /**
   * Set cvar value with clamping
   * @param {number} val - New value
   */
  setValue(val) {
    const clamped = Math.max(this.min, Math.min(this.max, val));
    Cvar.Set(this.cvar, clamped);
  }

  /**
   * Get normalized value for slider display
   * @returns {number} Value between 0 and 1
   */
  getNormalizedValue() {
    let val = this.getValue();
    if (this.invert) {
      val = this.max - val + this.min;
    }
    return (val - this.min) / (this.max - this.min);
  }

  /**
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {boolean} focused - Whether focused
   */
  // eslint-disable-next-line no-unused-vars
  draw(x, y, focused) {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);
    M.DrawSlider(x + 116, y, this.getNormalizedValue());
  }

  /**
   * @param {number} key - Key code
   * @returns {boolean} True if handled
   */
  handleInput(key) {
    if (!this.enabled) {
      return false;
    }

    if (key === K.LEFTARROW) {
      const newVal = this.getValue() - this.step;
      this.setValue(newVal);
      S.LocalSound(M.sfx_menu3);
      return true;
    }

    if (key === K.RIGHTARROW || key === K.ENTER) {
      const newVal = this.getValue() + this.step;
      this.setValue(newVal);
      S.LocalSound(M.sfx_menu3);
      return true;
    }

    return false;
  }
}

/**
 * Toggle for on/off values
 */
export class Toggle extends MenuItem {
  constructor(config) {
    super(config);
    /** @type {string} */
    this.cvar = config.cvar;
    /** @type {number} */
    this.onValue = config.onValue ?? 1;
    /** @type {number} */
    this.offValue = config.offValue ?? 0;
    /** @type {string} */
    this.onLabel = config.onLabel ?? 'on';
    /** @type {string} */
    this.offLabel = config.offLabel ?? 'off';
  }

  /**
   * Get current cvar value
   * @returns {number} Current value
   */
  getValue() {
    const cvarObj = Cvar.FindVar(this.cvar);
    return cvarObj ? cvarObj.value : this.offValue;
  }

  /**
   * Set cvar value
   * @param {number} val - New value
   */
  setValue(val) {
    Cvar.Set(this.cvar, val);
  }

  /**
   * Check if toggle is in "on" state
   * @returns {boolean} True if on
   */
  isOn() {
    return Q.compareFloat(this.getValue(), this.onValue);
  }

  /**
   * Toggle between on and off
   */
  toggle() {
    this.setValue(this.isOn() ? this.offValue : this.onValue);
  }

  /**
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {boolean} focused - Whether focused
   */
  // eslint-disable-next-line no-unused-vars
  draw(x, y, focused) {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);
    M.PrintWhite(x + 116, y, this.isOn() ? this.onLabel : this.offLabel);
  }

  /**
   * @param {number} key - Key code
   * @returns {boolean} True if handled
   */
  handleInput(key) {
    if (!this.enabled) {
      return false;
    }

    if (key === K.ENTER ||
      key === K.LEFTARROW ||
      key === K.RIGHTARROW) {
      this.toggle();
      S.LocalSound(M.sfx_menu3);
      return true;
    }

    return false;
  }
}

/**
 * Text input field
 */
export class Textbox extends MenuItem {
  constructor(config) {
    super(config);
    /** @type {string|null} */
    this.cvar = config.cvar || null;
    /** @type {string} */
    this.value = config.value || '';
    /** @type {number} */
    this.maxLength = config.maxLength ?? 32;
    /** @type {function(string): boolean} */
    this.validator = config.validator || (() => true);
    /** @type {number} In characters */
    this.width = config.width ?? 24;
  }

  activate() {
    if (this.cvar) {
      this.value = Cvar.FindVar(this.cvar)?.string || '';
    }
  }

  deactivate() {
    if (this.cvar) {
      Cvar.Set(this.cvar, this.value);
    }
  }

  /**
   * Get current value
   * @returns {string} Current text value
   */
  getValue() {
    return this.value;
  }

  /**
   * Set value with validation
   * @param {string} val - New value
   */
  setValue(val) {
    if (this.validator(val)) {
      this.value = val;
    }
  }

  /**
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {boolean} focused - Whether focused
   */
  draw(x, y, focused) {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);

    y += 16;

    M.DrawTextBox(x, y - 8, this.width, 1);
    M.PrintWhite(x + 8, y, this.getValue());

    if (focused) {
      const cursorX = x + 8 + (this.getValue().length * 8);
      M.DrawCharacter(cursorX, y, 10 + ((Host.realtime * 4.0) & 1));
    }
  }

  /**
   * @param {number} key - Key code
   * @returns {boolean} True if handled
   */
  handleInput(key) {
    if (!this.enabled) {
      return false;
    }

    if (key === K.BACKSPACE) {
      const current = this.getValue();
      if (current.length > 0) {
        this.setValue(current.substring(0, current.length - 1));
      }
      return true;
    }

    // Printable characters
    if (key >= 32 && key <= 127) {
      const current = this.getValue();
      if (current.length < this.maxLength) {
        this.setValue(current + String.fromCharCode(key));
      }
      return true;
    }

    return false;
  }
}

/**
 * Spacer - empty space
 */
export class Spacer extends MenuItem {
  constructor(config = {}) {
    super({ ...config, focusable: false });
    this.height = config.height ?? 8;
  }

  getHeight() {
    return this.height;
  }

  draw() {
    // Nothing to draw
  }
}

/**
 * Label - non-interactive text
 */
export class Label extends MenuItem {
  constructor(config) {
    super({ ...config, focusable: false });
    this.align = config.align ?? 'left'; // left, center, right
  }

  /**
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {boolean} focused - Whether focused
   */
  // eslint-disable-next-line no-unused-vars
  draw(x, y, focused) {
    if (!this.visible) {
      return;
    }
    M.Print(x, y, this.label);
  }
}

/**
 * Image - displays a picture (for image-based menu items like main menu)
 */
export class Image extends MenuItem {
  constructor(config) {
    super({ ...config, focusable: config.focusable ?? false });
    this.pic = config.pic;
    this.centered = config.centered ?? false;
  }

  /**
   * @param {number} x - X position
   * @param {number} y - Y position
   * @param {boolean} focused - Whether focused
   */
  // eslint-disable-next-line no-unused-vars
  draw(x, y, focused) {
    if (!this.visible || !this.pic) {
      return;
    }

    const drawX = this.centered && this.pic.width ?
      x - Math.floor(this.pic.width / 2) : x;

    M.DrawPic(drawX, y, this.pic);
  }

  getHeight() {
    return this.pic?.height || 0;
  }
}

export class PlayerSkin extends MenuItem {
  value = 0;

  constructor() {
    super({ focusable: false });
  }

  draw(x, y, focused) {
    if (!this.visible) {
      return;
    }

    const top = (this.value >> 4) & 0x0F;
    const bottom = this.value & 0x0F;

    M.DrawPic(x, y, M.bigbox);
    M.DrawPicTranslate(x + 12, y + 8, M.menuplyr,
      (top << 4) + (top >= 8 ? 4 : 11),
      (bottom << 4) + (bottom >= 8 ? 4 : 11));
  }

  getHeight() {
    return M.bigbox.height || 0;
  }
};

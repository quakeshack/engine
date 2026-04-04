import Q from '../../../shared/Q.ts';
import { K } from '../../../shared/Keys.ts';
import Cvar from '../../common/Cvar.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';

interface MenuPicture {
  readonly width?: number;
  readonly height?: number;
}

interface MenuItemConfig {
  readonly label?: string;
  readonly focusable?: boolean;
  readonly visible?: boolean;
  readonly enabled?: boolean;
}

type MenuAction = () => void | Promise<void>;

interface ActionConfig extends MenuItemConfig {
  readonly action?: MenuAction;
}

interface SliderConfig extends MenuItemConfig {
  readonly cvar: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly invert?: boolean;
  readonly displayScale?: number;
}

interface ToggleConfig extends MenuItemConfig {
  readonly cvar: string;
  readonly onValue?: number;
  readonly offValue?: number;
  readonly onLabel?: string;
  readonly offLabel?: string;
}

interface TextboxConfig extends MenuItemConfig {
  readonly cvar?: string | null;
  readonly value?: string;
  readonly maxLength?: number;
  readonly validator?: (value: string) => boolean;
  readonly width?: number;
}

interface SpacerConfig extends MenuItemConfig {
  readonly height?: number;
}

interface LabelConfig extends MenuItemConfig {
  readonly align?: 'left' | 'center' | 'right';
}

interface ImageConfig extends MenuItemConfig {
  readonly pic?: MenuPicture | null;
  readonly centered?: boolean;
}

let { Host, M, S } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Host, M, S } = getClientRegistry());
});

/**
 * Base class for all menu items.
 */
export class MenuItem {
  label: string;
  focusable: boolean;
  visible: boolean;
  enabled: boolean;

  constructor(config: MenuItemConfig = {}) {
    this.label = config.label || '';
    this.focusable = config.focusable ?? true;
    this.visible = config.visible ?? true;
    this.enabled = config.enabled ?? true;
  }

  /**
   * Draw the menu item.
   */
  draw(_x: number, _y: number, _focused: boolean): void {
    // Override in subclasses
  }

  /**
   * Handle keyboard input.
   * @returns True if input was handled.
   */
  handleInput(_key: number): boolean {
    return false;
  }

  /**
   * Called when item becomes active (e.g., menu opens).
   */
  activate(): void {
    // Override in subclasses
  }

  /**
   * Called when item becomes inactive (e.g., menu closes).
   */
  deactivate(): void {
    // Override in subclasses
  }

  /**
   * Get the height this item needs for rendering.
   * @returns Height in pixels.
   */
  getHeight(): number {
    return 8; // Default single line height
  }
}

/**
 * Action item - executes a callback when activated.
 */
export class Action extends MenuItem {
  action: MenuAction;

  constructor(config: ActionConfig) {
    super(config);
    this.action = config.action || (() => {});
  }

  override draw(x: number, y: number, _focused: boolean): void {
    if (!this.visible) {
      return;
    }

    if (this.enabled) {
      M.PrintWhite(x, y, this.label);
    } else {
      M.Print(x, y, this.label);
    }
  }

  override handleInput(key: number): boolean {
    if (!this.enabled) {
      return false;
    }

    if (key === K.ENTER) {
      void this.action();
      S.LocalSound(M.sfx_menu2);
      return true;
    }

    return false;
  }
}

/**
 * Slider for adjusting numeric values.
 */
export class Slider extends MenuItem {
  cvar: string;
  min: number;
  max: number;
  step: number;
  invert: boolean;
  displayScale: number;

  constructor(config: SliderConfig) {
    super(config);
    this.cvar = config.cvar;
    this.min = config.min ?? 0;
    this.max = config.max ?? 1;
    this.step = config.step ?? 0.1;
    this.invert = config.invert ?? false;
    this.displayScale = config.displayScale ?? 1;
  }

  /**
   * Get current cvar value.
   * @returns Current value.
   */
  getValue(): number {
    const cvarObj = Cvar.FindVar(this.cvar);
    return cvarObj ? cvarObj.value : this.min;
  }

  /**
   * Set cvar value with clamping.
   */
  setValue(value: number): void {
    const clamped = Math.max(this.min, Math.min(this.max, value));
    Cvar.Set(this.cvar, clamped);
  }

  /**
   * Get normalized value for slider display.
   * @returns Value between 0 and 1.
   */
  getNormalizedValue(): number {
    let value = this.getValue();
    if (this.invert) {
      value = this.max - value + this.min;
    }
    return (value - this.min) / (this.max - this.min);
  }

  override draw(x: number, y: number, _focused: boolean): void {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);
    M.DrawSlider(x + 116, y, this.getNormalizedValue());
  }

  override handleInput(key: number): boolean {
    if (!this.enabled) {
      return false;
    }

    if (key === K.LEFTARROW) {
      const newValue = this.getValue() - this.step;
      this.setValue(newValue);
      S.LocalSound(M.sfx_menu3);
      return true;
    }

    if (key === K.RIGHTARROW || key === K.ENTER) {
      const newValue = this.getValue() + this.step;
      this.setValue(newValue);
      S.LocalSound(M.sfx_menu3);
      return true;
    }

    return false;
  }
}

/**
 * Toggle for on/off values.
 */
export class Toggle extends MenuItem {
  cvar: string;
  onValue: number;
  offValue: number;
  onLabel: string;
  offLabel: string;

  constructor(config: ToggleConfig) {
    super(config);
    this.cvar = config.cvar;
    this.onValue = config.onValue ?? 1;
    this.offValue = config.offValue ?? 0;
    this.onLabel = config.onLabel ?? 'on';
    this.offLabel = config.offLabel ?? 'off';
  }

  /**
   * Get current cvar value.
   * @returns Current value.
   */
  getValue(): number {
    const cvarObj = Cvar.FindVar(this.cvar);
    return cvarObj ? cvarObj.value : this.offValue;
  }

  /**
   * Set cvar value.
   */
  setValue(value: number): void {
    Cvar.Set(this.cvar, value);
  }

  /**
   * Check if toggle is in "on" state.
   * @returns True if on.
   */
  isOn(): boolean {
    return Q.compareFloat(this.getValue(), this.onValue);
  }

  /**
   * Toggle between on and off.
   */
  toggle(): void {
    this.setValue(this.isOn() ? this.offValue : this.onValue);
  }

  override draw(x: number, y: number, _focused: boolean): void {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);
    M.PrintWhite(x + 116, y, this.isOn() ? this.onLabel : this.offLabel);
  }

  override handleInput(key: number): boolean {
    if (!this.enabled) {
      return false;
    }

    if (key === K.ENTER || key === K.LEFTARROW || key === K.RIGHTARROW) {
      this.toggle();
      S.LocalSound(M.sfx_menu3);
      return true;
    }

    return false;
  }
}

/**
 * Text input field.
 */
export class Textbox extends MenuItem {
  cvar: string | null;
  value: string;
  maxLength: number;
  validator: (value: string) => boolean;
  width: number;

  constructor(config: TextboxConfig) {
    super(config);
    this.cvar = config.cvar || null;
    this.value = config.value || '';
    this.maxLength = config.maxLength ?? 32;
    this.validator = config.validator || (() => true);
    this.width = config.width ?? 24;
  }

  override activate(): void {
    if (this.cvar !== null) {
      this.value = Cvar.FindVar(this.cvar)?.string || '';
    }
  }

  override deactivate(): void {
    if (this.cvar !== null) {
      Cvar.Set(this.cvar, this.value);
    }
  }

  /**
   * Get current value.
   * @returns Current text value.
   */
  getValue(): string {
    return this.value;
  }

  /**
   * Set value with validation.
   */
  setValue(value: string): void {
    if (this.validator(value)) {
      this.value = value;
    }
  }

  override draw(x: number, y: number, focused: boolean): void {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);

    y += 16;

    M.DrawTextBox(x, y - 8, this.width, 1);
    M.PrintWhite(x + 8, y, this.getValue());

    if (focused) {
      const cursorX = x + 8 + this.getValue().length * 8;
      M.DrawCharacter(cursorX, y, 10 + ((Host.realtime * 4.0) & 1));
    }
  }

  override handleInput(key: number): boolean {
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
 * Spacer - empty space.
 */
export class Spacer extends MenuItem {
  height: number;

  constructor(config: SpacerConfig = {}) {
    super({ ...config, focusable: false });
    this.height = config.height ?? 8;
  }

  override getHeight(): number {
    return this.height;
  }

  override draw(): void {
    // Nothing to draw
  }
}

/**
 * Label - non-interactive text.
 */
export class Label extends MenuItem {
  align: 'left' | 'center' | 'right';

  constructor(config: LabelConfig) {
    super({ ...config, focusable: false });
    this.align = config.align ?? 'left'; // left, center, right
  }

  override draw(x: number, y: number, _focused: boolean): void {
    if (!this.visible) {
      return;
    }
    M.Print(x, y, this.label);
  }
}

/**
 * Image - displays a picture (for image-based menu items like main menu).
 */
export class Image extends MenuItem {
  pic: MenuPicture | null;
  centered: boolean;

  constructor(config: ImageConfig) {
    super({ ...config, focusable: config.focusable ?? false });
    this.pic = config.pic ?? null;
    this.centered = config.centered ?? false;
  }

  override draw(x: number, y: number, _focused: boolean): void {
    if (!this.visible || this.pic === null) {
      return;
    }

    const drawX = this.centered && this.pic.width ? x - Math.floor(this.pic.width / 2) : x;

    M.DrawPic(drawX, y, this.pic);
  }

  override getHeight(): number {
    return this.pic?.height || 0;
  }
}

export class PlayerSkin extends MenuItem {
  value = 0;

  constructor() {
    super({ focusable: false });
  }

  override draw(x: number, y: number, _focused: boolean): void {
    if (!this.visible) {
      return;
    }

    const top = (this.value >> 4) & 0x0F;
    const bottom = this.value & 0x0F;

    M.DrawPic(x, y, M.bigbox);
    M.DrawPicTranslate(
      x + 12,
      y + 8,
      M.menuplyr,
      (top << 4) + (top >= 8 ? 4 : 11),
      (bottom << 4) + (bottom >= 8 ? 4 : 11),
    );
  }

  override getHeight(): number {
    return M.bigbox.height || 0;
  }
}

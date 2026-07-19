import Q from '../../../shared/Q.ts';
import { K } from '../../../shared/Keys.ts';
import { LineEditor } from '../../../shared/LineEditor.ts';
import Cmd from '../../common/Cmd.ts';
import Cvar from '../../common/Cvar.ts';
import { eventBus, getClientRegistry } from '../../registry.ts';
import type { MenuPic } from '../Menu.ts';

interface MenuItemConfig {
  readonly label?: string;
  readonly focusable?: boolean;
  readonly visible?: boolean;
  readonly enabled?: boolean;
  readonly heightOverride?: number;
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
  readonly cvar?: string;
  readonly getValue?: () => number;
  readonly setValue?: (value: number) => void;
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
  readonly customDraw?: ((textbox: Textbox, x: number, y: number, focused: boolean) => void) | null;
}

interface SpacerConfig extends MenuItemConfig {
  readonly height?: number;
}

interface LabelConfig extends MenuItemConfig {
  readonly align?: 'left' | 'center' | 'right';
}

interface ImageConfig extends MenuItemConfig {
  readonly pic?: MenuPic | null;
  readonly centered?: boolean;
}

interface SaveSlotConfig extends MenuItemConfig {
  readonly canDelete?: boolean;
  readonly onActivate?: () => void;
  readonly onDelete?: () => void;
}

interface KeyBindConfig extends MenuItemConfig {
  readonly command: string;
}

interface ColorPickerConfig extends MenuItemConfig {
  readonly getValue: () => number;
  readonly setValue: (value: number) => void;
  readonly max?: number;
}

let { Host, Key, M, S } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Host, Key, M, S } = getClientRegistry());
});

/**
 * Base class for all menu items.
 */
export class MenuItem {
  label: string;
  focusable: boolean;
  visible: boolean;
  enabled: boolean;
  heightOverride: number | null;

  constructor(config: MenuItemConfig = {}) {
    this.label = config.label || '';
    this.focusable = config.focusable ?? true;
    this.visible = config.visible ?? true;
    this.enabled = config.enabled ?? true;
    this.heightOverride = config.heightOverride ?? null;
  }

  /**
   * Draw the menu item. `valueX`, when provided by the layout, is the absolute column a
   * value-drawing item (e.g. Slider, Toggle) should align its value/bar to.
   */
  draw(_x: number, _y: number, _focused: boolean, _valueX?: number): void {
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
   * Handle a mouse click at the given point (virtual menu-space coordinates), for items whose
   * behavior depends on where within their row they were clicked (e.g. Slider setting its value
   * from the click position instead of just nudging it). Returns false to fall back to the
   * default "click behaves like Enter" activation.
   * @returns True if the click was handled.
   */
  handleClick(_px: number, _py: number): boolean {
    return false;
  }

  /**
   * Handle a text paste (e.g. Ctrl+V), if the item supports text input.
   * @returns True if the paste was handled.
   */
  handlePaste(_text: string): boolean {
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
    return this.heightOverride ?? 8; // Default single line height
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

  override handleInput(key: K): boolean {
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
  // Matches the travel distance M.DrawSlider() draws the bar/thumb across (see its `x` to
  // `x + 72` characters), so a click can be mapped back to a normalized value.
  static readonly #barTravel = 72;

  cvar: string;
  min: number;
  max: number;
  step: number;
  invert: boolean;
  displayScale: number;
  #barX = 0;

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

  override draw(x: number, y: number, _focused: boolean, valueX?: number): void {
    if (!this.visible) {
      return;
    }

    this.#barX = valueX ?? x + 116;
    M.Print(x, y, this.label);
    M.DrawSlider(this.#barX, y, this.getNormalizedValue());
  }

  /**
   * Set the value directly from a click position on the bar, rather than nudging it by one
   * step — the click position maps linearly onto the min/max range.
   * @returns True if the click was handled.
   */
  override handleClick(px: number): boolean {
    if (!this.enabled) {
      return false;
    }

    const normalized = Math.max(0, Math.min(1, (px - this.#barX) / Slider.#barTravel));
    const value = this.invert
      ? this.max - normalized * (this.max - this.min)
      : this.min + normalized * (this.max - this.min);

    this.setValue(value);
    S.LocalSound(M.sfx_menu3);
    return true;
  }

  override handleInput(key: K): boolean {
    if (!this.enabled) {
      return false;
    }

    // When inverted, the raw value grows opposite to the displayed bar, so the step
    // direction has to flip too: left always visually decreases the bar.
    const direction = this.invert ? -1 : 1;

    if (key === K.LEFTARROW) {
      this.setValue(this.getValue() - this.step * direction);
      S.LocalSound(M.sfx_menu3);
      return true;
    }

    if (key === K.RIGHTARROW || key === K.ENTER) {
      this.setValue(this.getValue() + this.step * direction);
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
  cvar: string | null;
  onValue: number;
  offValue: number;
  onLabel: string;
  offLabel: string;
  #getValueOverride: (() => number) | null;
  #setValueOverride: ((value: number) => void) | null;

  constructor(config: ToggleConfig) {
    super(config);
    this.cvar = config.cvar ?? null;
    this.onValue = config.onValue ?? 1;
    this.offValue = config.offValue ?? 0;
    this.onLabel = config.onLabel ?? 'on';
    this.offLabel = config.offLabel ?? 'off';
    this.#getValueOverride = config.getValue ?? null;
    this.#setValueOverride = config.setValue ?? null;

    console.assert(
      this.cvar !== null || (this.#getValueOverride !== null && this.#setValueOverride !== null),
      'Toggle requires either a cvar or a getValue/setValue pair',
    );
  }

  /**
   * Get the current value, either from the bound cvar or a custom getter.
   * @returns Current value.
   */
  getValue(): number {
    if (this.#getValueOverride) {
      return this.#getValueOverride();
    }

    const cvarObj = Cvar.FindVar(this.cvar!);
    return cvarObj ? cvarObj.value : this.offValue;
  }

  /**
   * Set the value, either on the bound cvar or via a custom setter.
   */
  setValue(value: number): void {
    if (this.#setValueOverride) {
      this.#setValueOverride(value);
      return;
    }

    Cvar.Set(this.cvar!, value);
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

  override draw(x: number, y: number, _focused: boolean, valueX?: number): void {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);
    M.PrintWhite(valueX ?? x + 116, y, this.isOn() ? this.onLabel : this.offLabel);
  }

  override handleInput(key: K): boolean {
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
 * Text input field. Supports a movable cursor (Left/Right/Home/End), forward/backward
 * deletion (Del/Backspace), and pasting (Ctrl+V, wired up by the platform layer).
 */
export class Textbox extends MenuItem {
  cvar: string | null;
  width: number;
  customDraw: ((textbox: Textbox, x: number, y: number, focused: boolean) => void) | null;
  #editor: LineEditor;

  constructor(config: TextboxConfig) {
    super(config);
    this.cvar = config.cvar || null;
    this.width = config.width ?? 24;
    this.customDraw = config.customDraw || null;
    this.#editor = new LineEditor(config.value || '', {
      maxLength: config.maxLength ?? 32,
      validator: config.validator || (() => true),
    });
  }

  get maxLength(): number {
    return this.#editor.maxLength;
  }

  set maxLength(value: number) {
    this.#editor.maxLength = value;
  }

  get validator(): (value: string) => boolean {
    return this.#editor.validator;
  }

  set validator(value: (value: string) => boolean) {
    this.#editor.validator = value;
  }

  /**
   * Current text value. Assigning it directly (e.g. to pre-fill the field from a cvar or
   * other external source) moves the cursor to the end, mirroring how a native `<input>`
   * behaves when its `.value` is set from script.
   * @returns The current text value.
   */
  get value(): string {
    return this.#editor.text;
  }

  set value(next: string) {
    this.#editor.text = next;
  }

  /**
   * Cursor index into the text.
   * @returns The current cursor index.
   */
  get cursorPos(): number {
    return this.#editor.cursorPos;
  }

  set cursorPos(pos: number) {
    this.#editor.cursorPos = pos;
  }

  /**
   * The glyph to draw for the blinking cursor this frame, or null when the current blink phase
   * should instead reveal the character already under the cursor. Public (computes the blink
   * phase from the current frame internally) so a `customDraw` callback with its own layout
   * (e.g. a name field with the input box in a fixed column instead of below the label) can
   * draw the same cursor without needing `draw()` as-is.
   * @returns A character code to draw at the cursor, or null to reveal the text underneath.
   */
  getCursorGlyph(): number | null {
    return this.#editor.cursorGlyph((Host.realtime * 4.0) & 1);
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

    if (this.customDraw) {
      this.customDraw(this, x, y, focused);
      return;
    }

    M.Print(x, y, this.label);

    y += 16;

    M.DrawTextBox(x, y - 8, this.width, 1);
    M.PrintWhite(x + 8, y, this.getValue());

    if (focused) {
      const glyph = this.getCursorGlyph();
      if (glyph !== null) {
        M.DrawCharacter(x + 8 + this.cursorPos * 8, y, glyph);
      }
    }
  }

  override handleInput(key: K): boolean {
    if (!this.enabled) {
      return false;
    }

    return this.#editor.handleKey(key);
  }

  override handlePaste(text: string): boolean {
    if (!this.enabled) {
      return false;
    }

    this.#editor.paste(text);
    return true;
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
  pic: MenuPic | null;
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


/**
 * A single load/save game slot. Enter always activates the slot (the caller decides whether
 * an empty slot is a no-op), Del removes it (if allowed) via onDelete.
 */
export class SaveSlotItem extends MenuItem {
  canDelete: boolean;
  onActivate: () => void;
  onDelete: () => void;

  constructor(config: SaveSlotConfig = {}) {
    super(config);
    this.canDelete = config.canDelete ?? false;
    this.onActivate = config.onActivate ?? (() => {});
    this.onDelete = config.onDelete ?? (() => {});
  }

  override draw(x: number, y: number, _focused: boolean): void {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);
  }

  override handleInput(key: K): boolean {
    if (!this.enabled) {
      return false;
    }

    if (key === K.ENTER) {
      this.onActivate();
      return true;
    }

    if (key === K.DEL) {
      if (this.canDelete) {
        this.onDelete();
      }
      return true;
    }

    return false;
  }
}

/**
 * A wrapping numeric selector (e.g. player shirt/pants color), advanced via Enter/Left/Right.
 */
export class ColorPicker extends MenuItem {
  getValue: () => number;
  setValue: (value: number) => void;
  max: number;

  constructor(config: ColorPickerConfig) {
    super(config);
    this.getValue = config.getValue;
    this.setValue = config.setValue;
    this.max = config.max ?? 13;
  }

  override draw(x: number, y: number, _focused: boolean): void {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);
  }

  override handleInput(key: K): boolean {
    if (!this.enabled) {
      return false;
    }

    if (key === K.LEFTARROW) {
      this.setValue(this.getValue() <= 0 ? this.max : this.getValue() - 1);
      S.LocalSound(M.sfx_menu3);
      return true;
    }

    if (key === K.RIGHTARROW || key === K.ENTER) {
      this.setValue(this.getValue() >= this.max ? 0 : this.getValue() + 1);
      S.LocalSound(M.sfx_menu3);
      return true;
    }

    return false;
  }
}

/**
 * A rebindable action row for a key-configuration menu. Enter arms capture of the next
 * keypress to bind; Backspace/Del clears every binding for the command.
 */
export class KeyBindItem extends MenuItem {
  command: string;
  capturing: boolean;

  constructor(config: KeyBindConfig) {
    super(config);
    this.command = config.command;
    this.capturing = false;
  }

  #findBoundKeys(): number[] {
    const found: number[] = [];

    for (let i = 0; i < Key.bindings.length; i++) {
      if (Key.bindings[i] === this.command) {
        found.push(i);
        if (found.length === 2) {
          break;
        }
      }
    }

    return found;
  }

  #unbind(): void {
    for (let i = 0; i < Key.bindings.length; i++) {
      if (Key.bindings[i] === this.command) {
        delete Key.bindings[i];
      }
    }
  }

  override draw(x: number, y: number, focused: boolean): void {
    if (!this.visible) {
      return;
    }

    M.Print(x, y, this.label);

    const keys = this.#findBoundKeys();
    if (keys.length === 0) {
      M.Print(x + 124, y, '???');
    } else {
      let name = Key.KeynumToString(keys[0]);
      if (keys[1] !== undefined) {
        name += ` or ${Key.KeynumToString(keys[1])}`;
      }
      M.Print(x + 124, y, name);
    }

    if (focused) {
      const cursorChar = this.capturing ? 61 : 12 + ((Host.realtime * 4.0) & 1);
      M.DrawCharacter(x + 114, y, cursorChar);
    }
  }

  override handleInput(key: K): boolean {
    if (this.capturing) {
      S.LocalSound(M.sfx_menu1);
      if (key !== K.ESCAPE && key !== 96 as K) { // FIXME: what’s 96?
        Cmd.text = `bind "${Key.KeynumToString(key)}" "${this.command}"\n${Cmd.text}`;
      }
      this.capturing = false;
      return true;
    }

    if (key === K.ENTER) {
      S.LocalSound(M.sfx_menu2);
      if (this.#findBoundKeys().length > 1) {
        this.#unbind();
      }
      this.capturing = true;
      return true;
    }

    if (key === K.BACKSPACE || key === K.DEL) {
      S.LocalSound(M.sfx_menu2);
      this.#unbind();
      return true;
    }

    return false;
  }
}

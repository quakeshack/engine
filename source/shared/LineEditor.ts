import { K } from './Keys.ts';

interface LineEditorConfig {
  readonly maxLength?: number;
  readonly validator?: (value: string) => boolean;
}

/**
 * A single line of editable text with cursor tracking. Shared by every text-input widget in
 * the engine (menu textboxes, the console prompt, the chat line) so cursor movement,
 * Backspace/Del, and paste behave identically everywhere.
 */
export class LineEditor {
  /** Flashing glyph pair shown when the cursor is at the end of the text (nothing to hide). */
  static readonly DEFAULT_END_GLYPHS: readonly [number, number] = [10, 11];
  /** Glyph shown for the cursor when it sits in front of an existing character. */
  static readonly DEFAULT_INSERT_GLYPH = 95; // underscore

  maxLength: number;
  validator: (value: string) => boolean;
  #text: string;
  #cursorPos: number;

  constructor(text = '', config: LineEditorConfig = {}) {
    this.maxLength = config.maxLength ?? Infinity;
    this.validator = config.validator ?? (() => true);
    this.#text = text;
    this.#cursorPos = text.length;
  }

  /**
   * Current text. Assigning it directly (e.g. loading a cvar or a history entry) moves the
   * cursor to the end, mirroring how a native `<input>` behaves when its `.value` is set
   * from script. Edits made through the methods below reposition the cursor precisely
   * instead.
   * @returns The current text.
   */
  get text(): string {
    return this.#text;
  }

  set text(next: string) {
    this.#text = next;
    this.#cursorPos = next.length;
  }

  /**
   * Cursor index into the text, clamped to the current length as a defensive fallback
   * against out-of-range assignment.
   * @returns The clamped cursor index.
   */
  get cursorPos(): number {
    return Math.min(this.#cursorPos, this.#text.length);
  }

  set cursorPos(pos: number) {
    this.#cursorPos = Math.max(0, Math.min(pos, this.#text.length));
  }

  /**
   * Replaces `text[start:end]` with `insertText`, subject to the validator, and moves the
   * cursor to just after the inserted text. Leaves the text and cursor untouched if the
   * validator rejected the result (e.g. a "must not be empty" rule blocking a Backspace).
   */
  #replaceRange(start: number, end: number, insertText: string): void {
    const before = this.#text;
    const next = before.slice(0, start) + insertText + before.slice(end);

    if (next === before || !this.validator(next)) {
      return;
    }

    this.#text = next;
    this.#cursorPos = start + insertText.length;
  }

  /** Deletes the character before the cursor, if any. */
  backspace(): void {
    const pos = this.cursorPos;
    if (pos > 0) {
      this.#replaceRange(pos - 1, pos, '');
    }
  }

  /** Deletes the character after the cursor (forward-delete), if any. */
  deleteForward(): void {
    const pos = this.cursorPos;
    if (pos < this.#text.length) {
      this.#replaceRange(pos, pos + 1, '');
    }
  }

  /** Inserts a single character at the cursor, subject to `maxLength`. */
  insertChar(char: string): void {
    if (this.#text.length < this.maxLength) {
      this.#replaceRange(this.cursorPos, this.cursorPos, char);
    }
  }

  /** Inserts pasted text at the cursor, collapsing newlines/tabs and truncating to `maxLength`. */
  paste(text: string): void {
    const sanitized = text.replace(/[\r\n\t]+/g, ' ');
    const available = this.maxLength - this.#text.length;

    if (available > 0 && sanitized.length > 0) {
      this.#replaceRange(this.cursorPos, this.cursorPos, sanitized.slice(0, available));
    }
  }

  /**
   * Applies a standard text-editing key: cursor movement (Left/Right/Home/End),
   * Backspace/Del, or inserting a printable character. Callers should handle any
   * destination-specific keys (Enter, Tab, history, scrollback, …) before falling back to
   * this, since every other printable key is treated as an insert.
   * @returns True if the key was recognized as a text-editing command.
   */
  handleKey(key: K): boolean {
    switch (key) {
      case K.LEFTARROW:
        this.cursorPos -= 1;
        return true;

      case K.RIGHTARROW:
        this.cursorPos += 1;
        return true;

      case K.HOME:
        this.cursorPos = 0;
        return true;

      case K.END:
        this.cursorPos = this.#text.length;
        return true;

      case K.BACKSPACE:
        this.backspace();
        return true;

      case K.DEL:
        this.deleteForward();
        return true;

      default:
        if (key >= K.SPACE && key < K.BACKSPACE) {
          this.insertChar(String.fromCharCode(key));
          return true;
        }
        return false;
    }
  }

  /**
   * Determines the glyph (if any) that should represent the blinking cursor. At the end of
   * the text, there is nothing to hide, so it always returns a glyph, alternating between
   * `endGlyphs` for the classic flashing cursor. Mid-line, the cursor sits in front of an
   * existing character, so it instead alternates between `insertGlyph` and `null` — `null`
   * meaning "draw nothing", which reveals that character rather than permanently hiding it.
   * The defaults are the Quake charset's flashing-cursor pair and insertion-point glyph.
   * @returns A character code to draw at the cursor, or null to reveal the text underneath.
   */
  cursorGlyph(
    blinkPhase: number,
    endGlyphs: readonly [number, number] = LineEditor.DEFAULT_END_GLYPHS,
    insertGlyph: number = LineEditor.DEFAULT_INSERT_GLYPH,
  ): number | null {
    if (this.cursorPos >= this.#text.length) {
      return endGlyphs[blinkPhase & 1];
    }

    return (blinkPhase & 1) === 0 ? insertGlyph : null;
  }

  /**
   * Splices a cursor glyph into the text, for destinations (console, chat) that draw the
   * whole line as a single string rather than positioning a separate cursor character. See
   * `cursorGlyph` for the blink behavior.
   * @returns The text with a cursor glyph spliced in, or the unmodified text when the blink
   * phase reveals the character underneath instead.
   */
  withCursorGlyph(
    blinkPhase: number,
    endGlyphs: readonly [number, number] = LineEditor.DEFAULT_END_GLYPHS,
    insertGlyph: number = LineEditor.DEFAULT_INSERT_GLYPH,
  ): string {
    const glyph = this.cursorGlyph(blinkPhase, endGlyphs, insertGlyph);

    if (glyph === null) {
      return this.#text;
    }

    const pos = this.cursorPos;
    const replaceEnd = pos < this.#text.length ? pos + 1 : pos;
    return this.#text.slice(0, pos) + String.fromCharCode(glyph) + this.#text.slice(replaceEnd);
  }
}

import { K } from '../../shared/Keys.ts';
import { LineEditor } from '../../shared/LineEditor.ts';
import Vector from '../../shared/Vector.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { clientConnectionState } from '../common/Def.ts';
import { eventBus, getClientRegistry } from '../registry.ts';

let { CL, Con, Host, M } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Con, Host, M } = getClientRegistry());
});

/**
 * Where key events are routed to, when the drop-down console isn't the one claiming them.
 * The console is no longer a peer destination — see `Con.isOpen`, which takes dispatch
 * priority over whichever of these is active underneath it (kept numbered as before, minus
 * the retired `console` member, so nothing here needs renumbering).
 */
export enum KeyDestination {
  game = 0,
  message = 2,
  menu = 3,
}

// ── Key name ↔ key-code mappings ─────────────────────────────────────────────

/** Named key string → key-code mapping for config file parsing. */
const keyNameToCode = new Map<string, number>([
  ['TAB', K.TAB],
  ['ENTER', K.ENTER],
  ['ESCAPE', K.ESCAPE],
  ['SPACE', K.SPACE],
  ['BACKSPACE', K.BACKSPACE],
  ['UPARROW', K.UPARROW],
  ['DOWNARROW', K.DOWNARROW],
  ['LEFTARROW', K.LEFTARROW],
  ['RIGHTARROW', K.RIGHTARROW],
  ['ALT', K.ALT],
  ['CTRL', K.CTRL],
  ['SHIFT', K.SHIFT],
  ['F1', K.F1],
  ['F2', K.F2],
  ['F3', K.F3],
  ['F4', K.F4],
  ['F5', K.F5],
  ['F6', K.F6],
  ['F7', K.F7],
  ['F8', K.F8],
  ['F9', K.F9],
  ['F10', K.F10],
  ['F11', K.F11],
  ['F12', K.F12],
  ['INS', K.INS],
  ['DEL', K.DEL],
  ['PGDN', K.PGDN],
  ['PGUP', K.PGUP],
  ['HOME', K.HOME],
  ['END', K.END],
  ['MOUSE1', K.MOUSE1],
  ['MOUSE2', K.MOUSE2],
  ['MOUSE3', K.MOUSE3],
  ['PAUSE', K.PAUSE],
  ['MWHEELUP', K.MWHEELUP],
  ['MWHEELDOWN', K.MWHEELDOWN],
  ['SEMICOLON', ';'.charCodeAt(0)],
]);

/** Reverse lookup: key-code → canonical name. Built once from keyNameToCode. */
const codeToKeyName = new Map<number, string>();
for (const [name, code] of keyNameToCode) {
  if (!codeToKeyName.has(code)) {
    codeToKeyName.set(code, name);
  }
}

// ── Shift map (US-QWERTY layout) ────────────────────────────────────────────

/**
 * Builds the shift-key lookup table (unshifted char-code → shifted char-code).
 * @returns The shift map array indexed by unshifted char code.
 */
function buildShiftMap(): number[] {
  const map: number[] = [];

  // Identity for all codes 0–255.
  for (let i = 0; i < 256; i++) {
    map[i] = i;
  }

  // a-z → A-Z
  for (let i = 'a'.charCodeAt(0); i <= 'z'.charCodeAt(0); i++) {
    map[i] = i - 32;
  }

  // Number row: 1!  2@  3#  4$  5%  6^  7&  8*  9(  0)
  const numberRowShifts: ReadonlyArray<[string, string]> = [
    ['1', '!'], ['2', '@'], ['3', '#'], ['4', '$'], ['5', '%'],
    ['6', '^'], ['7', '&'], ['8', '*'], ['9', '('], ['0', ')'],
  ];

  for (const [from, to] of numberRowShifts) {
    map[from.charCodeAt(0)] = to.charCodeAt(0);
  }

  // Punctuation shifts
  const punctuationShifts: ReadonlyArray<[string, string]> = [
    ['-', '_'], ['=', '+'], ['+', '<'], ['.', '>'], ['/', '?'],
    [';', ':'], ["'", '"'], ['[', '{'], [']', '}'], ['`', '~'],
    ['\\', '|'],
  ];

  for (const [from, to] of punctuationShifts) {
    map[from.charCodeAt(0)] = to.charCodeAt(0);
  }

  return map;
}

// ── Console-key set ──────────────────────────────────────────────────────────

/**
 * Builds the set of key codes that are consumed by the console input.
 * @returns A set of key codes for console-mode input.
 */
function buildConsoleKeySet(): Set<number> {
  const keys = new Set<number>();

  // All printable ASCII characters
  for (let i = K.SPACE; i < K.BACKSPACE; i++) {
    keys.add(i);
  }

  // Navigation and editing keys
  keys.add(K.ENTER);
  keys.add(K.TAB);
  keys.add(K.LEFTARROW);
  keys.add(K.RIGHTARROW);
  keys.add(K.UPARROW);
  keys.add(K.DOWNARROW);
  keys.add(K.BACKSPACE);
  keys.add(K.DEL);
  keys.add(K.HOME);
  keys.add(K.END);
  keys.add(K.PGUP);
  keys.add(K.PGDN);
  keys.add(K.SHIFT);

  // Backtick (`) and tilde (~) toggle the console, so they must not be consumed as input.
  keys.delete('`'.charCodeAt(0));
  keys.delete('~'.charCodeAt(0));

  return keys;
}

// ── Prompt color ─────────────────────────────────────────────────────────────

const CONSOLE_PROMPT_COLOR = new Vector(0.8, 0.8, 0.8);

export default class Key {
  /** Console input history. */
  static lines: string[] = [''];
  /** Line editor backing the console input line. */
  static #consoleEditor = new LineEditor();
  /** Index into history lines for Up/Down navigation. */
  static history_line = 1;

  /** Current active key destination, when the drop-down console isn't claiming input. */
  static destination = KeyDestination.game;

  /** Active key bindings, indexed by key code. */
  static bindings: (string | null)[] = [];

  /** Set of key codes that are consumed by the console rather than bound commands. */
  private static consolekeys = buildConsoleKeySet();

  /** Shift-key lookup table (indexed by unshifted key code, returns shifted code). */
  private static shiftMap = buildShiftMap();

  /** Currently pressed key codes. */
  private static pressed = new Set<number>();

  /** True when Shift is held. */
  private static shiftDown = false;

  // ── Console input ────────────────────────────────────────────────────────

  /**
   * Current console input line. Assigning it moves the cursor to the end.
   * @returns The current console input line.
   */
  static get edit_line(): string {
    return Key.#consoleEditor.text;
  }

  static set edit_line(value: string) {
    Key.#consoleEditor.text = value;
  }

  /**
   * Cursor index into the console input line.
   * @returns The current cursor index.
   */
  static get consoleCursorPos(): number {
    return Key.#consoleEditor.cursorPos;
  }

  /**
   * The console input line with a blinking cursor glyph spliced in, for the given blink
   * phase. See `LineEditor.cursorGlyph` for how the mid-line vs. end-of-line blink differs.
   * @returns The line to draw, cursor included.
   */
  static consoleDisplayText(blinkPhase: number): string {
    return Key.#consoleEditor.withCursorGlyph(blinkPhase);
  }

  /** Handles a keypress for console input mode. */
  static Console(key: K): void {
    switch (key) {
      case K.ENTER: {
        const line = Key.#consoleEditor.text;
        Cmd.text += `${line}\n`;
        Con.Print(`]${line}\n`, CONSOLE_PROMPT_COLOR);
        Key.lines.push(line);
        Key.#consoleEditor.text = '';
        Key.history_line = Key.lines.length;
        return;
      }

      case K.TAB: {
        const cmd = Cmd.CompleteCommand(Key.edit_line) ?? Cvar.CompleteVariable(Key.edit_line);
        if (cmd !== null) {
          Key.edit_line = `${cmd} `;
        }
        return;
      }

      case K.UPARROW: {
        Key.history_line = Math.max(0, Key.history_line - 1);
        Key.edit_line = Key.lines[Key.history_line];
        return;
      }

      case K.DOWNARROW: {
        if (Key.history_line >= Key.lines.length) {
          return;
        }
        Key.history_line++;
        if (Key.history_line >= Key.lines.length) {
          Key.history_line = Key.lines.length;
          Key.edit_line = '';
          return;
        }
        Key.edit_line = Key.lines[Key.history_line];
        return;
      }

      case K.PGUP: {
        Con.backscroll = Math.min(Con.backscroll + 2, Con.text.length);
        return;
      }

      case K.PGDN: {
        Con.backscroll = Math.max(Con.backscroll - 2, 0);
        return;
      }

      // Ctrl+Home/Ctrl+End jump the scrollback to the top/bottom. Plain Home/End fall
      // through to the line editor below, moving the cursor within the input line instead.
      case K.HOME: {
        if (Key.pressed.has(K.CTRL)) {
          Con.backscroll = Math.max(Con.text.length - 10, 0);
          return;
        }
        break;
      }

      case K.END: {
        if (Key.pressed.has(K.CTRL)) {
          Con.backscroll = 0;
          return;
        }
        break;
      }
    }

    Key.#consoleEditor.handleKey(key);
  }

  // ── Chat message input ───────────────────────────────────────────────────

  /** Maximum chat message length. */
  private static readonly MAX_CHAT_LENGTH = 31;

  /** Line editor backing the chat input line. */
  static #chatEditor = new LineEditor('', { maxLength: Key.MAX_CHAT_LENGTH });

  /** True when composing a team-only message. */
  static team_message = false;

  /**
   * Current chat message being composed. Assigning it moves the cursor to the end.
   * @returns The current chat message.
   */
  static get chat_buffer(): string {
    return Key.#chatEditor.text;
  }

  static set chat_buffer(value: string) {
    Key.#chatEditor.text = value;
  }

  /**
   * Cursor index into the chat input line.
   * @returns The current cursor index.
   */
  static get chatCursorPos(): number {
    return Key.#chatEditor.cursorPos;
  }

  /**
   * The chat input line with a blinking cursor glyph spliced in, for the given blink phase.
   * See `LineEditor.cursorGlyph` for how the mid-line vs. end-of-line blink differs.
   * @returns The line to draw, cursor included.
   */
  static chatDisplayText(blinkPhase: number): string {
    return Key.#chatEditor.withCursorGlyph(blinkPhase);
  }

  /** Handles a keypress for chat message mode. */
  static Message(key: K): void {
    if (key === K.ENTER) {
      if (Key.#chatEditor.text.trim().length > 0) {
        const command = Key.team_message ? 'say_team' : 'say';
        void Cmd.ExecuteString(`${command} "${Key.#chatEditor.text}"`);
      }
      Key.destination = KeyDestination.game;
      Key.#chatEditor.text = '';
      return;
    }

    if (key === K.ESCAPE) {
      Key.destination = KeyDestination.game;
      Key.#chatEditor.text = '';
      return;
    }

    Key.#chatEditor.handleKey(key);
  }

  // ── Key name / code conversion ───────────────────────────────────────────

  /**
   * Looks up the first key bound to the given command string.
   * @returns The key name string, or null when not bound.
   */
  static BindingToString(binding: string): string | null {
    const keynum = Key.bindings.indexOf(binding);
    if (keynum === -1) {
      return null;
    }
    return Key.KeynumToString(keynum);
  }

  /**
   * Converts a key name string to a key code.
   * @returns The numeric key code, or null for unknown names.
   */
  static StringToKeynum(str: string): number | null {
    if (str.length === 1) {
      return str.charCodeAt(0);
    }
    return keyNameToCode.get(str.toUpperCase()) ?? null;
  }

  /**
   * Converts a key code to its printable name string.
   * @returns The key name, or `'<UNKNOWN KEYNUM>'` for unrecognized codes.
   */
  static KeynumToString(keynum: number): string {
    if (keynum > (K.SPACE as number) && keynum < (K.BACKSPACE as number)) {
      return String.fromCharCode(keynum);
    }
    return codeToKeyName.get(keynum) ?? '<UNKNOWN KEYNUM>';
  }

  // ── Bind / unbind console commands ───────────────────────────────────────

  /** Console command handler: unbinds a single key. */
  static Unbind_f(...args: string[]): void {
    if (args.length === 0) {
      Con.Print('Usage: unbind <key>\n');
      return;
    }
    const b = Key.StringToKeynum(args[0]);
    if (b === null) {
      Con.Print(`"${args[0]}" isn't a valid key\n`);
      return;
    }
    Key.bindings[b] = null;
  }

  /** Console command handler: unbinds all keys. */
  static Unbindall_f(): void {
    Key.bindings = [];
  }

  /** Console command handler: binds or prints a key binding. */
  static Bind_f(...args: string[]): void {
    if (args.length === 0) {
      Con.Print('Usage: bind <key> [command]\n');
      return;
    }

    const keyName = args[0];
    const b = Key.StringToKeynum(keyName.toLowerCase());

    if (b === null) {
      Con.Print(`"${keyName}" isn't a valid key\n`);
      return;
    }

    if (args.length < 2) {
      const binding = Key.bindings[b];
      if (binding !== null && binding !== undefined) {
        Con.Print(`"${keyName}" = "${binding}"\n`);
      } else {
        Con.Print(`"${keyName}" is not bound\n`);
      }
      return;
    }

    Key.bindings[b] = args[1];
    Host.WriteConfiguration();
  }

  /**
   * Serializes all key bindings as a config file string.
   * @returns Newline-separated `bind` commands for all active bindings.
   */
  static WriteBindings(): string {
    const lines: string[] = [];
    for (let i = 0; i < Key.bindings.length; i++) {
      if (Key.bindings[i] !== null && Key.bindings[i] !== undefined) {
        lines.push(`bind "${Key.KeynumToString(i)}" "${Key.bindings[i]}"`);
      }
    }
    return lines.join('\n');
  }

  // ── Initialization ───────────────────────────────────────────────────────

  /** Registers key-related console commands. */
  static Init(): void {
    Cmd.AddCommand('bind', (...args: string[]) => { Key.Bind_f(...args); });
    Cmd.AddCommand('unbind', (...args: string[]) => { Key.Unbind_f(...args); });
    Cmd.AddCommand('unbindall', () => { Key.Unbindall_f(); });
  }

  // ── Event dispatch ───────────────────────────────────────────────────────

  /** Appends a `+command` (key-down) or `-command` (key-up) binding action to the command buffer. */
  private static appendBindAction(binding: string, key: K, down: boolean): void {
    if (binding.startsWith('+')) {
      const prefix = down ? '+' : '-';
      Cmd.text += `${prefix}${binding.substring(1)} ${key}\n`;
    } else if (down) {
      Cmd.text += `${binding}\n`;
    }
  }

  /** Routes a raw key event to the appropriate handler based on current destination. */
  static Event(key: K, down: boolean): void {
    // Allow cancelling a pending connection with Escape.
    if (CL.cls.state === clientConnectionState.connecting && key === K.ESCAPE && down) {
      CL.Disconnect();
      M.ToggleMenu_f();
      return;
    }

    // Suppress auto-repeat for most keys.
    if (down && key !== K.BACKSPACE && key !== K.PAUSE && Key.pressed.has(key)) {
      return;
    }

    if (down) {
      Key.pressed.add(key);
    } else {
      Key.pressed.delete(key);
    }

    if (key === K.SHIFT) {
      Key.shiftDown = down;
    }

    // Escape handling: always consumed. A drop-down console open on top of anything else always
    // takes priority to close — it never touches whatever destination is underneath.
    if (key === K.ESCAPE) {
      if (!down) {
        return;
      }
      if (Con.isOpen) {
        Con.isOpen = false;
        Key.history_line = Key.lines.length;
        return;
      }
      if (Key.destination === KeyDestination.message) {
        Key.Message(key);
      } else if (Key.destination === KeyDestination.menu) {
        M.Keydown(key);
      } else {
        M.ToggleMenu_f();
      }
      return;
    }

    // Key-up: release any +command bindings.
    if (!down) {
      const binding = Key.bindings[key];
      if (binding !== null && binding !== undefined) {
        Key.appendBindAction(binding, key, false);
      }
      // Also release the shifted variant if it differs.
      const shiftedCode = Key.shiftMap[key];
      if (shiftedCode !== (key as number)) {
        const shiftedBinding = Key.bindings[shiftedCode];
        if (shiftedBinding !== null && shiftedBinding !== undefined) {
          Key.appendBindAction(shiftedBinding, key, false);
        }
      }
      return;
    }

    // The drop-down console, when open, takes dispatch priority over whatever destination is
    // underneath (game or menu) — it's an overlay, not a peer destination. Keys it doesn't
    // consume as text (e.g. the toggle key itself) still execute their bound command, so `~`
    // continues to close it.
    if (Con.isOpen) {
      if (!Key.consolekeys.has(key)) {
        const binding = Key.bindings[key];
        if (binding !== null && binding !== undefined) {
          Key.appendBindAction(binding, key, true);
        }
        return;
      }

      if (Key.shiftDown) {
        key = Key.shiftMap[key] as K;
      }

      Key.Console(key);
      return;
    }

    // During demo playback, any console key in game mode opens the menu.
    if (CL.cls.demoplayback && Key.consolekeys.has(key) && Key.destination === KeyDestination.game) {
      M.ToggleMenu_f();
      return;
    }

    // Stuck at the "game" destination with no game actually running (e.g. right after closing
    // the menu while disconnected) and no keyboard handy: clicking the canvas is a mouse-only
    // escape hatch back to the menu, mirroring what Escape already does here. Checked at
    // mousedown time (before M.Keydown() could react to this same click and change
    // Key.destination) so a click on the menu's own Back/Close button can't immediately reopen
    // what it was just asked to close.
    if (key === K.MOUSE1 && Key.destination === KeyDestination.game && CL.cls.state !== clientConnectionState.connected) {
      M.Menu_Main_f();
      return;
    }

    // Execute bindings when the key shouldn't be consumed by the active text input:
    // - In game, bindings always execute (the console, if open, already claimed the key above).
    // - In the menu, any key that isn't meaningful as literal text (F-keys, Ins, Pause, and —
    //   importantly — the console's toggle key) executes its binding too, so `~` can pop the
    //   console open even while a text field like "Your Name" is focused. Mouse buttons/wheel
    //   are deliberately excluded here even though they're not console text either: those need
    //   to keep reaching the menu's own click handling below.
    const isMouseOrWheel = key === K.MOUSE1 || key === K.MOUSE2 || key === K.MOUSE3
      || key === K.MWHEELUP || key === K.MWHEELDOWN;
    if (Key.destination === KeyDestination.game
      || (Key.destination === KeyDestination.menu && !isMouseOrWheel && !Key.consolekeys.has(key))) {
      const binding = Key.bindings[key];
      if (binding !== null && binding !== undefined) {
        Key.appendBindAction(binding, key, true);
      }
      return;
    }

    // Apply shift mapping for text input destinations.
    if (Key.shiftDown) {
      key = Key.shiftMap[key] as K;
    }

    switch (Key.destination) {
      case KeyDestination.message:
        Key.Message(key);
        break;
      case KeyDestination.menu:
        M.Keydown(key);
        break;
    }
  }

  /** Forwards clipboard text (e.g. from a Ctrl+V shortcut) to the active text input. */
  static Paste(text: string): void {
    if (Con.isOpen) {
      Key.#consoleEditor.paste(text);
      return;
    }

    switch (Key.destination) {
      case KeyDestination.menu:
        M.Paste(text);
        return;
      case KeyDestination.message:
        Key.#chatEditor.paste(text);
        return;
      default:
        return;
    }
  }
}


import { K } from '../../shared/Keys.ts';
import Vector from '../../shared/Vector.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { clientConnectionState } from '../common/Def.ts';
import { eventBus, getClientRegistry } from '../registry.mjs';

let { CL, Con, Host, M } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Con, Host, M } = getClientRegistry());
});

/** Current key state, mapping key code → pressed flag. */
interface KeyDest {
  readonly game: 0;
  readonly console: 1;
  readonly message: 2;
  readonly menu: 3;
  /** Mutable current destination. */
  value: number;
}

export default class Key {
  /** Console input history. */
  static lines: string[] = [''];
  /** Current console input line. */
  static edit_line = '';
  /** Index into history lines for Up/Down navigation. */
  static history_line = 1;

  /** Key destination routing constants and current active destination. */
  static dest: KeyDest = {
    game: 0,
    console: 1,
    message: 2,
    menu: 3,
    value: 1, // FIXME
  };

  static bindings: (string | null)[] = [];
  static consolekeys: (boolean | undefined)[] = [];
  static shift: number[] = [];
  static down: (boolean | undefined)[] = [];

  /** Named key string → key-code mapping for config file parsing. */
  static readonly names: Record<string, number> = {
    TAB: K.TAB,
    ENTER: K.ENTER,
    ESCAPE: K.ESCAPE,
    SPACE: K.SPACE,
    BACKSPACE: K.BACKSPACE,
    UPARROW: K.UPARROW,
    DOWNARROW: K.DOWNARROW,
    LEFTARROW: K.LEFTARROW,
    RIGHTARROW: K.RIGHTARROW,
    ALT: K.ALT,
    CTRL: K.CTRL,
    SHIFT: K.SHIFT,
    F1: K.F1,
    F2: K.F2,
    F3: K.F3,
    F4: K.F4,
    F5: K.F5,
    F6: K.F6,
    F7: K.F7,
    F8: K.F8,
    F9: K.F9,
    F10: K.F10,
    F11: K.F11,
    F12: K.F12,
    INS: K.INS,
    DEL: K.DEL,
    PGDN: K.PGDN,
    PGUP: K.PGUP,
    HOME: K.HOME,
    END: K.END,
    MOUSE1: K.MOUSE1,
    MOUSE2: K.MOUSE2,
    MOUSE3: K.MOUSE3,
    PAUSE: K.PAUSE,
    MWHEELUP: K.MWHEELUP,
    MWHEELDOWN: K.MWHEELDOWN,
    SEMICOLON: 59,
  };

  /** Handles a keypress for console input mode. */
  static Console(key: number): void {
    if (key === K.ENTER) {
      Cmd.text += Key.edit_line + '\n';
      Con.Print(']' + Key.edit_line + '\n', new Vector(0.8, 0.8, 0.8));
      Key.lines[Key.lines.length] = Key.edit_line;
      Key.edit_line = '';
      Key.history_line = Key.lines.length;
      return;
    }

    if (key === K.TAB) {
      let cmd = Cmd.CompleteCommand(Key.edit_line);
      if (cmd === null) {
        cmd = Cvar.CompleteVariable(Key.edit_line);
      }
      if (cmd === null) {
        return;
      }
      Key.edit_line = cmd + ' ';
      return;
    }

    if ((key === K.BACKSPACE) || (key === K.LEFTARROW)) {
      if (Key.edit_line.length > 0) {
        Key.edit_line = Key.edit_line.substring(0, Key.edit_line.length - 1);
      }
      return;
    }

    if (key === K.UPARROW) {
      if (--Key.history_line < 0) {
        Key.history_line = 0;
      }
      Key.edit_line = Key.lines[Key.history_line];
      return;
    }

    if (key === K.DOWNARROW) {
      if (Key.history_line >= Key.lines.length) {
        return;
      }
      if (++Key.history_line >= Key.lines.length) {
        Key.history_line = Key.lines.length;
        Key.edit_line = '';
        return;
      }
      Key.edit_line = Key.lines[Key.history_line];
      return;
    }

    if (key === K.PGUP) {
      Con.backscroll += 2;
      if (Con.backscroll > Con.text.length) {
        Con.backscroll = Con.text.length;
      }
      return;
    }

    if (key === K.PGDN) {
      Con.backscroll -= 2;
      if (Con.backscroll < 0) {
        Con.backscroll = 0;
      }
      return;
    }

    if (key === K.HOME) {
      Con.backscroll = Con.text.length - 10;
      if (Con.backscroll < 0) {
        Con.backscroll = 0;
      }
      return;
    }

    if (key === K.END) {
      Con.backscroll = 0;
      return;
    }

    if ((key < 32) || (key > 127)) {
      return;
    }

    Key.edit_line += String.fromCharCode(key);
  }

  /** Current chat message being composed. */
  static chat_buffer = '';
  /** True when composing a team-only message. */
  static team_message = false;

  /** Handles a keypress for chat message mode. */
  static Message(key: number): void {
    if (key === K.ENTER) {
      if (Key.chat_buffer.trim().length > 0) {
        if (Key.team_message) {
          void Cmd.ExecuteString(`say_team "${Key.chat_buffer}"`);
        } else {
          void Cmd.ExecuteString(`say "${Key.chat_buffer}"`);
        }
      }
      Key.dest.value = Key.dest.game;
      Key.chat_buffer = '';
      return;
    }
    if (key === K.ESCAPE) {
      Key.dest.value = Key.dest.game;
      Key.chat_buffer = '';
      return;
    }
    if ((key < 32) || (key > 127)) {
      return;
    }
    if (key === K.BACKSPACE) {
      if (Key.chat_buffer.length !== 0) {
        Key.chat_buffer = Key.chat_buffer.substring(0, Key.chat_buffer.length - 1);
      }
      return;
    }
    if (Key.chat_buffer.length >= 31) {
      return;
    }
    Key.chat_buffer = Key.chat_buffer + String.fromCharCode(key);
  }

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

    return Key.names[str.toUpperCase()] ?? null;
  }

  /**
   * Converts a key code to its printable name string.
   * @returns The key name, or `'<UNKNOWN KEYNUM>'` for unrecognized codes.
   */
  static KeynumToString(keynum: number): string {
    if ((keynum > 32) && (keynum < 127)) {
      return String.fromCharCode(keynum);
    }

    for (const [name, num] of Object.entries(Key.names)) {
      if (num === keynum) {
        return name;
      }
    }

    return '<UNKNOWN KEYNUM>';
  }

  /** Console command handler: unbinds a single key. */
  static Unbind_f(key: string | undefined): void {
    if (key === undefined) {
      Con.Print('Usage: unbind <key>\n');
    }
    const b = Key.StringToKeynum(key!);
    if (b === null) {
      Con.Print(`"${key}" isn't a valid key\n`);
      return;
    }
    Key.bindings[b] = null;
  }

  /** Console command handler: unbinds all keys. */
  static Unbindall_f(): void {
    Key.bindings = [];
  }

  /** Console command handler: binds or prints a key binding. */
  static Bind_f(key: string | undefined, command: string | undefined): void {
    if (key === undefined) {
      Con.Print('Usage: bind <key> [command]\n');
      return;
    }

    const b = Key.StringToKeynum(key.toLowerCase());

    if (b === null) {
      Con.Print(`"${key}" isn't a valid key\n`);
      return;
    }
    if (command === undefined) {
      if (Key.bindings[b] !== null && Key.bindings[b] !== undefined) {
        Con.Print(`"${key}" = "${Key.bindings[b]}"\n`);
      } else {
        Con.Print(`"${key}" is not bound\n`);
      }
      return;
    }

    Key.bindings[b] = command;

    Host.WriteConfiguration();
  }

  /**
   * Serializes all key bindings as a config file string.
   * @returns Newline-separated `bind` commands for all active bindings.
   */
  static WriteBindings(): string {
    const f: string[] = [];
    for (let i = 0; i < Key.bindings.length; i++) {
      if (Key.bindings[i] !== null && Key.bindings[i] !== undefined) {
        f.push(`bind "${Key.KeynumToString(i)}" "${Key.bindings[i]}"`);
      }
    }
    return f.join('\n');
  }

  /** Initializes key tables, console key map, and registers console commands. */
  static Init(): void {
    let i;

    for (i = 32; i < 128; i++) {
      Key.consolekeys[i] = true;
    }
    Key.consolekeys[K.ENTER] = true;
    Key.consolekeys[K.TAB] = true;
    Key.consolekeys[K.LEFTARROW] = true;
    Key.consolekeys[K.RIGHTARROW] = true;
    Key.consolekeys[K.UPARROW] = true;
    Key.consolekeys[K.DOWNARROW] = true;
    Key.consolekeys[K.BACKSPACE] = true;
    Key.consolekeys[K.HOME] = true;
    Key.consolekeys[K.END] = true;
    Key.consolekeys[K.PGUP] = true;
    Key.consolekeys[K.PGDN] = true;
    Key.consolekeys[K.SHIFT] = true;
    Key.consolekeys[96] = false;
    Key.consolekeys[126] = false;

    for (i = 0; i < 256; i++) {
      Key.shift[i] = i;
    }
    for (i = 97; i <= 122; i++) {
      Key.shift[i] = i - 32;
    }
    Key.shift[49] = 33;
    Key.shift[50] = 64;
    Key.shift[51] = 35;
    Key.shift[52] = 36;
    Key.shift[53] = 37;
    Key.shift[54] = 94;
    Key.shift[55] = 38;
    Key.shift[56] = 42;
    Key.shift[57] = 40;
    Key.shift[48] = 41;
    Key.shift[45] = 95;
    Key.shift[61] = 43;
    Key.shift[43] = 60;
    Key.shift[46] = 62;
    Key.shift[47] = 63;
    Key.shift[59] = 58;
    Key.shift[39] = 34;
    Key.shift[91] = 123;
    Key.shift[93] = 125;
    Key.shift[96] = 126;
    Key.shift[92] = 124;

    Cmd.AddCommand('bind', Key.Bind_f);
    Cmd.AddCommand('unbind', Key.Unbind_f);
    Cmd.AddCommand('unbindall', Key.Unbindall_f);
  }

  /** True when Shift is held. */
  static shift_down = false;

  /** Routes a raw key event to the appropriate handler based on current destination. */
  static Event(key: number, down: boolean): void {
    if (CL.cls.state === clientConnectionState.connecting && key === K.ESCAPE && down === true) {
      CL.Disconnect();
      M.ToggleMenu_f();
      return;
    }
    if (down === true) {
      if ((key !== K.BACKSPACE) && (key !== K.PAUSE) && (Key.down[key] === true)) {
        return;
      }
    }
    Key.down[key] = down;

    if (key === K.SHIFT) {
      Key.shift_down = down;
    }

    if (key === K.ESCAPE) {
      if (down !== true) {
        return;
      }
      if (Key.dest.value === Key.dest.message) {
        Key.Message(key);
      } else if (Key.dest.value === Key.dest.menu) {
        M.Keydown(key);
      } else {
        M.ToggleMenu_f();
      }
      return;
    }

    let kb: string | null | undefined;

    if (down !== true) {
      kb = Key.bindings[key];
      if (kb !== null && kb !== undefined) {
        if (kb.charCodeAt(0) === 43) {
          Cmd.text += '-' + kb.substring(1) + ' ' + key + '\n';
        }
      }
      if (Key.shift[key] !== key) {
        kb = Key.bindings[Key.shift[key]];
        if (kb !== null && kb !== undefined) {
          if (kb.charCodeAt(0) === 43) {
            Cmd.text += '-' + kb.substring(1) + ' ' + key + '\n';
          }
        }
      }
      return;
    }

    if ((CL.cls.demoplayback === true) && (Key.consolekeys[key] === true) && (Key.dest.value === Key.dest.game)) {
      M.ToggleMenu_f();
      return;
    }

    if (((Key.dest.value === Key.dest.menu) && ((key === K.ESCAPE) || ((key >= K.F1) && (key <= K.F12)))) ||
      ((Key.dest.value === Key.dest.console) && (Key.consolekeys[key] !== true)) ||
      ((Key.dest.value === Key.dest.game) && ((Con.forcedup !== true) || (Key.consolekeys[key] !== true)))) {
      kb = Key.bindings[key];
      if (kb !== null && kb !== undefined) {
        if (kb.charCodeAt(0) === 43) {
          Cmd.text += kb + ' ' + key + '\n';
        } else {
          Cmd.text += kb + '\n';
        }
      }
      return;
    }

    if (Key.shift_down === true) {
      key = Key.shift[key];
    }

    if (Key.dest.value === Key.dest.message) {
      Key.Message(key);
    } else if (Key.dest.value === Key.dest.menu) {
      M.Keydown(key);
    } else {
      Key.Console(key);
    }
  }
}

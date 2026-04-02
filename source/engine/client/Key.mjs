import { K } from '../../shared/Keys.ts';
import Vector from '../../shared/Vector.ts';
import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import { clientConnectionState } from '../common/Def.mjs';
import { registry, eventBus } from '../registry.mjs';

const Key = {};

export default Key;

let { CL, Con, Host, M } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  Con = registry.Con;
  Host = registry.Host;
  M = registry.M;
});

Key.lines = [''];
Key.edit_line = '';
Key.history_line = 1;

Key.dest = /*Object.freeze*/({
  game: 0,
  console: 1,
  message: 2,
  menu: 3,

  value: 1, // FIXME
});

Key.bindings = [];
Key.consolekeys = [];
Key.shift = [];
Key.down = [];

Key.names = {
  'TAB': K.TAB,
  'ENTER': K.ENTER,
  'ESCAPE': K.ESCAPE,
  'SPACE': K.SPACE,
  'BACKSPACE': K.BACKSPACE,
  'UPARROW': K.UPARROW,
  'DOWNARROW': K.DOWNARROW,
  'LEFTARROW': K.LEFTARROW,
  'RIGHTARROW': K.RIGHTARROW,
  'ALT': K.ALT,
  'CTRL': K.CTRL,
  'SHIFT': K.SHIFT,
  'F1': K.F1,
  'F2': K.F2,
  'F3': K.F3,
  'F4': K.F4,
  'F5': K.F5,
  'F6': K.F6,
  'F7': K.F7,
  'F8': K.F8,
  'F9': K.F9,
  'F10': K.F10,
  'F11': K.F11,
  'F12': K.F12,
  'INS': K.INS,
  'DEL': K.DEL,
  'PGDN': K.PGDN,
  'PGUP': K.PGUP,
  'HOME': K.HOME,
  'END': K.END,
  'MOUSE1': K.MOUSE1,
  'MOUSE2': K.MOUSE2,
  'MOUSE3': K.MOUSE3,
  'PAUSE': K.PAUSE,
  'MWHEELUP': K.MWHEELUP,
  'MWHEELDOWN': K.MWHEELDOWN,
  'SEMICOLON': 59,
};

Key.Console = function(key) {
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
};

Key.chat_buffer = '';

Key.Message = function(key) {
  if (key === K.ENTER) {
    if (Key.chat_buffer.trim().length > 0) {
      if (Key.team_message) {
        Cmd.ExecuteString(`say_team "${Key.chat_buffer}"`);
      } else {
        Cmd.ExecuteString(`say "${Key.chat_buffer}"`);
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
};

Key.BindingToString = function(binding) {
  const keynum = Key.bindings.indexOf(binding);

  if (keynum === -1) {
    return null;
  }

  return Key.KeynumToString(keynum);
};

Key.StringToKeynum = function(str) {
  if (str.length === 1) {
    return str.charCodeAt(0);
  }

  return Key.names[str.toUpperCase()] || null;
};

Key.KeynumToString = function(keynum) {
  if ((keynum > 32) && (keynum < 127)) {
    return String.fromCharCode(keynum);
  }

  for (const [name, num] of Object.entries(Key.names)) {
    if (num === keynum) {
      return name;
    }
  }

  return '<UNKNOWN KEYNUM>';
};

Key.Unbind_f = function(key) {
  if (key === undefined) {
    Con.Print('Usage: unbind <key>\n');
  }
  const b = Key.StringToKeynum(key);
  if (b === null) {
    Con.Print('"' + key + '" isn\'t a valid key\n');
    return;
  }
  Key.bindings[b] = null;
};

Key.Unbindall_f = function() {
  Key.bindings = [];
};

Key.Bind_f = function(key, command) {
  if (key === undefined) {
    Con.Print('Usage: bind <key> [command]\n');
    return;
  }

  const b = Key.StringToKeynum(key.toLowerCase());

  if (b === null) {
    Con.Print('"' + key + '" isn\'t a valid key\n');
    return;
  }
  if (command === undefined) {
    if (Key.bindings[b] != null) {
      Con.Print('"' + key + '" = "' + Key.bindings[b] + '"\n');
    } else {
      Con.Print('"' + key + '" is not bound\n');
    }
    return;
  }

  Key.bindings[b] = command;

  Host.WriteConfiguration();
};

Key.WriteBindings = function() {
  const f = [];
  for (let i = 0; i < Key.bindings.length; i++) {
    if (Key.bindings[i] != null) {
      f.push('bind "' + Key.KeynumToString(i) + '" "' + Key.bindings[i] + '"');
    }
  }
  return f.join('\n');
};

Key.Init = function() {
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
};

Key.Event = function(key, down) {
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

  let kb;

  if (down !== true) {
    kb = Key.bindings[key];
    if (kb != null) {
      if (kb.charCodeAt(0) === 43) {
        Cmd.text += '-' + kb.substring(1) + ' ' + key + '\n';
      }
    }
    if (Key.shift[key] !== key) {
      kb = Key.bindings[Key.shift[key]];
      if (kb != null) {
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
    if (kb != null) {
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
};

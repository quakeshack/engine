

import { eventBus, registry } from '../registry.mjs';
import Cvar from './Cvar.mjs';
import Vector from '../../shared/Vector.mjs';
import Cmd from './Cmd.mjs';
import VID from '../client/VID.mjs';
import { version } from './Def.mjs';

let { CL, Draw, Host, Key, M, SCR } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  Draw = registry.Draw;
  Host = registry.Host;
  Key = registry.Key;
  M = registry.M;
  SCR = registry.SCR;
});

export default class Con {
  static backscroll = 0;
  static current = 0;
  static text = [];
  static captureBuffer = null;
  /** @type {Cvar} */
  static notifytime = null;

  /** used by the client to force the console to be up */
  static forcedup = false;

  /** used by the client to determine how many lines to draw */
  static vislines = 0;

  static ToggleConsole_f() {
    SCR.EndLoadingPlaque();
    if (Key.dest.value === Key.dest.console) {
      if (CL.cls.state !== CL.active.connected) {
        M.Menu_Main_f();
        return;
      }
      Key.dest.value = Key.dest.game;
      // Key.edit_line = ''; // CR: this annoys me otherwise
      Key.history_line = Key.lines.length;
      return;
    }
    Key.dest.value = Key.dest.console;
  }

  static Clear_f() {
    Con.backscroll = 0;
    Con.current = 0;
    Con.text = [];
  }

  static ClearNotify() {
    for (let i = Math.max(0, Con.text.length - 4); i < Con.text.length; i++) {
      Con.text[i].time = 0.0;
    }
  }

  static MessageMode_f() {
    Key.dest.value = Key.dest.message;
    Key.team_message = false;
  }

  static MessageMode2_f() {
    Key.dest.value = Key.dest.message;
    Key.team_message = true;
  }

  static Init() {
    Con.Print('Console initialized.\n');

    Con.notifytime = new Cvar('con_notifytime', '3', Cvar.FLAG.ARCHIVE, 'How long to display console messages.');

    if (!registry.isDedicatedServer) {
      Cmd.AddCommand('toggleconsole', Con.ToggleConsole_f);
      Cmd.AddCommand('messagemode', Con.MessageMode_f);
      Cmd.AddCommand('messagemode2', Con.MessageMode2_f);
      Cmd.AddCommand('clear', Con.Clear_f);
    }
  }

  static StartCapturing() {
    Con.captureBuffer = [];
  }

  static StopCapturing() {
    const data = Con.captureBuffer.join('\n') + '\n';
    Con.captureBuffer = null;
    return data;
  }

  static Print(msg, color = new Vector(1.0, 1.0, 1.0)) {
    Con.backscroll = 0;

    let mask = 0;
    if (msg.charCodeAt(0) <= 2) {
      mask = 128;
      // if (msg.charCodeAt(0) === 1) {
      //   S.LocalSound(Con.sfx_talk);
      // }
      msg = msg.substring(1);
    }
    for (let i = 0; i < msg.length; i++) {
      if (!Con.text[Con.current]) {
        Con.text[Con.current] = { text: '', time: Host.realtime || 0, color };
      }
      if (msg.charCodeAt(i) === 10) {
        const line = Con.text[Con.current].text;
        if (Con.captureBuffer !== null) {
          Con.captureBuffer.push(line);
        }
        eventBus.publish('console.print-line', line);
        if (Con.text.length >= 1024) {
          Con.text = Con.text.slice(-512);
          Con.current = Con.text.length;
        } else {
          Con.current++;
        }
        continue;
      }
      Con.text[Con.current].text += String.fromCharCode(msg.charCodeAt(i) + mask);
    }
  }

  static DPrint(msg) {
    if (Host.developer.value === 0) {
      return;
    }

    Con.Print(msg, new Vector(0.7, 0.7, 1.0));
  }

  static PrintWarning(msg) {
    Con.Print(msg, new Vector(1.0, 1.0, 0.3));
  }

  static PrintError(msg) {
    Con.Print(msg, new Vector(1.0, 0.3, 0.3));
  }

  static PrintSuccess(msg) {
    Con.Print(msg, new Vector(0.3, 1.0, 0.3));
  }

  static DrawInput() {
    if ((Key.dest.value !== Key.dest.console) && (Con.forcedup !== true)) {
      return;
    }
    let text = ']' + Key.edit_line + String.fromCharCode(10 + ((Host.realtime * 4.0) & 1));
    const width = (VID.width / 8) - 2;
    if (text.length >= width) {
      text = text.substring(1 + text.length - width);
    }
    Draw.String(8, Con.vislines - 16, text);
  }

  static DrawNotify() {
    const width = (VID.width / 8) - 2;
    let i = Con.text.length - 4; let v = 0;
    if (i < 0) {
      i = 0;
    }
    for (; i < Con.text.length; i++) {
      if ((Host.realtime - Con.text[i].time) > Con.notifytime.value) {
        continue;
      }
      Draw.String(8, v, Con.text[i].text.substring(0, width));
      v += 8;
    }

    v += 8;

    if (Key.dest.value === Key.dest.message) {
      Draw.String(8, v, 'say: ' + Key.chat_buffer + String.fromCharCode(10 + ((Host.realtime * 4.0) & 1)), 2.0);
    }
  }

  static DrawConsole(lines) {
    if (lines <= 0) {
      return;
    }
    lines = Math.floor(lines * VID.height * 0.005);
    Draw.ConsoleBackground(lines);
    Con.vislines = lines;
    const width = (VID.width / 8) - 2;
    let rows;
    let y = lines - 16;
    let i;
    for (i = Con.text.length - 1 - Con.backscroll; i >= 0;) {
      if (Con.text[i].text.length === 0) {
        y -= 8;
      } else {
        y -= Math.ceil(Con.text[i].text.length / width) << 3;
      }
      --i;
      if (y <= 0) {
        break;
      }
    }
    for (i++; i < Con.text.length - Con.backscroll; i++) {
      const { text, color } = Con.text[i];
      rows = Math.ceil(text.length / width);
      if (rows === 0) {
        y += 8;
        continue;
      }
      for (let j = 0; j < rows; j++) {
        Draw.String(8, y, text.substr(j * width, width), 1.0, color);
        y += 8;
      }
    }
    Con.DrawInput();
  }
}

import Vector from '../../shared/Vector.ts';
import { KeyDestination } from '../client/Key.ts';
import { eventBus, getClientRegistry, registry } from '../registry.ts';
import Cvar from './Cvar.ts';
import Cmd from './Cmd.ts';
import VID from '../client/VID.ts';
import { ClientEngineAPI } from './GameAPIs.ts';

let { CL, Draw, Host, IN, Key, SCR } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Draw, Host, IN, Key, SCR } = getClientRegistry());
});

/** A single line entry in the console text buffer. */
type ConsoleLine = {
  text: string;
  time: number;
  color: Vector;
  doNotNotify: boolean;
};

/**
 * Console output and display.
 *
 * Handles printing, notification display, and the interactive drop-down
 * console overlay used by both the browser client and dedicated server.
 */
export default class Con {
  static backscroll = 0;
  static current = 0;
  static text: ConsoleLine[] = [];
  static captureBuffer: string[] | null = null;

  /** Console notification display time. */
  static notifytime: Cvar | null = null;

  /** Used by the client to force the console to be up (there's no valid connected game). */
  static forcedup = false;

  /**
   * Whether the player has toggled the drop-down console open. Independent of `Key.destination`
   * — the console is an overlay that can appear on top of gameplay or the menu, not a peer
   * destination, and takes dispatch priority over both while open (see `Key.Event`).
   */
  static isOpen = false;

  /** Used by the client to determine how many lines to draw. */
  static vislines = 0;

  static ToggleConsole_f() {
    SCR.EndLoadingPlaque();
    Con.isOpen = !Con.isOpen;
    if (Con.isOpen) {
      // Release mouselook so the camera doesn't keep spinning from residual deltas while typing.
      IN.ReleasePointerLock();
    } else {
      // Key.edit_line = ''; // CR: this annoys me otherwise
      Key.history_line = Key.lines.length;
    }
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
    Key.destination = KeyDestination.message;
    Key.team_message = false;
  }

  static MessageMode2_f() {
    Key.destination = KeyDestination.message;
    Key.team_message = true;
  }

  static Init() {
    Con.DPrint('Console initialized.\n');

    Con.notifytime = new Cvar('con_notifytime', '3', Cvar.FLAG.ARCHIVE, 'How long to display console messages.');

    if (!registry.isDedicatedServer) {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      Cmd.AddCommand('toggleconsole', Con.ToggleConsole_f);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      Cmd.AddCommand('messagemode', Con.MessageMode_f);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      Cmd.AddCommand('messagemode2', Con.MessageMode2_f);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      Cmd.AddCommand('clear', Con.Clear_f);
    }
  }

  static StartCapturing() {
    Con.captureBuffer = [];
  }

  static StopCapturing(): string {
    const data = Con.captureBuffer!.join('\n') + '\n';
    Con.captureBuffer = null;
    return data;
  }

  static Print(msg: string, color = new Vector(1.0, 1.0, 1.0)) {
    let doNotNotify = false;

    Con.backscroll = 0;

    // CR: handle legacy color codes at the start of the message
    if (msg.charCodeAt(0) <= 3) {
      switch (msg.charCodeAt(0)) {
        case 1:
          color.set(ClientEngineAPI.IndexToRGB(47));
          break;
        case 2:
          color.set(ClientEngineAPI.IndexToRGB(95));
          break;
        case 3: // QuakeShack only
          doNotNotify = true;
          break;
      }
      msg = msg.substring(1);
    }
    for (let i = 0; i < msg.length; i++) {
      if (!Con.text[Con.current]) {
        Con.text[Con.current] = { text: '', time: Host.realtime || 0, color, doNotNotify };
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
      Con.text[Con.current].text += String.fromCharCode(msg.charCodeAt(i));
    }
  }

  static DPrint(msg: string) {
    if (!Host.developer?.value) {
      return;
    }

    Con.Print(msg, new Vector(0.7, 0.7, 1.0));
  }

  static PrintWarning(msg: string) {
    // TODO: make Con.Print make emit this as a console.warn
    Con.Print(msg, new Vector(1.0, 1.0, 0.3));
  }

  static PrintError(msg: string) {
    // TODO: make Con.Print make emit this as a console.error
    Con.Print(msg, new Vector(1.0, 0.3, 0.3));
  }

  static PrintSuccess(msg: string) {
    Con.Print(msg, new Vector(0.3, 1.0, 0.3));
  }

  static DrawInput() {
    if (!Con.isOpen) {
      return;
    }
    let text = ']' + Key.consoleDisplayText((Host.realtime * 4.0) & 1);
    const width = (VID.width / 16) - 2;
    if (text.length >= width) {
      text = text.substring(1 + text.length - width);
    }
    Draw.String(8, Con.vislines - 32, text, 2.0);
  }

  static DrawNotify() {
    const width = (VID.width / 16) - 2;

    let i = Con.text.length - 4, v = 0;

    if (i < 0) {
      i = 0;
    }

    for (; i < Con.text.length; i++) {
      if (Con.text[i].doNotNotify || (Host.realtime - Con.text[i].time) > Con.notifytime!.value) {
        continue;
      }

      Draw.String(8, v, Con.text[i].text.substring(0, width), 2.0, Con.text[i].color);
      v += 16;
    }

    v += 16;

    if (Key.destination === KeyDestination.message) {
      Draw.String(8, v, 'say: ' + Key.chatDisplayText((Host.realtime * 4.0) & 1), 2.0);
    }
  }

  static DrawConsole(lines: number) {
    if (lines <= 0) {
      return;
    }
    lines = Math.floor(lines * VID.height * 0.005);
    Draw.ConsoleBackground(lines);
    Con.vislines = lines;

    if (CL.cls.changelevel) {
      // do not draw console during level changes
      return;
    }

    const width = (VID.width / 8) - 2;
    let rows;
    let y = lines - 32;
    let i;
    for (i = Con.text.length - 1 - Con.backscroll; i >= 0;) {
      if (Con.text[i].text.length === 0) {
        y -= 16;
      } else {
        y -= Math.ceil(Con.text[i].text.length / width) << 4;
      }
      i--;
      if (y <= 0) {
        break;
      }
    }
    for (i++; i < Con.text.length - Con.backscroll; i++) {
      const { text, color } = Con.text[i];
      rows = Math.ceil(text.length / width);
      if (rows === 0) {
        y += 16;
        continue;
      }
      for (let j = 0; j < rows; j++) {
        Draw.String(8, y, text.substring(j * width, (j + 1) * width), 2.0, color);
        y += 16;
      }
    }
    Con.DrawInput();
  }
}

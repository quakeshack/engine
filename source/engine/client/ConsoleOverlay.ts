import { KeyDestination } from './Key.ts';
import Con from '../common/Console.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import VID from './VID.ts';
import { clientRuntimeState, clientStaticState } from './ClientState.ts';
import Host from '../common/Host.ts';
import Draw from './Draw.ts';
import IN from './IN.ts';
import Key from './Key.ts';
import ScreenFrame from './screen/ScreenFrame.ts';

/**
 * The console on the screen: the drop-down console with its slide, the notification lines when it is closed,
 * the input line, and whether it is open.
 */
export default class ConsoleOverlay {
  /** Used by the client to force the console to be up (there's no valid connected game). */
  static forcedup = false;

  /** How far the console has slid down, in lines: 0 is closed, 100 is open. */
  static current = 0;

  /** `scr_conspeed`: how fast the console slides, in lines per second. */
  static conspeed: Cvar = null!;

  /**
   * Whether the player has toggled the drop-down console open. Independent of `Key.destination`
   * — the console is an overlay that can appear on top of gameplay or the menu, not a peer
   * destination, and takes dispatch priority over both while open (see `Key.Event`).
   */
  static isOpen = false;

  /** Used by the client to determine how many lines to draw. */
  static vislines = 0;

  static ToggleConsole_f(): void {
    ScreenFrame.EndLoadingPlaque();
    ConsoleOverlay.isOpen = !ConsoleOverlay.isOpen;
    if (ConsoleOverlay.isOpen) {
      // Release mouselook so the camera doesn't keep spinning from residual deltas while typing.
      IN.ReleasePointerLock();
    } else {
      // Key.edit_line = ''; // CR: this annoys me otherwise
      Key.history_line = Key.lines.length;
    }
  }

  static MessageMode_f(): void {
    Key.destination = KeyDestination.message;
    Key.team_message = false;
  }

  static MessageMode2_f(): void {
    Key.destination = KeyDestination.message;
    Key.team_message = true;
  }

  static Init(): void {
    ConsoleOverlay.conspeed = new Cvar('scr_conspeed', '300');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Cmd.AddCommand('toggleconsole', ConsoleOverlay.ToggleConsole_f);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Cmd.AddCommand('messagemode', ConsoleOverlay.MessageMode_f);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Cmd.AddCommand('messagemode2', ConsoleOverlay.MessageMode2_f);
    Cmd.AddCommand('clear', () => { Con.Clear(); });
  }

  /**
   * Puts the console away at once, for a new level or a disconnect.
   */
  static Reset(): void {
    ConsoleOverlay.current = 0;
  }

  /**
   * True while the console has no business being drawn at all: there's no valid connected game
   * (so the main menu is always showing instead — see `M.CloseMenu()`) and the player hasn't
   * actively toggled the drop-down drawer open. Used by the frame to suppress the console draw call entirely in
   * that state, instead of rendering it as a full-screen backdrop behind the menu.
   * @returns True while the console should not be drawn at all.
   */
  static IsPassiveBackdrop(): boolean {
    return ConsoleOverlay.forcedup && !ConsoleOverlay.isOpen;
  }

  /**
   * Animates the console's slide height toward its target (open/closed), regardless of
   * connection state — the console is never drawn full-screen anymore (see
   * `IsPassiveBackdrop()`), so there's no special-cased snap to reach. Also decides whether the console is
   * forced up, which is when there is no connected game to show.
   */
  static Update(): void {
    ConsoleOverlay.forcedup = (!clientRuntimeState.worldmodel) || (clientStaticState.signon !== 4);

    const conlines = ConsoleOverlay.isOpen ? 100 : 0;

    if (conlines < ConsoleOverlay.current) {
      ConsoleOverlay.current -= ConsoleOverlay.conspeed.value * Host.frametime;
      if (conlines > ConsoleOverlay.current) {
        ConsoleOverlay.current = conlines;
      }
    } else if (conlines > ConsoleOverlay.current) {
      ConsoleOverlay.current += ConsoleOverlay.conspeed.value * Host.frametime;
      if (conlines < ConsoleOverlay.current) {
        ConsoleOverlay.current = conlines;
      }
    }
  }

  /**
   * Draws the console or, if it is hidden, the notify messages.
   */
  static Draw(): void {
    if (ConsoleOverlay.current > 0) {
      ConsoleOverlay.DrawConsole(ConsoleOverlay.current);
      return;
    }
    if ((Key.destination === KeyDestination.game || Key.destination === KeyDestination.message) && clientStaticState.signon === 4) {
      ConsoleOverlay.DrawNotify();
    }
  }

  static DrawInput(): void {
    if (!ConsoleOverlay.isOpen) {
      return;
    }
    let text = ']' + Key.consoleDisplayText((Host.realtime * 4.0) & 1);
    const width = (VID.width / 16) - 2;
    if (text.length >= width) {
      text = text.substring(1 + text.length - width);
    }
    Draw.String(8, ConsoleOverlay.vislines - 32, text, 2.0);
  }

  static DrawNotify(): void {
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

  static DrawConsole(lines: number): void {
    if (lines <= 0) {
      return;
    }
    lines = Math.floor(lines * VID.height * 0.005);
    Draw.ConsoleBackground(lines);
    ConsoleOverlay.vislines = lines;

    if (clientStaticState.changelevel) {
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
    ConsoleOverlay.DrawInput();
  }
}

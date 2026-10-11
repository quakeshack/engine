import Cvar from '../../common/Cvar.ts';
import { eventBus } from '../../common/EventBus.ts';
import Host from '../../common/Host.ts';
import { clientRuntimeState } from '../ClientState.ts';
import Draw from '../Draw.ts';
import Key, { KeyDestination } from '../Key.ts';
import VID from '../VID.ts';

eventBus.subscribe('server.spawning', () => {
  CenterPrint.Clear();
});

/**
 * The text the server prints in the middle of the screen (a message from the level, an intermission text), for
 * as long as it asks for. A game can draw its own from the `client.center-print` event.
 */
export default class CenterPrint {
  /** The text, wrapped at 40 characters. */
  static lines: string[] = [];

  /** Seconds the text is still shown for. */
  static timeLeft = 0.0;

  /** Client time the text was printed at, which paces the typewriter of an intermission. */
  static startTime = 0;

  /** `scr_centertime`: seconds a text is shown. */
  static centertime: Cvar = null!;

  /** `scr_printspeed`: characters per second the intermission text is typed out at. */
  static printspeed: Cvar = null!;

  /**
   * Creates the variables.
   */
  static Init(): void {
    CenterPrint.centertime = new Cvar('scr_centertime', '2');
    CenterPrint.printspeed = new Cvar('scr_printspeed', '8');
  }

  /**
   * Takes the text away at once.
   */
  static Clear(): void {
    CenterPrint.timeLeft = 0.0;
  }

  /**
   * Wraps a text into lines, shows it and starts the timer.
   * @param text The text, with newlines where the server wants them.
   */
  static Print(text: string): void {
    CenterPrint.lines = CenterPrint.#wrap(text);
    CenterPrint.timeLeft = CenterPrint.centertime.value;
    CenterPrint.startTime = clientRuntimeState.time;
    eventBus.publish('client.center-print', text);
  }

  /**
   * Draws the text, advancing the typewriter for an intermission.
   */
  static Draw(): void {
    CenterPrint.timeLeft -= Host.frametime;
    if (((CenterPrint.timeLeft <= 0.0) && (clientRuntimeState.intermission === 0)) || (Key.destination !== KeyDestination.game)) {
      return;
    }

    let y;
    if (CenterPrint.lines.length <= 4) {
      y = Math.floor(VID.height * 0.35);
    } else {
      y = 48;
    }

    let i;
    if (clientRuntimeState.intermission) {
      let remaining = Math.floor(CenterPrint.printspeed.value * (clientRuntimeState.time - CenterPrint.startTime));
      let str; let x; let j;
      for (i = 0; i < CenterPrint.lines.length; i++) {
        str = CenterPrint.lines[i];
        x = (VID.width - (str.length * 16)) / 2;
        for (j = 0; j < str.length; j++) {
          Draw.Character(x, y, str.charCodeAt(j), 2.0);
          if ((remaining--) === 0) {
            return;
          }
          x += 16;
        }
        y += 16;
      }
      return;
    }

    for (i = 0; i < CenterPrint.lines.length; i++) {
      Draw.String((VID.width - (CenterPrint.lines[i].length * 16)) / 2, y, CenterPrint.lines[i], 2.0);
      y += 16;
    }
  }

  /**
   * Formats Quake-style center text into wrapped lines.
   * @returns Wrapped lines.
   */
  static #wrap(str: string): string[] {
    const lines: string[] = [];
    let start = 0;

    for (let index = 0; index < str.length; index++) {
      if (str.charCodeAt(index) === 10) {
        lines.push(str.substring(start, index));
        start = index + 1;
        continue;
      }

      if ((index - start) >= 40) {
        lines.push(str.substring(start, index));
        start = index;
      }
    }

    lines.push(str.substring(start));
    return lines;
  }
}

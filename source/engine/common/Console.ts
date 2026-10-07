import Vector from '../../shared/Vector.ts';
import { eventBus } from './EventBus.ts';
import Cvar from './Cvar.ts';
import W from './W.ts';
import type { ConsoleCapture, ConsoleOutput } from './Services.ts';

/** A single line entry in the console text buffer. */
export interface ConsoleLine {
  text: string;
  time: number;
  color: Vector;
  doNotNotify: boolean;
}

/** What the console needs from the realm it runs in. */
export interface ConsoleDependencies {
  /** The clock lines are stamped with, in seconds. */
  readonly clock: () => number;
  /** Whether `developer` is on, which is when `DPrint` prints. */
  readonly developer: () => boolean;
}

/**
 * Console output: the text buffer everything prints to, and capturing of what a command prints so it
 * can be sent back to a remote player. One instance per realm, the default export of this module, which
 * the composition root of the realm hands its dependencies through `Init()`.
 *
 * Showing the buffer (the drop-down console, notifications) is the client's business, see
 * `client/ConsoleOverlay.ts`.
 */
export class Console {
  backscroll = 0;
  current = 0;
  text: ConsoleLine[] = [];
  captureBuffer: string[] | null = null;

  /** Console notification display time. Exists in every realm, so a configuration file that sets it is understood everywhere. */
  notifytime: Cvar | null = null;

  /** Where output goes instead of the text buffer, in a realm that has no screen of its own (a server worker). */
  #delegate: (ConsoleOutput & ConsoleCapture) | null = null;
  #clock: ConsoleDependencies['clock'] = () => 0;
  #developer: ConsoleDependencies['developer'] = () => false;

  /**
   * Hands all output over to another console, which is what a realm does whose output is shown elsewhere:
   * everything printed in a server worker is sent to the console of the page.
   * @param delegate The console to print to and capture from, `null` to print to the text buffer again.
   */
  useDelegate(delegate: (ConsoleOutput & ConsoleCapture) | null): void {
    this.#delegate = delegate;
  }

  Init(dependencies: ConsoleDependencies): void {
    this.#clock = dependencies.clock;
    this.#developer = dependencies.developer;

    this.notifytime = new Cvar('con_notifytime', '3', Cvar.FLAG.ARCHIVE, 'How long to display console messages.');

    this.DPrint('Console initialized.\n');
  }

  /**
   * Empties the text buffer.
   */
  Clear(): void {
    this.backscroll = 0;
    this.current = 0;
    this.text = [];
  }

  /**
   * Makes the last notification lines count as old, so they are not shown any more.
   */
  ClearNotify(): void {
    for (let i = Math.max(0, this.text.length - 4); i < this.text.length; i++) {
      this.text[i].time = 0.0;
    }
  }

  StartCapturing(): void {
    if (this.#delegate !== null) {
      this.#delegate.StartCapturing();
      return;
    }

    this.captureBuffer = [];
  }

  StopCapturing(): string {
    if (this.#delegate !== null) {
      return this.#delegate.StopCapturing();
    }

    const data = this.captureBuffer!.join('\n') + '\n';
    this.captureBuffer = null;
    return data;
  }

  Print(msg: string, color?: Vector): void {
    if (this.#delegate !== null) {
      this.#delegate.Print(msg, color);
      return;
    }

    const lineColor = color ?? new Vector(1.0, 1.0, 1.0);
    let doNotNotify = false;

    this.backscroll = 0;

    // CR: handle legacy color codes at the start of the message
    if (msg.charCodeAt(0) <= 3) {
      switch (msg.charCodeAt(0)) {
        case 1:
          lineColor.set(Console.#paletteColor(47));
          break;
        case 2:
          lineColor.set(Console.#paletteColor(95));
          break;
        case 3: // QuakeShack only
          doNotNotify = true;
          break;
      }
      msg = msg.substring(1);
    }
    for (let i = 0; i < msg.length; i++) {
      if (!this.text[this.current]) {
        this.text[this.current] = { text: '', time: this.#clock() || 0, color: lineColor, doNotNotify };
      }
      if (msg.charCodeAt(i) === 10) {
        const line = this.text[this.current].text;
        if (this.captureBuffer !== null) {
          this.captureBuffer.push(line);
        }
        eventBus.publish('console.print-line', line);
        if (this.text.length >= 1024) {
          this.text = this.text.slice(-512);
          this.current = this.text.length;
        } else {
          this.current++;
        }
        continue;
      }
      this.text[this.current].text += String.fromCharCode(msg.charCodeAt(i));
    }
  }

  DPrint(msg: string): void {
    if (this.#delegate !== null) {
      this.#delegate.DPrint(msg);
      return;
    }

    if (!this.#developer()) {
      return;
    }

    this.Print(msg, new Vector(0.7, 0.7, 1.0));
  }

  PrintWarning(msg: string): void {
    if (this.#delegate !== null) {
      this.#delegate.PrintWarning(msg);
      return;
    }

    // TODO: make Con.Print make emit this as a console.warn
    this.Print(msg, new Vector(1.0, 1.0, 0.3));
  }

  PrintError(msg: string): void {
    if (this.#delegate !== null) {
      this.#delegate.PrintError(msg);
      return;
    }

    // TODO: make Con.Print make emit this as a console.error
    this.Print(msg, new Vector(1.0, 0.3, 0.3));
  }

  PrintSuccess(msg: string): void {
    if (this.#delegate !== null) {
      this.#delegate.PrintSuccess(msg);
      return;
    }

    this.Print(msg, new Vector(0.3, 1.0, 0.3));
  }

  /**
   * Looks a color of the game palette up, which is what the legacy color codes at the start of a message select.
   * @returns The color with components in the range 0 to 1.
   */
  static #paletteColor(index: number): [number, number, number] {
    return [
      W.d_8to24table_u8[index * 3] / 256,
      W.d_8to24table_u8[index * 3 + 1] / 256,
      W.d_8to24table_u8[index * 3 + 2] / 256,
    ];
  }
}

export default new Console();

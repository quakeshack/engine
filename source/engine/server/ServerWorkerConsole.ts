import type { ConsoleCapture, ConsoleOutput } from '../common/Services.ts';
import type { ControlFromServer, ServerPrintLevel } from '../common/ServerWorkerProtocol.ts';
import type Vector from '../../shared/Vector.ts';

/**
 * The console of a server in a worker. Output goes to the console on the main thread, and can be
 * captured while a remote command runs, to be sent back to the one who issued it.
 */
export default class ServerWorkerConsole implements ConsoleOutput, ConsoleCapture {
  readonly #send: (message: ControlFromServer) => void;
  #captured: string[] | null = null;

  constructor(send: (message: ControlFromServer) => void) {
    this.#send = send;
  }

  Print(text: string, color?: Vector): void {
    this.#print('print', text, color);
  }

  PrintSuccess(text: string): void {
    this.#print('success', text);
  }

  PrintWarning(text: string): void {
    this.#print('warning', text);
  }

  PrintError(text: string): void {
    this.#print('error', text);
  }

  DPrint(text: string): void {
    this.#print('debug', text);
  }

  StartCapturing(): void {
    this.#captured = [];
  }

  StopCapturing(): string {
    const captured = this.#captured?.join('') ?? '';

    this.#captured = null;

    return captured;
  }

  #print(level: ServerPrintLevel, text: string, color?: Vector): void {
    if (this.#captured !== null) {
      this.#captured.push(text);
      return;
    }

    this.#send(color === undefined
      ? { kind: 'print', level, text }
      : { kind: 'print', level, text, color: [color[0], color[1], color[2]] });
  }
}

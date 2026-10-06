import type Vector from '../../shared/Vector.ts';

/** Where the server prints messages to, what the console does with them is not its business. */
export interface ConsoleOutput {
  Print(text: string, color?: Vector): void;
  DPrint(text: string): void;
  PrintWarning(text: string): void;
  PrintError(text: string): void;
  PrintSuccess(text: string): void;
}

/** Collects what the console prints while a command runs, so the output can be sent back to a remote client. */
export interface ConsoleCapture {
  StartCapturing(): void;
  StopCapturing(): string;
}

/** The platform services the engine's parts need. */
export interface SystemServices {
  Print(text: string): void;
  FloatTime(): number;
}


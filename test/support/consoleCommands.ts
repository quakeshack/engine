import type { ConsoleCommand } from '../../source/engine/common/Cmd.ts';

/**
 * Runs a console command class the way the command table does: one fresh instance, with what the caller
 * says about its context (the client it came from, whether it forwards) set on it, then `run` with the arguments.
 * @param Command The command class, as it was registered.
 * @param context What the instance knows about where it was typed.
 * @param args The arguments of the command.
 * @returns What the command returns, a promise for an asynchronous one.
 */
export function runConsoleCommand(
  Command: new () => ConsoleCommand,
  context: Partial<ConsoleCommand>,
  ...args: string[]
): void | Promise<void> {
  return Object.assign(new Command(), context).run(...args);
}

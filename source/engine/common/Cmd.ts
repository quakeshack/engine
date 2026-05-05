import type { ServerClient } from '../server/Client.ts';

import * as Protocol from '../network/Protocol.ts';
import { eventBus, getClientRegistry, getCommonRegistry, registry } from '../registry.ts';
import Cvar from './Cvar.ts';
import { clientConnectionState } from './Def.ts';

type CommandFunction = (this: ConsoleCommand, ...args: string[]) => void | Promise<void>;
type CommandConstructor = new () => ConsoleCommand;
type CommandRegistration = CommandConstructor | CommandFunction;
type CommandEntry = {
  name: string;
  command: CommandConstructor;
};
type AliasEntry = {
  name: string;
  value: string;
};

let { COM, Con } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con } = getCommonRegistry());
});

/** @returns {boolean} True when the registration is a ConsoleCommand subclass. */
function isConsoleCommandClass(command: CommandRegistration): command is CommandConstructor {
  return typeof command === 'function' && command.prototype instanceof ConsoleCommand;
}

/**
 * Console Command.
 */
export class ConsoleCommand {
  client: ServerClient | null = null;
  command: string | null = null;
  args: string | null = null;
  argv: string[] = [];

  run(..._args: string[]): void | Promise<void> {
    console.assert(false, 'ConsoleCommand.run() must be overridden');
  }

  // Forwards a console command to the server.
  // To forward a console command, use `this.forward();`.
  // NOTE: Forwarded commands must be allowlisted in `SV.ReadClientMessage`.
  forward(): boolean {
    if (this.client !== null) {
      return false;
    }

    if (registry.isDedicatedServer) {
      return true;
    }

    console.assert(this.client === null, 'must be executed locally');

    const argv = [...this.argv];
    let command = this.command;

    if (command !== null && command.toLowerCase() === 'cmd') {
      command = argv.shift() ?? null;
    }

    if (command === null) {
      Con.Print('Usage: cmd <command> <args>\n');
      return true;
    }

    const { CL } = getClientRegistry();

    if (CL.cls.state !== clientConnectionState.connected) {
      Con.Print(`Can't "${command}", not connected\n`);
      return true;
    }

    if (CL.cls.demoplayback) {
      return true;
    }

    // send command to the server in behalf of the client
    CL.cls.message.writeByte(Protocol.clc.stringcmd);
    CL.cls.message.writeString(this.args ?? '');

    return true;
  }
}

/**
 * Just the naked console command context.
 */
class AnonymousConsoleCommand extends ConsoleCommand {
  override run(): void {
    console.assert(false, 'AnonymousConsoleCommand.run() cannot be used');
  }

  override forward(): boolean {
    return false;
  }
}

class ForwardCommand extends ConsoleCommand {
  override run(): void {
    this.forward();
  }
}

class ExecSlot {
  filename: string;
  content: string | null = null;
  isReady = false;

  constructor(filename: string) {
    this.filename = filename;
  }
}

export default class Cmd {
  static alias: AliasEntry[] = [];
  static functions: CommandEntry[] = [];
  static text = '';
  static wait = false;

  static #execSlots: ExecSlot[] = [];

  static HasPendingCommands(): boolean {
    return this.wait || this.text.length > 0 || this.#execSlots.length > 0;
  }

  static Wait_f(): void {
    Cmd.wait = true;
  }

  static Execute(): void {
    // go through all pending exec slots
    while (this.#execSlots.length > 0) {
      const slot = this.#execSlots[0];

      if (!slot.isReady) {
        // as long as the first exec slot is not ready, we
        // cannot proceed with any command, we want to keep order
        return;
      }

      if (slot.content !== null) {
        Con.DPrint(`execing ${slot.filename}\n`);
        Cmd.text += slot.content;
      } else {
        Con.PrintWarning(`couldn't exec ${slot.filename}\n`);
      }

      this.#execSlots.shift();

      // if the exec caused a wait, we stop processing here
      if (Cmd.wait) {
        Cmd.wait = false;
        return;
      }
    }

    let line = '';
    let quotes = false;

    while (Cmd.text.length !== 0) {
      const character = Cmd.text[0];
      Cmd.text = Cmd.text.substring(1);

      if (character === '"') {
        quotes = !quotes;
        line += '"';
        continue;
      }

      if ((!quotes && character === ';') || character === '\n') {
        if (line.length === 0) {
          continue;
        }

        void Cmd.ExecuteString(line);

        if (Cmd.wait) {
          Cmd.wait = false;
          return;
        }

        line = '';
        continue;
      }

      line += character;
    }

    Cmd.text = '';
  }

  /**
   * Executes all console commands passed by the command line.
   */
  static StuffCmds_f(): void {
    let readingCommand = false;
    let build = '';

    for (let index = 0; index < COM.argv.length; index++) {
      const firstCharacter = COM.argv[index][0];

      if (readingCommand) {
        if (firstCharacter === '+') {
          build += `\n${COM.argv[index].substring(1)} `;
          continue;
        }

        if (firstCharacter === '-') {
          readingCommand = false;
          build += '\n';
          continue;
        }

        build += `${COM.argv[index]} `;
        continue;
      }

      if (firstCharacter === '+') {
        readingCommand = true;
        build += `${COM.argv[index].substring(1)} `;
      }
    }

    if (build.length !== 0) {
      Cmd.text = `${build}\n${Cmd.text}`;
    }
  }

  static Exec_f = class ExecConsoleCommand extends ConsoleCommand {
    override async run(filename?: string): Promise<void> {
      if (!filename) {
        Con.Print('exec <filename> : execute a script file\n');
        return;
      }

      const slot = new ExecSlot(filename);
      Cmd.#execSlots.push(slot);
      slot.content = await COM.LoadTextFile(filename);
      slot.isReady = true;
    }
  };

  static Echo_f = class EchoConsoleCommand extends ConsoleCommand {
    override run(): void {
      const args = this.args ?? '';
      Con.Print(`${args.substring(this.argv[0].length + 1)}\n`);
    }
  };

  static Alias_f(...argv: string[]): void {
    if (argv.length === 0) {
      Con.Print('Current alias commands:\n');

      for (const alias of Cmd.alias) {
        Con.Print(`${alias.name} : ${alias.value}\n`);
      }

      return;
    }

    const aliasName = argv[0].toLowerCase();
    const value = `${argv.slice(1).join(' ')}\n`;

    for (const alias of Cmd.alias) {
      if (alias.name === aliasName) {
        alias.value = value;
        return;
      }
    }

    Cmd.alias.push({ name: aliasName, value });
  }

  static Init(): void {
    Cmd.functions.length = 0;

    Cmd.AddCommand('stuffcmds', Cmd.StuffCmds_f);
    Cmd.AddCommand('exec', Cmd.Exec_f);
    Cmd.AddCommand('echo', Cmd.Echo_f);
    Cmd.AddCommand('alias', Cmd.Alias_f);
    Cmd.AddCommand('cmd', ForwardCommand);
    Cmd.AddCommand('wait', Cmd.Wait_f);
  }

  static Shutdown(): void {
    Cmd.functions.length = 0;
  }

  static TokenizeString(text: string): string[] {
    const argv: string[] = [];

    while (true) {
      let index = 0;
      let character = 0;

      for (; index < text.length; index++) {
        character = text.charCodeAt(index);

        if (character > 32 || character === 10) {
          break;
        }
      }

      if (text.charCodeAt(index) === 10 || index >= text.length) {
        break;
      }

      const parsed = COM.Parse(text);

      if (parsed.data === null) {
        break;
      }

      text = parsed.data;
      argv.push(parsed.token);
    }

    return argv;
  }

  static HasCommand(name: string): boolean {
    return Cmd.GetCommandNames().includes(name);
  }

  static GetCommandNames(): string[] {
    return Cmd.functions.map((entry) => entry.name);
  }

  static AddCommand(name: string, command: CommandRegistration): void {
    console.assert(Cvar.FindVar(name) === null, 'command name must not be taken by a cvar', name);

    if (Cmd.HasCommand(name)) {
      console.assert(false, `Cmd.AddCommand: ${name} already exists`);
      return;
    }

    if (isConsoleCommandClass(command)) {
      Cmd.functions.push({ name, command });
      return;
    }

    Cmd.functions.push({
      name,
      command: class extends ConsoleCommand {
        // if the command is a function, wrap it into a ConsoleCommand
        override run(...args: string[]): void | Promise<void> {
          return command.apply(this, args);
        }
      },
    });
  }

  static RemoveCommand(name: string): void {
    const index = Cmd.functions.findIndex((entry) => entry.name === name);

    console.assert(index !== -1, `Cmd.RemoveCommand: ${name} doesn't exist`);

    if (index === -1) {
      return;
    }

    Cmd.functions.splice(index, 1);
  }

  static CompleteCommand(partial: string): string | null {
    if (!partial) {
      return null;
    }

    return Cmd.GetCommandNames().find((name) => name.startsWith(partial)) ?? null;
  }

  static ExecuteString(text: string, client: ServerClient | null = null): void | Promise<void> {
    const argv = Cmd.TokenizeString(text);

    if (argv.length === 0) {
      return undefined;
    }

    const commandName = argv[0].toLowerCase();
    const commandArgs = argv.slice(1);

    // check commands
    for (const entry of Cmd.functions) {
      if (entry.name !== commandName) {
        continue;
      }

      const handler = new entry.command();
      handler.client = client;
      handler.args = text;
      handler.command = commandName;
      handler.argv = argv;

      const run = handler.run.bind(handler) as (...args: string[]) => void | Promise<void>;
      const result = run(...commandArgs);

      if (result instanceof Promise) {
        return result.catch((error: Error | string | null | undefined) => {
          const message = error instanceof Error ? error.message : error;
          Con.PrintError(`Error executing command "${commandName}":\n${message}\n`);
        });
      }

      return result;
    }

    for (const alias of Cmd.alias) {
      if (alias.name !== commandName) {
        continue;
      }

      Cmd.text = alias.value + Cmd.text;
      return undefined;
    }

    const context = new AnonymousConsoleCommand();
    context.client = client;
    context.args = text;
    context.command = commandName;
    context.argv = argv;

    // ask Cvar, if it knows more
    if (Cvar.Command_f.call(context, argv[0], argv[1])) {
      return undefined;
    }

    Con.Print(`Unknown command "${commandName}"\n`);

    return undefined;
  }
}

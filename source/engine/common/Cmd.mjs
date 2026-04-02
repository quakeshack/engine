import { AsyncFunction } from '../../shared/Q.ts';
import * as Protocol from '../network/Protocol.mjs';
import { eventBus, registry } from '../registry.mjs';
import Cvar from './Cvar.mjs';
import { clientConnectionState } from './Def.mjs';

let { CL, COM, Con, Host } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
});

/**
 * Console Command.
 */
export class ConsoleCommand {
  /** @type {?import('../server/Edict.mjs').ServerClient} Invoking server client. Unset, when called locally. */
  client = null;
  /** @type {string?} The name that was used to execute this command. */
  command = null;
  /** @type {string?} Full command line. */
  args = null;
  /** @type {string[]} Arguments including the name. */
  argv = [];

  /** @returns {void|Promise<void>} Hint: function can be async */
  run() {
    console.assert(false, 'ConsoleCommand.run() must be overridden');
  }

  /**
   * Forwards a console command to the server.
   * To forward a console command, use `this.forward();`.
   * NOTE: Forwarded commands must be allowlisted in `SV.ReadClientMessage`.
   * @returns {boolean} true, if forwarded
   */
  forward() {
    if (this.client !== null) {
      return false;
    }

    if (registry.isDedicatedServer) {
      return true;
    }

    console.assert(this.client === null, 'must be executed locally');

    const argv = this.argv;
    let command = this.command;

    if (command && command.toLowerCase() === 'cmd') {
      command = argv.shift() || null;
    }

    if (command === null) {
      Con.Print('Usage: cmd <command> <args>\n');
      return true;
    }

    console.assert(CL !== null, 'CL must be available');

    if (CL.cls.state !== clientConnectionState.connected) {
      Con.Print('Can\'t "' + command + '", not connected\n');
      return true;
    }

    if (CL.cls.demoplayback === true) {
      return true;
    }

    // send command to the server in behalf of the client
    CL.cls.message.writeByte(Protocol.clc.stringcmd);
    CL.cls.message.writeString(this.args);

    return true;
  }
};

/**
 * Just the naked console command context.
 */
class AnonymousConsoleCommand extends ConsoleCommand {
  run() {
    console.assert(false, 'AnonymousConsoleCommand.run() cannot be used');
  }

  forward() {
    return false;
  }
};

class ForwardCommand extends ConsoleCommand {
  run() {
    this.forward();
  }
};

class ExecSlot {
  constructor(/** @type {string} */ filename) {
    this.filename = filename;
    this.content = /** @type {string|null} */ (null);
    this.isReady = false;
  }
};

export default class Cmd {
  static alias = /** @type {{ name: string, value: string }[]} */([]);
  static functions = /** @type {{ name: string, command: typeof ConsoleCommand }[]} */([]);
  static text = '';
  static wait = false;

  static #execSlots = /** @type {ExecSlot[]} */([]);

  static HasPendingCommands() {
    return this.wait === true || this.text.length > 0 || this.#execSlots.length > 0;
  }

  static Wait_f() {
    Cmd.wait = true;
  }

  static Execute() {
    // go through all pending exec slots
    while (this.#execSlots.length > 0) {
      const slot = this.#execSlots[0];

      if (!slot.isReady) {
        // as long as the first exec slot is not ready, we
        // cannot proceed with any command, we want to keep order
        return;
      }

      if (slot.content !== null) {
        Con.DPrint('execing ' + slot.filename + '\n');
        Cmd.text += slot.content;
      } else {
        Con.PrintWarning('couldn\'t exec ' + slot.filename + '\n');
      }

      this.#execSlots.shift();

      // if the exec caused a wait, we stop processing here
      if (Cmd.wait) {
        Cmd.wait = false;
        return;
      }
    }

    let line = ''; let quotes = false;
    while (Cmd.text.length !== 0) {
      const c = Cmd.text[0];
      Cmd.text = Cmd.text.substring(1);
      if (c === '"') {
        quotes = !quotes;
        line += '"';
        continue;
      }
      if (((quotes === false) && (c === ';')) || (c === '\n')) {
        if (line.length === 0) {
          continue;
        }
        Cmd.ExecuteString(line);
        if (Cmd.wait) {
          Cmd.wait = false;
          return;
        }
        line = '';
        continue;
      }
      line += c;
    }
    Cmd.text = '';
  }

  /**
   * Executes all console commands passed by the command line.
   */
  static StuffCmds_f() {
    let s = false; let build = '';
    for (let i = 0; i < COM.argv.length; i++) {
      const c = COM.argv[i][0];
      if (s === true) {
        if (c === '+') {
          build += ('\n' + COM.argv[i].substring(1) + ' ');
          continue;
        }
        if (c === '-') {
          s = false;
          build += '\n';
          continue;
        }
        build += (COM.argv[i] + ' ');
        continue;
      }
      if (c === '+') {
        s = true;
        build += (COM.argv[i].substring(1) + ' ');
      }
    }
    if (build.length !== 0) {
      Cmd.text = build + '\n' + Cmd.text;
    }
  }

  static Exec_f = class ExecConsoleCommand extends ConsoleCommand {
    async run(filename) {
      if (!filename) {
        Con.Print('exec <filename> : execute a script file\n');
        return;
      }
      const slot = new ExecSlot(filename);
      Cmd.#execSlots.push(slot);
      const f = await COM.LoadTextFile(filename);
      slot.isReady = true;
      slot.content = f;
    }
  };

  static Echo_f = class EchoConsoleCommand extends ConsoleCommand {
    run() {
      Con.Print(`${this.args.substring(this.argv[0].length + 1)}\n`);
    }
  };

  static Alias_f(...argv) {
    if (argv.length <= 1) {
      Con.Print('Current alias commands:\n');
      for (let i = 0; i < Cmd.alias.length; i++) {
        Con.Print(Cmd.alias[i].name + ' : ' + Cmd.alias[i].value + '\n');
      }
    }
    let value = '';
    for (let i = 0; i < Cmd.alias.length; i++) {
      if (Cmd.alias[i].name === argv[1]) {
        break;
      }
    }
    for (let j = 2; j < argv.length; j++) {
      value += argv[j];
      if (j !== argv.length) {
        value += ' ';
      }
    }
    Cmd.alias.push({ name: argv[1], value: value + '\n' });
  }

  static Init() {
    Cmd.functions.length = 0;

    Cmd.AddCommand('stuffcmds', Cmd.StuffCmds_f);
    Cmd.AddCommand('exec', Cmd.Exec_f);
    Cmd.AddCommand('echo', Cmd.Echo_f);
    Cmd.AddCommand('alias', Cmd.Alias_f);
    Cmd.AddCommand('cmd', ForwardCommand);
    Cmd.AddCommand('wait', Cmd.Wait_f);
  }

  static Shutdown() {
    Cmd.functions.length = 0;
  }

  static TokenizeString(text) {
    const argv = [];
    let i; let c;
    while (true) {
      for (i = 0; i < text.length; i++) {
        c = text.charCodeAt(i);
        if ((c > 32) || (c === 10)) {
          break;
        }
      }
      if ((text.charCodeAt(i) === 10) || (i >= text.length)) {
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

  static HasCommand(name) {
    for (let i = 0; i < Cmd.functions.length; i++) {
      if (Cmd.functions[i].name === name) {
        return true;
      }
    }

    return false;
  }

  static AddCommand(name, command) {
    console.assert(Cvar.FindVar(name) === null, 'command name must not be taken by a cvar', name);

    for (let i = 0; i < Cmd.functions.length; i++) {
      if (Cmd.functions[i].name === name) {
        Con.Print('Cmd.AddCommand: ' + name + ' already defined\n');
        return;
      }
    }

    if (command.prototype instanceof ConsoleCommand) {
      Cmd.functions.push({ name: name, command: command });
    } else if (typeof command === 'function') {
      // if the command is a function, wrap it into a ConsoleCommand
      Cmd.functions.push({ name: name, command: class extends ConsoleCommand {
        run(...args) {
          command.apply(this, args);
        }
      }});
    }
  }

  static CompleteCommand(partial) {
    if (!partial) {
      return null;
    }

    for (let i = 0; i < Cmd.functions.length; i++) {
      if (Cmd.functions[i].name.startsWith(partial)) {
        return Cmd.functions[i].name;
      }
    }

    return null;
  }

  static ExecuteString(text, client = null) {
    const argv = Cmd.TokenizeString(text);

    if (argv.length === 0) {
      return;
    }

    const cmdname = argv[0].toLowerCase();
    const cmdargs = argv.slice(1);

    // check commands
    for (let i = 0; i < Cmd.functions.length; i++) {
      if (Cmd.functions[i].name === cmdname) {
        /** @type {ConsoleCommand} */
        const handler = new Cmd.functions[i].command();
        handler.client = client;
        handler.args = text;
        handler.command = cmdname;
        handler.argv = argv;

        if (handler.run instanceof AsyncFunction) {
          handler.run.apply(handler, cmdargs).catch((err) => {
            Con.PrintError(`Error executing command "${cmdname}":\n${err?.message || err}\n`);
          });
          return;
        }

        // Temporarily set Host.client for backward compatibility with commands that still use it
        const savedHostClient = Host.client;
        if (client) {
          Host.client = client;
        }
        try {
          handler.run.apply(handler, cmdargs);
        } finally {
          if (client) {
            Host.client = savedHostClient;
          }
        }
        return;
      }
    }

    // check aliases
    for (let i = 0; i < Cmd.alias.length; i++) {
      if (Cmd.alias[i].name === cmdname) {
        Cmd.text = Cmd.alias[i].value + Cmd.text;
        return;
      }
    }

    // ask Cvar, if it knows more
    const ctx = new AnonymousConsoleCommand();
    ctx.client = client;
    ctx.args = text;
    ctx.command = cmdname;
    ctx.argv = argv;

    if (Cvar.Command_f.call(ctx, argv[0], argv[1])) {
      return;
    }

    Con.Print('Unknown command "' + cmdname + '"\n');
  }
};

import MSG from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import { eventBus, registry } from '../registry.mjs';
import Cvar from './Cvar.mjs';

let { CL, COM, Con } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
});

/**
 * Console Command.
 */
export class ConsoleCommand {
  /** @type {?import('../server/Edict.mjs').ServerClient} Invoking server client. Unset, when called locally. */
  client = null;
  /** @type {string} The name that was used to execute this command. */
  command = null;
  /** @type {string} Full command line. */
  args = null;
  /** @type {string[]} Arguments including the name. */
  argv = [];

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
      command = argv.shift();
    }

    if (command === undefined) {
      Con.Print('Usage: cmd <command> <args>\n');
      return true;
    }

    console.assert(CL !== null, 'CL must be available');

    if (CL.cls.state !== CL.active.connected) {
      Con.Print('Can\'t "' + command + '", not connected\n');
      return true;
    }

    if (CL.cls.demoplayback === true) {
      return true;
    }

    // send command to the server in behalf of the client
    MSG.WriteByte(CL.cls.message, Protocol.clc.stringcmd);
    MSG.WriteString(CL.cls.message, this.args);

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

export default class Cmd {
  static alias = [];
  static functions = [];
  static text = '';
  static #wait = false;

  static Wait_f() {
    Cmd.#wait = true;
  }

  static Execute() {
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
        if (Cmd.#wait === true) {
          Cmd.#wait = false;
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

  static Exec_f(filename) {
    if (!filename) {
      Con.Print('exec <filename> : execute a script file\n');
      return;
    }
    const f = COM.LoadTextFile(filename);
    if (f === null) {
      Con.Print('couldn\'t exec ' + filename + '\n');
      return;
    }
    Con.Print('execing ' + filename + '\n');
    Cmd.text = f + Cmd.text;
  }

  static Echo_f = class EchoConsoleCommand extends ConsoleCommand {
    run() {
      Con.Print(`${this.args.substring(this.argv[0].length + 1)}\n`);
    }
  };

  static Alias_f(...argv) {
    if (argv.length <= 1) {
      Con.Print('Current alias commands:\n');
      for (let i = 0; i < Cmd.alias.length; ++i) {
        Con.Print(Cmd.alias[i].name + ' : ' + Cmd.alias[i].value + '\n');
      }
    }
    let value = '';
    for (let i = 0; i < Cmd.alias.length; ++i) {
      if (Cmd.alias[i].name === argv[1]) {
        break;
      }
    }
    for (let j = 2; j < argv.length; ++j) {
      value += argv[j];
      if (j !== argv.length) {
        value += ' ';
      }
    }
    Cmd.alias.push({ name: argv[1], value: value + '\n' });
  }

  static Init() {
    Cmd.functions = [];

    Cmd.AddCommand('stuffcmds', Cmd.StuffCmds_f);
    Cmd.AddCommand('exec', Cmd.Exec_f);
    Cmd.AddCommand('echo', Cmd.Echo_f);
    Cmd.AddCommand('alias', Cmd.Alias_f);
    Cmd.AddCommand('cmd', ForwardCommand);
    Cmd.AddCommand('wait', Cmd.Wait_f);
  }

  static Shutdown() {
    Cmd.functions = [];
  }

  static TokenizeString(text) {
    const argv = [];
    let i; let c;
    for (; ;) {
      for (i = 0; i < text.length; ++i) {
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
    for (let i = 0; i < Cmd.functions.length; ++i) {
      if (Cmd.functions[i].name === name) {
        return true;
      }
    }

    return false;
  }

  static AddCommand(name, command) {
    console.assert(Cvar.FindVar(name) === null, 'command name must not be taken by a cvar', name);

    for (let i = 0; i < Cmd.functions.length; ++i) {
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
      return;
    }

    for (let i = 0; i < Cmd.functions.length; i++) {
      if (Cmd.functions[i].name.startsWith(partial)) {
        return Cmd.functions[i].name;
      }
    }
  }

  static ExecuteString(text, client = null) {
    const argv = Cmd.TokenizeString(text);

    if (argv.length === 0) {
      return;
    }

    const cmdname = argv[0].toLowerCase();
    const cmdargs = argv.slice(1);

    // check commands
    for (let i = 0; i < Cmd.functions.length; ++i) {
      if (Cmd.functions[i].name === cmdname) {
        const handler = new Cmd.functions[i].command();
        handler.client = client;
        handler.args = text;
        handler.command = cmdname;
        handler.argv = argv;
        handler.run(...cmdargs);
        return;
      }
    }

    // check aliases
    for (let i = 0; i < Cmd.alias.length; ++i) {
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
}

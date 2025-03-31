/* global Con, COM, Cmd, Cvar, Host, CL, MSG, Protocol */

// eslint-disable-next-line no-global-assign
Cmd = {};

Cmd.alias = [];

Cmd.Wait_f = function() {
  Cmd.wait = true;
};

Cmd.text = '';

Cmd.Execute = function() {
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
      if (Cmd.wait === true) {
        Cmd.wait = false;
        return;
      }
      line = '';
      continue;
    }
    line += c;
  }
  Cmd.text = '';
};

/**
 * Executes all console commands passed by the command line.
 */
Cmd.StuffCmds_f = function() {
  let s = false; let build = '';
  for (let i = 0; i < COM.argv.length; ++i) {
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
};

Cmd.Exec_f = function(_, filename) {
  if (!filename) {
    Con.Print('exec <filename> : execute a script file\n');
    return;
  }
  const f = COM.LoadTextFile(filename);
  if (f == null) {
    Con.Print('couldn\'t exec ' + filename + '\n');
    return;
  }
  Con.Print('execing ' + filename + '\n');
  Cmd.text = f + Cmd.text;
};

Cmd.Echo_f = function(_, ...args) {
  Con.Print(`${args.join(' ')}\n`);
};

Cmd.Alias_f = function(_, ...argv) {
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
  Cmd.alias.push({name: argv[1], value: value + '\n'});
};

/** @deprecated */
Cmd.args = '';
Cmd.argv = [];
Cmd.functions = [];

Cmd.Init = function() {
  Cmd.args = '';
  Cmd.argv = [];
  Cmd.functions = [];

  Cmd.AddCommand('stuffcmds', Cmd.StuffCmds_f);
  Cmd.AddCommand('exec', Cmd.Exec_f);
  Cmd.AddCommand('echo', Cmd.Echo_f);
  Cmd.AddCommand('alias', Cmd.Alias_f);
  Cmd.AddCommand('cmd', Cmd.ForwardToServer);
  Cmd.AddCommand('wait', Cmd.Wait_f);
};

Cmd.Shutdown = function() {
  Cmd.args = '';
  Cmd.argv = [];
  Cmd.functions = [];
};

Cmd.TokenizeString = function(text) {
  const argv = [];
  let i; let c;
  for (;;) {
    for (i = 0; i < text.length; ++i) {
      c = text.charCodeAt(i);
      if ((c > 32) || (c === 10)) {
        break;
      }
    }
    if (argv.length === 1) {
      Cmd.args = text.substring(i);
    }
    if ((text.charCodeAt(i) === 10) || (i >= text.length)) {
      break;
    }
    text = COM.Parse(text);
    if (text == null) {
      break;
    }
    argv.push(COM.token);
  }
  return argv;
};

Cmd.HasCommand = function(name) {
  for (let i = 0; i < Cmd.functions.length; ++i) {
    if (Cmd.functions[i].name === name) {
      return true;
    }
  }

  return false;
};

Cmd.AddCommand = function(name, command) {
  console.assert(Cvar.FindVar(name) === null, 'command name must not be taken by a cvar', name);

  for (let i = 0; i < Cmd.functions.length; ++i) {
    if (Cmd.functions[i].name === name) {
      Con.Print('Cmd.AddCommand: ' + name + ' already defined\n');
      return;
    }
  }

  Cmd.functions.push({name: name, command: command});
};

Cmd.CompleteCommand = function(partial) {
  if (partial.length === 0) {
    return;
  }
  let i;
  for (i = 0; i < Cmd.functions.length; ++i) {
    if (Cmd.functions[i].name.substring(0, partial.length) === partial) {
      return Cmd.functions[i].name;
    }
  }
};

Cmd.ExecuteString = function(text, client = false) {
  Cmd.client = client;
  Cmd.argv = Cmd.TokenizeString(text);
  if (Cmd.argv.length === 0) {
    return;
  }
  const name = Cmd.argv[0].toLowerCase();
  for (let i = 0; i < Cmd.functions.length; ++i) {
    if (Cmd.functions[i].name === name) {
      Cmd.functions[i].command(...Cmd.argv);
      return;
    }
  }
  for (let i = 0; i < Cmd.alias.length; ++i) {
    if (Cmd.alias[i].name === name) {
      Cmd.text = Cmd.alias[i].value + Cmd.text;
      return;
    }
  }
  if (!Cvar.Command(...Cmd.argv)) {
    Con.Print('Unknown command "' + name + '"\n');
  }
};

Cmd.ForwardToServer = function(command, ...argv) {
  if (Host.dedicated.value) {
    return;
  }
  if (command && command.toLowerCase() === 'cmd') {
    command = argv.shift();
  }
  if (command === undefined) {
    Con.Print('Usage: cmd <command> <args>\n');
    return;
  }
  if (CL.cls.state !== CL.active.connected) {
    Con.Print('Can\'t "' + command + '", not connected\n');
    return;
  }
  if (CL.cls.demoplayback === true) {
    return;
  }
  argv.unshift(command);
  // FIXME: turn into a proper separate message to process
  MSG.WriteByte(CL.cls.message, Protocol.clc.stringcmd);
  MSG.WriteString(CL.cls.message, argv.join(' ') + '\n');
};

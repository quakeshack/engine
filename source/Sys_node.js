const { argv } = require('node:process');
const repl = require('repl');

Sys = class Sys {
  static Init() {
    COM.InitArgv(argv);

    Sys.oldtime = Date.now() * 0.001;

    Sys.Print('Host.Init\n');
    Host.Init(true);

    // Start a REPL instance
    Sys.repl = repl.start({
      'prompt': '] ',
      eval: function(command) {
        this.clearBufferedCommand();
        Cmd.ExecuteString(command);
        this.displayPrompt();
      },
      completer: function(line) {
        const completions = [];

        for (const fnc of Cmd.functions) {
          completions.push(fnc.name);
        }

        for (const cvar of Cvar.vars) {
          completions.push(cvar.name);
        }

        const hits = completions.filter((c) => c.startsWith(line));

        return [hits.length ? hits : completions, line];
      }
    });

    Sys.repl.on('exit', function() {
      Sys.Quit();
    });

    Sys.frame = setInterval(Host.Frame, 1000.0 / 60.0);
  }

  static Quit() {
    if (Sys.frame != null) {
      clearInterval(Sys.frame);
    }

    Host.Shutdown();

    process.exit(0);
  }

  static Print(text) {
    console.info(new String(text).trim());
  }

  static Error(text) {
    if (Sys.frame != null) {
      clearInterval(Sys.frame);
    }

    if (Host.initialized === true) {
      Host.Shutdown();
    }

    for (let i; i < Con.text.length; ++i) {
      console.info(Con.text[i].text);
    }

    console.error(text);

    throw new Error(text);
  };

  static FloatTime() {
    return Date.now() * 0.001 - Sys.oldtime;
  };
};

const {argv} = require('node:process');
const repl = require('repl');

/**
 * System class to manage initialization, quitting, and REPL functionality.
 */
Sys = class Sys {
  /**
   * Initializes the low-level system.
   */
  static Init() {
    // Initialize command-line arguments
    COM.InitArgv(argv);

    // Record the initial time
    Sys.oldtime = Date.now() * 0.001;

    Sys.Print('Host.Init\n');
    Host.Init(true);

    // Start a REPL instance
    Sys.repl = repl.start({
      prompt: '] ',
      eval(command, context, filename, callback) {
        this.clearBufferedCommand();
        Cmd.ExecuteString(command);
        this.displayPrompt();
        callback();
      },
      completer(line) {
        const completions = [
          ...Cmd.functions.map((fnc) => fnc.name),
          ...Cvar.vars.map((cvar) => cvar.name),
        ];

        const hits = completions.filter((c) => c.startsWith(line));
        return [hits.length ? hits : completions, line];
      },
    });

    Sys.repl.on('exit', () => Sys.Quit());

    // Set up a frame interval for the main loop
    Sys.frame = setInterval(Host.Frame, 1000.0 / 60.0);
  }

  /**
   * Handles quitting the system gracefully.
   */
  static Quit() {
    if (Sys.frame != null) {
      clearInterval(Sys.frame);
    }

    Host.Shutdown();
    process.exit(0);
  }

  /**
   * Prints a message to the console.
   * @param {string} text - The text to print.
   */
  static Print(text) {
    console.info(String(text).trim());
  }

  /**
   * Handles errors, shuts down the host, and exits the process.
   * @param {string} text - The error message.
   */
  static Error(text) {
    if (Sys.frame != null) {
      clearInterval(Sys.frame);
    }

    if (Host.initialized === true) {
      Host.Shutdown();
    }

    // Print all console text
    for (const line of Con.text) {
      console.info(line.text);
    }

    console.error(text);

    throw new Error(text);
  }

  /**
   * Returns the time elapsed since initialization.
   * @return {number} - Elapsed time in seconds.
   */
  static FloatTime() {
    return Date.now() * 0.001 - Sys.oldtime;
  }
};


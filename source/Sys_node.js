// eslint-disable-next-line no-unused-vars
/* global Sys, Con, COM, Host, Cmd, Cvar, NET, __dirname, Buffer */

const {argv, stdout, exit} = require('node:process');
const repl = require('repl');

const express = require('express');
const path = require('path');
const http = require('http');

/**
 * System class to manage initialization, quitting, and REPL functionality.
 */
// eslint-disable-next-line no-global-assign
Sys = class Sys {
  /**
   * Initializes the low-level system.
   */
  static Init() {
    // Initialize command-line arguments
    COM.InitArgv(argv);

    // Configure Console output
    Con.OnLinePrint = function(line) {
      console.info(line);
    };

    // Record the initial time
    Sys.oldtime = Date.now() * 0.001;

    // Start webserver
    Sys.StartWebserver();

    Sys.Print('Host.Init\n');
    Host.Init(true);

    // Start a REPL instance (if stdout is a TTY)
    if (stdout && stdout.isTTY) {
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
    }

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
    exit(0);
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

  static StartWebserver() {
    const app = express();

    const basepath = COM.GetParm('-basepath') || '';

    console.log('basepath', basepath);

    if (basepath !== '') {
      app.use(basepath, express.static(path.join(__dirname + '/..', 'public')));
      app.use(basepath + '/data', express.static(path.join(__dirname + '/..', 'data')));
      app.use(basepath + '/source', express.static(path.join(__dirname + '/..', 'source')));
    } else {
      app.use(express.static(path.join(__dirname + '/..', 'public')));
      app.use('/data', express.static(path.join(__dirname + '/..', 'data')));
      app.use('/source', express.static(path.join(__dirname + '/..', 'source')));
    }

    const skipChars = (basepath + '/quakefs/').length;
    app.get(basepath + '/quakefs/*', async (req, res) => {
      try {
        // Remove the leading "/data/" to get the relative filename
        // e.g. "/data/id1/progs/player.mdl" -> "id1/progs/player.mdl"
        const requestedPath = req.path.substring(skipChars);

        const fileData = await COM.LoadFileAsync(requestedPath);

        if (!fileData) {
          // File not found or empty result
          return res.status(404).send('File not found');
        }

        // Set headers and send the file data
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=86400');

        // Convert ArrayBuffer -> Buffer before sending
        return res.send(Buffer.from(fileData));
      } catch (error) {
        console.error('Error serving file:', error);
        return res.status(500).send('Internal Server Error');
      }
    });

    const server = http.createServer(app);
    const port = COM.GetParm('-port') || 3000;

    server.listen(port, () => {
      Sys.Print(`Webserver listening on port ${port}\n`);

      NET.server = server;
    });
  }
};


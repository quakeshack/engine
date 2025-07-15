/* global Buffer */

import { argv, stdout, exit } from 'node:process';
import { start } from 'repl';

import express from 'express';
import { join } from 'path';
import { createServer } from 'http';

import { registry, eventBus } from '../registry.mjs';
import Cvar from './Cvar.mjs';
import { REPLServer } from 'node:repl';
import Cmd from './Cmd.mjs';

let { COM, Host, NET } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Host = registry.Host;
  NET = registry.NET;
});

/**
 * System class to manage initialization, quitting, and REPL functionality.
 */
export default class Sys {
  static #oldtime = 0;
  static #frame = null;

  /** @type {REPLServer} */
  static #repl = null;

  /**
   * Initializes the low-level system.
   */
  static async Init() {
    // Initialize command-line arguments
    COM.InitArgv(argv);

    eventBus.subscribe('console.print-line', (line) => {
      console.info(line);
    });

    // Record the initial time
    Sys.#oldtime = Date.now() * 0.001;

    // Start webserver
    Sys.StartWebserver();

    Sys.Print('Host.Init\n');
    await Host.Init(true);

    // Start a REPL instance (if stdout is a TTY)
    if (stdout && stdout.isTTY) {
      Sys.#repl = start({
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
            ...Object.keys(Cvar._vars).map((cvar) => cvar), // FIXME: Cvar._vars is private, should not be accessed directly
          ];

          const hits = completions.filter((c) => c.startsWith(line));
          return [hits.length ? hits : completions, line];
        },
      });

      Sys.#repl.on('exit', () => Sys.Quit());
    }

    // Set up a frame interval for the main loop
    Sys.#frame = setInterval(Host.Frame, 1000.0 / 60.0);
  }

  /**
   * Handles quitting the system gracefully.
   */
  static Quit() {
    if (Sys.#frame !== null) {
      clearInterval(Sys.#frame);
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
   * Returns the time elapsed since initialization.
   * @returns {number} - Elapsed time in seconds.
   */
  static FloatTime() {
    return Date.now() * 0.001 - Sys.#oldtime;
  }

  /** @private */
  static StartWebserver() {
    const app = express();

    const basepath = COM.GetParm('-basepath') || '';

    const __dirname = import.meta.dirname;

    if (basepath !== '') {
      app.use(basepath, express.static(join(__dirname + '/..', 'public')));
      app.use(basepath + '/data', express.static(join(__dirname + '/..', 'data')));
      app.use(basepath + '/source', express.static(join(__dirname + '/..', 'source')));
    } else {
      app.use(express.static(join(__dirname + '/..', 'public')));
      app.use('/data', express.static(join(__dirname + '/..', 'data')));
      app.use('/source', express.static(join(__dirname + '/..', 'source')));
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
        res.setHeader('Cache-Control', Host.developer.value ? 'private, max-age=0' : 'public, max-age=86400');

        // Convert ArrayBuffer -> Buffer before sending
        return res.send(Buffer.from(fileData));
      } catch (error) {
        console.error('Error serving file:', error);
        return res.status(500).send('Internal Server Error');
      }
    });

    const server = createServer(app);
    const port = COM.GetParm('-port') || 3000;

    server.listen(port, () => {
      Sys.Print(`Webserver listening on port ${port}\n`);

      NET.server = server;
    });
  }
};


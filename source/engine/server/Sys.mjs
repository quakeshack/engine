/* global Buffer */

import { argv, stdout, exit } from 'node:process';
import { start } from 'repl';

import express from 'express';
import { join } from 'path';
import { createServer } from 'http';

import { registry, eventBus } from '../registry.mjs';
import Cvar from '../common/Cvar.ts';
/** @typedef {import('node:repl').REPLServer} REPLServer */
import Cmd from '../common/Cmd.ts';
import Q from '../../shared/Q.ts';
import WorkerManager from '../common/WorkerManager.ts';
import workerFactories from '../common/WorkerFactories.ts';

let { COM, Host, NET } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Host = registry.Host;
  NET = registry.NET;
});

eventBus.subscribe('host.crash', (e) => {
  console.error(e);
  exit(1);
});

const mainLoop = {
  _resolve: null,
  sleep() {
    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  },
  notify() {
    if (this._resolve) {
      this._resolve();
      this._resolve = null;
    }
  },
};

eventBus.subscribe('net.connection.accepted', () => {
  mainLoop.notify();
});

/**
 * System class to manage initialization, quitting, and REPL functionality.
 */
export default class Sys {
  static #oldtime = 0;
  static #isRunning = false;

  /** @type {REPLServer} */
  static #repl = null;

  /**
   * Initializes the low-level system.
   */
  static async Init() {
    // Initialize command-line arguments
    COM.InitArgv(argv);

    eventBus.subscribe('console.print-line', (line) => {
      stdout.write(line + '\n');
    });

    // Record the initial time
    Sys.#oldtime = Date.now() * 0.001;

    // Start worker manager
    WorkerManager.Init(workerFactories);

    // Start webserver
    await Sys.StartWebserver();

    Sys.Print('Host.Init\n');
    await Host.Init();

    // Start a REPL instance (if stdout is a TTY)
    if (stdout && stdout.isTTY) {
      Sys.#repl = start({
        prompt: '] ',
        eval(command, context, filename, callback) {
          mainLoop.notify();
          this.clearBufferedCommand();
          Cmd.text += command;
          setTimeout(() => callback(null), 20); // we have to wait at least one frame before expecting a result
        },
        completer(line) {
          const completions = [
            ...Cmd.GetCommandNames(),
            ...Cvar.GetVariableNames(),
          ];

          const hits = completions.filter((c) => c.startsWith(line));
          return [hits.length ? hits : completions, line];
        },
      });

      Sys.#repl.on('exit', () => Sys.Quit());
    }

    Sys.#isRunning = true;

    if (Host.refreshrate.value === 0) {
      Host.refreshrate.set(60);
    }

    // Main loop
    while (Sys.#isRunning) {
      const startTime = Date.now();

      await Host.Frame();

      const dtime = Date.now() - startTime;

      if (dtime > 100) {
        Sys.Print(`Host.Frame took too long: ${dtime} ms\n`);
      }

      await Q.sleep(Math.max(0, 1000.0 / Math.min(300, Math.max(60, Host.refreshrate.value)) - dtime));

      // when there are no more commands to process and no active connections, we can sleep indefinitely
      if (NET.activeconnections === 0 && Host._scheduledForNextFrame.length === 0 && !Cmd.HasPendingCommands()) {
        await mainLoop.sleep();
      }
    }
  }

  /**
   * Handles quitting the system gracefully.
   */
  static Quit() {
    Sys.#isRunning = false;

    Host.Shutdown();
    Sys.Print('Sys.Quit: exitting process\n');
    exit(0);
  }

  /**
   * Prints a message to the console.
   * @param {string} text - The text to print.
   */
  static Print(text) {
    stdout.write(String(text).trim() + '\n');
  }

  /**
   * Returns the time elapsed since initialization.
   * @returns {number} - Elapsed time in seconds.
   */
  static FloatTime() {
    return Date.now() * 0.001 - Sys.#oldtime;
  }

  /**
   * Returns the time elapsed since initialization in milliseconds.
   * @returns {number} - Elapsed time in milliseconds.
   */
  static FloatMilliTime() {
    return performance.now();
  }

  /** @private */
  static async StartWebserver() {
    if (COM.CheckParm('-noserver')) {
      Sys.Print('Webserver disabled via -noserver\n');
      return;
    }

    const app = express();

    const basepath = COM.GetParm('-basepath') || '';

    const listenPort = COM.GetParm('-port') || 3000;
    const listenAddress = COM.GetParm('-ip');

    Sys.Print(`Webserver will listen on ${listenAddress || 'all interfaces'} on port ${listenPort}\n`);

    const __dirname = import.meta.dirname + '/../..';

    const distHeaders = (res) => {
      res.set('Cross-Origin-Opener-Policy', 'same-origin');
      res.set('Cross-Origin-Embedder-Policy', 'require-corp');
    };

    if (basepath !== '') {
      app.use(basepath, express.static(join(__dirname + '/..', 'dist/browser'), { setHeaders: distHeaders }));
      app.use(basepath + '/data', express.static(join(__dirname + '/..', 'data')));
      app.use(basepath + '/source', express.static(join(__dirname + '/..', 'source')));
    } else {
      app.use(express.static(join(__dirname + '/..', 'dist/browser'), { setHeaders: distHeaders }));
      app.use('/data', express.static(join(__dirname + '/..', 'data')));
      app.use('/source', express.static(join(__dirname + '/..', 'source')));
    }

    const skipChars = (basepath + '/qfs/').length;
    app.get(basepath + '/qfs/*', async (req, res) => {
      try {
        // Remove the leading "/data/" to get the relative filename
        // e.g. "/data/id1/progs/player.mdl" -> "id1/progs/player.mdl"
        const requestedPath = req.path.substring(skipChars);

        const fileData = await COM.LoadFile(requestedPath);

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

    await new Promise((resolve, reject) => {
      server.once('error', (error) => {
        if ('code' in error && error.code === 'EADDRINUSE') {
          reject(new Error(`Webserver failed to start: port ${listenPort} is already in use`, { cause: error }));
          return;
        }

        reject(new Error('Webserver failed to start', { cause: error }));
      });

      server.listen({
        port: listenPort,
        host: listenAddress || undefined,
      }, () => {
        Sys.Print(`Webserver listening on port ${listenPort} (${listenAddress || 'all interfaces'})\n`);

        NET.server = server;
        resolve();
      });
    });
  }
};


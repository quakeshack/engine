/* global Buffer */

import type { AddressInfo } from 'node:net';
import type { REPLEval } from 'node:repl';
import { argv, stdout, exit } from 'node:process';
import { start } from 'repl';

import express from 'express';
import { join } from 'path';
import { createServer } from 'http';

import { eventBus, getCommonRegistry } from '../registry.ts';
import Cvar from '../common/Cvar.ts';
import Cmd from '../common/Cmd.ts';
import Q from '../../shared/Q.ts';
import BaseSys from '../common/Sys.ts';
import WorkerManager from '../common/WorkerManager.ts';
import workerFactories from '../common/WorkerFactories.ts';

type MainLoopResolver = (() => void) | null;
type CrashReason =
  | Error
  | string
  | null
  | undefined
  | {
      readonly name?: string;
      readonly message?: string;
      readonly constructor?: { readonly name?: string };
    };

let { COM, Host, NET } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Host, NET } = getCommonRegistry());
});

eventBus.subscribe('host.crash', (error: CrashReason) => {
  console.error(error);
  exit(1);
});

class MainLoop {
  static #resolve: MainLoopResolver = null;

  static sleep(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
  }

  static notify(): void {
    if (this.#resolve !== null) {
      this.#resolve();
      this.#resolve = null;
    }
  }
}

const evaluateReplCommand: REPLEval = function(command, _context, _filename, callback): void {
  MainLoop.notify();
  this.clearBufferedCommand();
  Cmd.text += command;
  setTimeout(() => callback(null), 20); // we have to wait at least one frame before expecting a result
};

eventBus.subscribe('net.connection.accepted', () => {
  MainLoop.notify();
});

/**
 * System class to manage initialization, quitting, and REPL functionality.
 */
export default class Sys extends BaseSys {
  static #oldtime = 0;
  static #isRunning = false;

  /**
   * Initializes the low-level system.
   */
  static override async Init(): Promise<void> {
    // Initialize command-line arguments
    COM.InitArgv(argv);

    eventBus.subscribe('console.print-line', (line: string) => {
      stdout.write(line + '\n');
    });

    // Record the initial time
    Sys.#oldtime = Date.now() * 0.001;

    // Start worker manager
    WorkerManager.Init(workerFactories);

    // Start webserver
    await Sys.#startWebserver();

    Sys.Print('Host.Init\n');
    await Host.Init();

    // Start a REPL instance (if stdout is a TTY)
    if (stdout && stdout.isTTY) {
      const repl = start({
        prompt: '] ',
        eval: evaluateReplCommand,
        completer(line: string): [string[], string] {
          const completions = [
            ...Cmd.GetCommandNames(),
            ...Cvar.GetVariableNames(),
          ];

          const hits = completions.filter((c) => c.startsWith(line));
          return [hits.length ? hits : completions, line];
        },
      });

      repl.on('exit', () => Sys.Quit());
    }

    // eslint-disable-next-line require-atomic-updates
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
        await MainLoop.sleep();
      }
    }
  }

  /**
   * Handles quitting the system gracefully.
   */
  static override Quit(): never {
    Sys.#isRunning = false;

    Host.Shutdown();
    Sys.Print('Sys.Quit: exitting process\n');
    exit(0);
  }

  /**
   * Prints a message to the console.
   */
  static override Print(text: string): void {
    stdout.write(String(text).trim() + '\n');
  }

  /**
   * Returns the time elapsed since initialization.
   * @returns The elapsed time in seconds.
   */
  static override FloatTime(): number {
    return Date.now() * 0.001 - Sys.#oldtime;
  }

  /**
   * Returns the time elapsed since initialization in milliseconds.
   * @returns The elapsed time in milliseconds.
   */
  static override FloatMilliTime(): number {
    return performance.now();
  }

  /**
   * Starts the dedicated server web frontend.
   */
  static async #startWebserver(): Promise<void> {
    if (COM.CheckParm('-noserver')) {
      Sys.Print('Webserver disabled via -noserver\n');
      return;
    }

    const app = express();

    const basepath = COM.GetParm('-basepath') || '';

    const listenPort = Number(COM.GetParm('-port') || 3000);
    const listenAddress = COM.GetParm('-ip');

    Sys.Print(`Webserver will listen on ${listenAddress || 'all interfaces'} on port ${listenPort}\n`);

    const __dirname = import.meta.dirname + '/../..';

    const distHeaders = (res: express.Response): void => {
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
    app.get(basepath + '/qfs/*', async (req: express.Request, res: express.Response) => {
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

    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
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
        const address = server.address() as AddressInfo | string | null;
        const boundAddress = typeof address === 'object' && address !== null ? address.address : (listenAddress || 'all interfaces');

        Sys.Print(`Webserver listening on port ${listenPort} (${boundAddress})\n`);

        NET.server = server;
        resolve();
      });
    });
  }
}



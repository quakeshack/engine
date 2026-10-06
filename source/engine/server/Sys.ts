/* global Buffer */

import type { AddressInfo } from 'node:net';
import type { REPLEval } from 'node:repl';
import { argv, stdout, exit } from 'node:process';
import { start } from 'repl';

import express from 'express';
import { join } from 'path';
import { createServer } from 'http';

import { eventBus } from '../common/EventBus.ts';
import Cvar from '../common/Cvar.ts';
import Cmd from '../common/Cmd.ts';
import Q from '../../shared/Q.ts';
import type COM from '../common/Com.ts';
import type Host from '../common/Host.ts';
import type NET from '../network/Network.ts';
import type { SystemServices } from '../common/Services.ts';
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
  setTimeout(() => { callback(null, undefined); }, 20); // we have to wait at least one frame before expecting a result
};

eventBus.subscribe('net.connection.accepted', () => {
  MainLoop.notify();
});

/**
 * System class to manage initialization, quitting, and REPL functionality.
 */
/** What the dedicated system services drive. */
export interface DedicatedSysDependencies {
  /** The file system, looked up when needed because it is built with these services. */
  readonly com: () => COM;
  readonly host: typeof Host;
  /** The network layer, looked up when needed because it is built with these services. */
  readonly net: () => NET;
}

/**
 * System services of a dedicated server: the main loop, the web server, the REPL and the clock.
 */
export default class DedicatedSys implements SystemServices {
  readonly #dependencies: DedicatedSysDependencies;
  #oldtime = 0;
  #isRunning = false;

  constructor(dependencies: DedicatedSysDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Initializes the low-level system.
   */
  async Init(): Promise<void> {
    // Initialize command-line arguments
    this.#dependencies.com().InitArgv(argv);

    eventBus.subscribe('console.print-line', (line: string) => {
      stdout.write(line + '\n');
    });

    // Record the initial time
    this.#oldtime = Date.now() * 0.001;

    // Start worker manager
    WorkerManager.Init(workerFactories);

    // Start webserver
    await this.#startWebserver();

    this.Print('Host.Init\n');
    await this.#dependencies.host.Init();

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

      repl.on('exit', () => this.Quit());
    }

    // eslint-disable-next-line require-atomic-updates
    this.#isRunning = true;

    if (this.#dependencies.host.refreshrate!.value === 0) {
      this.#dependencies.host.refreshrate!.set(60);
    }

    // Main loop
    while (this.#isRunning) {
      const startTime = Date.now();

      await this.#dependencies.host.Frame();

      const dtime = Date.now() - startTime;

      if (dtime > 100) {
        this.Print(`Host.Frame took too long: ${dtime} ms\n`);
      }

      await Q.sleep(Math.max(0, 1000.0 / Math.min(300, Math.max(60, this.#dependencies.host.refreshrate!.value)) - dtime));

      // when there are no more commands to process and no active connections, we can sleep indefinitely
      if (this.#dependencies.net().activeconnections === 0 && this.#dependencies.host._scheduledForNextFrame.length === 0 && !Cmd.HasPendingCommands()) {
        await MainLoop.sleep();
      }
    }
  }

  /**
   * Handles quitting the system gracefully.
   */
  Quit(): never {
    this.#isRunning = false;

    this.#dependencies.host.Shutdown();
    this.Print('Sys.Quit: exitting process\n');
    exit(0);
  }

  /**
   * Prints a message to the console.
   */
  Print(text: string): void {
    stdout.write(text.trim() + '\n');
  }

  /**
   * Returns the time elapsed since initialization.
   * @returns The elapsed time in seconds.
   */
  FloatTime(): number {
    return Date.now() * 0.001 - this.#oldtime;
  }

  /**
   * Returns the time elapsed since initialization in milliseconds.
   * @returns The elapsed time in milliseconds.
   */
  FloatMilliTime(): number {
    return performance.now();
  }

  /**
   * Starts the dedicated server web frontend.
   */
  async #startWebserver(): Promise<void> {
    if (this.#dependencies.com().CheckParm('-noserver')) {
      this.Print('Webserver disabled via -noserver\n');
      return;
    }

    const app = express();

    const basepath = this.#dependencies.com().GetParm('-basepath') || '';

    const listenPort = Number(this.#dependencies.com().GetParm('-port') || 3000);
    const listenAddress = this.#dependencies.com().GetParm('-ip');

    this.Print(`Webserver will listen on ${listenAddress || 'all interfaces'} on port ${listenPort}\n`);

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

        const fileData = await this.#dependencies.com().LoadFile(requestedPath);

        if (!fileData) {
          // File not found or empty result
          return res.status(404).send('File not found');
        }

        // Set headers and send the file data
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', this.#dependencies.host.developer!.value ? 'private, max-age=0' : 'public, max-age=86400');

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

        this.Print(`Webserver listening on port ${listenPort} (${boundAddress})\n`);

        this.#dependencies.net().server = server;
        resolve();
      });
    });
  }
}



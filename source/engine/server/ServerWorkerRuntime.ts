import type { ServerSaveResult, ServerSaveState, ServerStateMirror, ViewthingState } from '../common/ServerController.ts';
import type { ControlFromServer, ControlToServer, CvarDescription, ServerRequest, ServerResponseValue } from '../common/ServerWorkerProtocol.ts';

import { HostError } from '../common/Errors.ts';

/** What the runtime asks of the server host. */
export interface ServerWorkerHostControls {
  simulationAllowed: boolean;
  StartMap(mapname: string): Promise<boolean>;
  AnnounceChangelevel(mapname: string): void;
  Changelevel(mapname: string): Promise<boolean>;
  ShutdownServer(isCrashShutdown?: boolean): void;
  getViewthing(): ViewthingState | null;
  setViewthingFrame(frame: number): void;
}

/** What the page's console reaches in the realm of the server. */
export interface ServerWorkerConsoleControls {
  /** Lists the cvars and commands the page has to know about. */
  describe(): { readonly cvars: CvarDescription[]; readonly commands: string[] };
  /** Applies a variable the page changed. */
  setCvar(name: string, value: string): void;
  /** Runs a line the player typed. */
  execute(text: string, operator: string): void;
}

/** Saving and loading the server's half of a game. */
export interface ServerWorkerSavegameControls {
  capture(): ServerSaveResult;
  restore(state: ServerSaveState, source: string): Promise<void>;
}

/** What a `ServerWorkerRuntime` is built from. */
export interface ServerWorkerRuntimeDependencies {
  /** Sends a control message to the main thread. */
  readonly send: (message: ControlFromServer) => void;
  /** Reads the facts about the server the main thread mirrors. */
  readonly readState: () => ServerStateMirror;
  readonly host: ServerWorkerHostControls;
  readonly console: ServerWorkerConsoleControls;
  readonly savegame: ServerWorkerSavegameControls;
  /** Runs one frame of the realm: scheduled work, console commands and the server's turn. */
  readonly frame: () => Promise<void>;
  /** Seconds after which a frame runs even though nothing happened, `0` to never. */
  readonly fallbackInterval: () => number;
  /** Whether a server is running, which is when the fallback frames are due. */
  readonly isServerActive: () => boolean;
}

/**
 * Drives a server in a worker: answers the main thread's requests, runs a server frame whenever
 * something arrives (a command of the local player is the common case), keeps a timer running as a
 * fallback so remote players and an idle local one do not stall the world, and keeps the state the
 * main thread mirrors up to date.
 *
 * It knows nothing about threads, it talks through the `send` it is given and is fed through
 * `handle()`, so it runs in a test just as well.
 */
export default class ServerWorkerRuntime {
  readonly #deps: ServerWorkerRuntimeDependencies;
  #requests: Promise<void> = Promise.resolve();
  #busy = 0;
  #framing = false;
  #rerun = false;
  #dead = false;
  #lastState: ServerStateMirror | null = null;
  #lastFrameAt = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(dependencies: ServerWorkerRuntimeDependencies) {
    this.#deps = dependencies;
  }

  /**
   * Starts the fallback timer and tells the main thread that the worker is ready.
   */
  start(): void {
    this.#timer = setInterval(() => { this.#onTimer(); }, 10);
    this.#publishState();
    this.#deps.send({ kind: 'ready', ...this.#deps.console.describe() });
  }

  /**
   * Stops the runtime for good; whatever arrives later is ignored.
   */
  stop(): void {
    this.#dead = true;

    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Handles a control message of the main thread.
   * @param message What the main thread sent.
   */
  handle(message: ControlToServer): void {
    if (this.#dead) {
      return;
    }

    switch (message.kind) {
      case 'simulation-allowed':
        this.#deps.host.simulationAllowed = message.allowed;
        break;

      case 'cvar-set':
        this.#deps.console.setCvar(message.name, message.value);
        break;

      case 'command':
        this.#deps.console.execute(message.text, message.operator);
        this.requestFrame();
        break;

      case 'request': {
        const { id, request } = message;

        // Requests run one after the other, in the order they were made.
        this.#requests = this.#requests.then(async () => { await this.#perform(id, request); });
        break;
      }

      default:
        break;
    }
  }

  /**
   * Asks for a server frame as soon as nothing else is going on. Calls that come in while a frame
   * or a request is in progress are folded into one more frame afterwards.
   */
  requestFrame(): void {
    if (this.#dead) {
      return;
    }

    if (this.#framing || this.#busy > 0) {
      this.#rerun = true;
      return;
    }

    void this.#runFrames();
  }

  /**
   * Reports a failure from outside the runtime's own work, e.g. a helper worker, and stops the runtime.
   * @param error What went wrong.
   */
  fail(error: unknown): void {
    this.#crash(error);
  }

  async #runFrames(): Promise<void> {
    this.#framing = true;

    try {
      do {
        this.#rerun = false;
        this.#lastFrameAt = performance.now();
        await this.#deps.frame();
        this.#publishState();
      } while (this.#rerun && this.#busy === 0 && !this.#dead);
    } catch (error) {
      this.#failFrame(error);
    } finally {
      this.#framing = false;
    }
  }

  async #perform(id: number, request: ServerRequest): Promise<void> {
    this.#busy++;

    try {
      const result = await this.#execute(request);

      this.#publishState();
      this.#deps.send({ kind: 'response', id, ok: true, result });
    } catch (error) {
      this.#publishState();

      if (error instanceof HostError) {
        this.#deps.send({ kind: 'response', id, ok: false, error: error.message });
      } else {
        this.#crash(error);
      }
    } finally {
      this.#busy--;
      this.requestFrame();
    }
  }

  async #execute(request: ServerRequest): Promise<ServerResponseValue> {
    const { host } = this.#deps;

    switch (request.kind) {
      case 'start':
        return await host.StartMap(request.mapname);

      case 'announce-changelevel':
        host.AnnounceChangelevel(request.mapname);
        return true;

      case 'changelevel':
        return await host.Changelevel(request.mapname);

      case 'stop':
        host.ShutdownServer(request.crash);
        return true;

      case 'save':
        return this.#deps.savegame.capture();

      case 'restore':
        await this.#deps.savegame.restore(request.state, request.source);
        return true;

      case 'viewthing':
        return host.getViewthing();

      case 'viewthing-frame':
        host.setViewthingFrame(request.frame);
        return true;

      default:
        return false;
    }
  }

  #onTimer(): void {
    const interval = this.#deps.fallbackInterval();

    if (interval <= 0 || !this.#deps.isServerActive()) {
      return;
    }

    if (performance.now() - this.#lastFrameAt >= interval * 1000) {
      this.requestFrame();
    }
  }

  #publishState(): void {
    const { active, maxclients, mapname, paused } = this.#deps.readState();
    const last = this.#lastState;

    if (last !== null && last.active === active && last.maxclients === maxclients && last.mapname === mapname && last.paused === paused) {
      return;
    }

    const state: ServerStateMirror = { active, maxclients, mapname, paused };

    this.#lastState = state;
    this.#deps.send({ kind: 'state', state });
  }

  #failFrame(error: unknown): void {
    if (!(error instanceof HostError)) {
      this.#crash(error);
      return;
    }

    // Like Host.Error: the server goes down, the player is told, the engine stays up.
    try {
      this.#deps.host.ShutdownServer();
    } finally {
      this.#publishState();
      this.#deps.send({ kind: 'error', message: error.message });
    }
  }

  #crash(error: unknown): void {
    this.stop();

    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);

    this.#deps.send({ kind: 'crash', name, message, stack: error instanceof Error ? error.stack : undefined });
  }
}

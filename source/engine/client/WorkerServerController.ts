import type { ServerController, ServerSaveResult, ServerSaveState, ServerStateMirror, SessionRequest, ViewthingState } from '../common/ServerController.ts';
import type { ConsoleOutput } from '../common/Services.ts';
import type { ControlFromServer, ControlToServer, CvarDescription, ServerRequest, ServerResponseValue, ServerWorkerBoot, ServerWorkerInit } from '../common/ServerWorkerProtocol.ts';

import Vector from '../../shared/Vector.ts';
import Cmd, { ConsoleCommand } from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import { HostError } from '../common/Errors.ts';
import { ControlLink } from '../common/ServerWorkerProtocol.ts';
import ServerCvarMirror from './ServerCvarMirror.ts';

/** The worker a controller talks to. */
export interface ServerWorkerHandle {
  /**
   * Sends a message to the worker.
   * @param message What to send.
   * @param transfer Objects of the message that move to the worker.
   */
  postMessage(message: unknown, transfer?: Transferable[]): void;
  /** Ends the worker. */
  shutdown(): Promise<void>;
}

/** What a `WorkerServerController` is built from. */
export interface WorkerServerControllerDependencies {
  readonly worker: ServerWorkerHandle;
  /** The two ends of the channel; the worker receives `port2`, this side keeps `port1`. */
  readonly channel: { readonly port1: MessagePort; readonly port2: MessagePort };
  /** Collects the settings the worker boots with, when it boots. */
  readonly createInit: () => ServerWorkerInit;
  /** Where lines the server prints go. */
  readonly con: ConsoleOutput;
  /** Publishes an engine event that happened in the worker. */
  readonly publish: (name: string, ...args: unknown[]) => void;
  /** Name of the local player, shown for what the console does on the server's behalf, like kicks. */
  readonly operatorName: () => string;
  /** The server switched the view hack for a player who flies through walls on or off. */
  readonly onNoclipAnglehack: (enabled: boolean) => void;
  /** The game on the server asked for a level change or a restart, which this side carries out. */
  readonly onSessionRequest: (request: SessionRequest) => void;
  /** The server hit an error it recovered from by shutting down, show it to the player. */
  readonly onError: (message: string) => void;
  /** The worker died or failed in a way it cannot recover from. */
  readonly onCrash: (error: Error) => void;
}

interface PendingRequest {
  readonly resolve: (result: ServerResponseValue) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Controls a server that runs in a worker. The state the client may read is a mirror the worker keeps
 * up to date, and requests are answered when the worker has done them, in the order they were made.
 * Starting a request never blocks, the worker runs the server frames whenever packets of the local
 * player arrive, so `runLocalFrame` has nothing to do.
 */
export default class WorkerServerController implements ServerController {
  /** How long, in milliseconds, `replaceWorker` waits for requests that are on their way. */
  static readonly REPLACE_TIMEOUT = 5000;

  readonly state: ServerStateMirror;

  readonly #deps: WorkerServerControllerDependencies;
  #worker: ServerWorkerHandle;
  #channel: WorkerServerControllerDependencies['channel'];
  #link: ControlLink<ControlToServer, ControlFromServer>;
  /** Counts the links made, so that a message from a worker that was replaced is not taken for one of the new worker. */
  #generation = 0;
  readonly #pending = new Map<number, PendingRequest>();
  #mirror: ServerStateMirror = { active: false, maxclients: 0, mapname: null, paused: false };
  #nextRequest = 1;
  #simulationAllowed: boolean | null = null;
  #booted: Promise<void> | null = null;
  #bootSettled: { resolve: () => void; reject: (error: Error) => void } | null = null;
  #dead = false;
  #cvarList: CvarDescription[] = [];
  #commandList: string[] = [];
  #cvars: ServerCvarMirror | null = null;

  constructor(dependencies: WorkerServerControllerDependencies) {
    this.#deps = dependencies;
    this.#worker = dependencies.worker;
    this.#channel = dependencies.channel;
    this.#link = this.#createLink(dependencies.channel.port1);

    const mirror = (): ServerStateMirror => this.#mirror;

    this.state = {
      get active(): boolean {
        return mirror().active;
      },
      get maxclients(): number {
        return mirror().maxclients;
      },
      get mapname(): string | null {
        return mirror().mapname;
      },
      get paused(): boolean {
        return mirror().paused;
      },
    };
  }

  init(): Promise<void> {
    if (this.#booted !== null) {
      return this.#booted;
    }

    this.#booted = new Promise<void>((resolve, reject) => {
      this.#bootSettled = { resolve, reject };
    });

    const boot: ServerWorkerBoot = {
      event: 'server.worker.boot',
      port: this.#channel.port2,
      init: this.#deps.createInit(),
    };

    this.#worker.postMessage(boot, [boot.port]);

    return this.#booted;
  }

  setSimulationAllowed(allowed: boolean): void {
    if (this.#simulationAllowed === allowed || this.#dead) {
      return;
    }

    this.#simulationAllowed = allowed;
    this.#link.send({ kind: 'simulation-allowed', allowed });
  }

  // The worker steps its server when the packets of the local player arrive.
  runLocalFrame(_frametime: number, _realtime: number): void {
  }

  async start(mapname: string): Promise<boolean> {
    return await this.#request<boolean>({ kind: 'start', mapname });
  }

  announceChangelevel(mapname: string): void {
    void this.#request<boolean>({ kind: 'announce-changelevel', mapname }).catch((error: unknown) => {
      this.#deps.con.PrintError(`${error instanceof Error ? error.message : String(error)}\n`);
    });
  }

  async changelevel(mapname: string): Promise<boolean> {
    return await this.#request<boolean>({ kind: 'changelevel', mapname });
  }

  stop(isCrashShutdown = false): void {
    if (this.#dead || !this.#mirror.active) {
      return;
    }

    // The player must not see a server that is on its way down as running, the worker confirms it.
    this.#mirror = { ...this.#mirror, active: false, mapname: null };

    void this.#request<boolean>({ kind: 'stop', crash: isCrashShutdown }).catch((error: unknown) => {
      this.#deps.con.PrintError(`${error instanceof Error ? error.message : String(error)}\n`);
    });
  }

  attachConsole(): void {
    if (this.#cvars !== null) {
      return;
    }

    this.#cvars = new ServerCvarMirror((name, value) => { this.#send({ kind: 'cvar-set', name, value }); });
    this.#cvars.attach(this.#cvarList);

    // The commands only the server has, the ones both sides know stay what they are here.
    for (const name of this.#commandList) {
      if (!Cmd.HasCommand(name) && Cvar.FindVar(name) === null) {
        Cmd.AddCommand(name, this.#createForwardedCommand());
      }
    }
  }

  saveState(): Promise<ServerSaveResult> {
    return this.#request<ServerSaveResult>({ kind: 'save' });
  }

  async restoreState(state: ServerSaveState, source: string): Promise<void> {
    await this.#request<boolean>({ kind: 'restore', state, source });
  }

  getViewthing(): Promise<ViewthingState | null> {
    return this.#request<ViewthingState | null>({ kind: 'viewthing' });
  }

  async setViewthingFrame(frame: number): Promise<void> {
    await this.#request<boolean>({ kind: 'viewthing-frame', frame });
  }

  /**
   * Ends the worker and fails everything still waiting for it.
   * @param reason Why the controller is not used any more.
   */
  async dispose(reason = 'The server worker was shut down'): Promise<void> {
    this.#fail(new Error(reason));
    await this.#worker.shutdown();
  }

  /**
   * Replaces the worker with a new one that has not started: the old server is stopped the proper way when it is
   * running, the worker ends, and the new one boots with the settings of today. The cvars and commands the server has
   * are taken over again, and what this side set on a variable the server also has is handed to the new server.
   * Whoever called this has to carry the new channel to the network layer (`ChannelDriver.replaceEndpoint`) first.
   * @param next The new worker and the two ends of its channel.
   */
  async replaceWorker(next: Pick<WorkerServerControllerDependencies, 'worker' | 'channel'>): Promise<void> {
    const attached = this.#cvars !== null;

    if (!this.#dead && this.#mirror.active) {
      // let the game and the navigation worker shut down the way they do when a level ends
      await this.#request<boolean>({ kind: 'stop', crash: false });
    }

    // a stop that was asked for a moment ago, by the client letting go of the server, may still be on its way
    for (let waited = 0; this.#pending.size > 0 && waited < WorkerServerController.REPLACE_TIMEOUT; waited += 20) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    }

    this.#fail(new Error('The server worker is being replaced'));
    await this.#worker.shutdown();

    this.#cvars?.release();
    this.#cvars = null;

    this.#worker = next.worker;
    this.#channel = next.channel;
    this.#link = this.#createLink(next.channel.port1);
    this.#dead = false;
    this.#booted = null;
    this.#bootSettled = null;
    this.#simulationAllowed = null;
    this.#mirror = { active: false, maxclients: 0, mapname: null, paused: false };
    this.#cvarList = [];
    this.#commandList = [];

    await this.init();

    if (attached) {
      this.attachConsole();
    }
  }

  #createLink(port: MessagePort): ControlLink<ControlToServer, ControlFromServer> {
    const generation = ++this.#generation;

    return new ControlLink<ControlToServer, ControlFromServer>(port, (message) => {
      if (generation === this.#generation) {
        this.#onMessage(message);
      }
    });
  }

  #send(message: ControlToServer): void {
    if (!this.#dead) {
      this.#link.send(message);
    }
  }

  #request<T extends ServerResponseValue>(request: ServerRequest): Promise<T> {
    if (this.#dead) {
      return Promise.reject(new HostError('The server is not running.'));
    }

    const id = this.#nextRequest++;

    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as PendingRequest['resolve'], reject });
      this.#link.send({ kind: 'request', id, request });
    });
  }

  /**
   * Builds the command that stands in for one only the server knows. The server runs the line, as the local player where that is what it means.
   * @returns The command class to register.
   */
  #createForwardedCommand(): new () => ConsoleCommand {
    const forward = (text: string): void => { this.#forwardCommand(text); };

    return class ForwardedServerCommand extends ConsoleCommand {
      override run(): void {
        forward(this.args ?? '');
      }
    };
  }

  #forwardCommand(text: string): void {
    if (this.#dead) {
      this.#deps.con.PrintWarning('The server is not running.\n');
      return;
    }

    this.#link.send({ kind: 'command', text, operator: this.#deps.operatorName() });
  }

  #onMessage(message: ControlFromServer): void {
    switch (message.kind) {
      case 'ready':
        this.#cvarList = [...message.cvars];
        this.#commandList = message.commands;
        this.#bootSettled?.resolve();
        this.#bootSettled = null;
        break;

      case 'response':
        this.#settle(message);
        break;

      case 'state':
        this.#mirror = message.state;
        break;

      case 'cvar-registered':
        this.#cvarList.push(message.cvar);
        this.#cvars?.register(message.cvar);
        break;

      case 'cvar-changed':
        this.#cvars?.remoteChanged(message.name, message.value);
        this.#recordCvarValue(message.name, message.value);
        break;

      case 'noclip-anglehack':
        this.#deps.onNoclipAnglehack(message.enabled);
        break;

      case 'session-request':
        this.#deps.onSessionRequest(message.request);
        break;

      case 'print':
        this.#print(message.level, message.text, message.color);
        break;

      case 'event':
        this.#deps.publish(message.name, ...message.args);
        break;

      case 'error':
        this.#deps.onError(message.message);
        break;

      case 'crash': {
        const error = new Error(`${message.name}: ${message.message}`);

        // The trace of the worker is the useful one, this thread only received the news.
        if (message.stack !== undefined) {
          error.stack = `${error.message}\n--- in the server worker:\n${message.stack}`;
        }

        this.#fail(error);
        this.#deps.onCrash(error);
        break;
      }

      default:
        break;
    }
  }

  #settle(message: Extract<ControlFromServer, { kind: 'response' }>): void {
    const pending = this.#pending.get(message.id);

    if (pending === undefined) {
      return;
    }

    this.#pending.delete(message.id);

    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new HostError(message.error));
    }
  }

  /** Before the console is attached the values the server reports are kept for when it is. */
  #recordCvarValue(name: string, value: string): void {
    if (this.#cvars !== null) {
      return;
    }

    const index = this.#cvarList.findIndex((description) => description.name === name);

    if (index !== -1) {
      this.#cvarList[index] = { ...this.#cvarList[index], value };
    }
  }

  #print(level: Extract<ControlFromServer, { kind: 'print' }>['level'], text: string, color?: readonly [number, number, number]): void {
    const { con } = this.#deps;

    switch (level) {
      case 'success':
        con.PrintSuccess(text);
        break;
      case 'warning':
        con.PrintWarning(text);
        break;
      case 'error':
        con.PrintError(text);
        break;
      case 'debug':
        con.DPrint(text);
        break;
      default:
        con.Print(text, color === undefined ? undefined : new Vector(color[0], color[1], color[2]));
        break;
    }
  }

  #fail(error: Error): void {
    this.#dead = true;
    this.#mirror = { active: false, maxclients: this.#mirror.maxclients, mapname: null, paused: false };

    this.#cvars?.markInactive();
    this.#cvars?.stop();

    this.#bootSettled?.reject(error);
    this.#bootSettled = null;

    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }

    this.#pending.clear();
  }
}

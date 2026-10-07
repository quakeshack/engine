/*
 * DedicatedHost: how a dedicated server process starts, runs a frame and stops.
 *
 * The shared state of the loop (clock, scheduler, cvars, configuration, error reporting) is `common/Host.ts`; this
 * is the part that knows there is a server and no client. It is built by `createDedicatedServer` with everything
 * it needs, which is why it is a class with a constructor and not a facade.
 */

import type { URLs } from '../build-config';
import type COM from '../common/Com.ts';
import type Cvar from '../common/Cvar.ts';
import type { SystemServices } from '../common/Services.ts';
import type NET from '../network/Network.ts';
import type Server from '../server/Server.ts';
import type ServerHost from '../server/ServerHost.ts';

import Cmd, { type ConsoleCommand } from '../common/Cmd.ts';
import CvarTable from '../common/Cvar.ts';
import Con from '../common/Console.ts';
import { eventBus } from '../common/EventBus.ts';
import GameModule from '../common/GameModule.ts';
import Host from '../common/Host.ts';
import Mod from '../common/Mod.ts';
import { Pmove } from '../common/Pmove.ts';
import PlatformWorker from '../common/PlatformWorker.ts';
import WorkerManager from '../common/WorkerManager.ts';

/** What a `DedicatedHost` is built from. */
export interface DedicatedHostDependencies {
  readonly com: COM;
  readonly net: NET;
  readonly sv: Server;
  readonly serverHost: ServerHost;
  /** The platform of the process, which can also end it. */
  readonly sys: SystemServices & { Quit(): never };
  /** The view code the server needs set up, it computes the roll of a player. */
  readonly view: { Init(): void };
  readonly urls: () => URLs | undefined;
  /** The commit the build was made from, if it knows one. */
  readonly commitHash: string | undefined;
}

/**
 * Drives a dedicated server: boot sequence, main loop iteration, shutdown, and what an error does.
 */
export default class DedicatedHost {
  readonly #deps: DedicatedHostDependencies;

  constructor(dependencies: DedicatedHostDependencies) {
    this.#deps = dependencies;
  }

  /** How many frames per second the main loop aims for. */
  get refreshrate(): Cvar | null {
    return Host.refreshrate;
  }

  /** The `developer` variable. */
  get developer(): Cvar | null {
    return Host.developer;
  }

  /**
   * Whether something is waiting for the next frame, in which case the main loop must not sleep.
   * @returns True when work is scheduled.
   */
  hasScheduledWork(): boolean {
    return Host._scheduledForNextFrame.length > 0;
  }

  /**
   * Boots the server: tables, file system, game module, models and network, then runs the configuration.
   */
  async Init(): Promise<void> {
    const { com, net, sv, sys, view } = this.#deps;

    Host.oldrealtime = sys.FloatTime();

    // What the shared parts of the engine need from this realm.
    Host.files = com;
    Host.recoverFromError = () => { this.#deps.serverHost.ShutdownServer(); };
    Host.quit = () => { sys.Quit(); };
    Cmd.files = com;
    GameModule.com = com;
    WorkerManager.services = { con: Con, com, urls: this.#deps.urls };
    PlatformWorker.onCrash = (error) => { Host.HandleCrash(error); };
    CvarTable.serverState = { isServerActive: () => sv.server.active, reportedCheats: () => undefined };

    Cmd.Init();
    CvarTable.Init();

    view.Init(); // required for V.CalcRoll

    await com.Init();
    this.#InitLocal();

    Con.Init({ clock: () => Host.realtime, developer: () => Boolean(Host.developer?.value) });

    await GameModule.Init(sv.engineAPI);

    Mod.Init({ files: com, con: Con, loadRenderData: false });
    net.Init();
    Pmove.Init();
    sv.Init();

    Cmd.text = `exec better-quake.rc\n${Cmd.text}`;
     
    Host.initialized = true;
    sys.Print('========Host Initialized=========\n');

    eventBus.publish('host.ready');
  }

  /**
   * Registers the commands and variables of a dedicated server.
   */
  #InitLocal(): void {
    const { serverHost } = this.#deps;

    serverHost.InitDedicatedCommands();
    serverHost.InitCommands();
    Cmd.AddCommand('quit', () => { this.ForceQuit(); });
    Cmd.AddCommand('name', function nameCommand(this: ConsoleCommand, ...names: string[]): void { serverHost.name(this, ...names); });
    Cmd.AddCommand('color', function colorCommand(this: ConsoleCommand, ...colors: string[]): void { serverHost.color(this, ...colors); });
    Host.InitCommands();

    Host.InitLocal(this.#deps.commitHash, true);
    serverHost.InitLocal();
  }

  /**
   * Stops the server and the process.
   */
  ForceQuit(): void {
    this.#deps.serverHost.ShutdownServer();

    this.#deps.com.Shutdown();
    this.#deps.sys.Quit();
  }

  /**
   * Runs one iteration of the main loop, and reports whatever goes wrong in it.
   */
  async Frame(): Promise<void> {
    if (Host.crashing) {
      return;
    }

    try {
      await Host.BeginFrame(this.#deps.sys.FloatTime());

      Cmd.Execute();
      this.#deps.serverHost.Frame(Host.frametime, Host.realtime);
      Host.framecount++;
    } catch (error) {
      Host.HandleCrash(error as Error);
    }
  }

  /**
   * Stops the engine: writes the configuration and shuts the network and the tables down.
   */
  Shutdown(): void {
    if (Host.isdown) {
      this.#deps.sys.Print('recursive shutdown\n');
      return;
    }

    eventBus.publish('host.shutting-down');
    Host.isdown = true;
    Host.WriteConfiguration();

    this.#deps.net.Shutdown();
    Pmove.Shutdown();
    Cmd.Shutdown();
    CvarTable.Shutdown();
    eventBus.publish('host.shutdown');
  }
}

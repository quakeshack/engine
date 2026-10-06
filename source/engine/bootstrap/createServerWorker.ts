import type { ConsoleOutput, SystemServices } from '../common/Services.ts';
import type { ComDependencies } from '../common/Com.ts';
import type { ChannelEndpoint, ChannelPortLike } from '../network/ChannelDriver.ts';
import type { ControlFromServer, ControlPortLike, ControlToServer, ServerWorkerInit } from '../common/ServerWorkerProtocol.ts';
import type { WorkerFactoryRegistry } from '../common/PlatformWorker.ts';
import type COM from '../common/Com.ts';

import { eventBus } from '../common/EventBus.ts';
import { registry } from '../registry.ts';
import Cmd from '../common/Cmd.ts';
import Cvar from '../common/Cvar.ts';
import GameModule from '../common/GameModule.ts';
import Mod from '../common/Mod.ts';
import { Pmove } from '../common/Pmove.ts';
import W from '../common/W.ts';
import WorkerManager from '../common/WorkerManager.ts';
import { ControlLink, forwardedServerEvents } from '../common/ServerWorkerProtocol.ts';
import { ChannelDriver, MessagePortEndpoint } from '../network/ChannelDriver.ts';
import NET from '../network/Network.ts';
import PlayerRollView from '../server/PlayerRollView.ts';
import ServerCvarSync from '../server/ServerCvarSync.ts';
import ServerLocalConsole from '../server/ServerLocalConsole.ts';
import ServerRealm from '../server/ServerRealm.ts';
import ServerSavegame from '../server/ServerSavegame.ts';
import ServerWorkerConsole from '../server/ServerWorkerConsole.ts';
import ServerWorkerRuntime from '../server/ServerWorkerRuntime.ts';
import { createServerRuntime } from './createServerRuntime.ts';

/** What differs between the platforms a server worker can run on. */
export interface ServerWorkerPlatform {
  /** The port the main thread handed to the worker; control and game packets share it. */
  readonly port: ControlPortLike & ChannelPortLike;
  /** The clock of the platform, in seconds. */
  readonly sys: SystemServices;
  /** Builds the file system of the platform. */
  readonly createCom: (dependencies: ComDependencies) => COM;
  /** The workers this worker may start itself, e.g. the navigation worker. */
  readonly workerFactories: WorkerFactoryRegistry;
}

/** A booted server worker. */
export interface ServerWorker {
  readonly runtime: ServerWorkerRuntime;
  readonly realm: ServerRealm;
}

/**
 * Composition root of a server worker: builds the realm services (console, clock, files, network),
 * the server runtime on top of them and the runtime that answers the main thread, hands them to the
 * registry that older code still reads inside this realm, and tells the main thread when it is ready.
 * @param platform What differs between the platforms.
 * @param init Settings the main thread sent with the port.
 * @returns The booted worker.
 */
export async function createServerWorker(platform: ServerWorkerPlatform, init: ServerWorkerInit): Promise<ServerWorker> {
  let runtime: ServerWorkerRuntime | null = null;

  const link = new ControlLink<ControlFromServer, ControlToServer>(platform.port, (message) => { runtime?.handle(message); });
  const con = new ServerWorkerConsole((message) => { link.send(message); });
  const { sys } = platform;

  const com = platform.createCom({
    con: con as unknown as ConsoleOutput,
    sys,
    buildConfig: () => init.buildConfig,
    urls: () => init.urls,
  });

  com.searchpaths = init.searchpaths;
  com.gamedir = init.gamedir;
  com.game = init.game;
  com.abortController = new AbortController();

  const realm = new ServerRealm({
    sys,
    con,
    engineVersion: init.engineVersion,
    onCrash: (error) => { runtime?.fail(error); },
    onNoclipAnglehack: (enabled) => { link.send({ kind: 'noclip-anglehack', enabled }); },
  });

  // Packets that arrive are a reason to run a server frame, a command of the local player most of all.
  const portEndpoint = new MessagePortEndpoint(platform.port);
  const endpoint: ChannelEndpoint = {
    post: (message, transfer) => { portEndpoint.post(message, transfer); },
    setReceiver: (receiver) => {
      portEndpoint.setReceiver((message) => {
        receiver(message);
        runtime?.requestFrame();
      });
    },
  };

  let net!: NET;

  net = new NET({
    con,
    sys,
    dedicated: false,
    urls: () => init.urls,
    serverInfo: () => ({ maxPlayers: sv.svs.maxclients, mapname: sv.server.mapname!, game: com.game }),
    webSocketModule: () => undefined,
    createDrivers: (owner) => [['channel', new ChannelDriver(owner, endpoint)]],
  });

  const { sv, serverHost } = createServerRuntime({
    con,
    sys,
    net,
    mod: Mod,
    com,
    host: realm,
    view: new PlayerRollView(),
    gameEdition: () => init.edition,
  }, false);

  realm.serverHost = serverHost;

  registry.isDedicatedServer = true;
  registry.buildConfig = init.buildConfig;
  registry.urls = init.urls;
  registry.Con = con as unknown as typeof registry.Con;
  registry.Sys = sys as unknown as typeof registry.Sys;
  registry.COM = com;
  registry.Mod = Mod;
  registry.NET = net;
  registry.SV = sv;
  registry.Host = realm as unknown as typeof registry.Host;
  eventBus.publish('registry.frozen');

  WorkerManager.Init(platform.workerFactories);

  Cmd.Init();
  Cvar.Init();
  realm.InitLocal();
  serverHost.InitLocal();
  serverHost.InitCommands();
  serverHost.InitIdentityCommands();
  serverHost.InitSessionRequestCommands((request) => { link.send({ kind: 'session-request', request }); });

  await com.InitStorage();
  await W.LoadPalette('gfx/palette.lmp');
  await GameModule.Init(sv.engineAPI);

  Mod.Init();
  net.Init();
  Pmove.Init();
  sv.Init();

  const cvarSync = new ServerCvarSync((message) => { link.send(message); });
  const localConsole = new ServerLocalConsole(sv, serverHost, con);

  localConsole.install();
  cvarSync.start();

  runtime = new ServerWorkerRuntime({
    send: (message) => { link.send(message); },
    readState: () => ({
      active: sv.server.active,
      maxclients: sv.svs.maxclients,
      mapname: sv.server.mapname,
      paused: sv.server.paused,
    }),
    host: serverHost,
    console: {
      describe: () => ({ cvars: cvarSync.describe(), commands: Cmd.GetCommandNames() }),
      setCvar: (name, value) => { cvarSync.apply(name, value); },
      execute: (text, operator) => { localConsole.execute(text, operator); },
    },
    savegame: {
      capture: () => ServerSavegame.capture(sv),
      restore: (state, source) => ServerSavegame.restore(sv, state, source),
    },
    frame: async () => { await realm.Frame(); },
    fallbackInterval: () => realm.ticrate?.value ?? 0,
    isServerActive: () => sv.server.active,
  });

  for (const name of forwardedServerEvents) {
    eventBus.subscribe(name, (...args: unknown[]) => {
      link.send({ kind: 'event', name, args });
    });
  }

  runtime.start();

  return { runtime, realm };
}

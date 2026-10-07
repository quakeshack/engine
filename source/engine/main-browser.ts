import type { BuildConfig, URLs } from './build-config';

import CL from './client/CL.ts';
import Draw from './client/Draw.ts';
import IN from './client/IN.ts';
import Key from './client/Key.ts';
import M from './client/Menu.ts';
import R from './client/R.ts';
import S from './client/Sound.ts';
import Sys from './client/Sys.ts';
import V from './client/V.ts';
import SCR from './client/SCR.ts';
import COM from './common/Com.ts';
import Con from './common/Console.ts';
import Host from './common/Host.ts';
import Mod from './common/Mod.ts';
import NET from './network/Network.ts';
import { freeze as registryFreeze, registry } from './registry.ts';
import InThreadServerController from './server/InThreadServerController.ts';
import ClientHost from './client/ClientHost.ts';
import WorkerServerController from './client/WorkerServerController.ts';
import PeerRelay from './client/PeerRelay.ts';
import Cmd from './common/Cmd.ts';
import PlatformWorker from './common/PlatformWorker.ts';
import workerFactories from './common/WorkerFactories.ts';
import { type EventBusValue, eventBus } from './common/EventBus.ts';
import { ChannelDriver, MessagePortEndpoint } from './network/ChannelDriver.ts';
import { LoopDriver, WebRTCDriver, WebSocketDriver } from './network/NetworkDrivers.ts';
import { createServerRuntime } from './bootstrap/createServerRuntime.ts';
import { editionOf } from './common/GameApiSupport.ts';
import clientCvars from './client/ClientCvars.ts';
import { clientStaticState } from './client/ClientState.ts';

/**
 * Whether the server runs in a worker. It does unless the page asks for the server of the page's
 * thread with `?serverthread`, which is for debugging: breakpoints and the whole engine in one place.
 * The flag has no value on purpose, a parameter with a value would be run as a console command at startup.
 * @returns True when the server should run in a worker.
 */
function wantsServerWorker(): boolean {
  return 'Worker' in globalThis && !new URLSearchParams(window.location.search).has('serverthread');
}

export default class EngineLauncher {
  static async Launch(urls: URLs, buildConfig: BuildConfig): Promise<typeof registry> {
    console.info('Launching engine in browser mode...');

    registry.urls = urls;
    registry.buildConfig = buildConfig;

    // set some global flags
    registry.isDedicatedServer = false;

    // inject some external dependencies
    registry.WebSocket = window.WebSocket;

    // hooking up all required components
    const useWorker = wantsServerWorker();
    const channel = useWorker ? new MessageChannel() : null;
    let channelDriver: ChannelDriver | null = null;

    const com = new COM({ con: Con, sys: Sys, buildConfig: () => registry.buildConfig, urls: () => registry.urls });
    const net = new NET({
      con: Con,
      sys: Sys,
      dedicated: false,
      urls: () => registry.urls,
      serverInfo: () => ({ maxPlayers: clientStaticState.serverController.state.maxclients, mapname: clientStaticState.serverController.state.mapname ?? '', game: com.game }),
      webSocketModule: () => registry.WebSocket,
      createDrivers: (owner) => [
        // A server in a worker is reached through the channel to it, one in this thread through the loopback.
        channel !== null ? ['channel', channelDriver = new ChannelDriver(owner, new MessagePortEndpoint(channel.port1))] : ['loopback', new LoopDriver(owner)],
        ['websocket', new WebSocketDriver(owner)],
        ['webrtc', new WebRTCDriver(owner)],
      ],
    });

    registry.Sys = Sys;

    registry.COM = com;
    registry.Con = Con;
    registry.Host = Host;
    registry.V = V;
    registry.NET = net;
    registry.Mod = Mod;
    registry.Key = Key;
    registry.CL = CL;
    registry.S = S;
    registry.Draw = Draw;
    registry.R = R;
    registry.M = M;
    registry.SCR = SCR;
    registry.IN = IN;

    // the client only ever sees the controller, the server is in this thread or in a worker
    if (channel !== null) {
      let relay: PeerRelay | null = null;
      const worker = new PlatformWorker('server/ServerWorker.ts', workerFactories['server/ServerWorker.ts']('server'));

      clientStaticState.serverController = new WorkerServerController({
        worker,
        channel,
        createInit: () => ({
          searchpaths: com.searchpaths,
          gamedir: com.gamedir,
          game: com.game,
          urls: registry.urls!,
          engineVersion: Host.version!.string,
          edition: editionOf(com),
          argv: com.argv,
          buildConfig: registry.buildConfig,
        }),
        con: Con,
        operatorName: () => clientCvars.name.string,
        onNoclipAnglehack: (enabled) => { Host.noclip_anglehack = enabled; },
        publish: (name, ...args) => { eventBus.publish(name, ...(args as EventBusValue[])); },
        onSessionRequest: (request) => { ClientHost.HandleSessionRequest(request); },
        onError: (message) => { relay?.closeAll(); Host.Error(message); },
        onCrash: (error) => { relay?.stop(); Host.HandleCrash(error); },
      });

      // A worker has no WebRTC, so the peers of a game for several players are accepted here and carried over.
      relay = new PeerRelay({
        net,
        // The driver is built when the network layer starts, which is later than this.
        channel: { open: (address) => channelDriver!.open(address) },
        state: clientStaticState.serverController.state,
        setListening: (listening) => { void Cmd.ExecuteString(listening ? 'listen 1' : 'listen 0'); },
      });
      relay.start();
    } else {
      const runtime = createServerRuntime({ con: Con, sys: Sys, net, mod: Mod, com, host: Host, view: V, gameEdition: () => editionOf(com) }, false);

      registry.SV = runtime.sv;
      Host.serverHost = runtime.serverHost;
      clientStaticState.serverController = new InThreadServerController(runtime.sv, runtime.serverHost);
    }

    // registry is ready
    registryFreeze();

    await Sys.Init();

    return registry;
  }
}

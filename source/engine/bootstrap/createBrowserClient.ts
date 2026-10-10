import type { BuildConfig, URLs } from '../build-config';

import CL from '../client/CL.ts';
import Draw from '../client/Draw.ts';
import IN from '../client/IN.ts';
import Key from '../client/Key.ts';
import M from '../client/Menu.ts';
import R from '../client/R.ts';
import Particles, { ParticleType } from '../client/renderer/effects/Particles.ts';
import Decals from '../client/renderer/effects/Decals.ts';
import Camera from '../client/renderer/scene/Camera.ts';
import RenderStats from '../client/renderer/scene/RenderStats.ts';
import DefaultTextures from '../client/renderer/resources/DefaultTextures.ts';
import Fog from '../client/renderer/scene/Fog.ts';
import SkyBox from '../client/renderer/scene/SkyBox.ts';
import Visibility from '../client/renderer/scene/Visibility.ts';
import S from '../client/Sound.ts';
import Sys from '../client/Sys.ts';
import V from '../client/V.ts';
import SCR from '../client/SCR.ts';
import COM from '../common/Com.ts';
import Con from '../common/Console.ts';
import Host from '../common/Host.ts';
import Mod from '../common/Mod.ts';
import NET from '../network/Network.ts';
import InThreadServerController from '../server/InThreadServerController.ts';
import ClientHost from '../client/ClientHost.ts';
import ConsoleOverlay from '../client/ConsoleOverlay.ts';
import WorkerServerController from '../client/WorkerServerController.ts';
import PeerRelay from '../client/PeerRelay.ts';
import Cmd from '../common/Cmd.ts';
import PlatformWorker from '../common/PlatformWorker.ts';
import workerFactories from '../common/WorkerFactories.ts';
import { type EventBusValue, eventBus } from '../common/EventBus.ts';
import { ChannelDriver, MessagePortEndpoint } from '../network/ChannelDriver.ts';
import { LoopDriver, WebRTCDriver, WebSocketDriver } from '../network/NetworkDrivers.ts';
import { createServerRuntime } from './createServerRuntime.ts';
import { editionOf } from '../common/GameApiSupport.ts';
import clientCvars from '../client/ClientCvars.ts';
import { clientStaticState } from '../client/ClientState.ts';
import { ShaderLibrary } from '../client/renderer/programs/ShaderLibrary.ts';
import GL from '../client/GL.ts';
import { ClientEngineAPI } from '../client/ClientEngineAPI.ts';
import type Server from '../server/Server.ts';
import { installPageServices } from '../client/PageServices.ts';

/**
 * Whether the server runs in a worker. It does unless the page asks for the server of the page's
 * thread with `?serverthread`, which is for debugging: breakpoints and the whole engine in one place.
 * The flag has no value on purpose, a parameter with a value would be run as a console command at startup.
 * @returns True when the server should run in a worker.
 */
function wantsServerWorker(): boolean {
  return 'Worker' in globalThis && !new URLSearchParams(window.location.search).has('serverthread');
}

/**
 * Composition root of the page: builds the realm services (file system, network), the server (in a worker, or in
 * this thread with `?serverthread`) and the engine API the game sees, installs them where the client modules read them,
 * and runs the main loop until the page quits.
 * @param urls Where the signaling and master servers are reached.
 * @param buildConfig The build the page was made by.
 */
export async function createBrowserClient(urls: URLs, buildConfig: BuildConfig): Promise<void> {
  console.info('Launching engine in browser mode...');

  // hooking up all required components
  const useWorker = wantsServerWorker();
  const channel = useWorker ? new MessageChannel() : null;
  let channelDriver: ChannelDriver | null = null;
  let inThreadServer: Server | null = null;

  const com = new COM({ con: Con, sys: Sys, buildConfig: () => buildConfig, urls: () => urls });
  const net = new NET({
    con: Con,
    sys: Sys,
    dedicated: false,
    urls: () => urls,
    serverInfo: () => ({ maxPlayers: clientStaticState.serverController.state.maxclients, mapname: clientStaticState.serverController.state.mapname ?? '', game: com.game }),
    webSocketModule: () => window.WebSocket,
    createDrivers: (owner) => [
      // A server in a worker is reached through the channel to it, one in this thread through the loopback.
      channel !== null ? ['channel', channelDriver = new ChannelDriver(owner, new MessagePortEndpoint(channel.port1))] : ['loopback', new LoopDriver(owner)],
      ['websocket', new WebSocketDriver(owner)],
      ['webrtc', new WebRTCDriver(owner)],
    ],
  });

  const engineApi = new ClientEngineAPI(() => editionOf(com));

  installPageServices({ com, net, engineApi, urls, buildConfig });

  // The shader text is only bundled for the page, GL.ts is also reachable from the server worker.
  GL.shaderLibrary = ShaderLibrary.fromBundle();

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
        urls,
        engineVersion: Host.version!.string,
        edition: editionOf(com),
        argv: com.argv,
        buildConfig,
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

    inThreadServer = runtime.sv;
    Host.serverHost = runtime.serverHost;
    clientStaticState.serverController = new InThreadServerController(runtime.sv, runtime.serverHost);
  }

  // The members that verification scripts in a browser reach for, see docs/browser-verification.md.
  (window as Window & { engine?: object }).engine = { CL, COM: com, Con, ConsoleOverlay, Host, Mod, NET: net, Sys, V, Key, S, Draw, R, Camera, Visibility, RenderStats, DefaultTextures, Fog, SkyBox, Particles, ParticleType, Decals, M, SCR, IN, SV: inThreadServer };

  await Sys.Init();
}

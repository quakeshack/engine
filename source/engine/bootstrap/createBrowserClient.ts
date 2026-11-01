import type { BuildConfig, URLs } from '../build-config';

import CL from '../client/CL.ts';
import Draw from '../client/Draw.ts';
import SpriteAssets from '../client/renderer/sprite/SpriteAssets.ts';
import IN from '../client/IN.ts';
import Key from '../client/Key.ts';
import M from '../client/Menu.ts';
import R from '../client/R.ts';
import Particles, { ParticleType } from '../client/renderer/effects/Particles.ts';
import Decals from '../client/renderer/effects/Decals.ts';
import Camera from '../client/renderer/scene/Camera.ts';
import PostProcess from '../client/renderer/postprocess/PostProcess.ts';
import RenderStats from '../client/renderer/scene/RenderStats.ts';
import DefaultTextures from '../client/renderer/resources/DefaultTextures.ts';
import Frame from '../client/renderer/frame/Frame.ts';
import Fog from '../client/renderer/scene/Fog.ts';
import SkyBox from '../client/renderer/scene/SkyBox.ts';
import Visibility from '../client/renderer/scene/Visibility.ts';
import S from '../client/Sound.ts';
import Sys from '../client/Sys.ts';
import FirstPersonView from '../client/view/FirstPersonView.ts';
import viewCvars from '../client/view/ViewCvars.ts';
import PlayerRollView from '../server/PlayerRollView.ts';
import ScreenFrame from '../client/screen/ScreenFrame.ts';
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
import ServerReloader from '../client/ServerReloader.ts';
import Cmd from '../common/Cmd.ts';
import PlatformWorker, { type PlatformWorkerHandle } from '../common/PlatformWorker.ts';
import workerFactories from '../common/WorkerFactories.ts';
import { eventBus } from '../common/EventBus.ts';
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
 * Starts the script of the server worker. A development build reads the bundle the watch build wrote last, past the
 * browser's cache (its entry keeps one name, see `vite.config.mjs`), which is what lets a reload see new code. A
 * production build uses the hashed file the bundler resolved.
 * @returns The new worker.
 */
function createServerWorkerScript(): PlatformWorkerHandle {
  if (!__DEV__) {
    return workerFactories['server/ServerWorker.ts']('server');
  }

  // Put together from parts so that the bundler does not take it for a worker import of its own.
  const url = new URL(['.', 'worker-ServerWorker.js'].join('/'), import.meta.url);
  url.searchParams.set('v', String(Date.now()));

  return new Worker(url, { name: 'server', type: 'module' });
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
    const worker = new PlatformWorker('server/ServerWorker.ts', createServerWorkerScript());

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
      publish: (name, ...args) => { eventBus.publishUntyped(name, ...args); },
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

    if (__DEV__) {
      // A development build can replace its server worker with one made from the bundle the watch build wrote last.
      const controller = clientStaticState.serverController as WorkerServerController;
      const reloader = new ServerReloader({
        controller,
        spawn: () => ({ worker: new PlatformWorker('server/ServerWorker.ts', createServerWorkerScript()), channel: new MessageChannel() }),
        attachChannel: (port) => { channelDriver!.replaceEndpoint(new MessagePortEndpoint(port)); },
        closePeers: () => { relay?.closeAll(); },
        capture: () => ClientHost.CaptureGame(),
        restore: (state, source) => ClientHost.RestoreGame(state, source),
        disconnect: () => { CL.Disconnect(); },
        startMap: (mapname) => { void Cmd.ExecuteString(`map ${mapname}`); },
        con: Con,
      });

      // the command table is rebuilt when the host initializes, which is after this
      eventBus.subscribe('host.ready', () => { Cmd.AddCommand('server_reload', reloader.createCommand()); });
    }
  } else {
    const runtime = createServerRuntime({ con: Con, sys: Sys, net, mod: Mod, com, host: Host, view: new PlayerRollView(viewCvars), gameEdition: () => editionOf(com) }, false);

    inThreadServer = runtime.sv;
    Host.serverHost = runtime.serverHost;
    clientStaticState.serverController = new InThreadServerController(runtime.sv, runtime.serverHost);
  }

  // The members that verification scripts in a browser reach for, see docs/browser-verification.md.
  (window as Window & { engine?: object }).engine = { CL, COM: com, Con, ConsoleOverlay, Host, Mod, NET: net, Sys, FirstPersonView, Key, S, Draw, R, Camera, Visibility, RenderStats, PostProcess, Frame, DefaultTextures, Fog, SkyBox, Particles, ParticleType, Decals, SpriteAssets, M, ScreenFrame, IN, SV: inThreadServer };

  await Sys.Init();
}

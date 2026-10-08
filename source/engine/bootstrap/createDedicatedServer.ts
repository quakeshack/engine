import type { BuildConfig } from '../build-config';

import * as WebSocketModule from 'ws';

import Con from '../common/Console.ts';
import Host from '../common/Host.ts';
import Mod from '../common/Mod.ts';
import NET from '../network/Network.ts';
import type Server from '../server/Server.ts';
import V from '../client/V.ts';
import NodeCOM from '../server/Com.ts';
import DedicatedSys from '../server/Sys.ts';
import { createServerRuntime } from './createServerRuntime.ts';
import DedicatedHost from './DedicatedHost.ts';
import { editionOf } from '../common/GameApiSupport.ts';

/**
 * Composition root of a dedicated server: builds the realm services (platform, console, files,
 * network), the server runtime on top of them, and starts the main loop.
 * @param buildConfig The build the server was made by.
 */
export async function createDedicatedServer(buildConfig?: BuildConfig): Promise<void> {
  console.info('Launching engine as dedicated server...');

  // hooking up all required components
  let com!: NodeCOM;
  let net!: NET;
  let sv!: Server;

  let dedicatedHost!: DedicatedHost;

  const sys = new DedicatedSys({ com: () => com, host: () => dedicatedHost, net: () => net });

  com = new NodeCOM({ con: Con, sys, buildConfig: () => buildConfig, urls: () => undefined });
  net = new NET({
    con: Con,
    sys,
    dedicated: true,
    urls: () => undefined,
    serverInfo: () => ({ maxPlayers: sv.svs.maxclients, mapname: sv.server.mapname!, game: com.game }),
    webSocketModule: () => WebSocketModule,
  });


  const runtime = createServerRuntime({ con: Con, sys, net, mod: Mod, com, host: Host, view: V, gameEdition: () => editionOf(com) }, true);

  sv = runtime.sv;
  Host.serverHost = runtime.serverHost;

  dedicatedHost = new DedicatedHost({
    com,
    net,
    sv,
    serverHost: runtime.serverHost,
    sys,
    view: V,
    urls: () => undefined,
    commitHash: buildConfig?.commitHash ?? undefined,
  });

  await sys.Init();
}

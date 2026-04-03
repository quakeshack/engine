import { Worker } from 'node:worker_threads';
import * as WebSocketModule from 'ws';

import Con from './common/Console.ts';
import Host from './common/Host.ts';
import Mod from './common/Mod.ts';
import NET from './network/Network.ts';
import { freeze as registryFreeze, registry } from './registry.mjs';
import V from './client/V.mjs';
import NodeCOM from './server/Com.ts';
import PR from './server/Progs.ts';
import SV from './server/Server.ts';
import Sys from './server/Sys.ts';

// Polyfill Worker global for Node.js so that WorkerFactories.ts
// (which uses the browser-compatible `new Worker(url)` pattern for
// Vite static analysis) works identically in unbundled Node.js.
globalThis.Worker = Worker as typeof globalThis.Worker;

export default class EngineLauncher {
  static async Launch(): Promise<typeof registry> {
    console.info('Launching engine as dedicated server...');

    // set some global flags
    registry.isDedicatedServer = true;

    // inject some external dependencies
    registry.WebSocket = WebSocketModule;

    // hooking up all required components
    registry.Sys = Sys;
    registry.COM = NodeCOM;
    registry.Con = Con;
    registry.Host = Host;
    registry.V = V;
    registry.NET = NET;
    registry.SV = SV;
    registry.PR = PR;
    registry.Mod = Mod;

    // registry is ready
    registryFreeze();

    await Sys.Init();

    return registry;
  }
}

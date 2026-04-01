
import { Worker } from 'node:worker_threads';
import { registry, freeze as registryFreeze } from './registry.mjs';

// Polyfill Worker global for Node.js so that WorkerFactories.mjs
// (which uses the browser-compatible `new Worker(url)` pattern for
// Vite static analysis) works identically in unbundled Node.js.
// @ts-ignore — Node.js worker_threads.Worker is API-compatible at runtime
globalThis.Worker = Worker;

import Sys from './server/Sys.mjs';
import NodeCOM from './server/Com.mjs';
import Con from './common/Console.mjs';
import Host from './common/Host.mjs';
import V from './client/V.mjs';
import NET from './network/Network.mjs';
import SV from './server/Server.mjs';
import PR from './server/Progs.mjs';
import Mod from './common/Mod.mjs';
import * as WebSocket from 'ws';
import InfluxMetrics from './server/telemetry/InfluxMetrics.mjs';

export default class EngineLauncher {
  static async Launch() {
    console.info('Launching engine as dedicated server...');

    // set some global flags
    registry.isDedicatedServer = true;

    // inject some external dependencies
    registry.WebSocket = WebSocket;

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

    // Optional telemetry integration (configured via influxdb_* cvars/env).
    InfluxMetrics.Install();

    // registry is ready
    registryFreeze();

    await Sys.Init();

    return registry;
  }
};

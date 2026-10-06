import type { BuildConfig } from './build-config';

import { Worker } from 'node:worker_threads';

import type { registry } from './registry.ts';
import { createDedicatedServer } from './bootstrap/createDedicatedServer.ts';

// Polyfill Worker global for Node.js so that WorkerFactories.ts
// (which uses the browser-compatible `new Worker(url)` pattern for
// Vite static analysis) works identically in unbundled Node.js.
globalThis.Worker = Worker as unknown as typeof globalThis.Worker;

export default class EngineLauncher {
  static async Launch(buildConfig?: BuildConfig): Promise<typeof registry> {
    return await createDedicatedServer(buildConfig);
  }
}

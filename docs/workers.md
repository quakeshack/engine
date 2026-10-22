# Workers

The engine has one worker abstraction, `PlatformWorker`, that works in Node.js (`worker_threads`) and in the browser (Web Workers).

The main thread and a worker talk by message passing over the event bus. The worker code listens for messages from the main thread, processes them and sends back responses. How the server uses this in the browser is described in [Server in a Web Worker](server-worker.md).

## Key files

- `source/engine/common/PlatformWorker.ts`: the single worker wrapper. It detects the platform at module load and normalizes message, error and shutdown APIs.
- `source/engine/common/WorkerFactories.ts`: maps worker names to factory functions using the `new Worker(new URL(...))` pattern for Vite's static analysis. New workers **must** be registered here.
- `source/engine/common/WorkerManager.ts`: the orchestrator that spawns workers and bridges the event bus between the main thread and the worker threads.
- `source/engine/common/WorkerFramework.ts`: the bootstrap code that runs **inside** a worker thread. It sets up the console delegate, the file services and the message bridge.

## Adding a new worker

1. Create the worker script in `source/engine/server/` (see `DummyWorker.ts` for an example). The filename **must** end in `Worker.ts`.
2. Register it in `WorkerFactories.ts` with a `new Worker(new URL(...))` factory.

The dedicated build discovers `*Worker.ts` files on its own and bundles them into `dist/dedicated/workers/` in a second Rollup pass (`dedicatedWorkerBundlePlugin` in `vite.config.dedicated.mjs`).

## How the Worker global works in Node.js

The dedicated server entry (`source/engine/main-dedicated.ts`) polyfills `globalThis.Worker` with `worker_threads.Worker`, so `WorkerFactories.ts` can use the same `new Worker(url, opts)` constructor on every platform.

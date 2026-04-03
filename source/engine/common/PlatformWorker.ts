import { eventBus, getCommonRegistry } from '../registry.mjs';
import { BaseWorker, type WorkerMessageListener } from './Sys.ts';

let { Host } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ Host } = getCommonRegistry());
});

const isNode = typeof process !== 'undefined' && process.versions?.node !== undefined;

export interface WorkerMessageEnvelope {
  readonly event: string;
  readonly data?: unknown[];
  readonly args?: unknown[];
}

type NodeLikeWorker = {
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
};

type BrowserLikeWorker = {
  addEventListener(event: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(event: 'error', listener: (event: ErrorEvent) => void): void;
  postMessage(message: unknown): void;
  terminate(): void;
};

export type PlatformWorkerHandle = NodeLikeWorker | BrowserLikeWorker;
export type WorkerFactory = (name: string) => PlatformWorkerHandle;
export type WorkerFactoryRegistry = Record<string, WorkerFactory>;

/**
 * Unified worker wrapper that works on both Node.js and browser environments.
 *
 * In Node.js, it wraps a `worker_threads.Worker` (event emitter API).
 * In the browser, it wraps a Web Worker (DOM event target API).
 *
 * Platform differences (message unwrapping, error subscription, terminate
 * semantics) are detected once at module load via `isNode` and handled
 * transparently.
 *
 * Receives an already-constructed Worker instance to avoid importing
 * WorkerFactories (which would create a circular dependency through
 * worker scripts that transitively import this module).
 */
export default class PlatformWorker extends BaseWorker {
  #worker: PlatformWorkerHandle | null = null;

  constructor(name: string, worker: PlatformWorkerHandle) {
    super(name);

    this.#worker = worker;
    this.#setupErrorHandler();
  }

  #setupErrorHandler() {
    const worker = this.#worker;

    if (worker === null) {
      return;
    }

    if (isNode) {
      (worker as NodeLikeWorker).on('error', (error) => {
        console.error(`PlatformWorker ${this.name} error: ${error.message}`);

        void this.shutdown();

        Host.HandleCrash(error);
      });
    } else {
      (worker as BrowserLikeWorker).addEventListener('error', (error) => {
        const detail = error.message || error.filename || '(no details)';

        console.error(`PlatformWorker ${this.name} error: ${detail}`, error);

        void this.shutdown();

        Host.HandleCrash(error);
      });
    }
  }

  addOnMessageListener(listener: WorkerMessageListener) {
    const worker = this.#worker;

    if (worker === null) {
      return;
    }

    if (isNode) {
      (worker as NodeLikeWorker).on('message', (data) => {
        listener(data);
      });
    } else {
      (worker as BrowserLikeWorker).addEventListener('message', (event) => {
        listener(event.data);
      });
    }
  }

  postMessage(message: unknown) {
    this.#worker?.postMessage(message);
  }

  async shutdown() {
    for (const listener of this._shutdownListeners) {
      listener();
    }

    this._shutdownListeners.length = 0;

    const worker = this.#worker;
    this.#worker = null;

    if (worker === null) {
      return;
    }

    await worker.terminate();
  }
}

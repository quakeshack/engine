import { registry, eventBus } from '../registry.mjs';
import { BaseWorker } from './Sys.mjs';

let { Host } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ Host } = registry);
});

/** @type {boolean} */
const isNode = typeof process !== 'undefined' && process.versions?.node !== null;  

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
  /**
   * @type {Worker}
   * @description In Node.js this is a `worker_threads.Worker` (EventEmitter API);
   * in the browser it is a standard Web Worker (EventTarget API).
   */
  #worker = null;

  /**
   * @param {string} name worker script name
   * @param {Worker} worker pre-constructed Worker instance
   */
  constructor(name, worker) {
    super(name);

    this.#worker = worker;
    this.#setupErrorHandler();
  }

  #setupErrorHandler() {
    if (isNode) {
      // @ts-ignore — Node.js Worker uses EventEmitter API (.on), not EventTarget
      this.#worker.on('error', (e) => {
        console.error(`PlatformWorker ${this.name} error: ${e.message}`);

        void this.shutdown();

        Host.HandleCrash(e);
      });
    } else {
      this.#worker.addEventListener('error', (e) => {
        const detail = e?.message || e?.filename || '(no details)';

        console.error(`PlatformWorker ${this.name} error: ${detail}`, e);

        void this.shutdown();

        Host.HandleCrash(e);
      });
    }
  }

  addOnMessageListener(listener) {
    if (isNode) {
      // @ts-ignore — Node.js Worker uses EventEmitter API (.on), not EventTarget
      this.#worker.on('message', (data) => {
        listener(data);
      });
    } else {
      this.#worker.addEventListener('message', (e) => {
        listener(e.data);
      });
    }
  }

  postMessage(message) {
    this.#worker.postMessage(message);
  }

  async shutdown() {
    for (const listener of this._shutdownListeners) {
      listener();
    }

    this._shutdownListeners.length = 0;

    // Node.js Worker.terminate() returns a Promise; browser Worker.terminate() does not.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await this.#worker.terminate();

    this.#worker = null;
  }
}

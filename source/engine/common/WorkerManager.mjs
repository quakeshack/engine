import { registry, eventBus } from '../registry.mjs';
import { SysError } from './Errors.ts';
import PlatformWorker from './PlatformWorker.mjs';

let { Con, COM } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
});

export default class WorkerManager {
  /** @type {Record<string, (name: string) => Worker>} */
  static #factories = null;

  /**
   * Initializes the worker manager with the worker factory registry.
   *
   * Factories are passed in at runtime (rather than statically imported)
   * to avoid a circular module dependency: worker scripts transitively
   * import WorkerManager via Navigation.mjs, and WorkerFactories.mjs
   * references those same worker scripts.
   * @param {Record<string, (name: string) => Worker>} factories worker factory map from WorkerFactories.mjs
   */
  static Init(factories) {
    WorkerManager.#factories = factories;
    // eventBus.subscribe('com.ready', () => {
    //   console.info('WorkerManager: Spawning dummy worker for initialization test.');

    //   const worker = this.SpawnWorker('server/DummyWorker.mjs', ['worker.test', 'worker.busy', 'worker.error']);

    //   const sab = new SharedArrayBuffer(4);

    //   new Uint8Array(sab)[0] = 42;

    //   setTimeout(() => {
    //     eventBus.publish('worker.test', sab);
    //   }, 1000);

    //   // void worker.shutdown();
    // });
  }

  /**
   * Spawns a worker thread and sets up event forwarding.
   * @param {string} script Path to worker script (must be registered in WorkerFactories.mjs)
   * @param {string[]} events list of events the worker wants to subscribe to
   * @returns {PlatformWorker} worker thread wrapper
   */
  static SpawnWorker(script, events) {
    const factory = WorkerManager.#factories[script];

    console.assert(factory, `No worker factory found for script "${script}". Make sure it's registered in WorkerFactories.mjs.`);

    let rawWorker;
    try {
      rawWorker = factory(script);
    } catch (e) {
      console.error(`WorkerManager: failed to create worker "${script}":`, e);
      throw new SysError(`Worker ${script}: failed to construct: ${e.message}`);
    }

    const worker = new PlatformWorker(script, rawWorker);

    // worker thread --> main thread
    worker.addOnMessageListener(({ event, data }) => {
      // Handle special events directly, otherwise publish to event bus
      switch (event) {
        case 'worker.con.print':
          Con.Print(data[0]);
          break;

        case 'worker.con.print.success':
          Con.PrintSuccess(data[0]);
          break;

        case 'worker.con.print.warning':
          Con.PrintWarning(data[0]);
          break;

        case 'worker.con.print.error':
          Con.PrintError(data[0]);
          break;

        case 'worker.con.dprint':
          Con.DPrint(data[0]);
          break;

        default:
          eventBus.publish(event, ...data);
          break;
      }
    });

    /** @type {Function[]} all subscribed events need to be unsubscribed once the worker finished */
    const unsubscribeFunctions = [];

    // make sure all subscriptions are removed on shutdown
    worker.addOnShutdownListener(() => {
      for (const unsubscribe of unsubscribeFunctions) {
        unsubscribe();
      }

      unsubscribeFunctions.length = 0;
    });

    // main thread --> worker thread
    for (const event of events) {
      unsubscribeFunctions.push(eventBus.subscribe(event, (...args) => {
        worker.postMessage({
          event,
          args,
        });
      }));
    }

    // tell the worker that it can initialize now
    worker.postMessage({
      event: 'worker.framework.init',
      args: [
        [COM.searchpaths, COM.gamedir, COM.game], // COM
        registry.urls, // urls
      ],
    });

    return worker;
  }
};


import { registry, eventBus, getCommonRegistry } from '../registry.mjs';
import { SysError } from './Errors.ts';
import PlatformWorker, { type WorkerFactoryRegistry, type WorkerMessageEnvelope } from './PlatformWorker.ts';

let { Con, COM } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con } = getCommonRegistry());
});

type WorkerFrameworkInitArgs = [
  [typeof COM.searchpaths, typeof COM.gamedir, typeof COM.game],
  typeof registry.urls,
];

type WorkerOutboundEnvelope = {
  readonly event: string;
  readonly args: unknown[];
};

export default class WorkerManager {
  static #factories: WorkerFactoryRegistry | null = null;

  /**
   * Initializes the worker manager with the worker factory registry.
   *
   * Factories are passed in at runtime (rather than statically imported)
   * to avoid a circular module dependency: worker scripts transitively
   * import WorkerManager via Navigation.mjs, and WorkerFactories.ts
   * references those same worker scripts.
   */
  static Init(factories: WorkerFactoryRegistry) {
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
   * @returns worker thread wrapper
   */
  static SpawnWorker(script: string, events: string[]): PlatformWorker {
    const factory = WorkerManager.#factories?.[script];

    console.assert(factory, `No worker factory found for script "${script}". Make sure it's registered in WorkerFactories.ts.`);

    if (factory === undefined) {
      throw new SysError(`Worker ${script}: no registered factory`);
    }

    let rawWorker;
    try {
      rawWorker = factory(script);
    } catch (error) {
      console.error(`WorkerManager: failed to create worker "${script}":`, error);
      const message = error instanceof Error ? error.message : String(error);
      throw new SysError(`Worker ${script}: failed to construct: ${message}`);
    }

    const worker = new PlatformWorker(script, rawWorker);

    // worker thread --> main thread
    worker.addOnMessageListener((message: unknown) => {
      const { event, data = [] } = message as WorkerMessageEnvelope;

      // Handle special events directly, otherwise publish to event bus
      switch (event) {
        case 'worker.con.print':
          Con.Print(String(data[0] ?? ''));
          break;

        case 'worker.con.print.success':
          Con.PrintSuccess(String(data[0] ?? ''));
          break;

        case 'worker.con.print.warning':
          Con.PrintWarning(String(data[0] ?? ''));
          break;

        case 'worker.con.print.error':
          Con.PrintError(String(data[0] ?? ''));
          break;

        case 'worker.con.dprint':
          Con.DPrint(String(data[0] ?? ''));
          break;

        default:
          eventBus.publish(event, ...data);
          break;
      }
    });

    const unsubscribeFunctions: Array<() => void> = [];

    // make sure all subscriptions are removed on shutdown
    worker.addOnShutdownListener(() => {
      for (const unsubscribe of unsubscribeFunctions) {
        unsubscribe();
      }

      unsubscribeFunctions.length = 0;
    });

    // main thread --> worker thread
    for (const event of events) {
      unsubscribeFunctions.push(eventBus.subscribe(event, (...args: unknown[]) => {
        const payload: WorkerOutboundEnvelope = {
          event,
          args,
        };
        worker.postMessage(payload);
      }));
    }

    const initArgs: WorkerFrameworkInitArgs = [
      [COM.searchpaths, COM.gamedir, COM.game], // COM
      registry.urls, // urls
    ];

    // tell the worker that it can initialize now
    worker.postMessage({
      event: 'worker.framework.init',
      args: initArgs,
    });

    return worker;
  }
}

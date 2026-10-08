import type { URLs } from '../build-config';
import type { ConsoleOutput } from './Services.ts';

import Con from './Console.ts';
import W from './W.ts';
import { eventBus } from './EventBus.ts';
import Mod from './Mod.ts';
import Sys from './Sys.ts';
import COM, { type ComDependencies, type SearchPath } from './Com.ts';

type WorkerConsoleMessage = string;

type WorkerPortMessage = {
  readonly event: string;
  readonly args: unknown[];
};

type WorkerPublishMessage = {
  readonly event: string;
  readonly data: unknown[];
};

type WorkerFrameworkPort = {
  postMessage(message: WorkerPublishMessage): void;
  addEventListener?(event: 'message', listener: (event: MessageEvent<WorkerPortMessage>) => void): void;
  on?(event: 'message', listener: (message: WorkerPortMessage) => void): void;
};

/** The services a worker script gets from its framework, instead of looking them up in a registry. */
export interface WorkerServices {
  readonly con: typeof WorkerConsole;
  readonly com: COM;
}

type WorkerFrameworkInitPayload = [SearchPath[], SearchPath[] | null, string];

class WorkerConsole {
  static Print(message: WorkerConsoleMessage) {
    WorkerFramework.Publish('worker.con.print', message);
  }

  static PrintError(message: WorkerConsoleMessage) {
    WorkerFramework.Publish('worker.con.print.error', message);
  }

  static PrintWarning(message: WorkerConsoleMessage) {
    WorkerFramework.Publish('worker.con.print.warning', message);
  }

  static PrintSuccess(message: WorkerConsoleMessage) {
    WorkerFramework.Publish('worker.con.print.success', message);
  }

  static DPrint(message: WorkerConsoleMessage) {
    WorkerFramework.Publish('worker.con.dprint', message);
  }
}

class WorkerSys extends Sys {
  static Print(message: string) {
    console.info(message);
  }

  static FloatTime(): number {
    return Date.now() / 1000;
  }
}

/** The file system of a browser worker, which shares its files with the main thread through Cache Storage and IndexedDB. */
class WorkerCOM extends COM {}

/**
 * Worker Framework
 *
 * Initializes the worker framework, setting up the event bus.
 * Listens for messages from the parent thread and publishes them to the event bus.
 *
 * Also prepares lean versions of Con, Sys, and COM for use within the worker.
 *
 * Usage: `await WorkerFramework.Init();` at the top of the worker script.
 */
export default class WorkerFramework {
  static port: WorkerFrameworkPort | null = null;

  static #InitModules(workerCom: COM) {
    W.files = workerCom;

    // What the shared parts of the engine print in this realm goes to the console of the main thread.
    Con.useDelegate({
      Print: (message) => { WorkerConsole.Print(message); },
      PrintSuccess: (message) => { WorkerConsole.PrintSuccess(message); },
      PrintWarning: (message) => { WorkerConsole.PrintWarning(message); },
      PrintError: (message) => { WorkerConsole.PrintError(message); },
      DPrint: (message) => { WorkerConsole.DPrint(message); },
      StartCapturing() {},
      StopCapturing: () => '',
    });

    Mod.Init({ files: workerCom, con: WorkerConsole as unknown as ConsoleOutput, loadRenderData: false });
  }

  /**
   * Boots the worker realm.
   * @returns The realm services a worker script is built from.
   */
  static async Init(): Promise<WorkerServices> {
    let workerCom: COM;

    // The URLs are sent by the main thread once the worker is up, see `worker.framework.init`.
    const urls = {} as URLs;

    const comDependencies: ComDependencies = {
      con: WorkerConsole,
      sys: WorkerSys,
      buildConfig: () => undefined,
      urls: () => urls,
    };

    const isNode = typeof process !== 'undefined' && process.versions !== undefined && process.versions.node !== undefined;

    if (isNode) {
      // Paths constructed at runtime so Vite's worker bundler cannot
      // statically resolve them (it ignores @vite-ignore in its
      // separate Rollup pass). These modules are Node.js-only.
      const workerThreadsId = ['node', 'worker_threads'].join(':');
      const { parentPort } = await import(/* @vite-ignore */ workerThreadsId);
      this.port = parentPort as WorkerFrameworkPort;
      const serverComId = ['..', 'server', 'Com.ts'].join('/');
      const comModule = await import(/* @vite-ignore */ serverComId);
      workerCom = new (comModule.default as typeof COM)(comDependencies);

      this.port.on?.('message', ({ event, args }) => {
        const eventArgs = Array.isArray(args) ? args as Array<Parameters<typeof eventBus.publish>[1]> : [];
        eventBus.publish(event, ...eventArgs);
      });
    } else {
      this.port = self as unknown as WorkerFrameworkPort;
      workerCom = new WorkerCOM(comDependencies);

      this.port.addEventListener?.('message', (event) => {
        const { event: eventName, args } = event.data;
        const eventArgs = Array.isArray(args) ? args as Array<Parameters<typeof eventBus.publish>[1]> : [];
        eventBus.publish(eventName, ...eventArgs);
      });
    }

    this.#InitModules(workerCom);

    eventBus.subscribe('worker.framework.init', (comParams: WorkerFrameworkInitPayload, receivedUrls: URLs | undefined) => {
      workerCom.searchpaths = comParams[0];
      workerCom.gamedir = comParams[1];
      workerCom.game = comParams[2];

      // Inside a browser worker this opens the same Cache Storage and IndexedDB as the main thread.
      void workerCom.InitStorage();

      Object.assign(urls, receivedUrls ?? {});
    });

    console.debug('Worker Framework initialized.');

    return { con: WorkerConsole, com: workerCom };
  }

  static Publish(event: string, ...data: unknown[]) {
    this.port?.postMessage({ event, data });
  }
}

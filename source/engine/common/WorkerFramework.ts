import type { URLs } from '../build-config';

import { eventBus, registry } from '../registry.mjs';
import Mod from './Mod.ts';
import Sys from './Sys.ts';
import COM, { type SearchPath } from './Com.ts';

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

class WorkerCOM extends COM {
  // TODO: implement the COM stuff here for workers to share files etc.
}

/**
 * Worker Framework
 *
 * Initializes the worker framework, setting up the registry and event bus.
 * Listens for messages from the parent thread and publishes them to the event bus.
 *
 * Also prepares lean versions of Con, Sys, and COM for use within the worker.
 *
 * Usage: `await WorkerFramework.Init();` at the top of the worker script.
 */
export default class WorkerFramework {
  static port: WorkerFrameworkPort | null = null;

  static #InitRegistry(workerCom: typeof COM) {
    registry.isDedicatedServer = true;
    registry.isInsideWorker = true;
    registry.Con = WorkerConsole as typeof registry.Con;
    registry.Sys = WorkerSys;
    registry.COM = workerCom;
    registry.Mod = Mod;

    registry.urls = {} as URLs; // will be set later

    eventBus.publish('registry.frozen');
  }

  static #InitModules() {
    Mod.Init();
  }

  static async Init() {
    let workerCom: typeof COM;

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
      workerCom = comModule.default as typeof COM;

      this.port.on?.('message', ({ event, args }) => {
        eventBus.publish(event, ...args);
      });
    } else {
      this.port = self as unknown as WorkerFrameworkPort;
      workerCom = WorkerCOM;

      this.port.addEventListener?.('message', (event) => {
        const { event: eventName, args } = event.data;
        eventBus.publish(eventName, ...args);
      });
    }

    this.#InitRegistry(workerCom);
    this.#InitModules();

    eventBus.subscribe('worker.framework.init', (comParams: WorkerFrameworkInitPayload, urls: URLs | undefined) => {
      workerCom.searchpaths = comParams[0];
      workerCom.gamedir = comParams[1];
      workerCom.game = comParams[2];

      Object.assign(registry.urls ?? (registry.urls = {} as URLs), urls ?? {});
    });

    console.debug('Worker Framework initialized.');
  }

  static Publish(event: string, ...data: unknown[]) {
    this.port?.postMessage({ event, data });
  }
}

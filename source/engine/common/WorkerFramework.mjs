import { eventBus, registry } from '../registry.mjs';
import Mod from './Mod.mjs';
import Sys from './Sys.mjs';
import COM from './Com.ts';

class WorkerConsole {
  static Print(message) {
    WorkerFramework.Publish('worker.con.print', message);
  }

  static PrintError(message) {
    WorkerFramework.Publish('worker.con.print.error', message);
  }

  static PrintWarning(message) {
    WorkerFramework.Publish('worker.con.print.warning', message);
  }

  static PrintSuccess(message) {
    WorkerFramework.Publish('worker.con.print.success', message);
  }

  static DPrint(message) {
    WorkerFramework.Publish('worker.con.dprint', message);
  }
}

class WorkerSys extends Sys {
  static Print(message) {
    console.info(message);
  }

  static FloatTime() {
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
  static port = null;

  static #InitRegistry(COM) {
    registry.isDedicatedServer = true;
    registry.isInsideWorker = true;
    registry.Con = WorkerConsole;
    registry.Sys = WorkerSys;
    registry.COM = COM;
    registry.Mod = Mod;

    registry.urls = {}; // will be set later

    eventBus.publish('registry.frozen');
  }

  static #InitModules() {
    Mod.Init();
  }

  static async Init() {
    let COM;

    const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

    if (isNode) {
      // Paths constructed at runtime so Vite's worker bundler cannot
      // statically resolve them (it ignores @vite-ignore in its
      // separate Rollup pass). These modules are Node.js-only.
      const workerThreadsId = ['node', 'worker_threads'].join(':');
      const { parentPort } = await import(/* @vite-ignore */ workerThreadsId);
      this.port = parentPort;
      const serverComId = ['..', 'server', 'Com.mjs'].join('/');
      const comModule = await import(/* @vite-ignore */ serverComId);
      COM = comModule.default;

      this.port.on('message', ({ event, args }) => {
        eventBus.publish(event, ...args);
      });
    } else {
      this.port = self;
      COM = WorkerCOM;

      this.port.addEventListener('message', (e) => {
        const { event, args } = e.data;
        eventBus.publish(event, ...args);
      });
    }

    this.#InitRegistry(COM);
    this.#InitModules();

    eventBus.subscribe('worker.framework.init', (comParams, urls) => {
      COM.searchpaths = comParams[0];
      COM.gamedir = comParams[1];
      COM.game = comParams[2];

      Object.assign(registry.urls, urls);
    });

    console.debug('Worker Framework initialized.');
  }

  static Publish(event, ...data) {
    this.port.postMessage({ event, data });
  }
};

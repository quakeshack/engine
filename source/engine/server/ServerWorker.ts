import type { ServerWorkerBoot } from '../common/ServerWorkerProtocol.ts';

import { createServerWorker } from '../bootstrap/createServerWorker.ts';
import COM from '../common/Com.ts';
import type { WorkerFactoryRegistry } from '../common/PlatformWorker.ts';

/*
 * Entry of the worker that runs the server of a browser game. The main thread sends one boot message
 * with a port and the settings; from then on the control messages and the game packets travel over
 * that port, see `createServerWorker`.
 */

// The workers this worker starts itself. It has its own list so that the server worker does not have
// to pull in the one of the main thread, which contains this very worker.
const workerFactories: WorkerFactoryRegistry = {
  'server/NavigationWorker.ts': (name) => new Worker(new URL('./NavigationWorker.ts', import.meta.url), { name, type: 'module' }),
};

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<ServerWorkerBoot>) => void): void;
};

scope.addEventListener('message', (event) => {
  const boot = event.data;

  if (boot?.event !== 'server.worker.boot') {
    return;
  }

  createServerWorker({
    port: boot.port,
    sys: {
      Print: (text) => { console.info(text); },
      FloatTime: () => Date.now() / 1000,
    },
    createCom: (dependencies) => new COM(dependencies),
    workerFactories,
  }, boot.init).catch((error: unknown) => {
    console.error('Server worker failed to boot:', error);

    boot.port.postMessage({
      control: {
        kind: 'crash',
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  });
});

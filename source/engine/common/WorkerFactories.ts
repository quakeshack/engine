import type { WorkerFactoryRegistry } from './PlatformWorker.ts';

/**
 * Add new worker scripts here when creating additional workers.
 */
const workerFactories: WorkerFactoryRegistry = {
  'server/DummyWorker.ts': (name) => new Worker(new URL('../server/DummyWorker.ts', import.meta.url), { name, type: 'module' }),
  'server/NavigationWorker.ts': (name) => new Worker(new URL('../server/NavigationWorker.ts', import.meta.url), { name, type: 'module' }),
};

export default workerFactories;

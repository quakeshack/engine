import type { WorkerFactoryRegistry } from './PlatformWorker.ts';

/**
 * Add new worker scripts here when creating additional workers.
 */
const workerFactories: WorkerFactoryRegistry = {
  'server/DummyWorker.mjs': (name) => new Worker(new URL('../server/DummyWorker.mjs', import.meta.url), { name, type: 'module' }),
  'server/NavigationWorker.mjs': (name) => new Worker(new URL('../server/NavigationWorker.mjs', import.meta.url), { name, type: 'module' }),
};

export default workerFactories;

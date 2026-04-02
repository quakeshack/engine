import WorkerFramework from '../common/WorkerFramework.ts';
import { eventBus, registry } from '../registry.mjs';

await WorkerFramework.Init();

const { Con } = registry;

eventBus.subscribe('worker.test', (message) => {
  if (message) {
    Con.Print(`Reading back: ${message}\n`);
  }

  Con.Print('Dummy Worker reporting back!\n');
});

eventBus.subscribe('worker.busy', (timeInMillis) => {
  const start = Date.now();

  let number = 0;

  while (Date.now() - start < +timeInMillis) {
    // Busy wait
    number += Math.sqrt(Math.random());
  }

  Con.Print(`Dummy Worker finished busy work of ${timeInMillis} ms, calculated number: ${number}\n`);
});

eventBus.subscribe('worker.error', () => {
  throw new Error('This is a test error from the Dummy Worker!');
});

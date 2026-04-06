import WorkerFramework from '../common/WorkerFramework.ts';
import { eventBus, getCommonRegistry } from '../registry.ts';

await WorkerFramework.Init();

const { Con } = getCommonRegistry();

eventBus.subscribe('worker.test', (message: string | null) => {
  if (message) {
    Con.Print(`Reading back: ${message}\n`);
  }

  Con.Print('Dummy Worker reporting back!\n');
});

eventBus.subscribe('worker.busy', (timeInMillis: number | string) => {
  const start = Date.now();
  const duration = Number(timeInMillis);
  let number = 0;

  while (Date.now() - start < duration) {
    // Busy wait
    number += Math.sqrt(Math.random());
  }

  Con.Print(`Dummy Worker finished busy work of ${duration} ms, calculated number: ${number}\n`);
});

eventBus.subscribe('worker.error', () => {
  throw new Error('This is a test error from the Dummy Worker!');
});

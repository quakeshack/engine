import WorkerFramework from '../common/WorkerFramework.ts';
import { eventBus } from '../common/EventBus.ts';

import { Navigation, NavMeshOutOfDateException } from './Navigation.ts';
import type { EventPosition } from '../../shared/EngineEvents.ts';
import Vector from '../../shared/Vector.ts';

const { con: Con, com } = await WorkerFramework.Init();
const navigation = new Navigation(null, { con: Con, files: com, sv: null });

// eslint-disable-next-line @typescript-eslint/no-misused-promises
eventBus.subscribe('nav.load', async (mapname: string, checksum: number | null) => {
  Con.DPrint('Navigation: loading navigation graph...\n');

  try {
    await navigation.load(mapname, checksum);

    Con.DPrint('Navigation: navigation graph loaded on worker thread!\n');
  } catch (error) {
    // unusable navmesh, have the server thread rebuild it; its save publishes nav.load again
    if (error instanceof NavMeshOutOfDateException) {
      Con.PrintWarning(`Navigation: navmesh is out of date (${error.reason}), rebuilding\n`);
      WorkerFramework.Publish('nav.build');
    }
  }
});

eventBus.subscribe('nav.path.request', (id: string, start: EventPosition, end: EventPosition) => {
  const path = navigation.findPath(
    new Vector(start[0], start[1], start[2]),
    new Vector(end[0], end[1], end[2]),
  );

  WorkerFramework.Publish('nav.path.response', id, path);
});

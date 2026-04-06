import WorkerFramework from '../common/WorkerFramework.ts';
import { eventBus, getCommonRegistry } from '../registry.ts';

import { Navigation, NavMeshOutOfDateException } from './Navigation.ts';
import Vector from '../../shared/Vector.ts';

type WorkerVectorLike = ArrayLike<number>;

await WorkerFramework.Init();

const { Con } = getCommonRegistry();
const navigation = new Navigation(null);

// eslint-disable-next-line @typescript-eslint/no-misused-promises
eventBus.subscribe('nav.load', async (mapname: string, checksum: number | null) => {
  Con.DPrint('Navigation: loading navigation graph...\n');

  try {
    await navigation.load(mapname, checksum);

    Con.DPrint('Navigation: navigation graph loaded on worker thread!\n');
  } catch (error) {
    // unusable navmesh, trigger a rebuild
    if (error instanceof NavMeshOutOfDateException) {
      WorkerFramework.Publish('nav.build');
    }
  }
});

eventBus.subscribe('nav.path.request', (id: string, start: WorkerVectorLike, end: WorkerVectorLike) => {
  const path = navigation.findPath(
    new Vector(start[0], start[1], start[2]),
    new Vector(end[0], end[1], end[2]),
  );

  WorkerFramework.Publish('nav.path.response', id, path);
});

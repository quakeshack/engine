import WorkerFramework from '../common/WorkerFramework.mjs';
import { eventBus, registry } from '../registry.mjs';

import { Navigation, NavMeshOutOfDateException } from './Navigation.mjs';
import Vector from '../../shared/Vector.ts';

await WorkerFramework.Init();

const { Con } = registry;

const navigation = new Navigation();

eventBus.subscribe('nav.load', async (mapname, checksum) => {
  Con.DPrint('Navigation: loading navigation graph...\n');

  try {
    await navigation.load(mapname, checksum);

    Con.DPrint('Navigation: navigation graph loaded on worker thread!\n');
  } catch (e) {
    // unusable navmesh, trigger a rebuild
    if (e instanceof NavMeshOutOfDateException) {
      WorkerFramework.Publish('nav.build');
    }
  }
});

eventBus.subscribe('nav.path.request', (id, start, end) => {
  const path = navigation.findPath(new Vector(...start), new Vector(...end));

  WorkerFramework.Publish('nav.path.response', id, path);
});


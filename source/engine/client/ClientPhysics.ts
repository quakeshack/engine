import { Pmove } from '../common/Pmove.ts';
import CollisionModelSource from '../common/CollisionModelSource.ts';
import ClientCollision from './ClientCollision.ts';
import { clientRuntimeState } from './ClientState.ts';

const clientCollisionModelSource = new CollisionModelSource();

clientCollisionModelSource.configureClient({
  getWorldModel: () => clientRuntimeState.worldmodel,
  getModels: () => clientRuntimeState.model_precache,
});

/** Player movement as the client predicts it, with the movement variables the server sent. */
export const clientPmove = new Pmove();

/** Static-world collision against the client's own world model, never the server's. */
export const clientCollision = new ClientCollision(clientCollisionModelSource);

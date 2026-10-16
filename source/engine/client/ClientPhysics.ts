import { Pmove } from '../common/Pmove.ts';
import ClientCollision from './ClientCollision.ts';
import ClientCollisionModelSource from './ClientCollisionModelSource.ts';
import { clientRuntimeState } from './ClientState.ts';

/** Player movement as the client predicts it, with the movement variables the server sent. */
export const clientPmove = new Pmove();

/** Static-world collision against the client's own world model, never the server's. */
export const clientCollision = new ClientCollision(new ClientCollisionModelSource(() => clientRuntimeState));

import type { ServerEdict } from '../server/Edict.ts';
import type { BaseModel } from './model/BaseModel.ts';
import type { BrushModel } from './model/BSP.ts';

/**
 * Where collision code gets the world and the models from.
 *
 * Each realm has its own: the server's answers from the server's models (`ServerCollisionModelSource`), the page's
 * from what the client loaded for the current map (`ClientCollisionModelSource`). They never look into each other,
 * so a server in a worker, in this thread or on its own sees the same thing, and the static-world helpers of
 * `ServerCollision` (`traceStaticWorldLine`, `pointContents`, ...) answer for the world of whichever realm they were
 * built for.
 */
export interface CollisionModelSource {
  /**
   * Returns the entity of the static world, which a trace result points to when it hits the world.
   * @returns The world entity, or null when this realm has none (a client has no entities of the server, and a server
   * has none before a map is loaded). Callers treat null as "no entity to attach to the result", not as an error.
   */
  getWorldEntity(): ServerEdict | null;

  /**
   * Returns the static-world model of this realm.
   * @returns The world model, or null while no map is loaded.
   */
  getWorldModel(): BrushModel | null;

  /**
   * Resolves a model by its precache index in this realm.
   * @returns The model, or null when the slot is empty or the model is still loading.
   */
  getModelByIndex(modelIndex: number): BaseModel | null;
}

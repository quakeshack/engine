import type { BaseModel } from '../common/model/BaseModel.ts';
import type { BrushModel } from '../common/model/BSP.ts';
import type { CollisionModelSource } from '../common/CollisionModelSource.ts';
import type { ServerEdict } from '../server/Edict.ts';

import { ModelType } from '../common/Mod.ts';

/** The part of the client's state that its collision model source reads. */
interface ClientModelState {
  readonly worldmodel: BrushModel | null;
  readonly model_precache: readonly BaseModel[];
}

/**
 * The world and models the client loaded for the current map, whether the server is in a worker, in this thread or on
 * another machine. It never looks at a server.
 */
export class ClientCollisionModelSource implements CollisionModelSource {
  readonly #state: () => ClientModelState;

  /**
   * Takes the state as a getter instead of importing it: the page's physics module builds this while the client state
   * is still being evaluated, and neither an import nor the value itself exists yet at that point.
   * @param state - returns the client's runtime state, called at every use because a map change replaces what it holds
   */
  constructor(state: () => ClientModelState) {
    this.#state = state;
  }

  /**
   * A client has no entities of the server to attach to a trace result.
   * @returns Always null.
   */
  getWorldEntity(): ServerEdict | null {
    return null;
  }

  /**
   * @returns The client's world model; while it is not set yet the first precached model if that is a brush model, which is the world.
   */
  getWorldModel(): BrushModel | null {
    const state = this.#state();

    if (state.worldmodel !== null) {
      return state.worldmodel;
    }

    const precachedWorld = state.model_precache[1] ?? null;

    return precachedWorld !== null && precachedWorld.type === ModelType.brush ? precachedWorld as BrushModel : null;
  }

  getModelByIndex(modelIndex: number): BaseModel | null {
    return this.#state().model_precache[modelIndex] ?? null;
  }
}

export default ClientCollisionModelSource;

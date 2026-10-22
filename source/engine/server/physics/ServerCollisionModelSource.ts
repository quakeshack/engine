import type { BaseModel } from '../../common/model/BaseModel.ts';
import type { BrushModel } from '../../common/model/BSP.ts';
import type { CollisionModelSource } from '../../common/CollisionModelSource.ts';
import type { ServerEdict } from '../Edict.ts';

/** The part of a server's state that its collision model source reads. */
interface ServerModelState {
  readonly server: {
    readonly edicts: ServerEdict[];
    readonly worldmodel: BrushModel | null;
    readonly models: Array<BaseModel | null | Promise<BaseModel | null>>;
  };
}

/**
 * The world and models of a server, as the server itself holds them. It never looks at a client, there is none in
 * a server worker, and in the same thread the client's copy of the map is not the server's.
 */
export class ServerCollisionModelSource implements CollisionModelSource {
  readonly #sv: ServerModelState;

  /**
   * @param sv - the server whose map and models are answered from, read at every call because a map change replaces them
   */
  constructor(sv: ServerModelState) {
    this.#sv = sv;
  }

  getWorldEntity(): ServerEdict | null {
    return this.#sv.server.edicts[0] ?? null;
  }

  getWorldModel(): BrushModel | null {
    return this.#sv.server.worldmodel;
  }

  getModelByIndex(modelIndex: number): BaseModel | null {
    const model = this.#sv.server.models[modelIndex];

    return model instanceof Promise ? null : model ?? null;
  }
}

export default ServerCollisionModelSource;

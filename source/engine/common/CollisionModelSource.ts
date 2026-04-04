import { eventBus, getClientRegistry, getCommonRegistry } from '../registry.ts';

import type { ServerEdict } from '../server/Edict.ts';
import type { BaseModel } from './model/BaseModel.ts';
import type { BrushModel } from './model/BSP.ts';

interface ServerCollisionModelAccessors {
  readonly getWorldEntity?: () => ServerEdict | null;
  readonly getWorldModel?: () => BrushModel | null;
  readonly getModels?: () => Array<BaseModel | null> | null;
}

interface ClientCollisionModelAccessors {
  readonly getWorldModel?: () => BrushModel | null;
  readonly getModels?: () => Array<BaseModel | null> | null;
}

let { SV } = getCommonRegistry();
let { CL } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ SV } = getCommonRegistry());
  ({ CL } = getClientRegistry());
});

/**
 * Runtime-neutral model and world resolver for collision code.
 * Server and client bootstrap code inject live accessors so physics classes do
 * not need to know where model caches or world state live.
 */
export class CollisionModelSource {
  #getServerWorldEntity: () => ServerEdict | null = () => null;
  #getServerWorldModel: () => BrushModel | null = () => null;
  #getServerModels: () => Array<BaseModel | null> | null = () => null;
  #getClientWorldModel: () => BrushModel | null = () => null;
  #getClientModels: () => Array<BaseModel | null> | null = () => null;

  /**
   * Install live server accessors.
   */
  configureServer(accessors: ServerCollisionModelAccessors = {}): void {
    this.#getServerWorldEntity = accessors.getWorldEntity ?? (() => null);
    this.#getServerWorldModel = accessors.getWorldModel ?? (() => null);
    this.#getServerModels = accessors.getModels ?? (() => null);
  }

  /**
   * Install live client accessors.
   */
  configureClient(accessors: ClientCollisionModelAccessors = {}): void {
    this.#getClientWorldModel = accessors.getWorldModel ?? (() => null);
    this.#getClientModels = accessors.getModels ?? (() => null);
  }

  /**
   * Return the active static-world entity, if any.
   * @returns The current server world entity.
   */
  getWorldEntity(): ServerEdict | null {
    return this.#getServerWorldEntity();
  }

  /**
   * Return the active static-world model.
   * @returns The current server or client world model.
   */
  getWorldModel(): BrushModel | null {
    const serverWorldModel = this.#getServerWorldModel();

    if (serverWorldModel !== null) {
      return serverWorldModel;
    }

    const clientWorldModel = this.#getClientWorldModel();

    if (clientWorldModel !== null) {
      return clientWorldModel;
    }

    const fallbackClientModel = this.#getClientModels()?.[1] ?? null;

    if (fallbackClientModel !== null && fallbackClientModel.type === 0) {
      return fallbackClientModel as BrushModel;
    }

    return null;
  }

  /**
   * Resolve a model from the active runtime's model cache.
   * @returns The resolved model, if any.
   */
  getModelByIndex(modelIndex: number): BaseModel | null {
    return this.#getServerModels()?.[modelIndex]
      ?? this.#getClientModels()?.[modelIndex]
      ?? null;
  }
}

/**
 * Compatibility adapter for tests and legacy call sites that still construct
 * collision helpers directly without explicit injection.
 * @returns A registry-backed collision model source.
 */
export function createRegistryCollisionModelSource(): CollisionModelSource {
  const modelSource = new CollisionModelSource();

  modelSource.configureServer({
    getWorldEntity: () => SV?.server?.edicts?.[0] ?? null,
    getWorldModel: () => SV?.server?.worldmodel ?? null,
    getModels: () => (SV?.server?.models.map((model) => model instanceof Promise ? null : model) as Array<BaseModel | null> | undefined) ?? null,
  });
  modelSource.configureClient({
    getWorldModel: () => CL?.state?.worldmodel ?? null,
    getModels: () => CL?.state?.model_precache ?? null,
  });

  return modelSource;
}

export const sharedCollisionModelSource = new CollisionModelSource();

export default CollisionModelSource;

import { registry } from '../registry.mjs';

/** @typedef {import('../server/Client.mjs').ServerEdict} ServerEdict */

/**
 * Runtime-neutral model and world resolver for collision code.
 * Server and client bootstrap code inject live accessors so physics classes do
 * not need to know where model caches or world state live.
 */
export class CollisionModelSource {
  /** @type {() => ServerEdict|null} */
  #getServerWorldEntity = () => null;

  /** @type {() => import('./Mod.ts').BrushModel|null} */
  #getServerWorldModel = () => null;

  /** @type {() => Array<import('./Mod.ts').BrushModel|object|null>|null} */
  #getServerModels = () => null;

  /** @type {() => import('./Mod.ts').BrushModel|null} */
  #getClientWorldModel = () => null;

  /** @type {() => Array<import('./Mod.ts').BrushModel|object|null>|null} */
  #getClientModels = () => null;

  /**
   * Install live server accessors.
   * @param {{getWorldEntity?: () => ServerEdict|null, getWorldModel?: () => import('./Mod.ts').BrushModel|null, getModels?: () => Array<import('./Mod.ts').BrushModel|object|null>|null}} accessors server accessors
   */
  configureServer(accessors = {}) {
    this.#getServerWorldEntity = accessors.getWorldEntity ?? (() => null);
    this.#getServerWorldModel = accessors.getWorldModel ?? (() => null);
    this.#getServerModels = accessors.getModels ?? (() => null);
  }

  /**
   * Install live client accessors.
   * @param {{getWorldModel?: () => import('./Mod.ts').BrushModel|null, getModels?: () => Array<import('./Mod.ts').BrushModel|object|null>|null}} accessors client accessors
   */
  configureClient(accessors = {}) {
    this.#getClientWorldModel = accessors.getWorldModel ?? (() => null);
    this.#getClientModels = accessors.getModels ?? (() => null);
  }

  /** @returns {ServerEdict|null} active static-world entity, if any */
  getWorldEntity() {
    return this.#getServerWorldEntity();
  }

  /** @returns {import('./Mod.ts').BrushModel|null} active static-world model */
  getWorldModel() {
    return this.#getServerWorldModel()
      ?? this.#getClientWorldModel()
      ?? this.#getClientModels()?.[1]
      ?? null;
  }

  /**
   * Resolve a model from the active runtime's model cache.
   * @param {number} modelIndex precached model index
   * @returns {import('./Mod.ts').BrushModel|object|null} resolved model, if any
   */
  getModelByIndex(modelIndex) {
    return this.#getServerModels()?.[modelIndex]
      ?? this.#getClientModels()?.[modelIndex]
      ?? null;
  }
}

/**
 * Compatibility adapter for tests and legacy call sites that still construct
 * collision helpers directly without explicit injection.
 * @returns {CollisionModelSource} registry-backed collision model source
 */
export function createRegistryCollisionModelSource() {
  const modelSource = new CollisionModelSource();

  modelSource.configureServer({
    getWorldEntity: () => registry.SV?.server?.edicts?.[0] ?? null,
    getWorldModel: () => registry.SV?.server?.worldmodel ?? null,
    getModels: () => registry.SV?.server?.models ?? null,
  });
  modelSource.configureClient({
    getWorldModel: () => registry.CL?.state?.worldmodel ?? null,
    getModels: () => registry.CL?.state?.model_precache ?? null,
  });

  return modelSource;
}

export const sharedCollisionModelSource = new CollisionModelSource();

export default CollisionModelSource;

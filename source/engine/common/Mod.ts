import type { ConsoleOutput } from './Services.ts';
import { MissingResourceError } from './Errors.ts';
import { ModelLoaderRegistry } from './model/ModelLoaderRegistry.ts';
import { AliasMDLLoader } from './model/loaders/AliasMDLLoader.ts';
import { SpriteSPRLoader } from './model/loaders/SpriteSPRLoader.ts';
import { BSP29Loader } from './model/loaders/BSP29Loader.ts';
import { BSP2Loader } from './model/loaders/BSP2Loader.ts';
import { WavefrontOBJLoader } from './model/loaders/WavefrontOBJLoader.ts';
import ParsedQC from './model/parsers/ParsedQC.ts';
import { BSP38Loader } from './model/loaders/BSP38Loader.ts';
import type { BaseModel } from './model/BaseModel.ts';
import { BrushModel } from './model/BSP.ts';
import { DEFAULT_MODEL_LOAD_OPTIONS, type ModelFiles, type ModelLoadContext, type ModelLoadOptions } from './model/ModelLoadContext.ts';

export enum ModelType {
  brush = 0,
  sprite = 1,
  alias = 2,
  mesh = 3,
}

export enum ModelScope {
  shared = 'shared',
  client = 'client',
  server = 'server',
}

export enum ModelHull {
  normal = 0,
  player = 1,
  big = 2,
  crouch = 3,
}

type ModelCache = Record<string, BaseModel>;

// Re-export model classes for backward compatibility.
// TODO: remove these!
export { AliasModel } from './model/AliasModel.ts';
export { BrushModel } from './model/BSP.ts';
export { SpriteModel } from './model/SpriteModel.ts';
export { MeshModel } from './model/MeshModel.ts';

/**
 * What the model cache is built from by the composition root of its realm.
 */
export interface ModDependencies {
  /** Where model files are read from. */
  readonly files: ModelFiles;
  /** Where loaders report problems to. */
  readonly con: ConsoleOutput;
  /** Whether loaders create textures and the other data only a renderer needs. A server realm says no. */
  readonly loadRenderData: boolean;
  /** Names of client models that outlive a clear of the client scope (the models effects spawn at runtime). */
  readonly keptClientModels?: () => string[];
}

/**
 * Shared model cache and loading entry point. One instance per realm, the default export of this module;
 * the composition root of the realm hands it its dependencies through `Init()`.
 */
export class Mod {
  #files: ModelFiles | null = null;
  #keptClientModels: () => string[] = () => [];

  known: ModelCache = {};
  clientKnown: ModelCache = {};
  serverKnown: ModelCache = {};
  readonly pendingLoads: Record<string, Promise<BaseModel | null>> = {};
  readonly modelLoaderRegistry = new ModelLoaderRegistry();

  /**
   * Rebuilds scoped inline submodels against a scoped world view.
   */
  RegisterScopedSubmodels(sharedWorld: BaseModel, scopedWorld: BaseModel, scope: ModelScope): void {
    if (!(sharedWorld instanceof BrushModel && sharedWorld.isWorldModel) || !(scopedWorld instanceof BrushModel)) {
      return;
    }

    const scopedCache = this.GetScopeCache(scope);
    scopedWorld.submodels = [];

    for (let index = 0; index < sharedWorld.submodels.length; index++) {
      const submodelName = `*${index + 1}`;
      const existingScopedSubmodel = scopedCache[submodelName];

      if (existingScopedSubmodel) {
        existingScopedSubmodel.cleanupScopedView();
      }

      const sharedSubmodel = sharedWorld.submodels[index];
      const scopedSubmodel = sharedSubmodel.createScopedView();

      scopedSubmodel.vertexes = scopedWorld.vertexes;
      scopedSubmodel.edges = scopedWorld.edges;
      scopedSubmodel.surfedges = scopedWorld.surfedges;
      scopedSubmodel.nodes = scopedWorld.nodes;
      scopedSubmodel.leafs = scopedWorld.leafs;
      scopedSubmodel.texinfo = scopedWorld.texinfo;
      scopedSubmodel.textures = scopedWorld.textures;
      scopedSubmodel.marksurfaces = scopedWorld.marksurfaces;
      scopedSubmodel.lightdata = scopedWorld.lightdata;
      scopedSubmodel.lightdata_rgb = scopedWorld.lightdata_rgb;
      scopedSubmodel.deluxemap = scopedWorld.deluxemap;
      scopedSubmodel.faces = scopedWorld.faces;
      scopedSubmodel.visdata = scopedWorld.visdata;
      scopedSubmodel.numclusters = scopedWorld.numclusters;
      scopedSubmodel.clusterPvsOffsets = scopedWorld.clusterPvsOffsets;
      scopedSubmodel.phsdata = scopedWorld.phsdata;
      scopedSubmodel.clusterPhsOffsets = scopedWorld.clusterPhsOffsets;
      scopedSubmodel.worldspawnInfo = scopedWorld.worldspawnInfo;

      scopedWorld.submodels[index] = scopedSubmodel;
      scopedCache[submodelName] = scopedSubmodel;
    }
  }

  Init(dependencies: ModDependencies): void {
    const context: ModelLoadContext = {
      files: dependencies.files,
      con: dependencies.con,
      loadRenderData: dependencies.loadRenderData,
    };

    this.#files = dependencies.files;
    this.#keptClientModels = dependencies.keptClientModels ?? (() => []);

    this.modelLoaderRegistry.clear();
    this.modelLoaderRegistry.register(new BSP38Loader(context));
    this.modelLoaderRegistry.register(new BSP2Loader(context)); // Register BSP2 before BSP29 so the more specific format wins.
    this.modelLoaderRegistry.register(new BSP29Loader(context));
    this.modelLoaderRegistry.register(new AliasMDLLoader(context));
    this.modelLoaderRegistry.register(new SpriteSPRLoader(context));
    this.modelLoaderRegistry.register(new WavefrontOBJLoader(context));
  }

  /**
   * Returns the model cache for the requested scope.
   * @returns The cache object for the requested scope.
   */
  GetScopeCache(scope: ModelScope): ModelCache {
    switch (scope) {
      case ModelScope.client:
        return this.clientKnown;
      case ModelScope.server:
        return this.serverKnown;
      default:
        return this.known;
    }
  }

  /**
   * Resolves the cached model instance for a scope, creating a scoped runtime
   * view when needed.
   * @returns The scoped model instance, or `null` when unavailable.
   */
  ResolveScopedModel(name: string, scope: ModelScope): BaseModel | null {
    if (scope === ModelScope.shared) {
      return this.known[name] ?? null;
    }

    const scopedCache = this.GetScopeCache(scope);

    if (scopedCache[name]) {
      return scopedCache[name];
    }

    const sharedModel = this.known[name];

    if (!sharedModel) {
      return null;
    }

    const scopedModel = sharedModel.createScopedView();
    scopedCache[name] = scopedModel;

    if (sharedModel instanceof BrushModel && sharedModel.isWorldModel) {
      this.RegisterScopedSubmodels(sharedModel, scopedModel, scope);
    }

    return scopedModel;
  }

  PruneSharedCache(): void {
    for (const name of Object.keys(this.known)) {
      if (this.clientKnown[name] || this.serverKnown[name]) {
        continue;
      }

      delete this.known[name];
    }
  }

  /**
   * Clears cached models for a scope.
   */
  ClearAll(scope: ModelScope = ModelScope.shared): void {
    if (scope === ModelScope.shared) {
      for (const scopedScope of [ModelScope.client, ModelScope.server]) {
        this.ClearAll(scopedScope);
      }

      for (const name of Object.keys(this.known)) {
        delete this.known[name];
      }

      return;
    }

    const tempEnts = scope === ModelScope.client ? this.#keptClientModels() : [];

    const scopedCache = this.GetScopeCache(scope);

    for (const name of Object.keys(scopedCache)) {
      const model = scopedCache[name];

      if (tempEnts.includes(name)) {
        continue;
      }

      model.cleanupScopedView();
      delete scopedCache[name];
    }

    this.PruneSharedCache();
  }

  /**
   * Loads a model from a buffer and registers it in the shared cache.
   * @returns The model now registered under that name, which is an earlier one when it already has more geometry.
   */
  async LoadModelFromBuffer(name: string, buffer: ArrayBuffer, options: ModelLoadOptions = DEFAULT_MODEL_LOAD_OPTIONS): Promise<BaseModel> {
    const model = await this.modelLoaderRegistry.load(buffer, name, options);
    this.RegisterModel(model);
    return this.known[model.name] ?? model;
  }

  /**
   * Registers a model in the shared cache. Replacing a model drops the scoped views of the old one, so
   * nobody keeps resolving it, but a model with less collision geometry never replaces one with more:
   * two loads of the same name with different options may finish in either order.
   */
  RegisterModel(model: BaseModel): void {
    const existing = this.known[model.name];

    if (existing !== undefined && existing !== model) {
      if (existing.hasCollisionGeometry && !model.hasCollisionGeometry) {
        return;
      }

      this.#dropScopedViews(model.name);
    }

    this.known[model.name] = model;
  }

  #dropScopedViews(name: string): void {
    for (const scope of [ModelScope.client, ModelScope.server]) {
      const scopedCache = this.GetScopeCache(scope);
      const scopedModel = scopedCache[name];

      if (scopedModel === undefined) {
        continue;
      }

      scopedModel.cleanupScopedView();
      delete scopedCache[name];
    }
  }

  /**
   * Loads a named model into the shared cache and returns the scoped instance. A model that is cached
   * without the collision geometry the options ask for is loaded again.
   * @returns The scoped model instance, or `null` when the load fails without crashing.
   */
  async LoadModelAsync(name: string, crash: boolean, scope: ModelScope = ModelScope.shared, options: ModelLoadOptions = DEFAULT_MODEL_LOAD_OPTIONS): Promise<BaseModel | null> {
    const scopedModel = this.ResolveScopedModel(name, scope);

    if (scopedModel !== null && (!options.collisionGeometry || scopedModel.hasCollisionGeometry)) {
      return scopedModel;
    }

    // A load with collision geometry is a different load than one without, so they must not share a pending promise.
    const pendingKey = options.collisionGeometry ? `${name}?collision` : name;

    if (this.pendingLoads[pendingKey] === undefined) {
      this.pendingLoads[pendingKey] = (async () => {
        const buffer = await this.#files!.LoadFile(name);

        if (buffer === null) {
          if (crash) {
            throw new MissingResourceError(name);
          }

          return null;
        }

        return await this.LoadModelFromBuffer(name, buffer, options);
      })().finally(() => {
        delete this.pendingLoads[pendingKey];
      });
    }

    const loadedModel = await this.pendingLoads[pendingKey];

    if (loadedModel === null) {
      return null;
    }

    return this.ResolveScopedModel(name, scope);
  }

  /**
   * Resolves an inline submodel from the already loaded world model cache.
   * @returns The scoped inline submodel, or `null` when it is unavailable.
   */
  ForName(name: string, scope: ModelScope = ModelScope.shared): BaseModel | null {
    console.assert(name[0] === '*', 'only submodels supported in this.ForName');
    return this.ResolveScopedModel(name, scope);
  }

  /**
   * Returns the requested model, loading it first when necessary.
   * @returns The requested model, or `null` when it cannot be loaded.
   */
  async ForNameAsync(name: string, crash = false, scope: ModelScope = ModelScope.shared, options: ModelLoadOptions = DEFAULT_MODEL_LOAD_OPTIONS): Promise<BaseModel | null> {
    if (name[0] === '*') {
      return this.ForName(name, scope);
    }

    return await this.LoadModelAsync(name, crash, scope, options);
  }

  ParseQC(qcContent: string) {
    const data = new ParsedQC();
    return data.parseQC(qcContent);
  }
}

export default new Mod();

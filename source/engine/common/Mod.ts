import { eventBus, getClientRegistry, getCommonRegistry, registry } from '../registry.ts';
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
import type { BrushModel } from './model/BSP.ts';

let { COM } = getCommonRegistry();
let { CL } = getClientRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM } = getCommonRegistry());
  ({ CL } = getClientRegistry());
});

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

function isBrushModel(model: BaseModel): model is BrushModel {
  return model.type === ModelType.brush;
}

// Re-export model classes for backward compatibility.
// TODO: remove these!
export { AliasModel } from './model/AliasModel.ts';
export { BrushModel } from './model/BSP.ts';
export { SpriteModel } from './model/SpriteModel.ts';
export { MeshModel } from './model/MeshModel.ts';

/**
 * Shared model cache and loading entry point.
 */
export default class Mod {
  /** @deprecated use ModelType instead */
  static type = ModelType;
  /** @deprecated use ModelScope instead */
  static scope = ModelScope;
  /** @deprecated use ModelHull instead */
  static hull = ModelHull;
  static known: ModelCache = {};
  static clientKnown: ModelCache = {};
  static serverKnown: ModelCache = {};
  static readonly pendingLoads: Record<string, Promise<BaseModel | null>> = {};
  static readonly modelLoaderRegistry = new ModelLoaderRegistry();

  static IsSubmodelName(name: string): boolean {
    return name[0] === '*';
  }

  /**
   * Returns true when the shared model is a world brush model with inline submodels.
   * @returns True when the model is a world brush model with inline submodels.
   */
  static IsBrushWorldModel(sharedModel: BaseModel): sharedModel is BrushModel {
    return isBrushModel(sharedModel)
      && !sharedModel.submodel
      && sharedModel.submodels.length > 0;
  }

  /**
   * Rebuilds scoped inline submodels against a scoped world view.
   */
  static RegisterScopedSubmodels(sharedWorld: BaseModel, scopedWorld: BaseModel, scope: ModelScope): void {
    if (!Mod.IsBrushWorldModel(sharedWorld) || !isBrushModel(scopedWorld)) {
      return;
    }

    const scopedCache = Mod.GetScopeCache(scope);
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

  static Init(): void {
    Mod.modelLoaderRegistry.clear();
    Mod.modelLoaderRegistry.register(new BSP38Loader());
    Mod.modelLoaderRegistry.register(new BSP2Loader()); // Register BSP2 before BSP29 so the more specific format wins.
    Mod.modelLoaderRegistry.register(new BSP29Loader());
    Mod.modelLoaderRegistry.register(new AliasMDLLoader());
    Mod.modelLoaderRegistry.register(new SpriteSPRLoader());
    Mod.modelLoaderRegistry.register(new WavefrontOBJLoader());
  }

  /**
   * Returns the model cache for the requested scope.
   * @returns The cache object for the requested scope.
   */
  static GetScopeCache(scope: ModelScope): ModelCache {
    switch (scope) {
      case Mod.scope.client:
        return Mod.clientKnown;
      case Mod.scope.server:
        return Mod.serverKnown;
      default:
        return Mod.known;
    }
  }

  /**
   * Resolves the cached model instance for a scope, creating a scoped runtime
   * view when needed.
   * @returns The scoped model instance, or `null` when unavailable.
   */
  static ResolveScopedModel(name: string, scope: ModelScope): BaseModel | null {
    if (scope === Mod.scope.shared) {
      return Mod.known[name] ?? null;
    }

    const scopedCache = Mod.GetScopeCache(scope);

    if (scopedCache[name]) {
      return scopedCache[name];
    }

    const sharedModel = Mod.known[name];

    if (!sharedModel) {
      return null;
    }

    const scopedModel = sharedModel.createScopedView();
    scopedCache[name] = scopedModel;

    if (Mod.IsBrushWorldModel(sharedModel)) {
      Mod.RegisterScopedSubmodels(sharedModel, scopedModel, scope);
    }

    return scopedModel;
  }

  static PruneSharedCache(): void {
    for (const name of Object.keys(Mod.known)) {
      if (Mod.clientKnown[name] || Mod.serverKnown[name]) {
        continue;
      }

      delete Mod.known[name];
    }
  }

  /**
   * Clears cached models for a scope.
   */
  static ClearAll(scope: ModelScope = Mod.scope.shared): void {
    if (scope === Mod.scope.shared) {
      for (const scopedScope of [Mod.scope.client, Mod.scope.server]) {
        Mod.ClearAll(scopedScope);
      }

      for (const name of Object.keys(Mod.known)) {
        delete Mod.known[name];
      }

      return;
    }

    const tempEnts = (() => {
      if (scope !== Mod.scope.client || registry.isDedicatedServer) {
        return [] as string[];
      }

      return Object.keys(CL.state.clientEntities.tempEntityModels);
    })();

    const scopedCache = Mod.GetScopeCache(scope);

    for (const name of Object.keys(scopedCache)) {
      const model = scopedCache[name];

      if (tempEnts.includes(name)) {
        continue;
      }

      model.cleanupScopedView();
      delete scopedCache[name];
    }

    Mod.PruneSharedCache();
  }

  static async LoadModelFromBuffer(name: string, buffer: ArrayBuffer): Promise<BaseModel> {
    const model = await Mod.modelLoaderRegistry.load(buffer, name);
    Mod.RegisterModel(model);
    return model;
  }

  static RegisterModel(model: BaseModel): void {
    Mod.known[model.name] = model;
  }

  /**
   * Loads a named model into the shared cache and returns the scoped instance.
   * @returns The scoped model instance, or `null` when the load fails without crashing.
   */
  static async LoadModelAsync(name: string, crash: boolean, scope: ModelScope = Mod.scope.shared): Promise<BaseModel | null> {
    const scopedModel = Mod.ResolveScopedModel(name, scope);

    if (scopedModel !== null) {
      return scopedModel;
    }

    if (Mod.pendingLoads[name] === undefined) {
      Mod.pendingLoads[name] = (async () => {
        const buffer = await COM.LoadFile(name);

        if (buffer === null) {
          if (crash) {
            throw new MissingResourceError(name);
          }

          return null;
        }

        return await Mod.LoadModelFromBuffer(name, buffer);
      })().finally(() => {
        delete Mod.pendingLoads[name];
      });
    }

    const loadedModel = await Mod.pendingLoads[name];

    if (loadedModel === null) {
      return null;
    }

    return Mod.ResolveScopedModel(name, scope);
  }

  /**
   * Resolves an inline submodel from the already loaded world model cache.
   * @returns The scoped inline submodel, or `null` when it is unavailable.
   */
  static ForName(name: string, scope: ModelScope = Mod.scope.shared): BaseModel | null {
    console.assert(name[0] === '*', 'only submodels supported in Mod.ForName');
    return Mod.ResolveScopedModel(name, scope);
  }

  /**
   * Returns the requested model, loading it first when necessary.
   * @returns The requested model, or `null` when it cannot be loaded.
   */
  static async ForNameAsync(name: string, crash = false, scope: ModelScope = Mod.scope.shared): Promise<BaseModel | null> {
    if (name[0] === '*') {
      return Mod.ForName(name, scope);
    }

    return await Mod.LoadModelAsync(name, crash, scope);
  }

  static ParseQC(qcContent: string) {
    const data = new ParsedQC();
    return data.parseQC(qcContent);
  }
}

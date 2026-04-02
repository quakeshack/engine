import { eventBus, registry } from '../registry.mjs';
import { MissingResourceError } from './Errors.ts';
import { ModelLoaderRegistry } from './model/ModelLoaderRegistry.mjs';
import { AliasMDLLoader } from './model/loaders/AliasMDLLoader.mjs';
import { SpriteSPRLoader } from './model/loaders/SpriteSPRLoader.mjs';
import { BSP29Loader } from './model/loaders/BSP29Loader.mjs';
import { BSP2Loader } from './model/loaders/BSP2Loader.mjs';
import { WavefrontOBJLoader } from './model/loaders/WavefrontOBJLoader.mjs';
import ParsedQC from './model/parsers/ParsedQC.mjs';
import { BSP38Loader } from './model/loaders/BSP38Loader.mjs';

/** @typedef {import('./model/BaseModel.mjs').BaseModel} BaseModel */
/** @typedef {'shared' | 'client' | 'server'} ModelScope */

let { CL, COM } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
});

// Re-export model classes for backward compatibility
export { AliasModel } from './model/AliasModel.mjs';
export { BrushModel } from './model/BSP.mjs';
export { SpriteModel } from './model/SpriteModel.mjs';
export { MeshModel } from './model/MeshModel.mjs';

export default class Mod {
  static type = { brush: 0, sprite: 1, alias: 2, mesh: 3 };

  static scope = Object.freeze({
    shared: 'shared',
    client: 'client',
    server: 'server',
  });

  static hull = {
    /** hull0, point intersection */
    normal: 0,
    /** hull1, testing for player (32, 32, 56) */
    player: 1,
    /** hull2, testing for large objects (64, 64, 88) */
    big: 2,
    /** hull3, only used by BSP30 for crouching etc. (32, 32, 36) */
    crouch: 3,
  };

  static known = /** @type {Record<string, BaseModel>} */ ({});

  static clientKnown = /** @type {Record<string, BaseModel>} */ ({});

  static serverKnown = /** @type {Record<string, BaseModel>} */ ({});

  static pendingLoads = /** @type {Record<string, Promise<BaseModel|null>>} */ ({});

  static modelLoaderRegistry = new ModelLoaderRegistry();

  static IsSubmodelName(name) {
    return name[0] === '*';
  }

  /**
   * @param {BaseModel} sharedModel shared cached model
   * @returns {boolean} true when the model is a world brush model with inline submodels
   */
  static IsBrushWorldModel(sharedModel) {
    return sharedModel.type === Mod.type.brush
      && sharedModel.submodel !== true
      && Array.isArray(sharedModel.submodels)
      && sharedModel.submodels.length > 0;
  }

  /**
   * @param {BaseModel} sharedWorld shared world model
   * @param {BaseModel} scopedWorld scoped world model
   * @param {ModelScope} scope requested scope
   */
  static RegisterScopedSubmodels(sharedWorld, scopedWorld, scope) {
    if (!Mod.IsBrushWorldModel(sharedWorld)) {
      return;
    }

    const scopedCache = Mod.GetScopeCache(scope);
    scopedWorld.submodels = [];

    for (let i = 0; i < sharedWorld.submodels.length; i++) {
      const submodelName = `*${i + 1}`;
      const existingScopedSubmodel = scopedCache[submodelName];

      if (existingScopedSubmodel) {
        existingScopedSubmodel.cleanupScopedView();
      }

      const sharedSubmodel = sharedWorld.submodels[i];
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

      scopedWorld.submodels[i] = scopedSubmodel;
      scopedCache[submodelName] = scopedSubmodel;
    }
  }

  static Init() {
    Mod.modelLoaderRegistry.clear();
    Mod.modelLoaderRegistry.register(new BSP38Loader());
    Mod.modelLoaderRegistry.register(new BSP2Loader()); // Register BSP2 before BSP29 so it’s checked first (more specific format)
    Mod.modelLoaderRegistry.register(new BSP29Loader());
    Mod.modelLoaderRegistry.register(new AliasMDLLoader());
    Mod.modelLoaderRegistry.register(new SpriteSPRLoader());
    Mod.modelLoaderRegistry.register(new WavefrontOBJLoader());
  }

  /**
   * @param {ModelScope} scope requested model scope
   * @returns {Record<string, BaseModel>} cache for the requested scope
   */
  static GetScopeCache(scope) {
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
   * @param {string} name model name
   * @param {ModelScope} scope requested scope
   * @returns {BaseModel|null} scoped model instance or null when unavailable
   */
  static ResolveScopedModel(name, scope) {
    if (scope === Mod.scope.shared) {
      return Mod.known[name] || null;
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

  static PruneSharedCache() {
    for (const name of Object.keys(Mod.known)) {
      if (Mod.clientKnown[name] || Mod.serverKnown[name]) {
        continue;
      }

      delete Mod.known[name];
    }
  }

  /**
   * @param {ModelScope} [scope] scope to clear
   */
  static ClearAll(scope = Mod.scope.shared) {
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
        return [];
      }

      return Object.keys(CL.state.clientEntities.tempEntityModels);
    })();

    const scopedCache = Mod.GetScopeCache(scope);

    for (const name of Object.keys(scopedCache)) {
      const mod = scopedCache[name];

      if (tempEnts.includes(name)) {
        continue;
      }

      mod.cleanupScopedView();
      delete scopedCache[name];
    }

    Mod.PruneSharedCache();
  }

  static async LoadModelFromBuffer(name, buffer) {
    // FIXME: maybe catch at least NotImplementedError here and give a better
    //        error message, right now it will simply crash the whole engine
    const model = await Mod.modelLoaderRegistry.load(buffer, name);

    Mod.RegisterModel(model);

    return model;
  }

  static RegisterModel(model) {
    Mod.known[model.name] = model;
  }

  /**
   * @param {string} name model to load
   * @param {boolean} crash whether to throw an error if the model is not found
   * @param {ModelScope} scope requested cache scope
   * @returns {Promise<BaseModel|null>} the loaded model or null if not found
   */
  static async LoadModelAsync(name, crash, scope = Mod.scope.shared) { // private method
    const scopedModel = Mod.ResolveScopedModel(name, scope);

    if (scopedModel !== null) {
      return scopedModel;
    }

    if (Mod.pendingLoads[name] === undefined) {
      Mod.pendingLoads[name] = (async () => {
        const buf = await COM.LoadFile(name);
        if (buf === null) {
          if (crash === true) {
            throw new MissingResourceError(name);
          }
          return null;
        }

        return await Mod.LoadModelFromBuffer(name, buf);
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
   * Load submodels. For anything else, use Mod.ForNameAsync instead.
   * @param {string} name filename
   * @param {ModelScope} [scope] requested cache scope
   * @returns {BaseModel|null} the loaded model or null if not found
   */
  static ForName(name, scope = Mod.scope.shared) { // public method
    console.assert(name[0] === '*', 'only submodels supported in Mod.ForName');

    return Mod.ResolveScopedModel(name, scope);
  }

  /**
   * @param {string} name filename
   * @param {boolean} crash whether to throw an error if the model is not found
   * @param {ModelScope} [scope] requested cache scope
   * @returns {Promise<BaseModel|null>} the loaded model or null if not found
   */
  static async ForNameAsync(name, crash = false, scope = Mod.scope.shared) { // public method
    if (name[0] === '*') {
      return Mod.ForName(name, scope);
    }

    return await Mod.LoadModelAsync(name, crash, scope);
  }

  static ParseQC(qcContent) {
    const data = new ParsedQC();

    return data.parseQC(qcContent);
  }
}

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Mod from '../../source/engine/common/Mod.mjs';
import { AliasModel } from '../../source/engine/common/model/AliasModel.mjs';
import { Face } from '../../source/engine/common/model/BaseModel.mjs';
import { BrushModel } from '../../source/engine/common/model/BSP.mjs';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import Vector from '../../source/shared/Vector.mjs';

/** @typedef {import('../../source/engine/common/model/BaseModel.mjs').BaseModel} BaseModel */

/**
 * @param {BaseModel|null} model model to narrow
 * @returns {BrushModel} brush model
 */
function asBrushModel(model) {
  return /** @type {BrushModel} */ (model);
}

/**
 * @param {BaseModel|null} model model to narrow
 * @returns {AliasModel} alias model
 */
function asAliasModel(model) {
  return /** @type {AliasModel} */ (model);
}

/**
 * @param {() => void | Promise<void>} callback test body
 */
async function withModelRegistry(callback) {
  const previousRegistry = {
    Con: registry.Con,
    Mod: registry.Mod,
    isDedicatedServer: registry.isDedicatedServer,
  };
  const previousKnown = { ...Mod.known };
  const previousClientKnown = { ...Mod.clientKnown };
  const previousServerKnown = { ...Mod.serverKnown };
  const previousPendingLoads = { ...Mod.pendingLoads };

  registry.isDedicatedServer = true;
  registry.Con = /** @type {typeof import('../../source/engine/common/Console.mjs').default} */ ({
    Print() {},
    DPrint() {},
    PrintWarning() {},
    PrintError(...args) {
      console.error(...args);
    },
    PrintSuccess() {},
  });
  registry.Mod = Mod;
  eventBus.publish('registry.frozen');

  try {
    await callback();
  } finally {
    const previousCon = previousRegistry.Con;
    const previousMod = previousRegistry.Mod;
    const previousIsDedicatedServer = previousRegistry.isDedicatedServer;

    Mod.ClearAll(Mod.scope.shared);

    for (const name of Object.keys(Mod.known)) {
      delete Mod.known[name];
    }
    Object.assign(Mod.known, previousKnown);

    for (const name of Object.keys(Mod.clientKnown)) {
      delete Mod.clientKnown[name];
    }
    Object.assign(Mod.clientKnown, previousClientKnown);

    for (const name of Object.keys(Mod.serverKnown)) {
      delete Mod.serverKnown[name];
    }
    Object.assign(Mod.serverKnown, previousServerKnown);

    for (const name of Object.keys(Mod.pendingLoads)) {
      delete Mod.pendingLoads[name];
    }
    Object.assign(Mod.pendingLoads, previousPendingLoads);

    Object.assign(registry, {
      Con: previousCon,
      Mod: previousMod,
      isDedicatedServer: previousIsDedicatedServer,
    });
    eventBus.publish('registry.frozen');
  }
}

/**
 * @returns {{ worldModel: BrushModel, submodel: BrushModel }} registered shared world and inline submodel
 */
function createSharedBrushModels() {
  const worldModel = new BrushModel('maps/scoped-test.bsp');
  const submodel = new BrushModel('*1');
  const face = new Face();
  const vertexes = [new Vector(0, 0, 0), new Vector(16, 0, 0)];
  const edges = [[0, 1]];
  const surfedges = [0];
  const texinfo = [{ texture: 0, vecs: [[1, 0, 0, 0], [0, 1, 0, 0]], flags: 0, value: 0, nexttexinfo: -1 }];
  const faces = [face];

  worldModel.vertexes = vertexes;
  worldModel.edges = edges;
  worldModel.surfedges = surfedges;
  worldModel.texinfo = texinfo;
  worldModel.faces = faces;
  worldModel.submodels = [submodel];

  submodel.submodel = true;
  submodel.vertexes = vertexes;
  submodel.edges = edges;
  submodel.surfedges = surfedges;
  submodel.texinfo = texinfo;
  submodel.faces = faces;
  submodel.firstface = 0;
  submodel.numfaces = 1;

  Mod.RegisterModel(worldModel);
  Mod.RegisterModel(submodel);

  return { worldModel, submodel };
}

/**
 * @returns {AliasModel} registered shared alias model
 */
function createSharedAliasModel() {
  const aliasModel = new AliasModel('progs/scoped-test.mdl');

  aliasModel.cmds = /** @type {WebGLBuffer} */ (/** @type {unknown} */ ({ id: 'shared-alias-buffer' }));

  Mod.RegisterModel(aliasModel);

  return aliasModel;
}

describe('Mod scoped model cache', () => {
  test('separates client and server submodel instances while reusing shared BSP data', async () => {
    await withModelRegistry(async () => {
      const { worldModel, submodel } = createSharedBrushModels();

      const serverWorld = asBrushModel(await Mod.ForNameAsync(worldModel.name, true, Mod.scope.server));
      const clientWorld = asBrushModel(await Mod.ForNameAsync(worldModel.name, true, Mod.scope.client));
      const sharedWorld = asBrushModel(await Mod.ForNameAsync(worldModel.name, true, Mod.scope.shared));

      const serverSubmodel = asBrushModel(Mod.ForName('*1', Mod.scope.server));
      const clientSubmodel = asBrushModel(Mod.ForName('*1', Mod.scope.client));
      const sharedSubmodel = asBrushModel(Mod.ForName('*1', Mod.scope.shared));

      assert.equal(sharedWorld, worldModel);
      assert.equal(sharedSubmodel, submodel);
      assert.notEqual(serverWorld, clientWorld);
      assert.notEqual(serverWorld, sharedWorld);
      assert.notEqual(serverSubmodel, clientSubmodel);
      assert.notEqual(clientSubmodel, sharedSubmodel);
      assert.equal(serverWorld.faces, sharedWorld.faces);
      assert.equal(clientWorld.faces, sharedWorld.faces);
      assert.equal(clientSubmodel.faces, clientWorld.faces);
      assert.equal(serverSubmodel.faces, serverWorld.faces);
      assert.equal(clientSubmodel.vertexes, sharedSubmodel.vertexes);
      assert.equal(clientSubmodel.edges, sharedSubmodel.edges);
      assert.equal(clientSubmodel.surfedges, sharedSubmodel.surfedges);
      assert.equal(clientSubmodel.texinfo, sharedSubmodel.texinfo);
      assert.equal(clientSubmodel.vertexes.length > 0, true);
      assert.equal(clientSubmodel.edges.length > 0, true);
      assert.equal(clientSubmodel.surfedges.length > 0, true);

      Mod.ClearAll(Mod.scope.server);

      const refreshedServerSubmodel = asBrushModel(Mod.ForName('*1', Mod.scope.server));
      assert.notEqual(refreshedServerSubmodel, serverSubmodel);
      assert.equal(refreshedServerSubmodel.vertexes, sharedSubmodel.vertexes);
      assert.equal(Mod.ForName('*1', Mod.scope.client), clientSubmodel);
      assert.equal(Mod.ForName('*1', Mod.scope.shared), sharedSubmodel);

      Mod.ClearAll(Mod.scope.client);

      const refreshedClientSubmodel = asBrushModel(Mod.ForName('*1', Mod.scope.client));
      assert.notEqual(refreshedClientSubmodel, clientSubmodel);
      assert.equal(refreshedClientSubmodel.vertexes, sharedSubmodel.vertexes);
      assert.equal(refreshedClientSubmodel.surfedges, sharedSubmodel.surfedges);
    });
  });

  test('keeps shared alias vertex buffers visible to scoped views', async () => {
    await withModelRegistry(async () => {
      const sharedAliasModel = createSharedAliasModel();

      const clientAliasModel = asAliasModel(await Mod.ForNameAsync(sharedAliasModel.name, true, Mod.scope.client));
      const serverAliasModel = asAliasModel(await Mod.ForNameAsync(sharedAliasModel.name, true, Mod.scope.server));

      assert.notEqual(clientAliasModel, sharedAliasModel);
      assert.notEqual(serverAliasModel, sharedAliasModel);
      assert.equal(clientAliasModel.cmds, sharedAliasModel.cmds);
      assert.equal(serverAliasModel.cmds, sharedAliasModel.cmds);

      Mod.ClearAll(Mod.scope.client);

      assert.equal(sharedAliasModel.cmds !== null, true);

      const refreshedClientAliasModel = asAliasModel(await Mod.ForNameAsync(sharedAliasModel.name, true, Mod.scope.client));
      assert.equal(refreshedClientAliasModel.cmds, sharedAliasModel.cmds);
    });
  });

  test('clears shared and scoped caches together when clearing shared scope', async () => {
    await withModelRegistry(async () => {
      const { worldModel } = createSharedBrushModels();
      const sharedAliasModel = createSharedAliasModel();

      const clientWorld = asBrushModel(await Mod.ForNameAsync(worldModel.name, true, Mod.scope.client));
      const serverWorld = asBrushModel(await Mod.ForNameAsync(worldModel.name, true, Mod.scope.server));
      const clientAliasModel = asAliasModel(await Mod.ForNameAsync(sharedAliasModel.name, true, Mod.scope.client));
      const serverAliasModel = asAliasModel(await Mod.ForNameAsync(sharedAliasModel.name, true, Mod.scope.server));

      assert.equal(clientWorld !== null, true);
      assert.equal(serverWorld !== null, true);
      assert.equal(clientAliasModel !== null, true);
      assert.equal(serverAliasModel !== null, true);
      assert.equal(Object.keys(Mod.known).length > 0, true);
      assert.equal(Object.keys(Mod.clientKnown).length > 0, true);
      assert.equal(Object.keys(Mod.serverKnown).length > 0, true);

      Mod.ClearAll(Mod.scope.shared);

      assert.deepEqual(Object.keys(Mod.known), []);
      assert.deepEqual(Object.keys(Mod.clientKnown), []);
      assert.deepEqual(Object.keys(Mod.serverKnown), []);
      assert.equal(Mod.ResolveScopedModel(worldModel.name, Mod.scope.shared), null);
      assert.equal(Mod.ForName('*1', Mod.scope.client), null);
      assert.equal(Mod.ForName('*1', Mod.scope.server), null);
      assert.equal(Mod.ResolveScopedModel(sharedAliasModel.name, Mod.scope.client), null);
      assert.equal(Mod.ResolveScopedModel(sharedAliasModel.name, Mod.scope.server), null);
    });
  });
});

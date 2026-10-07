import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Mod, ModelScope } from '../../source/engine/common/Mod.ts';
import { AliasModel } from '../../source/engine/common/model/AliasModel.ts';
import { Face } from '../../source/engine/common/model/BaseModel.ts';
import type { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { BrushModel, Node, type BrushTexInfo } from '../../source/engine/common/model/BSP.ts';
import Vector from '../../source/shared/Vector.ts';
import { createModelLoadContext } from '../support/modelContext.ts';

/**
 * Narrows a model the cache returned.
 * @param model The model.
 * @returns The model as a brush model.
 */
function asBrushModel(model: BaseModel | null): BrushModel {
  return model as BrushModel;
}

/**
 * Narrows a model the cache returned.
 * @param model The model.
 * @returns The model as an alias model.
 */
function asAliasModel(model: BaseModel | null): AliasModel {
  return model as AliasModel;
}

/**
 * Runs a test body against a model cache of its own, set up like a server's (no render data).
 * @param callback The test body.
 */
async function withModel(callback: (mod: Mod) => void | Promise<void>): Promise<void> {
  const mod = new Mod();
  const { files, con, loadRenderData } = createModelLoadContext();

  mod.Init({ files, con, loadRenderData });

  await callback(mod);
}

/**
 * Registers a shared world model with one inline submodel.
 * @param mod The model cache to register in.
 * @returns The registered shared world and inline submodel.
 */
function createSharedBrushModels(mod: Mod): { worldModel: BrushModel, submodel: BrushModel } {
  const worldModel = new BrushModel('maps/scoped-test.bsp');
  const submodel = new BrushModel('*1');
  const face = new Face();
  const rootNode = new Node(worldModel);
  const leaf = new Node(worldModel);
  const vertexes = [new Vector(0, 0, 0), new Vector(16, 0, 0)];
  const edges = [[0, 1]];
  const surfedges = [0];
  const texinfo: BrushTexInfo[] = [{ texture: 0, vecs: [[1, 0, 0, 0], [0, 1, 0, 0]], flags: 0, value: 0, nexttexinfo: -1 }];
  const faces = [face];

  rootNode.num = 0;
  rootNode.contents = 0;
  rootNode.mins = new Vector(-16, -16, -16);
  rootNode.maxs = new Vector(16, 16, 16);
  rootNode.baseMins = rootNode.mins.copy();
  rootNode.baseMaxs = rootNode.maxs.copy();

  leaf.num = 1;
  leaf.contents = -1;
  leaf.parent = rootNode;
  leaf.mins = new Vector(-8, -8, -8);
  leaf.maxs = new Vector(8, 8, 8);
  leaf.baseMins = leaf.mins.copy();
  leaf.baseMaxs = leaf.maxs.copy();
  leaf.firstmarksurface = 0;
  leaf.nummarksurfaces = 1;

  rootNode.children = [leaf, leaf];

  worldModel.vertexes = vertexes;
  worldModel.edges = edges;
  worldModel.surfedges = surfedges;
  worldModel.texinfo = texinfo;
  worldModel.faces = faces;
  worldModel.nodes = [rootNode];
  worldModel.leafs = [leaf];
  worldModel.marksurfaces = [0];
  worldModel.submodels = [submodel];

  submodel.submodel = true;
  submodel.vertexes = vertexes;
  submodel.edges = edges;
  submodel.surfedges = surfedges;
  submodel.texinfo = texinfo;
  submodel.faces = faces;
  submodel.firstface = 0;
  submodel.numfaces = 1;

  mod.RegisterModel(worldModel);

  return { worldModel, submodel };
}

/**
 * Registers a shared world model under another name.
 * @param mod The model cache to register in.
 * @param worldName Model name.
 * @param vertexX Unique vertex value to identify the world.
 * @returns The registered shared world and inline submodel.
 */
function createSharedBrushModelsForWorld(mod: Mod, worldName: string, vertexX: number): { worldModel: BrushModel, submodel: BrushModel } {
  const { worldModel, submodel } = createSharedBrushModels(mod);

  delete mod.known[worldModel.name];
  worldModel.name = worldName;
  worldModel.vertexes = [new Vector(vertexX, 0, 0), new Vector(vertexX + 16, 0, 0)];
  submodel.vertexes = worldModel.vertexes;

  mod.RegisterModel(worldModel);

  return { worldModel, submodel };
}

/**
 * Registers a shared alias model.
 * @param mod The model cache to register in.
 * @returns The registered shared alias model.
 */
function createSharedAliasModel(mod: Mod): AliasModel {
  const aliasModel = new AliasModel('progs/scoped-test.mdl');

  aliasModel.cmds = { id: 'shared-alias-buffer' } as unknown as WebGLBuffer;

  mod.RegisterModel(aliasModel);

  return aliasModel;
}

void describe('Mod scoped model cache', () => {
  void test('separates client and server submodel instances while reusing shared BSP data', async () => {
    await withModel(async (mod) => {
      const { worldModel, submodel } = createSharedBrushModels(mod);

      const serverWorld = asBrushModel(await mod.ForNameAsync(worldModel.name, true, ModelScope.server));
      const clientWorld = asBrushModel(await mod.ForNameAsync(worldModel.name, true, ModelScope.client));
      const sharedWorld = asBrushModel(await mod.ForNameAsync(worldModel.name, true, ModelScope.shared));

      const serverSubmodel = asBrushModel(mod.ForName('*1', ModelScope.server));
      const clientSubmodel = asBrushModel(mod.ForName('*1', ModelScope.client));
      const sharedSubmodel = asBrushModel(mod.ForName('*1', ModelScope.shared));

      assert.equal(sharedWorld, worldModel);
      assert.equal(sharedSubmodel, null);
      assert.notEqual(serverWorld, clientWorld);
      assert.notEqual(serverWorld, sharedWorld);
      assert.notEqual(serverSubmodel, clientSubmodel);
      assert.notEqual(clientSubmodel, submodel);
      assert.equal(serverWorld.faces, sharedWorld.faces);
      assert.equal(clientWorld.faces, sharedWorld.faces);
      assert.equal(clientSubmodel.faces, clientWorld.faces);
      assert.equal(serverSubmodel.faces, serverWorld.faces);
      assert.equal(clientSubmodel.vertexes, clientWorld.vertexes);
      assert.equal(clientSubmodel.edges, clientWorld.edges);
      assert.equal(clientSubmodel.surfedges, clientWorld.surfedges);
      assert.equal(clientSubmodel.texinfo, clientWorld.texinfo);
      assert.equal(clientSubmodel.vertexes.length > 0, true);
      assert.equal(clientSubmodel.edges.length > 0, true);
      assert.equal(clientSubmodel.surfedges.length > 0, true);

      mod.ClearAll(ModelScope.server);

      const refreshedServerSubmodel = asBrushModel(mod.ForName('*1', ModelScope.server));
      assert.equal(refreshedServerSubmodel, null);
      assert.equal(mod.ForName('*1', ModelScope.client), clientSubmodel);
      assert.equal(mod.ForName('*1', ModelScope.shared), null);

      mod.ClearAll(ModelScope.client);

      const refreshedClientSubmodel = asBrushModel(mod.ForName('*1', ModelScope.client));
      assert.equal(refreshedClientSubmodel, null);
    });
  });

  void test('keeps bare submodel names scoped to their owning world per side', async () => {
    await withModel(async (mod) => {
      const { worldModel: serverWorldShared } = createSharedBrushModelsForWorld(mod, 'maps/server-test.bsp', 64);
      const { worldModel: clientWorldShared } = createSharedBrushModelsForWorld(mod, 'maps/client-test.bsp', 256);

      const serverWorld = asBrushModel(await mod.ForNameAsync(serverWorldShared.name, true, ModelScope.server));
      const clientWorld = asBrushModel(await mod.ForNameAsync(clientWorldShared.name, true, ModelScope.client));

      const serverSubmodel = asBrushModel(mod.ForName('*1', ModelScope.server));
      const clientSubmodel = asBrushModel(mod.ForName('*1', ModelScope.client));

      assert.equal(serverSubmodel.vertexes, serverWorld.vertexes);
      assert.equal(clientSubmodel.vertexes, clientWorld.vertexes);
      assert.equal(serverSubmodel.vertexes[0][0], 64);
      assert.equal(clientSubmodel.vertexes[0][0], 256);
      assert.notEqual(serverSubmodel.vertexes, clientSubmodel.vertexes);
    });
  });

  void test('keeps shared alias vertex buffers visible to scoped views', async () => {
    await withModel(async (mod) => {
      const sharedAliasModel = createSharedAliasModel(mod);

      const clientAliasModel = asAliasModel(await mod.ForNameAsync(sharedAliasModel.name, true, ModelScope.client));
      const serverAliasModel = asAliasModel(await mod.ForNameAsync(sharedAliasModel.name, true, ModelScope.server));

      assert.notEqual(clientAliasModel, sharedAliasModel);
      assert.notEqual(serverAliasModel, sharedAliasModel);
      assert.equal(clientAliasModel.cmds, sharedAliasModel.cmds);
      assert.equal(serverAliasModel.cmds, sharedAliasModel.cmds);

      mod.ClearAll(ModelScope.client);

      assert.equal(sharedAliasModel.cmds !== null, true);

      const refreshedClientAliasModel = asAliasModel(await mod.ForNameAsync(sharedAliasModel.name, true, ModelScope.client));
      assert.equal(refreshedClientAliasModel.cmds, sharedAliasModel.cmds);
    });
  });

  void test('resets shared brush leaf runtime state before rebuilding a scoped client view', async () => {
    await withModel(async (mod) => {
      const { worldModel } = createSharedBrushModels(mod);

      const clientWorld = asBrushModel(await mod.ForNameAsync(worldModel.name, true, ModelScope.client));
      const serverWorld = asBrushModel(await mod.ForNameAsync(worldModel.name, true, ModelScope.server));
      const sharedWorld = asBrushModel(await mod.ForNameAsync(worldModel.name, true, ModelScope.shared));

      assert.equal(clientWorld.nodes[0], sharedWorld.nodes[0]);
      assert.equal(clientWorld.leafs[0], sharedWorld.leafs[0]);
      assert.equal(serverWorld.nodes[0], sharedWorld.nodes[0]);
      assert.equal(serverWorld.leafs[0], sharedWorld.leafs[0]);

      clientWorld.nodes[0].visframe = 123;
      clientWorld.nodes[0].markvisframe = 456;
      clientWorld.leafs[0].skychain = 2;
      clientWorld.leafs[0].waterchain = 3;
      clientWorld.leafs[0].cmds.push([99, 12, 18]);
      clientWorld.leafs[0].mins![0] = -128;
      clientWorld.faces[0].dlightbits = 7;
      clientWorld.faces[0].dlightframe = 42;

      assert.deepEqual(sharedWorld.leafs[0].cmds, [[99, 12, 18]]);
      assert.equal(sharedWorld.leafs[0].skychain, 2);
      assert.equal(sharedWorld.leafs[0].waterchain, 3);
      assert.equal(sharedWorld.leafs[0].mins![0], -128);

      mod.ClearAll(ModelScope.client);

      const refreshedClientWorld = asBrushModel(await mod.ForNameAsync(worldModel.name, true, ModelScope.client));

      assert.notEqual(refreshedClientWorld, clientWorld);
      assert.equal(refreshedClientWorld.nodes[0], clientWorld.nodes[0]);
      assert.equal(refreshedClientWorld.leafs[0], clientWorld.leafs[0]);
      assert.equal(refreshedClientWorld.leafs[0].skychain, 2);
      assert.deepEqual(refreshedClientWorld.leafs[0].cmds, [[99, 12, 18]]);
      assert.equal(refreshedClientWorld.faces[0].dlightbits, 0);
      assert.equal(refreshedClientWorld.faces[0].dlightframe, -1);

      refreshedClientWorld.resetWorldRenderState();

      assert.equal(refreshedClientWorld.nodes[0].visframe, 0);
      assert.equal(refreshedClientWorld.nodes[0].markvisframe, 0);
      assert.equal(refreshedClientWorld.leafs[0].skychain, 0);
      assert.equal(refreshedClientWorld.leafs[0].waterchain, 0);
      assert.deepEqual(refreshedClientWorld.leafs[0].cmds, []);
      assert.equal(refreshedClientWorld.leafs[0].mins![0], -8);
      assert.equal(refreshedClientWorld.faces[0].dlightbits, 0);
      assert.equal(refreshedClientWorld.faces[0].dlightframe, -1);
    });
  });

  void test('clears shared and scoped caches together when clearing shared scope', async () => {
    await withModel(async (mod) => {
      const { worldModel } = createSharedBrushModels(mod);
      const sharedAliasModel = createSharedAliasModel(mod);

      const clientWorld = asBrushModel(await mod.ForNameAsync(worldModel.name, true, ModelScope.client));
      const serverWorld = asBrushModel(await mod.ForNameAsync(worldModel.name, true, ModelScope.server));
      const clientAliasModel = asAliasModel(await mod.ForNameAsync(sharedAliasModel.name, true, ModelScope.client));
      const serverAliasModel = asAliasModel(await mod.ForNameAsync(sharedAliasModel.name, true, ModelScope.server));

      assert.equal(clientWorld !== null, true);
      assert.equal(serverWorld !== null, true);
      assert.equal(clientAliasModel !== null, true);
      assert.equal(serverAliasModel !== null, true);
      assert.equal(Object.keys(mod.known).length > 0, true);
      assert.equal(Object.keys(mod.clientKnown).length > 0, true);
      assert.equal(Object.keys(mod.serverKnown).length > 0, true);

      mod.ClearAll(ModelScope.shared);

      assert.deepEqual(Object.keys(mod.known), []);
      assert.deepEqual(Object.keys(mod.clientKnown), []);
      assert.deepEqual(Object.keys(mod.serverKnown), []);
      assert.equal(mod.ResolveScopedModel(worldModel.name, ModelScope.shared), null);
      assert.equal(mod.ForName('*1', ModelScope.client), null);
      assert.equal(mod.ForName('*1', ModelScope.server), null);
      assert.equal(mod.ResolveScopedModel(sharedAliasModel.name, ModelScope.client), null);
      assert.equal(mod.ResolveScopedModel(sharedAliasModel.name, ModelScope.server), null);
    });
  });
});

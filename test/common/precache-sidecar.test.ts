import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Mod, ModelScope } from '../../source/engine/common/Mod.ts';
import type { ModelFiles } from '../../source/engine/common/model/ModelLoadContext.ts';
import type { SpriteModel } from '../../source/engine/common/model/SpriteModel.ts';
import type { SpriteSequence } from '../../source/engine/common/model/sprite/SpriteTypes.ts';
import { ServerEngineAPI } from '../../source/engine/server/ServerEngineAPI.ts';
import type Server from '../../source/engine/server/Server.ts';
import { ModelPrecacheFlags } from '../../source/shared/ModelPrecacheFlags.ts';
import { createDirectoryFiles, createSilentConsole } from '../support/modelContext.ts';
import type { BaseModel } from '../../source/engine/common/model/BaseModel.ts';

const FIXTURES = new URL('../fixtures/sprites/', import.meta.url);

/**
 * @returns Files of the sprite fixtures that remember which sidecar lookups were made, and have a sidecar for `anim.gif`.
 */
function createFiles(): { files: ModelFiles, lookups: string[] } {
  const lookups: string[] = [];
  const directory = createDirectoryFiles(FIXTURES);

  return {
    lookups,
    files: {
      LoadFile: (name) => directory.LoadFile(name),
      LoadTextFile: (name) => directory.LoadTextFile(name),
      LoadOptionalTextFile: (name) => {
        lookups.push(name);

        return Promise.resolve(name === 'anim.gif.json' ? JSON.stringify({ scale: 2 }) : null);
      },
    },
  };
}

interface PrecacheServer {
  modelPrecache: string[];
  modelPrecacheFlags: number[];
  models: Array<BaseModel | Promise<BaseModel | null> | null>;
}

/**
 * Builds the engine API on top of a minimal server: the precache lists and a model cache like a server's.
 * @returns The API, the server state it works on and the sidecar lookups made.
 */
function createApi(): { api: ServerEngineAPI, server: PrecacheServer, lookups: string[] } {
  const { files, lookups } = createFiles();
  const mod = new Mod();

  mod.Init({ files, con: createSilentConsole(), loadRenderData: false });

  const server: PrecacheServer = { modelPrecache: [''], modelPrecacheFlags: [], models: [null] };

  return {
    api: new ServerEngineAPI({ server, mod } as unknown as Server, () => ({ registered: true, hipnotic: false, rogue: false })),
    server,
    lookups,
  };
}

/**
 * @returns The width of the first picture of a loaded sprite, in world units.
 */
function imageWidth(model: BaseModel | null): number {
  return (((model as SpriteModel).frames[0]) as SpriteSequence).images[0].width;
}

void describe('PrecacheModel with a sidecar hint', () => {
  void test('looks for the sidecar of a sprite by default and applies it', async () => {
    const { api, server, lookups } = createApi();

    api.PrecacheModel('anim.gif');

    assert.equal(imageWidth(await server.models[1]), 16);
    assert.deepEqual(lookups, ['anim.gif.json']);
    assert.equal(server.modelPrecacheFlags[1], ModelPrecacheFlags.none);
  });

  void test('does not look when the game says there is none, and flags it for the clients', async () => {
    const { api, server, lookups } = createApi();

    api.PrecacheModel('anim.gif', { sidecar: false });

    assert.equal(imageWidth(await server.models[1]), 8, 'the sidecar is not read');
    assert.deepEqual(lookups, []);
    assert.equal(server.modelPrecacheFlags[1], ModelPrecacheFlags.noSidecar);
  });

  void test('a later precache that wants the sidecar loads it after all', async () => {
    const { api, server, lookups } = createApi();

    api.PrecacheModel('anim.gif', { sidecar: false });
    await server.models[1];
    api.PrecacheModel('anim.gif');

    assert.equal(imageWidth(await server.models[1]), 16);
    assert.deepEqual(server.modelPrecache, ['', 'anim.gif']);
    assert.deepEqual(lookups, ['anim.gif.json']);
    assert.equal(server.modelPrecacheFlags[1], ModelPrecacheFlags.none);
  });

  void test('a later precache that says there is none changes nothing', async () => {
    const { api, server, lookups } = createApi();

    api.PrecacheModel('anim.gif');
    const entry = server.models[1];

    api.PrecacheModel('anim.gif', { sidecar: false });

    assert.equal(server.models[1], entry);
    assert.equal(imageWidth(await server.models[1]), 16);
    assert.deepEqual(lookups, ['anim.gif.json']);
    assert.equal(server.modelPrecacheFlags[1], ModelPrecacheFlags.none);
  });

  void test('the model cache keeps the model with the sidecar when both loads race', async () => {
    const { files } = createFiles();
    const mod = new Mod();

    mod.Init({ files, con: createSilentConsole(), loadRenderData: false });

    await mod.ForNameAsync('anim.gif', true, ModelScope.server, { collisionGeometry: false, sidecar: false });
    const full = await mod.ForNameAsync('anim.gif', true, ModelScope.server, { collisionGeometry: false, sidecar: true });
    const again = await mod.ForNameAsync('anim.gif', true, ModelScope.server, { collisionGeometry: false, sidecar: false });

    assert.equal(imageWidth(full), 16);
    assert.equal(imageWidth(again), 16, 'a request that skips the sidecar does not replace the model that has it');
  });
});

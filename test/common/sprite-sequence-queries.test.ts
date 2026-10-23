import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { Mod, ModelScope } from '../../source/engine/common/Mod.ts';
import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import type { ModelFiles } from '../../source/engine/common/model/ModelLoadContext.ts';
import { SpriteModel } from '../../source/engine/common/model/SpriteModel.ts';
import { ServerEngineAPI } from '../../source/engine/server/ServerEngineAPI.ts';
import type Server from '../../source/engine/server/Server.ts';
import { createClientEngineApi } from '../support/clientEngineApi.ts';
import { createDirectoryFiles, createSilentConsole } from '../support/modelContext.ts';

const FIXTURES = new URL('../fixtures/sprites/', import.meta.url);

/** Sidecars of the fixtures that name their sequences. */
const SIDECARS: Record<string, object> = {
  'anim.gif.json': { sequences: [{ name: 'rise', from: 0, to: 1 }, { name: 'burst', from: 2, repeat: 1 }, { name: 'idle', from: 0, direction: 'pingpong', repeat: 2 }] },
};

/**
 * @returns The fixture files, with the sidecars above.
 */
function createFiles(): ModelFiles {
  const directory = createDirectoryFiles(FIXTURES);

  return {
    ...directory,
    LoadOptionalTextFile: (name) => Promise.resolve(name in SIDECARS ? JSON.stringify(SIDECARS[name]) : null),
  };
}

/**
 * Loads fixtures into a model cache like a realm's.
 * @returns The cache and a loader.
 */
function createCache(): { mod: Mod, load: (name: string, scope: ModelScope) => Promise<BaseModel> } {
  const mod = new Mod();

  mod.Init({ files: createFiles(), con: createSilentConsole(), loadRenderData: false });

  return { mod, load: async (name, scope) => (await mod.ForNameAsync(name, true, scope))! };
}

/**
 * Asks both APIs the same questions, so a game gets the same answers on either side.
 * @returns The answers of each side.
 */
interface Asker {
  duration(name: string, frame?: number): number;
  index(name: string, sequence: string): number;
}

/**
 * @returns What a server's game sees: the models of a server whose map has loaded.
 */
async function createServerAsker(models: readonly string[]): Promise<Asker> {
  const { mod, load } = createCache();
  const server = { modelPrecache: ['', ...models, 'progs/player.mdl'], modelPrecacheFlags: [], models: [] };

  await Promise.all(models.map((name) => load(name, ModelScope.server)));
  mod.known['progs/player.mdl'] = new BaseModel('progs/player.mdl');
  mod.serverKnown['progs/player.mdl'] = mod.known['progs/player.mdl'];

  const api = new ServerEngineAPI({ server, mod } as unknown as Server, () => ({ registered: true, hipnotic: false, rogue: false }));

  return { duration: (name, frame) => api.GetSpriteSequenceDuration(name, frame), index: (name, sequence) => api.GetSpriteSequenceIndex(name, sequence) };
}

/**
 * @returns What a client's game sees: the models the server precached.
 */
async function createClientAsker(models: readonly string[]): Promise<Asker> {
  const { load } = createCache();
  const loaded = await Promise.all(models.map((name) => load(name, ModelScope.client)));
  const api = createClientEngineApi();

  clientRuntimeState.model_precache = [undefined as unknown as BaseModel, ...loaded, new BaseModel('progs/player.mdl')];

  return { duration: (name, frame) => api.GetSpriteSequenceDuration(name, frame), index: (name, sequence) => api.GetSpriteSequenceIndex(name, sequence) };
}

for (const [side, createAsker] of [['ServerEngineAPI', createServerAsker], ['ClientEngineAPI', createClientAsker]] as const) {
  void describe(`${side} sprite sequence queries`, () => {
    let previousPrecache: BaseModel[] = [];

    beforeEach(() => {
      previousPrecache = clientRuntimeState.model_precache;
    });

    afterEach(() => {
      clientRuntimeState.model_precache = previousPrecache;
    });

    void test('GetSpriteSequenceDuration tells how long a one-shot animation plays', async () => {
      const asker = await createAsker(['anim-once.gif', 'anim-loop3.gif']);

      assert.equal(Math.round(asker.duration('anim-once.gif', 0) * 1000), 350);
      assert.equal(Math.round(asker.duration('anim-loop3.gif') * 1000), 1200);
    });

    void test('GetSpriteSequenceDuration is infinite for a sequence that repeats forever', async () => {
      const asker = await createAsker(['anim.apng']);

      assert.equal(asker.duration('anim.apng'), Infinity);
    });

    void test('GetSpriteSequenceDuration is 0 for a single picture and for a model that is no sprite', async () => {
      const asker = await createAsker(['static.png']);

      assert.equal(asker.duration('static.png'), 0);
      assert.equal(asker.duration('progs/player.mdl'), 0);
    });

    void test('GetSpriteSequenceDuration takes the sequence the frame selects', async () => {
      const asker = await createAsker(['anim.gif']);

      // the images last 50, 100 and 200 ms
      assert.equal(asker.duration('anim.gif', 0), Infinity, '"rise" repeats like the file, forever');
      assert.equal(Math.round(asker.duration('anim.gif', 1) * 1000), 200, '"burst" is the last image, once');
      assert.equal(Math.round(asker.duration('anim.gif', 2) * 1000), 900, '"idle" goes 0, 1, 2, 1 in 450 ms, twice');
    });

    void test('GetSpriteSequenceDuration treats a frame out of range like the renderer does, as the first', async () => {
      const asker = await createAsker(['anim-once.gif']);

      assert.equal(asker.duration('anim-once.gif', 9), asker.duration('anim-once.gif', 0));
      assert.equal(asker.duration('anim-once.gif', -1), asker.duration('anim-once.gif', 0));
    });

    void test('GetSpriteSequenceIndex finds a sequence by name', async () => {
      const asker = await createAsker(['anim.gif']);

      assert.equal(asker.index('anim.gif', 'rise'), 0);
      assert.equal(asker.index('anim.gif', 'burst'), 1);
      assert.equal(asker.index('anim.gif', 'idle'), 2);
    });

    void test('GetSpriteSequenceIndex is -1 for an unknown name, an empty name, and a model that is no sprite', async () => {
      const asker = await createAsker(['anim.gif', 'anim.apng']);

      assert.equal(asker.index('anim.gif', 'nope'), -1);
      assert.equal(asker.index('anim.gif', ''), -1, 'a sequence without a name cannot be asked for');
      assert.equal(asker.index('anim.apng', 'rise'), -1);
      assert.equal(asker.index('progs/player.mdl', 'rise'), -1);
    });

    void test('both fail for a model that was not precached', async () => {
      const asker = await createAsker(['anim.gif']);

      assert.throws(() => asker.duration('gfx/missing.gif'), /not precached/);
      assert.throws(() => asker.index('gfx/missing.gif', 'rise'), /not precached/);
    });
  });
}

void describe('SpriteModel sequence queries', () => {
  void test('a ping-pong sequence with repeats plays its cycles', async () => {
    const { load } = createCache();
    const model = await load('anim.gif', ModelScope.server);

    assert.ok(model instanceof SpriteModel);
    // images of 50, 100 and 200 ms: one cycle goes 0, 1, 2, 1 = 50 + 100 + 200 + 100 ms, two cycles
    assert.equal(Math.round(model.sequenceDuration(2) * 1000), 900);
  });
});

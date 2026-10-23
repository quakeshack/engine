import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import { ServerEdict } from '../../source/engine/server/Edict.ts';
import { Mod, ModelScope } from '../../source/engine/common/Mod.ts';

import { defaultMockEngine, withMockEngine, mockedSV } from '../support/fixtures.ts';
import { createDirectoryFiles, createSilentConsole } from '../support/modelContext.ts';

/**
 * @returns An entity that does nothing, for an edict that only needs something to set a model on.
 */
function createTestEntity(): ServerEdict['entity'] {
  return {
    classname: 'player',
    alpha: 1,
    angles: new Vector(),
    avelocity: new Vector(),
    absmax: new Vector(),
    absmin: new Vector(),
    assignInitialData() {},
    clear() {},
    colormap: 0,
    effects: 0,
    flags: 0,
    frame: 0,
    free() {},
    groundentity: null,
    health: 100,
    mins: new Vector(),
    maxs: new Vector(),
    model: null,
    modelindex: 0,
    movetype: 0,
    origin: new Vector(),
    punchangle: new Vector(),
    size: new Vector(),
    skin: 0,
    solid: 0,
    spawn() {},
    takedamage: 0,
    team: 0,
    velocity: new Vector(),
    view_ofs: new Vector(),
    v_angle: new Vector(),
    edictId: 1,
    equals() { return false; },
    serialize() { return {}; },
    deserialize() {},
  };
}

void describe('ServerEdict', () => {
  void test('keeps getClient slot mapping separate from isClient semantics', () => {
    // Slot 15 is past maxclients: the slot of edict 16 is looked up all the same.
    const clients = Array.from({ length: 16 }, (_, slot) => new ServerClient(slot, mockedSV()));
    const reservedSlotClient = clients[15];

    withMockEngine(defaultMockEngine({
      svs: {
        maxclients: 4,
        clients,
      },
      server: {
        num_edicts: 32,
        edicts: [],
      },
    }), () => {
      const reservedWorldEdict = new ServerEdict(16, mockedSV());

      assert.equal(reservedWorldEdict.isClient(), false);
      assert.equal(reservedWorldEdict.getClient(), reservedSlotClient);
    });
  });

  void test('can suppress trigger touches during model relinks', () => {
    const linkCalls: boolean[] = [];
    const playerModel = new BaseModel('progs/player.mdl');
    playerModel.mins = new Vector(-16, -16, -24);
    playerModel.maxs = new Vector(16, 16, 32);

    withMockEngine(defaultMockEngine({
      area: {
        linkEdict(_edict: ServerEdict, touchTriggers: boolean) {
          linkCalls.push(touchTriggers);
        },
      },
      server: {
        modelPrecache: ['progs/player.mdl'],
        models: [playerModel],
      },
    }), () => {
      const edict = new ServerEdict(1, mockedSV());
      edict.entity = createTestEntity();

      edict.setModel('progs/player.mdl', false);
      edict.setMinMaxSize(Vector.origin, Vector.origin, true);
    });

    assert.deepEqual(linkCalls, [false, true]);
  });

  void test('sets the bounds of an image sprite from its file', async () => {
    const mod = new Mod();
    mod.Init({ files: createDirectoryFiles(new URL('../fixtures/sprites/', import.meta.url)), con: createSilentConsole(), loadRenderData: false });
    const flame = await mod.ForNameAsync('anim.gif', true, ModelScope.server);

    withMockEngine(defaultMockEngine({
      area: { linkEdict() {} },
      server: {
        modelPrecache: ['anim.gif'],
        models: [flame],
      },
    }), () => {
      const edict = new ServerEdict(1, mockedSV());
      edict.entity = createTestEntity();

      edict.setModel('anim.gif', false);

      assert.deepEqual([...edict.entity!.mins], [-4, -4, -2]);
      assert.deepEqual([...edict.entity!.maxs], [4, 4, 2]);
    });
  });
});

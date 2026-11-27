import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import { ServerEdict } from '../../source/engine/server/Edict.ts';
import { Mod, ModelScope } from '../../source/engine/common/Mod.ts';

import { defaultMockEngine, withMockEngine, mockedSV } from '../support/fixtures.ts';
import { assertNear } from '../support/assertions.ts';
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

  void test('sizes an entity from the union of the frame bounds of a skeletal model, which a server loads without render data', async () => {
    const mod = new Mod();
    mod.Init({ files: createDirectoryFiles(new URL('../fixtures/skeletal/', import.meta.url)), con: createSilentConsole(), loadRenderData: false });
    const player = await mod.ForNameAsync('player.iqm', true, ModelScope.server);

    withMockEngine(defaultMockEngine({
      area: { linkEdict() {} },
      server: {
        modelPrecache: ['player.iqm'],
        models: [player],
      },
    }), () => {
      const edict = new ServerEdict(1, mockedSV());
      edict.entity = createTestEntity();

      edict.setModel('player.iqm', false);

      // The bounds of progs/player.mdl: its header's translate, and translate + 255 * scale (see iqm-loader.test.ts).
      assertNear(edict.entity!.mins[0], -44.17623, 1e-3);
      assertNear(edict.entity!.mins[2], -35.06478, 1e-3);
      assertNear(edict.entity!.maxs[0], 39.2196, 1e-3);
      assertNear(edict.entity!.maxs[2], 48.4740, 1e-3);
    });
  });

  void test('a model that is still loading sizes the entity when it arrives, unless the entity was sized since', async () => {
    // A monster spawned during play while its model loads: id1's Chthon calls setSize right after setModel, and the model's
    // own bounds, arriving later, used to overwrite that size.
    const model = new BaseModel('progs/boss.iqm');
    model.mins = new Vector(-187, -264, -196);
    model.maxs = new Vector(340, 291, 377);
    let arrive: (loaded: BaseModel) => void = () => {};
    const loading = new Promise<BaseModel>((resolve) => { arrive = resolve; });

    await withMockEngine(defaultMockEngine({
      area: { linkEdict() {} },
      server: { modelPrecache: ['', 'progs/boss.iqm'], models: [null, loading] },
    }), async () => {
      const sized = new ServerEdict(1, mockedSV());
      sized.entity = createTestEntity();
      const unsized = new ServerEdict(2, mockedSV());
      unsized.entity = createTestEntity();

      sized.setModel('progs/boss.iqm', false);
      sized.setMinMaxSize(new Vector(-128, -128, -24), new Vector(128, 128, 256), false);
      unsized.setModel('progs/boss.iqm', false);

      arrive(model);
      await loading;
      await Promise.resolve();

      assert.deepEqual([...sized.entity!.mins, ...sized.entity!.maxs], [-128, -128, -24, 128, 128, 256]);
      assert.deepEqual([...unsized.entity!.mins, ...unsized.entity!.maxs], [-187, -264, -196, 340, 291, 377]);
    });
  });

  void describe('makeStatic', () => {
    /**
     * Makes an entity static and returns what was written for the client's signon.
     * @param members What the entity plays: sequence, animtime and framerate, any of them.
     * @returns The signon message.
     */
    function makeStaticWith(members: Partial<Pick<NonNullable<ServerEdict['entity']>, 'sequence' | 'animtime' | 'framerate'>>): SzBuffer {
      const signon = new SzBuffer(256, 'makeStatic signon');

      withMockEngine(defaultMockEngine({
        area: { unlinkEdict() {}, linkEdict() {} },
        ModelIndex: (name: string) => ['', 'gfx/flame.gif'].indexOf(name),
        ed: { Free() {} },
        server: { signon, modelPrecache: ['', 'gfx/flame.gif'], models: [] },
      }), () => {
        const edict = new ServerEdict(1, mockedSV());

        edict.entity = Object.assign(createTestEntity()!, { model: 'gfx/flame.gif', classname: 'light_flame', alpha: 1 }, members);
        edict.makeStatic();
      });

      return signon;
    }

    /**
     * @param signon The message.
     * @returns The bytes from the solid byte on: the flag, the block when there is one, then the angles and origin.
     */
    function afterSolid(signon: SzBuffer): DataView {
      // svc, classname + terminator, model, frame, colormap, skin, effects, alpha, solid
      const header = 1 + 'light_flame'.length + 1 + 7;

      return new DataView(signon.data, header, signon.cursize - header);
    }

    void test('writes an empty block for a decoration that plays no sequence, which is all of them in a game that does not know sequences', () => {
      const view = afterSolid(makeStaticWith({}));

      assert.equal(view.getUint8(0), 0);
      assert.equal(view.byteLength, 1 + 6 + 12, 'the mask, three angles of 16 bits and three coordinates of 32 bits');
    });

    void test('writes the sequence, its start time and its speed when the entity sets them', () => {
      const view = afterSolid(makeStaticWith({ sequence: 2, animtime: 7.5, framerate: 0.5 }));

      assert.equal(view.getUint8(0), Protocol.sequenceField.sequence | Protocol.sequenceField.animtime | Protocol.sequenceField.framerate);
      assert.equal(view.getInt16(1, true), 2);
      assert.equal(view.getFloat32(3, true), 7.5);
      assert.equal(view.getFloat32(7, true), 0.5);
      assert.equal(view.byteLength, 1 + 10 + 6 + 12);
    });

    void test('writes only the fields that were set: a game that picks a sequence but no start time leaves the clock to the client', () => {
      const sequenceOnly = afterSolid(makeStaticWith({ sequence: 1 }));
      const startOnly = afterSolid(makeStaticWith({ animtime: 3 }));
      const speedOnly = afterSolid(makeStaticWith({ framerate: 2 }));

      assert.equal(sequenceOnly.getUint8(0), Protocol.sequenceField.sequence);
      assert.equal(sequenceOnly.getInt16(1, true), 1);
      assert.equal(startOnly.getUint8(0), Protocol.sequenceField.animtime);
      assert.equal(startOnly.getFloat32(1, true), 3);
      assert.equal(speedOnly.getUint8(0), Protocol.sequenceField.framerate);
      assert.equal(speedOnly.getFloat32(1, true), 2);
    });
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

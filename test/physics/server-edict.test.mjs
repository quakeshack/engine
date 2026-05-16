import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import { ServerEdict } from '../../source/engine/server/Edict.ts';

import { defaultMockRegistry, withMockRegistry } from './fixtures.mjs';

void describe('ServerEdict', () => {
  void test('keeps getClient slot mapping separate from isClient semantics', () => {
    const reservedSlotClient = { state: 0 };

    void withMockRegistry(defaultMockRegistry({
      svs: {
        maxclients: 4,
        clients: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, reservedSlotClient],
      },
      server: {
        num_edicts: 32,
        edicts: [],
      },
    }), () => {
      const reservedWorldEdict = new ServerEdict(16);

      assert.equal(reservedWorldEdict.isClient(), false);
      assert.equal(reservedWorldEdict.getClient(), reservedSlotClient);
    });
  });

  void test('can suppress trigger touches during model relinks', () => {
    const linkCalls = [];

    void withMockRegistry(defaultMockRegistry({
      area: {
        linkEdict(_edict, touchTriggers) {
          linkCalls.push(touchTriggers);
        },
      },
      server: {
        modelPrecache: ['progs/player.mdl'],
        models: [{ mins: new Vector(-16, -16, -24), maxs: new Vector(16, 16, 32) }],
      },
    }), () => {
      const edict = new ServerEdict(1);
      edict.entity = {
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

      edict.setModel('progs/player.mdl', false);
      edict.setMinMaxSize(Vector.origin, Vector.origin, true);
    });

    assert.deepEqual(linkCalls, [false, true]);
  });
});

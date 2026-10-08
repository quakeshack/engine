import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ClientEntities, { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { BaseClientEdictHandler } from '../../source/shared/ClientEdict.ts';
import ClientSerialization from '../../source/shared/ClientSerialization.ts';
import GameModule from '../../source/engine/common/GameModule.ts';
import Vector from '../../source/shared/Vector.ts';
import { content, moveType } from '../../source/shared/Defs.ts';

import { assertNear } from '../physics/fixtures.mjs';
import { useClientStateOf } from '../support/clientState.ts';
import { installPageServices } from '../../source/engine/client/PageServices.ts';
import { createClientEngineApi } from '../support/clientEngineApi.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { engineMocks } from '../support/engineMocks.ts';

// Handlers are constructed with the page's engine API.
installPageServices({ engineApi: createClientEngineApi() });

/**
 * A synthetic client-only handler standing in for a real debris/shell-casing handler: saves a
 * die time relative to `engine.CL.time`, the same convention `R.SerializeParticles()` uses for
 * `die`, and a trivial model so `setOrigin()`'s `linkEdict()` succeeds without assertion noise.
 */
class TestDebrisHandler extends BaseClientEdictHandler {
  dieTime = 0;

  spawn() {
    this.clientEdict.model = { mins: new Vector(-8, -8, -8), maxs: new Vector(8, 8, 8) };
    if (this.dieTime === 0) {
      this.dieTime = this.engine.CL.time + 5.0;
    }
  }

  serialize() {
    return ClientSerialization.serialize({ dieTime: this.dieTime - this.engine.CL.time });
  }

  deserialize(data) {
    const restored = ClientSerialization.deserialize(data);
    this.dieTime = this.engine.CL.time + restored.dieTime;
  }
}

/**
 * Runs a callback with a test game module (resolving `test_debris` to `TestDebrisHandler`)
 * installed as the active one, restoring the previous module afterwards.
 * @param {() => void} callback
 */
function withTestGameModule(callback) {
  const previous = GameModule.active;

  GameModule.active = {
    identification: { name: 'Test Game', author: 'test', version: [1, 0, 0], capabilities: [] },
    ClientGameAPI: {
      GetClientEdictHandler: (classname) => (classname === 'test_debris' ? TestDebrisHandler : null),
    },
  };

  try {
    callback();
  } finally {
    GameModule.active = previous;
  }
}

/**
 * Runs a callback with a minimal `CL.state` (time + a trivial single-leaf worldmodel) installed,
 * so `ClientEdict.setOrigin()`/`linkEdict()` succeeds for real without assertion noise.
 * @param {number} time value for `CL.state.time` (and thus `engine.CL.time`)
 * @param {() => void} callback
 */
function withMockClRegistry(time, callback) {
  const previousCL = engineMocks.CL;

  engineMocks.CL = {
    state: {
      time,
      worldmodel: { nodes: [{ contents: content.CONTENT_EMPTY, num: 0 }] },
    },
  };

  const restoreClientState = useClientStateOf(engineMocks.CL);

  const restore = () => {
    engineMocks.CL = previousCL;
    restoreClientState();
  };

  try {
    callback();
  } finally {
    restore();
  }
}

void describe('ClientEntities.serialize/deserialize (save/load)', () => {
  void test('a persistent entity survives with matching classname/origin/angles/velocity/handler blob', () => {
    withTestGameModule(() => {
      withMockClRegistry(10.0, () => {
        const clientEntities = new ClientEntities();
        const ent = clientEntities.allocateSimulatedEntity('test_debris');
        ent.spawn(); // sets dieTime = 10.0 + 5.0 = 15.0
        ent.setOrigin(new Vector(1, 2, 3));
        ent.angles.setTo(4, 5, 6);
        ent.velocity.setTo(7, 8, 9);

        const saved = clientEntities.serialize();

        assert.equal(saved.length, 1);
        const [entry] = saved;
        assert.equal(entry.classname, 'test_debris');
        assert.deepEqual(entry.origin, [1, 2, 3]);
        assert.deepEqual(entry.angles, [4, 5, 6]);
        assert.deepEqual(entry.velocity, [7, 8, 9]);
        // dieTime (15.0) saved relative to CL.time (10.0) -- matches SerializedParticle's die convention.
        assertNear(entry.handlerData.dieTime[1], 5.0, 1e-9);
      });
    });
  });

  void test('excludes a non-persistent (static) entity', () => {
    withTestGameModule(() => {
      withMockClRegistry(10.0, () => {
        const clientEntities = new ClientEntities();
        const ent = clientEntities.allocateStaticEntity('test_debris');
        ent.spawn();
        ent.setOrigin(new Vector(1, 2, 3));

        assert.equal(ent.persistent, false);
        assert.deepEqual(clientEntities.serialize(), []);
      });
    });
  });

  void test('excludes a free (already-removed) persistent entity', () => {
    withTestGameModule(() => {
      withMockClRegistry(10.0, () => {
        const clientEntities = new ClientEntities();
        const ent = clientEntities.allocateSimulatedEntity('test_debris');
        ent.spawn();
        ent.setOrigin(new Vector(1, 2, 3));
        ent.markFree();

        assert.deepEqual(clientEntities.serialize(), []);
      });
    });
  });

  void test('round-trips through deserialize() into a fresh ClientEntities, re-anchored to a new session time', () => {
    withTestGameModule(() => {
      let saved;

      withMockClRegistry(10.0, () => {
        const original = new ClientEntities();
        const ent = original.allocateSimulatedEntity('test_debris');
        ent.spawn(); // dieTime = 10.0 + 5.0 = 15.0
        ent.setOrigin(new Vector(1, 2, 3));
        ent.angles.setTo(4, 5, 6);
        ent.velocity.setTo(7, 8, 9);

        // Simulate 2s passing in the same session before the save happens, so the saved relative
        // die time (3.0) is distinguishable from spawn()'s own fresh-entity default (5.0) below --
        // otherwise a deserialize() that did nothing at all would coincidentally match too.
        clientRuntimeState.time = 12.0;
        saved = original.serialize();
      });

      // A brand new session: CL.state.time restarts near zero, unrelated to the old session's 12.0.
      withMockClRegistry(2.0, () => {
        const restored = new ClientEntities();
        restored.deserialize(saved);

        const entities = [...restored.getEntities()];
        assert.equal(entities.length, 1);

        const [ent] = entities;
        assert.equal(ent.classname, 'test_debris');
        assert.deepEqual([...ent.origin], [1, 2, 3]);
        assert.deepEqual([...ent.angles], [4, 5, 6]);
        assert.deepEqual([...ent.velocity], [7, 8, 9]);
        assert.equal(ent.persistent, true);

        // dieTime re-anchored to the new session's time (2.0 + 3.0), not the old absolute 15.0,
        // and not spawn()'s own fresh-entity default of 5.0.
        assertNear(ent.serialize().dieTime[1], 3.0, 1e-9);
      });
    });
  });

  void test('restores the entity model by name from the precache list, linking it into the world', () => {
    const modelFixture = { name: 'progs/gib1.mdl', mins: new Vector(-8, -8, -8), maxs: new Vector(8, 8, 8) };
    const otherModel = { name: 'progs/gib2.mdl', mins: new Vector(-8, -8, -8), maxs: new Vector(8, 8, 8) };

    class ModelessHandler extends BaseClientEdictHandler {}

    const previous = GameModule.active;
    GameModule.active = {
      identification: { name: 'Test Game', author: 'test', version: [1, 0, 0], capabilities: [] },
      ClientGameAPI: { GetClientEdictHandler: () => ModelessHandler },
    };

    try {
      let saved;

      withMockClRegistry(10.0, () => {
        const original = new ClientEntities();
        const ent = original.allocateSimulatedEntity('test_modeled');
        ent.model = modelFixture;
        ent.setOrigin(new Vector(1, 2, 3));

        saved = original.serialize();
      });

      assert.equal(saved[0].model, 'progs/gib1.mdl');

      withMockClRegistry(2.0, () => {
        // model index 0 is never a real model, mirroring a real precache list
        clientRuntimeState.model_precache = [undefined, otherModel, modelFixture];

        const restored = new ClientEntities();
        restored.deserialize(saved);

        const [ent] = [...restored.getEntities()];
        assert.equal(ent.model, modelFixture);
        // setOrigin() ran with the model already in place, so the entity was linked into a leaf
        assert.deepEqual(ent.leafs, [0]);
      });
    } finally {
      GameModule.active = previous;
    }
  });

  void test('leaves the model null when it is no longer in the precache list', () => {
    const modelFixture = { name: 'progs/gone.mdl', mins: new Vector(-8, -8, -8), maxs: new Vector(8, 8, 8) };

    class ModelessHandler extends BaseClientEdictHandler {}

    const previous = GameModule.active;
    GameModule.active = {
      identification: { name: 'Test Game', author: 'test', version: [1, 0, 0], capabilities: [] },
      ClientGameAPI: { GetClientEdictHandler: () => ModelessHandler },
    };

    try {
      withMockClRegistry(2.0, () => {
        clientRuntimeState.model_precache = [];

        const restored = new ClientEntities();
        restored.deserialize([{
          classname: 'test_modeled',
          model: modelFixture.name,
          origin: [0, 0, 0],
          angles: [0, 0, 0],
          velocity: [0, 0, 0],
          movetype: moveType.MOVETYPE_NONE,
          avelocity: [0, 0, 0],
          gravity: 1.0,
          onGround: false,
          handlerData: null,
        }]);

        assert.equal([...restored.getEntities()][0].model, null);
      });
    } finally {
      GameModule.active = previous;
    }
  });

  void test('round-trips the engine-driven physics state, restored after spawn() so a handler cannot overwrite it', () => {
    class TossingHandler extends BaseClientEdictHandler {
      spawn() {
        this.clientEdict.movetype = moveType.MOVETYPE_BOUNCE;
        this.clientEdict.avelocity.setTo(1, 2, 3);
        this.clientEdict.gravity = 1.0;
        this.clientEdict.onGround = false;
      }
    }

    const previous = GameModule.active;
    GameModule.active = {
      identification: { name: 'Test Game', author: 'test', version: [1, 0, 0], capabilities: [] },
      ClientGameAPI: { GetClientEdictHandler: () => TossingHandler },
    };

    try {
      let saved;

      withMockClRegistry(10.0, () => {
        const original = new ClientEntities();
        const ent = original.allocateSimulatedEntity('test_tossing');
        ent.model = { name: 'progs/gib1.mdl', mins: new Vector(-8, -8, -8), maxs: new Vector(8, 8, 8) };
        ent.spawn();
        ent.setOrigin(new Vector(1, 2, 3));
        ent.movetype = moveType.MOVETYPE_TOSS;
        ent.avelocity.setTo(40, 50, 60);
        ent.gravity = 0.25;
        ent.onGround = true;

        saved = original.serialize();
      });

      assert.equal(saved[0].movetype, moveType.MOVETYPE_TOSS);
      assert.deepEqual(saved[0].avelocity, [40, 50, 60]);
      assert.equal(saved[0].gravity, 0.25);
      assert.equal(saved[0].onGround, true);

      withMockClRegistry(2.0, () => {
        clientRuntimeState.model_precache = [undefined, { name: 'progs/gib1.mdl', mins: new Vector(-8, -8, -8), maxs: new Vector(8, 8, 8) }];

        const restored = new ClientEntities();
        restored.deserialize(saved);

        const [ent] = [...restored.getEntities()];
        assert.equal(ent.movetype, moveType.MOVETYPE_TOSS, 'not the BOUNCE spawn() set');
        assert.deepEqual([...ent.avelocity], [40, 50, 60]);
        assert.equal(ent.gravity, 0.25);
        assert.equal(ent.onGround, true);
      });
    } finally {
      GameModule.active = previous;
    }
  });

  void test('a freed edict loses its physics state', () => {
    const ent = new ClientEdict(-1);
    ent.movetype = moveType.MOVETYPE_BOUNCE;
    ent.avelocity.setTo(1, 2, 3);
    ent.gravity = 0.5;
    ent.onGround = true;

    ent.freeEdict();

    assert.equal(ent.movetype, moveType.MOVETYPE_NONE);
    assert.deepEqual([...ent.avelocity], [0, 0, 0]);
    assert.equal(ent.gravity, 1.0);
    assert.equal(ent.onGround, false);
  });
});


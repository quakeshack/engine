import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ClientEntities, { ClientDlight, ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { BaseClientEdictHandler } from '../../source/shared/ClientEdict.ts';
import Vector from '../../source/shared/Vector.ts';
import { content, effect } from '../../source/shared/Defs.ts';
import GameModule from '../../source/engine/common/GameModule.ts';
import { createTreeModel } from '../support/bspTree.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import type { ClientEngineAPI } from '../../source/engine/client/ClientEngineAPI.ts';
import { createBoundsModel, createGameModuleStub } from '../support/fixtures.ts';
import type { BrushModel } from '../../source/engine/common/model/BSP.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

/**
 * Computes wrapped angular delta in degrees.
 * @param from
 * @param to
 * @returns Wrapped angular delta in [-180, 180).
 */
function shortestAngleDelta(from: number, to: number): number {
  return ((to - from + 540.0) % 360.0) - 180.0;
}

/**
 * Sets the render time of the mocked client messages. The real one is computed from the last snapshot and the clock,
 * so the mock that `withMockClientEntitiesRegistry` installs has it as a plain value.
 * @param value The render time.
 */
function setRenderTime(value: number): void {
  Reflect.set(clientRuntimeState.clientMessages, 'renderTime', value);
}

/**
 * Runs a callback with a minimal client registry fixture.
 * @param callback
 */
function withMockClientEntitiesRegistry(callback: () => void) {
  withEngineMocks({
    CL: {
      nolerp: { value: 0 },
      state: {
        clientMessages: {
          mtime: [0.0],
          // mirrors ClientMessages.renderTime: mtime[0] extrapolated by real
          // elapsed time; tests set this directly instead of mocking Host.
          renderTime: 0.0,
        },
      },
    },
  }, callback);
}

/**
 * Runs a callback with a minimal registry fixture for dlight simulation time
 * (`CL.state.time`) and frame delta (`Host.frametime`).
 * @param time Current simulation time (`CL.state.time`).
 * @param frametime Per-frame delta (`Host.frametime`).
 * @param callback
 */
function withMockDlightRegistry(time: number, frametime: number, callback: () => void) {
  withEngineMocks({ CL: { state: { time } }, Host: { frametime } }, callback);
}

void describe('ClientEdict.lerp.angles', () => {
  void test('uses shortest-path quaternion interpolation for wrapped yaw', () => {
    withMockClientEntitiesRegistry(() => {
      const entity = new ClientEdict(1);

      entity.anglesPrevious.setTo(0.0, 350.0, 0.0);
      entity.angles.setTo(0.0, 10.0, 0.0);
      entity.anglesTime = 0.0;
      entity.lerpEndTime = 1.0;
      setRenderTime(0.5);

      const lerped = entity.lerp.angles;
      const deltaYaw = shortestAngleDelta(entity.anglesPrevious[1], lerped[1]);

      assert.ok(Math.abs(deltaYaw - 10.0) < 0.001);
    });
  });

  void test('does not mutate stored network angles while lerping', () => {
    withMockClientEntitiesRegistry(() => {
      const entity = new ClientEdict(2);

      entity.anglesPrevious.setTo(35.0, -170.0, 80.0);
      entity.angles.setTo(-20.0, 175.0, -40.0);
      entity.anglesTime = 0.0;
      entity.lerpEndTime = 1.0;
      setRenderTime(0.5);

      void entity.lerp.angles;

      assert.deepEqual([...entity.anglesPrevious], [35.0, -170.0, 80.0]);
      assert.deepEqual([...entity.angles], [-20.0, 175.0, -40.0]);
    });
  });
});

void describe('ClientEdict.lerp.origin', () => {
  void test('advances between renders even while mtime[0] is unchanged (no new snapshot yet)', () => {
    // Regression test: interpolation used to be driven directly off mtime[0],
    // which only changes once per received network snapshot. That froze the
    // rendered position for every frame in between, producing a visible pop
    // instead of smooth motion. renderTime advances continuously instead.
    withMockClientEntitiesRegistry(() => {
      const entity = new ClientEdict(3);

      entity.originPrevious.setTo(0.0, 0.0, 0.0);
      entity.origin.setTo(100.0, 0.0, 0.0);
      entity.originTime = 0.0;
      entity.lerpEndTime = 1.0;

      // mtime[0] simulates "last received snapshot time" and stays fixed
      // here, as it would between two network packets.
      clientRuntimeState.clientMessages.mtime[0] = 0.0;

      setRenderTime(0.2);
      const first = entity.lerp.origin[0];

      setRenderTime(0.6);
      const second = entity.lerp.origin[0];

      assert.ok(second > first, `expected interpolation to advance (${first} -> ${second})`);
    });
  });
});

void describe('ClientEdict.dropOriginLerp', () => {
  void test('renders the predicted origin as is instead of interpolating from the origin of the last message', () => {
    // Regression test: the player entity is moved by client prediction every frame while a server message
    // snapshots originPrevious. Rendering lerp(originPrevious, origin) made the chase cam player flicker
    // along that line, and sweep across the map after a teleport.
    withMockClientEntitiesRegistry(() => {
      const entity = new ClientEdict(4);

      entity.originPrevious.setTo(0.0, 0.0, 0.0);
      entity.origin.setTo(2000.0, 0.0, 0.0); // predicted position right after a teleport
      entity.originTime = 0.0;
      entity.lerpEndTime = 1.0;
      setRenderTime(0.2);

      assert.ok(entity.lerp.origin[0] < 2000.0, 'without the fix the origin is interpolated');

      entity.dropOriginLerp();

      assert.deepEqual([...entity.lerp.origin], [2000.0, 0.0, 0.0]);
    });
  });

  void test('lerping resumes when a later message snapshots a new previous origin', () => {
    withMockClientEntitiesRegistry(() => {
      const entity = new ClientEdict(5);

      entity.origin.setTo(100.0, 0.0, 0.0);
      entity.dropOriginLerp();
      entity.originPrevious.setTo(0.0, 0.0, 0.0);
      entity.originTime = 0.0;
      entity.lerpEndTime = 1.0;
      setRenderTime(0.5);

      assert.equal(entity.lerp.origin[0], 50.0);
    });
  });
});

/**
 * Runs a callback with a minimal `CL.state.worldmodel` installed so `ClientEdict.setOrigin()`/
 * `linkEdict()` can recompute `leafs` against a real (if tiny) BSP node tree.
 * @param worldmodel worldmodel fixture with a root BSP node
 * @param callback
 */
function withMockWorldmodelRegistry(worldmodel: BrushModel, callback: () => void) {
  withEngineMocks({ CL: { state: { worldmodel } } }, callback);
}

void describe('ClientEdict.linkEdict', () => {
  void test('replaces leafs on each call instead of accumulating them across repeated setOrigin() calls', () => {
    // Regression test: #splitEntityOnNode only ever appends to `leafs`, so without clearing it
    // first, a repeatedly-moved entity (e.g. ClientEntityPhysics.step() calling setOrigin() every
    // frame) would keep every leaf it had ever occupied instead of just its current one.
    // leaf 0 is the outside leaf of every map
    const worldmodel = createTreeModel(
      [{ normal: [1, 0, 0], dist: 0, type: 0 }],
      [{ planeNum: 0, children: [~1, ~2] }],
      [{}, { contents: content.CONTENT_EMPTY }, { contents: content.CONTENT_EMPTY }],
    );

    withMockWorldmodelRegistry(worldmodel, () => {
      const entity = new ClientEdict(-1);
      entity.model = createBoundsModel(new Vector(-8, -8, -8), new Vector(8, 8, 8));

      entity.setOrigin(new Vector(50, 0, 0));
      assert.deepEqual(entity.leafs, [1]);

      entity.setOrigin(new Vector(-50, 0, 0));
      assert.deepEqual(entity.leafs, [2], 'expected the stale leaf from the previous position to be gone, not appended to');
    });
  });
});

void describe('ClientEdict.markFree', () => {
  void test('sets free to true', () => {
    const entity = new ClientEdict(-1);

    assert.equal(entity.free, false);

    entity.markFree();

    assert.equal(entity.free, true);
  });
});

void describe('ClientEntities.getEntities', () => {
  void test('stops yielding a client-owned entity once its handler calls remove()', () => {
    const clientEntities = new ClientEntities();
    const entity = clientEntities.allocateClientEntity();

    assert.ok([...clientEntities.getEntities()].includes(entity));

    class TestEdictHandler extends BaseClientEdictHandler {
      triggerRemove() {
        this.remove();
      }
    }

    new TestEdictHandler(entity, {} as ClientEngineAPI).triggerRemove();

    assert.equal(entity.free, true);
    assert.ok(![...clientEntities.getEntities()].includes(entity));
  });
});

void describe('ClientEdict.spawn', () => {
  /**
   * Allocates a client-only entity whose handler records the parameters it is spawned with.
   * @returns the entity and the recorded spawn() arguments
   */
  function allocateRecordingEntity(): {entity: ClientEdict, spawned: Array<object|undefined>} {
    const spawned: Array<object | undefined> = [];

    class RecordingHandler extends BaseClientEdictHandler {
      override spawn(parameters?: object) {
        spawned.push(parameters);
      }
    }

    const previous = GameModule.active;
    GameModule.active = createGameModuleStub({ ClientGameAPI: { GetClientEdictHandler: () => RecordingHandler } });

    try {
      return { entity: new ClientEntities().allocateSimulatedEntity('test_recording'), spawned };
    } finally {
      GameModule.active = previous;
    }
  }

  void test('hands the per-instance parameters on to the handler', () => {
    const { entity, spawned } = allocateRecordingEntity();

    entity.spawn({ delay: 2.5 });

    assert.deepEqual(spawned, [{ delay: 2.5 }]);
  });

  void test('passes no parameters when the entity comes from the network, a map or a save game', () => {
    const { entity, spawned } = allocateRecordingEntity();

    entity.spawn();

    assert.deepEqual(spawned, [undefined]);
  });
});

void describe('ClientEntities.isPotentiallyVisible', () => {
  /**
   * Runs a callback with a registry fixture whose world answers every PVS lookup with the given
   * visibility, so `emit()` can run its static entity pass.
   * @param visibility the PVS of the current view
   * @param callback
   */
  function withViewVisibility(visibility: {areRevealed: (leafs: number[]) => boolean}, callback: () => void) {
    withEngineMocks({
      CL: { state: { worldmodel: { getPvsByPoint: () => visibility }, viewentity: 1 } },
      R: { novis: { value: 0 }, refdef: { vieworg: new Vector() } },
    }, callback);
  }

  void test('is true before any view has been processed', () => {
    const entity = new ClientEdict(-1);
    entity.leafs.push(7);

    assert.equal(new ClientEntities().isPotentiallyVisible(entity), true);
  });

  void test('follows the PVS of the view of the last emit pass, also for entities that are not drawn', () => {
    const clientEntities = new ClientEntities();
    const seen = clientEntities.allocateStaticEntity('test_seen');
    const hidden = clientEntities.allocateStaticEntity('test_hidden');
    const undrawn = clientEntities.allocateStaticEntity('test_undrawn');
    seen.leafs.push(1);
    hidden.leafs.push(2);
    undrawn.leafs.push(1);
    undrawn.effects |= effect.EF_NODRAW;

    withViewVisibility({ areRevealed: (leafs) => leafs.includes(1) }, () => {
      clientEntities.emit();

      assert.equal(clientEntities.isPotentiallyVisible(seen), true);
      assert.equal(clientEntities.isPotentiallyVisible(hidden), false);
      assert.equal(clientEntities.isPotentiallyVisible(undrawn), true);
    });
  });

  void test('cannot tell an entity that is not linked into any leaf, so it counts as visible', () => {
    const clientEntities = new ClientEntities();
    const unlinked = clientEntities.allocateStaticEntity('test_unlinked');

    withViewVisibility({ areRevealed: () => false }, () => {
      clientEntities.emit();

      assert.equal(clientEntities.isPotentiallyVisible(unlinked), true);
    });
  });

  void test('forgets the view when the entities are cleared for a new map', () => {
    const clientEntities = new ClientEntities();
    const entity = clientEntities.allocateStaticEntity('test_entity');
    entity.leafs.push(2);

    withViewVisibility({ areRevealed: () => false }, () => {
      clientEntities.emit();
      assert.equal(clientEntities.isPotentiallyVisible(entity), false);

      clientEntities.clear();
      assert.equal(clientEntities.isPotentiallyVisible(entity), true);
    });
  });
});

void describe('ClientDlight.think', () => {
  void test('decays radius by the per-frame delta, not the absolute session time', () => {
    // Regression test: think() used to multiply `decay` by the absolute
    // CL.state.time instead of Host.frametime, so any light with nonzero
    // decay (e.g. explosions) would collapse to zero on its very first
    // think() once the session had been running for more than an instant.
    withMockDlightRegistry(50.0, 0.1, () => {
      const dl = new ClientDlight();
      dl.radius = 350.0;
      dl.decay = 300.0;
      dl.bornTime = 49.9;
      dl.die = 1000.0;

      dl.think();

      assert.ok(Math.abs(dl.radius - 320.0) < 0.001, `expected ~320, got ${dl.radius}`);
    });
  });

  void test('fades a zero-decay light smoothly as it approaches its die time', () => {
    // Muzzle flashes, e-lights, etc. never set `decay` and previously held
    // full radius until `die`, then vanished instantly on the next frame.
    withMockDlightRegistry(0.375, 0.01, () => {
      const dl = new ClientDlight();
      dl.radius = 200.0;
      dl.decay = 0.0;
      dl.bornTime = 0.0;
      dl.die = 0.5; // lifetime 0.5s -> fade window is 0.25s (halfway point)

      dl.think();

      assert.ok(Math.abs(dl.radius - 100.0) < 0.001, `expected ~100, got ${dl.radius}`);
    });
  });

  void test('reaches exactly zero radius at the die time, never negative', () => {
    withMockDlightRegistry(0.5, 0.01, () => {
      const dl = new ClientDlight();
      dl.radius = 200.0;
      dl.decay = 0.0;
      dl.bornTime = 0.0;
      dl.die = 0.5;

      dl.think();

      assert.equal(dl.radius, 0.0);
    });
  });
});

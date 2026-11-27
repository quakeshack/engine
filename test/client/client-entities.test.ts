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
import { CollisionTrace } from '../../source/engine/server/physics/ServerCollisionSupport.ts';
import { assertNear } from '../support/assertions.ts';

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

// A game puts the light of a muzzle flash 20 units ahead of the entity, which is farther than a player's hull is wide.
// Flush against a wall that is inside the wall, and the world's cube shadow swallowed the light: only the shooter was lit,
// until the shooter walked backwards away from the wall.
void describe('ClientEntities.emit keeps the light of an entity out of the walls', () => {
  /**
   * A world with one wall, the plane x = `wallX`, that blocks a line crossing it from the open side (x below it).
   * @param wallX where the wall is
   * @returns a traceStaticWorldLine() mock
   */
  function wallAt(wallX: number): (start: Vector, end: Vector) => CollisionTrace {
    return (start: Vector, end: Vector) => {
      if (start[0] >= wallX) {
        return new CollisionTrace(start.copy(), { fraction: 0, allsolid: true, startsolid: true });
      }

      if (end[0] <= wallX) {
        return new CollisionTrace(end.copy(), {});
      }

      const fraction = (wallX - start[0]) / (end[0] - start[0]);

      return new CollisionTrace(start.copy().add(end.copy().subtract(start).multiply(fraction)), { fraction });
    };
  }

  /**
   * Runs the emit pass for a server entity, number 5, at the origin facing +X, with the default handler.
   * @param trace The world.
   * @param flashing Whether the entity has `EF_MUZZLEFLASH`, and so makes its own light.
   * @param before What to do with the registry before the pass.
   * @returns The registry after the pass.
   */
  function emitWorld(trace: (start: Vector, end: Vector) => CollisionTrace, flashing = true, before: (clientEntities: ClientEntities) => void = () => {}): ClientEntities {
    const clientEntities = new ClientEntities();

    withEngineMocks({
      CL: {
        nolerp: { value: 0 },
        collision: { traceStaticWorldLine: trace },
        state: { time: 1, clientEntities, worldmodel: { getPvsByPoint: () => ({ areRevealed: () => true }) }, viewentity: 1, clientMessages: { mtime: [0.0], renderTime: 0.0 } },
      },
      R: { novis: { value: 0 }, refdef: { vieworg: new Vector() } },
      Host: { frametime: 0.1 },
    }, () => {
      const shooter = clientEntities.getEntity(5);

      shooter.model = createBoundsModel(new Vector(-16, -16, -24), new Vector(16, 16, 32));
      shooter.updatecount = 1;
      shooter.origin.setTo(0, 0, 0);
      shooter.angles.setTo(0, 0, 0);
      shooter.msg_origins[0].setTo(0, 0, 0);
      shooter.msg_angles[0].setTo(0, 0, 0);
      shooter.effects = flashing ? effect.EF_MUZZLEFLASH : 0;
      shooter.loadHandler();
      before(clientEntities);

      clientEntities.emit();
    });

    return clientEntities;
  }

  /**
   * @param clientEntities The registry.
   * @param entity The entity number the light belongs to.
   * @returns Where its light is, rounded to a hundredth, `null` when it has none.
   */
  function lightOf(clientEntities: ClientEntities, entity: number): number[] | null {
    const light = clientEntities.dlights.find((candidate) => candidate.entity === entity && candidate.die > 0);

    return light === undefined ? null : Array.from(light.origin).map((value) => Math.round(value * 100) / 100);
  }

  void test('leaves the light where the game put it, 20 ahead and 16 up, when nothing is in the way', () => {
    assert.deepEqual(lightOf(emitWorld(wallAt(1000)), 5), [20, 0, 16]);
  });

  void test('pulls a light that is inside a wall back to 4 units before the wall, on the line from the entity', () => {
    // the wall is 18 ahead, where a player stands when flush against it: the light at 20 is 2 inside. The line from the
    // origin to (20, 0, 16) meets the wall at 18/20 of the way.
    const length = Math.hypot(20, 16);
    const reach = length * (18 / 20) - 4;
    const [x, y, z] = lightOf(emitWorld(wallAt(18)), 5)!;

    assertNear(x, reach * (20 / length), 0.01);
    assertNear(y, 0, 0.01);
    assertNear(z, reach * (16 / length), 0.01);
    assert.ok(x < 18, 'the light is on this side of the wall');
  });

  void test('never moves the light behind its entity, however close the wall is', () => {
    assert.deepEqual(lightOf(emitWorld(wallAt(1)), 5), [0, 0, 0]);
  });

  void test('leaves the light of an entity whose own origin is in solid alone, as for a player in noclip', () => {
    assert.deepEqual(lightOf(emitWorld(wallAt(-5)), 5), [20, 0, 16]);
  });

  void test('leaves a light that belongs to no entity where it is, such as an explosion in a wall', () => {
    const clientEntities = emitWorld(wallAt(18), false, (registry) => {
      // slot 0 is the world, whose origin is the origin of the map: a light without an owner must not be traced from it
      registry.getEntity(0).origin.setTo(0, 0, 0);

      const dl = registry.allocateDynamicLight(0);

      dl.origin = new Vector(30, 0, 0);
      dl.radius = 300;
      dl.die = 5;
    });
    const explosion = clientEntities.dlights.find((light) => light.die === 5)!;

    assert.deepEqual(Array.from(explosion.origin), [30, 0, 0]);
  });
});

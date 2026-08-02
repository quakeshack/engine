import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ClientEntities, { ClientDlight, ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { BaseClientEdictHandler } from '../../source/shared/ClientEdict.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Computes wrapped angular delta in degrees.
 * @param {number} from
 * @param {number} to
 * @returns {number} Wrapped angular delta in [-180, 180).
 */
function shortestAngleDelta(from, to) {
  return ((to - from + 540.0) % 360.0) - 180.0;
}

/**
 * Runs a callback with a minimal client registry fixture.
 * @param {() => void} callback
 */
function withMockClientEntitiesRegistry(callback) {
  const previousCL = registry.CL;

  registry.CL = {
    nolerp: { value: 0 },
    state: {
      clientMessages: {
        mtime: [0.0],
        // mirrors ClientMessages.renderTime: mtime[0] extrapolated by real
        // elapsed time; tests set this directly instead of mocking Host.
        renderTime: 0.0,
      },
    },
  };
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.CL = previousCL;
    eventBus.publish('registry.frozen');
  };

  try {
    callback();
  } finally {
    restore();
  }
}

/**
 * Runs a callback with a minimal registry fixture for dlight simulation time
 * (`CL.state.time`) and frame delta (`Host.frametime`).
 * @param {number} time Current simulation time (`CL.state.time`).
 * @param {number} frametime Per-frame delta (`Host.frametime`).
 * @param {() => void} callback
 */
function withMockDlightRegistry(time, frametime, callback) {
  const previousCL = registry.CL;
  const previousHost = registry.Host;

  registry.CL = { state: { time } };
  registry.Host = { frametime };
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.CL = previousCL;
    registry.Host = previousHost;
    eventBus.publish('registry.frozen');
  };

  try {
    callback();
  } finally {
    restore();
  }
}

void describe('ClientEdict.lerp.angles', () => {
  void test('uses shortest-path quaternion interpolation for wrapped yaw', () => {
    withMockClientEntitiesRegistry(() => {
      const entity = new ClientEdict(1);

      entity.anglesPrevious.setTo(0.0, 350.0, 0.0);
      entity.angles.setTo(0.0, 10.0, 0.0);
      entity.anglesTime = 0.0;
      entity.lerpEndTime = 1.0;
      registry.CL.state.clientMessages.renderTime = 0.5;

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
      registry.CL.state.clientMessages.renderTime = 0.5;

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
      registry.CL.state.clientMessages.mtime[0] = 0.0;

      registry.CL.state.clientMessages.renderTime = 0.2;
      const first = entity.lerp.origin[0];

      registry.CL.state.clientMessages.renderTime = 0.6;
      const second = entity.lerp.origin[0];

      assert.ok(second > first, `expected interpolation to advance (${first} -> ${second})`);
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

    new TestEdictHandler(entity, {}).triggerRemove();

    assert.equal(entity.free, true);
    assert.ok(![...clientEntities.getEntities()].includes(entity));
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

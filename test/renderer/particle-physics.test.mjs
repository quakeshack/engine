import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import R from '../../source/engine/client/R.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import Vector from '../../source/shared/Vector.ts';
import { content } from '../../source/shared/Defs.ts';

/**
 * Runs a callback with a mocked `SV.collision` installed, so `R.ResolveParticleCollision()` can
 * be tested without a real BSP world -- it only ever calls `pointContents()`/
 * `traceStaticWorldLine()`, both fully mocked here.
 * @param {{pointContents?: (point: Vector) => number, traceStaticWorldLine?: (start: Vector, end: Vector) => object}} collision mock collision methods
 * @param {() => void} callback
 */
function withMockCollisionRegistry(collision, callback) {
  const previousSV = registry.SV;

  registry.SV = /** @type {typeof import('../../source/engine/server/SV.ts').default} */ ({ collision });
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.SV = previousSV;
    eventBus.publish('registry.frozen');
  };

  try {
    callback();
  } finally {
    restore();
  }
}

void describe('R.collidableParticleTypes', () => {
  void test('contains exactly the gravity-falling particle types, excluding fire and tracer', () => {
    // fire drifts upward (embers) rather than falling, and tracer never integrates gravity at
    // all -- neither should pay for collision checks.
    assert.deepEqual(
      [...R.collidableParticleTypes].sort((a, b) => a - b),
      [R.ptype.grav, R.ptype.slowgrav, R.ptype.explode, R.ptype.explode2, R.ptype.blob, R.ptype.blob2].sort((a, b) => a - b),
    );
    assert.equal(R.collidableParticleTypes.has(R.ptype.fire), false);
    assert.equal(R.collidableParticleTypes.has(R.ptype.tracer), false);
  });
});

void describe('R.ResolveParticleCollision', () => {
  void test('moves to newOrigin and skips the real trace when the destination is not solid', () => {
    let traceCalls = 0;

    withMockCollisionRegistry({
      pointContents: () => content.CONTENT_EMPTY,
      traceStaticWorldLine: () => {
        traceCalls++;
        throw new Error('should not be called when the cheap point check finds open space');
      },
    }, () => {
      const origin = new Vector(0, 0, 100);
      const velocity = new Vector(10, 0, -50);
      const newOrigin = new Vector(1, 0, 95);

      const died = R.ResolveParticleCollision(origin, velocity, newOrigin);

      assert.equal(died, false);
      assert.deepEqual([...origin], [1, 0, 95]);
      assert.deepEqual([...velocity], [10, 0, -50], 'velocity is untouched when nothing was hit');
      assert.equal(traceCalls, 0);
    });
  });

  void test('reflects velocity off a floor-like surface via the shared PhysicsMath.clipVelocity formula', () => {
    withMockCollisionRegistry({
      pointContents: () => content.CONTENT_SOLID,
      traceStaticWorldLine: (start, end) => ({
        allsolid: false,
        startsolid: false,
        fraction: 0.5,
        endpos: start.copy().add(end.copy().subtract(start).multiply(0.5)),
        plane: { normal: new Vector(0, 0, 1), dist: 0 },
      }),
    }, () => {
      const origin = new Vector(0, 0, 1);
      const velocity = new Vector(0, 0, -100);
      const newOrigin = new Vector(0, 0, -9);

      const died = R.ResolveParticleCollision(origin, velocity, newOrigin);

      assert.equal(died, false, 'a floor-like impact bounces instead of killing the particle');
      assert.deepEqual([...origin], [0, 0, -4], 'origin snaps to the trace impact point, not newOrigin');
      // PhysicsMath.clipVelocity(vec=(0,0,-100), normal=(0,0,1), overbounce=1.5):
      // backoff = dot(vec, normal) * 1.5 = -150; out.z = vec.z - normal.z * backoff = -100 + 150 = 50
      assert.deepEqual([...velocity], [0, 0, 50]);
    });
  });

  void test('reports a kill for a wall/ceiling-like surface instead of bouncing', () => {
    withMockCollisionRegistry({
      pointContents: () => content.CONTENT_SOLID,
      traceStaticWorldLine: (start) => ({
        allsolid: false,
        startsolid: false,
        fraction: 0.5,
        endpos: start.copy(),
        plane: { normal: new Vector(1, 0, 0), dist: 0 }, // vertical wall, normal.z === 0
      }),
    }, () => {
      const origin = new Vector(0, 0, 50);
      const velocity = new Vector(200, 0, 0);
      const newOrigin = new Vector(20, 0, 50);

      const died = R.ResolveParticleCollision(origin, velocity, newOrigin);

      assert.equal(died, true);
      assert.deepEqual([...velocity], [200, 0, 0], 'velocity is left alone for a particle about to be killed');
    });
  });

  void test('reports a kill when the trace starts and stays entirely solid', () => {
    withMockCollisionRegistry({
      pointContents: () => content.CONTENT_SOLID,
      traceStaticWorldLine: (start) => ({
        allsolid: true,
        startsolid: true,
        fraction: 0,
        endpos: start.copy(),
        plane: { normal: new Vector(0, 0, 1), dist: 0 }, // even a floor-like normal shouldn't save it
      }),
    }, () => {
      const origin = new Vector(0, 0, 0);
      const velocity = new Vector(0, 0, -50);
      const newOrigin = new Vector(0, 0, -5);

      const died = R.ResolveParticleCollision(origin, velocity, newOrigin);

      assert.equal(died, true);
    });
  });

  void test('does not kill the particle when the point check flags solid but the swept trace finds no real hit', () => {
    // Regression test: found live in a real map via browser verification. A point right at a
    // BSP boundary can classify as solid via the cheap pointContents() pre-filter while the
    // actual swept trace along the path reports fraction 1.0 (nothing really hit) -- a
    // boundary/epsilon disagreement between point classification and segment tracing. The
    // fallback CollisionTrace in that case carries a default zero plane (normal.z === 0), which
    // used to satisfy the wall/ceiling check and kill the particle for no real reason.
    withMockCollisionRegistry({
      pointContents: () => content.CONTENT_SOLID,
      traceStaticWorldLine: (_start, end) => ({
        allsolid: false,
        startsolid: false,
        fraction: 1.0,
        endpos: end.copy(),
        plane: { normal: new Vector(), dist: 0 }, // default/empty plane, as CollisionTrace.empty() carries
      }),
    }, () => {
      const origin = new Vector(0, 0, 50);
      const velocity = new Vector(10, 0, -30);
      const newOrigin = new Vector(1, 0, 47);

      const died = R.ResolveParticleCollision(origin, velocity, newOrigin);

      assert.equal(died, false);
      assert.deepEqual([...origin], [1, 0, 47]);
      assert.deepEqual([...velocity], [10, 0, -30], 'velocity is untouched -- nothing was actually hit');
    });
  });
});

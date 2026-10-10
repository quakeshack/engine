import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import R from '../../source/engine/client/R.ts';
import Vector from '../../source/shared/Vector.ts';
import { useClientStateOf } from '../support/clientState.ts';

const POOL_SIZE = 8;
const CLOCK = 100.0;

void describe('particle pool', () => {
  const previousParticles = R.particles;
  const previousCount = R.numparticles;
  let restoreClientState: () => void = () => {};

  beforeEach(() => {
    R.numparticles = POOL_SIZE;
    R.ClearParticles();
    restoreClientState = useClientStateOf({ state: { time: CLOCK } });
  });

  afterEach(() => {
    restoreClientState();
    R.particles = previousParticles;
    R.numparticles = previousCount;
  });

  void describe('ClearParticles', () => {
    void test('fills the pool with dead particles', () => {
      assert.equal(R.particles.length, POOL_SIZE);

      for (const particle of R.particles) {
        assert.ok(particle.die < CLOCK);
      }
    });
  });

  void describe('AllocParticles', () => {
    void test('hands out the lowest free slots first', () => {
      assert.deepEqual(R.AllocParticles(3), [0, 1, 2]);
    });

    void test('skips slots that are still alive', () => {
      R.particles[1].die = CLOCK + 50.0;

      assert.deepEqual(R.AllocParticles(3), [0, 2, 3]);
    });

    void test('treats a particle as alive until the clock has passed its die time', () => {
      R.particles[0].die = CLOCK;

      assert.deepEqual(R.AllocParticles(2), [1, 2]);
    });

    void test('returns fewer slots than asked for when the pool is nearly full', () => {
      for (let i = 0; i < POOL_SIZE - 2; i++) {
        R.particles[i].die = CLOCK + 1.0;
      }

      assert.deepEqual(R.AllocParticles(5), [POOL_SIZE - 2, POOL_SIZE - 1]);
    });

    void test('returns an empty list when every slot is alive', () => {
      for (const particle of R.particles) {
        particle.die = CLOCK + 1.0;
      }

      assert.deepEqual(R.AllocParticles(4), []);
    });

    void test('returns an empty list when nothing is asked for', () => {
      assert.deepEqual(R.AllocParticles(0), []);
    });
  });

  void describe('SerializeParticles', () => {
    void test('leaves out particles that have expired', () => {
      R.particles[4].die = CLOCK + 2.0;

      const serialized = R.SerializeParticles();

      assert.deepEqual(serialized.map((particle) => particle.i), [4]);
    });

    void test('stores die relative to the clock and rounds values to a tenth', () => {
      Object.assign(R.particles[2], {
        die: CLOCK + 7.26,
        color: 0x6f,
        ramp: 1.04,
        type: R.ptype.explode,
        org: new Vector(1.26, -2.74, 3.04),
        vel: new Vector(0.0, 10.0, -20.0),
      });

      assert.deepEqual(R.SerializeParticles(), [{
        i: 2,
        die: 7.3,
        color: 0x6f,
        ramp: 1.0,
        type: R.ptype.explode,
        org: [1.3, -2.7, 3.0],
        vel: [0.0, 10.0, -20.0],
      }]);
    });
  });

  void describe('DeserializeParticles', () => {
    void test('puts particles back into their slots and re-anchors die on the current clock', () => {
      const serialized = [{
        i: 5,
        die: 3.5,
        color: 0x68,
        ramp: 2.0,
        type: R.ptype.grav,
        org: [10.0, 20.0, 30.0] as [number, number, number],
        vel: [1.0, 2.0, 3.0] as [number, number, number],
      }];

      restoreClientState();
      restoreClientState = useClientStateOf({ state: { time: 200.0 } });

      R.DeserializeParticles(serialized);

      const particle = R.particles[5];

      assert.equal(particle.die, 203.5);
      assert.equal(particle.color, 0x68);
      assert.equal(particle.ramp, 2.0);
      assert.equal(particle.type, R.ptype.grav);
      assert.deepEqual([...particle.org], [10.0, 20.0, 30.0]);
      assert.deepEqual([...particle.vel], [1.0, 2.0, 3.0]);
    });

    void test('round-trips what SerializeParticles wrote', () => {
      Object.assign(R.particles[1], {
        die: CLOCK + 4.0,
        color: 0x40,
        ramp: 0.0,
        type: R.ptype.blob,
        org: new Vector(5.0, 6.0, 7.0),
        vel: new Vector(-1.0, 0.0, 1.0),
      });

      const serialized = R.SerializeParticles();

      R.ClearParticles();
      R.DeserializeParticles(serialized);

      assert.deepEqual(R.SerializeParticles(), serialized);
    });
  });
});

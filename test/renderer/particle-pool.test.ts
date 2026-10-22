import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Particles, { ParticleType } from '../../source/engine/client/renderer/effects/Particles.ts';
import Vector from '../../source/shared/Vector.ts';
import { useClientStateOf } from '../support/clientState.ts';

const POOL_SIZE = 8;
const CLOCK = 100.0;

void describe('particle pool', () => {
  const previousParticles = Particles.particles;
  const previousCount = Particles.numparticles;
  let restoreClientState: () => void = () => {};

  beforeEach(() => {
    Particles.numparticles = POOL_SIZE;
    Particles.Clear();
    restoreClientState = useClientStateOf({ state: { time: CLOCK } });
  });

  afterEach(() => {
    restoreClientState();
    Particles.particles = previousParticles;
    Particles.numparticles = previousCount;
  });

  void describe('ClearParticles', () => {
    void test('fills the pool with dead particles', () => {
      assert.equal(Particles.particles.length, POOL_SIZE);

      for (const particle of Particles.particles) {
        assert.ok(particle.die < CLOCK);
      }
    });
  });

  void describe('AllocParticles', () => {
    void test('hands out the lowest free slots first', () => {
      assert.deepEqual(Particles.AllocParticles(3), [0, 1, 2]);
    });

    void test('skips slots that are still alive', () => {
      Particles.particles[1].die = CLOCK + 50.0;

      assert.deepEqual(Particles.AllocParticles(3), [0, 2, 3]);
    });

    void test('treats a particle as alive until the clock has passed its die time', () => {
      Particles.particles[0].die = CLOCK;

      assert.deepEqual(Particles.AllocParticles(2), [1, 2]);
    });

    void test('returns fewer slots than asked for when the pool is nearly full', () => {
      for (let i = 0; i < POOL_SIZE - 2; i++) {
        Particles.particles[i].die = CLOCK + 1.0;
      }

      assert.deepEqual(Particles.AllocParticles(5), [POOL_SIZE - 2, POOL_SIZE - 1]);
    });

    void test('returns an empty list when every slot is alive', () => {
      for (const particle of Particles.particles) {
        particle.die = CLOCK + 1.0;
      }

      assert.deepEqual(Particles.AllocParticles(4), []);
    });

    void test('returns an empty list when nothing is asked for', () => {
      assert.deepEqual(Particles.AllocParticles(0), []);
    });
  });

  void describe('SerializeParticles', () => {
    void test('leaves out particles that have expired', () => {
      Particles.particles[4].die = CLOCK + 2.0;

      const serialized = Particles.SerializeParticles();

      assert.deepEqual(serialized.map((particle) => particle.i), [4]);
    });

    void test('stores die relative to the clock and rounds values to a tenth', () => {
      Object.assign(Particles.particles[2], {
        die: CLOCK + 7.26,
        color: 0x6f,
        ramp: 1.04,
        type: ParticleType.explode,
        org: new Vector(1.26, -2.74, 3.04),
        vel: new Vector(0.0, 10.0, -20.0),
      });

      assert.deepEqual(Particles.SerializeParticles(), [{
        i: 2,
        die: 7.3,
        color: 0x6f,
        ramp: 1.0,
        type: ParticleType.explode,
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
        type: ParticleType.grav,
        org: [10.0, 20.0, 30.0] as [number, number, number],
        vel: [1.0, 2.0, 3.0] as [number, number, number],
      }];

      restoreClientState();
      restoreClientState = useClientStateOf({ state: { time: 200.0 } });

      Particles.DeserializeParticles(serialized);

      const particle = Particles.particles[5];

      assert.equal(particle.die, 203.5);
      assert.equal(particle.color, 0x68);
      assert.equal(particle.ramp, 2.0);
      assert.equal(particle.type, ParticleType.grav);
      assert.deepEqual([...particle.org], [10.0, 20.0, 30.0]);
      assert.deepEqual([...particle.vel], [1.0, 2.0, 3.0]);
    });

    void test('round-trips what SerializeParticles wrote', () => {
      Object.assign(Particles.particles[1], {
        die: CLOCK + 4.0,
        color: 0x40,
        ramp: 0.0,
        type: ParticleType.blob,
        org: new Vector(5.0, 6.0, 7.0),
        vel: new Vector(-1.0, 0.0, 1.0),
      });

      const serialized = Particles.SerializeParticles();

      Particles.Clear();
      Particles.DeserializeParticles(serialized);

      assert.deepEqual(Particles.SerializeParticles(), serialized);
    });
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import NavigationDebug from '../../source/engine/client/NavigationDebug.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import '../support/consoleBridge.ts';
import { patchMembers, useClientStateOf } from '../support/clientState.ts';
import Particles, { ParticleType } from '../../source/engine/client/renderer/effects/Particles.ts';
import { engineMocks } from '../support/engineMocks.ts';

/**
 * Runs a callback with a particle pool that hands out a fixed number of particles.
 * @param {{ free: number }} pool how many particles are still available
 * @param {(context: { particles: object[], warnings: string[] }) => void} callback test callback
 */
function withParticles({ free }, callback) {
  const previous = { CL: engineMocks.CL, Con: engineMocks.Con };
  const particles = [];
  const warnings = [];

  engineMocks.CL = { state: { time: 10 } };

  const restoreClientState = useClientStateOf(engineMocks.CL);
  engineMocks.Con = { PrintWarning: (text) => { warnings.push(text); } };
  const restoreParticles = patchMembers(Particles, {
    particles,
    AllocParticles() {
      if (particles.length >= free) {
        return [];
      }

      particles.push({});
      return [particles.length - 1];
    },
  });

  try {
    callback({ particles, warnings });
  } finally {
    Object.assign(engineMocks, previous);
    restoreParticles();
    restoreClientState();
  }
}

void describe('NavigationDebug', () => {
  NavigationDebug.Init();

  void test('turns a temporary dot into a particle that dies after its ttl', () => {
    withParticles({ free: 1 }, ({ particles }) => {
      eventBus.publish('nav.debug.emit-dot.temporarily', [1, 2, 3], 144, 5);

      assert.equal(particles.length, 1);
      assert.deepEqual([...particles[0].org], [1, 2, 3]);
      assert.equal(particles[0].color, 144);
      assert.equal(particles[0].die, 15);
      assert.equal(particles[0].type, ParticleType.tracer);
    });
  });

  void test('turns a permanent dot into a particle that never dies', () => {
    withParticles({ free: 1 }, ({ particles }) => {
      eventBus.publish('nav.debug.emit-dot.permanently', new Vector(4, 5, 6), 251);

      assert.equal(particles[0].die, Infinity);
      assert.deepEqual([...particles[0].org], [4, 5, 6]);
    });
  });

  void test('warns instead of failing when the renderer has no particle left', () => {
    withParticles({ free: 0 }, ({ particles, warnings }) => {
      eventBus.publish('nav.debug.emit-dot.permanently', [0, 0, 0], 15);

      assert.equal(particles.length, 0);
      assert.equal(warnings.length, 1);
    });
  });
});

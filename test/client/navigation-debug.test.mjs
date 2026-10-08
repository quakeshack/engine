import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import NavigationDebug from '../../source/engine/client/NavigationDebug.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import '../support/consoleBridge.ts';
import { useClientStateOf } from '../support/clientState.ts';
import { useRendererOf } from '../support/renderer.ts';
import { engineMocks } from '../support/engineMocks.ts';

/**
 * Runs a callback with a renderer that hands out particles from a fixed pool.
 * @param {{ free: number }} pool how many particles are still available
 * @param {(context: { particles: object[], warnings: string[] }) => void} callback test callback
 */
function withRenderer({ free }, callback) {
  const previous = { CL: engineMocks.CL, Con: engineMocks.Con, R: engineMocks.R };
  const particles = [];
  const warnings = [];

  engineMocks.CL = { state: { time: 10 } };

  const restoreClientState = useClientStateOf(engineMocks.CL);
  engineMocks.Con = { PrintWarning: (text) => { warnings.push(text); } };
  engineMocks.R = {
    ptype: { tracer: 7 },
    particles,
    AllocParticles() {
      if (particles.length >= free) {
        return [];
      }

      particles.push({});
      return [particles.length - 1];
    },
  };
  const restoreRenderer = useRendererOf(engineMocks.R);

  try {
    callback({ particles, warnings });
  } finally {
    Object.assign(engineMocks, previous);
  }
}

void describe('NavigationDebug', () => {
  NavigationDebug.Init();

  void test('turns a temporary dot into a particle that dies after its ttl', () => {
    withRenderer({ free: 1 }, ({ particles }) => {
      eventBus.publish('nav.debug.emit-dot.temporarily', [1, 2, 3], 144, 5);

      assert.equal(particles.length, 1);
      assert.deepEqual([...particles[0].org], [1, 2, 3]);
      assert.equal(particles[0].color, 144);
      assert.equal(particles[0].die, 15);
      assert.equal(particles[0].type, 7);
    });
  });

  void test('turns a permanent dot into a particle that never dies', () => {
    withRenderer({ free: 1 }, ({ particles }) => {
      eventBus.publish('nav.debug.emit-dot.permanently', new Vector(4, 5, 6), 251);

      assert.equal(particles[0].die, Infinity);
      assert.deepEqual([...particles[0].org], [4, 5, 6]);
    });
  });

  void test('warns instead of failing when the renderer has no particle left', () => {
    withRenderer({ free: 0 }, ({ particles, warnings }) => {
      eventBus.publish('nav.debug.emit-dot.permanently', [0, 0, 0], 15);

      assert.equal(particles.length, 0);
      assert.equal(warnings.length, 1);
    });
  });
});

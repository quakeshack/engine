import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DefaultClientEdictHandler } from '../../source/engine/client/ClientLegacy.ts';
import ClientEntities, { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { effect, modelFlags } from '../../source/shared/Defs.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';

/**
 * Runs a callback with a real `ClientEntities` instance wired into the
 * registry, plus mocked `Host.frametime` so `ClientDlight.think()` behaves
 * deterministically.
 * @param {() => void} callback
 */
function withMockLegacyClientRegistry(callback) {
  const previousCL = registry.CL;
  const previousHost = registry.Host;
  const previousR = registry.R;

  const clientEntities = new ClientEntities();

  registry.CL = { state: { time: 0.0, clientEntities } };
  registry.Host = { frametime: 1 / 60 };
  registry.R = { RocketTrail() {}, EntityParticles() {} };
  eventBus.publish('registry.frozen');

  const restore = () => {
    registry.CL = previousCL;
    registry.Host = previousHost;
    registry.R = previousR;
    eventBus.publish('registry.frozen');
  };

  try {
    callback(clientEntities);
  } finally {
    restore();
  }
}

void describe('DefaultClientEdictHandler.emit dynamic lights', () => {
  // Regression test: EF_DIMLIGHT/EF_BRIGHTLIGHT/MF_ROCKET dlights are
  // re-triggered every render frame while their effect is active, renewing
  // `die` a tiny instant into the future (this used to be 0.001s-0.01s).
  // The moment the effect stops being refreshed (entity freed, effect flag
  // cleared), any frame gap larger than that tiny offset immediately made
  // `ClientDlight.isFree()` true, which hard-culls the light from rendering
  // and skips `think()` entirely -- so it vanished in a single frame instead
  // of fading out. `die` must be renewed far enough ahead to survive at
  // least one missed frame so the light can fade out smoothly.
  /**
   * Keeps stepping frames (without refreshing the light) until it goes free,
   * recording the radius observed at the end of each step.
   * @param {import('../../source/engine/client/ClientEntities.ts').default} clientEntities
   * @param {import('../../source/engine/client/ClientEntities.ts').ClientDlight} dl
   * @returns {number[]} Radius samples, one per elapsed frame, ending at 0.
   */
  function sampleRadiusUntilFree(clientEntities, dl) {
    const samples = [];
    for (let i = 0; i < 60 && !dl.isFree(); i++) {
      registry.CL.state.time += registry.Host.frametime;
      clientEntities.think();
      samples.push(dl.radius);
    }
    return samples;
  }

  void test('EF_DIMLIGHT dlight survives a missed frame and fades across several frames instead of vanishing', () => {
    withMockLegacyClientRegistry((clientEntities) => {
      const clent = new ClientEdict(1);
      clent.effects |= effect.EF_DIMLIGHT;
      clent.origin.setTo(0.0, 0.0, 0.0);

      const handler = new DefaultClientEdictHandler(clent, {});

      // Simulate the effect being refreshed for a few consecutive frames.
      for (let i = 0; i < 3; i++) {
        handler.emit();
        registry.CL.state.time += registry.Host.frametime;
        clientEntities.think();
      }

      const dl = clientEntities.dlights.find((light) => light.entity === clent.num);
      assert.ok(dl, 'expected a dlight to be allocated for the entity');
      assert.ok(dl.radius > 0.0, 'dlight should still be lit while refreshed');

      // The effect stops being refreshed (e.g. the monster faces away), but
      // normal frames still elapse and think() still runs.
      registry.CL.state.time += registry.Host.frametime;
      clientEntities.think();

      assert.ok(!dl.isFree(), 'dlight must not be culled on the very first missed frame');

      const samples = sampleRadiusUntilFree(clientEntities, dl);
      const distinctPositiveSamples = new Set(samples.filter((radius) => radius > 0.0));

      assert.equal(dl.radius, 0.0, 'dlight should eventually fade fully to zero');
      assert.ok(distinctPositiveSamples.size > 1, `expected a gradual multi-frame fade, got samples ${samples.join(', ')}`);
    });
  });

  void test('MF_ROCKET dlight survives a missed frame and fades across several frames instead of vanishing', () => {
    withMockLegacyClientRegistry((clientEntities) => {
      const clent = new ClientEdict(2);
      clent.model = { flags: modelFlags.MF_ROCKET };
      clent.origin.setTo(0.0, 0.0, 0.0);
      clent.originPrevious.setTo(0.0, 0.0, 0.0);

      const handler = new DefaultClientEdictHandler(clent, {});

      for (let i = 0; i < 3; i++) {
        handler.emit();
        registry.CL.state.time += registry.Host.frametime;
        clientEntities.think();
      }

      const dl = clientEntities.dlights.find((light) => light.entity === clent.num);
      assert.ok(dl, 'expected a dlight to be allocated for the rocket entity');

      registry.CL.state.time += registry.Host.frametime;
      clientEntities.think();

      assert.ok(!dl.isFree(), 'rocket dlight must not be culled on the very first missed frame');

      const samples = sampleRadiusUntilFree(clientEntities, dl);
      const distinctPositiveSamples = new Set(samples.filter((radius) => radius > 0.0));

      assert.equal(dl.radius, 0.0, 'rocket dlight should eventually fade fully to zero');
      assert.ok(distinctPositiveSamples.size > 1, `expected a gradual multi-frame fade, got samples ${samples.join(', ')}`);
    });
  });
});

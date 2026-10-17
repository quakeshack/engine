import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DefaultClientEdictHandler } from '../../source/engine/client/ClientLegacy.ts';
import ClientEntities, { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import { effect, modelFlags } from '../../source/shared/Defs.ts';
import { patchMembers } from '../support/clientState.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import Particles from '../../source/engine/client/renderer/effects/Particles.ts';
import { engineMocks } from '../support/engineMocks.ts';
import type { ClientEngineAPI } from '../../source/engine/client/ClientEngineAPI.ts';
import type { BaseModel } from '../../source/engine/common/model/BaseModel.ts';
import type { ClientDlight } from '../../source/engine/client/ClientEntities.ts';
import { withEngineMocks } from '../support/withEngineMocks.ts';

/**
 * Runs a callback with a real `ClientEntities` instance wired into the
 * registry, plus mocked `Host.frametime` so `ClientDlight.think()` behaves
 * deterministically.
 * @param callback
 */
function withMockLegacyClientRegistry(callback: (clientEntities: ClientEntities) => void): void {
  const clientEntities = new ClientEntities();
  const restoreParticles = patchMembers(Particles, { RocketTrail() {}, EntityParticles() {} });

  try {
    withEngineMocks({ CL: { state: { time: 0.0, clientEntities } }, Host: { frametime: 1 / 60 } }, () => { callback(clientEntities); });
  } finally {
    restoreParticles();
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
   * @param clientEntities
   * @param dl
   * @returns Radius samples, one per elapsed frame, ending at 0.
   */
  function sampleRadiusUntilFree(clientEntities: ClientEntities, dl: ClientDlight): number[] {
    const samples = [];
    for (let i = 0; i < 60 && !dl.isFree(); i++) {
      clientRuntimeState.time += (engineMocks.Host as { frametime: number }).frametime;
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

      const handler = new DefaultClientEdictHandler(clent, {} as ClientEngineAPI);

      // Simulate the effect being refreshed for a few consecutive frames.
      for (let i = 0; i < 3; i++) {
        handler.emit();
        clientRuntimeState.time += (engineMocks.Host as { frametime: number }).frametime;
        clientEntities.think();
      }

      const dl = clientEntities.dlights.find((light) => light.entity === clent.num);
      assert.ok(dl, 'expected a dlight to be allocated for the entity');
      assert.ok(dl.radius > 0.0, 'dlight should still be lit while refreshed');

      // The effect stops being refreshed (e.g. the monster faces away), but
      // normal frames still elapse and think() still runs.
      clientRuntimeState.time += (engineMocks.Host as { frametime: number }).frametime;
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
      // The handler only reads the flags of the model.
      clent.model = { flags: modelFlags.MF_ROCKET } as BaseModel;
      clent.origin.setTo(0.0, 0.0, 0.0);
      clent.originPrevious.setTo(0.0, 0.0, 0.0);

      const handler = new DefaultClientEdictHandler(clent, {} as ClientEngineAPI);

      for (let i = 0; i < 3; i++) {
        handler.emit();
        clientRuntimeState.time += (engineMocks.Host as { frametime: number }).frametime;
        clientEntities.think();
      }

      const dl = clientEntities.dlights.find((light) => light.entity === clent.num);
      assert.ok(dl, 'expected a dlight to be allocated for the rocket entity');

      clientRuntimeState.time += (engineMocks.Host as { frametime: number }).frametime;
      clientEntities.think();

      assert.ok(!dl.isFree(), 'rocket dlight must not be culled on the very first missed frame');

      const samples = sampleRadiusUntilFree(clientEntities, dl);
      const distinctPositiveSamples = new Set(samples.filter((radius) => radius > 0.0));

      assert.equal(dl.radius, 0.0, 'rocket dlight should eventually fade fully to zero');
      assert.ok(distinctPositiveSamples.size > 1, `expected a gradual multi-frame fade, got samples ${samples.join(', ')}`);
    });
  });
});

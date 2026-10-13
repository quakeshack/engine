import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { GLRenderTexture } from '../../source/engine/client/GL.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import { createFakeRenderTarget } from '../support/renderTargets.ts';

void describe('PostProcess depth sampling', () => {
  const previousScene = PostProcess.scene;
  const previousNull = PostProcess.nullTexture;
  let log: string[] = [];

  beforeEach(() => {
    log = [];

    const texture = (name: string) => ({
      bind: (unit: number) => { log.push(`bind ${name} to unit ${unit}`); },
    }) as unknown as GLRenderTexture;

    // the scene target's depth texture is what the sampling passes bind, and what endDepthSampling attaches again
    PostProcess.scene = Object.assign(createFakeRenderTarget('scene', log), { depthTexture: texture('depth') });
    PostProcess.nullTexture = texture('null');
  });

  afterEach(() => {
    PostProcess.scene = previousScene;
    PostProcess.nullTexture = previousNull;
  });

  void test('endDepthSampling takes the depth texture off the unit before attaching it again', () => {
    PostProcess.bindDepthForSampling(7);
    PostProcess.endDepthSampling();

    assert.deepEqual(log, [
      'bind depth to unit 7',
      'bind null to unit 7',
      'restore depth texture of scene',
    ]);
  });

  void test('releases every unit the depth texture was bound to', () => {
    PostProcess.bindDepthForSampling(7);
    PostProcess.bindDepthForSampling(3);
    log.length = 0;

    PostProcess.endDepthSampling();

    assert.deepEqual(log.slice(0, 2), ['bind null to unit 7', 'bind null to unit 3']);
  });

  void test('forgets the units after a pass, the next one starts clean', () => {
    PostProcess.bindDepthForSampling(7);
    PostProcess.endDepthSampling();
    log.length = 0;

    PostProcess.endDepthSampling();

    assert.deepEqual(log, ['restore depth texture of scene']);
  });
});

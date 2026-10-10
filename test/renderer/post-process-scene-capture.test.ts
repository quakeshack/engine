import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import type PostProcessEffect from '../../source/engine/client/renderer/postprocess/PostProcessEffect.ts';

void describe('PostProcess scene capture', () => {
  const previousEffects = PostProcess.effects;
  const previousStack = PostProcess.stack;

  afterEach(() => {
    PostProcess.requestSceneCapture(false);
    PostProcess.effects = previousEffects;
    PostProcess.stack = previousStack;
  });

  void test('is not needed when nothing asked for it and no effect is active', () => {
    PostProcess.effects = [{ active: false } as PostProcessEffect];
    PostProcess.stack = [];

    assert.equal(PostProcess.needsSceneCapture(), false);
  });

  void test('is needed when the frame preparation asked for it', () => {
    PostProcess.effects = [];
    PostProcess.stack = [];

    PostProcess.requestSceneCapture(true);

    assert.equal(PostProcess.needsSceneCapture(), true);
  });

  void test('keeps the request until it is withdrawn', () => {
    PostProcess.effects = [];
    PostProcess.stack = [];

    PostProcess.requestSceneCapture(true);
    assert.equal(PostProcess.needsSceneCapture(), true);
    assert.equal(PostProcess.needsSceneCapture(), true);

    PostProcess.requestSceneCapture(false);
    assert.equal(PostProcess.needsSceneCapture(), false);
  });

  void test('is needed while a screen-space effect is active, with no request', () => {
    PostProcess.effects = [{ active: true } as PostProcessEffect];
    PostProcess.stack = [];

    assert.equal(PostProcess.needsSceneCapture(), true);
  });
});

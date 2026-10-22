import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import type PostProcessEffect from '../../source/engine/client/renderer/postprocess/PostProcessEffect.ts';

void describe('PostProcess scene capture', () => {
  const previousEffects = PostProcess.effects;

  afterEach(() => {
    PostProcess.requestSceneCapture(false);
    PostProcess.effects = previousEffects;
    PostProcess.entries.reset();
  });

  void test('is not needed when nothing asked for it and no effect is active', () => {
    PostProcess.effects = [{ active: false } as PostProcessEffect];

    assert.equal(PostProcess.needsSceneCapture(), false);
  });

  void test('is needed when the frame preparation asked for it', () => {
    PostProcess.effects = [];

    PostProcess.requestSceneCapture(true);

    assert.equal(PostProcess.needsSceneCapture(), true);
  });

  void test('keeps the request until it is withdrawn', () => {
    PostProcess.effects = [];

    PostProcess.requestSceneCapture(true);
    assert.equal(PostProcess.needsSceneCapture(), true);
    assert.equal(PostProcess.needsSceneCapture(), true);

    PostProcess.requestSceneCapture(false);
    assert.equal(PostProcess.needsSceneCapture(), false);
  });

  void test('is needed while a screen-space effect is active, with no request', () => {
    PostProcess.effects = [{ active: true } as PostProcessEffect];

    assert.equal(PostProcess.needsSceneCapture(), true);
  });

  void test('is needed while the game has a stack or a pulse running, and not after', () => {
    PostProcess.effects = [];

    PostProcess.setStack([{ id: 'blur', settings: { radius: 2 } }]);
    assert.equal(PostProcess.needsSceneCapture(), true);

    PostProcess.clearStack();
    assert.equal(PostProcess.needsSceneCapture(), false);

    PostProcess.pulse({ id: 'blur', settings: { radius: 2 }, timing: { hold: 0.1 } });
    assert.equal(PostProcess.needsSceneCapture(), true);
  });
});

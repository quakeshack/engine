import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import RenderTarget from '../../source/engine/client/renderer/frame/RenderTarget.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { createRecordingContext, type RecordingContext } from '../support/recordingContext.ts';

void describe('PostProcess.copySceneColor', () => {
  const previousContext = GL.gl;
  let recording: RecordingContext = null!;

  beforeEach(() => {
    recording = createRecordingContext();
    GL.gl = recording.gl;
    publishGlReady(recording.gl);
    PostProcess.init();
  });

  afterEach(() => {
    PostProcess.msaa!.free();
    PostProcess.shutdown();
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  /**
   * Starts the scene the way the frame does.
   * @param samples The value of `gl_msaa`.
   */
  function beginScene(samples: number): void {
    PostProcess.msaa!.set(String(samples));
    PostProcess.resize(640, 480);
    PostProcess.begin();
    recording.log.length = 0;
  }

  void test('blits the color into the texture of the copy and goes on drawing into the scene', () => {
    beginScene(0);

    const copy = PostProcess.copySceneColor();

    assert.equal(copy, PostProcess.colorCopy);
    assert.deepEqual(recording.calls('blitFramebuffer'), ['blitFramebuffer(0, 0, 640, 480, 0, 0, 640, 480, COLOR_BUFFER_BIT, NEAREST)']);
    assert.equal(RenderTarget.bound, PostProcess.scene);
  });

  // resolveMSAA() leaves the multisampled target reading attachment 1, so the next frame copied the emissive (the
  // glow for bloom) as the color behind every refracting surface unless the copy selects the color itself
  void test('reads the color attachment even when the source was left reading the emissive', () => {
    beginScene(4);
    PostProcess.msaaTarget!.bindForRead();
    recording.gl.readBuffer(recording.gl.COLOR_ATTACHMENT1);
    PostProcess.msaaTarget!.bind();
    recording.log.length = 0;

    PostProcess.copySceneColor();

    const log = recording.log.filter((call) => call.startsWith('readBuffer') || call.startsWith('blitFramebuffer'));
    assert.deepEqual(log.slice(-2), ['readBuffer(COLOR_ATTACHMENT0)', 'blitFramebuffer(0, 0, 640, 480, 0, 0, 640, 480, COLOR_BUFFER_BIT, NEAREST)']);
  });

  void test('reads the multisampled target when the frame is multisampled, and stays in it', () => {
    beginScene(4);

    PostProcess.copySceneColor();

    assert.equal(recording.calls('blitFramebuffer').length, 1);
    assert.equal(RenderTarget.bound, PostProcess.msaaTarget);
  });

  void test('is never a texture of the scene, which the framebuffer draws into', () => {
    beginScene(0);

    const copy = PostProcess.copySceneColor();

    assert(!PostProcess.scene!.isAttached(copy.colorTexture(0)));
  });
});

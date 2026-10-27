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

  void test('blits color and emissive into the two textures of the copy and goes on drawing into the scene', () => {
    beginScene(0);

    const copy = PostProcess.copySceneColor();

    assert.equal(copy, PostProcess.colorCopy);
    assert.deepEqual(recording.calls('readBuffer'), ['readBuffer(COLOR_ATTACHMENT0)', 'readBuffer(COLOR_ATTACHMENT1)', 'readBuffer(COLOR_ATTACHMENT0)']);
    assert.deepEqual(recording.calls('blitFramebuffer'), [
      'blitFramebuffer(0, 0, 640, 480, 0, 0, 640, 480, COLOR_BUFFER_BIT, NEAREST)',
      'blitFramebuffer(0, 0, 640, 480, 0, 0, 640, 480, COLOR_BUFFER_BIT, NEAREST)',
    ]);
    assert.equal(RenderTarget.bound, PostProcess.scene);
  });

  void test('leaves both textures of the copy attached where they belong, for the next copy', () => {
    beginScene(0);

    const copy = PostProcess.copySceneColor();

    assert(copy.isAttached(copy.colorTexture(0)));
    assert(copy.isAttached(copy.colorTexture(1)));
    assert.deepEqual(recording.calls('drawBuffers').at(-1), 'drawBuffers([COLOR_ATTACHMENT0, COLOR_ATTACHMENT1])');
  });

  void test('reads the multisampled target when the frame is multisampled, and stays in it', () => {
    beginScene(4);

    PostProcess.copySceneColor();

    assert.equal(recording.calls('blitFramebuffer').length, 2);
    assert.equal(RenderTarget.bound, PostProcess.msaaTarget);
  });

  void test('is never a texture of the scene, which the framebuffer draws into', () => {
    beginScene(0);

    const copy = PostProcess.copySceneColor();

    assert(!PostProcess.scene!.isAttached(copy.colorTexture(0)));
    assert(!PostProcess.scene!.isAttached(copy.colorTexture(1)));
  });
});

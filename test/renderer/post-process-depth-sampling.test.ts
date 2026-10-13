import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import RenderTarget from '../../source/engine/client/renderer/frame/RenderTarget.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { createRecordingContext, type RecordingContext } from '../support/recordingContext.ts';

void describe('PostProcess.copySceneDepth', () => {
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

  void test('blits the depth of the scene into the copy and goes on drawing into the scene', () => {
    beginScene(0);

    const texture = PostProcess.copySceneDepth();

    assert.equal(texture, PostProcess.depthCopy!.depthTexture);
    assert.deepEqual(recording.calls('blitFramebuffer'), [
      'blitFramebuffer(0, 0, 640, 480, 0, 0, 640, 480, DEPTH_BUFFER_BIT, NEAREST)',
    ]);
    assert.equal(RenderTarget.bound, PostProcess.scene);
  });

  void test('reads the multisampled target when the frame is multisampled, and does not resolve or leave it', () => {
    beginScene(4);

    PostProcess.copySceneDepth();

    // one depth blit: the multisampled depth is resolved into the copy, nothing of the scene is touched
    assert.deepEqual(recording.calls('blitFramebuffer'), [
      'blitFramebuffer(0, 0, 640, 480, 0, 0, 640, 480, DEPTH_BUFFER_BIT, NEAREST)',
    ]);
    assert.equal(RenderTarget.bound, PostProcess.msaaTarget);
  });

  void test('asks again every time, the depth changes between two passes', () => {
    beginScene(4);

    PostProcess.copySceneDepth();
    PostProcess.copySceneDepth();
    PostProcess.copySceneDepth();

    assert.equal(recording.calls('blitFramebuffer').length, 3);
  });

  void test('the scene is resolved once, by end(), however many copies were made', () => {
    beginScene(4);

    PostProcess.copySceneDepth();
    PostProcess.copySceneDepth();
    recording.log.length = 0;
    PostProcess.end();

    // two color attachments and the depth
    assert.deepEqual(recording.calls('blitFramebuffer').map((call) => call.includes('COLOR_BUFFER_BIT') ? 'color' : 'depth'), ['color', 'color', 'depth']);
    assert.equal(RenderTarget.bound, null);
  });

  void test('is never the depth texture of the scene, which the framebuffer draws into', () => {
    beginScene(0);

    assert.notEqual(PostProcess.copySceneDepth(), PostProcess.depthTexture);
  });
});

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { createRecordingContext, type RecordingContext } from '../support/recordingContext.ts';

void describe('PostProcess.resize', () => {
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

  void test('gives the multisampled target the sample count of gl_msaa, at most what the context supports', () => {
    PostProcess.msaa!.set('8');

    PostProcess.resize(640, 480);

    // the recording context supports 4 samples
    assert.equal(PostProcess.msaaSamples, 4);
    assert.equal(PostProcess.msaaTarget!.samples, 4);
    assert.equal(PostProcess.msaaTarget!.width, 640);
  });

  void test('takes up a change of gl_msaa without a change of size', () => {
    PostProcess.resize(640, 480);
    assert.equal(PostProcess.msaaSamples, 4);

    PostProcess.msaa!.set('0');
    PostProcess.resize(640, 480);

    assert.equal(PostProcess.msaaSamples, 0);

    PostProcess.msaa!.set('2');
    PostProcess.resize(640, 480);

    assert.equal(PostProcess.msaaSamples, 2);
    assert.equal(PostProcess.msaaTarget!.samples, 2);
  });

  void test('does not keep the multisampled storage while gl_msaa is 0', () => {
    PostProcess.resize(640, 480);
    recording.log.length = 0;

    PostProcess.msaa!.set('0');
    PostProcess.resize(640, 480);

    assert.deepEqual(recording.calls('renderbufferStorage'), [
      'renderbufferStorage(RENDERBUFFER, RGBA8, 0, 0)',
      'renderbufferStorage(RENDERBUFFER, RGBA8, 0, 0)',
      'renderbufferStorage(RENDERBUFFER, DEPTH_COMPONENT24, 0, 0)',
    ]);
  });

  void test('resizes the scene, the depth copy and the boundary target together', () => {
    PostProcess.resize(800, 600);

    assert.equal(PostProcess.scene!.width, 800);
    assert.equal(PostProcess.depthCopy!.height, 600);
    assert.equal(PostProcess.turbulentBoundary!.width, 800);
    assert.equal(PostProcess.width, 800);
  });
});

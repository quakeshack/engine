import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import GL, { GLRenderTexture } from '../../source/engine/client/GL.ts';
import RenderTarget from '../../source/engine/client/renderer/frame/RenderTarget.ts';
import RenderTargetPair from '../../source/engine/client/renderer/frame/RenderTargetPair.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { publishGlReady } from '../support/glEvents.ts';
import { createRecordingContext, type RecordingContext } from '../support/recordingContext.ts';

void describe('RenderTarget', () => {
  const previousContext = GL.gl;
  let recording: RecordingContext = null!;

  beforeEach(() => {
    recording = createRecordingContext();
    GL.gl = recording.gl;
    publishGlReady(recording.gl);
  });

  afterEach(() => {
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  void describe('creation', () => {
    void test('attaches the textures it owns, in order, and draws to all of them', () => {
      new RenderTarget({
        name: 'scene',
        color: [{ storage: 'texture' }, { storage: 'texture' }],
        depth: { storage: 'texture', filter: 'nearest' },
      });

      assert.deepEqual(recording.calls('framebufferTexture2D'), [
        'framebufferTexture2D(FRAMEBUFFER, COLOR_ATTACHMENT0, TEXTURE_2D, texture 1, 0)',
        'framebufferTexture2D(FRAMEBUFFER, COLOR_ATTACHMENT1, TEXTURE_2D, texture 2, 0)',
        'framebufferTexture2D(FRAMEBUFFER, DEPTH_ATTACHMENT, TEXTURE_2D, texture 3, 0)',
      ]);
      assert.deepEqual(recording.calls('drawBuffers'), ['drawBuffers([COLOR_ATTACHMENT0, COLOR_ATTACHMENT1])']);
    });

    void test('leaves the default framebuffer bound', () => {
      new RenderTarget({ name: 'ping', color: [{ storage: 'texture' }], depth: null });

      const binds = recording.calls('bindFramebuffer');

      assert.equal(binds[binds.length - 1], 'bindFramebuffer(FRAMEBUFFER, null)');
    });

    void test('textures are filtered as asked and clamped, depth defaults to nearest and color to linear', () => {
      new RenderTarget({ name: 'a', color: [{ storage: 'texture' }, { storage: 'texture', filter: 'nearest' }], depth: { storage: 'texture' } });

      assert.deepEqual(recording.calls('texParameteri').filter((call) => call.includes('MAG_FILTER')), [
        'texParameteri(TEXTURE_2D, TEXTURE_MAG_FILTER, LINEAR)',
        'texParameteri(TEXTURE_2D, TEXTURE_MAG_FILTER, NEAREST)',
        'texParameteri(TEXTURE_2D, TEXTURE_MAG_FILTER, NEAREST)',
      ]);
      assert.equal(recording.calls('texParameteri').filter((call) => call.includes('CLAMP_TO_EDGE')).length, 6);
    });

    void test('a depth-only target draws no color and reads none', () => {
      new RenderTarget({ name: 'shadow', color: [], depth: { storage: 'texture' } });

      assert.deepEqual(recording.calls('drawBuffers'), ['drawBuffers([NONE])']);
      assert.deepEqual(recording.calls('readBuffer'), ['readBuffer(NONE)']);
    });

    void test('a renderbuffer is bound once before it is attached', () => {
      new RenderTarget({ name: 'msaa', color: [{ storage: 'renderbuffer' }], depth: { storage: 'renderbuffer' } });

      assert.deepEqual(recording.calls('bindRenderbuffer').slice(0, 4), [
        'bindRenderbuffer(RENDERBUFFER, renderbuffer 1)',
        'bindRenderbuffer(RENDERBUFFER, null)',
        'bindRenderbuffer(RENDERBUFFER, renderbuffer 2)',
        'bindRenderbuffer(RENDERBUFFER, null)',
      ]);
      assert.deepEqual(recording.calls('framebufferRenderbuffer'), [
        'framebufferRenderbuffer(FRAMEBUFFER, COLOR_ATTACHMENT0, RENDERBUFFER, renderbuffer 1)',
        'framebufferRenderbuffer(FRAMEBUFFER, DEPTH_ATTACHMENT, RENDERBUFFER, renderbuffer 2)',
      ]);
    });

    void test('an external texture is attached and nothing else', () => {
      const external = new GLRenderTexture();

      new RenderTarget({ name: 'copy', color: [{ storage: 'external', texture: external }], depth: null });

      assert.deepEqual(recording.calls('framebufferTexture2D'), [
        'framebufferTexture2D(FRAMEBUFFER, COLOR_ATTACHMENT0, TEXTURE_2D, texture 1, 0)',
      ]);
      assert.equal(recording.calls('texParameteri').length, 0);
    });
  });

  void describe('resize', () => {
    void test('allocates textures at the size, color and depth with their formats', () => {
      const target = new RenderTarget({ name: 'scene', color: [{ storage: 'texture' }], depth: { storage: 'texture' } });

      target.resize(640, 480);

      assert.deepEqual(recording.calls('texImage2D'), [
        'texImage2D(TEXTURE_2D, 0, RGBA, 640, 480, 0, RGBA, UNSIGNED_BYTE, null)',
        'texImage2D(TEXTURE_2D, 0, DEPTH_COMPONENT24, 640, 480, 0, DEPTH_COMPONENT, UNSIGNED_INT, null)',
      ]);
      assert.equal(target.width, 640);
      assert.equal(target.height, 480);
    });

    void test('does nothing when neither size nor samples changed', () => {
      const target = new RenderTarget({ name: 'scene', color: [{ storage: 'texture' }], depth: null });

      target.resize(640, 480);
      const callsAfterFirst = recording.log.length;
      target.resize(640, 480);

      assert.equal(recording.log.length, callsAfterFirst);
    });

    void test('multisamples renderbuffers when asked, and a change of the sample count alone reallocates', () => {
      const target = new RenderTarget({ name: 'msaa', color: [{ storage: 'renderbuffer' }], depth: { storage: 'renderbuffer' } });

      target.resize(640, 480, 4);
      target.resize(640, 480, 2);

      assert.deepEqual(recording.calls('renderbufferStorageMultisample'), [
        'renderbufferStorageMultisample(RENDERBUFFER, 4, RGBA8, 640, 480)',
        'renderbufferStorageMultisample(RENDERBUFFER, 4, DEPTH_COMPONENT24, 640, 480)',
        'renderbufferStorageMultisample(RENDERBUFFER, 2, RGBA8, 640, 480)',
        'renderbufferStorageMultisample(RENDERBUFFER, 2, DEPTH_COMPONENT24, 640, 480)',
      ]);
      assert.equal(target.samples, 2);
    });

    void test('a size of zero releases the storage', () => {
      const target = new RenderTarget({ name: 'msaa', color: [{ storage: 'renderbuffer' }], depth: null });

      target.resize(640, 480, 4);
      target.resize(0, 0, 0);

      assert.deepEqual(recording.calls('renderbufferStorage'), ['renderbufferStorage(RENDERBUFFER, RGBA8, 0, 0)']);
    });

    void test('leaves an external texture alone', () => {
      const external = new GLRenderTexture();
      const target = new RenderTarget({ name: 'copy', color: [{ storage: 'external', texture: external }], depth: { storage: 'renderbuffer' } });

      target.resize(320, 200);

      assert.equal(recording.calls('texImage2D').length, 0);
      assert.deepEqual(recording.calls('renderbufferStorage'), ['renderbufferStorage(RENDERBUFFER, DEPTH_COMPONENT24, 320, 200)']);
    });
  });

  void describe('isAttached', () => {
    void test('is true for the textures the framebuffer draws into and false for any other', () => {
      const external = new GLRenderTexture();
      const target = new RenderTarget({
        name: 'scene',
        color: [{ storage: 'texture' }, { storage: 'external', texture: external }],
        depth: { storage: 'texture' },
      });
      const other = new RenderTarget({ name: 'ping', color: [{ storage: 'texture' }], depth: null });

      assert.equal(target.isAttached(target.colorTexture(0)), true);
      assert.equal(target.isAttached(external), true);
      assert.equal(target.isAttached(target.depthTexture!), true);
      assert.equal(target.isAttached(other.colorTexture(0)), false);
    });

    void test('names the textures after their target, and an external one after its first owner', () => {
      const target = new RenderTarget({ name: 'scene', color: [{ storage: 'texture' }], depth: { storage: 'texture' } });
      const copy = new RenderTarget({ name: 'copy', color: [{ storage: 'external', texture: target.colorTexture(0) }], depth: null });

      assert.equal(RenderTarget.describeTexture(target.colorTexture(0)), 'scene.color0');
      assert.equal(RenderTarget.describeTexture(target.depthTexture!), 'scene.depth');
      assert.equal(RenderTarget.ownerOf(copy.colorTexture(0)), target);
    });
  });

  void describe('bound', () => {
    void test('follows the binds of the class and the screen after unbind', () => {
      const target = new RenderTarget({ name: 'scene', color: [{ storage: 'texture' }], depth: null });

      assert.equal(RenderTarget.bound, null);

      target.bind();
      assert.equal(RenderTarget.bound, target);

      RenderTarget.unbind();
      assert.equal(RenderTarget.bound, null);

      target.bindForRead();
      assert.equal(RenderTarget.bound, null);

      target.bindForDraw();
      assert.equal(RenderTarget.bound, target);

      RenderTarget.bindOutput(null);
      assert.equal(RenderTarget.bound, null);
    });
  });

  void describe('cube faces', () => {
    void test('attaches the face of a cube texture as the depth attachment', () => {
      const target = new RenderTarget({ name: 'shadow-point', color: [], depth: null });
      const cube = { label: 'cube' } as unknown as WebGLTexture;

      recording.log.length = 0;
      target.attachDepthCubeFace(cube, 3);

      // TEXTURE_CUBE_MAP_POSITIVE_X is 34069, face 3 is NEGATIVE_Y
      assert.deepEqual(recording.log, ['framebufferTexture2D(FRAMEBUFFER, DEPTH_ATTACHMENT, 34072, cube, 0)']);
    });
  });

  void describe('free', () => {
    void test('deletes the framebuffer and what it owns, and not an external texture', () => {
      const external = new GLRenderTexture();
      const target = new RenderTarget({
        name: 'mixed',
        color: [{ storage: 'external', texture: external }, { storage: 'texture' }],
        depth: { storage: 'renderbuffer' },
      });

      target.free();

      assert.deepEqual(recording.calls('deleteFramebuffer'), ['deleteFramebuffer(framebuffer 1)']);
      assert.deepEqual(recording.calls('deleteTexture'), ['deleteTexture(texture 2)']);
      assert.deepEqual(recording.calls('deleteRenderbuffer'), ['deleteRenderbuffer(renderbuffer 1)']);
    });
  });

  void describe('limits', () => {
    void test('are read from the context once, and again after the context came back', () => {
      const first = RenderTarget.limits;
      const second = RenderTarget.limits;

      assert.deepEqual(first, { maxColorAttachments: 8, maxDrawBuffers: 8, maxSamples: 4 });
      assert.equal(first, second);
      assert.equal(recording.calls('getParameter').length, 3);

      eventBus.publish('gl.shutdown');
      GL.gl = recording.gl;
      publishGlReady(recording.gl);

      assert.notEqual(RenderTarget.limits, first);
    });
  });
});

void describe('RenderTargetPair', () => {
  const previousContext = GL.gl;

  beforeEach(() => {
    const { gl } = createRecordingContext();

    GL.gl = gl;
    publishGlReady(gl);
  });

  afterEach(() => {
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  void test('what was written is what is read after a swap, and reset starts the history over', () => {
    const pair = new RenderTargetPair({ name: 'adaptation', color: [{ storage: 'texture' }], depth: null });
    const first = pair.read;
    const second = pair.write;

    assert.notEqual(first, second);
    assert.equal(first.name, 'adaptation-0');
    assert.equal(second.name, 'adaptation-1');

    pair.swap();

    assert.equal(pair.read, second);
    assert.equal(pair.write, first);

    pair.reset();

    assert.equal(pair.read, first);
  });

  void test('resizes both', () => {
    const pair = new RenderTargetPair({ name: 'history', color: [{ storage: 'texture' }], depth: null });

    pair.resize(64, 32);

    assert.equal(pair.read.width, 64);
    assert.equal(pair.write.height, 32);
  });
});

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import type { GLRenderTexture } from '../../source/engine/client/GL.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';

void describe('PostProcess depth sampling', () => {
  const previousContext = GL.gl;
  const previousDepth = PostProcess.depthTexture;
  const previousNull = PostProcess.nullTexture;
  const previousRenderbuffer = PostProcess.depthRenderbuffer;
  let log: string[] = [];

  beforeEach(() => {
    log = [];

    const texture = (name: string) => ({
      bind: (unit: number) => { log.push(`bind ${name} to unit ${unit}`); },
      attachToFramebuffer: () => { log.push(`attach ${name} to the framebuffer`); },
    }) as unknown as GLRenderTexture;

    PostProcess.depthTexture = texture('depth');
    PostProcess.nullTexture = texture('null');
    PostProcess.depthRenderbuffer = {} as WebGLRenderbuffer;

    GL.gl = {
      FRAMEBUFFER: 1,
      DEPTH_ATTACHMENT: 2,
      RENDERBUFFER: 3,
      framebufferRenderbuffer: () => { log.push('detach the depth renderbuffer'); },
    } as unknown as WebGL2RenderingContext;
    eventBus.publish('gl.ready');
  });

  afterEach(() => {
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
    PostProcess.depthTexture = previousDepth;
    PostProcess.nullTexture = previousNull;
    PostProcess.depthRenderbuffer = previousRenderbuffer;
  });

  void test('endDepthSampling takes the depth texture off the unit before attaching it again', () => {
    PostProcess.bindDepthForSampling(7);
    PostProcess.endDepthSampling();

    assert.deepEqual(log, [
      'bind depth to unit 7',
      'bind null to unit 7',
      'detach the depth renderbuffer',
      'attach depth to the framebuffer',
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

    assert.deepEqual(log, ['detach the depth renderbuffer', 'attach depth to the framebuffer']);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import PostProcess from '../../source/engine/client/renderer/PostProcess.ts';
import { eventBus } from '../../source/engine/registry.ts';

void describe('PostProcess._resolveMSAAColorAttachment', () => {
  void test('resolves secondary attachments through draw attachment 0', () => {
    const operations = [];
    const mockGl = {
      COLOR_ATTACHMENT0: 0x8CE0,
      COLOR_ATTACHMENT1: 0x8CE1,
      DRAW_FRAMEBUFFER: 0x8CA9,
      TEXTURE_2D: 0x0DE1,
      COLOR_BUFFER_BIT: 0x4000,
      NEAREST: 0x2600,
      readBuffer(attachment) {
        operations.push(['readBuffer', attachment]);
      },
      framebufferTexture2D(target, attachment, textarget, texture, level) {
        operations.push(['framebufferTexture2D', target, attachment, textarget, texture, level]);
      },
      drawBuffers(buffers) {
        operations.push(['drawBuffers', buffers]);
      },
      blitFramebuffer(...args) {
        operations.push(['blitFramebuffer', ...args]);
      },
    };

    const originalGl = GL.gl;
    GL.gl = /** @type {WebGL2RenderingContext} */ (mockGl);
    eventBus.publish('gl.ready');

    try {
      PostProcess._resolveMSAAColorAttachment(mockGl.COLOR_ATTACHMENT1, 'emissive-texture', 320, 200);
    } finally {
      GL.gl = originalGl;
      eventBus.publish('gl.shutdown');
      if (originalGl) {
        eventBus.publish('gl.ready');
      }
    }

    assert.deepEqual(operations, [
      ['readBuffer', mockGl.COLOR_ATTACHMENT1],
      ['framebufferTexture2D', mockGl.DRAW_FRAMEBUFFER, mockGl.COLOR_ATTACHMENT1, mockGl.TEXTURE_2D, null, 0],
      ['framebufferTexture2D', mockGl.DRAW_FRAMEBUFFER, mockGl.COLOR_ATTACHMENT0, mockGl.TEXTURE_2D, 'emissive-texture', 0],
      ['drawBuffers', [mockGl.COLOR_ATTACHMENT0]],
      ['blitFramebuffer', 0, 0, 320, 200, 0, 0, 320, 200, mockGl.COLOR_BUFFER_BIT, mockGl.NEAREST],
    ]);
  });
});

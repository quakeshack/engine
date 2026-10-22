import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { publishGlReady } from '../support/glEvents.ts';

import GL from '../../source/engine/client/GL.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import type { GLRenderTexture } from '../../source/engine/client/GL.ts';

void describe('PostProcess._resolveMSAAColorAttachment', () => {
  void test('resolves secondary attachments through draw attachment 0', () => {
    const operations: unknown[][] = [];
    const textureHandle = 'emissive-texture-handle';
    const mockGl = {
      COLOR_ATTACHMENT0: 0x8CE0,
      COLOR_ATTACHMENT1: 0x8CE1,
      DRAW_FRAMEBUFFER: 0x8CA9,
      TEXTURE_2D: 0x0DE1,
      COLOR_BUFFER_BIT: 0x4000,
      NEAREST: 0x2600,
      readBuffer(attachment: number) {
        operations.push(['readBuffer', attachment]);
      },
      framebufferTexture2D(target: number, attachment: number, textarget: number, texture: unknown, level: number) {
        operations.push(['framebufferTexture2D', target, attachment, textarget, texture, level]);
      },
      drawBuffers(buffers: number[]) {
        operations.push(['drawBuffers', buffers]);
      },
      blitFramebuffer(...args: unknown[]) {
        operations.push(['blitFramebuffer', ...args]);
      },
    };

    // GLRenderTexture stub: records the attach through the same mockGl calls
    // a real GLRenderTexture.attachToFramebuffer() would make.
    const targetTexture = {
      attachToFramebuffer(attachmentPoint: number) {
        mockGl.framebufferTexture2D(mockGl.DRAW_FRAMEBUFFER, attachmentPoint, mockGl.TEXTURE_2D, textureHandle, 0);
      },
    } as unknown as GLRenderTexture;

    const originalGl = GL.gl;
    // The resolve only calls the few functions the mock records.
    GL.gl = mockGl as unknown as WebGL2RenderingContext;
    publishGlReady();

    try {
      PostProcess._resolveMSAAColorAttachment(mockGl.COLOR_ATTACHMENT1, targetTexture, 320, 200);
    } finally {
      GL.gl = originalGl;
      eventBus.publish('gl.shutdown');
      if (originalGl) {
        publishGlReady();
      }
    }

    assert.deepEqual(operations, [
      ['readBuffer', mockGl.COLOR_ATTACHMENT1],
      ['framebufferTexture2D', mockGl.DRAW_FRAMEBUFFER, mockGl.COLOR_ATTACHMENT1, mockGl.TEXTURE_2D, null, 0],
      ['framebufferTexture2D', mockGl.DRAW_FRAMEBUFFER, mockGl.COLOR_ATTACHMENT0, mockGl.TEXTURE_2D, textureHandle, 0],
      ['drawBuffers', [mockGl.COLOR_ATTACHMENT0]],
      ['blitFramebuffer', 0, 0, 320, 200, 0, 0, 320, 200, mockGl.COLOR_BUFFER_BIT, mockGl.NEAREST],
    ]);
  });
});

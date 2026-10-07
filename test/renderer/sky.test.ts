import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { SimpleSkyBox } from '../../source/engine/client/renderer/Sky.ts';
import type { BrushModel } from '../../source/engine/common/model/BSP.ts';

/**
 * A stand-in for a WebGL context that creates objects for anything asked of it.
 * @returns The stand-in.
 */
function createFakeContext(): WebGL2RenderingContext {
  return new Proxy({}, {
    get: (_target, property) => (typeof property === 'string' && /^[A-Z_0-9]+$/.test(property) ? 0 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
}

void describe('Sky shutdown', () => {
  const previousContext = GL.gl;
  const previousCreateVAO = GL.CreateVAO;

  afterEach(() => {
    GL.gl = previousContext;
    GL.CreateVAO = previousCreateVAO;
  });

  void test('a skybox with buffers can be shut down after its context is gone, as when the page is closing', () => {
    GL.gl = createFakeContext();
    GL.CreateVAO = () => ({}) as WebGLVertexArrayObject;
    eventBus.publish('gl.ready');

    const sky = new SimpleSkyBox({ textures: [] } as unknown as BrushModel);

    sky.init();

    // closing the page: the context goes away first, a late disconnect clears the sky afterwards
    eventBus.publish('gl.shutdown');

    assert.doesNotThrow(() => { sky.shutdown(); });
  });

  void test('shutting a skybox down twice is harmless', () => {
    GL.gl = createFakeContext();
    GL.CreateVAO = () => ({}) as WebGLVertexArrayObject;
    eventBus.publish('gl.ready');

    const sky = new SimpleSkyBox({ textures: [] } as unknown as BrushModel);

    sky.init();
    sky.shutdown();

    assert.doesNotThrow(() => { sky.shutdown(); });
  });
});

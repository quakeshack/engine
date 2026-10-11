import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import { eventBus } from '../../source/engine/common/EventBus.ts';
import { publishGlReady } from '../support/glEvents.ts';
import GL from '../../source/engine/client/GL.ts';
import VID from '../../source/engine/client/VID.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import PostProcessEffect from '../../source/engine/client/renderer/postprocess/PostProcessEffect.ts';
import { patchMembers } from '../support/clientState.ts';

/** An effect that draws nothing. */
class NoopEffect extends PostProcessEffect {
  constructor(name: string) {
    super(name);
    this.stackable = true;
  }

  override apply(): void {}
}

void describe('PostProcess.resolveGameplayStack', () => {
  const previousEffects = PostProcess.effects;
  const previousContext = GL.gl;
  let restores: Array<() => void> = [];

  beforeEach(() => {
    PostProcess.effects = [new NoopEffect('blur')];
    restores = [
      patchMembers(PostProcess, {
        colorTexture: { id: 'scene' } as never,
        fbo: { id: 'scene fbo' } as never,
        pingFBO: { id: 'ping' } as never,
        pongFBO: { id: 'pong' } as never,
        pingTexture: { id: 'ping texture' } as never,
        pongTexture: { id: 'pong texture' } as never,
      }),
      patchMembers(VID, { width: 640, height: 480, pixelRatio: 1 }),
    ];
    mock.method(PostProcess, 'resizePingPong', () => {});
    mock.method(PostProcess, '_blitToScreen', () => {});
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }

    PostProcess.clearStack();
    PostProcess.effects = previousEffects;
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  void test('leaves the screen bound and the viewport as it found it, so the scene is resolved to the screen', () => {
    const bound: unknown[] = [];
    const viewports: number[][] = [];

    GL.gl = new Proxy({}, {
      get: (_target, property) => {
        if (property === 'getParameter') {
          return () => new Int32Array([10, 20, 300, 200]);
        }

        if (property === 'bindFramebuffer') {
          return (_binding: unknown, framebuffer: unknown) => { bound.push(framebuffer); };
        }

        if (property === 'viewport') {
          return (...values: number[]) => { viewports.push(values); };
        }

        return typeof property === 'string' && /^[A-Z_0-9]+$/.test(property) ? 0 : () => ({});
      },
    }) as unknown as WebGL2RenderingContext;
    publishGlReady();
    PostProcess.setStack([{ id: 'blur', settings: { radius: 2 } }]);

    PostProcess.resolveGameplayStack();

    // the result is written into the scene FBO, and the next thing that draws, the resolve to the screen or the
    // HUD, must not land in it
    assert.ok(bound.some((framebuffer) => framebuffer !== null), 'the result was written into the scene FBO');
    assert.equal(bound[bound.length - 1], null, 'the last framebuffer bound is the screen');
    assert.deepEqual(viewports[viewports.length - 1], [10, 20, 300, 200]);
  });
});

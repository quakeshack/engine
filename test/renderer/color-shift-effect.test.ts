import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import type Cvar from '../../source/engine/common/Cvar.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import GL, { type GLRenderTexture } from '../../source/engine/client/GL.ts';
import ColorShiftEffect, { type MixedColorShift } from '../../source/engine/client/renderer/postprocess/ColorShiftEffect.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';

const layer = (r: number, g: number, b: number, alpha: number): { color: number[]; alpha: number } => ({ color: [r, g, b], alpha });

void describe('ColorShiftEffect', () => {
  void describe('mix', () => {
    void test('is a single layer as it is', () => {
      const mixed = ColorShiftEffect.mix([layer(0.5, 0.25, 1, 0.4)]);

      assert.deepEqual(mixed.color, [0.5, 0.25, 1]);
      assertNear(mixed.alpha, 0.4, 1e-12);
    });

    void test('lays each layer over the result of the ones before, a = a + a2 * (1 - a)', () => {
      const mixed = ColorShiftEffect.mix([layer(1, 0, 0, 0.5), layer(0, 0, 1, 0.5)]);

      // 0.5 + 0.5 * 0.5
      assertNear(mixed.alpha, 0.75, 1e-12);
      // the second layer brings 0.5 / 0.75 of the coverage
      assertNear(mixed.color[0], 1 - 0.5 / 0.75, 1e-12);
      assertNear(mixed.color[2], 0.5 / 0.75, 1e-12);
    });

    void test('is the same as laying the layers over a scene with ordinary alpha blending, one after the other', () => {
      const layers = [layer(0.9, 0.1, 0.2, 0.3), layer(0.1, 0.8, 0.3, 0.6), layer(0.2, 0.2, 0.9, 0.15)];
      const scene = [0.4, 0.5, 0.6];

      const sequential = [...scene];
      for (const { color, alpha } of layers) {
        for (let channel = 0; channel < 3; channel++) {
          sequential[channel] = sequential[channel] * (1 - alpha) + color[channel] * alpha;
        }
      }

      const mixed = ColorShiftEffect.mix(layers);
      const once = scene.map((value, channel) => value * (1 - mixed.alpha) + mixed.color[channel] * mixed.alpha);

      for (let channel = 0; channel < 3; channel++) {
        assertNear(once[channel], sequential[channel], 1e-12);
      }
    });

    void test('depends on the order of the layers', () => {
      const forward = ColorShiftEffect.mix([layer(1, 0, 0, 0.5), layer(0, 0, 1, 0.25)]);
      const reversed = ColorShiftEffect.mix([layer(0, 0, 1, 0.25), layer(1, 0, 0, 0.5)]);

      assertNear(forward.alpha, reversed.alpha, 1e-12);
      assert.ok(Math.abs(forward.color[0] - reversed.color[0]) > 0.1);
    });

    void test('scales every layer by the percentage', () => {
      assertNear(ColorShiftEffect.mix([layer(1, 1, 1, 0.8)], 0.5).alpha, 0.4, 1e-12);
      assert.equal(ColorShiftEffect.mix([layer(1, 1, 1, 0.8)], 0).alpha, 0);
    });

    void test('never covers more than the whole view, and not less than nothing', () => {
      assert.equal(ColorShiftEffect.mix([layer(1, 1, 1, 1), layer(1, 1, 1, 1)]).alpha, 1);
      assert.equal(ColorShiftEffect.mix([layer(1, 1, 1, 1)], 3).alpha, 1);
    });

    void test('skips layers that cover nothing, are negative or are not numbers', () => {
      const mixed = ColorShiftEffect.mix([layer(1, 0, 0, 0), layer(0, 1, 0, -0.5), layer(0, 0, 1, Number.NaN), layer(1, 1, 0, 0.2)]);

      assert.deepEqual(mixed.color, [1, 1, 0]);
      assertNear(mixed.alpha, 0.2, 1e-12);
    });

    void test('takes a layer without a color as black', () => {
      const mixed = ColorShiftEffect.mix([{ alpha: 0.5 }]);

      assert.deepEqual(mixed.color, [0, 0, 0]);
    });

    void test('draws nothing for no layers', () => {
      assert.equal(ColorShiftEffect.mix([]).alpha, 0);
    });
  });

  void describe('settings', () => {
    void test('repair a color or an alpha that is not a number', () => {
      assert.deepEqual(ColorShiftEffect.resolveSettings({ color: [Number.NaN, 0, 0], alpha: Number.NaN }), { color: [0, 0, 0], alpha: 0 });
      assert.deepEqual(ColorShiftEffect.resolveSettings({}), { color: [0, 0, 0], alpha: 0 });
    });

    void test('fade only the alpha, the color stays', () => {
      assert.deepEqual(new ColorShiftEffect().neutral, { alpha: 0 });
    });

    void test('run in the final stage, over what the renderer\'s own effects made of the scene', () => {
      assert.equal(new ColorShiftEffect().defaultStage, 'final');
    });
  });

  void describe('combineSettings', () => {
    const effect = new ColorShiftEffect();
    let restores: Array<() => void> = [];
    let cshiftpercent = { value: 100 };
    let polyblend = { value: 1 };

    beforeEach(() => {
      cshiftpercent = { value: 100 };
      polyblend = { value: 1 };
      restores = [patchMembers(rendererCvars, { cshiftpercent: cshiftpercent as unknown as Cvar, polyblend: polyblend as unknown as Cvar })];
    });

    afterEach(() => {
      for (const restore of restores.reverse()) {
        restore();
      }
    });

    void test('mixes a run into one tint, scaled by gl_cshiftpercent', () => {
      cshiftpercent.value = 50;

      const mixed = effect.combineSettings([layer(1, 0, 0, 0.8)]);

      assertNear(mixed!.alpha, 0.4, 1e-12);
    });

    void test('draws nothing with gl_polyblend at zero, or when the mix covers nothing', () => {
      polyblend.value = 0;
      assert.equal(effect.combineSettings([layer(1, 0, 0, 0.8)]), null);

      polyblend.value = 1;
      assert.equal(effect.combineSettings([layer(1, 0, 0, 0)]), null);

      cshiftpercent.value = 0;
      assert.equal(effect.combineSettings([layer(1, 0, 0, 0.8)]), null);
    });
  });

  void describe('apply', () => {
    const previousContext = GL.gl;
    let events: string[] = [];
    let quads: number[][] = [];

    beforeEach(() => {
      events = [];
      quads = [];
      GL.gl = new Proxy({}, {
        get: (_target, property) => {
          if (property === 'blendFunc') {
            return () => { events.push('blendFunc'); };
          }

          if (property === 'disable') {
            return () => { events.push('disable'); };
          }

          return typeof property === 'string' && /^[A-Z_0-9]+$/.test(property) ? 0 : () => ({});
        },
      }) as unknown as WebGL2RenderingContext;
      eventBus.publish('gl.ready');

      mock.method(PostProcess, '_blitToScreen', (_texture: unknown, x: number, y: number, width: number, height: number) => {
        events.push(`blit ${x} ${y} ${width} ${height}`);
      });
      mock.method(GL, 'UseProgram', (identifier: string) => { events.push(`program ${identifier}`); return null; });
      mock.method(GL, 'StreamDrawColoredQuad', (...values: number[]) => { events.push('quad'); quads.push(values); });
      mock.method(GL, 'StreamFlush', () => { events.push('flush'); });
    });

    afterEach(() => {
      mock.restoreAll();
      eventBus.publish('gl.shutdown');
      GL.gl = previousContext;
    });

    const input = { id: 'input' } as unknown as GLRenderTexture;

    void test('copies the scene, then draws the tint as one quad over the same rectangle, rounded to bytes', () => {
      const settings: MixedColorShift = { color: [1, 0.5, 0], alpha: 0.5 };

      new ColorShiftEffect().apply(input, 10, 20, 300, 200, settings);

      assert.deepEqual(events, ['blit 10 20 300 200', 'blendFunc', 'program fill', 'quad', 'flush', 'disable']);
      assert.deepEqual(quads, [[10, 20, 300, 200, 255, 128, 0, 128]]);
    });

    void test('only copies the scene when there is no tint, which is how a chain passes it on', () => {
      new ColorShiftEffect().apply(input, 0, 0, 640, 480, null);

      assert.deepEqual(events, ['blit 0 0 640 480', 'disable']);
    });

    void test('keeps the bytes in range', () => {
      new ColorShiftEffect().apply(input, 0, 0, 10, 10, { color: [2, -1, 0.5], alpha: 3 });

      assert.deepEqual(quads[0].slice(4), [255, 0, 128, 255]);
    });
  });
});

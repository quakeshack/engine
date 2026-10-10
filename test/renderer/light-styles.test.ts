import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import GL from '../../source/engine/client/GL.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import LightStyles from '../../source/engine/client/renderer/lighting/LightStyles.ts';
import Interpolation from '../../source/engine/client/renderer/scene/Interpolation.ts';
import rendererCvars from '../../source/engine/client/renderer/resources/RendererCvars.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers, useClientStateOf } from '../support/clientState.ts';

interface Upload {
  readonly texture: string;
  readonly data: number[];
}

void describe('LightStyles', () => {
  const previousContext = GL.gl;
  const previousTextures = [LightStyles.lightstyle_texture_a, LightStyles.lightstyle_texture_b];
  const uploads: Upload[] = [];
  let bound = '';
  let restores: Array<() => void> = [];

  beforeEach(() => {
    uploads.length = 0;

    const texture = (name: string) => ({ bind: () => { bound = name; } }) as unknown as typeof LightStyles.lightstyle_texture_a;

    LightStyles.lightstyle_texture_a = texture('a');
    LightStyles.lightstyle_texture_b = texture('b');

    GL.gl = {
      TEXTURE_2D: 1,
      RED: 2,
      UNSIGNED_BYTE: 3,
      texSubImage2D: (...args: unknown[]) => { uploads.push({ texture: bound, data: [...(args[8] as Uint8Array)] }); },
    } as unknown as WebGL2RenderingContext;
    eventBus.publish('gl.ready');
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    restores = [];
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
    [LightStyles.lightstyle_texture_a, LightStyles.lightstyle_texture_b] = previousTextures;
    LightStyles.Clear();
  });

  /**
   * Sets the clock, the lightstyle strings and the `r_fullbright` value.
   * @param time Client time in seconds.
   * @param lightstyle The strings of the first styles, the others are empty.
   * @param fullbright Value of `r_fullbright`.
   */
  function setup(time: number, lightstyle: string[], fullbright = 0): void {
    const styles = Array.from({ length: 64 }, (_, index) => lightstyle[index] ?? '');

    restores.push(
      useClientStateOf({ state: { time, clientEntities: { lightstyle: styles } } }),
      patchMembers(rendererCvars, { fullbright: { value: fullbright } }),
    );
  }

  void describe('Animate', () => {
    void test('maps letters to intensities, a is 0 and m is 12, one 10 Hz step apart for the second texture', () => {
      // step 3 at t = 0.35: "azm" -> index 3 % 3 = 0 ('a' = 0), next index 1 ('z' = 25)
      setup(0.35, ['azm']);

      LightStyles.Animate();

      assert.equal(LightStyles.lightstylevalue_a[0], 0);
      assert.equal(LightStyles.lightstylevalue_b[0], 25);
    });

    void test('wraps around the end of the string', () => {
      // step 2 at t = 0.25: "ab" -> index 0 and then 1; step 3: index 1 and then 0
      setup(0.35, ['ab']);

      LightStyles.Animate();

      assert.equal(LightStyles.lightstylevalue_a[0], 1);
      assert.equal(LightStyles.lightstylevalue_b[0], 0);
    });

    void test('keeps a style without a string at normal brightness', () => {
      setup(1.0, []);

      LightStyles.Animate();

      assert.equal(LightStyles.lightstylevalue_a[5], 12);
      assert.equal(LightStyles.lightstylevalue_b[5], 12);
    });

    void test('makes every style normal with r_fullbright', () => {
      setup(0.35, ['azm'], 1);

      LightStyles.Animate();

      assert.equal(LightStyles.lightstylevalue_a[0], 12);
      assert.equal(LightStyles.lightstylevalue_b[0], 12);
    });

    void test('uploads both rows of 64 intensities, a to the first texture and b to the second', () => {
      setup(0.35, ['azm']);

      LightStyles.Animate();

      assert.equal(uploads.length, 2);
      assert.equal(uploads[0].texture, 'a');
      assert.equal(uploads[0].data.length, 64);
      assert.equal(uploads[0].data[0], 0);
      assert.equal(uploads[1].texture, 'b');
      assert.equal(uploads[1].data[0], 25);
    });
  });

  void describe('Clear', () => {
    void test('puts every style back to normal brightness', () => {
      LightStyles.lightstylevalue_a.fill(3);
      LightStyles.lightstylevalue_b.fill(4);

      LightStyles.Clear();

      assert.ok(LightStyles.lightstylevalue_a.every((value) => value === 12));
      assert.ok(LightStyles.lightstylevalue_b.every((value) => value === 12));
    });
  });
});

void describe('Interpolation', () => {
  let restores: Array<() => void> = [];

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    restores = [];
  });

  /**
   * Sets the clock and the `r_interpolation` value.
   * @param time Client time in seconds.
   * @param enabled Value of `r_interpolation`.
   */
  function setup(time: number, enabled: number): void {
    restores.push(
      useClientStateOf({ state: { time } }),
      patchMembers(rendererCvars, { interpolation: { value: enabled } }),
    );
  }

  void test('is 0 for both kinds while r_interpolation is off', () => {
    setup(0.13, 0);

    assert.equal(Interpolation.Texture(), 0);
    assert.equal(Interpolation.Lightstyle(), 0);
  });

  void test('runs texture frames linearly over 0.2 seconds', () => {
    setup(0.05, 1);

    assertNear(Interpolation.Texture(), 0.25);
  });

  void test('eases lightstyles over 0.1 seconds with a smoothstep', () => {
    // t = 0.025 is a quarter of a step: 0.25 * 0.25 * (3 - 0.5)
    setup(0.025, 1);

    assertNear(Interpolation.Lightstyle(), 0.15625);
  });

  void test('is back at 0 when a step starts', () => {
    setup(0.2, 1);

    assertNear(Interpolation.Texture(), 0);
    assertNear(Interpolation.Lightstyle(), 0);
  });
});

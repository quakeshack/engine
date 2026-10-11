import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import Host from '../../source/engine/common/Host.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import GL, { type GLRenderTexture } from '../../source/engine/client/GL.ts';
import VID from '../../source/engine/client/VID.ts';
import BlurEffect from '../../source/engine/client/renderer/postprocess/BlurEffect.ts';
import ColorGradeEffect from '../../source/engine/client/renderer/postprocess/ColorGradeEffect.ts';
import PostProcess from '../../source/engine/client/renderer/postprocess/PostProcess.ts';
import PostProcessEffect from '../../source/engine/client/renderer/postprocess/PostProcessEffect.ts';
import PostProcessEntries from '../../source/engine/client/renderer/postprocess/PostProcessEntries.ts';
import { assertNear } from '../support/assertions.ts';
import { patchMembers } from '../support/clientState.ts';

type Call = [name: string, input: unknown, settings: object | null];

/** An effect that only records what it was asked to apply. */
class RecordingEffect extends PostProcessEffect {
  readonly calls: Call[];
  override readonly neutral: object;

  constructor(name: string, calls: Call[], stackable = true) {
    super(name);
    this.calls = calls;
    this.stackable = stackable;
    // what a blur has: nothing is blurred at a radius of 0
    this.neutral = { radius: 0 };
  }

  override apply(inputTexture: GLRenderTexture, _x: number, _y: number, _width: number, _height: number, settings: object | null = null): void {
    this.calls.push([this.name, inputTexture, settings]);
  }
}

/**
 * A stand-in for a WebGL context that creates objects for anything asked of it.
 * @returns The stand-in.
 */
function createFakeContext(): WebGL2RenderingContext {
  return new Proxy({}, {
    get: (_target, property) => (typeof property === 'string' && /^[A-Z_0-9]+$/.test(property) ? 0 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
}

void describe('PostProcess gameplay stack', () => {
  const previousEffects = PostProcess.effects;
  const previousContext = GL.gl;
  let calls: Call[] = [];
  let restores: Array<() => void> = [];
  let blit: ReturnType<typeof mock.method> = null!;

  beforeEach(() => {
    calls = [];
    GL.gl = createFakeContext();
    eventBus.publish('gl.ready');

    PostProcess.effects = [
      new RecordingEffect('color-grade', calls),
      new RecordingEffect('blur', calls),
    ];
    restores = [
      patchMembers(PostProcess, { colorTexture: { id: 'scene' } as unknown as GLRenderTexture }),
      patchMembers(VID, { width: 640, height: 480, pixelRatio: 1 }),
    ];
    mock.method(PostProcess, 'resizePingPong', () => {});
    blit = mock.method(PostProcess, '_blitToScreen', () => {});
  });

  afterEach(() => {
    mock.restoreAll();

    for (const restore of restores.reverse()) {
      restore();
    }

    PostProcess.entries.reset();
    PostProcess.effects = previousEffects;
    eventBus.publish('gl.shutdown');
    GL.gl = previousContext;
  });

  void describe('the game-facing methods', () => {
    void test('keeps the entries in the order the game gave them', () => {
      PostProcess.setStack([
        { id: 'blur', settings: { radius: 4 } },
        { id: 'color-grade', settings: { saturation: 1.25 } },
      ]);

      assert.equal(PostProcess.hasStack(), true);
      assert.deepEqual(PostProcess.entries.collect('scene').map((entry) => entry.id), ['blur', 'color-grade']);
    });

    void test('clears the stack on request', () => {
      PostProcess.setStack([{ id: 'color-grade', settings: { saturation: 0.5 } }]);

      PostProcess.clearStack();

      assert.equal(PostProcess.hasStack(), false);
      assert.deepEqual(PostProcess.entries.collect('scene'), []);
    });

    void test('ignores entries of an effect that is not registered when resolving', () => {
      PostProcess.effects = [new RecordingEffect('color-grade', calls)];
      PostProcess.setStack([
        { id: 'color-grade', settings: { saturation: 1.1 } },
        { id: 'blur', settings: { radius: 4 } },
      ]);

      PostProcess.resolveGameplayStack();

      assert.deepEqual(calls.map(([name]) => name), ['color-grade']);
    });

    void test('tells a stack that stays from something that is only passing', () => {
      assert.equal(PostProcess.hasGameplayStack(), false);

      PostProcess.pulse({ id: 'blur', settings: { radius: 4 }, timing: { hold: 1 } });

      assert.equal(PostProcess.hasStack(), false);
      assert.equal(PostProcess.hasGameplayStack(), true);
    });
  });

  void describe('advance', () => {
    void test('moves the fades by the real time between two calls, and not at all on the first', () => {
      const restoreHost = patchMembers(Host, { realtime: 100 });
      restores.push(restoreHost);
      PostProcess.advance();
      PostProcess.setStack([{ id: 'blur', settings: { radius: 8 } }], { fade: 1 });

      Host.realtime = 100.05;
      PostProcess.advance();

      const radius = (PostProcess.entries.collect('scene')[0].settings as { radius: number }).radius;
      assertNear(radius, 8 * 0.05, 1e-9);
    });
  });

  void describe('resolveGameplayStack', () => {
    void test('applies every entry in order, each with its own settings, through the capture texture', () => {
      PostProcess.setStack([
        { id: 'blur', settings: { radius: 2 } },
        { id: 'color-grade', settings: { saturation: 0 } },
        { id: 'blur', settings: { radius: 9 } },
      ]);

      PostProcess.resolveGameplayStack();

      assert.deepEqual(calls.map(([name]) => name), ['blur', 'color-grade', 'blur']);
      assert.equal(calls[0][1], PostProcess.colorTexture);
      assert.equal((calls[0][2] as { radius: number }).radius, 2);
      assert.equal((calls[2][2] as { radius: number }).radius, 9);
    });

    void test('applies the pulses of the frame, faded, and not the entries of the final stage', () => {
      PostProcess.pulse({ id: 'blur', settings: { radius: 8 }, timing: { fadeIn: 1, hold: 1 } });
      PostProcess.entries.advance(0.1);
      PostProcess.setStack([{ id: 'color-grade', settings: { saturation: 0 }, stage: 'final' }]);

      PostProcess.resolveGameplayStack();

      assert.deepEqual(calls.map(([name]) => name), ['blur']);
      assertNear((calls[0][2] as { radius: number }).radius, 0.8, 1e-9);
    });

    void test('does nothing without entries', () => {
      PostProcess.resolveGameplayStack();

      assert.deepEqual(calls, []);
    });
  });

  void describe('resolve', () => {
    const screenTexture = { id: 'screen' } as unknown as GLRenderTexture;

    void test('blits the scene when nothing is active', () => {
      PostProcess.resolve(0, 0, 640, 480, screenTexture);

      assert.equal(blit.mock.callCount(), 1);
      assert.deepEqual(calls, []);
    });

    void test('applies the renderer\'s own effects first, then the final stage of the game, which is last', () => {
      const warp = new RecordingEffect('warp', calls, false);
      warp.active = true;
      PostProcess.effects.push(warp);
      PostProcess.setStack([
        { id: 'blur', settings: { radius: 3 }, stage: 'final' },
        { id: 'color-grade', settings: { saturation: 0.2 } },
      ]);

      PostProcess.resolve(0, 0, 640, 480, screenTexture);

      assert.deepEqual(calls.map(([name]) => name), ['warp', 'blur']);
      assert.equal(calls[0][2], null, 'a renderer effect has no entry settings');
      assert.equal((calls[1][2] as { radius: number }).radius, 3);
    });

    void test('renders to the screen through the final entry alone, with no blit of the scene', () => {
      PostProcess.setStack([{ id: 'blur', settings: { radius: 3 }, stage: 'final' }]);

      PostProcess.resolve(0, 0, 640, 480, screenTexture);

      assert.equal(blit.mock.callCount(), 0);
      assert.deepEqual(calls.map(([name, input]) => [name, input]), [['blur', screenTexture]]);
    });
  });

  void describe('the effects of the stack', () => {
    void test('list the numbers that fade, and none that would only change a tint or a period', () => {
      assert.deepEqual(Object.keys(new ColorGradeEffect().neutral).sort(), ['contrast', 'exposure', 'pulseStrength', 'saturation', 'tintStrength']);
      assert.deepEqual(new BlurEffect().neutral, { radius: 0 });
    });

    void test('fade a grade in with its tint color carried over whole', () => {
      const effect = new ColorGradeEffect();
      const settings = effect.resolveSettings({ saturation: 0, tintColor: [1, 0, 0] as never, tintStrength: 1, pulsePeriod: 0.8 });

      const half = PostProcessEntries.blend(effect.neutral, null, settings as Record<string, unknown>, 0.5);

      assert.equal(half.saturation, 0.5);
      assert.equal(half.tintStrength, 0.5);
      assert.deepEqual(half.tintColor, [1, 0, 0]);
      assert.equal(half.pulsePeriod, 0.8);
    });

    void test('normalize color-grade and blur settings to safe defaults', () => {
      assert.deepEqual(ColorGradeEffect.resolveSettings({ saturation: Number.NaN, tintStrength: Number.NaN }), {
        saturation: 1.0,
        contrast: 1.0,
        exposure: 0.0,
        tintColor: undefined,
        tintStrength: 0.0,
        pulseStrength: 0.0,
        pulsePeriod: 0.0,
      });

      assert.deepEqual(BlurEffect.resolveSettings({ radius: Number.NaN }), { radius: 4.0 });
    });

    void test('let an entry that leaves a radius out blur by the default', () => {
      assert.deepEqual(new BlurEffect().resolveSettings({}), { radius: 4.0 });
    });

    void test('run in the scene stage, before the renderer\'s own effects', () => {
      assert.equal(new ColorGradeEffect().defaultStage, 'scene');
      assert.equal(new BlurEffect().defaultStage, 'scene');
    });
  });
});

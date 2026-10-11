import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import type { PostProcessEffectDescriptor, PostProcessPulseDescriptor, PostProcessStage } from '../../source/shared/GameInterfaces.ts';
import PostProcessEntries, {
  MAX_ADVANCE,
  type PostProcessEntryEffect,
} from '../../source/engine/client/renderer/postprocess/PostProcessEntries.ts';
import { assertNear } from '../support/assertions.ts';

/**
 * Builds a stand-in for an effect.
 * @param neutral The settings that change nothing.
 * @param defaults What the effect fills in for a setting the game left out.
 * @param defaultStage The stage the effect runs in.
 * @returns The effect.
 */
function createEffect(neutral: object, defaults: object, defaultStage: PostProcessStage = 'scene'): PostProcessEntryEffect {
  return {
    neutral,
    defaultStage,
    resolveSettings: (settings) => ({ ...defaults, ...settings }),
  };
}

const grade = (settings: object, options: object = {}): PostProcessEffectDescriptor =>
  ({ id: 'color-grade', settings, ...options }) as PostProcessEffectDescriptor;
const blur = (radius: number | undefined, options: object = {}): PostProcessEffectDescriptor =>
  ({ id: 'blur', settings: radius === undefined ? {} : { radius }, ...options }) as PostProcessEffectDescriptor;
const blurPulse = (radius: number, timing: object, options: object = {}): PostProcessPulseDescriptor =>
  ({ id: 'blur', settings: { radius }, timing, ...options }) as PostProcessPulseDescriptor;

/**
 * Lists the radii of the blur entries in a stage, which is how these tests read what would be applied.
 * @param entries The entries.
 * @param stage The stage.
 * @returns The radius of each entry of the stage, in order.
 */
function radii(entries: PostProcessEntries, stage: PostProcessStage = 'scene'): number[] {
  return entries.collect(stage).filter((entry) => entry.id === 'blur').map((entry) => (entry.settings as { radius: number }).radius);
}

void describe('PostProcessEntries', () => {
  let entries: PostProcessEntries = null!;

  /**
   * Lets time pass in steps the model accepts.
   * @param seconds How long.
   */
  function run(seconds: number): void {
    let left = seconds;

    while (left > 1e-9) {
      const step = Math.min(left, 0.05);

      entries.advance(step);
      left -= step;
    }
  }

  beforeEach(() => {
    const effects: Record<string, PostProcessEntryEffect> = {
      'color-grade': createEffect({ saturation: 1, tintStrength: 0 }, { saturation: 1, tintStrength: 0 }),
      blur: createEffect({ radius: 0 }, { radius: 4 }),
      shift: createEffect({ alpha: 0 }, { alpha: 0 }, 'final'),
    };

    entries = new PostProcessEntries((id) => effects[id]);
  });

  void describe('pulseIntensity', () => {
    const timing = { fadeIn: 1, hold: 2, fadeOut: 1 };

    void test('rises during the fade-in, holds, falls during the fade-out and is zero after', () => {
      assert.equal(PostProcessEntries.pulseIntensity(timing, 0), 0);
      assertNear(PostProcessEntries.pulseIntensity(timing, 0.5), 0.5);
      assert.equal(PostProcessEntries.pulseIntensity(timing, 1), 1);
      assert.equal(PostProcessEntries.pulseIntensity(timing, 2.5), 1);
      assertNear(PostProcessEntries.pulseIntensity(timing, 3.5), 0.5);
      assert.equal(PostProcessEntries.pulseIntensity(timing, 4), 0);
      assert.equal(PostProcessEntries.pulseIntensity(timing, 9), 0);
    });

    void test('is full strength from the first moment without a fade-in', () => {
      assert.equal(PostProcessEntries.pulseIntensity({ fadeIn: 0, hold: 1, fadeOut: 1 }, 0), 1);
    });
  });

  void describe('blend', () => {
    const neutral = { saturation: 1, radius: 0 };

    void test('moves the numbers the effect lists, from nothing when there is no origin', () => {
      assert.deepEqual(PostProcessEntries.blend(neutral, null, { saturation: 0, radius: 8 }, 0.25), { saturation: 0.75, radius: 2 });
    });

    void test('moves to nothing when there is no target, and keeps what is not listed from the origin', () => {
      const result = PostProcessEntries.blend(neutral, { saturation: 0, tint: 'red' }, null, 0.5);

      assert.deepEqual(result, { saturation: 0.5, radius: 0, tint: 'red' });
    });

    void test('takes what is not listed as it is from the target, so a tint color or a period does not fade', () => {
      const result = PostProcessEntries.blend(neutral, null, { saturation: 0, period: 0.8 }, 0.1);

      assert.equal(result.period, 0.8);
    });
  });

  void describe('the stack', () => {
    void test('applies the entries in the order the game gave them, with the effect filling in the rest', () => {
      entries.setStack([blur(6), grade({ saturation: 0.5 })]);

      assert.deepEqual(entries.collect('scene'), [
        { id: 'blur', settings: { radius: 6 } },
        { id: 'color-grade', settings: { saturation: 0.5, tintStrength: 0 } },
      ]);
    });

    void test('applies an effect once per entry', () => {
      entries.setStack([blur(2), grade({ saturation: 0 }), blur(8)]);

      assert.deepEqual(radii(entries), [2, 8]);
    });

    void test('skips entries of an effect that is not registered, and still counts them as a stack', () => {
      entries.setStack([{ id: 'unknown', settings: {} } as unknown as PostProcessEffectDescriptor, blur(3)]);

      assert.deepEqual(radii(entries), [3]);
      assert.equal(entries.hasStack(), true);
    });

    void test('ignores null entries', () => {
      entries.setStack([null as unknown as PostProcessEffectDescriptor, blur(3)]);

      assert.deepEqual(radii(entries), [3]);
    });

    void test('replaces the whole stack of a channel', () => {
      entries.setStack([blur(2)]);
      entries.setStack([grade({ saturation: 0 })]);

      assert.deepEqual(radii(entries), []);
      assert.equal(entries.collect('scene').length, 1);
    });

    void test('lets an entry change its stage, and an effect have a default one', () => {
      entries.setStack([blur(2, { stage: 'final' }), { id: 'shift', settings: { alpha: 0.5 } } as unknown as PostProcessEffectDescriptor]);

      assert.deepEqual(entries.collect('scene'), []);
      assert.deepEqual(entries.collect('final').map((entry) => entry.id), ['blur', 'shift']);
    });
  });

  void describe('channels', () => {
    void test('compose in the order they were first used, and a replaced channel keeps its place', () => {
      entries.setStack([blur(1)], { channel: 'hud' });
      entries.setStack([blur(2)], { channel: 'game' });
      entries.setStack([blur(3)], { channel: 'hud' });

      assert.deepEqual(radii(entries), [3, 2]);
    });

    void test('are cleared on their own', () => {
      entries.setStack([blur(1)], { channel: 'hud' });
      entries.setStack([blur(2)], { channel: 'game' });

      entries.clearStack('hud');

      assert.deepEqual(radii(entries), [2]);
      assert.equal(entries.hasStack('hud'), false);
      assert.equal(entries.hasStack('game'), true);
      assert.equal(entries.hasStack(), true);
    });

    void test('are all cleared without a name, and a pulse is left to end on its own', () => {
      entries.setStack([blur(1)], { channel: 'hud' });
      entries.setStack([blur(2)]);
      entries.pulse(blurPulse(5, { hold: 1 }));

      entries.clearStack();

      assert.equal(entries.hasStack(), false);
      assert.deepEqual(radii(entries), [5]);
    });
  });

  void describe('fading between stacks', () => {
    void test('fades a new entry in from nothing', () => {
      entries.setStack([blur(8)], { fade: 1 });

      assert.deepEqual(radii(entries), [0]);

      run(0.5);
      assertNear(radii(entries)[0], 4);

      run(0.5);
      assert.deepEqual(radii(entries), [8]);
    });

    void test('moves an entry that stays from its old settings to the new ones', () => {
      entries.setStack([blur(2)]);

      entries.setStack([blur(6)], { fade: 1 });
      assert.deepEqual(radii(entries), [2]);

      run(0.5);
      assertNear(radii(entries)[0], 4);

      run(0.5);
      assert.deepEqual(radii(entries), [6]);
    });

    void test('fades an entry that is gone out, then removes it', () => {
      entries.setStack([blur(8)]);

      entries.setStack([], { fade: 1 });
      assert.equal(entries.hasStack(), false, 'the game asked for no stack');
      assert.equal(entries.hasEntries(), true, 'but there is still something to draw');
      assert.deepEqual(radii(entries), [8]);

      run(0.5);
      assertNear(radii(entries)[0], 4);

      run(0.5);
      assert.equal(entries.hasEntries(), false);
    });

    void test('starts a fade from where the previous one had got to', () => {
      entries.setStack([blur(8)], { fade: 1 });
      run(0.5);

      entries.setStack([blur(0)], { fade: 1 });
      assertNear(radii(entries)[0], 4);

      run(0.5);
      assertNear(radii(entries)[0], 2);
    });

    void test('brings an entry that was fading out back in', () => {
      entries.setStack([blur(8)]);
      entries.setStack([], { fade: 1 });
      run(0.5);

      entries.setStack([blur(8)], { fade: 1 });

      assertNear(radii(entries)[0], 4);
      assert.equal(entries.hasStack(), true);
    });

    void test('matches entries of one effect by position, or by key', () => {
      entries.setStack([blur(2), blur(10)]);

      // swapping the order is a change of both, not of nothing: position 0 goes 2 to 10
      entries.setStack([blur(10), blur(2)], { fade: 1 });
      run(0.5);
      assert.deepEqual(radii(entries).map((radius) => Math.round(radius)), [6, 6]);

      entries.setStack([blur(1, { key: 'a' }), blur(10, { key: 'b' })]);
      entries.setStack([blur(10, { key: 'b' }), blur(1, { key: 'a' })], { fade: 1 });
      run(0.5);
      assert.deepEqual(radii(entries), [10, 1]);
    });

    void test('does not fade the numbers an effect does not list, a tint color for one', () => {
      entries.setStack([grade({ saturation: 1, tintColor: 'red', tintStrength: 1 })], { fade: 1 });
      run(0.25);

      const settings = entries.collect('scene')[0].settings as Record<string, unknown>;

      assert.equal(settings.tintColor, 'red');
      assertNear(settings.tintStrength as number, 0.25);
    });

    void test('ignores a fade that is not a number', () => {
      entries.setStack([blur(8)], { fade: Number.NaN });

      assert.deepEqual(radii(entries), [8]);
    });
  });

  void describe('pulses', () => {
    void test('follow the envelope of their timing and are gone after it', () => {
      entries.pulse(blurPulse(8, { fadeIn: 0.5, hold: 0.5, fadeOut: 0.5 }));

      assert.deepEqual(radii(entries), [0]);

      run(0.25);
      assertNear(radii(entries)[0], 4);

      run(0.25);
      assertNear(radii(entries)[0], 8);

      run(0.5);
      assertNear(radii(entries)[0], 8);

      run(0.25);
      assertNear(radii(entries)[0], 4);

      run(0.25);
      assert.equal(entries.hasEntries(), false);
      assert.deepEqual(radii(entries), []);
    });

    void test('start over under the same key instead of stacking', () => {
      entries.pulse(blurPulse(8, { hold: 1 }, { key: 'damage' }));
      run(0.8);

      entries.pulse(blurPulse(8, { hold: 1 }, { key: 'damage' }));
      run(0.5);

      assert.deepEqual(radii(entries), [8], 'one pulse, and it has not run out');
    });

    void test('stack up without a key', () => {
      entries.pulse(blurPulse(8, { hold: 1 }));
      entries.pulse(blurPulse(3, { hold: 1 }));

      assert.deepEqual(radii(entries), [8, 3]);
    });

    void test('go below or above the stack of their channel, in the order they started', () => {
      entries.setStack([blur(1)]);
      entries.pulse(blurPulse(2, { hold: 1 }));
      entries.pulse(blurPulse(3, { hold: 1 }, { placement: 'below' }));
      entries.pulse(blurPulse(4, { hold: 1 }));

      assert.deepEqual(radii(entries), [3, 1, 2, 4]);
    });

    void test('are composed with the channel they were started in', () => {
      entries.setStack([blur(1)], { channel: 'a' });
      entries.setStack([blur(2)], { channel: 'b' });
      entries.pulse(blurPulse(9, { hold: 1 }), { channel: 'a' });

      assert.deepEqual(radii(entries), [1, 9, 2]);
    });

    void test('run in the stage of the effect, unless they name one', () => {
      entries.pulse({ id: 'shift', settings: { alpha: 1 }, timing: { hold: 1 } } as unknown as PostProcessPulseDescriptor);
      entries.pulse(blurPulse(4, { hold: 1 }, { stage: 'final' }));

      assert.deepEqual(entries.collect('scene'), []);
      assert.deepEqual(entries.collect('final').map((entry) => entry.id), ['shift', 'blur']);
    });

    void test('without any duration are shown for the frame they started in and gone with the next', () => {
      entries.pulse(blurPulse(8, {}));

      assert.deepEqual(radii(entries), [8]);

      entries.advance(0.016);

      assert.deepEqual(radii(entries), []);
    });

    void test('treat a duration that is negative or not a number as zero', () => {
      entries.pulse(blurPulse(8, { fadeIn: -1, hold: Number.NaN, fadeOut: 0.5 }));

      run(0.25);

      assertNear(radii(entries)[0], 4);
    });
  });

  void describe('advance', () => {
    void test('moves time by at most MAX_ADVANCE, so a stall does not skip a fade', () => {
      entries.setStack([blur(8)], { fade: 1 });

      entries.advance(5);

      assertNear(radii(entries)[0], 8 * MAX_ADVANCE);
    });

    void test('does not run time backwards', () => {
      entries.setStack([blur(8)], { fade: 1 });

      entries.advance(-1);

      assert.deepEqual(radii(entries), [0]);
    });
  });
});

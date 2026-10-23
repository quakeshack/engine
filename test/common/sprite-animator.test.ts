import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SpriteAnimator, type SpriteImageBlend } from '../../source/engine/common/model/sprite/SpriteAnimator.ts';
import { SpriteDirection, type SpriteImage, type SpriteSequence } from '../../source/engine/common/model/sprite/SpriteTypes.ts';

/**
 * Builds a sequence of images that are each shown for their own number of seconds.
 * @param durations Seconds per image.
 * @param direction Order of the images.
 * @param repeat Plays, 0 for forever.
 * @returns The sequence.
 */
function createSequence(durations: number[], direction = SpriteDirection.forward, repeat = 0): SpriteSequence {
  const images: SpriteImage[] = durations.map((_duration, layer) => ({ layer, origin: [0, 0], width: 1, height: 1, uvScale: [1, 1] }));
  const endTimes = new Float32Array(durations.length);
  let elapsed = 0;

  for (let index = 0; index < durations.length; index++) {
    elapsed += durations[index];
    endTimes[index] = elapsed;
  }

  return { name: '', images, endTimes, direction, repeat };
}

/**
 * @returns The image indices shown at the middle of each second from 0 to `seconds`.
 */
function sample(sequence: SpriteSequence, seconds: number): number[] {
  const shown: number[] = [];

  for (let second = 0; second < seconds; second++) {
    shown.push(SpriteAnimator.imageIndexAt(sequence, second + 0.5));
  }

  return shown;
}

void describe('SpriteAnimator', () => {
  void describe('forward', () => {
    void test('shows each image for its own time and loops', () => {
      const sequence = createSequence([1, 2, 1]);

      assert.deepEqual(sample(sequence, 8), [0, 1, 1, 2, 0, 1, 1, 2]);
    });

    void test('starts at the first image before the sequence has started', () => {
      assert.equal(SpriteAnimator.imageIndexAt(createSequence([1, 1]), -3), 0);
    });

    void test('holds the last image once the repeats are over', () => {
      const sequence = createSequence([1, 1, 1], SpriteDirection.forward, 2);

      assert.deepEqual(sample(sequence, 8), [0, 1, 2, 0, 1, 2, 2, 2]);
      assert.equal(SpriteAnimator.duration(sequence), 6);
    });

    void test('a single image is always shown', () => {
      assert.equal(SpriteAnimator.imageIndexAt(createSequence([0.1]), 123.4), 0);
    });
  });

  void describe('reverse', () => {
    void test('plays the images backwards with their own durations', () => {
      const sequence = createSequence([1, 2, 1], SpriteDirection.reverse);

      assert.deepEqual(sample(sequence, 8), [2, 1, 1, 0, 2, 1, 1, 0]);
    });

    void test('holds the first image once the repeats are over', () => {
      const sequence = createSequence([1, 1, 1], SpriteDirection.reverse, 1);

      assert.deepEqual(sample(sequence, 5), [2, 1, 0, 0, 0]);
    });
  });

  void describe('pingpong', () => {
    void test('goes to the end and back without repeating the end images', () => {
      const sequence = createSequence([1, 1, 1, 1], SpriteDirection.pingpong);

      assert.equal(SpriteAnimator.cycleDuration(sequence), 6);
      assert.deepEqual(sample(sequence, 12), [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1]);
    });

    void test('works with uneven durations', () => {
      const sequence = createSequence([1, 2, 1], SpriteDirection.pingpong);

      assert.equal(SpriteAnimator.cycleDuration(sequence), 6);
      assert.deepEqual(sample(sequence, 8), [0, 1, 1, 2, 1, 1, 0, 1]);
    });

    void test('two images are just played in turn', () => {
      const sequence = createSequence([1, 1], SpriteDirection.pingpong);

      assert.equal(SpriteAnimator.cycleDuration(sequence), 2);
      assert.deepEqual(sample(sequence, 4), [0, 1, 0, 1]);
    });

    void test('ends where it began after its last repeat', () => {
      const sequence = createSequence([1, 1, 1], SpriteDirection.pingpong, 1);

      assert.deepEqual(sample(sequence, 6), [0, 1, 2, 1, 0, 0]);
      assert.equal(SpriteAnimator.duration(sequence), 4);
    });
  });

  void describe('pingpongReverse', () => {
    void test('starts at the last image', () => {
      const sequence = createSequence([1, 1, 1, 1], SpriteDirection.pingpongReverse);

      assert.deepEqual(sample(sequence, 8), [3, 2, 1, 0, 1, 2, 3, 2]);
    });

    void test('ends on the last image after its last repeat', () => {
      const sequence = createSequence([1, 1, 1], SpriteDirection.pingpongReverse, 1);

      assert.deepEqual(sample(sequence, 6), [2, 1, 0, 1, 2, 2]);
    });
  });

  void describe('duration', () => {
    void test('is infinite for a sequence that repeats forever', () => {
      assert.equal(SpriteAnimator.duration(createSequence([1, 1])), Infinity);
    });

    void test('is the cycle times the repeats', () => {
      assert.equal(SpriteAnimator.duration(createSequence([0.5, 0.25], SpriteDirection.forward, 4)), 3);
    });
  });

  void describe('blendAt', () => {
    /**
     * @returns The image, the next one and how far in the first is at `time`, rounded for comparing.
     */
    function blend(sequence: SpriteSequence, time: number): [number, number, number] {
      const out: SpriteImageBlend = { index: -1, nextIndex: -1, mix: -1 };

      SpriteAnimator.blendAt(sequence, time, out);

      return [out.index, out.nextIndex, Math.round(out.mix * 1000) / 1000];
    }

    void test('fades from an image to the next as its time runs out', () => {
      const sequence = createSequence([1, 2, 1]);

      assert.deepEqual(blend(sequence, 0), [0, 1, 0]);
      assert.deepEqual(blend(sequence, 0.25), [0, 1, 0.25]);
      assert.deepEqual(blend(sequence, 2), [1, 2, 0.5]);
      assert.deepEqual(blend(sequence, 2.5), [1, 2, 0.75]);
    });

    void test('fades from the last image back to the first of a looping sequence', () => {
      const sequence = createSequence([1, 1]);

      assert.deepEqual(blend(sequence, 1.5), [1, 0, 0.5]);
    });

    void test('follows the direction of the sequence', () => {
      assert.deepEqual(blend(createSequence([1, 1, 1], SpriteDirection.reverse), 0.5), [2, 1, 0.5]);
      assert.deepEqual(blend(createSequence([1, 1, 1], SpriteDirection.pingpong), 2.5), [2, 1, 0.5]);
      assert.deepEqual(blend(createSequence([1, 1, 1], SpriteDirection.pingpong), 3.5), [1, 0, 0.5]);
    });

    void test('does not fade while a finished sequence holds its last image', () => {
      const sequence = createSequence([1, 1], SpriteDirection.forward, 1);

      assert.deepEqual(blend(sequence, 5), [1, 1, 0]);
    });

    void test('a single image has nothing to fade to', () => {
      assert.deepEqual(blend(createSequence([0.5]), 3), [0, 0, 0]);
    });

    void test('fades to the image it will hold when the last play ends', () => {
      const sequence = createSequence([1, 1], SpriteDirection.forward, 1);

      assert.deepEqual(blend(sequence, 1.5), [1, 1, 0.5]);
    });
  });
});

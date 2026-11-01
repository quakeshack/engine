import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SpriteAnimator, SpriteSample, type SpriteImageBlend } from '../../source/engine/common/model/sprite/SpriteAnimator.ts';
import { SpriteDirection, type SpriteImage, type SpriteSequence } from '../../source/engine/common/model/sprite/SpriteTypes.ts';

/**
 * Builds a sequence of images that are each shown for their own number of seconds.
 * @param durations Seconds per image.
 * @param direction Order of the images.
 * @param repeat Plays, 0 for forever.
 * @returns The sequence.
 */
function createSequence(durations: number[], direction = SpriteDirection.forward, repeat = 0): SpriteSequence {
  const images: SpriteImage[] = durations.map((_duration, layer) => ({ layer, origin: [0, 0], width: 1, height: 1, pixelWidth: 1, pixelHeight: 1, uvScale: [1, 1] }));
  const endTimes = new Float32Array(durations.length);
  let elapsed = 0;

  for (let index = 0; index < durations.length; index++) {
    elapsed += durations[index];
    endTimes[index] = elapsed;
  }

  return { name: '', images, views: [images], endTimes, direction, repeat };
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

  void describe('viewIndex', () => {
    /**
     * @returns The view of 8 seen by a viewer at `degrees` around an entity that faces +X.
     */
    function viewAt(degrees: number, yaw = 0, count = 8): number {
      const radians = degrees * (Math.PI / 180);

      return SpriteAnimator.viewIndex(count, yaw, Math.cos(radians) * 100, Math.sin(radians) * 100);
    }

    void test('counts counterclockwise from the front, one view per sector', () => {
      assert.deepEqual([0, 45, 90, 135, 180, 225, 270, 315].map((degrees) => viewAt(degrees)), [0, 1, 2, 3, 4, 5, 6, 7]);
    });

    void test('centers each sector on its view', () => {
      assert.equal(viewAt(22), 0);
      assert.equal(viewAt(-22), 0);
      assert.equal(viewAt(67), 1);
      assert.equal(viewAt(-23), 7);
    });

    void test('gives the edge between two sectors to the later view, as Doom does', () => {
      // Doom's (angle + 22.5 degrees) >> 29 is a floor: 22.5 degrees is already rotation 2 (view 1)
      assert.equal(SpriteAnimator.viewIndex(8, 0, Math.cos(Math.PI / 8), Math.sin(Math.PI / 8)), 1);
    });

    void test('is measured against the entity\'s yaw, whatever its range', () => {
      assert.equal(viewAt(90, 90), 0, 'facing the viewer');
      assert.equal(viewAt(0, 180), 4, 'facing away');
      assert.equal(viewAt(0, 720 + 90), 6);
      assert.equal(viewAt(0, -90), 2);
    });

    void test('works for any number of views', () => {
      assert.deepEqual([0, 22.5, 90, 180, 337.5].map((degrees) => viewAt(degrees, 0, 16)), [0, 1, 4, 8, 15]);
      assert.deepEqual([0, 90, 180, 270].map((degrees) => viewAt(degrees, 0, 4)), [0, 1, 2, 3]);
    });

    void test('a single view is always the front', () => {
      assert.equal(viewAt(180, 0, 1), 0);
    });
  });

  void describe('sample', () => {
    /**
     * @returns A sequence of two steps in two views, the second view on layers 10 and 11.
     */
    function createRotatedSequence(): SpriteSequence {
      const front = createSequence([1, 1]);
      const side = front.images.map((image) => ({ ...image, layer: image.layer + 10 }));

      return { ...front, views: [front.images, side] };
    }

    void test('shows the image of the step that is playing in the view it is given', () => {
      const out = new SpriteSample();

      SpriteAnimator.sample(createRotatedSequence(), 1.5, false, out, 1);

      assert.equal(out.image.layer, 11);
    });

    void test('shows the front without a view', () => {
      const out = new SpriteSample();

      SpriteAnimator.sample(createRotatedSequence(), 1.5, false, out);

      assert.equal(out.image.layer, 1);
    });

    void test('fades only within the view, never into another one', () => {
      const out = new SpriteSample();

      SpriteAnimator.sample(createRotatedSequence(), 0.5, true, out, 1);

      assert.deepEqual([out.image.layer, out.nextLayer, out.fade], [10, 11, 0.5]);
    });
  });
});

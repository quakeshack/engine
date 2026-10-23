import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SpriteSample } from '../../source/engine/common/model/sprite/SpriteAnimator.ts';
import { SpriteAsset } from '../../source/engine/common/model/sprite/SpriteAsset.ts';
import { SpriteDirection, type SpriteFrame, type SpriteImage, type SpriteSequence } from '../../source/engine/common/model/sprite/SpriteTypes.ts';
import { SpritePlayback } from '../../source/engine/client/renderer/sprite/SpritePlayback.ts';

/**
 * @returns An image of 4x2 pixels at twice the size in world units, on the given layer.
 */
function image(layer: number): SpriteImage {
  return { layer, origin: [0, 0], width: 8, height: 4, pixelWidth: 4, pixelHeight: 2, uvScale: [1, 1] };
}

/**
 * @returns A sequence of `count` images that each take a second.
 */
function sequence(name: string, count: number, repeat: number, direction = SpriteDirection.forward): SpriteSequence {
  return {
    name,
    images: Array.from({ length: count }, (_value, layer) => image(layer)),
    endTimes: Float32Array.from({ length: count }, (_value, index) => index + 1),
    direction,
    repeat,
  };
}

/**
 * @returns A clock a test sets by hand, and a playback over an asset on it.
 */
function createPlayback(frames: readonly SpriteFrame[]): { clock: { now: number }, playback: SpritePlayback } {
  const clock = { now: 10 };

  return { clock, playback: new SpritePlayback(new SpriteAsset({ frames }), () => clock.now) };
}

/**
 * @returns The layer the playback shows now.
 */
function layerOf(playback: SpritePlayback): number {
  const sample = new SpriteSample();

  playback.sample(false, sample);

  return sample.image.layer;
}

void describe('SpritePlayback', () => {
  void test('starts on the first image of the first sequence, whatever the clock says', () => {
    const { playback } = createPlayback([sequence('idle', 3, 0)]);

    assert.equal(playback.sequence, 0);
    assert.equal(layerOf(playback), 0);
  });

  void test('follows its clock from the moment it was made', () => {
    const { clock, playback } = createPlayback([sequence('idle', 3, 0)]);

    clock.now += 1.5;
    assert.equal(layerOf(playback), 1);
    clock.now += 1;
    assert.equal(layerOf(playback), 2);
    clock.now += 1;
    assert.equal(layerOf(playback), 0, 'a sequence that repeats forever starts over');
  });

  void test('two playbacks of one asset play independently', () => {
    const asset = new SpriteAsset({ frames: [sequence('idle', 3, 0)] });
    const clock = { now: 0 };
    const first = new SpritePlayback(asset, () => clock.now);

    clock.now = 1;

    const second = new SpritePlayback(asset, () => clock.now);

    clock.now = 2;
    assert.equal(layerOf(first), 2);
    assert.equal(layerOf(second), 1);
  });

  void describe('play', () => {
    void test('starts a sequence by index from its first image', () => {
      const { clock, playback } = createPlayback([sequence('idle', 3, 0), sequence('burst', 2, 1)]);

      clock.now += 2.5;
      playback.play(1);

      assert.equal(playback.sequence, 1);
      assert.equal(layerOf(playback), 0);

      clock.now += 1;
      assert.equal(layerOf(playback), 1);
    });

    void test('starts a sequence by name', () => {
      const { playback } = createPlayback([sequence('idle', 3, 0), sequence('burst', 2, 1)]);

      playback.play('burst');

      assert.equal(playback.sequence, 1);
    });

    void test('restarts the sequence that is already showing', () => {
      const { clock, playback } = createPlayback([sequence('idle', 3, 0)]);

      clock.now += 2.5;
      playback.play('idle');

      assert.equal(layerOf(playback), 0);
    });

    void test('throws for a name or an index the file does not have', () => {
      const { playback } = createPlayback([sequence('idle', 3, 0)]);

      assert.throws(() => { playback.play('missing'); }, RangeError);
      assert.throws(() => { playback.play(''); }, RangeError);
      assert.throws(() => { playback.play(1); }, RangeError);
      assert.throws(() => { playback.play(-1); }, RangeError);
      assert.throws(() => { playback.play(0.5); }, RangeError);
      assert.equal(playback.sequence, 0);
    });

    void test('a paused playback stays paused on the first image', () => {
      const { clock, playback } = createPlayback([sequence('idle', 3, 0), sequence('burst', 2, 1)]);

      playback.pause();
      playback.play('burst');
      clock.now += 5;

      assert.equal(playback.paused, true);
      assert.equal(layerOf(playback), 0);
    });
  });

  void describe('pause and resume', () => {
    void test('hold the image and continue from it', () => {
      const { clock, playback } = createPlayback([sequence('idle', 4, 0)]);

      clock.now += 1.5;
      playback.pause();
      clock.now += 100;

      assert.equal(layerOf(playback), 1);

      playback.resume();
      assert.equal(playback.paused, false);
      assert.equal(layerOf(playback), 1);

      clock.now += 1;
      assert.equal(layerOf(playback), 2, 'the half second that was left of the image plays, then the next');
    });

    void test('pausing twice or resuming a running playback changes nothing', () => {
      const { clock, playback } = createPlayback([sequence('idle', 4, 0)]);

      playback.resume();
      clock.now += 1.5;
      playback.pause();
      clock.now += 1;
      playback.pause();
      clock.now += 1;

      assert.equal(layerOf(playback), 1);
    });
  });

  void describe('speed', () => {
    void test('plays faster or slower', () => {
      const { clock, playback } = createPlayback([sequence('idle', 4, 0)]);

      playback.speed = 2;
      clock.now += 1;
      assert.equal(layerOf(playback), 2);

      playback.speed = 0.5;
      clock.now += 2;
      assert.equal(layerOf(playback), 3, 'two seconds at half speed is one second of the file');
    });

    void test('changing it keeps what has played', () => {
      const { clock, playback } = createPlayback([sequence('idle', 4, 0)]);

      clock.now += 2.5;
      playback.speed = 4;

      assert.equal(layerOf(playback), 2);
    });

    void test('has to be a positive number', () => {
      const { playback } = createPlayback([sequence('idle', 4, 0)]);

      for (const value of [0, -1, Number.NaN, Infinity]) {
        assert.throws(() => { playback.speed = value; }, RangeError, String(value));
      }

      assert.equal(playback.speed, 1);
    });
  });

  void describe('duration and finished', () => {
    void test('a sequence that plays once finishes and holds its last image', () => {
      const { clock, playback } = createPlayback([sequence('burst', 3, 1)]);

      assert.equal(playback.duration, 3);
      assert.equal(playback.finished, false);

      clock.now += 2.9;
      assert.equal(playback.finished, false);

      clock.now += 0.2;
      assert.equal(playback.finished, true);
      assert.equal(layerOf(playback), 2);

      clock.now += 100;
      assert.equal(layerOf(playback), 2);
    });

    void test('counts repeats and the ping-pong direction', () => {
      const { playback } = createPlayback([sequence('loop', 3, 2), sequence('bounce', 3, 1, SpriteDirection.pingpong)]);

      assert.equal(playback.duration, 6);

      playback.play('bounce');

      assert.equal(playback.duration, 4, 'forward over three images and back over the middle one');
    });

    void test('a sequence that repeats forever never finishes', () => {
      const { clock, playback } = createPlayback([sequence('idle', 3, 0)]);

      clock.now += 1000;

      assert.equal(playback.duration, Infinity);
      assert.equal(playback.finished, false);
    });

    void test('the speed counts for the duration of the clock, not for the file', () => {
      const { clock, playback } = createPlayback([sequence('burst', 4, 1)]);

      playback.speed = 2;
      assert.equal(playback.duration, 2);

      clock.now += 2;
      assert.equal(playback.finished, true);
    });

    void test('a single picture has nothing to play and is finished', () => {
      const { playback } = createPlayback([image(0)]);

      assert.equal(playback.duration, 0);
      assert.equal(playback.finished, true);
    });

    void test('a paused playback does not finish', () => {
      const { clock, playback } = createPlayback([sequence('burst', 3, 1)]);

      clock.now += 1;
      playback.pause();
      clock.now += 100;

      assert.equal(playback.finished, false);
    });
  });

  void describe('a clock that starts over', () => {
    void test('restarts the sequence from its first image', () => {
      const { clock, playback } = createPlayback([sequence('idle', 4, 0)]);

      clock.now += 3.5;
      assert.equal(layerOf(playback), 3);

      // a new connection: client time begins at zero again
      clock.now = 0.5;
      assert.equal(layerOf(playback), 0);

      clock.now = 1.5;
      assert.equal(layerOf(playback), 1);
    });
  });

  void describe('size', () => {
    void test('is the size of the image that is showing, in world units', () => {
      const { playback } = createPlayback([sequence('idle', 2, 0), image(0)]);

      assert.equal(playback.width, 8);
      assert.equal(playback.height, 4);

      playback.play(1);

      assert.equal(playback.width, 8);
    });
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { ApngBlend, ApngDispose, ApngSpriteDecoder } from '../../source/engine/client/renderer/sprite/ApngSpriteDecoder.ts';
import { CorruptedResourceError } from '../../source/engine/common/Errors.ts';
import { ImageFormat, ImageHeaders } from '../../source/engine/common/model/sprite/ImageHeader.ts';
import { decodeStillPng, encodeApng, type TestApngFrame } from '../support/spriteImages.ts';

/**
 * @returns A fixture of `test/fixtures/sprites/` as an ArrayBuffer.
 */
function readFixture(name: string): ArrayBuffer {
  const bytes = readFileSync(new URL(`../fixtures/sprites/${name}`, import.meta.url));

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * @returns The pixel of a decoded frame as `[r, g, b, a]`.
 */
function pixel(frame: Uint8Array, width: number, x: number, y: number): number[] {
  return [...frame.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
}

/**
 * @returns A frame of one color.
 */
function solid(width: number, height: number, color: number[], extra: Partial<TestApngFrame> = {}): TestApngFrame {
  return { width, height, rgba: Array.from({ length: width * height }, () => color).flat(), ...extra };
}

/**
 * Decodes an APNG built from frames the way the browser path does, with the Node PNG decoder standing in.
 * @returns The snapshots of every frame.
 */
async function decode(file: ArrayBuffer, name = 'test.apng'): Promise<Uint8Array[]> {
  const header = ImageHeaders.parse(file, name);
  const decoded = await new ApngSpriteDecoder(decodeStillPng).decode(file, ImageFormat.png, header, name);

  return [...decoded.frames];
}

void describe('ApngSpriteDecoder', () => {
  void test('takes animated PNG only', () => {
    const decoder = new ApngSpriteDecoder(decodeStillPng);
    const animated = ImageHeaders.parse(readFixture('anim.apng'), 'anim.apng');
    const still = ImageHeaders.parse(readFixture('static.png'), 'static.png');

    assert.equal(decoder.canDecode(ImageFormat.png, animated), true);
    assert.equal(decoder.canDecode(ImageFormat.png, still), false);
    assert.equal(decoder.canDecode(ImageFormat.gif, animated), false);
  });

  void describe('splitting', () => {
    void test('takes the default image as the first frame when its frame control comes first', () => {
      const file = ApngSpriteDecoder.split(readFixture('anim.apng'), 'anim.apng');

      assert.equal(file.frames.length, 3);
      assert.deepEqual([file.width, file.height], [8, 4]);
      assert.ok(file.frames.every((frame) => frame.data.length > 0));
    });

    void test('leaves out a default image that is not part of the animation', () => {
      const file = ApngSpriteDecoder.split(readFixture('anim-hidden-default.apng'), 'anim-hidden-default.apng');

      assert.equal(file.frames.length, 2);
    });

    void test('rebuilds a frame as a PNG file of its own that a PNG decoder reads', async () => {
      const file = ApngSpriteDecoder.split(readFixture('anim.apng'), 'anim.apng');
      const still = await decodeStillPng(ApngSpriteDecoder.buildStandalonePng(file, file.frames[1]));

      assert.equal(still.width, file.frames[1].width);
      assert.equal(still.height, file.frames[1].height);
      assert.equal(still.rgba.length, still.width * still.height * 4);
    });

    void test('rejects a file with no frames', () => {
      assert.throws(() => ApngSpriteDecoder.split(readFixture('static.png'), 'static.png'), CorruptedResourceError);
    });
  });

  void describe('a file written by Pillow', () => {
    void test('decodes the frames with the default image as the first one', async () => {
      const frames = await decode(readFixture('anim.apng'));

      assert.equal(frames.length, 3);

      for (let index = 0; index < 3; index++) {
        const bar = [255 - 60 * index, 40 * index, 90 + 40 * index, 255];

        assert.deepEqual(pixel(frames[index], 8, index + 1, 1), bar, `frame ${index}`);
        assert.deepEqual(pixel(frames[index], 8, 7, 3), [0, 0, 0, 0], `frame ${index}`);
      }
    });

    void test('decodes a file whose default image is only a fallback', async () => {
      const frames = await decode(readFixture('anim-hidden-default.apng'));

      assert.equal(frames.length, 2);
      assert.deepEqual(pixel(frames[0], 8, 2, 1), [195, 40, 130, 255]);
    });
  });

  void describe('compositing', () => {
    const RED = [255, 0, 0, 255];
    const GREEN = [0, 255, 0, 255];
    const BLUE = [0, 0, 255, 255];

    void test('copies a frame over a transparent canvas, in its place', async () => {
      const frames = await decode(encodeApng({ width: 4, height: 2, defaultImageIsFrame: true, frames: [solid(2, 1, RED, { x: 1, y: 1 })] }));

      assert.deepEqual(pixel(frames[0], 4, 1, 1), RED);
      assert.deepEqual(pixel(frames[0], 4, 2, 1), RED);
      assert.deepEqual(pixel(frames[0], 4, 0, 1), [0, 0, 0, 0]);
      assert.deepEqual(pixel(frames[0], 4, 1, 0), [0, 0, 0, 0]);
    });

    void test('blend over lets what is behind a half transparent pixel show through, premultiplied', async () => {
      const frames = await decode(encodeApng({
        width: 1,
        height: 1,
        defaultImageIsFrame: true,
        frames: [solid(1, 1, BLUE), solid(1, 1, [255, 0, 0, 128], { blend: ApngBlend.over })],
      }));

      // red at 128/255 over opaque blue: color red * 128/255 + blue * 127/255
      assert.deepEqual(pixel(frames[1], 1, 0, 0), [128, 0, 127, 255]);
    });

    void test('blend over a transparent pixel leaves the canvas as it is', async () => {
      const frames = await decode(encodeApng({
        width: 1,
        height: 1,
        defaultImageIsFrame: true,
        frames: [solid(1, 1, BLUE), solid(1, 1, [255, 0, 0, 0], { blend: ApngBlend.over })],
      }));

      assert.deepEqual(pixel(frames[1], 1, 0, 0), BLUE);
    });

    void test('blend source replaces the canvas, also with transparency', async () => {
      const frames = await decode(encodeApng({
        width: 1,
        height: 1,
        defaultImageIsFrame: true,
        frames: [solid(1, 1, BLUE), solid(1, 1, [255, 0, 0, 128], { blend: ApngBlend.source })],
      }));

      assert.deepEqual(pixel(frames[1], 1, 0, 0), [128, 0, 0, 128]);
    });

    void test('keeps the premultiplied color of a half transparent frame', async () => {
      const frames = await decode(encodeApng({ width: 1, height: 1, defaultImageIsFrame: true, frames: [solid(1, 1, [200, 100, 50, 51])] }));

      assert.deepEqual(pixel(frames[0], 1, 0, 0), [40, 20, 10, 51]);
    });

    void test('dispose none keeps a frame on the canvas', async () => {
      const frames = await decode(encodeApng({
        width: 2,
        height: 1,
        defaultImageIsFrame: true,
        frames: [solid(1, 1, RED, { dispose: ApngDispose.none }), solid(1, 1, GREEN, { x: 1 })],
      }));

      assert.deepEqual(pixel(frames[1], 2, 0, 0), RED);
      assert.deepEqual(pixel(frames[1], 2, 1, 0), GREEN);
    });

    void test('dispose background clears the frame\'s rectangle before the next one', async () => {
      const frames = await decode(encodeApng({
        width: 2,
        height: 1,
        defaultImageIsFrame: true,
        frames: [solid(1, 1, RED, { dispose: ApngDispose.background }), solid(1, 1, GREEN, { x: 1 })],
      }));

      assert.deepEqual(pixel(frames[0], 2, 0, 0), RED);
      assert.deepEqual(pixel(frames[1], 2, 0, 0), [0, 0, 0, 0]);
      assert.deepEqual(pixel(frames[1], 2, 1, 0), GREEN);
    });

    void test('dispose previous puts back what was there before the frame', async () => {
      const frames = await decode(encodeApng({
        width: 2,
        height: 1,
        defaultImageIsFrame: true,
        frames: [
          solid(2, 1, BLUE),
          solid(1, 1, RED, { dispose: ApngDispose.previous }),
          solid(1, 1, GREEN, { x: 1 }),
        ],
      }));

      assert.deepEqual(pixel(frames[1], 2, 0, 0), RED);
      assert.deepEqual(pixel(frames[2], 2, 0, 0), BLUE, 'the red frame is gone');
      assert.deepEqual(pixel(frames[2], 2, 1, 0), GREEN);
    });

    void test('dispose previous on the first frame acts as dispose background', async () => {
      const frames = await decode(encodeApng({
        width: 2,
        height: 1,
        defaultImageIsFrame: true,
        frames: [solid(1, 1, RED, { dispose: ApngDispose.previous }), solid(1, 1, GREEN, { x: 1 })],
      }));

      assert.deepEqual(pixel(frames[1], 2, 0, 0), [0, 0, 0, 0]);
    });

    void test('decodes a file whose default image is a hidden fallback', async () => {
      const frames = await decode(encodeApng({
        width: 2,
        height: 1,
        defaultImageIsFrame: false,
        frames: [solid(1, 1, RED), solid(1, 1, GREEN, { x: 1 })],
      }));

      assert.equal(frames.length, 2);
      assert.deepEqual(pixel(frames[0], 2, 0, 0), RED);
    });
  });

  void test('rejects a frame whose decoded size is not the one the file says', async () => {
    const file = encodeApng({ width: 2, height: 2, defaultImageIsFrame: true, frames: [solid(2, 2, [1, 2, 3, 255]), solid(2, 2, [1, 2, 3, 255])] });
    const wrongSize = new ApngSpriteDecoder((png) => decodeStillPng(png).then((still) => ({ ...still, width: 1 })));

    await assert.rejects(wrongSize.decode(file, ImageFormat.png, ImageHeaders.parse(file, 'a.apng'), 'a.apng'), CorruptedResourceError);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { GifSpriteDecoder } from '../../source/engine/client/renderer/sprite/GifSpriteDecoder.ts';
import { CorruptedResourceError } from '../../source/engine/common/Errors.ts';
import { ImageFormat, ImageHeaders } from '../../source/engine/common/model/sprite/ImageHeader.ts';
import { encodeGif } from '../support/spriteImages.ts';

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const PALETTE = [...RED, ...GREEN, ...BLUE, ...WHITE];

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

void describe('GifSpriteDecoder', () => {
  void test('takes GIF only', () => {
    const decoder = new GifSpriteDecoder();
    const header = ImageHeaders.parse(readFixture('anim.gif'), 'anim.gif');

    assert.equal(decoder.canDecode(ImageFormat.gif, header), true);
    assert.equal(decoder.canDecode(ImageFormat.png, header), false);
    assert.equal(decoder.canDecode(ImageFormat.webp, header), false);
  });

  void describe('a file written by Pillow', () => {
    void test('decodes every frame onto the full canvas, restoring the background between them', () => {
      const decoded = GifSpriteDecoder.decodeFrames(readFixture('anim.gif'), 'anim.gif');

      assert.equal(decoded.width, 8);
      assert.equal(decoded.height, 4);
      assert.equal(decoded.frames.length, 3);

      // frame i is a bar of four columns starting at column i, colored (255 - 60i, 40i, 90 + 40i), seen with Pillow
      for (let index = 0; index < 3; index++) {
        const color = [255 - 60 * index, 40 * index, 90 + 40 * index, 255];

        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 8; x++) {
            const inside = x >= index && x < index + 4;

            assert.deepEqual(pixel(decoded.frames[index], 8, x, y), inside ? color : [0, 0, 0, 0], `frame ${index} at ${x},${y}`);
          }
        }
      }
    });

    void test('decodes an interlaced image to the same pixels as the progressive one', () => {
      const interlaced = GifSpriteDecoder.decodeFrames(readFixture('interlaced.gif'), 'interlaced.gif');
      const progressive = GifSpriteDecoder.decodeFrames(readFixture('progressive.gif'), 'progressive.gif');

      assert.equal(interlaced.width, 5);
      assert.equal(interlaced.height, 20);
      assert.deepEqual(interlaced.frames[0], progressive.frames[0]);
      // the gradient runs from red at the top to blue at the bottom
      assert.ok(pixel(interlaced.frames[0], 5, 2, 0)[0] > pixel(interlaced.frames[0], 5, 2, 19)[0]);
      assert.ok(pixel(interlaced.frames[0], 5, 2, 0)[2] < pixel(interlaced.frames[0], 5, 2, 19)[2]);
    });
  });

  void describe('transparency and disposal', () => {
    /**
     * Frame 0 fills the 4x2 canvas with red. Frame 1 draws a 2x1 green piece at (1, 0) with a transparent index
     * of 3 (white) in its second pixel. Frame 2 is blue, 1x1 at (3, 1).
     * @param disposalOfFrame1 The disposal method of the green piece.
     * @returns The decoded frames.
     */
    function decodeWithDisposal(disposalOfFrame1: number): readonly Uint8Array[] {
      return GifSpriteDecoder.decodeFrames(encodeGif({
        width: 4,
        height: 2,
        palette: PALETTE,
        frames: [
          { width: 4, height: 2, indices: [0, 0, 0, 0, 0, 0, 0, 0] },
          { left: 1, width: 2, height: 1, indices: [1, 3], disposal: disposalOfFrame1, transparentIndex: 3 },
          { left: 3, top: 1, width: 1, height: 1, indices: [2] },
        ],
      }), 'synthetic.gif').frames;
    }

    void test('draws a frame over the previous canvas and leaves transparent pixels alone', () => {
      const frames = decodeWithDisposal(1);

      assert.deepEqual(pixel(frames[0], 4, 1, 0), [255, 0, 0, 255]);
      assert.deepEqual(pixel(frames[1], 4, 1, 0), [0, 255, 0, 255]);
      assert.deepEqual(pixel(frames[1], 4, 2, 0), [255, 0, 0, 255], 'the transparent pixel shows what was there');
    });

    void test('disposal 1 and 0 leave the frame on the canvas', () => {
      for (const disposal of [0, 1]) {
        const frames = decodeWithDisposal(disposal);

        assert.deepEqual(pixel(frames[2], 4, 1, 0), [0, 255, 0, 255], `disposal ${disposal}`);
        assert.deepEqual(pixel(frames[2], 4, 3, 1), [0, 0, 255, 255]);
      }
    });

    void test('disposal 2 clears the frame\'s rectangle to transparent', () => {
      const frames = decodeWithDisposal(2);

      assert.deepEqual(pixel(frames[2], 4, 1, 0), [0, 0, 0, 0]);
      assert.deepEqual(pixel(frames[2], 4, 2, 0), [0, 0, 0, 0]);
      assert.deepEqual(pixel(frames[2], 4, 0, 0), [255, 0, 0, 255], 'outside the rectangle nothing changes');
    });

    void test('disposal 3 puts back what was there before the frame', () => {
      const frames = decodeWithDisposal(3);

      assert.deepEqual(pixel(frames[2], 4, 1, 0), [255, 0, 0, 255]);
      assert.deepEqual(pixel(frames[2], 4, 2, 0), [255, 0, 0, 255]);
    });

    void test('a frame returns a copy, later frames do not change an earlier one', () => {
      const frames = decodeWithDisposal(1);

      assert.deepEqual(pixel(frames[0], 4, 1, 0), [255, 0, 0, 255]);
      assert.notEqual(frames[0], frames[1]);
    });
  });

  void describe('what the encoder cannot hide', () => {
    void test('uses the color table of the frame when it has one', () => {
      const frames = GifSpriteDecoder.decodeFrames(encodeGif({
        width: 2,
        height: 1,
        palette: PALETTE,
        frames: [
          { width: 2, height: 1, indices: [0, 1] },
          { width: 2, height: 1, indices: [0, 1], palette: [...BLUE, ...WHITE] },
        ],
      }), 'local.gif').frames;

      assert.deepEqual(pixel(frames[0], 2, 0, 0), [255, 0, 0, 255]);
      assert.deepEqual(pixel(frames[1], 2, 0, 0), [0, 0, 255, 255]);
      assert.deepEqual(pixel(frames[1], 2, 1, 0), [255, 255, 255, 255]);
    });

    void test('puts the rows of an interlaced frame where they belong', () => {
      const rows = 11;
      const indices = Array.from({ length: rows * 2 }, (_value, index) => Math.floor(index / 2) % 4);
      const plain = GifSpriteDecoder.decodeFrames(encodeGif({ width: 2, height: rows, palette: PALETTE, frames: [{ width: 2, height: rows, indices }] }), 'plain.gif');
      const interlaced = GifSpriteDecoder.decodeFrames(encodeGif({ width: 2, height: rows, palette: PALETTE, frames: [{ width: 2, height: rows, indices, interlaced: true }] }), 'interlaced.gif');

      assert.deepEqual(interlaced.frames[0], plain.frames[0]);

      for (let row = 0; row < rows; row++) {
        assert.deepEqual(pixel(plain.frames[0], 2, 0, row).slice(0, 3), PALETTE.slice((row % 4) * 3, (row % 4) * 3 + 3));
      }
    });

    void test('decodes data that makes the LZW codes grow to 12 bits and reset the dictionary', () => {
      const size = 96;
      const palette = Array.from({ length: 256 }, (_value, index) => [index, 255 - index, (index * 7) % 256]).flat();
      let seed = 12345;
      const indices = Array.from({ length: size * size }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed >> 16) & 0xff;
      });

      const decoded = GifSpriteDecoder.decodeFrames(encodeGif({ width: size, height: size, palette, frames: [{ width: size, height: size, indices }] }), 'noise.gif');

      for (let index = 0; index < indices.length; index++) {
        const expected = [indices[index], 255 - indices[index], (indices[index] * 7) % 256, 255];

        if (pixel(decoded.frames[0], size, index % size, Math.floor(index / size)).some((value, channel) => value !== expected[channel])) {
          assert.fail(`pixel ${index} differs`);
        }
      }
    });

    void test('decodes long runs, which make the dictionary refer to its newest entry', () => {
      const indices = new Array<number>(500).fill(2);
      const decoded = GifSpriteDecoder.decodeFrames(encodeGif({ width: 25, height: 20, palette: PALETTE, frames: [{ width: 25, height: 20, indices }] }), 'run.gif');

      assert.ok(decoded.frames[0].every((value, index) => value === [0, 0, 255, 255][index % 4]));
    });

    void test('clips a frame that reaches over the edge of the canvas', () => {
      const decoded = GifSpriteDecoder.decodeFrames(encodeGif({
        width: 2, height: 2, palette: PALETTE, frames: [{ left: 1, top: 1, width: 3, height: 3, indices: new Array<number>(9).fill(1) }],
      }), 'clip.gif');

      assert.deepEqual(pixel(decoded.frames[0], 2, 1, 1), [0, 255, 0, 255]);
      assert.deepEqual(pixel(decoded.frames[0], 2, 0, 0), [0, 0, 0, 0]);
    });
  });

  void describe('broken files', () => {
    void test('rejects a file without images', () => {
      const file = new Uint8Array(encodeGif({ width: 1, height: 1, palette: PALETTE, frames: [] }));

      assert.throws(() => GifSpriteDecoder.decodeFrames(file.buffer, 'empty.gif'), CorruptedResourceError);
    });

    void test('rejects an unknown block', () => {
      const file = new Uint8Array(encodeGif({ width: 1, height: 1, palette: PALETTE, frames: [{ width: 1, height: 1, indices: [0] }] }));
      file[file.length - 1] = 0x99;

      assert.throws(() => GifSpriteDecoder.decodeFrames(file.buffer, 'unknown.gif'), CorruptedResourceError);
    });

    void test('rejects an image without any color table', () => {
      const file = new Uint8Array(encodeGif({ width: 1, height: 1, palette: PALETTE, frames: [{ width: 1, height: 1, indices: [0] }] }));
      file[10] &= 0x7f; // no global color table; the table's bytes are then read as blocks

      assert.throws(() => GifSpriteDecoder.decodeFrames(file.buffer, 'notable.gif'), CorruptedResourceError);
    });
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AsepriteSpriteDecoder } from '../../source/engine/client/renderer/sprite/AsepriteSpriteDecoder.ts';
import { CorruptedResourceError } from '../../source/engine/common/Errors.ts';
import { ImageFormat, ImageHeaders } from '../../source/engine/common/model/sprite/ImageHeader.ts';
import { encodeAseprite, type TestAseprite } from '../support/aseprite.ts';

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

/**
 * Decodes a file the way the engine does.
 * @returns The frames and what the decoder reported.
 */
async function decode(file: TestAseprite): Promise<{ frames: Uint8Array[], warnings: string[], width: number, height: number }> {
  const warnings: string[] = [];
  const buffer = encodeAseprite(file);
  const decoded = await new AsepriteSpriteDecoder((text) => { warnings.push(text.trim()); }).decode(buffer, ImageFormat.aseprite, ImageHeaders.parse(buffer, 'a.aseprite'), 'a.aseprite');

  return { frames: [...decoded.frames], warnings, width: decoded.width, height: decoded.height };
}

/**
 * @returns The pixel of a decoded frame as `[r, g, b, a]`.
 */
function pixel(frame: Uint8Array, width: number, x: number, y: number): number[] {
  return [...frame.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
}

/**
 * @returns A cel of the given size filled with one color.
 */
function solid(layer: number, width: number, height: number, color: readonly number[], extra: object = {}): TestAseprite['frames'][number]['cels'] extends readonly (infer T)[] | undefined ? T : never {
  return { layer, width, height, pixels: Array.from({ length: width * height }, () => color).flat(), ...extra };
}

void describe('AsepriteSpriteDecoder', () => {
  void test('takes Aseprite files only', () => {
    const decoder = new AsepriteSpriteDecoder();
    const header = ImageHeaders.parse(encodeAseprite({ width: 1, height: 1, frames: [{}] }), 'a.aseprite');

    assert.equal(decoder.canDecode(ImageFormat.aseprite, header), true);
    assert.equal(decoder.canDecode(ImageFormat.gif, header), false);
  });

  void describe('true color', () => {
    void test('puts a cel where it says, on a transparent canvas, and clips what hangs over the edge', async () => {
      const { frames, width } = await decode({ width: 3, height: 2, frames: [{ cels: [solid(0, 2, 2, RED, { x: 2, y: 1 })] }] });

      assert.deepEqual(pixel(frames[0], width, 2, 1), RED);
      assert.deepEqual(pixel(frames[0], width, 0, 0), CLEAR);
      assert.deepEqual(pixel(frames[0], width, 2, 0), CLEAR);
    });

    void test('a cel at a negative position shows its part inside the canvas', async () => {
      const { frames, width } = await decode({ width: 2, height: 1, frames: [{ cels: [solid(0, 3, 1, GREEN, { x: -2 })] }] });

      assert.deepEqual(pixel(frames[0], width, 0, 0), GREEN);
      assert.deepEqual(pixel(frames[0], width, 1, 0), CLEAR);
    });

    void test('reads raw and compressed cels alike', async () => {
      const { frames, width } = await decode({ width: 2, height: 1, layers: [{ name: 'a' }, { name: 'b' }], frames: [{ cels: [solid(0, 1, 1, RED, { kind: 'raw' }), solid(1, 1, 1, BLUE, { kind: 'compressed', x: 1 })] }] });

      assert.deepEqual(pixel(frames[0], width, 0, 0), RED);
      assert.deepEqual(pixel(frames[0], width, 1, 0), BLUE);
    });

    void test('layers further up cover those below', async () => {
      const { frames, width } = await decode({ width: 1, height: 1, layers: [{ name: 'below' }, { name: 'above' }], frames: [{ cels: [solid(1, 1, 1, GREEN), solid(0, 1, 1, RED)] }] });

      assert.deepEqual(pixel(frames[0], width, 0, 0), GREEN);
    });

    void test('returns premultiplied color: half transparent red', async () => {
      const { frames, width } = await decode({ width: 1, height: 1, frames: [{ cels: [solid(0, 1, 1, [255, 0, 0, 128])] }] });

      assert.deepEqual(pixel(frames[0], width, 0, 0), [128, 0, 0, 128]);
    });

    void test('blends a half transparent cel over what is below: red at 50% over blue', async () => {
      const { frames, width } = await decode({ width: 1, height: 1, layers: [{ name: 'below' }, { name: 'above' }], frames: [{ cels: [solid(0, 1, 1, BLUE), solid(1, 1, 1, RED, { opacity: 128 })] }] });

      assert.deepEqual(pixel(frames[0], width, 0, 0), [128, 0, 127, 255]);
    });

    void test('the opacity of a layer counts only when the header says it is valid', async () => {
      const layers = [{ name: 'below' }, { name: 'above', opacity: 0 }];
      const cels = [solid(0, 1, 1, BLUE), solid(1, 1, 1, RED)];
      const ignored = await decode({ width: 1, height: 1, layers, frames: [{ cels }] });
      const valid = await decode({ width: 1, height: 1, layers, flags: 1, frames: [{ cels }] });

      assert.deepEqual(pixel(ignored.frames[0], 1, 0, 0), RED);
      assert.deepEqual(pixel(valid.frames[0], 1, 0, 0), BLUE);
    });

    void test('draws each frame on a fresh canvas', async () => {
      const { frames, width } = await decode({ width: 2, height: 1, frames: [{ cels: [solid(0, 1, 1, RED)] }, { cels: [solid(0, 1, 1, GREEN, { x: 1 })] }, {}] });

      assert.deepEqual(pixel(frames[1], width, 0, 0), CLEAR);
      assert.deepEqual(pixel(frames[1], width, 1, 0), GREEN);
      assert.deepEqual([...frames[2]], [...new Array<number>(8).fill(0)], 'a frame without cels is empty');
    });
  });

  void describe('draw order', () => {
    void test('a z-index moves a cel up or down the layers', async () => {
      const layers = [{ name: 'low' }, { name: 'middle' }, { name: 'high' }];
      const { frames } = await decode({
        width: 2,
        height: 1,
        layers,
        frames: [{ cels: [solid(0, 1, 1, RED, { zIndex: 2 }), solid(1, 1, 1, GREEN), solid(2, 1, 1, BLUE)] }, { cels: [solid(0, 1, 1, RED), solid(1, 1, 1, GREEN), solid(2, 1, 1, BLUE, { zIndex: -2 })] }],
      });

      assert.deepEqual(pixel(frames[0], 2, 0, 0), RED, 'the lowest layer moved two up is now on top');
      assert.deepEqual(pixel(frames[1], 2, 0, 0), GREEN, 'the highest layer moved two down is below');
    });

    void test('cels that end up in the same place are ordered by their z-index', async () => {
      // layer 0 + z 1 and layer 1 + z 0 both land on 1; the one with the lower z-index goes first
      const { frames } = await decode({
        width: 1,
        height: 1,
        layers: [{ name: 'a' }, { name: 'b' }],
        frames: [{ cels: [solid(0, 1, 1, RED, { zIndex: 1 }), solid(1, 1, 1, GREEN)] }],
      });

      assert.deepEqual(pixel(frames[0], 1, 0, 0), RED);
    });
  });

  void describe('what is not drawn', () => {
    void test('hidden layers, the layers of a hidden group and reference layers', async () => {
      const { frames } = await decode({
        width: 1,
        height: 1,
        layers: [
          { name: 'base' },
          { name: 'hidden', flags: 0 },
          { name: 'group', type: 1, flags: 0 },
          { name: 'in group', childLevel: 1 },
          { name: 'guide', flags: 1 | 64 },
        ],
        frames: [{ cels: [solid(0, 1, 1, RED), solid(1, 1, 1, GREEN), solid(3, 1, 1, BLUE), solid(4, 1, 1, [255, 255, 255, 255])] }],
      });

      assert.deepEqual(pixel(frames[0], 1, 0, 0), RED);
    });

    void test('tilemap layers, reported once, and the art around them still draws', async () => {
      const { frames, warnings } = await decode({
        width: 1,
        height: 1,
        layers: [{ name: 'tiles', type: 2 }, { name: 'art' }],
        frames: [{ cels: [solid(0, 1, 1, GREEN), solid(1, 1, 1, RED)] }, { cels: [solid(0, 1, 1, GREEN), solid(1, 1, 1, RED)] }],
      });

      assert.deepEqual(pixel(frames[0], 1, 0, 0), RED);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /tilemap layers are not drawn \("tiles"\)/);
    });

    void test('a blend mode other than normal is drawn as normal and reported once', async () => {
      const { frames, warnings } = await decode({
        width: 1,
        height: 1,
        layers: [{ name: 'base' }, { name: 'multiply', blendMode: 1 }],
        frames: [{ cels: [solid(0, 1, 1, RED), solid(1, 1, 1, GREEN)] }, { cels: [solid(0, 1, 1, RED), solid(1, 1, 1, GREEN)] }],
      });

      assert.deepEqual(pixel(frames[0], 1, 0, 0), GREEN);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /blend mode 1 of layer "multiply"/);
    });
  });

  void describe('other color modes', () => {
    const palette = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 128, 9, 9, 9, 255];

    void test('indexed pixels take their color and alpha from the palette', async () => {
      const { frames } = await decode({ width: 3, height: 1, depth: 8, palette, transparentIndex: 99, frames: [{ cels: [{ layer: 0, width: 3, height: 1, pixels: [0, 1, 2] }] }] });

      assert.deepEqual(pixel(frames[0], 3, 0, 0), RED);
      assert.deepEqual(pixel(frames[0], 3, 1, 0), GREEN);
      assert.deepEqual(pixel(frames[0], 3, 2, 0), [0, 0, 128, 128], 'premultiplied');
    });

    void test('the transparent index is transparent in every layer but the background', async () => {
      const cel = (layer: number): { layer: number, width: number, height: number, pixels: number[] } => ({ layer, width: 2, height: 1, pixels: [3, 0] });
      const { frames } = await decode({
        width: 2,
        height: 2,
        depth: 8,
        palette,
        transparentIndex: 3,
        layers: [{ name: 'bg', flags: 1 | 8 }, { name: 'fg' }],
        frames: [{ cels: [cel(0), { ...cel(1), y: 1 }] }],
      });

      assert.deepEqual(pixel(frames[0], 2, 0, 0), [9, 9, 9, 255], 'the background keeps index 3');
      assert.deepEqual(pixel(frames[0], 2, 0, 1), CLEAR, 'the other layer does not');
    });

    void test('an indexed file needs its palette', async () => {
      await assert.rejects(decode({ width: 1, height: 1, depth: 8, frames: [{ cels: [{ layer: 0, width: 1, height: 1, pixels: [0] }] }] }), CorruptedResourceError);
    });

    void test('grayscale pixels are a value and an alpha', async () => {
      const { frames } = await decode({ width: 2, height: 1, depth: 16, frames: [{ cels: [{ layer: 0, width: 2, height: 1, pixels: [200, 255, 100, 0] }] }] });

      assert.deepEqual(pixel(frames[0], 2, 0, 0), [200, 200, 200, 255]);
      assert.deepEqual(pixel(frames[0], 2, 1, 0), CLEAR);
    });
  });

  void describe('linked cels', () => {
    void test('show the picture of the cel they link to, at their own place', async () => {
      const { frames } = await decode({
        width: 3,
        height: 1,
        frames: [{ cels: [solid(0, 1, 1, RED)] }, { cels: [{ layer: 0, kind: 'linked', linkedFrame: 0, x: 2 }] }],
      });

      assert.deepEqual(pixel(frames[1], 3, 2, 0), RED);
      assert.deepEqual(pixel(frames[1], 3, 0, 0), CLEAR);
    });

    void test('follow a chain of links', async () => {
      const { frames } = await decode({
        width: 1,
        height: 1,
        frames: [{ cels: [solid(0, 1, 1, BLUE)] }, { cels: [{ layer: 0, kind: 'linked', linkedFrame: 0 }] }, { cels: [{ layer: 0, kind: 'linked', linkedFrame: 1 }] }],
      });

      assert.deepEqual(pixel(frames[2], 1, 0, 0), BLUE);
    });

    void test('a link to a frame without a cel on the layer is an error', async () => {
      await assert.rejects(decode({ width: 1, height: 1, frames: [{}, { cels: [{ layer: 0, kind: 'linked', linkedFrame: 0 }] }] }), CorruptedResourceError);
    });
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CorruptedResourceError } from '../../source/engine/common/Errors.ts';
import { AsepriteFile } from '../../source/engine/common/model/sprite/AsepriteFile.ts';
import { AsepriteHeader } from '../../source/engine/common/model/sprite/AsepriteHeader.ts';
import { ImageFormat, ImageHeaders } from '../../source/engine/common/model/sprite/ImageHeader.ts';
import { SpriteDirection } from '../../source/engine/common/model/sprite/SpriteTypes.ts';
import { encodeAseprite } from '../support/aseprite.ts';

const PIXEL = [255, 0, 0, 255];

void describe('AsepriteFile', () => {
  void describe('matches', () => {
    void test('takes a file with the magic number at offset 4', () => {
      assert.equal(AsepriteFile.matches(encodeAseprite({ width: 1, height: 1, frames: [{}] })), true);
    });

    void test('leaves other files alone: an Adobe swatch file with the same extension, random bytes, a short file', () => {
      const swatch = new Uint8Array(200);

      swatch.set([0x41, 0x53, 0x45, 0x46]);

      assert.equal(AsepriteFile.matches(swatch.buffer), false);
      assert.equal(AsepriteFile.matches(new Uint8Array(200).buffer), false);
      assert.equal(AsepriteFile.matches(new ArrayBuffer(20)), false);
    });
  });

  void describe('frames', () => {
    void test('reads the size, the depth and the duration of each frame', () => {
      const data = AsepriteFile.parse(encodeAseprite({ width: 6, height: 4, depth: 16, frames: [{ duration: 50 }, { duration: 200 }] }), 'a.aseprite');

      assert.deepEqual([data.width, data.height, data.depth], [6, 4, 16]);
      assert.deepEqual(data.frames.map((frame) => frame.duration), [50, 200]);
    });

    void test('a frame without a duration of its own takes the speed of the header', () => {
      const data = AsepriteFile.parse(encodeAseprite({ width: 1, height: 1, speed: 80, frames: [{}, { duration: 30 }] }), 'a.aseprite');

      assert.deepEqual(data.frames.map((frame) => frame.duration), [80, 30]);
    });

    void test('skips chunks it does not know by their size', () => {
      const data = AsepriteFile.parse(encodeAseprite({ width: 1, height: 1, frames: [{ cels: [{ layer: 0, width: 1, height: 1, pixels: PIXEL }] }] }), 'a.aseprite');

      assert.equal(data.frames[0].cels.length, 1, 'the user data chunk after the cel did not confuse it');
    });

    void test('rejects a file without frames, an unknown depth and a damaged frame header', () => {
      assert.throws(() => AsepriteFile.parse(encodeAseprite({ width: 1, height: 1, frames: [] }), 'a.aseprite'), CorruptedResourceError);
      assert.throws(() => AsepriteFile.parse(encodeAseprite({ width: 1, height: 1, depth: 24, frames: [{}] }), 'a.aseprite'), CorruptedResourceError);

      const damaged = new Uint8Array(encodeAseprite({ width: 1, height: 1, frames: [{}] }));

      damaged[128 + 4] = 0;

      assert.throws(() => AsepriteFile.parse(damaged.buffer, 'a.aseprite'), CorruptedResourceError);
    });

    void test('a file that is cut short is reported as corrupt by the header pass', () => {
      const file = encodeAseprite({ width: 1, height: 1, frames: [{ cels: [{ layer: 0, width: 1, height: 1, pixels: PIXEL }] }] });

      assert.throws(() => ImageHeaders.parse(file.slice(0, 160), 'cut.aseprite'), CorruptedResourceError);
    });
  });

  void describe('layers', () => {
    void test('a group that is hidden hides the layers inside it, and no more', () => {
      const data = AsepriteFile.parse(encodeAseprite({
        width: 1,
        height: 1,
        frames: [{}],
        layers: [
          { name: 'background', flags: 1 | 8 },
          { name: 'group', type: 1, flags: 0 },
          { name: 'inside', childLevel: 1 },
          { name: 'deeper group', type: 1, childLevel: 1 },
          { name: 'deep', childLevel: 2 },
          { name: 'above', childLevel: 0 },
        ],
      }), 'a.aseprite');

      assert.deepEqual(data.layers.map((layer) => [layer.name, layer.visible]), [
        ['background', true], ['group', false], ['inside', false], ['deeper group', false], ['deep', false], ['above', true],
      ]);
      assert.equal(data.layers[0].background, true);
    });

    void test('a visible group shows its layers, a hidden layer inside it only itself', () => {
      const data = AsepriteFile.parse(encodeAseprite({
        width: 1,
        height: 1,
        frames: [{}],
        layers: [{ name: 'group', type: 1 }, { name: 'shown', childLevel: 1 }, { name: 'hidden', childLevel: 1, flags: 0 }, { name: 'shown too', childLevel: 1 }],
      }), 'a.aseprite');

      assert.deepEqual(data.layers.map((layer) => layer.visible), [true, true, false, true]);
    });

    void test('reference layers are marked', () => {
      const data = AsepriteFile.parse(encodeAseprite({ width: 1, height: 1, frames: [{}], layers: [{ name: 'guide', flags: 1 | 64 }] }), 'a.aseprite');

      assert.equal(data.layers[0].reference, true);
    });

    void test('the opacity of a layer only counts when the header says so', () => {
      const layers = [{ name: 'a', opacity: 128 }];

      assert.equal(AsepriteFile.parse(encodeAseprite({ width: 1, height: 1, frames: [{}], layers }), 'a.aseprite').layers[0].opacity, 255);
      assert.equal(AsepriteFile.parse(encodeAseprite({ width: 1, height: 1, frames: [{}], layers, flags: 1 }), 'a.aseprite').layers[0].opacity, 128);
    });
  });

  void describe('palette', () => {
    void test('reads the new palette chunk with an alpha for each entry', () => {
      const data = AsepriteFile.parse(encodeAseprite({ width: 1, height: 1, depth: 8, palette: [1, 2, 3, 4, 5, 6, 7, 8], frames: [{}] }), 'a.aseprite');

      assert.deepEqual([...data.palette!], [1, 2, 3, 4, 5, 6, 7, 8]);
    });

    void test('reads the old palette chunk when there is no other', () => {
      const data = AsepriteFile.parse(encodeAseprite({ width: 1, height: 1, depth: 8, oldPalette: [9, 8, 7, 6, 5, 4], frames: [{}] }), 'a.aseprite');

      assert.deepEqual([...data.palette!.subarray(0, 8)], [9, 8, 7, 255, 6, 5, 4, 255]);
    });

    void test('has none in a true color file', () => {
      assert.equal(AsepriteFile.parse(encodeAseprite({ width: 1, height: 1, frames: [{}] }), 'a.aseprite').palette, null);
    });
  });
});

void describe('AsepriteHeader', () => {
  void test('reports durations in milliseconds, plays forever and has no tags or origins by default', () => {
    const header = ImageHeaders.parse(encodeAseprite({ width: 5, height: 3, frames: [{ duration: 40 }, { duration: 60 }] }), 'a.aseprite');

    assert.deepEqual(header, { width: 5, height: 3, frameDurations: [40, 60], repeat: 0, tags: [], origins: null, regions: new Map() });
  });

  void test('is found as the Aseprite format', () => {
    assert.equal(ImageHeaders.detect(encodeAseprite({ width: 1, height: 1, frames: [{}] })), ImageFormat.aseprite);
  });

  void test('reads tags with their direction and repeat', () => {
    const header = AsepriteHeader.parse(encodeAseprite({
      width: 1,
      height: 1,
      frames: [{}, {}, {}, {}],
      tags: [{ name: 'idle', from: 0, to: 1 }, { name: 'bounce', from: 2, to: 3, direction: 2, repeat: 4 }, { name: 'back', from: 0, to: 3, direction: 1, repeat: 1 }],
    }), 'a.aseprite');

    assert.deepEqual(header.tags, [
      { name: 'idle', from: 0, to: 1, direction: SpriteDirection.forward, repeat: 0 },
      { name: 'bounce', from: 2, to: 3, direction: SpriteDirection.pingpong, repeat: 4 },
      { name: 'back', from: 0, to: 3, direction: SpriteDirection.reverse, repeat: 1 },
    ]);
  });

  void test('takes the origin from the pivot of a slice, relative to the slice', () => {
    const header = AsepriteHeader.parse(encodeAseprite({
      width: 16,
      height: 16,
      frames: [{}],
      slices: [{ name: 'feet', keys: [{ frame: 0, x: 4, y: 6, pivot: [2, 9] }] }],
    }), 'a.aseprite');

    assert.deepEqual(header.origins, [[6, 15]]);
  });

  void test('a slice that moves has a pivot for each frame, from its key on', () => {
    const header = AsepriteHeader.parse(encodeAseprite({
      width: 16,
      height: 16,
      frames: [{}, {}, {}, {}],
      slices: [{ name: 'feet', keys: [{ frame: 1, x: 0, y: 0, pivot: [1, 1] }, { frame: 3, x: 5, y: 5, pivot: [2, 2] }] }],
    }), 'a.aseprite');

    assert.deepEqual(header.origins, [[1, 1], [1, 1], [1, 1], [7, 7]]);
  });

  void test('uses the first slice that has a pivot and ignores slices without one', () => {
    const header = AsepriteHeader.parse(encodeAseprite({
      width: 16,
      height: 16,
      frames: [{}],
      slices: [{ name: 'region', keys: [{ frame: 0, x: 0, y: 0 }] }, { name: 'pivot', keys: [{ frame: 0, x: 3, y: 3, pivot: [1, 1] }] }, { name: 'later', keys: [{ frame: 0, x: 9, y: 9, pivot: [1, 1] }] }],
    }), 'a.aseprite');

    assert.deepEqual(header.origins, [[4, 4]]);
  });
  void describe('regions', () => {
    void test('every named slice is a region, with the size of its key', () => {
      const header = AsepriteHeader.parse(encodeAseprite({
        width: 32,
        height: 16,
        frames: [{}],
        slices: [
          { name: 'digit_0', keys: [{ frame: 0, x: 2, y: 3, width: 5, height: 7 }] },
          { name: 'digit_1', keys: [{ frame: 0, x: 8, y: 3, width: 6, height: 7 }] },
        ],
      }), 'a.aseprite');

      assert.deepEqual([...header.regions], [
        ['digit_0', { x: 2, y: 3, width: 5, height: 7 }],
        ['digit_1', { x: 8, y: 3, width: 6, height: 7 }],
      ]);
    });

    void test('a slice that moves is the rectangle it has in the first frame', () => {
      const header = AsepriteHeader.parse(encodeAseprite({
        width: 32,
        height: 16,
        frames: [{}, {}],
        slices: [{ name: 'hand', keys: [{ frame: 1, x: 9, y: 9, width: 3, height: 3 }, { frame: 0, x: 1, y: 1, width: 4, height: 4 }] }],
      }), 'a.aseprite');

      assert.deepEqual(header.regions.get('hand'), { x: 1, y: 1, width: 4, height: 4 });
    });

    void test('a slice that begins later takes its first key', () => {
      const header = AsepriteHeader.parse(encodeAseprite({
        width: 32,
        height: 16,
        frames: [{}, {}, {}],
        slices: [{ name: 'late', keys: [{ frame: 2, x: 4, y: 5, width: 6, height: 7 }] }],
      }), 'a.aseprite');

      assert.deepEqual(header.regions.get('late'), { x: 4, y: 5, width: 6, height: 7 });
    });

    void test('a slice with a pivot is a region as well, a slice without a name or an area is not', () => {
      const header = AsepriteHeader.parse(encodeAseprite({
        width: 32,
        height: 16,
        frames: [{}],
        slices: [
          { name: 'feet', keys: [{ frame: 0, x: 0, y: 0, width: 8, height: 8, pivot: [4, 8] }] },
          { name: '', keys: [{ frame: 0, x: 0, y: 0, width: 2, height: 2 }] },
          { name: 'empty', keys: [{ frame: 0, x: 0, y: 0, width: 0, height: 2 }] },
        ],
      }), 'a.aseprite');

      assert.deepEqual([...header.regions.keys()], ['feet']);
    });
  });
});

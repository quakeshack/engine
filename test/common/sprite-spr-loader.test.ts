import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SpriteSPRLoader } from '../../source/engine/common/model/loaders/SpriteSPRLoader.ts';
import { SpritePixels } from '../../source/engine/common/model/sprite/SpritePixels.ts';
import {
  SpriteBlend, SpriteDirection, SpriteOrientation, SpritePhase, type SpriteImage, type SpriteSequence,
} from '../../source/engine/common/model/sprite/SpriteTypes.ts';
import { createModelLoadContext, createSilentConsole } from '../support/modelContext.ts';

interface TestImage {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
}

type TestFrame = TestImage | { readonly endTimes: number[]; readonly images: TestImage[] };

interface TestSprite {
  readonly type?: number;
  readonly version?: number;
  readonly syncType?: number;
  readonly width: number;
  readonly height: number;
  readonly frames: TestFrame[];
}

/**
 * Writes a version 1 SPR file with every pixel set to palette index 7.
 * @returns The file.
 */
function createSprite(sprite: TestSprite): ArrayBuffer {
  const bytes: number[] = [];
  const u32 = (value: number): void => { bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff); };
  const f32 = (value: number): void => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    bytes.push(...new Uint8Array(view.buffer));
  };
  const image = (entry: TestImage): void => {
    u32(entry.originX);
    u32(entry.originY);
    u32(entry.width);
    u32(entry.height);
    bytes.push(...new Array<number>(entry.width * entry.height).fill(7));
  };

  u32(0x50534449);
  u32(sprite.version ?? 1);
  u32(sprite.type ?? 2);
  f32(10);
  u32(sprite.width);
  u32(sprite.height);
  u32(sprite.frames.length);
  f32(0);
  u32(sprite.syncType ?? 0);

  for (const frame of sprite.frames) {
    if ('images' in frame) {
      u32(1);
      u32(frame.images.length);
      frame.endTimes.forEach(f32);
      frame.images.forEach(image);
    } else {
      u32(0);
      image(frame);
    }
  }

  return new Uint8Array(bytes).buffer;
}

/**
 * @returns A server's loader: bounds and timing only, nothing is uploaded.
 */
function createServerLoader(): SpriteSPRLoader {
  return new SpriteSPRLoader(createModelLoadContext({ loadRenderData: false }));
}

void describe('SpriteSPRLoader', () => {
  void test('reads bounds, orientation and phase from the header', async () => {
    const model = await createServerLoader().load(createSprite({
      type: 3, syncType: 1, width: 8, height: 4, frames: [{ originX: -4, originY: 2, width: 8, height: 4 }],
    }), 'sprites/test.spr');

    assert.equal(model.orientation, SpriteOrientation.oriented);
    assert.equal(model.phase, SpritePhase.random);
    assert.equal(model.random, true);
    assert.equal(model.boundingradius, 10);
    assert.deepEqual([...model.mins], [-4, -4, -2]);
    assert.deepEqual([...model.maxs], [4, 4, 2]);
    assert.equal(model.needload, false);
  });

  void test('keeps the global clock when the header does not ask for a random phase', async () => {
    const model = await createServerLoader().load(createSprite({
      width: 8, height: 4, frames: [{ originX: 0, originY: 0, width: 8, height: 4 }],
    }), 'sprites/test.spr');

    assert.equal(model.phase, SpritePhase.global);
    assert.equal(model.random, false);
  });

  void test('maps every type of the header onto an orientation', async () => {
    for (const orientation of [0, 1, 2, 3, 4]) {
      const model = await createServerLoader().load(createSprite({
        type: orientation, width: 1, height: 1, frames: [{ originX: 0, originY: 0, width: 1, height: 1 }],
      }), 'sprites/test.spr');

      assert.equal(model.orientation, orientation as SpriteOrientation);
    }
  });

  void test('falls back to a plain billboard for an unknown type and says so', async () => {
    const warnings: string[] = [];
    const loader = new SpriteSPRLoader(createModelLoadContext({ loadRenderData: false, con: createSilentConsole({ PrintWarning: (text: string) => { warnings.push(text); } }) }));

    const model = await loader.load(createSprite({
      type: 9, width: 1, height: 1, frames: [{ originX: 0, originY: 0, width: 1, height: 1 }],
    }), 'sprites/test.spr');

    assert.equal(model.orientation, SpriteOrientation.parallel);
    assert.equal(warnings.length, 1);
  });

  void test('turns single frames into images and groups into sequences with the file\'s end times', async () => {
    const model = await createServerLoader().load(createSprite({
      width: 8,
      height: 8,
      frames: [
        { originX: -4, originY: 4, width: 8, height: 8 },
        { endTimes: [0.1, 0.3], images: [{ originX: 0, originY: 0, width: 4, height: 2 }, { originX: 0, originY: 0, width: 4, height: 2 }] },
      ],
    }), 'sprites/test.spr');

    assert.equal(model.numframes, 2);

    const [single, group] = model.frames as [SpriteImage, SpriteSequence];
    assert.deepEqual([single.origin[0], single.origin[1], single.width, single.height], [-4, -4, 8, 8]);
    assert.equal(group.images.length, 2);
    assert.deepEqual(Array.from(group.endTimes).map((time) => Math.round(time * 100) / 100), [0.1, 0.3]);
    assert.equal(group.direction, SpriteDirection.forward);
    assert.equal(group.repeat, 0);
  });

  void test('gives each image a layer and scales the uv of those smaller than the largest', async () => {
    const model = await createServerLoader().load(createSprite({
      width: 8,
      height: 8,
      frames: [
        { originX: 0, originY: 0, width: 8, height: 8 },
        { endTimes: [1, 2], images: [{ originX: 0, originY: 0, width: 4, height: 2 }, { originX: 0, originY: 0, width: 8, height: 4 }] },
      ],
    }), 'sprites/test.spr');

    const [single, group] = model.frames as [SpriteImage, SpriteSequence];

    assert.equal(single.layer, 0);
    assert.deepEqual(group.images.map((image) => image.layer), [1, 2]);
    assert.deepEqual(single.uvScale, [1, 1]);
    assert.deepEqual(group.images[0].uvScale, [0.5, 0.25]);
    assert.deepEqual(group.images[1].uvScale, [1, 0.5]);
  });

  void test('loads without a texture in a realm that does not draw', async () => {
    const model = await createServerLoader().load(createSprite({
      width: 2, height: 2, frames: [{ originX: 0, originY: 0, width: 2, height: 2 }],
    }), 'sprites/test.spr');

    assert.equal(model.asset?.texture, null);
    assert.equal(model.asset?.blend, SpriteBlend.alphaTest);
    assert.equal(model.asset?.layerWidth, 2);
  });

  void test('rejects other versions, empty files and non-positive intervals', () => {
    const frame = { originX: 0, originY: 0, width: 1, height: 1 };

    assert.throws(() => createServerLoader().load(createSprite({ version: 2, width: 1, height: 1, frames: [frame] }), 'a.spr'), /wrong version/);
    assert.throws(() => createServerLoader().load(createSprite({ width: 1, height: 1, frames: [] }), 'a.spr'), /no frames/);
    assert.throws(() => createServerLoader().load(createSprite({ width: 1, height: 1, frames: [{ endTimes: [0], images: [frame] }] }), 'a.spr'), /interval/);
  });
});

void describe('SpritePixels.padToLayer', () => {
  void test('hands back an image that already has the size of the layer', () => {
    const rgba = new Uint8Array(2 * 2 * 4).fill(9);

    assert.equal(SpritePixels.padToLayer(rgba, 2, 2, 2, 2), rgba);
  });

  void test('puts the image in the top left corner of a transparent layer', () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);

    const layer = SpritePixels.padToLayer(rgba, 2, 1, 3, 2);

    assert.deepEqual(Array.from(layer), [
      1, 2, 3, 255, 4, 5, 6, 255, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });
});

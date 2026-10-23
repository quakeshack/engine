import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import { ModelScope, Mod } from '../../source/engine/common/Mod.ts';
import { ImageSpriteLoader } from '../../source/engine/common/model/loaders/ImageSpriteLoader.ts';
import { SpriteModel } from '../../source/engine/common/model/SpriteModel.ts';
import { SpriteAnimator } from '../../source/engine/common/model/sprite/SpriteAnimator.ts';
import {
  SpriteBlend, SpriteDirection, SpriteFilter, SpriteOrientation, SpritePhase, type SpriteImage, type SpriteSequence,
} from '../../source/engine/common/model/sprite/SpriteTypes.ts';
import { GLTextureArray } from '../../source/engine/client/GL.ts';
import type { SpriteImageDecoding } from '../../source/engine/common/model/sprite/SpriteImageDecoding.ts';
import { createDirectoryFiles, createModelLoadContext, createSilentConsole } from '../support/modelContext.ts';

const FIXTURES = new URL('../fixtures/sprites/', import.meta.url);

/**
 * Loads a fixture through the model cache the way a server realm does: no render data.
 * @returns The model.
 */
async function loadOnServer(name: string): Promise<SpriteModel> {
  const mod = new Mod();

  mod.Init({ files: createDirectoryFiles(FIXTURES), con: createSilentConsole(), loadRenderData: false });

  const model = await mod.ForNameAsync(name, true, ModelScope.server);

  assert.ok(model instanceof SpriteModel);

  return model;
}

void describe('ImageSpriteLoader', () => {
  void describe('canLoad', () => {
    const loader = new ImageSpriteLoader(createModelLoadContext());

    void test('takes image files with an image extension', async () => {
      const files = createDirectoryFiles(FIXTURES);

      for (const name of ['anim.gif', 'static.png', 'anim.apng', 'anim.webp']) {
        assert.equal(loader.canLoad((await files.LoadFile(name))!, `gfx/${name}`), true, name);
      }
    });

    void test('leaves a file with another extension to the other loaders', async () => {
      const file = (await createDirectoryFiles(FIXTURES).LoadFile('anim.gif'))!;

      assert.equal(loader.canLoad(file, 'progs/flame.spr'), false);
    });

    void test('leaves a file that is no image, whatever its name, to the other loaders', () => {
      assert.equal(loader.canLoad(new Uint8Array(64).buffer, 'gfx/fake.gif'), false);
    });
  });

  void describe('on a server (no render data)', () => {
    void test('sets bounds around the center of the image, as an SPR does', async () => {
      const model = await loadOnServer('anim.gif');

      assert.deepEqual([...model.mins], [-4, -4, -2]);
      assert.deepEqual([...model.maxs], [4, 4, 2]);
      assert.equal(model.width, 8);
      assert.equal(model.height, 4);
      assert.equal(model.needload, false);
    });

    void test('plays all images as one sequence that starts with the entity', async () => {
      const model = await loadOnServer('anim.gif');

      assert.equal(model.numframes, 1);
      assert.equal(model.phase, SpritePhase.spawn);
      assert.equal(model.orientation, SpriteOrientation.parallel);

      const sequence = model.frames[0] as SpriteSequence;

      assert.equal(sequence.images.length, 3);
      assert.deepEqual(sequence.images.map((image) => image.layer), [0, 1, 2]);
      assert.deepEqual(Array.from(sequence.endTimes).map((time) => Math.round(time * 1000)), [50, 150, 350]);
      assert.equal(sequence.direction, SpriteDirection.forward);
      assert.equal(sequence.repeat, 0);
    });

    void test('centers each image on the entity and draws it at one pixel per unit', async () => {
      const model = await loadOnServer('anim.gif');
      const image = (model.frames[0] as SpriteSequence).images[0];

      assert.deepEqual([...image.origin], [-4, -2]);
      assert.deepEqual([image.width, image.height], [8, 4]);
      assert.deepEqual([...image.uvScale], [1, 1]);
    });

    void test('has no texture', async () => {
      assert.equal((await loadOnServer('anim.gif')).asset?.texture, null);
    });

    void test('tells how long a one-shot animation runs', async () => {
      const once = (await loadOnServer('anim-once.gif')).frames[0] as SpriteSequence;
      const loop3 = (await loadOnServer('anim-loop3.gif')).frames[0] as SpriteSequence;
      const forever = (await loadOnServer('anim.gif')).frames[0] as SpriteSequence;

      assert.equal(Math.round(SpriteAnimator.duration(once) * 1000), 350);
      assert.equal(Math.round(SpriteAnimator.duration(loop3) * 1000), 1200);
      assert.equal(SpriteAnimator.duration(forever), Infinity);
    });

    void test('plays 10 ms delays at 100 ms', async () => {
      const sequence = (await loadOnServer('anim-zero-delay.gif')).frames[0] as SpriteSequence;

      assert.deepEqual(Array.from(sequence.endTimes).map((time) => Math.round(time * 1000)), [100, 200, 220]);
    });

    void test('a still image is a single picture', async () => {
      const model = await loadOnServer('static.png');
      const frame = model.frames[0] as SpriteImage;

      assert.equal(model.numframes, 1);
      assert.equal('images' in frame, false);
      assert.equal(frame.layer, 0);
    });

    void test('GIF is alpha tested, the other formats are alpha blended', async () => {
      assert.equal((await loadOnServer('anim.gif')).asset?.blend, SpriteBlend.alphaTest);
      assert.equal((await loadOnServer('anim.apng')).asset?.blend, SpriteBlend.alpha);
      assert.equal((await loadOnServer('anim.webp')).asset?.blend, SpriteBlend.alpha);
    });

    void test('loads every fixture', async () => {
      for (const name of ['anim.gif', 'anim-once.gif', 'anim-loop3.gif', 'anim-zero-delay.gif', 'interlaced.gif', 'static.png', 'anim.apng',
        'anim-hidden-default.apng', 'anim.webp', 'anim-loop2.webp', 'static-lossless.webp', 'static-lossy.webp', 'static-lossy-alpha.webp']) {
        const model = await loadOnServer(name);

        assert.ok(model.width > 0 && model.height > 0, name);
      }
    });
  });

  void describe('where something is drawn', () => {
    const uploads: Array<{ width: number, height: number, layers: number }> = [];

    beforeEach(() => {
      uploads.length = 0;
      mock.method(GLTextureArray, 'FromRGBALayers', (width: number, height: number, layers: readonly Uint8Array[]) => {
        uploads.push({ width, height, layers: layers.length });

        return { texture: 'array texture' } as unknown as GLTextureArray;
      });
    });

    afterEach(() => {
      mock.restoreAll();
    });

    /**
     * Loads a fixture with the given decoder, as the client does.
     * @returns The model.
     */
    async function loadOnClient(name: string, spriteImages: SpriteImageDecoding | null): Promise<SpriteModel> {
      const loader = new ImageSpriteLoader(createModelLoadContext({ loadRenderData: true, spriteImages }));

      return await loader.load((await createDirectoryFiles(FIXTURES).LoadFile(name))!, `gfx/${name}`);
    }

    /**
     * @returns A decoder that gives `count` frames of `width` x `height` whatever the file.
     */
    function fakeDecoding(width: number, height: number, count: number): SpriteImageDecoding & { calls: number } {
      return {
        calls: 0,
        decode() {
          this.calls++;

          return Promise.resolve({ width, height, frames: Array.from({ length: count }, () => new Uint8Array(width * height * 4)) });
        },
      };
    }

    void test('uploads the decoded frames as the layers of one array texture', async () => {
      const decoding = fakeDecoding(8, 4, 3);

      const model = await loadOnClient('anim.gif', decoding);

      assert.equal(decoding.calls, 1);
      assert.deepEqual(uploads, [{ width: 8, height: 4, layers: 3 }]);
      assert.ok(model.asset?.texture !== null);
      assert.equal((model.frames[0] as SpriteSequence).images.length, 3);
    });

    void test('draws at the size of the file whatever size the texture has', async () => {
      const model = await loadOnClient('anim.gif', fakeDecoding(4, 2, 3));
      const image = (model.frames[0] as SpriteSequence).images[0];

      assert.deepEqual(uploads, [{ width: 4, height: 2, layers: 3 }]);
      assert.equal(model.asset?.layerWidth, 4);
      assert.deepEqual([image.width, image.height], [8, 4]);
      assert.deepEqual([...model.mins], [-4, -4, -2]);
      assert.deepEqual([...image.uvScale], [1, 1]);
    });

    void test('plays what could be decoded when the browser gives fewer frames than the file has', async () => {
      const model = await loadOnClient('anim.webp', fakeDecoding(8, 4, 1));

      assert.deepEqual(uploads, [{ width: 8, height: 4, layers: 1 }]);
      assert.equal(model.numframes, 1);
      assert.equal('images' in model.frames[0], false);
    });

    void test('ignores frames the file does not have', async () => {
      await loadOnClient('anim.gif', fakeDecoding(8, 4, 5));

      assert.equal(uploads[0].layers, 3);
    });

    void test('has no texture without a decoder', async () => {
      const model = await loadOnClient('anim.gif', null);

      assert.equal(model.asset?.texture, null);
      assert.deepEqual(uploads, []);
    });

    void test('does not decode on a server', async () => {
      const decoding = fakeDecoding(8, 4, 3);
      const loader = new ImageSpriteLoader(createModelLoadContext({ loadRenderData: false, spriteImages: decoding }));

      await loader.load((await createDirectoryFiles(FIXTURES).LoadFile('anim.gif'))!, 'gfx/anim.gif');

      assert.equal(decoding.calls, 0);
      assert.deepEqual(uploads, []);
    });
  });

  void describe('with a sidecar', () => {
    /**
     * Loads a fixture on a server with a sidecar next to it.
     * @param settings What the sidecar file says (text, to also test broken files).
     * @param warnings Collects what the loader reports.
     * @returns The model.
     */
    async function loadWithSidecar(name: string, settings: object | string, warnings: string[] = []): Promise<SpriteModel> {
      const directory = createDirectoryFiles(FIXTURES);
      const loader = new ImageSpriteLoader(createModelLoadContext({
        loadRenderData: false,
        con: createSilentConsole({ PrintWarning: (text: string) => { warnings.push(text); } }),
        files: {
          ...directory,
          LoadOptionalTextFile: (file) => Promise.resolve(file === `gfx/${name}.json` ? (typeof settings === 'string' ? settings : JSON.stringify(settings)) : null),
        },
      }));

      return await loader.load((await directory.LoadFile(name))!, `gfx/${name}`);
    }

    /**
     * @returns The sequences of a model, as the entity's `frame` selects them.
     */
    function sequencesOf(model: SpriteModel): SpriteSequence[] {
      return model.frames as SpriteSequence[];
    }

    void test('scale sets world units per pixel, for the pictures and for the bounds the server uses', async () => {
      const model = await loadWithSidecar('anim.gif', { scale: 0.5 });
      const image = sequencesOf(model)[0].images[0];

      assert.deepEqual([image.width, image.height], [4, 2]);
      assert.deepEqual([...image.origin], [-2, -1]);
      assert.deepEqual([...model.mins], [-2, -2, -1]);
      assert.deepEqual([...model.maxs], [2, 2, 1]);
      assert.deepEqual([model.width, model.height], [4, 2]);
    });

    void test('origin is the pixel of the image that sits on the entity, from the top left', async () => {
      const model = await loadWithSidecar('anim.gif', { origin: [2, 1], scale: 2 });
      const image = sequencesOf(model)[0].images[0];

      // the image is 8x4 pixels: 2 px to the left of the origin, 6 to the right, 1 above it and 3 below, doubled
      assert.deepEqual([...image.origin], [-4, -6]);
      assert.deepEqual([image.width, image.height], [16, 8]);
      assert.deepEqual([...model.mins], [-12, -12, -6]);
      assert.deepEqual([...model.maxs], [12, 12, 2]);
    });

    void test('origin at the bottom center puts the feet on the entity', async () => {
      const model = await loadWithSidecar('static.png', { origin: [4, 4] });

      assert.deepEqual([...(model.frames[0] as SpriteImage).origin], [-4, 0]);
      assert.deepEqual([model.mins[2], model.maxs[2]], [0, 4]);
    });

    void test('takes orientation, phase, blend, filter and interpolation', async () => {
      const model = await loadWithSidecar('anim.apng', { orientation: 'facingUpright', phase: 'random', blend: 'additive', filter: 'nearest', interpolate: true });

      assert.equal(model.orientation, SpriteOrientation.facingUpright);
      assert.equal(model.phase, SpritePhase.random);
      assert.equal(model.random, true, 'the client takes the random phase from this');
      assert.equal(model.asset?.blend, SpriteBlend.additive);
      assert.equal(model.asset?.filter, SpriteFilter.nearest);
      assert.equal(model.asset?.interpolate, true);
    });

    void test('without a sidecar the defaults of the format stay', async () => {
      const model = await loadWithSidecar('anim.apng', {});

      assert.equal(model.orientation, SpriteOrientation.parallel);
      assert.equal(model.phase, SpritePhase.spawn);
      assert.equal(model.asset?.filter, null);
      assert.equal(model.asset?.interpolate, false);
      assert.equal(model.sidecarSkipped, false);
    });

    void test('fps replaces the timing of the file, also below the 10 ms clamp', async () => {
      const slow = sequencesOf(await loadWithSidecar('anim.gif', { fps: 4 }))[0];
      const fast = sequencesOf(await loadWithSidecar('anim.gif', { fps: 200 }))[0];

      assert.deepEqual(Array.from(slow.endTimes), [0.25, 0.5, 0.75]);
      assert.deepEqual(Array.from(fast.endTimes).map((time) => Math.round(time * 1000)), [5, 10, 15]);
    });

    void test('repeat replaces the count of the file', async () => {
      assert.equal(sequencesOf(await loadWithSidecar('anim.gif', { repeat: 2 }))[0].repeat, 2);
      assert.equal(sequencesOf(await loadWithSidecar('anim-once.gif', { repeat: 0 }))[0].repeat, 0);
    });

    void test('sequences become the frames an entity selects, in order, over the same layers', async () => {
      const model = await loadWithSidecar('anim.gif', {
        sequences: [
          { name: 'rise', from: 0, to: 1, direction: 'reverse' },
          { name: 'last', from: 2, repeat: 1, fps: 10 },
        ],
      });
      const [rise, last] = sequencesOf(model);

      assert.equal(model.numframes, 2);
      assert.equal(rise.name, 'rise');
      assert.deepEqual(rise.images.map((image) => image.layer), [0, 1]);
      assert.equal(rise.direction, SpriteDirection.reverse);
      assert.deepEqual(Array.from(rise.endTimes).map((time) => Math.round(time * 1000)), [50, 150], 'the timing of the file');
      assert.equal(rise.repeat, 0, 'the file repeats forever');
      assert.equal(last.name, 'last');
      assert.deepEqual(last.images.map((image) => image.layer), [2]);
      assert.deepEqual(Array.from(last.endTimes).map((time) => Math.round(time * 1000)), [100]);
      assert.equal(last.repeat, 1);
    });

    void test('a sequence takes the repeat of the sidecar over the one of the file', async () => {
      const model = await loadWithSidecar('anim.gif', { repeat: 5, sequences: [{ name: 'a' }, { name: 'b', repeat: 1 }] });

      assert.deepEqual(sequencesOf(model).map((sequence) => sequence.repeat), [5, 1]);
    });

    void test('a sequence that reaches past the file is cut and reported', async () => {
      const warnings: string[] = [];
      const model = await loadWithSidecar('anim.gif', { sequences: [{ name: 'long', from: 1, to: 9 }] }, warnings);

      assert.deepEqual(sequencesOf(model)[0].images.map((image) => image.layer), [1, 2]);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /sequence "long".*0 to 2/);
    });

    void test('a broken sidecar is reported and the file loads with the defaults', async () => {
      const warnings: string[] = [];
      const model = await loadWithSidecar('anim.gif', '{ "scale": ', warnings);

      assert.equal(warnings.length, 1);
      assert.equal(model.width, 8);
    });

    void test('does not look for the sidecar when the game says there is none', async () => {
      let lookups = 0;
      const directory = createDirectoryFiles(FIXTURES);
      const loader = new ImageSpriteLoader(createModelLoadContext({
        files: { ...directory, LoadOptionalTextFile: () => { lookups++; return Promise.resolve('{"scale": 4}'); } },
      }));

      const model = await loader.load((await directory.LoadFile('anim.gif'))!, 'gfx/anim.gif', { collisionGeometry: false, sidecar: false });

      assert.equal(lookups, 0);
      assert.equal(model.width, 8);
      assert.equal(model.sidecarSkipped, true);
    });
  });

  void describe('with a sidecar where something is drawn', () => {
    const uploads: Array<{ filter: SpriteFilter | null, layers: readonly Uint8Array[] }> = [];

    beforeEach(() => {
      uploads.length = 0;
      mock.method(GLTextureArray, 'FromRGBALayers', (_width: number, _height: number, layers: readonly Uint8Array[], filter: SpriteFilter | null) => {
        uploads.push({ filter, layers: layers.map((layer) => layer.slice()) });

        return { texture: 'array texture' } as unknown as GLTextureArray;
      });
    });

    afterEach(() => {
      mock.restoreAll();
    });

    /**
     * Loads a fixture whose decoder gives one black, one white and one red pixel per frame, with a sidecar.
     */
    async function load(settings: object): Promise<void> {
      const directory = createDirectoryFiles(FIXTURES);
      const loader = new ImageSpriteLoader(createModelLoadContext({
        loadRenderData: true,
        files: { ...directory, LoadOptionalTextFile: () => Promise.resolve(JSON.stringify(settings)) },
        spriteImages: {
          decode: () => Promise.resolve({
            width: 3,
            height: 1,
            frames: Array.from({ length: 3 }, () => new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255])),
          }),
        },
      }));

      await loader.load((await directory.LoadFile('anim.gif'))!, 'gfx/anim.gif');
    }

    void test('makes the key color transparent in every frame before it goes to the texture', async () => {
      await load({ colorKey: { color: [0, 0, 0] } });

      assert.equal(uploads[0].layers.length, 3);

      for (const layer of uploads[0].layers) {
        assert.deepEqual([...layer], [0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 255]);
      }
    });

    void test('a tolerance takes in colors close to the key', async () => {
      await load({ colorKey: { color: [250, 0, 0], tolerance: 10 } });

      assert.deepEqual([...uploads[0].layers[0].subarray(8)], [0, 0, 0, 0]);
      assert.deepEqual([...uploads[0].layers[0].subarray(4, 8)], [255, 255, 255, 255]);
    });

    void test('hands the filter to the texture', async () => {
      await load({ filter: 'nearest' });

      assert.equal(uploads[0].filter, SpriteFilter.nearest);
    });

    void test('leaves the pixels and the filter alone without those settings', async () => {
      await load({});

      assert.equal(uploads[0].filter, null);
      assert.deepEqual([...uploads[0].layers[0]], [0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255]);
    });
  });
});

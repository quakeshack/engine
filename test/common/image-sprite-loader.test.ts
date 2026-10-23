import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ModelScope, Mod } from '../../source/engine/common/Mod.ts';
import { ImageSpriteLoader } from '../../source/engine/common/model/loaders/ImageSpriteLoader.ts';
import { SpriteModel } from '../../source/engine/common/model/SpriteModel.ts';
import { SpriteAnimator } from '../../source/engine/common/model/sprite/SpriteAnimator.ts';
import {
  SpriteBlend, SpriteDirection, SpriteOrientation, SpritePhase, type SpriteImage, type SpriteSequence,
} from '../../source/engine/common/model/sprite/SpriteTypes.ts';
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

  void test('says it cannot draw yet when it runs where something is drawn', async () => {
    const warnings: string[] = [];
    const loader = new ImageSpriteLoader(createModelLoadContext({
      loadRenderData: true,
      con: createSilentConsole({ PrintWarning: (text: string) => { warnings.push(text); } }),
    }));
    const file = (await createDirectoryFiles(FIXTURES).LoadFile('anim.gif'))!;

    const model = await loader.load(file, 'gfx/anim.gif');

    assert.equal(warnings.length, 1);
    assert.equal(model.asset?.texture, null);
  });
});

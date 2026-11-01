import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import { GLTextureArray } from '../../source/engine/client/GL.ts';
import { clientRuntimeState } from '../../source/engine/client/ClientState.ts';
import { installPageServices } from '../../source/engine/client/PageServices.ts';
import SpriteAssets from '../../source/engine/client/renderer/sprite/SpriteAssets.ts';
import { SpriteSample } from '../../source/engine/common/model/sprite/SpriteAnimator.ts';
import type COM from '../../source/engine/common/Com.ts';
import { eventBus } from '../../source/engine/common/EventBus.ts';
import { MissingResourceError } from '../../source/engine/common/Errors.ts';
import Host from '../../source/engine/common/Host.ts';
import Mod from '../../source/engine/common/Mod.ts';
import type { ModelFiles } from '../../source/engine/common/model/ModelLoadContext.ts';
import type { SpriteImageDecoding } from '../../source/engine/common/model/sprite/SpriteImageDecoding.ts';
import { createDirectoryFiles, createSilentConsole } from '../support/modelContext.ts';

const FIXTURES = new URL('../fixtures/sprites/', import.meta.url);

/** What the files of a test say beyond the fixtures. */
interface TestFiles {
  /** Sidecars by file name. */
  sidecars: Record<string, object>;
  /** Files by name that exist next to the fixtures. */
  extra: Record<string, ArrayBuffer>;
  /** The names of the sidecars that were asked for. */
  lookups: string[];
}

void describe('SpriteAssets', () => {
  const files: TestFiles = { sidecars: {}, extra: {}, lookups: [] };
  const decodes: string[] = [];
  const freed: string[] = [];
  let restorePageServices: () => void = () => {};
  const previousClock = { time: 0, realtime: 0 };

  /**
   * @returns The fixtures plus what the test added.
   */
  function createFiles(): ModelFiles {
    const directory = createDirectoryFiles(FIXTURES);

    return {
      ...directory,
      LoadFile: (name) => (name in files.extra ? Promise.resolve(files.extra[name]) : directory.LoadFile(name)),
      LoadOptionalTextFile: (name) => {
        files.lookups.push(name);

        return Promise.resolve(name in files.sidecars ? JSON.stringify(files.sidecars[name]) : null);
      },
    };
  }

  beforeEach(() => {
    files.sidecars = {};
    files.extra = {};
    files.lookups = [];
    decodes.length = 0;
    freed.length = 0;
    previousClock.time = clientRuntimeState.time;
    previousClock.realtime = Host.realtime;

    mock.method(GLTextureArray, 'FromRGBALayers', (_width: number, _height: number, layers: readonly Uint8Array[]) => {
      const label = `texture ${layers.length}`;

      return { free: () => { freed.push(label); } } as unknown as GLTextureArray;
    });

    const spriteImages: SpriteImageDecoding = {
      decode(_buffer, _format, header, name) {
        decodes.push(name);

        return Promise.resolve({ width: header.width, height: header.height, frames: header.frameDurations.map(() => new Uint8Array(header.width * header.height * 4)) });
      },
    };
    const sprites = createFiles();

    Mod.Init({ files: sprites, con: createSilentConsole(), loadRenderData: true, spriteImages });
    // the page's COM reads the same game directory; these tests only need it to hand out files
    restorePageServices = installPageServices({ com: sprites as unknown as COM });
  });

  afterEach(() => {
    eventBus.publish('gl.shutdown');
    restorePageServices();
    mock.restoreAll();
    clientRuntimeState.time = previousClock.time;
    Host.realtime = previousClock.realtime;
  });

  void test('loads a sprite file for the screen', async () => {
    const playback = await SpriteAssets.Load('anim.gif');

    assert.equal(playback.sequence, 0);
    assert.equal(playback.asset.frames.length, 1);
    assert.equal(playback.width, 8);
    assert.equal(playback.height, 4);
    assert.equal(playback.paused, false);
  });

  void test('shares the images between the playbacks of one file, and loads them once', async () => {
    const first = await SpriteAssets.Load('anim.gif');
    const second = await SpriteAssets.Load('anim.gif');

    assert.equal(second.asset, first.asset);
    assert.notEqual(second, first);
    assert.deepEqual(decodes, ['anim.gif']);
  });

  void test('shares the work of loads that overlap', async () => {
    const [first, second] = await Promise.all([SpriteAssets.Load('anim.gif'), SpriteAssets.Load('anim.gif')]);

    assert.equal(second.asset, first.asset);
    assert.deepEqual(decodes, ['anim.gif']);
  });

  void test('plays the playbacks of one file independently', async () => {
    clientRuntimeState.time = 1;

    const first = await SpriteAssets.Load('anim.gif');

    clientRuntimeState.time = 2;

    const second = await SpriteAssets.Load('anim.gif');
    const sample = new SpriteSample();

    // the file shows its three images for 50, 100 and 200 ms
    clientRuntimeState.time = 2.03;
    first.sample(false, sample);
    assert.equal(sample.image.layer, 2, '1.03 seconds in is 0.33 seconds into the third pass');
    second.sample(false, sample);
    assert.equal(sample.image.layer, 0, '0.03 seconds in');
  });

  void describe('the clock', () => {
    void test('is the client time by default', async () => {
      clientRuntimeState.time = 5;
      Host.realtime = 1000;

      const playback = await SpriteAssets.Load('anim.gif');
      const sample = new SpriteSample();

      clientRuntimeState.time = 5.1;
      playback.sample(false, sample);

      assert.equal(sample.image.layer, 1, 'the second image shows from 50 to 150 ms');
    });

    void test('is real time on request', async () => {
      clientRuntimeState.time = 5;
      Host.realtime = 1000;

      const playback = await SpriteAssets.Load('anim.gif', { clock: 'real' });
      const sample = new SpriteSample();

      clientRuntimeState.time = 99;
      Host.realtime = 1000.1;
      playback.sample(false, sample);

      assert.equal(sample.image.layer, 1);
    });
  });

  void describe('the settings file', () => {
    void test('is read, and gives regions to the sprite', async () => {
      files.sidecars['anim.gif.json'] = { scale: 2, regions: { left: [0, 0, 4, 4] } };

      const playback = await SpriteAssets.Load('anim.gif');

      assert.deepEqual(files.lookups, ['anim.gif.json']);
      assert.equal(playback.width, 16);
      assert.deepEqual(playback.asset.regions.get('left'), { x: 0, y: 0, width: 4, height: 4 });
    });

    void test('is not looked for when the game says there is none', async () => {
      await SpriteAssets.Load('anim.gif', { sidecar: false });

      assert.deepEqual(files.lookups, []);
    });

    void test('a load that skipped it does not stand in for one that reads it', async () => {
      files.sidecars['anim.gif.json'] = { scale: 2 };

      const skipped = await SpriteAssets.Load('anim.gif', { sidecar: false });
      const read = await SpriteAssets.Load('anim.gif');

      assert.equal(skipped.width, 8);
      assert.equal(read.width, 16);
      assert.notEqual(read.asset, skipped.asset);
    });
  });

  void describe('a file that cannot be loaded', () => {
    void test('throws for a file that does not exist, and tries again next time', async () => {
      await assert.rejects(SpriteAssets.Load('missing.gif'), MissingResourceError);

      files.extra['missing.gif'] = (await createFiles().LoadFile('anim.gif'))!;

      assert.equal((await SpriteAssets.Load('missing.gif')).width, 8);
    });

    void test('throws for a file that is no image', async () => {
      files.extra['broken.gif'] = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;

      await assert.rejects(SpriteAssets.Load('broken.gif'), /not a sprite/);
    });

    void test('throws for a model of another kind without loading it', async () => {
      const header = new Uint8Array(84);

      header.set([...'IDPO'].map((character) => character.charCodeAt(0)));
      files.extra['progs/player.mdl'] = header.buffer;

      await assert.rejects(SpriteAssets.Load('progs/player.mdl'), /not a sprite/);
      assert.equal(Mod.known['progs/player.mdl'], undefined);
    });
  });

  void describe('lifetime', () => {
    void test('keeps no trace in the model cache', async () => {
      await SpriteAssets.Load('anim.gif');

      assert.equal(Mod.known['anim.gif'], undefined);
      assert.equal(Mod.clientKnown['anim.gif'], undefined);
    });

    void test('survives the end of a map', async () => {
      const before = await SpriteAssets.Load('anim.gif');

      Mod.ClearAll();

      const after = await SpriteAssets.Load('anim.gif');

      assert.equal(after.asset, before.asset);
      assert.deepEqual(freed, []);
      assert.equal(decodes.length, 1);
    });

    void test('frees the textures when the GL context goes away, and loads again after it', async () => {
      const before = await SpriteAssets.Load('anim.gif');

      eventBus.publish('gl.shutdown');
      await new Promise((resolve) => { setImmediate(resolve); });

      assert.deepEqual(freed, ['texture 3'], 'one array texture of the three images');

      const after = await SpriteAssets.Load('anim.gif');

      assert.notEqual(after.asset, before.asset);
      assert.equal(decodes.length, 2);
    });
  });
});

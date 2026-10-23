import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SpriteSidecars } from '../../source/engine/common/model/sprite/SpriteSidecar.ts';
import {
  SpriteBlend, SpriteDirection, SpriteFilter, SpriteOrientation, SpritePhase,
} from '../../source/engine/common/model/sprite/SpriteTypes.ts';
import { createSilentConsole } from '../support/modelContext.ts';

/**
 * Parses a sidecar given as an object.
 * @returns The settings and what was reported.
 */
function parse(settings: object | string): { sidecar: ReturnType<typeof SpriteSidecars.parse>, warnings: string[] } {
  const warnings: string[] = [];
  const sidecar = SpriteSidecars.parse(typeof settings === 'string' ? settings : JSON.stringify(settings), 'gfx/flame.gif.json', createSilentConsole({
    PrintWarning: (text: string) => { warnings.push(text); },
  }));

  return { sidecar, warnings };
}

void describe('SpriteSidecars', () => {
  void test('an empty object leaves everything to the defaults', () => {
    const { sidecar, warnings } = parse({});

    assert.deepEqual(sidecar, SpriteSidecars.EMPTY);
    assert.deepEqual(warnings, []);
  });

  void test('reads every setting', () => {
    const { sidecar, warnings } = parse({
      version: 1,
      orientation: 'parallelUpright',
      origin: [16, 4],
      scale: 0.5,
      blend: 'additive',
      filter: 'nearest',
      phase: 'random',
      interpolate: true,
      lit: true,
      fps: 12,
      repeat: 3,
      colorKey: { color: [0, 0, 0], tolerance: 16 },
      sequences: [
        { name: 'idle', from: 0, to: 7, direction: 'pingpong' },
        { name: 'burst', from: 8, to: 15, repeat: 1, fps: 24 },
      ],
    });

    assert.deepEqual(warnings, []);
    assert.equal(sidecar.orientation, SpriteOrientation.parallelUpright);
    assert.deepEqual(sidecar.origin, [16, 4]);
    assert.equal(sidecar.scale, 0.5);
    assert.equal(sidecar.blend, SpriteBlend.additive);
    assert.equal(sidecar.filter, SpriteFilter.nearest);
    assert.equal(sidecar.phase, SpritePhase.random);
    assert.equal(sidecar.interpolate, true);
    assert.equal(sidecar.lit, true);
    assert.equal(sidecar.fps, 12);
    assert.equal(sidecar.repeat, 3);
    assert.deepEqual(sidecar.colorKey, { color: [0, 0, 0], tolerance: 16 });
    assert.deepEqual(sidecar.sequences, [
      { name: 'idle', from: 0, to: 7, direction: SpriteDirection.pingpong, repeat: null, fps: null },
      { name: 'burst', from: 8, to: 15, direction: null, repeat: 1, fps: 24 },
    ]);
  });

  void test('names every orientation', () => {
    for (const [name, orientation] of [['parallelUpright', 0], ['facingUpright', 1], ['parallel', 2], ['oriented', 3], ['parallelOriented', 4]] as const) {
      assert.equal(parse({ orientation: name }).sidecar.orientation, orientation as SpriteOrientation);
    }
  });

  void test('a color key without a tolerance matches exactly', () => {
    assert.deepEqual(parse({ colorKey: { color: [255, 0, 255] } }).sidecar.colorKey, { color: [255, 0, 255], tolerance: 0 });
  });

  void describe('regions', () => {
    void test('reads named rectangles in pixels', () => {
      const { sidecar, warnings } = parse({ regions: { number_0: [0, 0, 20, 24], number_1: [20, 0, 12, 24] } });

      assert.deepEqual([...sidecar.regions], [
        ['number_0', { x: 0, y: 0, width: 20, height: 24 }],
        ['number_1', { x: 20, y: 0, width: 12, height: 24 }],
      ]);
      assert.deepEqual(warnings, []);
    });

    void test('there are none by default', () => {
      assert.equal(parse({}).sidecar.regions.size, 0);
      assert.equal(SpriteSidecars.EMPTY.regions.size, 0);
    });

    void test('leaves out an entry that is not four whole numbers from zero, and says so', () => {
      const { sidecar, warnings } = parse({ regions: { ok: [1, 2, 3, 4], short: [1, 2, 3], negative: [-1, 0, 4, 4], fraction: [0, 0, 1.5, 4], text: 'a' } });

      assert.deepEqual([...sidecar.regions.keys()], ['ok']);
      assert.equal(warnings.length, 4);
    });

    void test('leaves out a region with no area', () => {
      const { sidecar, warnings } = parse({ regions: { flat: [0, 0, 5, 0], thin: [0, 0, 0, 5] } });

      assert.equal(sidecar.regions.size, 0);
      assert.equal(warnings.length, 2);
      assert.match(warnings[0], /region "flat" has no area/);
    });

    void test('regions that are not an object are ignored', () => {
      const { sidecar, warnings } = parse({ regions: [[0, 0, 1, 1]] });

      assert.equal(sidecar.regions.size, 0);
      assert.equal(warnings.length, 1);
    });

    void test('a region called like a member of Object is just a name', () => {
      const { sidecar } = parse('{ "regions": { "constructor": [0, 0, 2, 2], "__proto__": [1, 1, 2, 2] } }');

      assert.deepEqual(sidecar.regions.get('constructor'), { x: 0, y: 0, width: 2, height: 2 });
      assert.equal(sidecar.regions.get('toString'), undefined);
    });
  });

  void describe('what is wrong is reported and left out, the rest still counts', () => {
    void test('a file that is not JSON', () => {
      const { sidecar, warnings } = parse('{ scale: 2 ');

      assert.equal(sidecar, SpriteSidecars.EMPTY);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /gfx\/flame\.gif\.json: not valid JSON/);
    });

    void test('JSON that is not an object', () => {
      assert.equal(parse('[1, 2]').sidecar, SpriteSidecars.EMPTY);
      assert.equal(parse('3').sidecar, SpriteSidecars.EMPTY);
      assert.equal(parse('null').sidecar, SpriteSidecars.EMPTY);
    });

    void test('a setting nobody knows, which is usually a typo', () => {
      const { sidecar, warnings } = parse({ scal: 2, scale: 3 });

      assert.equal(sidecar.scale, 3);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /unknown setting "scal"/);
    });

    void test('a word that is not one of the choices', () => {
      const { sidecar, warnings } = parse({ blend: 'glow', scale: 2 });

      assert.equal(sidecar.blend, null);
      assert.equal(sidecar.scale, 2);
      assert.match(warnings[0], /"blend" has to be one of alphaTest, alpha, additive/);
    });

    void test('a number that is out of range or not whole', () => {
      const { sidecar, warnings } = parse({ scale: 0, fps: -4, repeat: 1.5 });

      assert.deepEqual([sidecar.scale, sidecar.fps, sidecar.repeat], [1, null, null]);
      assert.equal(warnings.length, 3);
    });

    void test('values of the wrong type', () => {
      const { sidecar, warnings } = parse({ scale: '2', interpolate: 'yes', origin: [1], orientation: 3, lit: 1 });

      assert.deepEqual([sidecar.scale, sidecar.interpolate, sidecar.origin, sidecar.orientation, sidecar.lit], [1, null, null, null, null]);
      assert.equal(warnings.length, 5);
    });

    void test('a color key without a color', () => {
      const { sidecar, warnings } = parse({ colorKey: { tolerance: 3 } });

      assert.equal(sidecar.colorKey, null);
      assert.match(warnings.at(-1)!, /colorKey needs a "color"/);
    });

    void test('a color key with a channel above 255', () => {
      assert.equal(parse({ colorKey: { color: [0, 0, 256] } }).sidecar.colorKey, null);
    });

    void test('sequences that are not a list, and entries that are not objects', () => {
      assert.equal(parse({ sequences: 'idle' }).sidecar.sequences, null);

      const { sidecar, warnings } = parse({ sequences: [3, { name: 'ok', from: 1 }] });

      assert.deepEqual(sidecar.sequences?.map((sequence) => sequence.name), ['ok']);
      assert.equal(warnings.length, 1);
    });

    void test('an unknown version still reads the settings', () => {
      const { sidecar, warnings } = parse({ version: 2, scale: 4 });

      assert.equal(sidecar.scale, 4);
      assert.match(warnings[0], /unknown version 2/);
    });
  });
});

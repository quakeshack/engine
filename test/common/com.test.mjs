import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import COM from '../../source/engine/common/Com.ts';

/**
 * Builds a COM with silent services and the given build config.
 * @param {object | undefined} [buildConfig] the build config the COM reads
 * @returns {COM} the file system under test
 */
function createCom(buildConfig = undefined) {
  return new COM({
    con: { Print() {}, DPrint() {}, PrintWarning() {}, PrintError() {}, PrintSuccess() {} },
    sys: { Print() {}, FloatTime: () => 0 },
    buildConfig: () => buildConfig,
    urls: () => undefined,
  });
}

/**
 * Builds a build config for the tests.
 * @param {object} [overrides] fields to replace
 * @returns {object} the build config
 */
function createBuildConfig(overrides = {}) {
  return {
    mode: 'production',
    timestamp: '2026-04-11T00:00:00.000Z',
    commitHash: null,
    gameDir: null,
    baseDir: null,
    ...overrides,
  };
}

void describe('COM', () => {
  void describe('DefaultExtension', () => {
    void test('appends extension when path has none', () => {
      assert.equal(COM.DefaultExtension('maps/e1m1', '.bsp'), 'maps/e1m1.bsp');
    });

    void test('does not append when path already has an extension', () => {
      assert.equal(COM.DefaultExtension('maps/e1m1.bsp', '.lit'), 'maps/e1m1.bsp');
    });

    void test('does not treat directory slashes as extensions', () => {
      assert.equal(COM.DefaultExtension('gfx/env/sky', '.tga'), 'gfx/env/sky.tga');
    });

    void test('ignores dots that appear only in parent directory names', () => {
      assert.equal(COM.DefaultExtension('maps.v1/e1m1', '.bsp'), 'maps.v1/e1m1.bsp');
    });
  });

  void describe('instance access to the pure helpers', () => {
    void test('reach the same functions as the static ones', () => {
      const com = createCom();

      assert.equal(com.Parse, COM.Parse);
      assert.equal(com.ParseEntityLump, COM.ParseEntityLump);
      assert.equal(com.DefaultExtension, COM.DefaultExtension);
    });
  });

  void describe('Parse', () => {
    void test('parses a simple token', () => {
      const result = COM.Parse('hello world');
      assert.equal(result.token, 'hello');
      assert.equal(result.data?.trim(), 'world');
    });

    void test('returns null data when input is exhausted', () => {
      const result = COM.Parse('');
      assert.equal(result.token, '');
      assert.equal(result.data, null);
    });

    void test('parses a quoted string as a single token', () => {
      const result = COM.Parse('"hello world" rest');
      assert.equal(result.token, 'hello world');
      assert.equal(result.data?.trim(), 'rest');
    });

    void test('skips // line comments', () => {
      const result = COM.Parse('// comment\ntoken');
      assert.equal(result.token, 'token');
    });

    void test('skips leading whitespace', () => {
      const result = COM.Parse('   spaced');
      assert.equal(result.token, 'spaced');
    });

    void test('skips multiple leading comments before reading token', () => {
      const result = COM.Parse('// first\n// second\ntoken value');
      assert.equal(result.token, 'token');
      assert.equal(result.data?.trim(), 'value');
    });

    void test('returns remainder for unterminated quoted string', () => {
      const result = COM.Parse('"unterminated');
      assert.equal(result.token, 'unterminated');
      assert.equal(result.data, '');
    });
  });

  void describe('CheckParm / GetParm', () => {
    void test('CheckParm returns index when parameter exists', () => {
      const com = createCom();

      com.argv = ['quake', '-game', 'hipnotic', '-developer'];

      assert.equal(com.CheckParm('-game'), 1);
      assert.equal(com.CheckParm('-developer'), 3);
      assert.equal(com.CheckParm('-missing'), null);
    });

    void test('GetParm returns the value following the flag', () => {
      const com = createCom();

      com.argv = ['quake', '-game', 'hipnotic', '-developer'];

      assert.equal(com.GetParm('-game'), 'hipnotic');
      assert.equal(com.GetParm('-developer'), null); // no value after last flag
      assert.equal(com.GetParm('-missing'), null);
    });
  });

  void describe('InitArgv', () => {
    void test('populates argv and detects -rogue flag', () => {
      const com = createCom();

      com.InitArgv(['quake', '-rogue']);

      assert.equal(com.rogue, true);
      assert.equal(com.standard_quake, false);
      assert.equal(com.argv[0], 'quake');
    });

    void test('-safe appends disable flags', () => {
      const com = createCom();

      com.InitArgv(['quake', '-safe']);

      assert.ok(com.argv.includes('-nosound'));
      assert.ok(com.argv.includes('-nocdaudio'));
      assert.ok(com.argv.includes('-nomouse'));
    });
  });

  void describe('InitFilesystem', () => {
    void test('uses the build-config base directory when no -basedir argument is provided', async () => {
      const com = createCom(createBuildConfig({ baseDir: 'lq1' }));

      com.argv = ['quake'];
      await com.InitFilesystem();

      assert.deepEqual(com.searchpaths.map((search) => search.filename), ['lq1']);
      assert.equal(com.gamedir?.[0].filename, 'lq1');
    });

    void test('prefers the command-line -basedir argument over the build-config fallback', async () => {
      const com = createCom(createBuildConfig({ baseDir: 'lq1' }));

      com.argv = ['quake', '-basedir', 'id1'];
      await com.InitFilesystem();

      assert.deepEqual(com.searchpaths.map((search) => search.filename), ['id1']);
      assert.equal(com.gamedir?.[0].filename, 'id1');
    });

    void test('layers the build-config game directory on top of the effective base directory', async () => {
      const com = createCom(createBuildConfig({ gameDir: 'hellwave', baseDir: 'lq1' }));

      com.argv = ['quake'];
      await com.InitFilesystem();

      assert.deepEqual(com.searchpaths.map((search) => search.filename), ['lq1', 'hellwave']);
      assert.equal(com.gamedir?.[0].filename, 'hellwave');
      assert.equal(com.game, 'hellwave');
      assert.equal(com.modified, true);
    });

    void test('keeps the state of one COM apart from another', async () => {
      const first = createCom(createBuildConfig({ baseDir: 'lq1' }));
      const second = createCom();

      first.argv = ['quake'];
      await first.InitFilesystem();

      assert.deepEqual(second.searchpaths, []);
    });
  });
});

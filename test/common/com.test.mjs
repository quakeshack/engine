import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import COM from '../../source/engine/common/Com.ts';
import { registry } from '../../source/engine/registry.ts';
import { defaultMockRegistry, withMockRegistry } from '../physics/fixtures.mjs';

/**
 *
 * @param searchpaths
 */
function cloneSearchPaths(searchpaths) {
  if (searchpaths === null) {
    return null;
  }

  return searchpaths.map((search) => ({
    filename: search.filename,
    pack: search.pack.map((pack) => [...pack]),
  }));
}

/**
 *
 * @param overrides
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

/**
 *
 * @param callback
 */
async function withFilesystemState(callback) {
  const savedState = {
    argv: [...COM.argv],
    searchpaths: cloneSearchPaths(COM.searchpaths),
    hipnotic: COM.hipnotic,
    rogue: COM.rogue,
    standardQuake: COM.standard_quake,
    modified: COM.modified,
    gamedir: cloneSearchPaths(COM.gamedir),
    game: COM.game,
    buildConfig: registry.buildConfig,
  };

  COM.argv = ['quake'];
  COM.searchpaths = [];
  COM.hipnotic = false;
  COM.rogue = false;
  COM.standard_quake = true;
  COM.modified = false;
  COM.gamedir = null;
  COM.game = 'id1';
  registry.buildConfig = undefined;

  try {
    await callback();
  } finally {
    COM.argv = savedState.argv;
    COM.searchpaths = savedState.searchpaths ?? [];
    COM.hipnotic = savedState.hipnotic;
    COM.rogue = savedState.rogue;
    COM.standard_quake = savedState.standardQuake;
    COM.modified = savedState.modified;
    COM.gamedir = savedState.gamedir;
    COM.game = savedState.game;
    registry.buildConfig = savedState.buildConfig;
  }
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
    const savedArgv = [...COM.argv];

    void test('CheckParm returns index when parameter exists', () => {
      COM.argv = ['quake', '-game', 'hipnotic', '-developer'];
      try {
        assert.equal(COM.CheckParm('-game'), 1);
        assert.equal(COM.CheckParm('-developer'), 3);
        assert.equal(COM.CheckParm('-missing'), null);
      } finally {
        COM.argv = savedArgv;
      }
    });

    void test('GetParm returns the value following the flag', () => {
      COM.argv = ['quake', '-game', 'hipnotic', '-developer'];
      try {
        assert.equal(COM.GetParm('-game'), 'hipnotic');
        assert.equal(COM.GetParm('-developer'), null); // no value after last flag
        assert.equal(COM.GetParm('-missing'), null);
      } finally {
        COM.argv = savedArgv;
      }
    });
  });

  void describe('InitArgv', () => {
    void test('populates argv and detects -rogue flag', () => {
      const savedArgv = [...COM.argv];
      const savedRogue = COM.rogue;
      const savedStdQuake = COM.standard_quake;
      try {
        COM.argv = [];
        COM.rogue = false;
        COM.standard_quake = true;
        COM.InitArgv(['quake', '-rogue']);
        assert.equal(COM.rogue, true);
        assert.equal(COM.standard_quake, false);
        assert.equal(COM.argv[0], 'quake');
      } finally {
        COM.argv = savedArgv;
        COM.rogue = savedRogue;
        COM.standard_quake = savedStdQuake;
      }
    });

    void test('-safe appends disable flags', () => {
      const savedArgv = [...COM.argv];
      try {
        COM.argv = [];
        COM.InitArgv(['quake', '-safe']);
        assert.ok(COM.argv.includes('-nosound'));
        assert.ok(COM.argv.includes('-nocdaudio'));
        assert.ok(COM.argv.includes('-nomouse'));
      } finally {
        COM.argv = savedArgv;
      }
    });
  });

  void describe('InitFilesystem', () => {
    void test('uses the build-config base directory when no -basedir argument is provided', async () => {
      await withMockRegistry({
        ...defaultMockRegistry(),
        COM,
      }, async () => {
        await withFilesystemState(async () => {
          registry.buildConfig = createBuildConfig({ baseDir: 'lq1' });

          await COM.InitFilesystem();

          assert.deepEqual(COM.searchpaths.map((search) => search.filename), ['lq1']);
          assert.equal(COM.gamedir?.[0].filename, 'lq1');
        });
      });
    });

    void test('prefers the command-line -basedir argument over the build-config fallback', async () => {
      await withMockRegistry({
        ...defaultMockRegistry(),
        COM,
      }, async () => {
        await withFilesystemState(async () => {
          COM.argv = ['quake', '-basedir', 'id1'];
          registry.buildConfig = createBuildConfig({ baseDir: 'lq1' });

          await COM.InitFilesystem();

          assert.deepEqual(COM.searchpaths.map((search) => search.filename), ['id1']);
          assert.equal(COM.gamedir?.[0].filename, 'id1');
        });
      });
    });

    void test('layers the build-config game directory on top of the effective base directory', async () => {
      await withMockRegistry({
        ...defaultMockRegistry(),
        COM,
      }, async () => {
        await withFilesystemState(async () => {
          registry.buildConfig = createBuildConfig({
            gameDir: 'hellwave',
            baseDir: 'lq1',
          });

          await COM.InitFilesystem();

          assert.deepEqual(COM.searchpaths.map((search) => search.filename), ['lq1', 'hellwave']);
          assert.equal(COM.gamedir?.[0].filename, 'hellwave');
          assert.equal(COM.game, 'hellwave');
          assert.equal(COM.modified, true);
        });
      });
    });
  });
});

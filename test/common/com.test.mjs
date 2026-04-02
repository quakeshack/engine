import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import COM from '../../source/engine/common/Com.ts';

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
});

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import ServerCvarMirror from '../../source/engine/client/ServerCvarMirror.ts';
import Cvar from '../../source/engine/common/Cvar.ts';

const ARCHIVE = Cvar.FLAG.ARCHIVE;
const SERVER = Cvar.FLAG.SERVER;

/**
 * @param {string} name name
 * @param {string} value value on the server
 * @param {number} [flags] flags on the server
 * @returns {{ name: string, value: string, flags: number, description: string | null }} a description as the server sends it
 */
function description(name, value, flags = SERVER, text = null) {
  return { name, value, flags, description: text };
}

/**
 * @returns {{ mirror: ServerCvarMirror, sent: Array<[string, string]> }} a mirror and what it sent to the server
 */
function createMirror() {
  const sent = [];

  return { mirror: new ServerCvarMirror((name, value) => sent.push([name, value])), sent };
}

void describe('ServerCvarMirror', () => {
  beforeEach(() => {
    Cvar.Shutdown();
  });

  afterEach(() => {
    Cvar.Shutdown();
  });

  void describe('variables only the server has', () => {
    void test('exist as ordinary cvars with the flags, value and description of the server', () => {
      const { mirror } = createMirror();

      mirror.attach([description('sv_gravity', '800', SERVER | ARCHIVE, 'How strong gravity is.')]);
      mirror.stop();

      const cvar = Cvar.FindVar('sv_gravity');

      assert.notEqual(cvar, null);
      assert.equal(cvar.string, '800');
      assert.equal(cvar.value, 800);
      assert.equal(cvar.flags, SERVER | ARCHIVE);
      assert.equal(cvar.description, 'How strong gravity is.');
    });

    void test('are written to the configuration when the server flags them as archive', () => {
      const { mirror } = createMirror();

      mirror.attach([description('sv_friction', '4', SERVER | ARCHIVE)]);
      mirror.stop();

      assert.match(Cvar.WriteVariables(), /seta "sv_friction" "4"/);
    });

    void test('are not sent to the server just for being created', () => {
      const { mirror, sent } = createMirror();

      mirror.attach([description('sv_gravity', '800')]);
      mirror.stop();

      assert.deepEqual(sent, []);
    });

    void test('send a change made here to the server', () => {
      const { mirror, sent } = createMirror();

      mirror.attach([description('sv_gravity', '800')]);
      Cvar.FindVar('sv_gravity').set('400');
      mirror.stop();

      assert.deepEqual(sent, [['sv_gravity', '400']]);
    });

    void test('take a change of the server without sending it back', () => {
      const { mirror, sent } = createMirror();

      mirror.attach([description('sv_gravity', '800')]);
      mirror.remoteChanged('sv_gravity', '200');
      mirror.stop();

      assert.equal(Cvar.FindVar('sv_gravity').string, '200');
      assert.deepEqual(sent, []);
    });

    void test('come in when the server registers them later', () => {
      const { mirror } = createMirror();

      mirror.attach([]);
      mirror.register(description('hw_maxplayers', '4'));
      mirror.stop();

      assert.equal(Cvar.FindVar('hw_maxplayers').string, '4');
    });

    void test('are marked read-only when the server is gone, keeping their values', () => {
      const { mirror } = createMirror();

      mirror.attach([description('sv_gravity', '800', SERVER | ARCHIVE)]);
      mirror.markInactive();
      mirror.stop();

      const cvar = Cvar.FindVar('sv_gravity');

      assert.equal(cvar.string, '800');
      assert.ok((cvar.flags & Cvar.FLAG.READONLY) !== 0);
      assert.ok((cvar.flags & ARCHIVE) !== 0);
    });
  });

  void describe('variables both sides have', () => {
    void test('keep the value of this side and tell the server about it', () => {
      const own = new Cvar('developer', '1');
      const { mirror, sent } = createMirror();

      mirror.attach([description('developer', '0', Cvar.FLAG.NONE)]);
      mirror.stop();

      assert.equal(own.string, '1');
      assert.deepEqual(sent, [['developer', '1']]);
    });

    void test('say nothing when both agree', () => {
      new Cvar('developer', '0');
      const { mirror, sent } = createMirror();

      mirror.attach([description('developer', '0', Cvar.FLAG.NONE)]);
      mirror.stop();

      assert.deepEqual(sent, []);
    });

    void test('follow in both directions', () => {
      const own = new Cvar('developer', '0');
      const { mirror, sent } = createMirror();

      mirror.attach([description('developer', '0', Cvar.FLAG.NONE)]);
      own.set('1');
      mirror.remoteChanged('developer', '2');
      mirror.stop();

      assert.deepEqual(sent, [['developer', '1']]);
      assert.equal(own.string, '2');
    });

    void test('are not marked read-only when the server is gone, they belong to this side', () => {
      const own = new Cvar('developer', '0');
      const { mirror } = createMirror();

      mirror.attach([description('developer', '0', Cvar.FLAG.NONE)]);
      mirror.markInactive();
      mirror.stop();

      assert.equal((own.flags & Cvar.FLAG.READONLY), 0);
    });
  });

  void describe('what is not mirrored', () => {
    void test('a variable of this side the server never heard of stays private', () => {
      const own = new Cvar('volume', '0.7');
      const { mirror, sent } = createMirror();

      mirror.attach([description('sv_gravity', '800')]);
      own.set('0.2');
      mirror.stop();

      assert.deepEqual(sent, []);
    });

    void test('a change reported for an unknown variable is ignored', () => {
      const { mirror } = createMirror();

      mirror.attach([]);

      assert.doesNotThrow(() => { mirror.remoteChanged('nothing_here', '1'); });
      mirror.stop();
    });

    void test('nothing is sent once stopped', () => {
      const { mirror, sent } = createMirror();

      mirror.attach([description('sv_gravity', '800')]);
      mirror.stop();
      Cvar.FindVar('sv_gravity').set('1');

      assert.deepEqual(sent, []);
    });
  });
});

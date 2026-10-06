import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { SzBuffer, registerClientDeserializer, registerSerializableType } from '../../source/engine/network/MSG.ts';
import { UserCmd, button } from '../../source/engine/network/Protocol.ts';

void describe('SzBuffer', () => {
  void describe('hasRoom', () => {
    void test('reports room based on the buffer\'s actual maxsize, not a fixed margin', () => {
      const buffer = new SzBuffer(16384, 'hasRoom');

      assert.equal(buffer.hasRoom(16384), true);
      assert.equal(buffer.hasRoom(16385), false);

      buffer.writeByte(1);
      buffer.cursize = 16000; // simulate a busy frame well past the old stale 1009-byte check

      assert.equal(buffer.hasRoom(384), true);
      assert.equal(buffer.hasRoom(385), false);
    });

    void test('reflects room left after writes consume cursize', () => {
      const buffer = new SzBuffer(32, 'hasRoom writes');

      assert.equal(buffer.hasRoom(32), true);

      buffer.writeLong(1);
      buffer.writeLong(2);

      assert.equal(buffer.cursize, 8);
      assert.equal(buffer.hasRoom(24), true);
      assert.equal(buffer.hasRoom(25), false);
    });
  });

  void test('round-trips delta user commands', () => {
    const from = new UserCmd();
    const to = new UserCmd();

    from.msec = 8;
    from.forwardmove = 100;
    from.angles.set([5, 10, 15]);

    to.set(from);
    to.msec = 16;
    to.forwardmove = 200;
    to.sidemove = -40;
    to.upmove = 12;
    to.angles.set([45, 90, 135]);
    to.buttons = button.attack;
    to.impulse = 7;

    const buffer = new SzBuffer(128, 'delta-usercmd');

    buffer.writeDeltaUsercmd(from, to);
    buffer.beginReading();

    const decoded = buffer.readDeltaUsercmd(from);

    assert.equal(decoded.equals(to), true);
  });

  void test('round-trips built-in serializable values', () => {
    const buffer = new SzBuffer(256, 'serializables');
    const values = [
      'quake',
      255,
      -12,
      12.5,
      true,
      false,
      null,
      new Vector(1, 2, 3),
      [1, 'two', null],
    ];

    buffer.writeSerializables(values);
    buffer.beginReading();

    const decoded = buffer.readSerializablesOnClient();

    assert.equal(decoded[0], 'quake');
    assert.equal(decoded[1], 255);
    assert.equal(decoded[2], -12);
    assert.equal(decoded[3], 12.5);
    assert.equal(decoded[4], true);
    assert.equal(decoded[5], false);
    assert.equal(decoded[6], null);
    assert.ok(decoded[7] instanceof Vector);
    assert.deepEqual(Array.from(decoded[7]), [1, 2, 3]);
    assert.deepEqual(decoded[8], [1, 'two', null]);
  });
});

void describe('registerClientDeserializer', () => {
  class Token {
    constructor(value) {
      this.value = value;
    }
  }

  registerSerializableType(Token, {
    serialize: (sz, token) => sz.writeShort(token.value),
    deserializeOnServer: (sz) => new Token(sz.readShort()),
  });

  /**
   * Writes a token into a fresh buffer, ready to be read back.
   * @param {number} value the token's value
   * @returns {SzBuffer} the buffer
   */
  function writeToken(value) {
    const buffer = new SzBuffer(64, 'token');

    buffer.writeSerializables([new Token(value)]);

    return buffer;
  }

  void test('refuses to read a type on the client until its client side is registered', () => {
    assert.throws(() => writeToken(7).readSerializablesOnClient(), /no client deserializer/);
  });

  void test('reads the type on the client once its client side is registered', () => {
    registerClientDeserializer(Token, (sz) => ({ clientValue: sz.readShort() }));

    assert.deepEqual(writeToken(7).readSerializablesOnClient(), [{ clientValue: 7 }]);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import { UserCmd, button } from '../../source/engine/network/Protocol.ts';

void describe('SzBuffer', () => {
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

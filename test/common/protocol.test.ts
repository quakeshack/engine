import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Protocol from '../../source/engine/network/Protocol.ts';

void describe('Protocol', () => {
  // A version change breaks every connected peer, so it has to be a deliberate edit here too.
  void test('stays at protocol version 45', () => {
    assert.equal(Protocol.version, 45);
  });

  // The entity update flag word was 16 bits wide until protocol 44 and every bit of it was in use: `u.sequence` is the
  // first that does not fit, which is why the word is written as 32 bits (`writeUint32`, `readUint32`).
  void test('has an entity update bit that does not fit in 16 bits, and no two bits are the same', () => {
    const bits = Object.values(Protocol.u).filter((value): value is number => typeof value === 'number');

    assert.ok(bits.every((bit) => bit > 0) && Math.max(...bits) > 0xffff);
    assert.equal(new Set(bits).size, bits.length);
    assert.equal(bits.reduce((all, bit) => all | bit, 0) >>> 0, 0x3ffff);
  });

  void test('names the fields of the sequence block by distinct bits that fit in the byte the block starts with', () => {
    const fields = Object.values(Protocol.sequenceField).filter((value): value is number => typeof value === 'number');

    assert.equal(new Set(fields).size, fields.length);
    assert.ok(fields.every((field) => field > 0 && field <= 0xff && (field & (field - 1)) === 0));
  });

  void test('copies and resets user commands without aliasing vectors', () => {
    const command = new Protocol.UserCmd();

    command.msec = 16;
    command.forwardmove = 200;
    command.sidemove = -50;
    command.upmove = 10;
    command.angles.set([1, 2, 3]);
    command.buttons = Protocol.button.attack;
    command.impulse = 7;

    const copy = command.copy();

    assert.notStrictEqual(copy, command);
    assert.notStrictEqual(copy.angles, command.angles);
    assert.equal(copy.equals(command), true);

    command.reset();

    assert.equal(command.msec, 0);
    assert.equal(command.forwardmove, 0);
    assert.equal(command.sidemove, 0);
    assert.equal(command.upmove, 0);
    assert.equal(command.buttons, 0);
    assert.equal(command.impulse, 0);
    assert.deepEqual(Array.from(command.angles), [0, 0, 0]);
  });
});

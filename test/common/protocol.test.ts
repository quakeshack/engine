import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as Protocol from '../../source/engine/network/Protocol.ts';

void describe('Protocol', () => {
  void test('keeps the expected command and flag bit values', () => {
    assert.equal(Protocol.version, 42);
    assert.equal(Protocol.u.classname, 1 << 0);
    assert.equal(Protocol.su.moveack, 1 << 8);
    assert.equal(Protocol.clc.stringcmd, 4);
    assert.equal(Protocol.cm.CM_IMPULSE, 1 << 6);
    assert.equal(Protocol.pf.PF_VELOCITY, 1 << 12);
    assert.equal(Protocol.button.attack, 1);
    assert.equal(Protocol.svc.clientevent, 108);
    assert.equal(Protocol.serializableTypes.null, 6);
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

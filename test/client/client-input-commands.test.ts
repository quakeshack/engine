import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import Cmd from '../../source/engine/common/Cmd.ts';
import type Cvar from '../../source/engine/common/Cvar.ts';
import clientCvars from '../../source/engine/client/ClientCvars.ts';
import ClientInput, { kbutton, kbuttons } from '../../source/engine/client/ClientInput.ts';
import PitchDrift from '../../source/engine/client/view/PitchDrift.ts';
import { patchMembers } from '../support/clientState.ts';
import '../support/consoleBridge.ts';

void describe('ClientInput commands', () => {
  let restores: Array<() => void> = [];
  let driftStarts = 0;

  beforeEach(() => {
    Cmd.Shutdown();
    ClientInput.Init();
    ClientInput.impulse = 0;
    driftStarts = 0;

    restores = [
      patchMembers(PitchDrift, { Start() { driftStarts++; } }),
      patchMembers(clientCvars, { lookspring: { value: 1 } as Cvar }),
    ];
  });

  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }

    Cmd.Shutdown();
  });

  void describe('+<button> <key>', () => {
    void test('puts the key down and presses the button', () => {
      void Cmd.ExecuteString('+forward 5');

      const button = kbuttons[kbutton.forward];

      assert.deepEqual(button.down, [5, 0]);
      // bit 0 is held, bit 1 is pressed this frame
      assert.equal(button.state, 3);
    });

    void test('holds a second key beside the first', () => {
      void Cmd.ExecuteString('+forward 5');
      void Cmd.ExecuteString('+forward 7');

      assert.deepEqual(kbuttons[kbutton.forward].down, [5, 7]);
    });

    void test('ignores the same key going down again', () => {
      void Cmd.ExecuteString('+forward 5');
      void Cmd.ExecuteString('+forward 5');

      assert.deepEqual(kbuttons[kbutton.forward].down, [5, 0]);
    });

    void test('ignores a third key', () => {
      void Cmd.ExecuteString('+forward 5');
      void Cmd.ExecuteString('+forward 7');
      void Cmd.ExecuteString('+forward 9');

      assert.deepEqual(kbuttons[kbutton.forward].down, [5, 7]);
    });

    void test('uses -1 for a button typed in the console without a key', () => {
      void Cmd.ExecuteString('+jump');

      assert.deepEqual(kbuttons[kbutton.jump].down, [-1, 0]);
    });

    void test('leaves the buttons of other names alone', () => {
      void Cmd.ExecuteString('+forward 5');

      assert.deepEqual(kbuttons[kbutton.back].down, [0, 0]);
      assert.equal(kbuttons[kbutton.back].state, 0);
    });
  });

  void describe('-<button> <key>', () => {
    void test('releases the button once the last key is up', () => {
      void Cmd.ExecuteString('+forward 5');
      void Cmd.ExecuteString('-forward 5');

      const button = kbuttons[kbutton.forward];

      assert.deepEqual(button.down, [0, 0]);
      // no longer held (bit 0), released this frame (bit 2), the press is still counted (bit 1)
      assert.equal(button.state, 6);
    });

    void test('keeps the button held while another key of it is still down', () => {
      void Cmd.ExecuteString('+forward 5');
      void Cmd.ExecuteString('+forward 7');
      void Cmd.ExecuteString('-forward 5');

      const button = kbuttons[kbutton.forward];

      assert.deepEqual(button.down, [0, 7]);
      assert.equal(button.state & 1, 1);
    });

    void test('ignores a key that was not down', () => {
      void Cmd.ExecuteString('+forward 5');
      void Cmd.ExecuteString('-forward 9');

      assert.deepEqual(kbuttons[kbutton.forward].down, [5, 0]);
      assert.equal(kbuttons[kbutton.forward].state, 3);
    });

    void test('releases every key at once when typed in the console without a key', () => {
      void Cmd.ExecuteString('+forward 5');
      void Cmd.ExecuteString('+forward 7');
      void Cmd.ExecuteString('-forward');

      assert.deepEqual(kbuttons[kbutton.forward].down, [0, 0]);
      assert.equal(kbuttons[kbutton.forward].state, 4);
    });
  });

  void describe('mlook', () => {
    void test('+mlook puts the mouse look button down like any other', () => {
      void Cmd.ExecuteString('+mlook 12');

      assert.deepEqual(kbuttons[kbutton.mlook].down, [12, 0]);
      assert.equal(driftStarts, 0);
    });

    void test('-mlook releases the button and recenters the view when lookspring is on', () => {
      void Cmd.ExecuteString('+mlook 12');
      void Cmd.ExecuteString('-mlook 12');

      assert.deepEqual(kbuttons[kbutton.mlook].down, [0, 0]);
      assert.equal(driftStarts, 1);
    });

    void test('-mlook does not recenter the view when lookspring is off', () => {
      restores.push(patchMembers(clientCvars, { lookspring: { value: 0 } as Cvar }));

      void Cmd.ExecuteString('+mlook 12');
      void Cmd.ExecuteString('-mlook 12');

      assert.equal(driftStarts, 0);
    });

    void test('-mlook does not recenter the view while another key of it is down', () => {
      void Cmd.ExecuteString('+mlook 12');
      void Cmd.ExecuteString('+mlook 13');
      void Cmd.ExecuteString('-mlook 12');

      assert.equal(driftStarts, 0);
    });
  });

  void describe('impulse', () => {
    void test('remembers the code for the next move message', () => {
      void Cmd.ExecuteString('impulse 7');

      assert.equal(ClientInput.impulse, 7);
    });

    void test('leaves it alone without a code', () => {
      ClientInput.impulse = 3;

      void Cmd.ExecuteString('impulse');

      assert.equal(ClientInput.impulse, 3);
    });
  });
});

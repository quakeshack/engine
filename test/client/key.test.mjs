import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import Key from '../../source/engine/client/Key.ts';

void describe('Key', () => {
  void test('StringToKeynum resolves named and printable keys', () => {
    assert.equal(Key.StringToKeynum('ENTER'), K.ENTER);
    assert.equal(Key.StringToKeynum('a'), 97);
    assert.equal(Key.StringToKeynum('not-a-key'), null);
  });

  void test('WriteBindings serializes active bindings with readable key names', () => {
    const previousBindings = [...Key.bindings];

    try {
      Key.bindings = [];
      Key.bindings[K.ENTER] = '+jump';
      Key.bindings[97] = 'say hello';

      assert.equal(
        Key.WriteBindings(),
        'bind "ENTER" "+jump"\nbind "a" "say hello"',
      );
    } finally {
      Key.bindings = previousBindings;
    }
  });
});

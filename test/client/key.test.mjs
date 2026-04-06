import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { K } from '../../source/shared/Keys.ts';
import Key, { KeyDestination } from '../../source/engine/client/Key.ts';

void describe('Key', () => {
  void describe('StringToKeynum', () => {
    void test('resolves named special keys', () => {
      assert.equal(Key.StringToKeynum('ENTER'), K.ENTER);
      assert.equal(Key.StringToKeynum('ESCAPE'), K.ESCAPE);
      assert.equal(Key.StringToKeynum('SPACE'), K.SPACE);
      assert.equal(Key.StringToKeynum('SEMICOLON'), ';'.charCodeAt(0));
    });

    void test('resolves single printable characters by char code', () => {
      assert.equal(Key.StringToKeynum('a'), 97);
      assert.equal(Key.StringToKeynum('Z'), 90);
    });

    void test('is case-insensitive for named keys', () => {
      assert.equal(Key.StringToKeynum('enter'), K.ENTER);
      assert.equal(Key.StringToKeynum('Escape'), K.ESCAPE);
    });

    void test('returns null for unknown names', () => {
      assert.equal(Key.StringToKeynum('not-a-key'), null);
      assert.equal(Key.StringToKeynum('BOGUS'), null);
    });
  });

  void describe('KeynumToString', () => {
    void test('returns printable character for ASCII range', () => {
      assert.equal(Key.KeynumToString(97), 'a');
      assert.equal(Key.KeynumToString(65), 'A');
    });

    void test('returns canonical name for special keys', () => {
      assert.equal(Key.KeynumToString(K.ENTER), 'ENTER');
      assert.equal(Key.KeynumToString(K.ESCAPE), 'ESCAPE');
    });

    void test('returns marker for unrecognized key codes', () => {
      assert.equal(Key.KeynumToString(999), '<UNKNOWN KEYNUM>');
    });
  });

  void describe('WriteBindings', () => {
    void test('serializes active bindings with readable key names', () => {
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

    void test('skips null and undefined slots', () => {
      const previousBindings = [...Key.bindings];
      try {
        Key.bindings = [];
        Key.bindings[10] = null;
        Key.bindings[97] = 'test';
        assert.equal(Key.WriteBindings(), 'bind "a" "test"');
      } finally {
        Key.bindings = previousBindings;
      }
    });
  });

  void describe('BindingToString', () => {
    void test('finds the first key bound to a command', () => {
      const previousBindings = [...Key.bindings];
      try {
        Key.bindings = [];
        Key.bindings[K.ENTER] = '+jump';
        assert.equal(Key.BindingToString('+jump'), 'ENTER');
      } finally {
        Key.bindings = previousBindings;
      }
    });

    void test('returns null when no key is bound to the command', () => {
      assert.equal(Key.BindingToString('nonexistent_command'), null);
    });
  });

  void describe('KeyDestination', () => {
    void test('enum values match expected constants', () => {
      assert.equal(KeyDestination.game, 0);
      assert.equal(KeyDestination.console, 1);
      assert.equal(KeyDestination.message, 2);
      assert.equal(KeyDestination.menu, 3);
    });

    void test('destination defaults to console', () => {
      assert.equal(Key.destination, KeyDestination.console);
    });
  });
});

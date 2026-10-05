import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import ClientSerialization from '../../source/shared/ClientSerialization.ts';
import Vector from '../../source/shared/Vector.ts';

void describe('ClientSerialization', () => {
  void describe('serialize/deserialize round trip', () => {
    void test('round-trips primitives (string, number, boolean, null)', () => {
      const data = ClientSerialization.serialize({ a: 'hello', b: 42, c: true, d: null });

      assert.deepEqual(data, {
        a: ['P', 'hello'],
        b: ['P', 42],
        c: ['P', true],
        d: ['P', null],
      });
      assert.deepEqual(ClientSerialization.deserialize(data), { a: 'hello', b: 42, c: true, d: null });
    });

    void test('omits undefined fields entirely instead of tagging them', () => {
      const data = ClientSerialization.serialize({ a: 1, b: undefined });

      assert.deepEqual(data, { a: ['P', 1] });
      assert.equal('b' in data, false);
    });

    void test('round-trips a Vector as a tagged numeric triple', () => {
      const data = ClientSerialization.serialize({ origin: new Vector(1, 2, 3) });

      assert.deepEqual(data, { origin: ['V', 1, 2, 3] });

      const restored = ClientSerialization.deserialize(data);
      assert.ok(restored.origin instanceof Vector);
      assert.deepEqual([...restored.origin], [1, 2, 3]);
    });

    void test('round-trips an array of primitives', () => {
      const data = ClientSerialization.serialize({ list: [1, 'two', false] });

      assert.deepEqual(data, { list: ['A', [['P', 1], ['P', 'two'], ['P', false]]] });
      assert.deepEqual(ClientSerialization.deserialize(data), { list: [1, 'two', false] });
    });

    void test('round-trips a nested plain object', () => {
      const data = ClientSerialization.serialize({ state: 'smoke', enteredAt: -0.3, sequence: { state: 'fade', enteredAt: 1.2 } });

      assert.deepEqual(data, {
        state: ['P', 'smoke'],
        enteredAt: ['P', -0.3],
        sequence: ['S', { state: ['P', 'fade'], enteredAt: ['P', 1.2] }],
      });
      assert.deepEqual(ClientSerialization.deserialize(data), {
        state: 'smoke',
        enteredAt: -0.3,
        sequence: { state: 'fade', enteredAt: 1.2 },
      });
    });

    void test('round-trips a mix of nested objects, arrays, and vectors together', () => {
      const original = {
        dieTime: 4.7,
        origin: new Vector(10, -20, 30),
        tags: ['debris', 'wood'],
        sequence: { state: 'flash', enteredAt: -0.05 },
      };

      const restored = ClientSerialization.deserialize(ClientSerialization.serialize(original));

      assert.equal(restored.dieTime, 4.7);
      assert.ok(restored.origin instanceof Vector);
      assert.deepEqual([...restored.origin], [10, -20, 30]);
      assert.deepEqual(restored.tags, ['debris', 'wood']);
      assert.deepEqual(restored.sequence, { state: 'flash', enteredAt: -0.05 });
    });
  });
});

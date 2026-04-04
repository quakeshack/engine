import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SerializableEntity } from '../../source/shared/GameInterfaces.ts';

void describe('SerializableEntity', () => {
  void test('matches structural serializable entities via instanceof', () => {
    const entity = {
      classname: 'player',
      serialize() {
        return {};
      },
      deserialize(_data) {},
    };

    assert.equal(entity instanceof SerializableEntity, true);
  });

  void test('rejects objects that do not expose save-load methods', () => {
    const entity = {
      classname: 'player',
      serialize() {
        return {};
      },
    };

    assert.equal(entity instanceof SerializableEntity, false);
  });
});

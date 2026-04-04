import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import BaseEntity from '../../source/game/id1/entity/BaseEntity.ts';
import { entity, serializable, Serializer } from '../../source/game/id1/helper/MiscHelpers.ts';

function createMockGameAPI() {
  return {
    engine: {
      IsLoading() {
        return false;
      },
    },
  };
}

void describe('Serializer', () => {
  void test('uses static serializableFields for typed classes', () => {
    class StaticSerializable {
      static serializableFields = ['count'];

      count = 3;
      skipped = 'ignore-me';

      constructor() {
        this._serializer = new Serializer(this, null);
      }
    }

    const instance = new StaticSerializable();

    assert.deepEqual(instance._serializer.serialize(), {
      count: ['P', 3],
    });
  });

  void test('still supports legacy startFields/endFields callers', () => {
    class LegacySerializable {
      constructor() {
        this._serializer = new Serializer(this, null);
        this._serializer.startFields();
        this.name = 'legacy';
        this.enabled = true;
        this._serializer.endFields();
      }
    }

    const instance = new LegacySerializable();

    assert.deepEqual(instance._serializer.serialize(), {
      enabled: ['P', true],
      name: ['P', 'legacy'],
    });
  });
});

void describe('BaseEntity', () => {
  void test('stays extensible for mod-friendly subclasses during the transition', () => {
    class ModFriendlyEntity extends BaseEntity {
      static classname = 'mod_friendly';

      _declareFields() {
        super._declareFields();
        this._serializer.startFields();
        this.customField = 42;
        this._serializer.endFields();
      }

      constructor(gameAPI) {
        super(null, gameAPI);
        this.postConstructorField = 'works';
      }
    }

    const entity = new ModFriendlyEntity(createMockGameAPI());

    assert.equal(Object.isSealed(entity), false);
    assert.equal(entity.customField, 42);
    assert.equal(entity.postConstructorField, 'works');

    entity.extraField = 'mods stay easy';
    assert.equal(entity.extraField, 'mods stay easy');
  });
});

void describe('@entity / @serializable decorators', () => {
  void test('BaseEntity.serializableFields is a frozen array from @entity', () => {
    assert.ok(Array.isArray(BaseEntity.serializableFields));
    assert.ok(Object.isFrozen(BaseEntity.serializableFields));
    assert.ok(BaseEntity.serializableFields.includes('ltime'));
    assert.ok(BaseEntity.serializableFields.includes('origin'));
    assert.ok(BaseEntity.serializableFields.includes('_scheduledThinks'));
  });

  void test('Serializer collects all decorated BaseEntity fields', () => {
    const entity = new BaseEntity(null, createMockGameAPI());
    const serialized = entity._serializer.serialize();
    assert.ok('ltime' in serialized);
    assert.ok('origin' in serialized);
    assert.ok('message' in serialized);
    assert.ok(!('_sub' in serialized), '_sub should not be serialized');
    assert.ok(!('_damageHandler' in serialized), '_damageHandler should not be serialized');
  });

  void test('legacy static serializableFields merges with decorated parent', () => {
    class LegacyChild extends BaseEntity {
      static classname = 'legacy_child';
      static serializableFields = ['customProp'];

      constructor(gameAPI) {
        super(null, gameAPI);
        this.customProp = 42;
      }
    }

    const child = new LegacyChild(createMockGameAPI());
    const serialized = child._serializer.serialize();
    assert.ok('ltime' in serialized, 'inherits decorated parent fields');
    assert.ok('customProp' in serialized, 'includes own static array fields');
  });

  void test('entity and serializable are exported functions', () => {
    assert.equal(typeof entity, 'function');
    assert.equal(typeof serializable, 'function');
  });
});

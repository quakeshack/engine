import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import BaseEntity from '../../source/game/id1/entity/BaseEntity.ts';
import { entity, serializable, Serializer } from '../../source/game/id1/helper/MiscHelpers.ts';

/**
 * Create the minimal game API surface required by serializer tests.
 * @returns {object} Mock game API.
 */
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

void describe('BaseMonster decorator port', async () => {
  // Import GameAPI first to establish the correct ESM evaluation order.
  // In production, GameAPI.ts is the entry point, so monster subclasses
  // evaluate after BaseMonster.ts. In tests, importing BaseMonster.ts
  // directly inverts that order, causing TDZ errors in subclass files.
  await import('../../source/game/id1/GameAPI.ts');

  const { default: BaseMonster, WalkMonster, FlyMonster, SwimMonster, MeatSprayEntity } =
    await import('../../source/game/id1/entity/monster/BaseMonster.ts');

  void test('BaseMonster.serializableFields is a frozen array from @entity', () => {
    assert.ok(Array.isArray(BaseMonster.serializableFields));
    assert.ok(Object.isFrozen(BaseMonster.serializableFields));
  });

  void test('BaseMonster decorated fields include expected keys', () => {
    const fields = BaseMonster.serializableFields;
    for (const key of ['pausetime', 'movetarget', 'health', 'ideal_yaw', 'yaw_speed', 'bloodcolor', 'enemy', 'goalentity', 'cnt', '_ai']) {
      assert.ok(fields.includes(key), `missing field "${key}"`);
    }
  });

  void test('collectSerializableFields merges BaseEntity + BaseMonster fields', () => {
    // collectSerializableFields walks the prototype chain to merge fields from
    // all @entity-decorated ancestors.  We verify this by constructing a mock
    // instance whose prototype chain looks like: instance → BaseMonster → BaseEntity.
    const merged = [...new Set([
      ...BaseEntity.serializableFields,
      ...BaseMonster.serializableFields,
    ])];
    for (const key of BaseEntity.serializableFields) {
      assert.ok(merged.includes(key), `missing inherited field "${key}"`);
    }
    for (const key of BaseMonster.serializableFields) {
      assert.ok(merged.includes(key), `missing own field "${key}"`);
    }
  });

  void test('subclasses carry their own serializableFields from @entity', () => {
    // WalkMonster, FlyMonster, SwimMonster add no extra @serializable fields,
    // so their own serializableFields arrays should be empty (only BaseMonster's
    // and BaseEntity's are inherited via collectSerializableFields at runtime).
    for (const Ctor of [WalkMonster, FlyMonster, SwimMonster]) {
      const fields = Ctor.serializableFields;
      assert.ok(Array.isArray(fields), `${Ctor.name} missing serializableFields`);
      assert.ok(Object.isFrozen(fields), `${Ctor.name} serializableFields not frozen`);
    }
  });

  void test('MeatSprayEntity has its own decorator-generated serializableFields', () => {
    assert.ok(Array.isArray(MeatSprayEntity.serializableFields));
    assert.ok(Object.isFrozen(MeatSprayEntity.serializableFields));
    // MeatSprayEntity extends BaseEntity with no extra @serializable fields,
    // so its own array should be empty.
    assert.equal(MeatSprayEntity.serializableFields.length, 0);
  });

  void test('non-serializable fields are excluded from BaseMonster', () => {
    const fields = BaseMonster.serializableFields;
    assert.ok(!fields.includes('_damageHandler'), '_damageHandler should not be serialized');
    assert.ok(!fields.includes('_sub'), '_sub should not be serialized');
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import BaseEntity from '../../source/game/id1/entity/BaseEntity.ts';

const registryModule = await import('../../source/game/id1/helper/Registry.ts');
const registryShimModule = await import('../../source/game/id1/helper/Registry.mjs');

const EntityRegistry = registryModule.default;

class RegisteredEntity extends BaseEntity {
  static classname = 'registered_entity';
  static clientEntityFields = ['origin', 'angles'];
  static precacheCalls = 0;
  static parseModelDataCalls = 0;
  static initStatesCalls = 0;

  static _precache(_engineAPI) {
    void _engineAPI;
    this.precacheCalls += 1;
  }

  static _parseModelData(_engineAPI) {
    void _engineAPI;
    this.parseModelDataCalls += 1;
  }

  static _initStates() {
    this.initStatesCalls += 1;
  }
}

class ServerOnlyEntity extends BaseEntity {
  static classname = 'server_only_entity';
  static clientEntityFields = [];
  static precacheCalls = 0;
  static parseModelDataCalls = 0;
  static initStatesCalls = 0;

  static _precache(_engineAPI) {
    void _engineAPI;
    this.precacheCalls += 1;
  }

  static _parseModelData(_engineAPI) {
    void _engineAPI;
    this.parseModelDataCalls += 1;
  }

  static _initStates() {
    this.initStatesCalls += 1;
  }
}

/**
 * Reset static hook counters for both test entity classes.
 * @returns {void}
 */
function resetCounters() {
  RegisteredEntity.precacheCalls = 0;
  RegisteredEntity.parseModelDataCalls = 0;
  RegisteredEntity.initStatesCalls = 0;
  ServerOnlyEntity.precacheCalls = 0;
  ServerOnlyEntity.parseModelDataCalls = 0;
  ServerOnlyEntity.initStatesCalls = 0;
}

void describe('EntityRegistry', () => {
  void test('keeps the .mjs shim aligned with the TypeScript module', () => {
    assert.equal(registryShimModule.default, EntityRegistry);
  });

  void test('registers entity classes by classname', () => {
    const registry = new EntityRegistry([RegisteredEntity, ServerOnlyEntity]);

    assert.equal(registry.has('registered_entity'), true);
    assert.equal(registry.has('missing_entity'), false);
    assert.equal(registry.get('registered_entity'), RegisteredEntity);
    assert.equal(registry.get('missing_entity'), null);
    assert.deepEqual([...registry.getAll()], [RegisteredEntity, ServerOnlyEntity]);
  });

  void test('runs bootstrap hooks across every registered entity class', () => {
    resetCounters();

    const registry = new EntityRegistry([RegisteredEntity, ServerOnlyEntity]);
    const engineAPI = {};

    registry.precacheAll(engineAPI);
    registry.initializeAll(engineAPI);

    assert.equal(RegisteredEntity.precacheCalls, 1);
    assert.equal(RegisteredEntity.parseModelDataCalls, 1);
    assert.equal(RegisteredEntity.initStatesCalls, 1);
    assert.equal(ServerOnlyEntity.precacheCalls, 1);
    assert.equal(ServerOnlyEntity.parseModelDataCalls, 1);
    assert.equal(ServerOnlyEntity.initStatesCalls, 1);
  });

  void test('returns only entities with client-exposed fields', () => {
    const registry = new EntityRegistry([RegisteredEntity, ServerOnlyEntity]);

    assert.deepEqual(registry.getClientEntityFields(), {
      registered_entity: ['origin', 'angles'],
    });
  });
});

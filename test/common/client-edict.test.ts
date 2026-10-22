import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BaseClientEdictHandler } from '../../source/shared/ClientEdict.ts';
import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import type { ClientEngineAPI } from '../../source/engine/client/ClientEngineAPI.ts';

// The handler only keeps and hands on what it is given, so plain objects stand in for the edict and the engine API.
const asEdict = (value: object): ClientEdict => value as unknown as ClientEdict;
const asEngine = (value: object): ClientEngineAPI => value as unknown as ClientEngineAPI;

void describe('BaseClientEdictHandler', () => {
  void test('stores the provided client edict and engine API references', () => {
    const clientEdict = { num: 7 };
    const engineAPI = { Draw: 'noop' };
    const handler = new BaseClientEdictHandler(asEdict(clientEdict), asEngine(engineAPI));

    assert.equal(handler.clientEdict, clientEdict);
    assert.equal(handler.engine, engineAPI);
  });

  void test('keeps the base lifecycle hooks as no-ops', () => {
    const handler = new BaseClientEdictHandler(asEdict({}), asEngine({}));

    assert.equal((handler.spawn as () => unknown).call(handler), undefined);
    assert.equal((handler.emit as () => unknown).call(handler), undefined);
    assert.equal((handler.think as () => unknown).call(handler), undefined);
  });
});

void describe('BaseClientEdictHandler.remove', () => {
  class TestEdictHandler extends BaseClientEdictHandler {
    triggerRemove() {
      this.remove();
    }
  }

  void test('marks the underlying client edict free', () => {
    const clientEdict = { free: false, markFree() { this.free = true; } };
    const handler = new TestEdictHandler(asEdict(clientEdict), asEngine({}));

    handler.triggerRemove();

    assert.equal(clientEdict.free, true);
  });
});

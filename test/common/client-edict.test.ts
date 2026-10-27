import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BaseClientEdictHandler } from '../../source/shared/ClientEdict.ts';
import type { ClientEdict } from '../../source/engine/client/ClientEntities.ts';
import type { ClientEngineAPI } from '../../source/engine/client/ClientEngineAPI.ts';

// Only the edict's markFree is used, so plain objects stand in for the edict and the engine API.
const asEdict = (value: object): ClientEdict => value as unknown as ClientEdict;
const asEngine = (value: object): ClientEngineAPI => value as unknown as ClientEngineAPI;

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

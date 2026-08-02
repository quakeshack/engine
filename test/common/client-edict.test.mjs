import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BaseClientEdictHandler } from '../../source/shared/ClientEdict.ts';

void describe('BaseClientEdictHandler', () => {
  void test('stores the provided client edict and engine API references', () => {
    const clientEdict = { num: 7 };
    const engineAPI = { Draw: 'noop' };
    const handler = new BaseClientEdictHandler(clientEdict, engineAPI);

    assert.equal(handler.clientEdict, clientEdict);
    assert.equal(handler.engine, engineAPI);
  });

  void test('keeps the base lifecycle hooks as no-ops', () => {
    const handler = new BaseClientEdictHandler({}, {});

    assert.equal(handler.spawn(), undefined);
    assert.equal(handler.emit(), undefined);
    assert.equal(handler.think(), undefined);
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
    const handler = new TestEdictHandler(clientEdict, {});

    handler.triggerRemove();

    assert.equal(clientEdict.free, true);
  });
});

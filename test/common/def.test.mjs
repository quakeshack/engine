import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { clientConnectionState, defaultBasedir, defaultGame, gamestateVersion, limits, productName } from '../../source/engine/common/Def.ts';

void describe('common definitions', () => {
  void test('exposes the expected engine identity and defaults', () => {
    assert.equal(productName, 'QuakeShack');
    assert.equal(defaultGame, 'id1');
    assert.equal(defaultBasedir, 'id1');
    assert.equal(gamestateVersion, 2);
  });

  void test('keeps stable numeric limits and connection state values', () => {
    assert.equal(limits.edicts, 64);
    assert.equal(limits.clients, 32);
    assert.equal(limits.dlights, 32);
    assert.equal(limits.lightstyles, 64);
    assert.equal(limits.beams, 24);
    assert.equal(limits.entities, 1024);

    assert.equal(clientConnectionState.disconnected, 0);
    assert.equal(clientConnectionState.connecting, 1);
    assert.equal(clientConnectionState.connected, 2);
  });
});

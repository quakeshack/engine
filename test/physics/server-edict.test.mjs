import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ServerEdict } from '../../source/engine/server/Edict.ts';

import { defaultMockRegistry, withMockRegistry } from './fixtures.mjs';

void describe('ServerEdict', () => {
  void test('keeps getClient slot mapping separate from isClient semantics', () => {
    const reservedSlotClient = { state: 0 };

    void withMockRegistry(defaultMockRegistry({
      svs: {
        maxclients: 4,
        clients: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, reservedSlotClient],
      },
      server: {
        num_edicts: 32,
        edicts: [],
      },
    }), () => {
      const reservedWorldEdict = new ServerEdict(16);

      assert.equal(reservedWorldEdict.isClient(), false);
      assert.equal(reservedWorldEdict.getClient(), reservedSlotClient);
    });
  });
});

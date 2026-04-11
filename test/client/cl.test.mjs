import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import CL from '../../source/engine/client/CL.ts';
import { eventBus } from '../../source/engine/registry.ts';

void describe('CL.AppendChatMessage', () => {
  void test('publishes chat messages without a legacy engine HUD fallback', () => {
    const publishedMessages = [];

    const unsubscribe = eventBus.subscribe('client.chat.message', (name, message, direct) => {
      publishedMessages.push([name, message, direct]);
    });

    try {
      CL.AppendChatMessage('Ranger', 'Ready?', false);
      CL.AppendChatMessage('Ranger', 'Go.', true);

      assert.deepEqual(publishedMessages, [
        ['Ranger', 'Ready?', false],
        ['Ranger', 'Go.', true],
      ]);
    } finally {
      unsubscribe();
    }
  });
});

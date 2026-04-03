import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { eventBus, registry } from '../../source/engine/registry.mjs';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import SV from '../../source/engine/server/Server.ts';
import { ServerEntityState } from '../../source/engine/server/ServerEntityState.ts';
import { ServerMessages } from '../../source/engine/server/ServerMessages.ts';

/**
 * Installs a minimal server registry context for delta-entity message tests.
 * @returns {{ restore: () => void }} A restore handle for the mocked registry state.
 */
function installWriteDeltaEntityContext() {
  const previousCon = registry.Con;
  const previousHost = registry.Host;
  const previousSV = registry.SV;
  const previousServer = SV.server;

  registry.Con = { Print() {}, DPrint() {}, PrintWarning() {} };
  registry.Host = { frametime: 0.1 };

  SV.server = {
    ...SV.server,
    time: 1,
    gameCapabilities: [],
    clientEntityFields: {},
  };

  registry.SV = SV;
  eventBus.publish('registry.frozen');

  return {
    restore() {
      registry.Con = previousCon;
      registry.Host = previousHost;
      registry.SV = previousSV;
      SV.server = previousServer;
      eventBus.publish('registry.frozen');
    },
  };
}

void describe('ServerMessages.writeDeltaEntity', () => {
  void test('preserves the legacy opaque alpha fallback for falsy alpha values', () => {
    const context = installWriteDeltaEntityContext();

    try {
      const messages = new ServerMessages();
      const from = new ServerEntityState(1);
      const to = new ServerEntityState(1);
      const buffer = new SzBuffer(64, 'ServerMessages.writeDeltaEntity alpha fallback');

      to.effects = 7;
      to.alpha = 0;

      assert.equal(messages.writeDeltaEntity(buffer, from, to), true);

      const view = new DataView(buffer.data);
      assert.equal(view.getUint16(0, true), 1);
      assert.equal(view.getUint16(2, true), Protocol.u.effects);
      assert.equal(view.getUint8(4), 7);
      assert.equal(view.getUint8(5), 255);
    } finally {
      context.restore();
    }
  });

  void test('writes scaled alpha bytes when alpha is explicitly set', () => {
    const context = installWriteDeltaEntityContext();

    try {
      const messages = new ServerMessages();
      const from = new ServerEntityState(1);
      const to = new ServerEntityState(1);
      const buffer = new SzBuffer(64, 'ServerMessages.writeDeltaEntity alpha scaling');

      to.effects = 5;
      to.alpha = 0.5;

      assert.equal(messages.writeDeltaEntity(buffer, from, to), true);

      const view = new DataView(buffer.data);
      assert.equal(view.getUint8(4), 5);
      assert.equal(view.getUint8(5), Math.floor(0.5 * 255.0));
    } finally {
      context.restore();
    }
  });
});

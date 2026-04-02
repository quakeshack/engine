import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { eventBus, registry } from '../../source/engine/registry.mjs';
import SV from '../../source/engine/server/Server.mjs';
import { ServerClient } from '../../source/engine/server/Client.mjs';

import {
  createMockEdict,
  createMockEntity,
} from './fixtures.mjs';

/**
 * @param {{paused: boolean}} options test options
 * @returns {{client: ServerClient, entity: ReturnType<typeof createMockEntity>, restore: () => void}} test context
 */
function installReadClientMoveContext({ paused }) {
  const previousCon = registry.Con;
  const previousHost = registry.Host;
  const previousNET = registry.NET;
  const previousSV = registry.SV;
  const previousServer = SV.server;

  const entity = createMockEntity();
  const worldEdict = createMockEdict(createMockEntity());
  const playerEdict = createMockEdict(entity);
  playerEdict.num = 1;

  const byteReads = [40, Protocol.button.attack | Protocol.button.jump, 7, 9];
  const shortReads = [100, -25, 5];

  registry.Con = { Print() {}, DPrint() {} };
  registry.Host = { frametime: 0.1 };
  registry.NET = {
    message: {
      readByte() {
        return byteReads.shift() ?? 0;
      },
      readAngleVector() {
        return new Vector(1, 2, 3);
      },
      readShort() {
        return shortReads.shift() ?? 0;
      },
    },
  };
  const server = {
    ...SV.server,
    paused,
    edicts: [worldEdict, playerEdict],
  };

  SV.server = server;
  registry.SV = SV;
  eventBus.publish('registry.frozen');

  const client = new ServerClient(0);
  client.state = ServerClient.STATE.CONNECTED;

  return {
    client,
    entity,
    restore() {
      registry.Con = previousCon;
      registry.Host = previousHost;
      registry.NET = previousNET;
      registry.SV = previousSV;
      SV.server = previousServer;
      eventBus.publish('registry.frozen');
    },
  };
}

describe('SV.ReadClientMove', () => {
  test('queues movement commands while the server is running', () => {
    const context = installReadClientMoveContext({ paused: false });

    try {
      SV.ReadClientMove(context.client);

      assert.equal(context.client.pendingCmds.length, 1);
      assert.equal(context.client.cmd.msec, 40);
      assert.equal(context.client.lastMoveSequence, 9);
      assert.equal(context.entity.button0, true);
      assert.equal(context.entity.button1, false);
      assert.equal(context.entity.button2, true);
      assert.equal(context.entity.impulse, 7);
      assert.deepEqual([...context.entity.v_angle], [1, 2, 3]);
    } finally {
      context.restore();
    }
  });

  test('does not enqueue paused movement backlog', () => {
    const context = installReadClientMoveContext({ paused: true });

    try {
      SV.ReadClientMove(context.client);

      assert.equal(context.client.pendingCmds.length, 0);
      assert.equal(context.client.cmd.msec, 40);
      assert.equal(context.client.lastMoveSequence, 9);
      assert.equal(context.entity.button0, true);
      assert.equal(context.entity.button1, false);
      assert.equal(context.entity.button2, true);
      assert.equal(context.entity.impulse, 7);
      assert.deepEqual([...context.entity.v_angle], [1, 2, 3]);
    } finally {
      context.restore();
    }
  });
});

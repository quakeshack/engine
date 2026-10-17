import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';

import type Server from '../../source/engine/server/Server.ts';
import type { ServerDependencies } from '../../source/engine/server/ServerDependencies.ts';
import { createMockEdict, createMockEntity, createTestServer, type MockEntity } from '../support/fixtures.ts';

/**
 * @param options Test options.
 * @returns The test context.
 */
function createReadClientMoveContext({ paused }: { paused: boolean }): { sv: Server; client: ServerClient; entity: MockEntity } {
  const entity = createMockEntity();
  const worldEdict = createMockEdict(createMockEntity());
  const playerEdict = createMockEdict(entity, 1);

  const byteReads = [40, Protocol.button.attack | Protocol.button.jump, 7, 9];
  const shortReads = [100, -25, 5];

  const sv = createTestServer({
    // Only the message reads are answered; the rest of the network layer is not used by ReadClientMove.
    net: {
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
    } as unknown as ServerDependencies['net'],
  });

  sv.server.paused = paused;
  sv.server.edicts = [worldEdict, playerEdict];

  const client = new ServerClient(0, sv);
  client.state = ServerClient.STATE.CONNECTED;

  return { sv, client, entity };
}

void describe('SV.ReadClientMove', () => {
  void test('queues movement commands while the server is running', () => {
    const context = createReadClientMoveContext({ paused: false });

    context.sv.ReadClientMove(context.client);

    assert.equal(context.client.pendingCmds.length, 1);
    assert.equal(context.client.cmd.msec, 40);
    assert.equal(context.client.lastMoveSequence, 9);
    assert.equal(context.entity.button0, true);
    assert.equal(context.entity.button1, false);
    assert.equal(context.entity.button2, true);
    assert.equal(context.entity.impulse, 7);
    assert.deepEqual([...context.entity.v_angle!], [1, 2, 3]);
  });

  void test('does not enqueue paused movement backlog', () => {
    const context = createReadClientMoveContext({ paused: true });

    context.sv.ReadClientMove(context.client);

    assert.equal(context.client.pendingCmds.length, 0);
    assert.equal(context.client.cmd.msec, 40);
    assert.equal(context.client.lastMoveSequence, 9);
    assert.equal(context.entity.button0, true);
    assert.equal(context.entity.button1, false);
    assert.equal(context.entity.button2, true);
    assert.equal(context.entity.impulse, 7);
    assert.deepEqual([...context.entity.v_angle!], [1, 2, 3]);
  });
});

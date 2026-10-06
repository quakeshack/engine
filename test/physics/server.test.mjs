import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Vector from '../../source/shared/Vector.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';

import { createMockEdict, createMockEntity, createTestServer } from './fixtures.mjs';

/** @typedef {import('../../source/engine/server/Server.ts').default} Server */

/**
 * @param {{paused: boolean}} options test options
 * @returns {{sv: Server, client: ServerClient, entity: ReturnType<typeof createMockEntity>}} test context
 */
function createReadClientMoveContext({ paused }) {
  const entity = createMockEntity();
  const worldEdict = createMockEdict(createMockEntity());
  const playerEdict = createMockEdict(entity);
  playerEdict.num = 1;

  const byteReads = [40, Protocol.button.attack | Protocol.button.jump, 7, 9];
  const shortReads = [100, -25, 5];

  const sv = createTestServer({
    net: /** @type {any} */ ({
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
    }),
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
    assert.deepEqual([...context.entity.v_angle], [1, 2, 3]);
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
    assert.deepEqual([...context.entity.v_angle], [1, 2, 3]);
  });
});

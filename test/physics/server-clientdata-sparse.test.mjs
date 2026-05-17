import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Vector from '../../source/shared/Vector.ts';
import { eventBus, registry } from '../../source/engine/registry.ts';
import * as Protocol from '../../source/engine/network/Protocol.ts';
import SV from '../../source/engine/server/Server.ts';
import { ServerClient } from '../../source/engine/server/Client.ts';
import { ServerMessages } from '../../source/engine/server/ServerMessages.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';

/**
 * Install a minimal registry state for writeClientdataToMessage tests.
 * @returns {{restore: () => void, client: ServerClient, entity: Record<string, unknown>}} Test context.
 */
function installClientdataContext() {
  const previousCon = registry.Con;
  const previousHost = registry.Host;
  const previousNET = registry.NET;
  const previousSV = registry.SV;
  const previousServer = SV.server;

  const entity = {
    classname: 'player',
    dmg_inflictor: null,
    dmg_take: 0,
    dmg_save: 0,
    fixangle: false,
    view_ofs: new Vector(0, 0, Protocol.default_viewheight),
    idealpitch: 0,
    flags: 0,
    waterlevel: 0,
    punchangle: new Vector(),
    health: 100,
    alive: false,
  };

  SV.server = {
    ...SV.server,
    time: 1,
    clientdataFields: ['health', 'alive'],
    clientdataFieldsBitsWriter: 'writeByte',
    edicts: [null, { num: 1, entity }],
  };

  registry.Con = { Print() {}, DPrint() {}, PrintWarning() {} };
  registry.Host = { realtime: 0, version: { string: 'test' } };
  registry.NET = { SendUnreliableMessage() { return 0; } };
  registry.SV = SV;
  eventBus.publish('registry.frozen');

  const client = new ServerClient(0);

  return {
    restore() {
      registry.Con = previousCon;
      registry.Host = previousHost;
      registry.NET = previousNET;
      registry.SV = previousSV;
      SV.server = previousServer;
      eventBus.publish('registry.frozen');
    },
    client,
    entity,
  };
}

/**
 * Read back only the sparse custom clientdata payload from a clientdata message.
 * @param {SzBuffer} buffer Source message buffer.
 * @returns {{fieldbits: number, values: unknown[]}} Decoded sparse field payload.
 */
function readSparseClientdataPayload(buffer) {
  buffer.beginReading();
  assert.equal(buffer.readByte(), Protocol.svc.clientdata);
  void buffer.readShort();
  void buffer.readByte();
  void buffer.readByte();
  void buffer.readByte();
  void buffer.readByte();

  const fieldbits = buffer.readByte();
  const values = buffer.readSerializablesOnClient();

  return { fieldbits, values };
}

void describe('ServerMessages clientdata sparse updates', () => {
  void test('sends sparse updates for falsy values and suppresses unchanged fields', () => {
    const context = installClientdataContext();

    try {
      const messages = new ServerMessages();
      const msgFirst = new SzBuffer(256, 'first clientdata message');

      messages.writeClientdataToMessage(context.client, msgFirst);

      const firstPayload = readSparseClientdataPayload(msgFirst);
      assert.equal(firstPayload.fieldbits, 3);
      assert.deepEqual(firstPayload.values, [100, false]);

      const msgSecond = new SzBuffer(256, 'second clientdata message');
      messages.writeClientdataToMessage(context.client, msgSecond);

      const secondPayload = readSparseClientdataPayload(msgSecond);
      assert.equal(secondPayload.fieldbits, 0);
      assert.deepEqual(secondPayload.values, []);

      context.entity.health = 0;
      context.entity.alive = true;

      const msgThird = new SzBuffer(256, 'third clientdata message');
      messages.writeClientdataToMessage(context.client, msgThird);

      const thirdPayload = readSparseClientdataPayload(msgThird);
      assert.equal(thirdPayload.fieldbits, 3);
      assert.deepEqual(thirdPayload.values, [0, true]);
    } finally {
      context.restore();
    }
  });
});

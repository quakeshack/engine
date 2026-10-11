import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { ServerClient } from '../../source/engine/server/Client.ts';
import { ServerMessages } from '../../source/engine/server/ServerMessages.ts';
import type Server from '../../source/engine/server/Server.ts';
import * as Defs from '../../source/shared/Defs.ts';

const INTERVAL = ServerMessages.PAUSED_DATAGRAM_INTERVAL;

interface FakeClient {
  readonly num: number;
  state: number;
  last_datagram_realtime: number;
  readonly message: { overflowed: boolean; cursize: number; clear(): void };
  netconnection: null;
}

interface Scene {
  readonly messages: ServerMessages;
  readonly svs: { realtime: number; maxclients: number; readonly clients: FakeClient[] };
  readonly server: { paused: boolean; num_edicts: number; readonly edicts: Array<{ isFree(): boolean; entity: { effects: number } }> };
  /** The clients a datagram was built for, in order. */
  readonly built: number[];
  /** The clients a reliable message was flushed to, in order. */
  readonly flushed: number[];
}

/**
 * Builds the part of a server that `sendClientMessages` reads, with the two steps that do real work recorded.
 * @param clientCount How many spawned clients the server has.
 * @returns The messages under test and what they were asked to do.
 */
function createScene(clientCount = 1): Scene {
  const built: number[] = [];
  const flushed: number[] = [];
  const clients: FakeClient[] = [];

  for (let index = 0; index < clientCount; index++) {
    clients.push({
      num: index,
      state: ServerClient.STATE.SPAWNED,
      last_datagram_realtime: Number.NEGATIVE_INFINITY,
      message: { overflowed: false, cursize: 0, clear() { this.cursize = 0; } },
      netconnection: null,
    });
  }

  const svs = { realtime: 100, maxclients: clientCount, clients };
  const server = {
    paused: false,
    num_edicts: 2,
    edicts: [
      { isFree: () => true, entity: { effects: 0 } },
      { isFree: () => false, entity: { effects: Defs.effect.EF_MUZZLEFLASH | Defs.effect.EF_BRIGHTFIELD } },
    ],
  };
  const sv = {
    svs,
    server,
    net: {
      CanSendMessage: () => true,
      SendMessage: (_connection: null, message: { cursize: number }) => {
        flushed.push(clients.findIndex((client) => client.message === message));
        return 1;
      },
    },
    dropClient: () => {
      assert.fail('no client is dropped');
    },
  } as unknown as Server;

  const messages = new ServerMessages(sv);

  messages.updateToReliableMessages = (): void => {};
  messages.sendClientDatagram = (client: ServerClient): boolean => {
    client.last_datagram_realtime = svs.realtime;
    built.push(client.num);
    return true;
  };

  return { messages, svs, server, built, flushed };
}

void describe('ServerMessages.sendClientMessages while the game is paused', () => {
  let scene: Scene = null!;

  beforeEach(() => {
    scene = createScene();
  });

  void test('builds a datagram in every frame while the game runs', () => {
    scene.messages.sendClientMessages();
    scene.svs.realtime += 0.001;
    scene.messages.sendClientMessages();

    assert.deepEqual(scene.built, [0, 0]);
  });

  void test('builds the first datagram of a paused game right away', () => {
    scene.server.paused = true;

    scene.messages.sendClientMessages();

    assert.deepEqual(scene.built, [0]);
  });

  void test('builds no datagram for a client that got one a moment ago', () => {
    scene.server.paused = true;

    scene.messages.sendClientMessages();
    scene.svs.realtime += INTERVAL / 2;
    scene.messages.sendClientMessages();

    assert.deepEqual(scene.built, [0]);
  });

  void test('builds the next datagram once the interval is over', () => {
    scene.server.paused = true;

    scene.messages.sendClientMessages();
    scene.svs.realtime += INTERVAL + 0.001;
    scene.messages.sendClientMessages();

    assert.deepEqual(scene.built, [0, 0]);
  });

  void test('builds a datagram again in the first frame after the game was unpaused', () => {
    scene.server.paused = true;
    scene.messages.sendClientMessages();

    scene.server.paused = false;
    scene.svs.realtime += 0.001;
    scene.messages.sendClientMessages();

    assert.deepEqual(scene.built, [0, 0]);
  });

  void test('serves a client that spawned during the pause at once, and leaves the others alone', () => {
    scene = createScene(2);
    scene.server.paused = true;
    scene.svs.clients[0].last_datagram_realtime = scene.svs.realtime - INTERVAL / 2;

    scene.messages.sendClientMessages();

    assert.deepEqual(scene.built, [1]);
  });

  void test('still flushes the reliable messages of a client it built no datagram for', () => {
    scene.server.paused = true;
    scene.svs.clients[0].last_datagram_realtime = scene.svs.realtime;
    scene.svs.clients[0].message.cursize = 12;

    scene.messages.sendClientMessages();

    assert.deepEqual(scene.built, []);
    assert.deepEqual(scene.flushed, [0]);
    assert.equal(scene.svs.clients[0].message.cursize, 0);
  });

  void test('keeps the muzzle flash of an entity until a datagram carried it', () => {
    scene.server.paused = true;
    scene.svs.clients[0].last_datagram_realtime = scene.svs.realtime;

    scene.messages.sendClientMessages();

    assert.equal(scene.server.edicts[1].entity.effects & Defs.effect.EF_MUZZLEFLASH, Defs.effect.EF_MUZZLEFLASH);
  });

  void test('clears the muzzle flash after the datagram that carried it', () => {
    scene.server.paused = true;

    scene.messages.sendClientMessages();

    assert.equal(scene.server.edicts[1].entity.effects, Defs.effect.EF_BRIGHTFIELD);
  });

  void test('does not build a datagram for a client that has not spawned yet', () => {
    scene.svs.clients[0].state = ServerClient.STATE.CONNECTED;

    scene.messages.sendClientMessages();

    assert.deepEqual(scene.built, []);
  });
});

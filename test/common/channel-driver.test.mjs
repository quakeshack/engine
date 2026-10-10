import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import { ChannelDriver, MessagePortEndpoint } from '../../source/engine/network/ChannelDriver.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import NET from '../../source/engine/network/Network.ts';
import { QSocket } from '../../source/engine/network/NetworkDrivers.ts';
import { createChannelEndpointPair } from '../physics/fixtures.mjs';

/**
 * Builds a network layer with a single channel driver, with silent services.
 * @param {import('../../source/engine/network/ChannelDriver.ts').ChannelEndpoint} endpoint the end of the channel it uses
 * @param {number} [bufferSize] size of the shared message buffer
 * @returns {{ net: NET, driver: ChannelDriver }} the network layer and its driver
 */
function createChannelNet(endpoint, bufferSize = 128) {
  let driver = null;

  const net = new NET({
    con: { DPrint() {}, Print() {}, PrintError() {}, PrintWarning() {}, PrintSuccess() {} },
    sys: { Print() {}, FloatTime() { return 1; } },
    dedicated: false,
    urls: () => undefined,
    serverInfo: () => ({ maxPlayers: 1, mapname: 'start', game: 'id1' }),
    webSocketModule: () => undefined,
    createDrivers: (owner) => {
      driver = new ChannelDriver(owner, endpoint);
      return [['channel', driver]];
    },
  });

  net.time = 1;
  net.Init();
  net.message = new SzBuffer(bufferSize, 'test net message');

  return { net, driver };
}

/**
 * @param {number[]} bytes payload
 * @returns {SzBuffer} a buffer holding the payload
 */
function buffer(bytes) {
  const result = new SzBuffer(64, 'test payload');

  for (const byte of bytes) {
    result.writeByte(byte);
  }

  return result;
}

/**
 * @param {NET} net the network layer that received something
 * @returns {number[]} the bytes of the message it read last
 */
function received(net) {
  return [...new Uint8Array(net.message.data, 0, net.message.cursize)];
}

/**
 * Connects a client end to a server end and returns both sockets.
 * @returns {{ client: ReturnType<typeof createChannelNet>, server: ReturnType<typeof createChannelNet>, clientSocket: QSocket, serverSocket: QSocket }} both ends
 */
function connect() {
  const [clientEndpoint, serverEndpoint] = createChannelEndpointPair();
  const client = createChannelNet(clientEndpoint);
  const server = createChannelNet(serverEndpoint);
  const clientSocket = client.net.Connect('local');
  const serverSocket = server.net.CheckNewConnections();

  assert.ok(clientSocket !== null);
  assert.ok(serverSocket !== null);

  return { client, server, clientSocket, serverSocket };
}

void describe('ChannelDriver', () => {
  void describe('connecting', () => {
    void test('only handles the local address', () => {
      const { driver } = createChannelNet(createChannelEndpointPair()[0]);

      assert.equal(driver.canHandle('local'), true);
      assert.equal(driver.canHandle('ws://example.org'), false);
      assert.equal(driver.Connect('somewhere'), null);
    });

    void test('a connect shows up as a new connection on the other end', () => {
      const { clientSocket, serverSocket } = connect();

      assert.equal(clientSocket.state, QSocket.STATE_CONNECTED);
      assert.equal(serverSocket.state, QSocket.STATE_CONNECTED);
      assert.equal(serverSocket.address, 'local');
    });

    void test('hands out each new connection once', () => {
      const [clientEndpoint, serverEndpoint] = createChannelEndpointPair();
      const client = createChannelNet(clientEndpoint);
      const server = createChannelNet(serverEndpoint);

      client.net.Connect('local');

      assert.ok(server.net.CheckNewConnections() !== null);
      assert.equal(server.net.CheckNewConnections(), null);
    });
  });

  void describe('packets', () => {
    void test('delivers a reliable message with its bytes', () => {
      const { client, server, clientSocket, serverSocket } = connect();

      assert.equal(client.net.SendMessage(clientSocket, buffer([1, 2, 3])), 1);
      assert.equal(server.net.GetMessage(serverSocket), 1);
      assert.deepEqual(received(server.net), [1, 2, 3]);
    });

    void test('tells unreliable messages from reliable ones', () => {
      const { client, server, clientSocket, serverSocket } = connect();

      client.net.SendUnreliableMessage(clientSocket, buffer([9]));

      assert.equal(server.net.GetMessage(serverSocket), 2);
      assert.deepEqual(received(server.net), [9]);
    });

    void test('answers in both directions', () => {
      const { client, server, clientSocket, serverSocket } = connect();

      server.net.SendMessage(serverSocket, buffer([7, 7]));

      assert.equal(client.net.GetMessage(clientSocket), 1);
      assert.deepEqual(received(client.net), [7, 7]);
    });

    void test('reads packets in the order they were sent', () => {
      const { client, server, clientSocket, serverSocket } = connect();

      client.net.SendMessage(clientSocket, buffer([1]));
      client.net.SendUnreliableMessage(clientSocket, buffer([2]));
      client.net.SendMessage(clientSocket, buffer([3]));

      const order = [];

      for (let type = server.net.GetMessage(serverSocket); type > 0; type = server.net.GetMessage(serverSocket)) {
        order.push([type, received(server.net)[0]]);
      }

      assert.deepEqual(order, [[1, 1], [2, 2], [1, 3]]);
    });

    void test('reports nothing to read as zero', () => {
      const { server, serverSocket } = connect();

      assert.equal(server.net.GetMessage(serverSocket), 0);
    });

    void test('sends a copy, the shared message buffer can be reused right away', () => {
      const { client, server, clientSocket, serverSocket } = connect();
      const message = buffer([5, 5, 5]);

      client.net.SendMessage(clientSocket, message);
      new Uint8Array(message.data).fill(0);

      server.net.GetMessage(serverSocket);

      assert.deepEqual(received(server.net), [5, 5, 5]);
    });

    void test('keeps connections apart', () => {
      const [clientEndpoint, serverEndpoint] = createChannelEndpointPair();
      const client = createChannelNet(clientEndpoint);
      const server = createChannelNet(serverEndpoint);
      const firstClient = client.driver.open('first');
      const secondClient = client.driver.open('second');
      const firstServer = server.net.CheckNewConnections();
      const secondServer = server.net.CheckNewConnections();

      client.net.SendMessage(secondClient, buffer([2]));
      client.net.SendMessage(firstClient, buffer([1]));

      assert.equal(secondServer.address, 'second');
      assert.equal(server.net.GetMessage(firstServer), 1);
      assert.deepEqual(received(server.net), [1]);
      assert.equal(server.net.GetMessage(firstServer), 0);
      assert.equal(server.net.GetMessage(secondServer), 1);
      assert.deepEqual(received(server.net), [2]);
    });

    void test('refuses to read a packet that does not fit the message buffer', () => {
      const [clientEndpoint, serverEndpoint] = createChannelEndpointPair();
      const client = createChannelNet(clientEndpoint);
      const server = createChannelNet(serverEndpoint, 4);
      const clientSocket = client.net.Connect('local');
      const serverSocket = server.net.CheckNewConnections();

      client.net.SendMessage(clientSocket, buffer([1, 2, 3, 4, 5, 6]));

      assert.throws(() => server.net.GetMessage(serverSocket), /overflow/);
    });
  });

  void describe('closing', () => {
    void test('a close reaches the other end after it read what was sent before', () => {
      const { client, server, clientSocket, serverSocket } = connect();

      client.net.SendMessage(clientSocket, buffer([4]));
      client.net.Close(clientSocket);

      assert.equal(server.net.GetMessage(serverSocket), 1);
      assert.equal(server.net.GetMessage(serverSocket), -1);
      assert.equal(serverSocket.state, QSocket.STATE_DISCONNECTED);
    });

    void test('cannot send once closed', () => {
      const { client, clientSocket } = connect();

      client.net.Close(clientSocket);

      assert.equal(client.net.SendMessage(clientSocket, buffer([1])), -1);
      assert.equal(client.net.CanSendMessage(clientSocket), false);
    });

    void test('cannot send to a peer that has closed', () => {
      const { server, clientSocket, serverSocket, client } = connect();

      server.net.Close(serverSocket);

      assert.equal(client.driver.CanSendMessage(clientSocket), true);
      client.net.GetMessage(clientSocket);
      assert.equal(client.net.SendMessage(clientSocket, buffer([1])), -1);
    });

    void test('shutting the driver down closes every socket', () => {
      const { client, server, serverSocket } = connect();

      client.driver.Shutdown();

      assert.equal(server.net.GetMessage(serverSocket), -1);
    });
  });
});

void describe('MessagePortEndpoint', () => {
  void test('carries messages over a real message channel and moves the payload', async () => {
    const { port1, port2 } = new MessageChannel();
    const sender = new MessagePortEndpoint(port1);
    const receiver = new MessagePortEndpoint(port2);
    const payload = new Uint8Array([1, 2, 3]).buffer;

    const arrived = new Promise((resolve) => { receiver.setReceiver(resolve); });

    sender.post({ kind: 'data', connection: 4, reliable: true, payload }, [payload]);

    const message = await arrived;

    try {
      assert.equal(message.kind, 'data');
      assert.equal(message.connection, 4);
      assert.deepEqual([...new Uint8Array(message.payload)], [1, 2, 3]);
      assert.equal(payload.byteLength, 0, 'the sent buffer moved to the other side');
    } finally {
      port1.close();
      port2.close();
    }
  });

  void test('ignores messages that are not channel messages', async () => {
    const { port1, port2 } = new MessageChannel();
    const receiver = new MessagePortEndpoint(port2);
    const seen = [];

    receiver.setReceiver((message) => seen.push(message));
    port1.postMessage({ somethingElse: true });
    port1.postMessage({ channel: { kind: 'close', connection: 1 } });

    // messages arrive in order, so once the channel message is there the other one has been looked at too;
    // a fixed delay is not enough when the whole suite runs in parallel
    const deadline = Date.now() + 2000;

    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    try {
      assert.deepEqual(seen, [{ kind: 'close', connection: 1 }]);
    } finally {
      port1.close();
      port2.close();
    }
  });
});

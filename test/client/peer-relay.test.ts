import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import PeerRelay from '../../source/engine/client/PeerRelay.ts';
import { ChannelDriver, type ChannelEndpoint } from '../../source/engine/network/ChannelDriver.ts';
import { SzBuffer } from '../../source/engine/network/MSG.ts';
import NET from '../../source/engine/network/Network.ts';
import { BaseDriver, QSocket } from '../../source/engine/network/NetworkDrivers.ts';
import { createChannelEndpointPair } from '../support/fixtures.ts';

/**
 * Stands in for the WebRTC driver: remote players are made up by the test.
 */
class FakePeerDriver extends BaseDriver {
  newConnections: QSocket[] = [];
  incoming = new Map<QSocket, Array<{ type: number; bytes: number[] }>>();
  sent = new Map<QSocket, Array<{ type: number; bytes: number[] }>>();
  closed = new Set<QSocket>();

  constructor(net: NET) {
    super('fake', net);
    this.initialized = true;
  }

  override Init(): boolean {
    return true;
  }

  /**
   * A remote player connects.
   * @param address the address they connect from
   * @returns the socket of the player
   */
  connectPeer(address: string): QSocket {
    const sock = this.net.NewQSocket(this);

    sock.address = address;
    sock.state = QSocket.STATE_CONNECTED;
    this.incoming.set(sock, []);
    this.sent.set(sock, []);
    this.newConnections.push(sock);

    return sock;
  }

  /**
   * The remote player sends a packet.
   * @param sock their socket
   * @param type 1 reliable, 2 unreliable
   * @param bytes the payload
   */
  receiveFrom(sock: QSocket, type: number, bytes: number[]): void {
    this.incoming.get(sock)!.push({ type, bytes });
  }

  override CheckNewConnections(): QSocket | null {
    return this.newConnections.shift() ?? null;
  }

  override GetMessage(sock: QSocket): number {
    const packet = this.incoming.get(sock)?.shift();

    if (packet === undefined) {
      return sock.state === QSocket.STATE_DISCONNECTED ? -1 : 0;
    }

    new Uint8Array(this.net.message.data).set(packet.bytes);
    this.net.message.cursize = packet.bytes.length;

    return packet.type;
  }

  #record(sock: QSocket, type: number, data: SzBuffer): number {
    this.sent.get(sock)!.push({ type, bytes: [...new Uint8Array(data.data, 0, data.cursize)] });
    return 1;
  }

  override SendMessage(sock: QSocket, data: SzBuffer): number {
    return this.#record(sock, 1, data);
  }

  override SendUnreliableMessage(sock: QSocket, data: SzBuffer): number {
    return this.#record(sock, 2, data);
  }

  override Close(sock: QSocket): void {
    this.closed.add(sock);
    super.Close(sock);
  }
}

/**
 * @param endpoint the end of the channel
 * @param createDrivers the drivers of the layer
 * @returns a network layer
 */
function createNet(endpoint: ChannelEndpoint, createDrivers: (net: NET) => Array<[string, BaseDriver]>): NET {
  const net = new NET({
    con: { DPrint() {}, Print() {}, PrintError() {}, PrintWarning() {}, PrintSuccess() {} },
    sys: { Print() {}, FloatTime: () => 1 },
    dedicated: false,
    urls: () => undefined,
    serverInfo: () => ({ maxPlayers: 4, mapname: 'start', game: 'id1' }),
    webSocketModule: () => undefined,
    createDrivers,
  });

  net.Init();
  net.message = new SzBuffer(128, 'test net message');

  return net;
}

/**
 * Builds a page with a relay and the network layer of a server in a worker behind it.
 * @param [serverState] the state the page believes the server has
 * @returns both sides and the relay
 */
function createSetup(serverState: { active?: boolean, maxclients?: number } = {}): { pageNet: NET; workerNet: NET; peers: FakePeerDriver; relay: PeerRelay; state: { active: boolean; maxclients: number; mapname: string; paused: boolean }; listening: boolean[] } {
  const [pageEndpoint, workerEndpoint] = createChannelEndpointPair();
  let peers: FakePeerDriver | null = null;
  let channel: ChannelDriver | null = null;

  const pageNet = createNet(pageEndpoint, (owner) => {
    peers = new FakePeerDriver(owner);
    channel = new ChannelDriver(owner, pageEndpoint);
    return [['channel', channel], ['fake', peers]];
  });
  const workerNet = createNet(workerEndpoint, (owner) => [['channel', new ChannelDriver(owner, workerEndpoint)]]);
  const state = { active: true, maxclients: 4, mapname: 'start', paused: false, ...serverState };
  const listening: boolean[] = [];
  const relay = new PeerRelay({
    net: pageNet,
    channel: channel!,
    state,
    setListening: (on: boolean) => { listening.push(on); pageNet.listening = on; },
  });

  return { pageNet, workerNet, peers: peers!, relay, state, listening };
}

/**
 * @param bytes payload
 * @returns a buffer with the payload
 */
function buffer(bytes: number[]): SzBuffer {
  const result = new SzBuffer(64, 'payload');

  for (const byte of bytes) {
    result.writeByte(byte);
  }

  return result;
}

/**
 * @param net the layer that read last
 * @returns the bytes it read
 */
function read(net: NET): number[] {
  return [...new Uint8Array(net.message.data, 0, net.message.cursize)];
}

void describe('PeerRelay', () => {
  void describe('listening', () => {
    void test('starts for a game of more than one player', () => {
      const { relay, listening } = createSetup({ maxclients: 4 });

      relay.pump();

      assert.deepEqual(listening, [true]);
    });

    void test('does not start for a single player game', () => {
      const { relay, listening } = createSetup({ maxclients: 1 });

      relay.pump();

      assert.deepEqual(listening, []);
    });

    void test('stops when a game for several players turns into one for a single player', () => {
      const { relay, listening, state } = createSetup({ maxclients: 4 });

      relay.pump();
      state.maxclients = 1;
      relay.pump();

      assert.deepEqual(listening, [true, false]);
    });

    void test('stops when the server is gone', () => {
      const { relay, listening, state } = createSetup({ maxclients: 4 });

      relay.pump();
      state.active = false;
      relay.pump();

      assert.deepEqual(listening, [true, false]);
    });

    void test('does not undo a listen typed by hand until the server changes', () => {
      const { relay, listening, pageNet } = createSetup({ maxclients: 1 });

      relay.pump();
      pageNet.listening = true;
      relay.pump();
      relay.pump();

      assert.deepEqual(listening, []);
    });
  });

  void describe('players', () => {
    void test('show up on the server as a connection with their address', () => {
      const { relay, peers, workerNet } = createSetup();

      peers.connectPeer('peer-1');
      relay.pump();

      const sock = workerNet.CheckNewConnections();

      assert.equal(sock!.address, 'peer-1');
      assert.equal(relay.peerCount, 1);
    });

    void test('send their packets to the server, with the kind of packet preserved', () => {
      const { relay, peers, workerNet } = createSetup();
      const peer = peers.connectPeer('peer-1');

      relay.pump();
      const sock = workerNet.CheckNewConnections();

      peers.receiveFrom(peer, 1, [1, 2, 3]);
      peers.receiveFrom(peer, 2, [9]);
      relay.pump();

      assert.equal(workerNet.GetMessage(sock), 1);
      assert.deepEqual(read(workerNet), [1, 2, 3]);
      assert.equal(workerNet.GetMessage(sock), 2);
      assert.deepEqual(read(workerNet), [9]);
    });

    void test('get the answers of the server', () => {
      const { relay, peers, workerNet } = createSetup();
      const peer = peers.connectPeer('peer-1');

      relay.pump();
      const sock = workerNet.CheckNewConnections();

      workerNet.SendMessage(sock, buffer([7, 7]));
      workerNet.SendUnreliableMessage(sock, buffer([8]));
      relay.pump();

      assert.deepEqual(peers.sent.get(peer), [{ type: 1, bytes: [7, 7] }, { type: 2, bytes: [8] }]);
    });

    void test('are kept apart', () => {
      const { relay, peers, workerNet } = createSetup();
      const first = peers.connectPeer('peer-1');
      const second = peers.connectPeer('peer-2');

      relay.pump();
      const firstSock = workerNet.CheckNewConnections();
      const secondSock = workerNet.CheckNewConnections();

      peers.receiveFrom(second, 1, [2]);
      peers.receiveFrom(first, 1, [1]);
      relay.pump();

      assert.equal(workerNet.GetMessage(firstSock), 1);
      assert.deepEqual(read(workerNet), [1]);
      assert.equal(workerNet.GetMessage(secondSock), 1);
      assert.deepEqual(read(workerNet), [2]);
    });

    void test('are dropped on the server when they leave', () => {
      const { relay, peers, workerNet } = createSetup();
      const peer = peers.connectPeer('peer-1');

      relay.pump();
      const sock = workerNet.CheckNewConnections();

      peer.state = QSocket.STATE_DISCONNECTED;
      relay.pump();

      assert.equal(workerNet.GetMessage(sock), -1);
      assert.equal(relay.peerCount, 0);
    });

    void test('are dropped when the server drops them', () => {
      const { relay, peers, workerNet } = createSetup();
      const peer = peers.connectPeer('peer-1');

      relay.pump();
      const sock = workerNet.CheckNewConnections();

      workerNet.Close(sock);
      relay.pump();

      assert.ok(peers.closed.has(peer));
      assert.equal(relay.peerCount, 0);
    });

    void test('all go when the relay lets go', () => {
      const { relay, peers } = createSetup();
      const first = peers.connectPeer('peer-1');
      const second = peers.connectPeer('peer-2');

      relay.pump();
      relay.closeAll();

      assert.ok(peers.closed.has(first) && peers.closed.has(second));
      assert.equal(relay.peerCount, 0);
    });
  });

  void describe('idle', () => {
    void test('does nothing while nobody listens and nobody is connected', () => {
      const { relay, peers, workerNet } = createSetup({ maxclients: 1 });

      peers.connectPeer('peer-1');
      relay.pump();

      assert.equal(workerNet.CheckNewConnections(), null);
    });
  });
});

import type Network from './Network.ts';
import type { ChannelPacket, ChannelSocketState } from './NetworkDrivers.ts';
import type { SzBuffer } from './MSG.ts';

import { HostError } from '../common/Errors.ts';
import { BaseDriver, QSocket } from './NetworkDrivers.ts';

/** What travels over a channel. Packets are the game protocol, untouched; the rest manages sockets. */
export type ChannelMessage =
  | { readonly kind: 'open'; readonly connection: number; readonly address: string }
  | { readonly kind: 'data'; readonly connection: number; readonly reliable: boolean; readonly payload: ArrayBuffer }
  | { readonly kind: 'close'; readonly connection: number };

/** One end of a channel to another thread. */
export interface ChannelEndpoint {
  /**
   * Sends a message to the other end.
   * @param message What to send.
   * @param transfer Buffers of the message that move to the other end instead of being copied.
   */
  post(message: ChannelMessage, transfer?: Transferable[]): void;

  /**
   * Sets who receives the messages of the other end, replacing a previous receiver.
   * @param receiver Called for every message, in the order they were sent.
   */
  setReceiver(receiver: (message: ChannelMessage) => void): void;
}

/** The part of a `MessagePort` an endpoint uses. */
export interface ChannelPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  start?(): void;
}

/**
 * A channel endpoint on top of a `MessagePort` (browser and `worker_threads` alike). Messages are
 * wrapped so the same port can carry something else next to them.
 */
export class MessagePortEndpoint implements ChannelEndpoint {
  readonly #port: ChannelPortLike;
  #receiver: ((message: ChannelMessage) => void) | null = null;

  constructor(port: ChannelPortLike) {
    this.#port = port;
    port.addEventListener('message', (event) => {
      const envelope = event.data as { readonly channel?: ChannelMessage } | null;

      if (envelope?.channel !== undefined) {
        this.#receiver?.(envelope.channel);
      }
    });
    port.start?.();
  }

  post(message: ChannelMessage, transfer: Transferable[] = []): void {
    this.#port.postMessage({ channel: message }, transfer);
  }

  setReceiver(receiver: (message: ChannelMessage) => void): void {
    this.#receiver = receiver;
  }
}

/**
 * Sockets whose other end lives behind a message channel, typically a server in a worker. It is a
 * sibling of the WebSocket driver, not of the loopback one: packets are queued per socket and read
 * in order, and since the channel is reliable and ordered there is no flow control of its own.
 * Any number of sockets share one channel, told apart by a connection id, which is how packets of
 * remote players can be relayed through the same pipe as those of the local player.
 */
export class ChannelDriver extends BaseDriver {
  /** The address of the server in the other thread. */
  static readonly LOCAL_ADDRESS = 'local';

  readonly #endpoint: ChannelEndpoint;
  readonly #sockets = new Map<number, QSocket>();
  readonly #newConnections: QSocket[] = [];
  #nextConnection = 1;

  constructor(net: Network, endpoint: ChannelEndpoint) {
    super('channel', net);
    this.#endpoint = endpoint;
  }

  override Init(): boolean {
    this.#sockets.clear();
    this.#newConnections.length = 0;
    this.#endpoint.setReceiver((message) => { this.#onMessage(message); });
    this.initialized = true;
    return true;
  }

  override Shutdown(): void {
    for (const sock of [...this.#sockets.values()]) {
      this.Close(sock);
    }

    this.#endpoint.setReceiver(() => {});
    super.Shutdown();
  }

  override canHandle(host: string): boolean {
    return host === ChannelDriver.LOCAL_ADDRESS;
  }

  override Connect(host: string): QSocket | null {
    if (!this.canHandle(host)) {
      return null;
    }

    return this.open(host);
  }

  /**
   * Opens a socket to the other end of the channel.
   * @param address What the other end shows as the address of this connection.
   * @returns The connected socket.
   */
  open(address: string): QSocket {
    const connection = this.#nextConnection++;
    const sock = this.#createSocket(connection, address);

    this.#endpoint.post({ kind: 'open', connection, address });

    return sock;
  }

  override CheckNewConnections(): QSocket | null {
    return this.#newConnections.shift() ?? null;
  }

  override GetMessage(sock: QSocket): number {
    const state = ChannelDriver.#state(sock);

    if (state === null) {
      return sock.state === QSocket.STATE_DISCONNECTED ? -1 : 0;
    }

    const packet = state.receiveQueue.shift();

    if (packet === undefined) {
      if (state.remoteClosed || sock.state === QSocket.STATE_DISCONNECTED) {
        this.#release(sock, state);
        return -1;
      }

      return 0;
    }

    if (packet.payload.byteLength > this.net.message.data.byteLength) {
      throw new HostError('ChannelDriver.GetMessage: overflow');
    }

    this.net.message.cursize = packet.payload.byteLength;
    new Uint8Array(this.net.message.data).set(packet.payload);

    return packet.reliable ? 1 : 2;
  }

  override SendMessage(sock: QSocket, data: SzBuffer): number {
    return this.#send(sock, data, true);
  }

  override SendUnreliableMessage(sock: QSocket, data: SzBuffer): number {
    return this.#send(sock, data, false);
  }

  override CanSendMessage(sock: QSocket): boolean {
    return sock.state === QSocket.STATE_CONNECTED && ChannelDriver.#state(sock) !== null;
  }

  override Close(sock: QSocket): void {
    const state = ChannelDriver.#state(sock);

    if (state !== null && !state.remoteClosed && sock.state !== QSocket.STATE_DISCONNECTED) {
      this.#endpoint.post({ kind: 'close', connection: state.connection });
    }

    if (state !== null) {
      this.#release(sock, state);
    }

    sock.state = QSocket.STATE_DISCONNECTED;
    sock.canSend = false;
  }

  #send(sock: QSocket, data: SzBuffer, reliable: boolean): number {
    const state = ChannelDriver.#state(sock);

    if (state === null || sock.state === QSocket.STATE_DISCONNECTED || state.remoteClosed) {
      return -1;
    }

    // The shared message buffer cannot move, only a copy can.
    const payload = data.data.slice(0, data.cursize);

    this.#endpoint.post({ kind: 'data', connection: state.connection, reliable, payload }, [payload]);

    return 1;
  }

  #createSocket(connection: number, address: string): QSocket {
    const sock = this.net.NewQSocket(this);

    sock.address = address;
    sock.canSend = true;
    sock.state = QSocket.STATE_CONNECTED;
    sock.transportState = { kind: 'channel', connection, receiveQueue: [], remoteClosed: false };
    this.#sockets.set(connection, sock);

    return sock;
  }

  #release(sock: QSocket, state: ChannelSocketState): void {
    if (this.#sockets.get(state.connection) === sock) {
      this.#sockets.delete(state.connection);
    }

    state.receiveQueue.length = 0;
    sock.state = QSocket.STATE_DISCONNECTED;
    sock.canSend = false;
  }

  #onMessage(message: ChannelMessage): void {
    switch (message.kind) {
      case 'open':
        this.#newConnections.push(this.#createSocket(message.connection, message.address));
        break;

      case 'data': {
        const sock = this.#sockets.get(message.connection);
        const state = sock === undefined ? null : ChannelDriver.#state(sock);

        if (state !== null) {
          const packet: ChannelPacket = { reliable: message.reliable, payload: new Uint8Array(message.payload) };

          state.receiveQueue.push(packet);
        }

        break;
      }

      case 'close': {
        const sock = this.#sockets.get(message.connection);
        const state = sock === undefined ? null : ChannelDriver.#state(sock);

        if (state !== null) {
          state.remoteClosed = true;
        }

        break;
      }

      default:
        break;
    }
  }

  static #state(sock: QSocket): ChannelSocketState | null {
    return sock.transportState?.kind === 'channel' ? sock.transportState : null;
  }
}

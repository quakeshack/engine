import type { ServerStateMirror } from '../common/ServerController.ts';
import type NET from '../network/Network.ts';
import type { QSocket } from '../network/NetworkDrivers.ts';
import type { ChannelDriver } from '../network/ChannelDriver.ts';

/** The part of the network layer a relay uses. */
export type PeerRelayNetwork = Pick<NET, 'message' | 'listening' | 'CheckNewConnections' | 'GetMessage' | 'SendMessage' | 'SendUnreliableMessage' | 'Close'>;

/** What a `PeerRelay` is built from. */
export interface PeerRelayDependencies {
  /** The network layer of the page, where the peers arrive. */
  readonly net: PeerRelayNetwork;
  /** Opens the sockets towards the server in the worker. */
  readonly channel: Pick<ChannelDriver, 'open'>;
  /** What the page knows about the server. */
  readonly state: ServerStateMirror;
  /** Starts or stops accepting peers (the `listen` command). */
  readonly setListening: (listening: boolean) => void;
}

interface RelayedPeer {
  readonly peer: QSocket;
  readonly link: QSocket;
}

/**
 * Carries the packets of remote players to a server that lives in a worker. A worker has no
 * `RTCPeerConnection`, so the peers are accepted on the page, by the network layer that always did
 * that, and each of them gets a socket on the channel to the worker. The server sees them as it
 * sees any player, and does not know the packets took a detour.
 *
 * It also does what the server does for its own network layer when it runs on the page: starts
 * listening when a game for more than one player begins, and stops when it ends.
 */
export default class PeerRelay {
  /** How often packets are carried, in milliseconds. */
  static readonly INTERVAL = 8;

  readonly #deps: PeerRelayDependencies;
  readonly #peers: RelayedPeer[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastHosting: number | null = null;

  constructor(dependencies: PeerRelayDependencies) {
    this.#deps = dependencies;
  }

  /**
   * How many remote players are connected through this relay.
   * @returns The number of connected peers.
   */
  get peerCount(): number {
    return this.#peers.length;
  }

  /**
   * Starts carrying packets.
   */
  start(): void {
    this.#timer ??= setInterval(() => { this.pump(); }, PeerRelay.INTERVAL);
  }

  /**
   * Stops carrying packets and lets go of everyone.
   */
  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    this.closeAll();
  }

  /**
   * Disconnects every remote player, for example because the server is gone.
   */
  closeAll(): void {
    for (const pair of this.#peers.splice(0)) {
      this.#close(pair);
    }
  }

  /**
   * Carries what is waiting, in both directions, and takes in new peers.
   */
  pump(): void {
    this.#syncListening();

    if (!this.#deps.net.listening && this.#peers.length === 0) {
      return;
    }

    for (let socket = this.#deps.net.CheckNewConnections(); socket !== null; socket = this.#deps.net.CheckNewConnections()) {
      this.#peers.push({ peer: socket, link: this.#deps.channel.open(socket.address ?? 'remote') });
    }

    for (const pair of [...this.#peers]) {
      if (!this.#carry(pair.peer, pair.link) || !this.#carry(pair.link, pair.peer)) {
        this.#peers.splice(this.#peers.indexOf(pair), 1);
        this.#close(pair);
      }
    }
  }

  /**
   * Follows the server: a game for more than one player is one to listen for, one for a single player is not.
   * It reacts to a change of the server only, a `listen` typed by hand stays until then.
   */
  #syncListening(): void {
    const { state, net } = this.#deps;
    const hosting = state.active ? state.maxclients : 0;

    if (hosting === this.#lastHosting) {
      return;
    }

    this.#lastHosting = hosting;

    if (hosting > 1 && !net.listening) {
      this.#deps.setListening(true);
    } else if (hosting <= 1 && net.listening) {
      this.#deps.setListening(false);
    }
  }

  /**
   * Moves every packet that waits on one socket to the other.
   * @returns False when one of the two is gone.
   */
  #carry(from: QSocket, to: QSocket): boolean {
    const { net } = this.#deps;

    for (let type = net.GetMessage(from); type !== 0; type = net.GetMessage(from)) {
      if (type < 0) {
        return false;
      }

      const sent = type === 1 ? net.SendMessage(to, net.message) : net.SendUnreliableMessage(to, net.message);

      if (sent < 0) {
        return false;
      }
    }

    return true;
  }

  #close(pair: RelayedPeer): void {
    this.#deps.net.Close(pair.peer);
    this.#deps.net.Close(pair.link);
  }
}

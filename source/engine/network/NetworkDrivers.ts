import Cvar from '../common/Cvar.ts';
import { HostError } from '../common/Errors.ts';
import type { SzBuffer } from './MSG.ts';
import { eventBus, getCommonRegistry, registry } from '../registry.ts';
import { formatIP } from './Misc.ts';

type Throwable = Error | string | number | boolean | null | undefined | { message?: string };
type NetworkPayload = SzBuffer;
type QSocketState = 'new' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected';

type ListenAddress = {
  address: string;
  port: number;
};

type NodeRawData = ArrayBuffer | Uint8Array | Uint8Array[];

type NodeIncomingMessageLike = {
  headers: Record<string, string | string[] | undefined>;
  socket: {
    remoteAddress?: string;
    remotePort?: number;
  };
};

type NodeWebSocketLike = {
  close: (code?: number) => void;
  readyState: number;
  send: (data: ArrayBuffer) => void;
  on: {
    (eventName: 'close' | 'error', listener: () => void): void;
    (eventName: 'message', listener: (data: NodeRawData) => void): void;
  };
};

type NodeWebSocketServerLike = {
  address: () => string | ListenAddress | null;
  close: () => void;
  on: (eventName: 'connection', listener: (ws: NodeWebSocketLike, req: NodeIncomingMessageLike) => void) => void;
};

type NodeWebSocketModuleLike = {
  WebSocketServer: new (options: { server: typeof NET.server }) => NodeWebSocketServerLike;
};

type DataChannelPair = {
  reliable?: RTCDataChannel;
  unreliable?: RTCDataChannel;
};

type WebRTCQueuedMessage = {
  buffer: Uint8Array;
  reliable: boolean;
};

/**
 * Host-side state for a single out-of-band (connectionless) peer connection --
 * see `plans/session-ping-latency.md`. Deliberately not a `QSocket`/`WebRTCSocketState`: an OOB
 * connection must never reach `NET.activeSockets`, `NET.NewQSocket`, or anything else the real
 * game protocol reads from.
 */
type OobConnectionState = {
  peerConnection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  lastPingAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * Viewer-side state for a single session's out-of-band ping probe -- see
 * `plans/session-ping-latency.md`. Each probe owns a dedicated `/signaling` WebSocket (never the
 * driver's own `signalingWs`), since the master server tracks exactly one (sessionId, peerId) pair
 * per signaling connection and a browsing client may probe several sessions at once.
 */
type ViewerOobProbeState = {
  sessionId: string;
  ws: WebSocket;
  peerId: string | null;
  peerConnection: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  sequence: number;
  pendingSequence: number | null;
  smoothedRtt: number | null;
  onPing: (rtt: number | null) => void;
};

type ServerInfo = {
  hostname: string;
  maxPlayers: number;
  currentPlayers: number;
  map: string;
  mod: string;
  settings: Record<string, string>;
};

type SignalingMessage = {
  type: string;
  answer?: RTCSessionDescription | RTCSessionDescriptionInit | null;
  candidate?: RTCIceCandidate | RTCIceCandidateInit | null;
  error?: string;
  existingPeers?: string[];
  fromPeerId?: string;
  hostToken?: string;
  isHost?: boolean;
  /** Out-of-band (connectionless) peer -- see `plans/session-ping-latency.md`. */
  isOob?: boolean;
  isPublic?: boolean;
  offer?: RTCSessionDescription | RTCSessionDescriptionInit | null;
  peerCount?: number;
  peerId?: string;
  reason?: string;
  serverInfo?: ServerInfo;
  sessionId?: string;
  targetPeerId?: string;
};

type LoopbackSocketState = {
  kind: 'loopback';
  peer: QSocket | null;
  receiveBuffer: Uint8Array;
  receiveLength: number;
};

type ClientWebSocketSocketState = {
  kind: 'websocket';
  mode: 'client';
  receiveQueue: Uint8Array[];
  sendQueue: Uint8Array[];
  webSocket: BrowserWebSocketWithSocket;
};

type ServerWebSocketSocketState = {
  kind: 'websocket';
  mode: 'server';
  receiveQueue: Uint8Array[];
  sendQueue: Uint8Array[];
  webSocket: NodeWebSocketLike;
};

type WebSocketSocketState = ClientWebSocketSocketState | ServerWebSocketSocketState;

type WebRTCSocketState = {
  kind: 'webrtc';
  dataChannels: Map<string, DataChannelPair>;
  isHost: boolean;
  onSignalingReady?: () => void;
  peerConnections: Map<string, RTCPeerConnection>;
  peerId?: string | null;
  receiveQueue: Uint8Array[];
  sendQueue: WebRTCQueuedMessage[];
  sessionId: string | null;
};

type QSocketTransportState = LoopbackSocketState | WebSocketSocketState | WebRTCSocketState | null;

type BrowserWebSocketWithSocket = WebSocket & {
  qsocket?: QSocket;
};

let { COM, Con, NET, Sys, SV } = getCommonRegistry();

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con, NET, Sys, SV } = getCommonRegistry());
});

/**
 * Normalize thrown values into a printable error message.
 * @param error
 * @returns Human-readable error text.
 */
function getErrorMessage(error: Throwable): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }

  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(error);
}

/**
 * Create loopback-only runtime state for a qsocket.
 * @param peer
 * @returns Initialized loopback transport state.
 */
function createLoopbackSocketState(peer: QSocket | null): LoopbackSocketState {
  return {
    kind: 'loopback',
    peer,
    receiveBuffer: new Uint8Array(new ArrayBuffer(65536)),
    receiveLength: 0,
  };
}

/**
 * Create WebRTC runtime state for a qsocket.
 * @param options
 * @returns Initialized WebRTC transport state.
 */
function createWebRTCSocketState(options: {
  isHost: boolean;
  peerId?: string | null;
  sessionId: string | null;
}): WebRTCSocketState {
  const {
    isHost,
    peerId = null,
    sessionId,
  } = options;

  return {
    kind: 'webrtc',
    dataChannels: new Map(),
    isHost,
    peerConnections: new Map(),
    peerId,
    receiveQueue: [],
    sendQueue: [],
    sessionId,
  };
}

/**
 * Return loopback transport state when present.
 * @param sock
 * @returns Loopback state for the socket when available.
 */
function getLoopbackState(sock: QSocket): LoopbackSocketState | null {
  return sock.transportState?.kind === 'loopback' ? sock.transportState : null;
}

/**
 * Return websocket transport state when present.
 * @param sock
 * @returns WebSocket state for the socket when available.
 */
function getWebSocketState(sock: QSocket): WebSocketSocketState | null {
  return sock.transportState?.kind === 'websocket' ? sock.transportState : null;
}

/**
 * Return WebRTC transport state when present.
 * @param sock
 * @returns WebRTC state for the socket when available.
 */
function getWebRTCSocketState(sock: QSocket): WebRTCSocketState | null {
  return sock.transportState?.kind === 'webrtc' ? sock.transportState : null;
}

/**
 * Copy a view into a detached ArrayBuffer for transport APIs that require it.
 * @param data
 * @returns A standalone buffer containing the input bytes.
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return buffer;
}

/**
 * Normalize node websocket message payloads into a standalone Uint8Array.
 * @param data
 * @returns A standalone byte view of the incoming payload.
 */
function rawDataToUint8Array(data: NodeRawData): Uint8Array {
  if (Array.isArray(data)) {
    const totalLength = data.reduce((length, chunk) => length + chunk.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of data) {
      combined.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
      offset += chunk.byteLength;
    }

    return combined;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

export class QSocket {
  static readonly STATE_NEW = 'new';
  static readonly STATE_CONNECTING = 'connecting';
  static readonly STATE_CONNECTED = 'connected';
  static readonly STATE_DISCONNECTING = 'disconnecting';
  static readonly STATE_DISCONNECTED = 'disconnected';

  address: string | null = null;
  canSend = false;
  connecttime: number;
  driver: BaseDriver;
  lastMessageTime: number;
  state: QSocketState = QSocket.STATE_NEW;
  transportState: QSocketTransportState = null;

  constructor(driver: BaseDriver, time: number) {
    this.driver = driver;
    this.connecttime = time;
    this.lastMessageTime = time;
  }

  toString(): string {
    return `QSocket(${this.address}, ${this.state})`;
  }

  GetMessage(): number {
    return this.driver.GetMessage(this);
  }

  SendMessage(data: NetworkPayload): number {
    return this.driver.SendMessage(this, data);
  }

  SendUnreliableMessage(data: NetworkPayload): number {
    return this.driver.SendUnreliableMessage(this, data);
  }

  CanSendMessage(): boolean {
    if (this.state !== QSocket.STATE_CONNECTED) {
      return false;
    }

    return this.driver.CanSendMessage(this);
  }

  Close(): void {
    this.driver.Close(this);
  }
}

export class BaseDriver {
  initialized = false;
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  Init(): boolean {
    return false;
  }

  Shutdown(): void {
    this.initialized = false;
  }

  canHandle(_host: string): boolean {
    return false;
  }

  Connect(_host: string): QSocket | null {
    return null;
  }

  CheckNewConnections(): QSocket | null {
    return null;
  }

  CheckForResend(): number {
    return -1;
  }

  GetMessage(_qsocket: QSocket): number {
    return -1;
  }

  SendMessage(_qsocket: QSocket, _data: NetworkPayload): number {
    return -1;
  }

  SendUnreliableMessage(_qsocket: QSocket, _data: NetworkPayload): number {
    return -1;
  }

  CanSendMessage(_qsocket: QSocket): boolean {
    return false;
  }

  Close(qsocket: QSocket): void {
    qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  ShouldListen(): boolean {
    return true;
  }

  Listen(_shouldListen: boolean): void {
  }

  GetListenAddress(): string | null {
    return null;
  }
}

export class LoopDriver extends BaseDriver {
  _client: QSocket | null = null;
  _server: QSocket | null = null;
  localconnectpending = false;

  constructor() {
    super('loop');
  }

  Init(): boolean {
    this._server = null;
    this._client = null;
    this.localconnectpending = false;
    this.initialized = true;
    return true;
  }

  canHandle(host: string): boolean {
    return host === 'local';
  }

  Connect(host: string): QSocket | null {
    if (host !== 'local') {
      return null;
    }

    this.localconnectpending = true;

    if (this._server === null) {
      this._server = NET.NewQSocket(this);
    }

    if (this._client === null) {
      this._client = NET.NewQSocket(this);
    }

    const server = this._server;
    const client = this._client;

    if (server === null || client === null) {
      return null;
    }

    server.address = 'local server';
    client.address = 'local client';
    server.canSend = true;
    client.canSend = true;

    server.transportState = createLoopbackSocketState(client);
    client.transportState = createLoopbackSocketState(server);

    client.state = QSocket.STATE_CONNECTED;
    server.state = QSocket.STATE_CONNECTED;

    return server;
  }

  CheckNewConnections(): QSocket | null {
    if (!this.localconnectpending) {
      return null;
    }

    this.localconnectpending = false;

    if (this._client === null || this._server === null) {
      return null;
    }

    const clientState = getLoopbackState(this._client);
    const serverState = getLoopbackState(this._server);

    if (clientState === null || serverState === null) {
      return null;
    }

    clientState.receiveLength = 0;
    this._client.canSend = true;
    this._client.state = QSocket.STATE_CONNECTED;

    serverState.receiveLength = 0;
    this._server.canSend = true;
    this._server.state = QSocket.STATE_CONNECTED;

    return this._client;
  }

  GetMessage(sock: QSocket): number {
    const loopbackState = getLoopbackState(sock);

    if (loopbackState === null || loopbackState.receiveLength === 0) {
      return 0;
    }

    const buffer = loopbackState.receiveBuffer;
    let receiveLength = loopbackState.receiveLength;

    const type = buffer[0];
    const length = buffer[1] + (buffer[2] << 8);

    if (length > NET.message.data.byteLength) {
      throw new HostError('Loop.GetMessage: overflow');
    }

    NET.message.cursize = length;
    new Uint8Array(NET.message.data).set(buffer.subarray(3, length + 3));

    receiveLength -= length;

    if (receiveLength >= 4) {
      buffer.copyWithin(0, length + 3, length + 3 + receiveLength);
    }

    loopbackState.receiveLength = receiveLength - 3;

    const { peer } = loopbackState;

    if (peer !== null && type === 1) {
      peer.canSend = true;
    }

    if (sock.state === QSocket.STATE_DISCONNECTED) {
      return -1;
    }

    return type;
  }

  SendMessage(sock: QSocket, data: NetworkPayload): number {
    const peer = getLoopbackState(sock)?.peer ?? null;
    const peerState = peer === null ? null : getLoopbackState(peer);

    if (peer === null || peerState === null) {
      return -1;
    }

    const bufferLength = peerState.receiveLength;
    peerState.receiveLength += data.cursize + 3;

    const buffer = peerState.receiveBuffer;

    if (peerState.receiveLength > buffer.length) {
      throw new HostError('LoopDriver.SendMessage: overflow');
    }

    buffer[bufferLength] = 1;
    buffer[bufferLength + 1] = data.cursize & 0xff;
    buffer[bufferLength + 2] = data.cursize >> 8;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), bufferLength + 3);
    sock.canSend = false;

    return 1;
  }

  SendUnreliableMessage(sock: QSocket, data: NetworkPayload): number {
    const peer = getLoopbackState(sock)?.peer ?? null;
    const peerState = peer === null ? null : getLoopbackState(peer);

    if (peer === null || peerState === null) {
      return -1;
    }

    const bufferLength = peerState.receiveLength;
    peerState.receiveLength += data.cursize + 3;

    const buffer = peerState.receiveBuffer;

    if (peerState.receiveLength > buffer.length) {
      throw new HostError('LoopDriver.SendUnreliableMessage: overflow');
    }

    buffer[bufferLength] = 2;
    buffer[bufferLength + 1] = data.cursize & 0xff;
    buffer[bufferLength + 2] = data.cursize >> 8;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), bufferLength + 3);

    return 1;
  }

  CanSendMessage(sock: QSocket): boolean {
    return getLoopbackState(sock)?.peer !== null ? sock.canSend : false;
  }

  Close(sock: QSocket): void {
    const loopbackState = getLoopbackState(sock);
    const peer = loopbackState?.peer ?? null;

    if (peer !== null) {
      const peerState = getLoopbackState(peer);

      if (peerState !== null) {
        peerState.peer = null;
      }
    }

    if (loopbackState !== null) {
      loopbackState.peer = null;
      loopbackState.receiveLength = 0;
    }

    sock.canSend = false;

    if (sock === this._server) {
      this._server = null;
    } else {
      this._client = null;
    }

    sock.state = QSocket.STATE_DISCONNECTED;
  }
}

export class WebSocketDriver extends BaseDriver {
  newConnections: QSocket[] = [];
  wss: NodeWebSocketServerLike | null = null;

  constructor() {
    super('websocket');
  }

  Init(): boolean {
    this.initialized = true;
    this.newConnections = [];
    return true;
  }

  canHandle(host: string): boolean {
    return /^wss?:\/\//i.test(host);
  }

  Connect(host: string): QSocket | null {
    if (!/^wss?:\/\//i.test(host)) {
      return null;
    }

    const url = new URL(host);

    if (!url.port) {
      url.port = new URL(location.href).port;
    }

    const sock = NET.NewQSocket(this);

    try {
      sock.address = url.toString();
      const browserSocket = new WebSocket(url, 'quake') as BrowserWebSocketWithSocket;
      browserSocket.binaryType = 'arraybuffer';
      sock.transportState = {
        kind: 'websocket',
        mode: 'client',
        receiveQueue: [],
        sendQueue: [],
        webSocket: browserSocket,
      };
    } catch (error) {
      Con.PrintError(`WebSocketDriver.Connect: failed to setup ${url}, ${getErrorMessage(error as Throwable)}\n`);
      return null;
    }

    const socketState = getWebSocketState(sock);

    if (socketState === null || socketState.mode !== 'client') {
      return null;
    }

    const { webSocket: browserSocket } = socketState;
    browserSocket.onerror = this.#OnErrorClient;
    browserSocket.onmessage = this.#OnMessageClient;
    browserSocket.onopen = this.#OnOpenClient;
    browserSocket.onclose = this.#OnCloseClient;

    browserSocket.qsocket = sock;
    sock.state = QSocket.STATE_CONNECTING;

    return sock;
  }

  CanSendMessage(qsocket: QSocket): boolean {
    const socketState = getWebSocketState(qsocket);
    return socketState !== null ? ![2, 3].includes(socketState.webSocket.readyState) : false;
  }

  GetMessage(qsocket: QSocket): number {
    const socketState = getWebSocketState(qsocket);

    if (socketState === null) {
      return qsocket.state === QSocket.STATE_DISCONNECTED ? -1 : 0;
    }

    const { receiveQueue } = socketState;

    if (receiveQueue.length === 0) {
      if (qsocket.state === QSocket.STATE_DISCONNECTED) {
        return -1;
      }

      if (qsocket.state === QSocket.STATE_DISCONNECTING) {
        qsocket.state = QSocket.STATE_DISCONNECTED;
      }

      return 0;
    }

    const message = receiveQueue.shift();

    if (message === undefined) {
      return 0;
    }

    const type = message[0];
    const length = message[1] + (message[2] << 8);
    new Uint8Array(NET.message.data).set(message.subarray(3, length + 3));
    NET.message.cursize = length;

    return type;
  }

  #FlushSendBuffer(qsocket: QSocket): boolean {
    const socketState = getWebSocketState(qsocket);

    if (socketState === null) {
      return false;
    }

    const { sendQueue, webSocket } = socketState;

    switch (webSocket.readyState) {
      case 2:
      case 3:
        Con.DPrint(`WebSocketDriver._FlushSendBuffer: connection already died (readyState = ${webSocket.readyState})`);
        return false;

      case 0:
        return true;
    }

    while (sendQueue.length > 0) {
      const message = sendQueue.shift();

      if (message === undefined) {
        break;
      }

      if (NET.delay_send.value === 0) {
        webSocket.send(toArrayBuffer(message));
      } else {
        setTimeout(() => {
          webSocket.send(toArrayBuffer(message));

          if (webSocket.readyState > 1) {
            qsocket.state = QSocket.STATE_DISCONNECTED;
          }
        }, NET.delay_send.value + (Math.random() - 0.5) * NET.delay_send_jitter.value);
      }
    }

    return true;
  }

  #SendRawMessage(qsocket: QSocket, data: Uint8Array): number {
    const socketState = getWebSocketState(qsocket);

    if (socketState === null) {
      return -1;
    }

    socketState.sendQueue.push(data);
    this.#FlushSendBuffer(qsocket);
    return qsocket.state !== QSocket.STATE_DISCONNECTED ? 1 : -1;
  }

  SendMessage(qsocket: QSocket, data: NetworkPayload): number {
    const buffer = new Uint8Array(data.cursize + 3);
    let index = 0;
    buffer[index++] = 1;
    buffer[index++] = data.cursize & 0xff;
    buffer[index++] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), index);
    return this.#SendRawMessage(qsocket, buffer);
  }

  SendUnreliableMessage(qsocket: QSocket, data: NetworkPayload): number {
    const buffer = new Uint8Array(data.cursize + 3);
    let index = 0;
    buffer[index++] = 2;
    buffer[index++] = data.cursize & 0xff;
    buffer[index++] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), index);
    return this.#SendRawMessage(qsocket, buffer);
  }

  Close(qsocket: QSocket): void {
    const socketState = getWebSocketState(qsocket);

    if (socketState !== null && this.CanSendMessage(qsocket)) {
      this.#FlushSendBuffer(qsocket);
      socketState.webSocket.close(1000);
    }

    qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  #OnErrorClient(this: BrowserWebSocketWithSocket, _error: Event): void {
    if (this.qsocket === undefined) {
      return;
    }

    Con.PrintError(`WebSocketDriver._OnErrorClient: lost connection to ${this.qsocket.address}\n`);
    this.qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  #OnMessageClient(this: BrowserWebSocketWithSocket, message: MessageEvent<string | ArrayBuffer>): void {
    if (this.qsocket === undefined) {
      return;
    }

    const data = message.data;

    if (typeof data === 'string') {
      return;
    }

    const socketState = getWebSocketState(this.qsocket);

    if (socketState === null) {
      return;
    }

    if (NET.delay_receive.value === 0) {
      socketState.receiveQueue.push(new Uint8Array(data));
      return;
    }

    setTimeout(() => {
      socketState.receiveQueue.push(new Uint8Array(data));
    }, NET.delay_receive.value + (Math.random() - 0.5) * NET.delay_receive_jitter.value);
  }

  #OnOpenClient(this: BrowserWebSocketWithSocket): void {
    if (this.qsocket !== undefined) {
      this.qsocket.state = QSocket.STATE_CONNECTED;
    }
  }

  #OnCloseClient(this: BrowserWebSocketWithSocket): void {
    if (this.qsocket === undefined || this.qsocket.state !== QSocket.STATE_CONNECTED) {
      return;
    }

    Con.DPrint('WebSocketDriver._OnCloseClient: connection closed.\n');
    this.qsocket.state = QSocket.STATE_DISCONNECTING;
  }

  #OnConnectionServer(ws: NodeWebSocketLike, req: NodeIncomingMessageLike): void {
    Con.DPrint('WebSocketDriver._OnConnectionServer: received new connection\n');

    const sock = NET.NewQSocket(this);
    sock.transportState = {
      kind: 'websocket',
      mode: 'server',
      receiveQueue: [],
      sendQueue: [],
      webSocket: ws,
    };

    const forwardedFor = req.headers['x-forwarded-for'];
    const address = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor ?? req.socket.remoteAddress ?? '';

    sock.address = formatIP(address, req.socket.remotePort ?? 0);
    sock.state = QSocket.STATE_CONNECTED;

    NET.time = Sys.FloatTime();
    sock.lastMessageTime = NET.time;

    ws.on('close', () => {
      Con.DPrint('WebSocketDriver._OnConnectionServer.disconnect: client disconnected\n');
      sock.state = QSocket.STATE_DISCONNECTED;
      eventBus.publish('net.connection.close', sock);
    });

    ws.on('error', () => {
      Con.DPrint('WebSocketDriver._OnConnectionServer.disconnect: client errored out\n');
      sock.state = QSocket.STATE_DISCONNECTED;
      eventBus.publish('net.connection.error', sock);
    });

    ws.on('message', (data: NodeRawData) => {
      const socketState = getWebSocketState(sock);

      if (socketState !== null) {
        socketState.receiveQueue.push(rawDataToUint8Array(data));
      }
    });

    this.newConnections.push(sock);
    eventBus.publish('net.connection.accepted', sock);
  }

  CheckNewConnections(): QSocket | null {
    return this.newConnections.shift() ?? null;
  }

  ShouldListen(): boolean {
    return registry.isDedicatedServer && NET.server !== null;
  }

  Listen(listening: boolean): void {
    if (this.wss !== null) {
      if (!listening) {
        this.wss.close();
        this.wss = null;
      }

      return;
    }

    if (!listening || NET.server === null) {
      return;
    }

    const { WebSocket: WebSocketModule } = getCommonRegistry();
    const nodeWebSocketModule = WebSocketModule as NodeWebSocketModuleLike;

    this.wss = new nodeWebSocketModule.WebSocketServer({ server: NET.server });
    this.wss.on('connection', this.#OnConnectionServer.bind(this));
    this.newConnections = [];
  }

  GetListenAddress(): string | null {
    if (this.wss === null) {
      return null;
    }

    const address = this.wss.address();

    if (address === null) {
      return null;
    }

    if (typeof address === 'string') {
      return address;
    }

    return formatIP(address.address, address.port);
  }
}

export class WebRTCDriver extends BaseDriver {
  /**
   * Host-side caps for out-of-band connections, enforced locally regardless of what the master
   * server or a remote peer claims -- see `plans/session-ping-latency.md` Security.
   */
  static readonly MAX_OOB_CONNECTIONS_PER_HOST = 16;
  static readonly MIN_PING_INTERVAL_MS = 1000;
  static readonly OOB_IDLE_TIMEOUT_MS = 30 * 1000;

  /** `'oob'` channel wire format: `[1 byte type][4 byte sequence][8 byte timestamp]` = 13 bytes. */
  static readonly OOB_FRAME_LENGTH = 13;
  static readonly OOB_PING = 1;
  static readonly OOB_PONG = 2;

  /** Viewer-side ping cadence and smoothing -- see `plans/session-ping-latency.md` §6. */
  static readonly PING_INTERVAL_MS = 4000;
  static readonly PING_EMA_ALPHA = 0.3;

  creatingSession = false;
  hostToken: string | null = null;
  iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.nextcloud.com:443' },
  ];
  isHost = false;
  newConnections: QSocket[] = [];
  /**
   * Out-of-band (connectionless) peer connections, keyed by peerId -- never linked to a `QSocket`.
   * See `plans/session-ping-latency.md`.
   */
  oobConnections = new Map<string, OobConnectionState>();
  peerId: string | null = null;
  pendingConnections = new Map<string, { peerConnection: RTCPeerConnection; qsocket: QSocket }>();
  pingInterval: ReturnType<typeof setInterval> | null = null;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  serverEventSubscriptions: Array<() => void> = [];
  sessionId: string | null = null;
  signalingUrl: string | null = null;
  signalingWs: WebSocket | null = null;
  /** Viewer-side ping probes, keyed by the probed sessionId. See `plans/session-ping-latency.md`. */
  viewerOobProbes = new Map<string, ViewerOobProbeState>();

  /**
   * Tears down an in-progress hosted session when the tab actually closes, instead of leaving
   * the master server to discover it via the stale-session sweep. Declared as a bound field (not
   * a method) so the same reference can be passed to both `addEventListener` and
   * `removeEventListener`.
   */
  #handlePageHide = (event: PageTransitionEvent): void => {
    // `persisted` means the page is entering the bfcache, not actually closing. An open signaling
    // WebSocket normally disqualifies a page from bfcache eligibility anyway, but bail out
    // defensively rather than tearing down a session that may resume.
    if (event.persisted) {
      return;
    }

    if (this.isHost) {
      this.Listen(false);
    }
  };

  constructor() {
    super('webrtc');
  }

  Init(): boolean {
    if (registry.isDedicatedServer) {
      this.initialized = false;
      return false;
    }

    // `registry.urls.signalingURL` (when configured) is the master server's bare origin, not a
    // full endpoint URL -- only its host is used here, same as SessionDiscovery.ts does for
    // `/list-servers`. The scheme always comes from the current page (never the configured
    // value's own scheme) so a page loaded over https doesn't attempt a mixed-content `ws://`
    // connection, and the `/signaling` path (the only one the master server accepts a WebRTC
    // signaling connection on, see quakeshack-master's `isWebSocketEndpoint`) is always appended.
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = registry.urls?.signalingURL ? new URL(registry.urls.signalingURL).host : `${location.hostname}:8787`;
    this.signalingUrl = `${protocol}//${host}/signaling`;

    this.initialized = true;
    Con.DPrint(`WebRTCDriver: Initialized with signaling at ${this.signalingUrl}\n`);

    window.addEventListener('pagehide', this.#handlePageHide);

    return true;
  }

  override Shutdown(): void {
    if (!registry.isDedicatedServer) {
      window.removeEventListener('pagehide', this.#handlePageHide);
    }

    super.Shutdown();
  }

  canHandle(host: string): boolean {
    return /^webrtc:\/\//i.test(host) || host === 'host';
  }

  Connect(host: string): QSocket | null {
    if (!/^webrtc:\/\//i.test(host)) {
      return null;
    }

    let sessionId: string | null = null;
    let shouldCreateSession = false;

    if (host.startsWith('webrtc://')) {
      host = host.substring(9);
    }

    if (host === 'host' || host === '') {
      shouldCreateSession = true;
    } else {
      sessionId = host;
    }

    if (!this.#ConnectSignaling()) {
      Con.PrintError('WebRTCDriver.Connect: Failed to connect to signaling server\n');
      return null;
    }

    const sock = NET.NewQSocket(this);
    sock.state = QSocket.STATE_CONNECTING;
    sock.address = shouldCreateSession ? 'WebRTC Host' : `WebRTC Session ${sessionId}`;
    sock.transportState = createWebRTCSocketState({ sessionId, isHost: shouldCreateSession });

    const onSignalingReady = () => {
      if (shouldCreateSession) {
        this.#CreateSession(sock);
      } else {
        this.#JoinSession(sock, sessionId);
      }
    };

    if (this.signalingWs !== null && this.signalingWs.readyState === 1) {
      onSignalingReady();
    } else {
      const socketState = getWebRTCSocketState(sock);

      if (socketState !== null) {
        socketState.onSignalingReady = onSignalingReady;
      }
    }

    return sock;
  }

  /**
   * Starts (or no-ops if already running) an out-of-band ping probe against a session's host,
   * without ever joining it for real -- see `plans/session-ping-latency.md`. `onPing` is called
   * with a smoothed RTT (ms) on every fresh pong, or `null` once the probe becomes unreachable
   * (connection failure, session closed, etc.). Call `stopSessionPing` once the caller no longer
   * cares (e.g. the session scrolled out of the visible lobby list).
   */
  startSessionPing(sessionId: string, onPing: (rtt: number | null) => void): void {
    if (this.viewerOobProbes.has(sessionId)) {
      return;
    }

    // Deliberately its own dedicated `/signaling` connection, never `this.signalingWs` -- the
    // master server tracks exactly one (sessionId, peerId) pair per signaling socket, but a
    // browsing client may probe several sessions concurrently.
    const ws = new WebSocket(this.signalingUrl ?? '');
    const state: ViewerOobProbeState = {
      sessionId,
      ws,
      peerId: null,
      peerConnection: null,
      channel: null,
      pingTimer: null,
      sequence: 0,
      pendingSequence: null,
      smoothedRtt: null,
      onPing,
    };
    this.viewerOobProbes.set(sessionId, state);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join-session', sessionId, role: 'oob' }));
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      if (typeof event.data !== 'string') {
        return;
      }

      this.#OnViewerOobSignalingMessage(state, JSON.parse(event.data) as SignalingMessage);
    };

    ws.onerror = (errorEvent: Event) => {
      console.debug('WebRTCDriver: Out-of-band signaling WebSocket error', errorEvent);
      state.onPing(null);
    };

    ws.onclose = () => {
      state.onPing(null);
      this.#TeardownViewerOobProbe(sessionId, state, false);
    };
  }

  /** Stops a probe started by `startSessionPing`. Safe to call even if none is running. */
  stopSessionPing(sessionId: string): void {
    const state = this.viewerOobProbes.get(sessionId);

    if (state === undefined) {
      return;
    }

    this.#TeardownViewerOobProbe(sessionId, state, true);
  }

  #OnViewerOobSignalingMessage(state: ViewerOobProbeState, message: SignalingMessage): void {
    switch (message.type) {
      case 'session-joined':
        state.peerId = message.peerId ?? null;
        break;
      case 'offer':
        void this.#OnViewerOobOffer(state, message);
        break;
      case 'ice-candidate':
        void this.#OnViewerOobIceCandidate(state, message);
        break;
      case 'session-closed':
      case 'error':
        state.onPing(null);
        this.#TeardownViewerOobProbe(state.sessionId, state, false);
        break;
      default:
        break;
    }
  }

  /**
   * Answers the host's offer for this probe -- the host is always the initiator (matching
   * `#OnPeerJoined`'s convention for a real peer), so the viewer's side of an OOB connection is
   * always the answerer, receiving the one `'oob'` channel via `ondatachannel` rather than
   * creating it.
   */
  async #OnViewerOobOffer(state: ViewerOobProbeState, message: SignalingMessage): Promise<void> {
    if (message.fromPeerId === undefined || message.offer === undefined || message.offer === null || state.peerConnection !== null) {
      return;
    }

    const peerConnection = new RTCPeerConnection({ iceServers: this.iceServers });
    state.peerConnection = peerConnection;

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        state.ws.send(JSON.stringify({
          type: 'ice-candidate',
          targetPeerId: message.fromPeerId,
          candidate: event.candidate,
        }));
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'closed') {
        state.onPing(null);
        this.#TeardownViewerOobProbe(state.sessionId, state, false);
      }
    };

    // The host created the one 'oob' channel it needs; any other channel is refused, same as the
    // host-side rule in #CreateOobPeerConnection.
    peerConnection.ondatachannel = (event) => {
      const channel = event.channel;

      if (channel.label !== 'oob' || state.channel !== null) {
        channel.close();
        return;
      }

      state.channel = channel;
      this.#SetupViewerOobChannel(state, channel);
    };

    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      state.ws.send(JSON.stringify({
        type: 'answer',
        targetPeerId: message.fromPeerId,
        answer: peerConnection.localDescription,
      }));
    } catch (error) {
      Con.PrintError(`WebRTCDriver: Error answering out-of-band offer for ${state.sessionId}: ${getErrorMessage(error as Throwable)}\n`);
      state.onPing(null);
      this.#TeardownViewerOobProbe(state.sessionId, state, false);
    }
  }

  async #OnViewerOobIceCandidate(state: ViewerOobProbeState, message: SignalingMessage): Promise<void> {
    if (state.peerConnection === null || !message.candidate) {
      return;
    }

    try {
      await state.peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
    } catch (error) {
      Con.DPrint(`WebRTCDriver: Error adding out-of-band ICE candidate for ${state.sessionId}: ${getErrorMessage(error as Throwable)}\n`);
    }
  }

  #SetupViewerOobChannel(state: ViewerOobProbeState, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      this.#StartViewerOobPingLoop(state, channel);
    };

    channel.onclose = () => {
      state.onPing(null);
      this.#TeardownViewerOobProbe(state.sessionId, state, false);
    };

    channel.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      this.#HandleViewerOobPong(state, event.data);
    };
  }

  #StartViewerOobPingLoop(state: ViewerOobProbeState, channel: RTCDataChannel): void {
    const sendPing = (): void => {
      if (channel.readyState !== 'open') {
        return;
      }

      state.sequence = (state.sequence + 1) >>> 0;
      state.pendingSequence = state.sequence;

      const frame = new ArrayBuffer(WebRTCDriver.OOB_FRAME_LENGTH);
      const view = new DataView(frame);
      view.setUint8(0, WebRTCDriver.OOB_PING);
      view.setUint32(1, state.sequence, true);
      view.setFloat64(5, Date.now(), true);
      channel.send(frame);
    };

    sendPing();
    state.pingTimer = setInterval(sendPing, WebRTCDriver.PING_INTERVAL_MS);
  }

  /**
   * Handles a pong on the viewer's side: validates the frame the same way the host does, ignores
   * a stale/duplicate pong that doesn't match the currently in-flight ping's sequence (the 'oob'
   * channel is unordered, so a late reply for an old ping can arrive after a newer one was already
   * sent), then folds the fresh RTT into an exponential moving average before reporting it.
   */
  #HandleViewerOobPong(state: ViewerOobProbeState, data: ArrayBuffer): void {
    if (data.byteLength !== WebRTCDriver.OOB_FRAME_LENGTH) {
      return;
    }

    const view = new DataView(data);

    if (view.getUint8(0) !== WebRTCDriver.OOB_PONG) {
      return;
    }

    if (view.getUint32(1, true) !== state.pendingSequence) {
      return;
    }

    state.pendingSequence = null;

    const rtt = Math.max(0, Date.now() - view.getFloat64(5, true));
    state.smoothedRtt = state.smoothedRtt === null
      ? rtt
      : state.smoothedRtt + (rtt - state.smoothedRtt) * WebRTCDriver.PING_EMA_ALPHA;

    state.onPing(Math.round(state.smoothedRtt));
  }

  #TeardownViewerOobProbe(sessionId: string, state: ViewerOobProbeState, sendLeave: boolean): void {
    if (this.viewerOobProbes.get(sessionId) !== state) {
      return;
    }

    this.viewerOobProbes.delete(sessionId);

    if (state.pingTimer !== null) {
      clearInterval(state.pingTimer);
    }

    state.channel?.close();
    state.peerConnection?.close();

    if (sendLeave && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'leave-session' }));
    }

    state.ws.onopen = null;
    state.ws.onmessage = null;
    state.ws.onerror = null;
    state.ws.onclose = null;
    state.ws.close();
  }

  #ConnectSignaling(): boolean {
    if (this.signalingWs !== null) {
      if (this.signalingWs.readyState === 1 || this.signalingWs.readyState === 0) {
        return true;
      }
    }

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.signalingWs = new WebSocket(this.signalingUrl ?? '');

      this.signalingWs.onopen = () => {
        Con.DPrint(`WebRTCDriver: Connected to signaling server at ${this.signalingUrl}\n`);
        const previousSessionId = this.sessionId;
        this.#ProcessPendingSignaling();

        if (previousSessionId !== null && previousSessionId === this.sessionId) {
          this.#RestoreSession();
        }
      };

      this.signalingWs.onmessage = async (event: MessageEvent<string>) => {
        if (typeof event.data !== 'string') {
          return;
        }

        await this.#OnSignalingMessage(JSON.parse(event.data) as SignalingMessage);
      };

      this.signalingWs.onerror = (errorEvent: Event) => {
        console.debug('WebRTCDriver: Signaling WebSocket error', errorEvent);
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        Con.DPrint(`WebRTCDriver: Signaling error: ${errorEvent}\n`); // FIXME: this does not print anything useful, need to find a better way to log the error details
        this.#OnSignalingError({ error: 'Signaling connection error', type: 'error' });
      };

      this.signalingWs.onclose = (closeEvent: CloseEvent) => {
        Con.DPrint('WebRTCDriver: Signaling connection closed\n');
        this.signalingWs = null;

        if (closeEvent.code !== 1000) {
          Con.PrintError(`Signaling connection closed unexpectedly, ${closeEvent.reason || 'unknown reason'} (code: ${closeEvent.code})\n`);
          Con.PrintWarning(`Signaling server at ${this.signalingUrl} might be unavailable.\n`);
        }

        this.#OnSignalingError({ error: 'Signaling connection closed', type: 'error' });
        this.#ScheduleReconnect();
      };

      return true;
    } catch (error) {
      Con.PrintError(`WebRTCDriver: Failed to connect to signaling at ${this.signalingUrl}:\n${getErrorMessage(error as Throwable)}\n`);
      this.#ScheduleReconnect();
      return false;
    }
  }

  #ScheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }

    const delay = 5000;
    Con.DPrint(`WebRTCDriver: Scheduling reconnect in ${delay}ms...\n`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      Con.DPrint('WebRTCDriver: Attempting to reconnect...\n');
      this.#ConnectSignaling();
    }, delay);
  }

  #RestoreSession(): void {
    if (this.isHost) {
      Con.DPrint('WebRTCDriver: Restoring host session...\n');
      this.#SendSignaling({
        type: 'create-session',
        sessionId: this.sessionId ?? undefined,
        hostToken: this.hostToken ?? undefined,
        serverInfo: this.#GatherServerInfo(),
        isPublic: this.#IsSessionPublic(),
      });
      return;
    }

    Con.DPrint(`WebRTCDriver: Restoring client session ${this.sessionId}\n`);
    this.#SendSignaling({
      type: 'join-session',
      sessionId: this.sessionId ?? undefined,
    });
  }

  #ProcessPendingSignaling(): void {
    for (const sock of NET.activeSockets) {
      const socketData = sock === undefined ? null : getWebRTCSocketState(sock);

      if (sock !== undefined && sock.driver === this && socketData?.onSignalingReady !== undefined) {
        socketData.onSignalingReady();
        socketData.onSignalingReady = undefined;
      }
    }
  }

  #SendSignaling(message: SignalingMessage): void {
    if (this.signalingWs !== null && this.signalingWs.readyState === 1) {
      this.signalingWs.send(JSON.stringify(message));
    }
  }

  #StartPingInterval(): void {
    if (!this.isHost) {
      return;
    }

    this.#StopPingInterval();
    this.pingInterval = setInterval(() => {
      this.#SendSignaling({ type: 'ping' });
    }, 30 * 1000);
    this.#SendSignaling({ type: 'ping' });
  }

  #StopPingInterval(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  #StartServerInfoSubscriptions(): void {
    if (!this.isHost) {
      return;
    }

    this.#StopServerInfoSubscriptions();
    this.serverEventSubscriptions.push(eventBus.subscribe('server.spawned', () => { this.#UpdateServerInfo(); }));
    this.serverEventSubscriptions.push(eventBus.subscribe('server.client.connected', () => { this.#UpdateServerInfo(); }));
    this.serverEventSubscriptions.push(eventBus.subscribe('server.client.disconnected', () => { this.#UpdateServerInfo(); }));
    this.serverEventSubscriptions.push(eventBus.subscribe('cvar.changed', (cvarName: string) => {
      const cvar = Cvar.FindVar(cvarName);

      if (cvar !== null && (cvar.flags & Cvar.FLAG.SERVER) !== 0) {
        this.#UpdateServerInfo();
      }
    }));
    this.#UpdateServerInfo();
  }

  #StopServerInfoSubscriptions(): void {
    while (this.serverEventSubscriptions.length > 0) {
      const unsubscribe = this.serverEventSubscriptions.pop();

      if (unsubscribe !== undefined) {
        unsubscribe();
      }
    }
  }

  #UpdateServerInfo(): void {
    if (!this.isHost || this.sessionId === null) {
      return;
    }

    this.#SendSignaling({
      type: 'update-server-info',
      serverInfo: this.#GatherServerInfo(),
      isPublic: this.#IsSessionPublic(),
    });
  }

  #GatherServerInfo(): ServerInfo {
    const serverInfo: ServerInfo = {
      hostname: Cvar.FindVar('hostname')?.string ?? 'UNNAMED',
      maxPlayers: SV.svs.maxclients,
      currentPlayers: NET.activeconnections,
      map: SV.server.mapname!,
      mod: COM.game,
      settings: {},
    };

    for (const cvar of Cvar.Filter((cvar: Cvar) => (cvar.flags & Cvar.FLAG.SERVER) !== 0)) {
      serverInfo.settings[cvar.name] = cvar.string;
    }

    return serverInfo;
  }

  #IsSessionPublic(): boolean {
    return (Cvar.FindVar('sv_public')?.value ?? 0) !== 0;
  }

  #CreateSession(sock: QSocket): void {
    this.#SendSignaling({ type: 'create-session' });
    const socketState = getWebRTCSocketState(sock);

    if (socketState !== null) {
      socketState.isHost = true;
    }

    this.isHost = true;
  }

  #JoinSession(sock: QSocket, sessionId: string | null): void {
    this.#SendSignaling({
      type: 'join-session',
      sessionId: sessionId ?? undefined,
    });
    const socketState = getWebRTCSocketState(sock);

    if (socketState !== null) {
      socketState.sessionId = sessionId;
    }

    this.sessionId = sessionId;
  }

  async #OnSignalingMessage(message: SignalingMessage): Promise<void> {
    switch (message.type) {
      case 'session-created':
        this.#OnSessionCreated(message);
        return;
      case 'session-joined':
        this.#OnSessionJoined(message);
        return;
      case 'peer-joined':
        this.#OnPeerJoined(message);
        return;
      case 'peer-left':
        this.#OnPeerLeft(message);
        return;
      case 'offer':
        await this.#OnOffer(message);
        return;
      case 'answer':
        await this.#OnAnswer(message);
        return;
      case 'ice-candidate':
        await this.#OnIceCandidate(message);
        return;
      case 'session-closed':
        this.#OnSessionClosed(message);
        return;
      case 'pong':
        return;
      case 'error':
        Con.DPrint(`WebRTCDriver: Signaling error: ${message.error}\n`);
        this.#OnSignalingError(message);
        return;
      default:
        Con.DPrint(`WebRTCDriver: Unknown signaling message: ${message.type}\n`);
    }
  }

  #OnSignalingError(message: SignalingMessage): void {
    let failedSocket: QSocket | null = null;

    for (const sock of NET.activeSockets) {
      if (sock !== undefined && sock.driver === this && sock.state === QSocket.STATE_CONNECTING) {
        const socketData = getWebRTCSocketState(sock);

        if (socketData !== null) {
          if (socketData.sessionId && (message.error ?? '').includes(socketData.sessionId)) {
            failedSocket = sock;
            break;
          }

          if (socketData.isHost && (message.error ?? '').includes('already exists')) {
            failedSocket = sock;
            break;
          }
        }

        if (failedSocket === null) {
          failedSocket = sock;
        }
      }
    }

    if (failedSocket !== null) {
      Con.PrintError(`WebRTCDriver: Connection failed - ${message.error}\n`);
      failedSocket.state = QSocket.STATE_DISCONNECTED;

      const webRtcData = getWebRTCSocketState(failedSocket);

      if (webRtcData !== null && webRtcData.sessionId === this.sessionId) {
        this.sessionId = null;
        this.peerId = null;
        this.hostToken = null;
        this.isHost = false;
      }

      return;
    }

    Con.PrintWarning(`WebRTCDriver: Signaling error (no matching socket): ${message.error}\n`);
  }

  #OnSessionCreated(message: SignalingMessage): void {
    this.sessionId = message.sessionId ?? null;
    this.peerId = message.peerId ?? null;
    this.isHost = message.isHost ?? false;
    this.hostToken = message.hostToken ?? null;
    this.creatingSession = false;

    Con.DPrint(`WebRTCDriver: Session created: ${this.sessionId}\n`);
    Con.DPrint(`WebRTCDriver: Your peer ID: ${this.peerId}\n`);

    let sock: QSocket | null = null;

    for (const activeSocket of NET.activeSockets) {
      const socketData = activeSocket === undefined ? null : getWebRTCSocketState(activeSocket);

      if (activeSocket !== undefined && activeSocket.driver === this && socketData !== null && socketData.isHost) {
        sock = activeSocket;
        break;
      }
    }

    if (sock === null) {
      sock = this.#FindSocketBySession(this.sessionId);
    }

    const socketData = sock === null ? null : getWebRTCSocketState(sock);

    if (sock !== null && socketData !== null) {
      socketData.sessionId = this.sessionId;
      sock.state = QSocket.STATE_CONNECTED;
      sock.address = `WebRTC Host (${this.sessionId})`;
      Con.DPrint('WebRTCDriver: Host socket ready for accepting peers\n');
      this.#StartPingInterval();
      this.#StartServerInfoSubscriptions();

      if (message.existingPeers !== undefined && message.existingPeers.length > 0) {
        Con.DPrint(`WebRTCDriver: Reconnecting to ${message.existingPeers.length} existing peers...\n`);

        for (const peerId of message.existingPeers) {
          this.#OnPeerJoined({ type: 'peer-joined', peerId });
        }
      }

      return;
    }

    Con.PrintWarning(`WebRTCDriver: No socket found for session ${this.sessionId}\n`);
  }

  #OnSessionJoined(message: SignalingMessage): void {
    this.sessionId = message.sessionId ?? null;
    this.peerId = message.peerId ?? null;
    this.isHost = message.isHost ?? false;

    Con.DPrint(`WebRTCDriver: Joined session: ${this.sessionId}\n`);
    Con.DPrint(`WebRTCDriver: Your peer ID: ${this.peerId}\n`);
    Con.DPrint(`WebRTCDriver: Peers in session: ${message.peerCount}\n`);

    const sock = this.#FindSocketBySession(this.sessionId);

    if (sock !== null) {
      sock.address = `WebRTC Peer (${this.sessionId})`;
      Con.DPrint('WebRTCDriver: Socket found, waiting for P2P connection\n');
      return;
    }

    Con.PrintWarning(`WebRTCDriver: No socket found for joined session ${this.sessionId}\n`);
  }

  #OnPeerJoined(message: SignalingMessage): void {
    if (message.peerId === undefined || !this.isHost) {
      return;
    }

    if (message.isOob) {
      this.#OnOobPeerJoined(message.peerId);
      return;
    }

    Con.DPrint(`WebRTCDriver: Peer ${message.peerId} joined\n`);

    const peerSock = NET.NewQSocket(this);
    peerSock.state = QSocket.STATE_CONNECTING;
    peerSock.address = `WebRTC Peer ${message.peerId}`;
    peerSock.transportState = createWebRTCSocketState({
      sessionId: this.sessionId,
      isHost: false,
      peerId: message.peerId,
    });

    this.#CreatePeerConnection(peerSock, message.peerId, true);
    this.newConnections.push(peerSock);
    Con.DPrint(`WebRTCDriver: Created socket for peer ${message.peerId}, added to new connections\n`);
  }

  #OnPeerLeft(message: SignalingMessage): void {
    if (message.peerId !== undefined) {
      Con.DPrint(`WebRTCDriver: Peer ${message.peerId} left\n`);
      this.#ClosePeerConnection(message.peerId);
    }
  }

  async #OnOffer(message: SignalingMessage): Promise<void> {
    if (message.fromPeerId === undefined || message.offer === undefined || message.offer === null) {
      return;
    }

    Con.DPrint(`WebRTCDriver: Received offer from ${message.fromPeerId}\n`);

    const sock = this.#FindSocketBySession(this.sessionId);

    if (sock === null) {
      Con.PrintWarning('WebRTCDriver._OnOffer: No socket found for session\n');
      return;
    }

    const peerConnection = this.#CreatePeerConnection(sock, message.fromPeerId, false);

    if (peerConnection === null) {
      return;
    }

    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      this.#SendSignaling({
        type: 'answer',
        targetPeerId: message.fromPeerId,
        answer: peerConnection.localDescription,
      });
    } catch (error) {
      Con.PrintError(`WebRTCDriver: Error handling offer: ${getErrorMessage(error as Throwable)}\n`);
    }
  }

  async #OnAnswer(message: SignalingMessage): Promise<void> {
    if (message.fromPeerId === undefined || message.answer === undefined || message.answer === null) {
      return;
    }

    Con.DPrint(`WebRTCDriver: Received answer from ${message.fromPeerId}\n`);

    const peerConnection = this.#FindActivePeerConnection(message.fromPeerId);

    if (peerConnection === null) {
      Con.PrintWarning(`WebRTCDriver: No peer connection found for ${message.fromPeerId}\n`);
      return;
    }

    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
      Con.DPrint(`WebRTCDriver: Answer processed for ${message.fromPeerId}\n`);
    } catch (error) {
      Con.PrintError(`WebRTCDriver: Error handling answer: ${getErrorMessage(error as Throwable)}\n`);
    }
  }

  async #OnIceCandidate(message: SignalingMessage): Promise<void> {
    if (message.fromPeerId === undefined) {
      return;
    }

    const peerConnection = this.#FindActivePeerConnection(message.fromPeerId);

    if (peerConnection === null) {
      return;
    }

    try {
      if (message.candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
      }
    } catch (error) {
      Con.DPrint(`WebRTCDriver: Error adding ICE candidate: ${getErrorMessage(error as Throwable)}\n`);
    }
  }

  /**
   * Resolves the live `RTCPeerConnection` for a peerId, whether it belongs to a real,
   * `QSocket`-linked connection or an out-of-band one (`plans/session-ping-latency.md`) -- shared
   * by `#OnAnswer`/`#OnIceCandidate` since both are pure WebRTC signaling plumbing with no game-state
   * involvement either way.
   * @returns The matching peer connection, or `null` if none is tracked for this peerId.
   */
  #FindActivePeerConnection(peerId: string): RTCPeerConnection | null {
    const oobState = this.oobConnections.get(peerId);

    if (oobState !== undefined) {
      return oobState.peerConnection;
    }

    const sock = this.isHost ? this.#FindSocketByPeerId(peerId) : this.#FindSocketBySession(this.sessionId);
    const socketData = sock === null ? null : getWebRTCSocketState(sock);

    return socketData?.peerConnections.get(peerId) ?? null;
  }

  #OnSessionClosed(message: SignalingMessage): void {
    Con.DPrint(`WebRTCDriver: Session closed: ${message.reason}\n`);

    const sock = this.#FindSocketBySession(this.sessionId);

    if (sock !== null) {
      sock.state = QSocket.STATE_DISCONNECTED;
    }

    this.sessionId = null;
    this.peerId = null;
    this.isHost = false;
  }

  #CreatePeerConnection(sock: QSocket, peerId: string, initiator: boolean): RTCPeerConnection | null {
    console.assert(sock.transportState?.kind === 'webrtc', 'WebRTCDriver._CreatePeerConnection: Invalid socket');

    const socketData = getWebRTCSocketState(sock);

    if (socketData === null) {
      Con.PrintError('WebRTCDriver._CreatePeerConnection: No socket provided\n');
      return null;
    }

    if (socketData.peerConnections.has(peerId)) {
      return socketData.peerConnections.get(peerId) ?? null;
    }

    Con.DPrint(`WebRTCDriver: Creating peer connection to ${peerId} (initiator: ${initiator})\n`);

    const peerConnection = new RTCPeerConnection({ iceServers: this.iceServers });
    socketData.peerConnections.set(peerId, peerConnection);

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        Con.DPrint(`WebRTCDriver: Sending ICE candidate to ${peerId}\n`);
        this.#SendSignaling({
          type: 'ice-candidate',
          targetPeerId: peerId,
          candidate: event.candidate,
        });
        return;
      }

      Con.DPrint(`WebRTCDriver: ICE gathering complete for ${peerId}\n`);
    };

    peerConnection.oniceconnectionstatechange = () => {
      Con.DPrint(`WebRTCDriver: ICE state with ${peerId}: ${peerConnection.iceConnectionState}\n`);
    };

    peerConnection.onconnectionstatechange = () => {
      Con.DPrint(`WebRTCDriver: Connection state with ${peerId}: ${peerConnection.connectionState}\n`);

      if (peerConnection.connectionState === 'connected') {
        Con.DPrint(`WebRTCDriver: P2P connection established with ${peerId}\n`);
      } else if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
        Con.DPrint(`WebRTCDriver: Connection ${peerConnection.connectionState} with ${peerId}\n`);
        this.#ClosePeerConnection(peerId);
      }
    };

    if (initiator) {
      const reliableChannel = peerConnection.createDataChannel('reliable', { ordered: true });
      const unreliableChannel = peerConnection.createDataChannel('unreliable', { ordered: false, maxRetransmits: 10 });
      this.#SetupDataChannel(sock, peerId, reliableChannel, unreliableChannel);

      void peerConnection.createOffer()
        .then((offer) => peerConnection.setLocalDescription(offer))
        .then(() => {
          this.#SendSignaling({
            type: 'offer',
            targetPeerId: peerId,
            offer: peerConnection.localDescription,
          });
        })
        .catch((error) => {
          Con.PrintError(`WebRTCDriver: Error creating offer: ${getErrorMessage(error)}\n`);
        });
    } else {
      peerConnection.ondatachannel = (event) => {
        const liveSocketData = getWebRTCSocketState(sock);

        if (liveSocketData === null) {
          return;
        }

        const channel = event.channel;

        if (!liveSocketData.dataChannels.has(peerId)) {
          liveSocketData.dataChannels.set(peerId, {});
        }

        const channels = liveSocketData.dataChannels.get(peerId);

        if (channels === undefined) {
          return;
        }

        if (channel.label === 'reliable') {
          channels.reliable = channel;
          this.#SetupDataChannelHandlers(sock, peerId, channel);
        } else if (channel.label === 'unreliable') {
          channels.unreliable = channel;
          this.#SetupDataChannelHandlers(sock, peerId, channel);
        }
      };
    }

    return peerConnection;
  }

  #SetupDataChannel(sock: QSocket, peerId: string, reliableChannel: RTCDataChannel, unreliableChannel: RTCDataChannel): void {
    const socketData = getWebRTCSocketState(sock);

    if (socketData === null) {
      return;
    }

    socketData.dataChannels.set(peerId, {
      reliable: reliableChannel,
      unreliable: unreliableChannel,
    });

    this.#SetupDataChannelHandlers(sock, peerId, reliableChannel);
    this.#SetupDataChannelHandlers(sock, peerId, unreliableChannel);
  }

  #SetupDataChannelHandlers(sock: QSocket, peerId: string, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      Con.DPrint(`WebRTCDriver: Data channel ${channel.label} opened with ${peerId}\n`);

      if (channel.label === 'reliable' && sock.state !== QSocket.STATE_CONNECTED) {
        sock.state = QSocket.STATE_CONNECTED;
        Con.DPrint('WebRTCDriver: Socket now CONNECTED (can send/receive data)\n');
      }

      this.#FlushSendBuffer(sock);
    };

    channel.onclose = () => {
      Con.DPrint(`WebRTCDriver: Data channel ${channel.label} closed with ${peerId}\n`);
      sock.state = QSocket.STATE_DISCONNECTED;
    };

    channel.onerror = (error) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      Con.PrintError(`WebRTCDriver: Data channel error with ${peerId}: ${error}\n`); // FIXME: this does not print anything useful, need to find a better way to log the error details
      sock.state = QSocket.STATE_DISCONNECTED;
    };

    channel.onmessage = (event) => {
      const socketState = getWebRTCSocketState(sock);

      if (socketState !== null) {
        socketState.receiveQueue.push(new Uint8Array(event.data));
      }
    };
  }

  #ClosePeerConnection(peerId: string): void {
    if (this.oobConnections.has(peerId)) {
      this.#CloseOobPeerConnection(peerId);
      return;
    }

    const sock = this.isHost ? this.#FindSocketByPeerId(peerId) : this.#FindSocketBySession(this.sessionId);

    const socketData = sock === null ? null : getWebRTCSocketState(sock);

    if (sock === null || socketData === null) {
      Con.DPrint(`WebRTCDriver._ClosePeerConnection: No socket found for ${peerId}\n`);
      return;
    }

    sock.state = QSocket.STATE_DISCONNECTING;

    const peerConnection = socketData.peerConnections.get(peerId);

    if (peerConnection !== undefined) {
      peerConnection.close();
      socketData.peerConnections.delete(peerId);
    }

    socketData.dataChannels.delete(peerId);
    sock.state = QSocket.STATE_DISCONNECTED;
  }

  /**
   * Host-side entry point for a `peer-joined` notification flagged `isOob` -- an out-of-band
   * (connectionless) peer that must never become a `QSocket`/`ServerClient`. See
   * `plans/session-ping-latency.md`.
   */
  #OnOobPeerJoined(peerId: string): void {
    if (this.oobConnections.size >= WebRTCDriver.MAX_OOB_CONNECTIONS_PER_HOST) {
      Con.DPrint(`WebRTCDriver: Refusing out-of-band peer ${peerId}, host cap reached\n`);
      return;
    }

    Con.DPrint(`WebRTCDriver: Out-of-band peer ${peerId} joined\n`);
    this.#CreateOobPeerConnection(peerId);
  }

  /**
   * Creates the host's out-of-band peer connection. The host is always the initiator here (same
   * convention as a real peer join, see `#OnPeerJoined`), creating a single `'oob'` data channel
   * and sending the offer -- there is deliberately no `ondatachannel`/answerer branch, since an OOB
   * connection is host-initiated by construction.
   */
  #CreateOobPeerConnection(peerId: string): void {
    if (this.oobConnections.has(peerId)) {
      return;
    }

    Con.DPrint(`WebRTCDriver: Creating out-of-band peer connection to ${peerId}\n`);

    const peerConnection = new RTCPeerConnection({ iceServers: this.iceServers });
    const state: OobConnectionState = {
      peerConnection,
      channel: null,
      lastPingAt: 0,
      idleTimer: null,
    };
    this.oobConnections.set(peerId, state);
    this.#ResetOobIdleTimer(peerId, state);

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.#SendSignaling({
          type: 'ice-candidate',
          targetPeerId: peerId,
          candidate: event.candidate,
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'closed') {
        this.#CloseOobPeerConnection(peerId);
      }
    };

    // The host already created the one 'oob' channel it needs (it's always the initiator here);
    // any additional or differently-labeled channel the remote peer opens is refused outright,
    // never wired to any handler.
    peerConnection.ondatachannel = (event) => {
      event.channel.close();
    };

    const channel = peerConnection.createDataChannel('oob', { ordered: false, maxRetransmits: 0 });
    state.channel = channel;
    this.#SetupOobChannelHandlers(peerId, state, channel);

    void peerConnection.createOffer()
      .then((offer) => peerConnection.setLocalDescription(offer))
      .then(() => {
        this.#SendSignaling({
          type: 'offer',
          targetPeerId: peerId,
          offer: peerConnection.localDescription,
        });
      })
      .catch((error) => {
        Con.PrintError(`WebRTCDriver: Error creating out-of-band offer: ${getErrorMessage(error as Throwable)}\n`);
        this.#CloseOobPeerConnection(peerId);
      });
  }

  /**
   * Wires the `'oob'` channel to the ping/pong handler. Deliberately separate from
   * `#SetupDataChannelHandlers` -- an OOB channel never touches `receiveQueue`/`QSocket` state,
   * only `#HandleOobMessage`'s own narrow, read-only dispatch.
   */
  #SetupOobChannelHandlers(peerId: string, state: OobConnectionState, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      Con.DPrint(`WebRTCDriver: Out-of-band channel opened with ${peerId}\n`);
    };

    channel.onclose = () => {
      this.#CloseOobPeerConnection(peerId);
    };

    channel.onerror = (error) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      Con.DPrint(`WebRTCDriver: Out-of-band channel error with ${peerId}: ${error}\n`);
    };

    channel.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      this.#HandleOobMessage(peerId, state, event.data);
    };
  }

  /**
   * The entire out-of-band query dispatch for this pass: validates the fixed 13-byte frame shape
   * before reading any content, rate-limits locally (never trusting the peer's own pacing), and
   * answers `PING` with `PONG`. Any other type, or a malformed frame, is dropped silently -- never
   * an error, never a larger response. This handler has no reference to `SV`/`Server.ts`/entity
   * state; see `plans/session-ping-latency.md` Security §1 for why future query types must keep
   * that property one narrow handler at a time rather than widening this one.
   */
  #HandleOobMessage(peerId: string, state: OobConnectionState, data: ArrayBuffer): void {
    if (data.byteLength !== WebRTCDriver.OOB_FRAME_LENGTH) {
      return;
    }

    const view = new DataView(data);

    if (view.getUint8(0) !== WebRTCDriver.OOB_PING) {
      return;
    }

    const now = Date.now();

    if (now - state.lastPingAt < WebRTCDriver.MIN_PING_INTERVAL_MS) {
      return;
    }

    state.lastPingAt = now;
    this.#ResetOobIdleTimer(peerId, state);

    const sequence = view.getUint32(1, true);
    const timestamp = view.getFloat64(5, true);

    const pong = new ArrayBuffer(WebRTCDriver.OOB_FRAME_LENGTH);
    const pongView = new DataView(pong);
    pongView.setUint8(0, WebRTCDriver.OOB_PONG);
    pongView.setUint32(1, sequence, true);
    pongView.setFloat64(5, timestamp, true);

    if (state.channel !== null && state.channel.readyState === 'open') {
      state.channel.send(pong);
    }
  }

  #ResetOobIdleTimer(peerId: string, state: OobConnectionState): void {
    if (state.idleTimer !== null) {
      clearTimeout(state.idleTimer);
    }

    state.idleTimer = setTimeout(() => {
      Con.DPrint(`WebRTCDriver: Closing idle out-of-band connection to ${peerId}\n`);
      this.#CloseOobPeerConnection(peerId);
    }, WebRTCDriver.OOB_IDLE_TIMEOUT_MS);
  }

  #CloseOobPeerConnection(peerId: string): void {
    const state = this.oobConnections.get(peerId);

    if (state === undefined) {
      return;
    }

    // Deleted before closing the channel/connection so a synchronous `onclose`/`onconnectionstatechange`
    // callback re-entering this method (as it does for a real close) sees no state and no-ops,
    // instead of double-closing or clearing an already-cleared timer.
    this.oobConnections.delete(peerId);

    if (state.idleTimer !== null) {
      clearTimeout(state.idleTimer);
    }

    state.channel?.close();
    state.peerConnection.close();
  }

  #CloseAllOobConnections(): void {
    for (const peerId of this.oobConnections.keys()) {
      this.#CloseOobPeerConnection(peerId);
    }
  }

  #FindSocketBySession(sessionId: string | null): QSocket | null {
    for (const sock of NET.activeSockets) {
      const socketData = sock === undefined ? null : getWebRTCSocketState(sock);

      if (sock !== undefined && sock.driver === this && socketData !== null && socketData.sessionId === sessionId) {
        return sock;
      }
    }

    return null;
  }

  #FindSocketByPeerId(peerId: string): QSocket | null {
    for (const sock of NET.activeSockets) {
      const socketData = sock === undefined ? null : getWebRTCSocketState(sock);

      if (sock !== undefined && sock.driver === this && socketData !== null && socketData.peerId === peerId) {
        return sock;
      }
    }

    return null;
  }

  CheckNewConnections(): QSocket | null {
    const sock = this.newConnections.shift() ?? null;

    if (sock !== null) {
      Con.DPrint(`WebRTCDriver.CheckNewConnections: returning new connection ${sock.address}\n`);
    }

    return sock;
  }

  #FlushSendBuffer(qsocket: QSocket): void {
    const webRtcData = getWebRTCSocketState(qsocket);

    if (webRtcData === null) {
      return;
    }

    const queue = webRtcData.sendQueue;

    while (queue.length > 0) {
      const message = queue[0];
      let canSendThis = false;

      for (const channels of webRtcData.dataChannels.values()) {
        const channel = message.reliable ? channels.reliable : channels.unreliable;

        if (channel !== undefined && channel.readyState === 'open') {
          canSendThis = true;
          break;
        }
      }

      if (!canSendThis) {
        break;
      }

      const result = this.#SendToAllPeers(qsocket, message.buffer, message.reliable);

      if (result > 0) {
        queue.shift();
      } else {
        break;
      }
    }

    if (queue.length === 0 && qsocket.state === QSocket.STATE_DISCONNECTING) {
      Con.DPrint(`WebRTCDriver._FlushSendBuffer: buffer drained, closing ${qsocket.address}\n`);
      this.#ForceClose(qsocket);
    }
  }

  GetMessage(qsocket: QSocket): number {
    const socketData = getWebRTCSocketState(qsocket);

    if (socketData === null) {
      return qsocket.state === QSocket.STATE_DISCONNECTED ? -1 : 0;
    }

    const { receiveQueue } = socketData;

    if (receiveQueue.length === 0) {
      if (qsocket.state === QSocket.STATE_DISCONNECTED) {
        return -1;
      }

      if (qsocket.state === QSocket.STATE_DISCONNECTING) {
        qsocket.state = QSocket.STATE_DISCONNECTED;
        return -1;
      }

      return 0;
    }

    const message = receiveQueue.shift();

    if (message === undefined) {
      return 0;
    }

    const type = message[0];
    const length = message[1] + (message[2] << 8);
    new Uint8Array(NET.message.data).set(message.subarray(3, length + 3));
    NET.message.cursize = length;

    return type;
  }

  SendMessage(qsocket: QSocket, data: NetworkPayload): number {
    const socketData = getWebRTCSocketState(qsocket);

    if (socketData === null) {
      return -1;
    }

    const buffer = new Uint8Array(data.cursize + 3);
    buffer[0] = 1;
    buffer[1] = data.cursize & 0xff;
    buffer[2] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), 3);
    socketData.sendQueue.push({ buffer, reliable: true });
    this.#FlushSendBuffer(qsocket);
    return 1;
  }

  SendUnreliableMessage(qsocket: QSocket, data: NetworkPayload): number {
    const socketData = getWebRTCSocketState(qsocket);

    if (socketData === null) {
      return -1;
    }

    const buffer = new Uint8Array(data.cursize + 3);
    buffer[0] = 2;
    buffer[1] = data.cursize & 0xff;
    buffer[2] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), 3);
    socketData.sendQueue.push({ buffer, reliable: false });
    this.#FlushSendBuffer(qsocket);
    return 1;
  }

  #SendToAllPeers(qsocket: QSocket, buffer: Uint8Array, reliable: boolean): number {
    console.assert(qsocket.transportState?.kind === 'webrtc', 'WebRTCDriver._SendToAllPeers: Invalid socket');

    const socketData = getWebRTCSocketState(qsocket);

    if (socketData === null) {
      Con.PrintError('WebRTCDriver._SendToAllPeers: missing WebRTC transport state\n');
      return -1;
    }

    let sentCount = 0;

    for (const [peerId, channels] of socketData.dataChannels) {
      const channel = reliable ? channels.reliable : channels.unreliable;

      if (channel === undefined || channel.readyState !== 'open') {
        Con.DPrint(`WebRTCDriver._SendToAllPeers: channel to ${peerId} not open (state=${channel?.readyState})\n`);
        continue;
      }

      try {
        channel.send(toArrayBuffer(buffer));
        sentCount++;
      } catch (error) {
        Con.DPrint(`WebRTCDriver: Error sending to ${peerId}: ${getErrorMessage(error as Throwable)}\n`);
      }
    }

    if (sentCount === 0) {
      Con.DPrint('WebRTCDriver._SendToAllPeers: no peers available to send to\n');
    }

    return sentCount > 0 ? 1 : -1;
  }

  CanSendMessage(qsocket: QSocket): boolean {
    const socketData = getWebRTCSocketState(qsocket);

    if (socketData === null) {
      return false;
    }

    for (const channels of socketData.dataChannels.values()) {
      if (channels.reliable !== undefined && channels.reliable.readyState === 'open') {
        return true;
      }
    }

    return false;
  }

  Close(qsocket: QSocket): void {
    const socketData = getWebRTCSocketState(qsocket);

    if (socketData === null) {
      qsocket.state = QSocket.STATE_DISCONNECTED;
      return;
    }

    this.#FlushSendBuffer(qsocket);

    if (socketData.sendQueue.length > 0 && qsocket.state !== QSocket.STATE_DISCONNECTED) {
      if (socketData.dataChannels.size > 0) {
        Con.DPrint(`WebRTCDriver.Close: delaying close for ${qsocket.address} to flush buffer\n`);
        qsocket.state = QSocket.STATE_DISCONNECTING;

        setTimeout(() => {
          if (qsocket.state === QSocket.STATE_DISCONNECTING) {
            Con.DPrint(`WebRTCDriver.Close: timeout waiting for flush, forcing close for ${qsocket.address}\n`);
            this.#ForceClose(qsocket);
          }
        }, 5000);

        return;
      }
    }

    this.#ForceClose(qsocket);
  }

  #ForceClose(qsocket: QSocket): void {
    const socketData = getWebRTCSocketState(qsocket);

    if (socketData === null) {
      qsocket.state = QSocket.STATE_DISCONNECTED;
      return;
    }

    for (const peerConnection of socketData.peerConnections.values()) {
      peerConnection.close();
    }

    socketData.peerConnections.clear();
    socketData.dataChannels.clear();

    const isSessionSocket = socketData.isHost || (!this.isHost && socketData.sessionId === this.sessionId);

    if (socketData.isHost) {
      this.#StopPingInterval();
      this.#StopServerInfoSubscriptions();
      this.#CloseAllOobConnections();
    }

    if (isSessionSocket && this.sessionId !== null) {
      this.#SendSignaling({ type: 'leave-session' });
    }

    if (isSessionSocket) {
      if (!(this.isHost && !socketData.isHost)) {
        this.sessionId = null;
        this.peerId = null;
        this.hostToken = null;
        this.isHost = false;
      }
    }

    qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  ShouldListen(): boolean {
    return !registry.isDedicatedServer;
  }

  Listen(listening: boolean): void {
    if (!this.ShouldListen()) {
      return;
    }

    if (listening) {
      if (this.sessionId !== null || this.creatingSession) {
        Con.DPrint('WebRTCDriver: Already hosting or creating a session\n');
        return;
      }

      Con.DPrint('WebRTCDriver: Starting WebRTC host session for listen server\n');
      this.creatingSession = true;

      if (!this.#ConnectSignaling()) {
        Con.PrintWarning('WebRTCDriver: Failed to connect to signaling server\n');
        this.creatingSession = false;
        return;
      }

      const sock = NET.NewQSocket(this);
      sock.state = QSocket.STATE_CONNECTING;
      sock.address = 'WebRTC Host';
      sock.transportState = createWebRTCSocketState({ sessionId: null, isHost: true });

      const createSessionWhenReady = () => {
        this.#SendSignaling({
          type: 'create-session',
          serverInfo: this.#GatherServerInfo(),
          isPublic: this.#IsSessionPublic(),
        });
        Con.DPrint('WebRTCDriver: Session creation request sent\n');
      };

      if (this.signalingWs !== null && this.signalingWs.readyState === 1) {
        createSessionWhenReady();
      } else {
        const socketState = getWebRTCSocketState(sock);

        if (socketState !== null) {
          socketState.onSignalingReady = createSessionWhenReady;
        }
      }

      this.isHost = true;
      Con.DPrint('WebRTCDriver: Waiting for signaling connection to create session...\n');
      return;
    }

    Con.DPrint('WebRTCDriver: Stopping listen server, tearing down session\n');
    this.#StopPingInterval();
    this.#StopServerInfoSubscriptions();

    for (let index = NET.activeSockets.length - 1; index >= 0; index--) {
      const sock = NET.activeSockets[index];
      const socketData = sock === undefined ? null : getWebRTCSocketState(sock);

      if (sock !== undefined && sock.driver === this && socketData !== null) {
        for (const peerConnection of socketData.peerConnections.values()) {
          peerConnection.close();
        }

        socketData.peerConnections.clear();
        socketData.dataChannels.clear();
        sock.state = QSocket.STATE_DISCONNECTED;
      }
    }

    if (this.sessionId !== null) {
      this.#SendSignaling({ type: 'leave-session' });
    }

    if (this.signalingWs !== null) {
      this.signalingWs.onclose = null;
      this.signalingWs.onerror = null;
      this.signalingWs.onmessage = null;
      this.signalingWs.onopen = null;
      this.signalingWs.close();
      this.signalingWs = null;
    }

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sessionId !== null) {
      Con.DPrint('WebRTCDriver: Session torn down, no longer accepting connections\n');
    }

    this.sessionId = null;
    this.peerId = null;
    this.isHost = false;
    this.creatingSession = false;
  }

  GetListenAddress(): string | null {
    return this.sessionId !== null ? `webrtc://${this.sessionId}` : null;
  }
}

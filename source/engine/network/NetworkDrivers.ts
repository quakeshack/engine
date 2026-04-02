import Cvar from '../common/Cvar.mjs';
import { HostError } from '../common/Errors.mjs';
import type { SzBuffer } from './MSG.ts';
import { eventBus, getCommonRegistry, registry } from '../registry.mjs';
import { formatIP } from './Misc.ts';

type Throwable = Error | string | number | boolean | null | undefined | { message?: string };
type NetworkPayload = Pick<SzBuffer, 'cursize' | 'data'>;
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
    (eventName: 'close', listener: () => void): void;
    (eventName: 'error', listener: () => void): void;
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
    receiveBuffer: new Uint8Array(new ArrayBuffer(8192)),
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

    if (peerState.receiveLength > 8192) {
      throw new HostError('LoopDriver.SendMessage: overflow');
    }

    const buffer = peerState.receiveBuffer;
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

    if (peerState.receiveLength > 8192) {
      throw new HostError('LoopDriver.SendUnreliableMessage: overflow');
    }

    const buffer = peerState.receiveBuffer;
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
    browserSocket.onerror = this._OnErrorClient;
    browserSocket.onmessage = this._OnMessageClient;
    browserSocket.onopen = this._OnOpenClient;
    browserSocket.onclose = this._OnCloseClient;

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

  _FlushSendBuffer(qsocket: QSocket): boolean {
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

  _SendRawMessage(qsocket: QSocket, data: Uint8Array): number {
    const socketState = getWebSocketState(qsocket);

    if (socketState === null) {
      return -1;
    }

    socketState.sendQueue.push(data);
    this._FlushSendBuffer(qsocket);
    return qsocket.state !== QSocket.STATE_DISCONNECTED ? 1 : -1;
  }

  SendMessage(qsocket: QSocket, data: NetworkPayload): number {
    const buffer = new Uint8Array(data.cursize + 3);
    let index = 0;
    buffer[index++] = 1;
    buffer[index++] = data.cursize & 0xff;
    buffer[index++] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), index);
    return this._SendRawMessage(qsocket, buffer);
  }

  SendUnreliableMessage(qsocket: QSocket, data: NetworkPayload): number {
    const buffer = new Uint8Array(data.cursize + 3);
    let index = 0;
    buffer[index++] = 2;
    buffer[index++] = data.cursize & 0xff;
    buffer[index++] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), index);
    return this._SendRawMessage(qsocket, buffer);
  }

  Close(qsocket: QSocket): void {
    const socketState = getWebSocketState(qsocket);

    if (socketState !== null && this.CanSendMessage(qsocket)) {
      this._FlushSendBuffer(qsocket);
      socketState.webSocket.close(1000);
    }

    qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  _OnErrorClient(this: BrowserWebSocketWithSocket, _error: Event): void {
    if (this.qsocket === undefined) {
      return;
    }

    Con.PrintError(`WebSocketDriver._OnErrorClient: lost connection to ${this.qsocket.address}\n`);
    this.qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  _OnMessageClient(this: BrowserWebSocketWithSocket, message: MessageEvent<string | ArrayBuffer>): void {
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

  _OnOpenClient(this: BrowserWebSocketWithSocket): void {
    if (this.qsocket !== undefined) {
      this.qsocket.state = QSocket.STATE_CONNECTED;
    }
  }

  _OnCloseClient(this: BrowserWebSocketWithSocket): void {
    if (this.qsocket === undefined || this.qsocket.state !== QSocket.STATE_CONNECTED) {
      return;
    }

    Con.DPrint('WebSocketDriver._OnCloseClient: connection closed.\n');
    this.qsocket.state = QSocket.STATE_DISCONNECTING;
  }

  _OnConnectionServer(ws: NodeWebSocketLike, req: NodeIncomingMessageLike): void {
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
    this.wss.on('connection', this._OnConnectionServer.bind(this));
    this.newConnections = [];
  }

  GetListenAddress(): string | null {
    if (this.wss === null) {
      return null;
    }

    const address = this.wss.address();

    if (address === null || typeof address === 'string') {
      return address;
    }

    const socketAddress = address as ListenAddress;
    return formatIP(socketAddress.address, socketAddress.port);
  }
}

export class WebRTCDriver extends BaseDriver {
  creatingSession = false;
  hostToken: string | null = null;
  iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.nextcloud.com:443' },
  ];
  isHost = false;
  newConnections: QSocket[] = [];
  peerId: string | null = null;
  pendingConnections = new Map<string, { peerConnection: RTCPeerConnection; qsocket: QSocket }>();
  pingInterval: ReturnType<typeof setInterval> | null = null;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  serverEventSubscriptions: Array<() => void> = [];
  sessionId: string | null = null;
  signalingUrl: string | null = null;
  signalingWs: WebSocket | null = null;

  constructor() {
    super('webrtc');
  }

  Init(): boolean {
    if (registry.isDedicatedServer) {
      this.initialized = false;
      return false;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.signalingUrl = `${protocol}//${location.hostname}:8787/signaling`;

    if (registry.urls?.signalingURL) {
      this.signalingUrl = registry.urls.signalingURL;
    }

    this.initialized = true;
    Con.DPrint(`WebRTCDriver: Initialized with signaling at ${this.signalingUrl}\n`);
    return true;
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

    if (!this._ConnectSignaling()) {
      Con.PrintError('WebRTCDriver.Connect: Failed to connect to signaling server\n');
      return null;
    }

    const sock = NET.NewQSocket(this);
    sock.state = QSocket.STATE_CONNECTING;
    sock.address = shouldCreateSession ? 'WebRTC Host' : `WebRTC Session ${sessionId}`;
    sock.transportState = createWebRTCSocketState({ sessionId, isHost: shouldCreateSession });

    const onSignalingReady = () => {
      if (shouldCreateSession) {
        this._CreateSession(sock);
      } else {
        this._JoinSession(sock, sessionId);
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

  _ConnectSignaling(): boolean {
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
        this._ProcessPendingSignaling();

        if (previousSessionId !== null && previousSessionId === this.sessionId) {
          this._RestoreSession();
        }
      };

      this.signalingWs.onmessage = async (event: MessageEvent<string>) => {
        if (typeof event.data !== 'string') {
          return;
        }

        await this._OnSignalingMessage(JSON.parse(event.data) as SignalingMessage);
      };

      this.signalingWs.onerror = (errorEvent: Event) => {
        console.debug('WebRTCDriver: Signaling WebSocket error', errorEvent);
        Con.DPrint(`WebRTCDriver: Signaling error: ${errorEvent}\n`);
        this._OnSignalingError({ error: 'Signaling connection error', type: 'error' });
      };

      this.signalingWs.onclose = (closeEvent: CloseEvent) => {
        Con.DPrint('WebRTCDriver: Signaling connection closed\n');
        this.signalingWs = null;

        if (closeEvent.code !== 1000) {
          Con.PrintError(`Signaling connection closed unexpectedly, ${closeEvent.reason || 'unknown reason'} (code: ${closeEvent.code})\n`);
          Con.PrintWarning(`Signaling server at ${this.signalingUrl} might be unavailable.\n`);
        }

        this._OnSignalingError({ error: 'Signaling connection closed', type: 'error' });
        this._ScheduleReconnect();
      };

      return true;
    } catch (error) {
      Con.PrintError(`WebRTCDriver: Failed to connect to signaling at ${this.signalingUrl}:\n${getErrorMessage(error as Throwable)}\n`);
      this._ScheduleReconnect();
      return false;
    }
  }

  _ScheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }

    const delay = 5000;
    Con.DPrint(`WebRTCDriver: Scheduling reconnect in ${delay}ms...\n`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      Con.DPrint('WebRTCDriver: Attempting to reconnect...\n');
      this._ConnectSignaling();
    }, delay);
  }

  _RestoreSession(): void {
    if (this.isHost) {
      Con.DPrint('WebRTCDriver: Restoring host session...\n');
      this._SendSignaling({
        type: 'create-session',
        sessionId: this.sessionId ?? undefined,
        hostToken: this.hostToken ?? undefined,
        serverInfo: this._GatherServerInfo(),
        isPublic: this._IsSessionPublic(),
      });
      return;
    }

    Con.DPrint(`WebRTCDriver: Restoring client session ${this.sessionId}\n`);
    this._SendSignaling({
      type: 'join-session',
      sessionId: this.sessionId ?? undefined,
    });
  }

  _ProcessPendingSignaling(): void {
    for (const sock of NET.activeSockets) {
      const socketData = sock === undefined ? null : getWebRTCSocketState(sock);

      if (sock !== undefined && sock.driver === this && socketData?.onSignalingReady !== undefined) {
        socketData.onSignalingReady();
        socketData.onSignalingReady = undefined;
      }
    }
  }

  _SendSignaling(message: SignalingMessage): void {
    if (this.signalingWs !== null && this.signalingWs.readyState === 1) {
      this.signalingWs.send(JSON.stringify(message));
    }
  }

  _StartPingInterval(): void {
    if (!this.isHost) {
      return;
    }

    this._StopPingInterval();
    this.pingInterval = setInterval(() => {
      this._SendSignaling({ type: 'ping' });
    }, 30 * 1000);
    this._SendSignaling({ type: 'ping' });
  }

  _StopPingInterval(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  _StartServerInfoSubscriptions(): void {
    if (!this.isHost) {
      return;
    }

    this._StopServerInfoSubscriptions();
    this.serverEventSubscriptions.push(eventBus.subscribe('server.spawned', () => this._UpdateServerInfo()));
    this.serverEventSubscriptions.push(eventBus.subscribe('server.client.connected', () => this._UpdateServerInfo()));
    this.serverEventSubscriptions.push(eventBus.subscribe('server.client.disconnected', () => this._UpdateServerInfo()));
    this.serverEventSubscriptions.push(eventBus.subscribe('cvar.changed', (cvarName: string) => {
      const cvar = Cvar.FindVar(cvarName);

      if (cvar !== null && (cvar.flags & Cvar.FLAG.SERVER) !== 0) {
        this._UpdateServerInfo();
      }
    }));
    this._UpdateServerInfo();
  }

  _StopServerInfoSubscriptions(): void {
    while (this.serverEventSubscriptions.length > 0) {
      const unsubscribe = this.serverEventSubscriptions.pop();

      if (unsubscribe !== undefined) {
        unsubscribe();
      }
    }
  }

  _UpdateServerInfo(): void {
    if (!this.isHost || this.sessionId === null) {
      return;
    }

    this._SendSignaling({
      type: 'update-server-info',
      serverInfo: this._GatherServerInfo(),
      isPublic: this._IsSessionPublic(),
    });
  }

  _GatherServerInfo(): ServerInfo {
    const serverInfo: ServerInfo = {
      hostname: Cvar.FindVar('hostname')?.string ?? 'UNNAMED',
      maxPlayers: SV.svs.maxclients,
      currentPlayers: NET.activeconnections,
      map: SV.server.mapname,
      mod: COM.game,
      settings: {},
    };

    for (const cvar of Cvar.Filter((cvar: Cvar) => (cvar.flags & Cvar.FLAG.SERVER) !== 0)) {
      serverInfo.settings[cvar.name] = cvar.string;
    }

    return serverInfo;
  }

  _IsSessionPublic(): boolean {
    return (Cvar.FindVar('sv_public')?.value ?? 0) !== 0;
  }

  _CreateSession(sock: QSocket): void {
    this._SendSignaling({ type: 'create-session' });
    const socketState = getWebRTCSocketState(sock);

    if (socketState !== null) {
      socketState.isHost = true;
    }

    this.isHost = true;
  }

  _JoinSession(sock: QSocket, sessionId: string | null): void {
    this._SendSignaling({
      type: 'join-session',
      sessionId: sessionId ?? undefined,
    });
    const socketState = getWebRTCSocketState(sock);

    if (socketState !== null) {
      socketState.sessionId = sessionId;
    }

    this.sessionId = sessionId;
  }

  async _OnSignalingMessage(message: SignalingMessage): Promise<void> {
    switch (message.type) {
      case 'session-created':
        this._OnSessionCreated(message);
        return;
      case 'session-joined':
        this._OnSessionJoined(message);
        return;
      case 'peer-joined':
        this._OnPeerJoined(message);
        return;
      case 'peer-left':
        this._OnPeerLeft(message);
        return;
      case 'offer':
        await this._OnOffer(message);
        return;
      case 'answer':
        await this._OnAnswer(message);
        return;
      case 'ice-candidate':
        await this._OnIceCandidate(message);
        return;
      case 'session-closed':
        this._OnSessionClosed(message);
        return;
      case 'pong':
        return;
      case 'error':
        Con.DPrint(`WebRTCDriver: Signaling error: ${message.error}\n`);
        this._OnSignalingError(message);
        return;
      default:
        Con.DPrint(`WebRTCDriver: Unknown signaling message: ${message.type}\n`);
    }
  }

  _OnSignalingError(message: SignalingMessage): void {
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

  _OnSessionCreated(message: SignalingMessage): void {
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
      sock = this._FindSocketBySession(this.sessionId);
    }

    const socketData = sock === null ? null : getWebRTCSocketState(sock);

    if (sock !== null && socketData !== null) {
      socketData.sessionId = this.sessionId;
      sock.state = QSocket.STATE_CONNECTED;
      sock.address = `WebRTC Host (${this.sessionId})`;
      Con.DPrint('WebRTCDriver: Host socket ready for accepting peers\n');
      this._StartPingInterval();
      this._StartServerInfoSubscriptions();

      if (message.existingPeers !== undefined && message.existingPeers.length > 0) {
        Con.DPrint(`WebRTCDriver: Reconnecting to ${message.existingPeers.length} existing peers...\n`);

        for (const peerId of message.existingPeers) {
          this._OnPeerJoined({ type: 'peer-joined', peerId });
        }
      }

      return;
    }

    Con.PrintWarning(`WebRTCDriver: No socket found for session ${this.sessionId}\n`);
  }

  _OnSessionJoined(message: SignalingMessage): void {
    this.sessionId = message.sessionId ?? null;
    this.peerId = message.peerId ?? null;
    this.isHost = message.isHost ?? false;

    Con.DPrint(`WebRTCDriver: Joined session: ${this.sessionId}\n`);
    Con.DPrint(`WebRTCDriver: Your peer ID: ${this.peerId}\n`);
    Con.DPrint(`WebRTCDriver: Peers in session: ${message.peerCount}\n`);

    const sock = this._FindSocketBySession(this.sessionId);

    if (sock !== null) {
      sock.address = `WebRTC Peer (${this.sessionId})`;
      Con.DPrint('WebRTCDriver: Socket found, waiting for P2P connection\n');
      return;
    }

    Con.PrintWarning(`WebRTCDriver: No socket found for joined session ${this.sessionId}\n`);
  }

  _OnPeerJoined(message: SignalingMessage): void {
    if (message.peerId === undefined) {
      return;
    }

    Con.DPrint(`WebRTCDriver: Peer ${message.peerId} joined\n`);

    if (this.isHost) {
      const peerSock = NET.NewQSocket(this);
      peerSock.state = QSocket.STATE_CONNECTING;
      peerSock.address = `WebRTC Peer ${message.peerId}`;
      peerSock.transportState = createWebRTCSocketState({
        sessionId: this.sessionId,
        isHost: false,
        peerId: message.peerId,
      });

      this._CreatePeerConnection(peerSock, message.peerId, true);
      this.newConnections.push(peerSock);
      Con.DPrint(`WebRTCDriver: Created socket for peer ${message.peerId}, added to new connections\n`);
    }
  }

  _OnPeerLeft(message: SignalingMessage): void {
    if (message.peerId !== undefined) {
      Con.DPrint(`WebRTCDriver: Peer ${message.peerId} left\n`);
      this._ClosePeerConnection(message.peerId);
    }
  }

  async _OnOffer(message: SignalingMessage): Promise<void> {
    if (message.fromPeerId === undefined || message.offer === undefined || message.offer === null) {
      return;
    }

    Con.DPrint(`WebRTCDriver: Received offer from ${message.fromPeerId}\n`);

    const sock = this._FindSocketBySession(this.sessionId);

    if (sock === null) {
      Con.PrintWarning('WebRTCDriver._OnOffer: No socket found for session\n');
      return;
    }

    const peerConnection = this._CreatePeerConnection(sock, message.fromPeerId, false);

    if (peerConnection === null) {
      return;
    }

    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      this._SendSignaling({
        type: 'answer',
        targetPeerId: message.fromPeerId,
        answer: peerConnection.localDescription,
      });
    } catch (error) {
      Con.PrintError(`WebRTCDriver: Error handling offer: ${getErrorMessage(error as Throwable)}\n`);
    }
  }

  async _OnAnswer(message: SignalingMessage): Promise<void> {
    if (message.fromPeerId === undefined || message.answer === undefined || message.answer === null) {
      return;
    }

    Con.DPrint(`WebRTCDriver: Received answer from ${message.fromPeerId}\n`);

    const sock = this.isHost ? this._FindSocketByPeerId(message.fromPeerId) : this._FindSocketBySession(this.sessionId);

    const socketData = sock === null ? null : getWebRTCSocketState(sock);

    if (sock === null || socketData === null) {
      Con.PrintWarning(`WebRTCDriver._OnAnswer: No socket found for ${message.fromPeerId}\n`);
      return;
    }

    const peerConnection = socketData.peerConnections.get(message.fromPeerId);

    if (peerConnection === undefined) {
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

  async _OnIceCandidate(message: SignalingMessage): Promise<void> {
    if (message.fromPeerId === undefined) {
      return;
    }

    const sock = this.isHost ? this._FindSocketByPeerId(message.fromPeerId) : this._FindSocketBySession(this.sessionId);

    const socketData = sock === null ? null : getWebRTCSocketState(sock);

    if (sock === null || socketData === null) {
      return;
    }

    const peerConnection = socketData.peerConnections.get(message.fromPeerId);

    if (peerConnection === undefined) {
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

  _OnSessionClosed(message: SignalingMessage): void {
    Con.DPrint(`WebRTCDriver: Session closed: ${message.reason}\n`);

    const sock = this._FindSocketBySession(this.sessionId);

    if (sock !== null) {
      sock.state = QSocket.STATE_DISCONNECTED;
    }

    this.sessionId = null;
    this.peerId = null;
    this.isHost = false;
  }

  _CreatePeerConnection(sock: QSocket, peerId: string, initiator: boolean): RTCPeerConnection | null {
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
        this._SendSignaling({
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
        this._ClosePeerConnection(peerId);
      }
    };

    if (initiator) {
      const reliableChannel = peerConnection.createDataChannel('reliable', { ordered: true });
      const unreliableChannel = peerConnection.createDataChannel('unreliable', { ordered: false, maxRetransmits: 10 });
      this._SetupDataChannel(sock, peerId, reliableChannel, unreliableChannel);

      void peerConnection.createOffer()
        .then((offer) => peerConnection.setLocalDescription(offer))
        .then(() => {
          this._SendSignaling({
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
          this._SetupDataChannelHandlers(sock, peerId, channel);
        } else if (channel.label === 'unreliable') {
          channels.unreliable = channel;
          this._SetupDataChannelHandlers(sock, peerId, channel);
        }
      };
    }

    return peerConnection;
  }

  _SetupDataChannel(sock: QSocket, peerId: string, reliableChannel: RTCDataChannel, unreliableChannel: RTCDataChannel): void {
    const socketData = getWebRTCSocketState(sock);

    if (socketData === null) {
      return;
    }

    socketData.dataChannels.set(peerId, {
      reliable: reliableChannel,
      unreliable: unreliableChannel,
    });

    this._SetupDataChannelHandlers(sock, peerId, reliableChannel);
    this._SetupDataChannelHandlers(sock, peerId, unreliableChannel);
  }

  _SetupDataChannelHandlers(sock: QSocket, peerId: string, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      Con.DPrint(`WebRTCDriver: Data channel ${channel.label} opened with ${peerId}\n`);

      if (channel.label === 'reliable' && sock.state !== QSocket.STATE_CONNECTED) {
        sock.state = QSocket.STATE_CONNECTED;
        Con.DPrint('WebRTCDriver: Socket now CONNECTED (can send/receive data)\n');
      }

      this._FlushSendBuffer(sock);
    };

    channel.onclose = () => {
      Con.DPrint(`WebRTCDriver: Data channel ${channel.label} closed with ${peerId}\n`);
      sock.state = QSocket.STATE_DISCONNECTED;
    };

    channel.onerror = (error) => {
      Con.PrintError(`WebRTCDriver: Data channel error with ${peerId}: ${error}\n`);
      sock.state = QSocket.STATE_DISCONNECTED;
    };

    channel.onmessage = (event) => {
      const socketState = getWebRTCSocketState(sock);

      if (socketState !== null) {
        socketState.receiveQueue.push(new Uint8Array(event.data));
      }
    };
  }

  _ClosePeerConnection(peerId: string): void {
    const sock = this.isHost ? this._FindSocketByPeerId(peerId) : this._FindSocketBySession(this.sessionId);

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

  _FindSocketBySession(sessionId: string | null): QSocket | null {
    for (const sock of NET.activeSockets) {
      const socketData = sock === undefined ? null : getWebRTCSocketState(sock);

      if (sock !== undefined && sock.driver === this && socketData !== null && socketData.sessionId === sessionId) {
        return sock;
      }
    }

    return null;
  }

  _FindSocketByPeerId(peerId: string): QSocket | null {
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

  _FlushSendBuffer(qsocket: QSocket): void {
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

      const result = this._SendToAllPeers(qsocket, message.buffer, message.reliable);

      if (result > 0) {
        queue.shift();
      } else {
        break;
      }
    }

    if (queue.length === 0 && qsocket.state === QSocket.STATE_DISCONNECTING) {
      Con.DPrint(`WebRTCDriver._FlushSendBuffer: buffer drained, closing ${qsocket.address}\n`);
      this._ForceClose(qsocket);
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
    this._FlushSendBuffer(qsocket);
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
    this._FlushSendBuffer(qsocket);
    return 1;
  }

  _SendToAllPeers(qsocket: QSocket, buffer: Uint8Array, reliable: boolean): number {
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

    this._FlushSendBuffer(qsocket);

    if (socketData.sendQueue.length > 0 && qsocket.state !== QSocket.STATE_DISCONNECTED) {
      if (socketData.dataChannels.size > 0) {
        Con.DPrint(`WebRTCDriver.Close: delaying close for ${qsocket.address} to flush buffer\n`);
        qsocket.state = QSocket.STATE_DISCONNECTING;

        setTimeout(() => {
          if (qsocket.state === QSocket.STATE_DISCONNECTING) {
            Con.DPrint(`WebRTCDriver.Close: timeout waiting for flush, forcing close for ${qsocket.address}\n`);
            this._ForceClose(qsocket);
          }
        }, 5000);

        return;
      }
    }

    this._ForceClose(qsocket);
  }

  _ForceClose(qsocket: QSocket): void {
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
      this._StopPingInterval();
      this._StopServerInfoSubscriptions();
    }

    if (isSessionSocket && this.sessionId !== null) {
      this._SendSignaling({ type: 'leave-session' });
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

      if (!this._ConnectSignaling()) {
        Con.PrintWarning('WebRTCDriver: Failed to connect to signaling server\n');
        this.creatingSession = false;
        return;
      }

      const sock = NET.NewQSocket(this);
      sock.state = QSocket.STATE_CONNECTING;
      sock.address = 'WebRTC Host';
      sock.transportState = createWebRTCSocketState({ sessionId: null, isHost: true });

      const createSessionWhenReady = () => {
        this._SendSignaling({
          type: 'create-session',
          serverInfo: this._GatherServerInfo(),
          isPublic: this._IsSessionPublic(),
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
    this._StopPingInterval();
    this._StopServerInfoSubscriptions();

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
      this._SendSignaling({ type: 'leave-session' });
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

import { registry } from '../registry.mjs';

export class QSocket {
  static STATE_NEW = 'new';
  static STATE_CONNECTING = 'connecting';
  static STATE_CONNECTED = 'connected';
  static STATE_DISCONNECTING = 'disconnecting';
  static STATE_DISCONNECTED = 'disconnected';

  constructor(time, driver) {
    this.connecttime = time;
    this.lastMessageTime = time;
    this.driver = driver;
    this.address = null;
    this.state = QSocket.STATE_NEW;

    this.receiveMessage = new Uint8Array(new ArrayBuffer(8192));
    this.receiveMessageLength = 0;

    this.sendMessage = new Uint8Array(new ArrayBuffer(8192));
    this.sendMessageLength = 0;
  }

  toString() {
    return `QSocket(${this.address}, ${this.state})`;
  }

  _getDriver() {
    console.assert(NET.drivers[this.driver], 'QSocket needs a valid driver');

    return NET.drivers[this.driver]; // FIXME: global ref
  }

  GetMessage() {
    return this._getDriver().GetMessage(this);
  }

  SendMessage(data) {
    return this._getDriver().SendMessage(this, data);
  }

  SendUnreliableMessage(data) {
    return this._getDriver().SendUnreliableMessage(this, data);
  }

  CanSendMessage() {
    return this._getDriver().CanSendMessage(this);
  }

  Close() {
    return this._getDriver().Close(this);
  }
};

class BaseDriver {
  constructor() {
    this.initialized = false;
    this.driverlevel = null;
  }

  Init(driverlevel) {
    this.driverlevel = driverlevel;
    return false;
  }

  // eslint-disable-next-line no-unused-vars
  Connect(host) {
    return null;
  }

  CheckNewConnections() {
    return null;
  }

  CheckForResend() {
    return -1;
  }

  // eslint-disable-next-line no-unused-vars
  GetMessage(qsocket) {
    return 0;
  }

  // eslint-disable-next-line no-unused-vars
  SendMessage(qsocket, data) {
    return -1;
  }

  // eslint-disable-next-line no-unused-vars
  SendUnreliableMessage(qsocket, data) {
    return -1;
  }

  // eslint-disable-next-line no-unused-vars
  CanSendMessage(qsocket) {
    return false;
  }

  Close(qsocket) {
    qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  Listen() {
  }
};

export class LoopDriver extends BaseDriver {
  constructor() {
    super();
    this._server = null;
    this._client = null;
    this.localconnectpending = false;
  }

  Init(driverlevel) {
    this.driverlevel = driverlevel;

    this._server = null;
    this._client = null;
    this.localconnectpending = false;

    this.initialized = true;
    return true;
  }

  Connect(host) {
    if (host !== 'local') { // Loop Driver only handles loopback/local connections
      return null;
    }

    // we will return only one new client ever
    this.localconnectpending = true;

    if (this._server === null) {
      this._server = NET.NewQSocket();
      this._server.driver = this.driverlevel;
      this._server.address = 'local server';
    }

    this._server.receiveMessageLength = 0;
    this._server.canSend = true;

    if (this._client === null) {
      this._client = NET.NewQSocket();
      this._client.driver = this.driverlevel;
      this._client.address = 'local client';
    }

    this._client.receiveMessageLength = 0;
    this._client.canSend = true;

    this._server.driverdata = this._client; // client is directly feeding into the server
    this._client.driverdata = this._server; // and vice-versa

    return this._server;
  }

  CheckNewConnections() {
    if (!this.localconnectpending) {
      return null;
    }

    this.localconnectpending = false;

    this._client.receiveMessageLength = 0;
    this._client.canSend = true;
    this._client.state = QSocket.STATE_CONNECTED;

    this._server.receiveMessageLength = 0;
    this._server.canSend = true;
    this._server.state = QSocket.STATE_CONNECTED;

    return this._client;
  }

  GetMessage(sock) {
    if (sock.receiveMessageLength === 0) {
      return 0;
    }
    const ret = sock.receiveMessage[0];
    const length = sock.receiveMessage[1] + (sock.receiveMessage[2] << 8);
    if (length > NET.message.data.byteLength) {
      Sys.Error('Loop.GetMessage: overflow');
    }
    NET.message.cursize = length;
    new Uint8Array(NET.message.data).set(sock.receiveMessage.subarray(3, length + 3));
    sock.receiveMessageLength -= length;
    if (sock.receiveMessageLength >= 4) {
      sock.receiveMessage.copyWithin(0, length + 3, length + 3 + sock.receiveMessageLength);
    }
    sock.receiveMessageLength -= 3;
    if (sock.driverdata && ret === 1) {
      sock.driverdata.canSend = true;
    }
    return ret;
  }

  SendMessage(sock, data) {
    if (!sock.driverdata) {
      return -1;
    }
    const bufferLength = sock.driverdata.receiveMessageLength;
    sock.driverdata.receiveMessageLength += data.cursize + 3;
    if (sock.driverdata.receiveMessageLength > 8192) {
      Sys.Error('LoopDriver.SendMessage: overflow');
    }
    const buffer = sock.driverdata.receiveMessage;
    buffer[bufferLength] = 1;
    buffer[bufferLength + 1] = data.cursize & 0xff;
    buffer[bufferLength + 2] = data.cursize >> 8;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), bufferLength + 3);
    sock.canSend = false;
    return 1;
  }

  SendUnreliableMessage(sock, data) {
    if (!sock.driverdata) {
      return -1;
    }
    const bufferLength = sock.driverdata.receiveMessageLength;
    sock.driverdata.receiveMessageLength += data.cursize + 3;
    if (sock.driverdata.receiveMessageLength > 8192) {
      Sys.Error('LoopDriver.SendUnreliableMessage: overflow');
    }
    const buffer = sock.driverdata.receiveMessage;
    buffer[bufferLength] = 2;
    buffer[bufferLength + 1] = data.cursize & 0xff;
    buffer[bufferLength + 2] = data.cursize >> 8;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), bufferLength + 3);
    return 1;
  }

  CanSendMessage(sock) {
    return sock.driverdata ? sock.canSend : false;
  }

  Close(sock) {
    if (sock.driverdata) {
      sock.driverdata.driverdata = null;
    }
    sock.receiveMessageLength = 0;
    sock.canSend = false;
    if (sock === this._server) {
      this._server = null;
    } else {
      this._client = null;
    }
    sock.state = QSocket.STATE_DISCONNECTED;
  }

  Listen() {
  }
};

export class WebSocketDriver extends BaseDriver {
  Init(driverlevel) {
    super.Init(driverlevel);
    this.initialized = true;
    this.newConnections = [];
    return true;
  }

  Connect(host) {
    // append ws if there’s none mention
    if (!/^wss?:\/\//.test(host)) {
      host = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + host;
    }

    const url = new URL(host);

    if (!['wss:', 'ws:'].includes(url.protocol)) {
      Con.Print('WEBS.Connect: can only connect to a WebSocket server');
      return null;
    }

    // set a default port
    if (!url.port) {
      url.port = (new URL(location.href)).port;
    }

    // we can open a QSocket
    const sock = NET.NewQSocket(NET.time, this.driverlevel);

    try {
      sock.address = url.toString();
      sock.driverdata = new WebSocket(url, 'quake');
      sock.driverdata.binaryType = 'arraybuffer';
    } catch (e) {
      Con.Print(`WebSocketDriver.Connect: failed to setup ${url}, ${e.message}\n`);
      return null;
    }

    // these event handlers will feed into the message buffer structures
    sock.driverdata.onerror = this._OnErrorClient;
    sock.driverdata.onmessage = this._OnMessageClient;
    sock.driverdata.onopen = this._OnOpenClient;
    sock.driverdata.onclose = this._OnCloseClient;

    // freeing up some QSocket structures
    sock.receiveMessage = [];
    sock.receiveMessageLength = null;
    sock.sendMessage = [];
    sock.sendMessageLength = null;

    sock.driverdata.qsocket = sock;

    sock.state = QSocket.STATE_CONNECTING;

    return sock;
  }

  CanSendMessage(qsocket) {
    return ![2, 3].includes(qsocket.driverdata.readyState); // FIXME: WebSocket declaration
    // return ![WebSocket.CLOSING, WebSocket.CLOSED].includes(qsocket.driverdata.readyState);
  }

  GetMessage(qsocket) {
    // check if we have collected new data
    if (qsocket.receiveMessage.length === 0) {
      // finished message buffer draining due to a disconnect
      if (qsocket.state === QSocket.STATE_DISCONNECTING) {
        qsocket.state === QSocket.STATE_DISCONNECTED;
      }

      return 0;
    }

    // fetch a message
    const message = qsocket.receiveMessage.shift();

    // parse header
    const ret = message[0];
    const length = message[1] + (message[2] << 8);

    // copy over the payload to our NET.message buffer
    new Uint8Array(NET.message.data).set(message.subarray(3, length + 3));
    NET.message.cursize = length;

    return ret;
  }

  _FlushSendBuffer(qsocket) {
    switch (qsocket.driverdata.readyState) {
      case 2:
      case 3:
      // case WebSocket.CLOSING: // FIXME: WebSocket declaration
      // case WebSocket.CLOSED: // FIXME: WebSocket declaration
        Con.DPrint(`WebSocketDriver._FlushSendBuffer: connection already died (readyState = ${qsocket.driverdata.readyState})`);
        return false;

      case 0:
      // case WebSocket.CONNECTING: // still connecting // FIXME: WebSocket declaration
        return true;
    }

    while (qsocket.sendMessage.length > 0) {
      const message = qsocket.sendMessage.shift();

      qsocket.driverdata.send(message);
    }

    return true;
  }

  _SendRawMessage(qsocket, data) {
    // push the message onto the sendMessage buffer
    qsocket.sendMessage.push(data);

    // try sending all out, don’t wait for an immediate reaction
    this._FlushSendBuffer(qsocket);

    // we always assume it worked
    return 1;
  }

  SendMessage(qsocket, data) {
    const buffer = new Uint8Array(data.cursize + 3);
    let i = 0;
    buffer[i++] = 1;
    buffer[i++] = data.cursize & 0xff;
    buffer[i++] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), i);
    return this._SendRawMessage(qsocket, buffer);
  }

  SendUnreliableMessage(qsocket, data) {
    const buffer = new Uint8Array(data.cursize + 3);
    let i = 0;
    buffer[i++] = 2;
    buffer[i++] = data.cursize & 0xff;
    buffer[i++] = (data.cursize >> 8) & 0xff;
    buffer.set(new Uint8Array(data.data, 0, data.cursize), i);
    return this._SendRawMessage(qsocket, buffer);
  }

  Close(qsocket) {
    if (this.CanSendMessage(qsocket)) {
      this._FlushSendBuffer(qsocket); // make sure to send everything queued up out
      qsocket.driverdata.close(1000);
    }

    qsocket.state = QSocket.STATE_DISCONNECTED;
  }

  // eslint-disable-next-line no-unused-vars
  _OnErrorClient(error) {
    Con.Print(`WebSocketDriver._OnErrorClient: lost connection to ${this.qsocket.address}\n`);
    this.qsocket.state = QSocket.STATE_DISCONNECTED; // instant disconnect
  }

  _OnMessageClient(message) {
    const data = message.data;

    if (typeof(data) === 'string') {
      return;
    }

    this.qsocket.receiveMessage.push(new Uint8Array(data));
  }

  _OnOpenClient() {
    this.qsocket.state = QSocket.STATE_CONNECTED;
  }

  _OnCloseClient() {
    if (this.qsocket.state !== QSocket.STATE_CONNECTED) {
      return;
    }

    Con.Print('WebSocketDriver._OnCloseClient: connection closed.\n');
    this.qsocket.state = QSocket.STATE_DISCONNECTING; // mark it as disconnecting, so that we can peacefully process any buffered messages
  }

  _OnConnectionServer(ws, req) {
    Con.Print('WebSocketDriver._OnConnectionServer: received new connection\n');

    const sock = NET.NewQSocket();

    if (!sock) {
      Con.Print('WebSocketDriver._OnConnectionServer: failed to allocate new socket, dropping client\n');
      // TODO: send a proper good bye to the client?
      ws.close();
      return;
    }

    sock.driver = this.driverlevel;
    sock.driverdata = ws;
    sock.address = NET.FormatIP((req.headers['x-forwarded-for'] || req.socket.remoteAddress), req.socket.remotePort);

    // these event handlers will feed into the message buffer structures
    sock.receiveMessage = [];
    sock.receiveMessageLength = null;
    sock.sendMessage = [];
    sock.sendMessageLength = null;
    sock.state = QSocket.STATE_CONNECTED;

    ws.on('close', () => {
      Con.DPrint('WebSocketDriver._OnConnectionServer.disconnect: client disconnected\n');
      sock.state = QSocket.STATE_DISCONNECTED;
    });

    ws.on('error', () => {
      Con.DPrint('WebSocketDriver._OnConnectionServer.disconnect: client errored out\n');
      sock.state = QSocket.STATE_DISCONNECTED;
    });

    ws.on('message', (data) => {
      sock.receiveMessage.push(new Uint8Array(data));
    });

    this.newConnections.push(sock);
  }

  CheckNewConnections() {
    if (this.newConnections.length === 0) {
      return null;
    }

    return this.newConnections.shift();
  }

  Listen(listening) {
    if (this.wss) {
      if (!listening) {
        this.wss.close();
        this.wss = null;
      }

      return;
    }

    const { WebSocket, NET } = registry;

    this.wss = new WebSocket.WebSocketServer({server: NET.server});
    this.wss.on('connection', this._OnConnectionServer.bind(this));
    this.newConnections = [];
  }
};


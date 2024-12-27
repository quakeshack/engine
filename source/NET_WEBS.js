WEBS = {};

WEBS.Driver = (class WebSocketDriver extends NET.BaseDriver {
  Init(driverlevel) {
    super.Init(driverlevel);
    this.initialized = true;
    this.newConnections = [];
    return true;
  }

  Connect(host) {
    // append ws if there’s none mention
    if (!/^wss?:\/\//.test(host)) {
      host = (location.protocol === 'https' ? 'wss' : 'ws') + '://' + host;
    }

    const url = new URL(host);

    if (!['wss:', 'ws:'].includes(url.protocol)) {
      Con.Print('WEBS.Connect: can only conect to a WebSocket server');
      return null;
    }

    // set a default port
    if (!url.port) {
      url.port = '8080';
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

    sock.disconnected = false; // we silently assume a connection

    return sock;
  }

  CanSendMessage(qsocket) {
    return ![2, 3].includes(qsocket.driverdata.readyState); // FIXME: WebSocket declaration
    // return ![WebSocket.CLOSING, WebSocket.CLOSED].includes(qsocket.driverdata.readyState);
  }

  GetMessage(qsocket) {
    // // this is our safeguard against dead connections
    // // FIXME: we could implement this in a different way making it reconnect and seamlessly continue
    // if ([WebSocket.CLOSING, WebSocket.CLOSED].includes(qsocket.driverdata.readyState)) {
    //   Con.DPrint(`WebSocketDriver.GetMessage: connection died (readyState = ${qsocket.driverdata.readyState})`);
    //   return -1;
    // }

    // check if we have collected new data
    if (qsocket.receiveMessage.length === 0) {
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

  _SendRawMessage(qsocket, data) {
    // push the message onto the sendMessage buffer
    qsocket.sendMessage.push(data);

    switch (qsocket.driverdata.readyState) {
      case 0:
      // case WebSocket.CONNECTING: // still connecting // FIXME: WebSocket declaration
        return;

      case 2:
      case 3:
      // case WebSocket.CLOSING: // FIXME: WebSocket declaration
      // case WebSocket.CLOSED: // FIXME: WebSocket declaration
        Con.DPrint(`WebSocketDriver._SendMessage: connection died (readyState = ${qsocket.driverdata.readyState})`);
        return -1;
    }

    while (qsocket.sendMessage.length > 0) {
      const message = qsocket.sendMessage.shift();

      qsocket.driverdata.send(message);
    }
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
      qsocket.driverdata.close(1000);
    }

    qsocket.disconnected = true;
  }

  _OnErrorClient(error) {
    Con.Print(`WebSocketDriver._OnErrorClient: lost connection to ${this.qsocket.address}\n`);
    NET.Close(this.qsocket);
  }

  _OnMessageClient(message) {
    const data = message.data;

    if (typeof(data) === 'string') {
      return;
    }

    this.qsocket.receiveMessage.push(new Uint8Array(data));
  }

  _OnOpenClient() {
    // FIXME: no longer needed, we buffer everything anyway
    this.qsocket.disconnected = false;
  }

  _OnCloseClient() {
    Con.Print(`WebSocketDriver._OnCloseClient: connection closed.\n`)
    // this.qsocket.disconnected = true; // FIXME: make it a close pending so we can drain the message buffer
  }

  _OnConnectionServer(ws, req) {
    Con.Print(`WebSocketDriver._OnConnectionServer: received new connection\n`);

    const sock = NET.NewQSocket();

    if (!sock) {
      Con.Print(`WebSocketDriver._OnConnectionServer: failed to allocate new socket, dropping client\n`);
      // FIXME: send a proper good bye to the client
      ws.close();
      return;
    }

    sock.driver = this.driverlevel;
    sock.driverdata = ws;
    sock.address = NET.FormatIP(req.socket.remoteAddress, req.socket.remotePort);

    // these event handlers will feed into the message buffer structures
    sock.receiveMessage = [];
    sock.receiveMessageLength = null;
    sock.sendMessage = [];
    sock.sendMessageLength = null;
    sock.disconnected = false;

    ws.on('disconnect', () => {
      Con.DPrint(`WebSocketDriver._OnConnectionServer.disconnect: client disconnected\n`);
      sock.disconnected = true;
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

    const WebSocket = require('ws');

    this.wss = new WebSocket.Server({port: 8080}); // FIXME: use cvar for port
    this.wss.on('connection', this._OnConnectionServer.bind(this));
    this.newConnections = [];
  }
});


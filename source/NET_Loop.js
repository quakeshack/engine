Loop = {};

Loop.Driver = (class LoopDriver extends NET.BaseDriver {
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

    if (this._server == null) {
      this._server = NET.NewQSocket();
      this._server.driver = this.driverlevel;
      this._server.address = 'local server';
    }

    this._server.receiveMessageLength = 0;
    this._server.canSend = true;

    if (this._client == null) {
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
    this._client.disconnected = false;

    this._server.receiveMessageLength = 0;
    this._server.canSend = true;
    this._server.disconnected = false;

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
    sock.disconnected = true;
  }

  Listen() {
  }
});


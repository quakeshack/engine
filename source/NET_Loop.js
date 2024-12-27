Loop = {};

Loop.LoopDriver = (class LoopDriver extends NET.BaseDriver {
  constructor() {
    super();
    this.client = null;
    this.server = null;
    this.localconnectpending = false;
  }

  Init() {
    this.client = null;
    this.server = null;
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

    if (this.client == null) {
      this.client = NET.NewQSocket();
      this.client.receiveMessage = new Uint8Array(new ArrayBuffer(8192));
      this.client.address = host;
    }

    this.client.receiveMessageLength = 0;
    this.client.canSend = true;

    if (this.server == null) {
      this.server = NET.NewQSocket();
      this.server.receiveMessage = new Uint8Array(new ArrayBuffer(8192));
      this.server.address = host;
    }

    this.server.receiveMessageLength = 0;
    this.server.canSend = true;

    this.client.driverdata = this.server; // client is directly feeding into the server
    this.server.driverdata = this.client; // and vice-versa

    return this.client;
  }

  CheckNewConnections() {
    if (!this.localconnectpending) {
      return null;
    }

    this.localconnectpending = false;

    this.server.receiveMessageLength = 0;
    this.server.canSend = true;

    this.client.receiveMessageLength = 0;
    this.client.canSend = true;

    return this.server;
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
    if (sock === this.client) {
      this.client = null;
    } else {
      this.server = null;
    }
  }

  Listen() {
  }
});


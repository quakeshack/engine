WEBS = {};

WEBS.Init = function() {
  return true; // we assume it will work
  // try {
  //   if ((window.WebSocket == null) || (document.location.protocol === 'https:')) {
  //     return;
  //   }
  //   WEBS.available = true;
  //   return true;
  // } catch (e) {
  //   WEBS.available = false;
  //   return false;
  // }
};

WEBS.Connect = function(host) {
  if (!/^wss?:\/\//.test(host)) {
    host = 'ws://' + host;
  }

  const url = new URL(host);

  if (!['wss:', 'ws:'].includes(url.protocol)) {
    Con.Print("WEBS.Connect: can only conect to a WebSocket server");
    return;
  }

  if (!url.port) {
    url.port = '8080';
  }

  const sock = NET.NewQSocket();
  sock.disconnected = false; // we assume it open, otherwise we get it shut by CL.ReadFromServer
  sock.receiveMessage = [];
  sock.address = host;
  try {
    sock.driverdata = new WebSocket(url, 'quake');
  } catch (e) {
    Con.DPrint("WEBS.Connect: " + e.message);
    return;
  }
  sock.driverdata.data_socket = sock;
  sock.driverdata.binaryType = 'arraybuffer';
  sock.driverdata.onerror = WEBS.OnError;
  sock.driverdata.onmessage = WEBS.OnMessage;
  sock.driverdata.onopen = WEBS.OnOpen;
  NET.newsocket = sock;

  return NET.newsocket;

  // if (WEBS.client == null) {
  //   WEBS.client = NET.NewQSocket();
  //   WEBS.client.receiveMessage = new Uint8Array(new ArrayBuffer(8192));
  //   WEBS.client.address = url;
  //   WEBS.client.driverdata =
  // }
  // WEBS.client.receiveMessageLength = 0;
  // WEBS.client.canSend = true;

  // return WEBS.client;
};

WEBS.CheckNewConnections = function() {
};

WEBS.GetMessage = function(sock) {
  if (sock.driverdata == null) {
    return -1;
  }
  if (sock.driverdata.readyState === 0) {
    return 0; // we have no data yet
  }
  if (sock.driverdata.readyState !== 1) {
    return -1;
  }
  if (sock.receiveMessage.length === 0) {
    return 0;
  }
  const message = sock.receiveMessage.shift();
  NET.message.cursize = message.length - 1;
  (new Uint8Array(NET.message.data)).set(message.subarray(1));
  return message[0];
};

WEBS.SendMessage = function(sock, data) {
  if (sock.driverdata == null) {
    return -1;
  }
  if (sock.driverdata.readyState !== 1) {
    return -1;
  }
  const buf = new ArrayBuffer(data.cursize + 1);
  const dest = new Uint8Array(buf);
  dest[0] = 1;
  dest.set(new Uint8Array(data.data, 0, data.cursize), 1);
  sock.driverdata.send(buf);
  return 1;
};

WEBS.SendUnreliableMessage = function(sock, data) {
  if (sock.driverdata == null) {
    return -1;
  }
  if (sock.driverdata.readyState !== 1) {
    return -1;
  }
  const buf = new ArrayBuffer(data.cursize + 1); const dest = new Uint8Array(buf);
  dest[0] = 2;
  dest.set(new Uint8Array(data.data, 0, data.cursize), 1);
  sock.driverdata.send(buf);
  return 1;
};

WEBS.CanSendMessage = function(sock) {
  if (sock.driverdata == null) {
    return;
  }
  if (sock.driverdata.readyState === 1) {
    return true;
  }
};

WEBS.Close = function(sock) {
  if (sock.driverdata != null) {
    sock.driverdata.close(1000);
  }
};

WEBS.CheckForResend = function() {
  if (NET.newsocket.driverdata.readyState === 1) {
    return 1;
  }
  if (NET.newsocket.driverdata.readyState !== 0) {
    return -1;
  }
};

WEBS.OnError = function() {
  NET.Close(this.data_socket);
};

WEBS.OnMessage = function(message) {
  const data = message.data;
  if (typeof(data) === 'string') {
    return;
  }
  if (data.byteLength > 8000) {
    return;
  }
  this.data_socket.receiveMessage.push(new Uint8Array(data));
};

WEBS.OnOpen = function() {
  this.data_socket.disconnected = false;
}

WEBS.Listen = function(listening) {
  if (WEBS.wss) {
    if (!listening) {
      // TODO: kill server
    }

    return;
  }

  const WebSocket = require('ws');

  WEBS.wss = new WebSocket.Server({ port: 8080 }); // TODO: use cvar for port

  WEBS.wss.on('connection', (ws) => {
    WEBS.CheckNewConnections();
    console.log('New client connected');

    // Listen for messages from the client
    ws.on('message', (message) => {
        console.log(`Received: ${message}`);

        // Echo the message back to the client
        ws.send(`You said: ${message}`);
    });

    // Handle client disconnection
    ws.on('close', () => {
        console.log('Client disconnected');
    });

    // Send a welcome message to the client
    ws.send('Welcome to the WebSocket server!');
});
};

// Module worker used by index.html. Mirrors what the server worker will need from the browser.
let adoptedChannel = null;
const channelLog = [];

self.addEventListener('message', async (event) => {
  const message = event.data;
  const reply = (payload) => self.postMessage({ id: message.id, ...payload });

  switch (message.kind) {
    case 'globals':
      reply({
        caches: typeof self.caches,
        locks: typeof navigator.locks,
        indexedDB: typeof self.indexedDB,
        localStorage: typeof self.localStorage,
        sharedArrayBuffer: typeof SharedArrayBuffer,
        crossOriginIsolated: self.crossOriginIsolated,
        rtcPeerConnection: typeof self.RTCPeerConnection,
        rtcDataChannel: typeof self.RTCDataChannel,
      });
      break;

    case 'dynamic-import':
      try {
        const chunk = await import('./game-chunk.js');
        reply({ ok: chunk.identification.name === 'Test Game', detail: `imported chunk: ${JSON.stringify(chunk.identification)}` });
      } catch (error) {
        reply({ ok: false, detail: String(error) });
      }
      break;

    case 'cache-put':
      try {
        const cache = await caches.open('worker-compat-check');
        await cache.put(message.key, new Response(new Uint8Array(message.bytes)));
        reply({ ok: true, detail: `put ${message.bytes.length} bytes` });
      } catch (error) {
        reply({ ok: false, detail: String(error) });
      }
      break;

    case 'lock': {
      const requestedAt = performance.now();
      await navigator.locks.request(message.lockName, async () => {
        const enteredAt = performance.now();
        reply({ requestedAt, enteredAt });
      });
      break;
    }

    case 'idb-put':
      try {
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('worker-compat-check', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('files');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const transaction = request.result.transaction('files', 'readwrite');
            transaction.objectStore('files').put(message.value, 'probe');
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          };
        });
        reply({ ok: true });
      } catch (error) {
        reply({ ok: false, detail: String(error) });
      }
      break;

    case 'adopt-channel': {
      adoptedChannel = message.channel;
      adoptedChannel.binaryType = 'arraybuffer';
      adoptedChannel.onmessage = (channelMessage) => { channelLog.push(new TextDecoder().decode(channelMessage.data)); };
      const hello = () => { adoptedChannel.send(new TextEncoder().encode('hello-from-worker')); };
      if (adoptedChannel.readyState === 'open') { hello(); } else { adoptedChannel.onopen = hello; }
      reply({ readyState: adoptedChannel.readyState });
      break;
    }

    case 'channel-log':
      reply({ received: channelLog.slice() });
      channelLog.length = 0;
      break;

    default:
      break;
  }
});
